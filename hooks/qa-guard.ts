// A trava dos agentes de QA: regra pura que diz se um comando de Bash ou uma gravação de arquivo é liberada, negada ou deixada
// para a decisão normal. É por padrões, não interpreta shell de verdade: na dúvida, recusa (deny) ou não opina (pass).
import { isInside, normalizePath } from './model.ts'

export type QaRole = 'runner' | 'observer' | 'fixer'
export type GuardCtx = {
  home: string
  repoRoot: string
  fixDir: string
  runDir: string
  readDirs: readonly string[]
  agentBrowser: string
  impeccable: string
  session: string
  cdpPort: number | null
  origins: readonly string[]
  containers: readonly string[]
}
export type BashVerdict = { decision: 'allow' | 'deny' | 'pass'; reason: string }

const GIT_DENIED = ['push', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'reset', 'clean', 'worktree', 'config', 'remote']
const GIT_ARG_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--shallow-file']
// Git da worktree do fixer: só leitura, com lista fechada de opções por subcomando (`count`: aceita -n, -<dígitos>).
type GitSpec = { flags: readonly string[]; count?: true }
const GIT_SPECS = new Map<string, GitSpec>([
  ['diff', { flags: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '--'] }],
  ['status', { flags: ['-s', '--short', '-b', '--branch', '--porcelain'] }],
  ['log', { flags: ['--oneline', '--stat', '-p', '--patch', '--'], count: true }],
])
const CURL_FLAGS = ['--silent', '--show-error', '--include', '--head', '--fail', '--insecure', '--verbose']
const CURL_VALUED = ['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '-m', '--max-time', '--connect-timeout', '-w', '--write-out']
const CURL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const DOCKER_VALUED = ['--since', '--until', '--tail', '-n']
// Opções do agent-browser por subcomando (`--json` entra em todos, menos `network`): cada opção só vale no subcomando dela.
type AbSpec = { flags: readonly string[]; valued: readonly string[] }
const AB_SPECS = new Map<string, AbSpec>([
  ['snapshot', { flags: ['-i', '--interactive', '-c', '--compact', '-u', '--urls'], valued: ['-d', '--depth', '-s', '--selector'] }],
  ['screenshot', { flags: ['--full', '-f', '--annotate'], valued: [] }],
  ['find', { flags: ['--exact'], valued: ['--name'] }],
  ['console', { flags: ['--clear'], valued: [] }],
  ['errors', { flags: ['--clear'], valued: [] }],
  ['network', { flags: ['--clear'], valued: ['--filter', '--type', '--method', '--status'] }],
  ['wait', { flags: [], valued: ['--load', '--text'] }],
])
const AB_ONE = ['click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'press', 'wait']
const AB_NONE = ['snapshot', 'back', 'forward', 'reload', 'console', 'errors']
const AB_GET = ['text', 'value', 'attr', 'title', 'url', 'count', 'box', 'styles']
const AB_FIND_BY = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last']
const AB_FIND_DO = ['click', 'fill', 'check', 'hover', 'text']
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

// `~` e `~/x` contra a home; `~user` contra a pasta ao lado da home (aproximação); relativo contra `base` (a pasta da sessão).
function resolveIn(path: string, base: string, home: string): string {
  const p = path.replace(/\\/g, '/')
  if (p.startsWith('/')) return normalizePath(p)
  if (p === '~' || p.startsWith('~/')) return normalizePath(`${home}${p.slice(1)}`)
  if (p.startsWith('~')) return normalizePath(`${home}/../${p.slice(1)}`)
  return normalizePath(`${base}/${p}`)
}

// Palavras de shell: aspas agrupam e trechos colados se juntam; sem escape (a forma insegura já foi barrada antes).
function shellWords(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let open = false
  let quote = ''
  for (const c of command) {
    if (quote !== '') {
      if (c === quote) quote = ''
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      open = true
    } else if (c === ' ') {
      if (open) out.push(cur)
      cur = ''
      open = false
    } else {
      cur += c
      open = true
    }
  }
  if (open) out.push(cur)
  return out
}

// Forma que a trava nunca libera: encadeamento, expansão, redirecionamento, glob, til solto ou aspas sem fechar.
function isUnsafeShape(command: string): boolean {
  if (/[;&|`$<>\\\n\r\t\v\f\0]/.test(command)) return true
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    // o bash só expande `~/` solto no começo de uma palavra; entre aspas é texto literal; `HEAD~2` é referência do git
    const homeTilde = !(quote === '' && (i === 0 || command[i - 1] === ' ') && command[i + 1] === '/')
    if (c === '~' && homeTilde && !(command.slice(i - 4, i) === 'HEAD' && /\d/.test(command[i + 1] ?? ''))) return true
    if (quote !== '') {
      if (c === quote) quote = ''
    } else if (c === "'" || c === '"') {
      quote = c
    } else if ('*?[]{}()!#'.includes(c)) {
      return true
    }
  }
  return quote !== ''
}

// ---- 1. Nega ----

const programOf = (word: string): string => {
  const path = word.replace(/\\/g, '/')
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.exe$/i, '')
}

const isBranchDelete = (w: string): boolean => /^-[A-Za-z]*[dD][A-Za-z]*$/.test(w) || (w.length > 2 && '--delete'.startsWith(w))

function subDenyReason(ws: readonly string[], at: number): string | null {
  const sub = ws[at]
  if (sub === undefined) return null
  if (GIT_DENIED.includes(sub)) return `git ${sub} é proibido para agentes de QA`
  if (sub === 'branch' && ws.slice(at + 1).some(isBranchDelete)) return 'git branch com apagar é proibido para agentes de QA'
  return null
}

function gitDenyReason(ws: readonly string[], at: number): string | null {
  let j = at + 1
  while (j < ws.length && (ws[j] ?? '').startsWith('-')) {
    const w = ws[j] ?? ''
    const config = w === '-c' || w === '--config-env' ? ws[j + 1] : w.startsWith('--config-env=') ? w.slice(13) : undefined
    if (config?.toLowerCase().startsWith('alias.')) return 'git com alias é proibido (pode esconder um push)'
    const known = GIT_ARG_OPTS.includes(w)
    // opção desconhecida pode levar argumento: olha as duas palavras seguintes
    const hidden = known || w.includes('=') ? null : (subDenyReason(ws, j + 1) ?? subDenyReason(ws, j + 2))
    if (hidden !== null) return hidden
    j += known ? 2 : 1
  }
  return subDenyReason(ws, j)
}

// Um candidato (palavra inteira ou o trecho depois do primeiro `=`) que parece caminho e cai no checkout principal.
function checkoutPathReason(word: string, ctx: GuardCtx, cwd: string): string | null {
  const w = word.replace(/\\/g, '/')
  const eq = w.indexOf('=')
  for (const c of eq < 0 ? [w] : [w, w.slice(eq + 1)]) {
    const pathy = /^(\/|~|\.\/|\.\.\/)/.test(c) || c.split('/').includes('..')
    if (!pathy || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(c)) continue
    const p = resolveIn(c, cwd, ctx.home)
    if (isInside(p, ctx.repoRoot) && !isInside(p, ctx.fixDir)) return `caminho do checkout principal é proibido: ${c}`
  }
  return null
}

// shortcut: a varredura olha toda palavra solta, então buscar o texto `cd`, `gh` ou `pushd` (`rg -n gh <fixDir>`) é negado, e `git`
// também quando a palavra seguinte é um subcomando proibido (`rg -n "git push" <fixDir>`); `rg -n git <fixDir>` passa. Para liberar,
// a varredura teria que saber qual palavra é programa e qual é argumento.
function denyReason(role: QaRole, command: string, ctx: GuardCtx, cwd: string): string | null {
  // palavras cruas, e palavras de shell (aspas juntadas: `g""it`, `c''d`)
  const raw = command.split(/[\s'"`;&|()<>]+/).filter(w => w !== '')
  for (const ws of [raw, shellWords(command)]) {
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i] ?? ''
      const name = programOf(w)
      const reason =
        name === 'gh'
          ? 'gh (GitHub CLI) é proibido para agentes de QA'
          : name === 'cd' || name === 'pushd'
            ? 'cd e pushd são proibidos para agentes de QA (não valem para a chamada seguinte)'
            : name === 'git'
              ? role === 'fixer'
                ? gitDenyReason(ws, i)
                : 'git é proibido para runner e observer'
              : checkoutPathReason(w, ctx, cwd)
      if (reason !== null) return reason
    }
  }
  return null
}

// ---- 3. Libera ----

function urlOk(w: string, ctx: GuardCtx): boolean {
  if (!/^https?:\/\//i.test(w)) return false
  try {
    const u = new URL(w)
    return ctx.origins.includes(u.origin) && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

function valueOk(v: string, ctx: GuardCtx, cwd: string): boolean {
  if (SCHEME.test(v)) return urlOk(v, ctx)
  if (!v.includes('/') && v !== '..' && v !== '~') return true
  return isInside(resolveIn(v, cwd, ctx.home), ctx.runDir)
}

// Palavra inteira e, se houver `=`, o trecho depois dele.
function wordOk(w: string, ctx: GuardCtx, cwd: string): boolean {
  const eq = w.indexOf('=')
  return valueOk(w, ctx, cwd) && (eq < 0 || valueOk(w.slice(eq + 1), ctx, cwd))
}

const argsOk = (args: readonly string[], ctx: GuardCtx, cwd: string): boolean => args.every(w => wordOk(w, ctx, cwd))

// Separa posicionais e opções (nome, valor) pela lista do subcomando; `null` se aparecer opção fora dela ou valor ruim.
function abParts(sub: string, rest: readonly string[]): { pos: string[]; opts: Array<[string, string]> } | null {
  const spec = AB_SPECS.get(sub) ?? { flags: [], valued: [] }
  const pos: string[] = []
  const opts: Array<[string, string]> = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? ''
    if (spec.flags.includes(w) || (w === '--json' && sub !== 'network')) {
      opts.push([w, ''])
    } else if (spec.valued.includes(w)) {
      const v = rest[++i]
      const bad = v === undefined || v.startsWith('-') || ((w === '-d' || w === '--depth') && !/^\d+$/.test(v))
      if (bad) return null
      opts.push([w, v])
    } else if (w.startsWith('-')) {
      return null
    } else {
      pos.push(w)
    }
  }
  return { pos, opts }
}

// `wait`: um posicional, ou `--load <estado>`, ou `--text <texto>`; nada mais.
function waitOk(pos: readonly string[], allOpts: ReadonlyArray<[string, string]>): boolean {
  // `--json` não conta como opção de espera
  const opts = allOpts.filter(([name]) => name !== '--json')
  const [opt] = opts
  if (opt === undefined) return pos.length === 1
  return pos.length === 0 && opts.length === 1 && (opt[0] === '--text' || ['load', 'domcontentloaded', 'networkidle'].includes(opt[1]))
}

// `find <localizador> <valor> [ação] [texto]` ou `find nth <dígitos> <seletor> [ação] [texto]`; texto só com `fill`.
function findOk(pos: readonly string[]): boolean {
  const [by = '', val = '', ...rest] = pos
  const isNth = by === 'nth'
  if (!isNth && !AB_FIND_BY.includes(by)) return false
  if (isNth && (!/^\d+$/.test(val) || rest.length === 0)) return false
  const tail = isNth ? rest.slice(1) : rest
  // `find nth 2 click`: sem seletor, `click` seria lido como seletor
  if (isNth && tail.length === 0 && AB_FIND_DO.includes(rest[0] ?? '')) return false
  const [action, text] = tail
  if (action === undefined) return val !== ''
  return AB_FIND_DO.includes(action) && tail.length <= 2 && (text === undefined || action === 'fill')
}

// `screenshot` só grava .png com caminho absoluto dentro de runDir.
function screenshotOk(path: string | undefined, ctx: GuardCtx): boolean {
  if (path === undefined || !path.startsWith('/')) return false
  const p = normalizePath(path)
  return p.endsWith('.png') && isInside(p, ctx.runDir)
}

function abFormOk(sub: string, pos: readonly string[], opts: ReadonlyArray<[string, string]>, ctx: GuardCtx): boolean {
  const n = pos.length
  const first = pos[0] ?? ''
  if (AB_NONE.includes(sub)) return n === 0
  if (AB_ONE.includes(sub) && sub !== 'wait') return n === 1
  switch (sub) {
    case 'open':
      return n === 1 && urlOk(first, ctx)
    case 'fill':
    case 'type':
      return n === 2
    case 'select':
      return n >= 2
    case 'keyboard':
      return n === 2 && (first === 'type' || first === 'inserttext')
    case 'scroll':
      return ['up', 'down', 'left', 'right'].includes(first) && (n === 1 || (n === 2 && /^\d+$/.test(pos[1] ?? '')))
    case 'screenshot':
      return n === 1 && screenshotOk(first, ctx)
    case 'get':
      return n >= 1 && AB_GET.includes(first)
    case 'is':
      return n === 2 && ['visible', 'enabled', 'checked'].includes(first)
    case 'find':
      return findOk(pos)
    case 'wait':
      return waitOk(pos, opts)
    case 'network':
      // sem `--json` (não está na lista do `network`): o JSON de `network requests` traz cabeçalhos (cookies, tokens)
      return n === 1 && first === 'requests'
    default:
      return false
  }
}

// Só a sessão que o mod preparou, subcomandos da lista e opções da lista: o domínio e a política são fixados pelo script.
function agentBrowserOk(args: readonly string[], ctx: GuardCtx): boolean {
  const [flag, session, sub, ...rest] = args
  if (flag !== '--session' || ctx.session === '' || session !== ctx.session || sub === undefined) return false
  const parts = abParts(sub, rest)
  return parts !== null && abFormOk(sub, parts.pos, parts.opts, ctx)
}

// `detect` com a porta de depuração do mod e só as opções da lista.
function impeccableOk(args: readonly string[], ctx: GuardCtx): boolean {
  if (args[0] !== 'detect' || ctx.cdpPort === null) return false
  let cdp = false
  for (let i = 1; i < args.length; i++) {
    const w = args[i] ?? ''
    const v = args[i + 1] ?? ''
    if (w === '--json' || w === '--no-advisory') continue
    if (w === '--cdp' && v === String(ctx.cdpPort)) cdp = true
    else if (!(w === '--target' && v !== '' && !v.startsWith('-')) && !(w === '--scope' && /^[a-z,]+$/.test(v))) return false
    i++
  }
  return cdp
}

function curlOk(args: readonly string[], ctx: GuardCtx): boolean {
  let urls = 0
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? ''
    if (w.includes('@')) return false
    if (/^-[sSiIfkv]+$/.test(w) || CURL_FLAGS.includes(w)) continue
    if (CURL_VALUED.includes(w)) {
      const v = args[++i]
      const badMethod = (w === '-X' || w === '--request') && !CURL_METHODS.includes(v ?? '')
      // `%output{arquivo}` no write-out grava arquivo
      const writes = (w === '-w' || w === '--write-out') && /%output/i.test(v ?? '')
      if (v === undefined || v.includes('@') || badMethod || writes) return false
    // `{a,b}` e `[1-9]` o curl expande sozinho, em várias requisições
    } else if (w.startsWith('-') || !urlOk(w, ctx) || /[{}[\]]/.test(w)) {
      return false
    } else {
      urls++
    }
  }
  return urls > 0
}

function dockerLogsOk(args: readonly string[], ctx: GuardCtx): boolean {
  if (args[0] !== 'logs') return false
  const names: string[] = []
  for (let i = 1; i < args.length; i++) {
    const w = args[i] ?? ''
    const key = w.split('=')[0] ?? ''
    if (DOCKER_VALUED.includes(w)) {
      const v = args[++i]
      if (v === undefined || v.startsWith('-')) return false
    } else if (w === '-t' || w === '--timestamps' || (w.includes('=') && DOCKER_VALUED.includes(key))) {
      continue
    } else if (w.startsWith('-')) {
      return false
    } else {
      names.push(w)
    }
  }
  return names.length === 1 && ctx.containers.includes(names[0] ?? '')
}

// Caminho do git da worktree (depois de `--`): simples; com `/` ou começando com `.` tem que ficar dentro de fixDir.
function gitPathOk(w: string, ctx: GuardCtx): boolean {
  const inFix = isInside(resolveIn(w, ctx.fixDir, ctx.home), ctx.fixDir)
  return /^[A-Za-z0-9._/-]+$/.test(w) && !isSecretPath(w) && (!(w.includes('/') || w.startsWith('.')) || inFix)
}

// Referência (antes de `--`): só o HEAD da worktree, um hash ou um intervalo entre eles. Nome nenhum (`stash`, `refs/stash`, branch,
// `FETCH_HEAD`): o stash é de todas as worktrees e guarda os arquivos não versionados e os segredos do checkout do usuário.
const REV = '(HEAD(~\\d+|\\^)?|[0-9a-f]{7,40})'
const GIT_REV = new RegExp(`^${REV}(\\.\\.\\.?${REV})?$`)

function gitWorktreeOk(args: readonly string[], ctx: GuardCtx): boolean {
  const [flag, dir, sub, ...rest] = args
  const sameDir = dir !== undefined && dir.startsWith('/') && ctx.fixDir !== '' && normalizePath(dir) === normalizePath(ctx.fixDir)
  const spec = sub === undefined ? undefined : GIT_SPECS.get(sub)
  if (flag !== '-C' || !sameDir || spec === undefined) return false
  let afterDashes = false
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? ''
    if (afterDashes) {
      if (!gitPathOk(w, ctx)) return false
    } else if (w === '--' && spec.flags.includes(w)) {
      afterDashes = true
    } else if (spec.flags.includes(w)) {
      continue
    } else if (spec.count && w === '-n') {
      if (!/^\d+$/.test(rest[++i] ?? '')) return false
    } else if (spec.count && /^(--max-count=|-)\d+$/.test(w)) {
      continue
    } else if (!GIT_REV.test(w)) {
      return false
    }
  }
  return true
}

// ---- Busca no código pelo Bash (só fixer): forma fechada, só caminho absoluto em fixDir ou runDir ----

const LS_LETTERS = /^-[aAlLhR1tSrdF]+$/
// Busca por programa: só letras que não levam valor (conferidas no `rg --help` e no `grep --help` desta máquina) e as opções
// com valor que cada um tem. Sem `r`/`R`: o grep recursivo leria o `.env`; o rg já é recursivo (nele `-r` é "replace").
type SearchSpec = { letters: RegExp; numeric: readonly string[]; globs: readonly string[]; types: readonly string[] }
const SEARCH_SPECS = new Map<string, SearchSpec>([
  // no rg, `-E` é codificação e `-h` é ajuda
  ['rg', { letters: /^-[nilFwcoHsvx]+$/, numeric: ['-A', '-B', '-C', '-m', '--max-count', '--max-depth'], globs: ['-g', '--glob'], types: ['-t', '--type'] }],
  ['grep', { letters: /^-[nilFwcoHhsvxE]+$/, numeric: ['-A', '-B', '-C', '-m', '--max-count'], globs: ['--include', '--exclude', '--exclude-dir'], types: [] }],
])
// Glob e tipo passam por cima de "pular oculto" (e o glob, de "pular ignorado"): `*.env` acha `.env`, `*.local` acha `.env.local`.
// Por isso só extensões de código, que nenhum `.env*` usa.
// Sem json, yaml, txt, log e afins: costumam guardar segredo (`.creds.local.json`) ou saída.
const CODE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte', 'md', 'mdx', 'py', 'go', 'rs', 'java', 'php', 'rb', 'sql', 'graphql', 'prisma', 'svg']
// tipos do rg cujos globs são só `*.<extensão>` de código (`sh` traz `.env`; `ruby`, `.irbrc`; `java`, `*.properties`)
const RG_TYPES = ['ts', 'js', 'css', 'html', 'md', 'py', 'go', 'rust', 'php', 'sql', 'vue', 'svelte', 'sass', 'less']
// a forma `*.ext` (ou `**/*.ext`) já recusa glob cujo nome começa com ponto
const isCodeGlob = (v: string): boolean => CODE_EXTS.includes(/^(\*\*\/)?\*\.([A-Za-z0-9]+)$/.exec(v)?.[2] ?? '')
// o grep do Bash do Claude Code é o ugrep com `--hidden`: numa pasta ele lê os ocultos que o `.gitignore` de cima não cobre
const isCodeFile = (p: string): boolean => CODE_EXTS.includes(/^[^.][^/]*\.([A-Za-z0-9]+)$/.exec(p.slice(p.lastIndexOf('/') + 1))?.[1] ?? '')
const FIND_TESTS = ['-name', '-iname', '-path']

// shortcut: arquivo oculto que não se chama `.env*`, com o caminho por extenso dentro de fixDir, é legível (pela busca e pelo Read);
// vale porque o mod só copia `.env*` para a worktree. Se ele passar a copiar outro segredo, o nome entra aqui.
const isSecretPath = (p: string): boolean => p.split('/').some(seg => seg.toLowerCase().startsWith('.env'))
const hasSegment = (p: string, name: string): boolean => p.split('/').some(seg => seg.toLowerCase() === name)

function searchPathOk(w: string, ctx: GuardCtx): boolean {
  if (!w.startsWith('/')) return false
  const p = normalizePath(w)
  return !isSecretPath(p) && (isInside(p, ctx.fixDir) || isInside(p, ctx.runDir))
}

const optValueOk = (v: string | undefined): v is string => v !== undefined && !v.startsWith('-')

// O último argumento é caminho: um valor engolido por uma opção nunca deixa o comando sem caminho (aí ele varre a pasta da sessão).
function lsOk(args: readonly string[], ctx: GuardCtx): boolean {
  const paths = args.filter(w => !LS_LETTERS.test(w))
  const last = args[args.length - 1] ?? ''
  return paths.length > 0 && !LS_LETTERS.test(last) && paths.every(w => !w.startsWith('-') && searchPathOk(w, ctx))
}

// rg e grep: o primeiro posicional é o padrão (a não ser que haja -e); os demais são caminhos, e o último argumento é um deles.
// `null` se a forma não for a liberada.
// shortcut: padrão de busca com `|`, `<`, `>`, `$`, `\` ou `=>` é recusado pela regra "sem encadeador" (`isUnsafeShape`): o fixer busca
// por palavra simples; liberar exigiria interpretar as aspas do shell de verdade.
function searchPathsOf(prog: string, args: readonly string[]): string[] | null {
  const spec = SEARCH_SPECS.get(prog)
  if (spec === undefined) return null
  const pos: string[] = []
  let hasPattern = false
  let lastIsPos = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? ''
    lastIsPos = false
    if (spec.letters.test(w)) continue
    if (spec.numeric.includes(w) || spec.globs.includes(w) || spec.types.includes(w) || w === '-e') {
      const v = args[++i]
      if (!optValueOk(v)) return null
      if (spec.numeric.includes(w) && !/^\d+$/.test(v)) return null
      if (spec.globs.includes(w) && !isCodeGlob(v)) return null
      if (spec.types.includes(w) && !RG_TYPES.includes(v)) return null
      if (w === '-e') hasPattern = true
    } else if (w.startsWith('-')) {
      return null
    } else {
      pos.push(w)
      lastIsPos = true
    }
  }
  return lastIsPos ? (hasPattern ? pos : pos.slice(1)) : null
}

function grepOk(prog: string, args: readonly string[], ctx: GuardCtx): boolean {
  const paths = searchPathsOf(prog, args)
  const fileOk = (w: string): boolean => prog !== 'grep' || isCodeFile(normalizePath(w))
  return paths !== null && paths.length > 0 && paths.every(w => searchPathOk(w, ctx) && fileOk(w))
}

// Os caminhos de um `grep`: a trava pura não distingue arquivo de pasta, e numa pasta o grep lê os ocultos (`x.ts/` é pasta).
function grepTargetsOf(command: string): string[] {
  const [prog, ...args] = shellWords(command)
  return prog === 'grep' ? (searchPathsOf(prog, args) ?? []) : []
}

// find: caminhos primeiro; depois só -name/-iname/-path (sem nome oculto nem `.env`), -type f|d|l, -maxdepth/-mindepth e -not.
function findCmdOk(args: readonly string[], ctx: GuardCtx): boolean {
  let i = 0
  while (i < args.length && !(args[i] ?? '').startsWith('-')) {
    if (!searchPathOk(args[i] ?? '', ctx)) return false
    i++
  }
  if (i === 0) return false
  for (; i < args.length; i++) {
    const w = args[i] ?? ''
    const v = args[i + 1]
    if (w === '-not') continue
    const ok = FIND_TESTS.includes(w)
      ? optValueOk(v) && !v.startsWith('.') && !v.toLowerCase().includes('.env')
      : w === '-type'
        ? ['f', 'd', 'l'].includes(v ?? '')
        : (w === '-maxdepth' || w === '-mindepth') && /^\d+$/.test(v ?? '')
    if (!ok) return false
    i++
  }
  return true
}

function isAllowed(role: QaRole, command: string, ctx: GuardCtx, cwd: string): boolean {
  const [prog, ...args] = shellWords(command)
  if (prog === undefined || prog === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prog)) return false
  if (prog === ctx.agentBrowser) return agentBrowserOk(args, ctx)
  if (prog === ctx.impeccable) return impeccableOk(args, ctx)
  if (prog === 'curl') return curlOk(args, ctx)
  if (prog === 'docker') return role === 'observer' && dockerLogsOk(args, ctx) && argsOk(args, ctx, cwd)
  if (role !== 'fixer') return false
  if (prog === 'git') return gitWorktreeOk(args, ctx)
  if (prog === 'ls') return lsOk(args, ctx)
  if (prog === 'rg' || prog === 'grep') return grepOk(prog, args, ctx)
  return prog === 'find' && findCmdOk(args, ctx)
}

// `cwd` é a pasta da sessão do usuário (todo agente roda nela): é contra ela que se resolve caminho relativo.
export function bashCheckOf(role: QaRole, command: string, ctx: GuardCtx, cwd: string): BashVerdict {
  const denied = denyReason(role, command, ctx, cwd)
  if (denied !== null) return { decision: 'deny', reason: denied }
  if (isUnsafeShape(command)) return { decision: 'pass', reason: 'comando com encadeamento, expansão ou aspas que a trava não interpreta' }
  // `<fixDir>/link/..` sai da pasta quando `link` é simbólico, e a normalização não vê isso.
  // shortcut: argumento de Bash que passa por link simbólico (sem `..`) não é resolvido; Read, Write e Edit são, pelo hook.
  if (shellWords(command).some(w => !SCHEME.test(w) && hasSegment(w.replace(/=/g, '/'), '..'))) {
    return { decision: 'pass', reason: 'caminho com .. que a trava não libera' }
  }
  return isAllowed(role, command, ctx, cwd)
    ? { decision: 'allow', reason: 'comando liberado pela trava de QA' }
    : { decision: 'pass', reason: 'comando fora da lista liberada pela trava de QA' }
}

// Arquivo que muda o que o rg e o grep pulam: com `!.env` dentro, a busca seguinte leria o `.env`.
const isIgnoreFile = (p: string): boolean => ['.ignore', '.rgignore', '.gitignore'].includes(p.slice(p.lastIndexOf('/') + 1).toLowerCase())

// Caminho absoluto do pedido, ou `null`: vazio, com til (o bash não o expande entre aspas e os agentes recebem caminhos absolutos)
// ou com `..` (que sai da pasta quando o segmento anterior é link simbólico).
function filePathOf(filePath: string, ctx: GuardCtx, cwd: string): string | null {
  if (filePath === '' || filePath.startsWith('~') || hasSegment(filePath.replace(/\\/g, '/'), '..')) return null
  return resolveIn(filePath, cwd, ctx.home)
}

// Gravar só no runDir (qualquer papel) ou, para o fixer, na worktree de correção; nunca num `.git`, de nenhuma pasta (config e hooks
// do git rodam código).
export function writeCheckOf(role: QaRole, filePath: string, ctx: GuardCtx, cwd: string): 'allow' | 'deny' {
  const p = filePathOf(filePath, ctx, cwd)
  // mudar o `.env` da cópia faria o reteste passar sem corrigir o código
  if (p === null || isSecretPath(p) || isIgnoreFile(p) || hasSegment(p, '.git')) return 'deny'
  return isInside(p, ctx.runDir) || (role === 'fixer' && isInside(p, ctx.fixDir)) ? 'allow' : 'deny'
}

// Ler: runDir, pastas de leitura extras e, só para o fixer, a worktree; nunca `.env*`.
export function readCheckOf(role: QaRole, filePath: string, ctx: GuardCtx, cwd: string): 'allow' | 'deny' {
  const p = filePathOf(filePath, ctx, cwd)
  if (p === null || isSecretPath(p)) return 'deny'
  const inside = isInside(p, ctx.runDir) || ctx.readDirs.some(dir => isInside(p, dir)) || (role === 'fixer' && isInside(p, ctx.fixDir))
  return inside ? 'allow' : 'deny'
}

// ---- O que o hook de comando chama ----

const isRole = (v: unknown): v is QaRole => v === 'runner' || v === 'observer' || v === 'fixer'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const STRING_FIELDS = ['home', 'repoRoot', 'fixDir', 'runDir', 'agentBrowser', 'impeccable', 'session'] as const
const LIST_FIELDS = ['readDirs', 'origins', 'containers'] as const

// Caminho absoluto já normalizado e com pelo menos dois segmentos: `/`, `/home` e `/a/../b` não servem de pasta liberada.
const isDeepPath = (p: string): boolean => p.startsWith('/') && normalizePath(p) === p && p.split('/').length >= 3
const isOrigin = (o: string): boolean => {
  try {
    const u = new URL(o)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o
  } catch {
    return false
  }
}

const within = (p: string, dir: string): boolean => p !== dir && isInside(p, dir)

// Valores do contexto: caminhos absolutos normalizados com 2+ segmentos; `fixDir` vazio ou dentro de `repoRoot` (sem ser ele) e sem
// segmento `.git`; `runDir` dentro de `<home>/.claude/workbench-qa/`, nem dentro nem contendo `repoRoot`; cada `readDirs` dentro de
// `runDir`, de `<home>/.claude/workbench-qa/` ou de `<home>/.claude/skills/`, sem conter `repoRoot`; origens http(s), porta e sessão.
function ctxValuesOk(c: GuardCtx): boolean {
  const qaHome = `${c.home}/.claude/workbench-qa`
  const paths = [c.home, c.repoRoot, c.runDir, c.agentBrowser, c.impeccable].every(isDeepPath)
  const fix = c.fixDir === '' || (isDeepPath(c.fixDir) && within(c.fixDir, c.repoRoot) && !hasSegment(c.fixDir, '.git'))
  const run = within(c.runDir, qaHome) && !isInside(c.runDir, c.repoRoot) && !isInside(c.repoRoot, c.runDir)
  const readRoots = [c.runDir, qaHome, `${c.home}/.claude/skills`]
  const reads = c.readDirs.every(d => isDeepPath(d) && readRoots.some(r => within(d, r)) && !isInside(c.repoRoot, d))
  const port = c.cdpPort === null || (Number.isInteger(c.cdpPort) && c.cdpPort >= 1 && c.cdpPort <= 65535)
  return paths && fix && run && reads && port && c.origins.every(isOrigin) && /^[A-Za-z0-9_-]*$/.test(c.session)
}

// O contexto vem de um arquivo: confere cada campo.
function ctxOf(raw: unknown): GuardCtx | null {
  if (!isRecord(raw)) return null
  const okStrings = STRING_FIELDS.every(k => typeof raw[k] === 'string')
  const okLists = LIST_FIELDS.every(k => isStrings(raw[k]))
  const port = raw['cdpPort']
  if (!okStrings || !okLists || !(port === null || typeof port === 'number')) return null
  const ctx = {
    home: String(raw['home']),
    repoRoot: String(raw['repoRoot']),
    fixDir: String(raw['fixDir']),
    runDir: String(raw['runDir']),
    readDirs: raw['readDirs'] as string[],
    agentBrowser: String(raw['agentBrowser']),
    impeccable: String(raw['impeccable']),
    session: String(raw['session']),
    cdpPort: port,
    origins: raw['origins'] as string[],
    containers: raw['containers'] as string[],
  }
  return ctxValuesOk(ctx) ? ctx : null
}

type GuardState = { role: QaRole; agentId: string | null; ctx: GuardCtx }

function stateOf(text: string | null): GuardState | null {
  if (text === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !isRole(raw['role'])) return null
  const agentId = raw['agentId']
  const ctx = ctxOf(raw['ctx'])
  if (ctx === null || !(agentId === null || typeof agentId === 'string')) return null
  return { role: raw['role'], agentId, ctx }
}

type Decision = { decision: 'allow' | 'deny'; reason: string }
const deny = (reason: string): Decision => ({ decision: 'deny', reason })
// O sistema de arquivos que o hook vê: caminho real (links simbólicos resolvidos; `null` se não deu para resolver) e se é arquivo.
export type FsView = { realOf: (absPath: string) => string | null; isFile: (absPath: string) => boolean }

// O pedido e o caminho real têm que passar os dois: um link em fixDir apontando para o checkout cai fora da pasta liberada.
function realOk(check: (p: string) => 'allow' | 'deny', path: string, ctx: GuardCtx, cwd: string, fs: FsView): boolean {
  if (check(path) === 'deny') return false
  const real = fs.realOf(resolveIn(path, cwd, ctx.home))
  return real !== null && check(real) === 'allow'
}

function bashDecision(role: QaRole, command: string, ctx: GuardCtx, cwd: string, fs: FsView): Decision {
  const v = bashCheckOf(role, command, ctx, cwd)
  if (v.decision !== 'allow') return deny(v.reason)
  const folder = grepTargetsOf(command).find(p => !fs.isFile(normalizePath(p)))
  return folder === undefined ? { decision: 'allow', reason: v.reason } : deny(`grep só lê arquivo regular: ${folder}`)
}

function toolDecision(role: QaRole, tool: string, toolInput: Record<string, unknown>, ctx: GuardCtx, cwd: string, fs: FsView): Decision {
  const command = toolInput['command']
  const path = toolInput['file_path']
  switch (tool) {
    case 'Bash':
      return typeof command === 'string' ? bashDecision(role, command, ctx, cwd, fs) : deny('Bash sem comando em texto')
    case 'Write':
    case 'Edit':
      if (typeof path !== 'string') return deny(`${tool} sem file_path em texto`)
      return realOk(p => writeCheckOf(role, p, ctx, cwd), path, ctx, cwd, fs) ? { decision: 'allow', reason: 'gravação dentro da pasta liberada' } : deny(`gravar em ${path} é proibido para agentes de QA`)
    case 'Read':
      if (typeof path !== 'string') return deny('Read sem file_path em texto')
      return realOk(p => readCheckOf(role, p, ctx, cwd), path, ctx, cwd, fs) ? { decision: 'allow', reason: 'leitura dentro da pasta liberada' } : deny(`ler ${path} é proibido para agentes de QA`)
    default:
      return deny(`a ferramenta ${tool} não é liberada para agentes de QA`)
  }
}

// Decisão estrita do hook PreToolUse: o que a trava não libera é negado. Nunca lança.
export function guardDecisionOf(role: string, input: unknown, stateText: string | null, fs: FsView): Decision {
  try {
    if (!isRole(role)) return deny(`papel desconhecido: ${role}`)
    const state = stateOf(stateText)
    if (state === null) return deny('contexto de QA ausente ou inválido')
    if (state.role !== role) return deny('o papel do arquivo de contexto é outro: agente fora de vez')
    if (!isRecord(input)) return deny('entrada do hook com forma inesperada')
    const { tool_name: tool, tool_input: toolInput, cwd, agent_id: agentId } = input
    if (typeof tool !== 'string' || !isRecord(toolInput) || typeof cwd !== 'string' || !cwd.startsWith('/')) {
      return deny('entrada do hook com forma inesperada')
    }
    if (state.agentId !== null && state.agentId !== agentId) return deny('agente aposentado: o id não é o do contexto')
    return toolDecision(role, tool, toolInput, state.ctx, cwd, fs)
  } catch (error) {
    return deny(`erro interno na trava de QA: ${error instanceof Error ? error.message : 'desconhecido'}`)
  }
}
