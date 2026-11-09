// A trava dos agentes de QA: regra pura que diz se um comando de Bash ou uma gravação de arquivo é liberada, negada ou deixada
// para a decisão normal. É por padrões, não interpreta shell de verdade: na dúvida, recusa (deny) ou não opina (pass).
import { isInside, normalizePath } from './model'

export type QaRole = 'runner' | 'observer' | 'fixer'
export type GuardCtx = {
  home: string
  repoRoot: string
  fixDir: string
  runDir: string
  agentBrowser: string
  impeccable: string
  session: string
  cdpPort: number | null
  origins: readonly string[]
  testCommand: string
  containers: readonly string[]
}
export type BashVerdict = { decision: 'allow' | 'deny' | 'pass'; reason: string }

const GIT_DENIED = ['push', 'checkout', 'switch', 'merge', 'rebase', 'stash', 'reset', 'clean', 'worktree', 'config', 'remote']
const GIT_ARG_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--shallow-file']
const GIT_WORKTREE_SUBS = ['add', 'commit', 'diff', 'status', 'log']
const GIT_BANNED_LONG = ['--no-verify', '--ext-diff', '--no-index', '--output']
const CURL_FLAGS = ['--silent', '--show-error', '--include', '--head', '--fail', '--insecure', '--verbose']
const CURL_VALUED = ['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '-m', '--max-time', '--connect-timeout', '-w', '--write-out']
const CURL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const DOCKER_VALUED = ['--since', '--until', '--tail', '-n']
const AB_FLAGS = ['-i', '--interactive', '-c', '--compact', '--full', '--json', '--exact', '--clear']
const AB_VALUED = ['-d', '--depth', '--name']
const AB_NETWORK_VALUED = ['--filter', '--type', '--method', '--status']
const AB_ONE = ['click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'press', 'wait']
const AB_NONE = ['snapshot', 'back', 'forward', 'reload', 'console', 'errors']
const AB_GET = ['text', 'value', 'attr', 'title', 'url', 'count', 'box', 'styles']
const AB_FIND_BY = ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth']
const AB_FIND_DO = ['click', 'dblclick', 'fill', 'type', 'hover', 'focus', 'check', 'uncheck', 'text']
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

function workDirOf(role: QaRole, ctx: GuardCtx): string {
  switch (role) {
    case 'fixer':
      return ctx.fixDir !== '' ? ctx.fixDir : ctx.repoRoot
    case 'runner':
    case 'observer':
      return ctx.repoRoot
    default:
      throw new Error('Caso não tratado: ' + String(role satisfies never))
  }
}

// `~` e `~/x` contra a home; `~user` contra a pasta ao lado da home (aproximação); relativo contra a pasta de trabalho.
function resolveIn(path: string, base: string, home: string): string {
  const p = path.replace(/\\/g, '/')
  if (p.startsWith('/')) return normalizePath(p)
  if (p === '~' || p.startsWith('~/')) return normalizePath(`${home}${p.slice(1)}`)
  if (p.startsWith('~')) return normalizePath(`${home}/../${p.slice(1)}`)
  return normalizePath(`${base}/${p}`)
}

const isOp = (t: string): boolean => t.length === 1 && ';&|()<>\n'.includes(t)

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
    // o bash só expande `~/` solto no começo de uma palavra; entre aspas é texto literal
    if (c === '~' && !(quote === '' && (i === 0 || command[i - 1] === ' ') && command[i + 1] === '/')) return true
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

function gitDenyReason(ws: readonly string[], at: number): string | null {
  let j = at + 1
  while (j < ws.length && (ws[j] ?? '').startsWith('-')) {
    const w = ws[j] ?? ''
    const config = w === '-c' || w === '--config-env' ? ws[j + 1] : w.startsWith('--config-env=') ? w.slice(13) : undefined
    if (config?.toLowerCase().startsWith('alias.')) return 'git com alias é proibido (pode esconder um push)'
    const known = GIT_ARG_OPTS.includes(w)
    // opção desconhecida pode levar argumento: olha as duas palavras seguintes
    const hides = !known && !w.includes('=') && [ws[j + 1], ws[j + 2]].some(x => x !== undefined && GIT_DENIED.includes(x))
    if (hides) return `git com opção desconhecida ${w} antes de subcomando proibido`
    j += known ? 2 : 1
  }
  const sub = ws[j]
  if (sub === undefined) return null
  if (GIT_DENIED.includes(sub)) return `git ${sub} é proibido para agentes de QA`
  if (sub === 'branch' && ws.slice(j + 1).some(isBranchDelete)) return 'git branch com apagar é proibido para agentes de QA'
  return null
}

// Um candidato (palavra inteira ou o trecho depois do primeiro `=`) que parece caminho e cai no checkout principal.
function checkoutPathReason(word: string, role: QaRole, ctx: GuardCtx): string | null {
  const w = word.replace(/\\/g, '/')
  const eq = w.indexOf('=')
  for (const c of eq < 0 ? [w] : [w, w.slice(eq + 1)]) {
    const pathy = /^(\/|~|\.\/|\.\.\/)/.test(c) || c.split('/').includes('..')
    if (!pathy || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(c)) continue
    const p = resolveIn(c, workDirOf(role, ctx), ctx.home)
    if (isInside(p, ctx.repoRoot) && !isInside(p, ctx.fixDir)) return `caminho do checkout principal é proibido: ${c}`
  }
  return null
}

function cdDenyReason(tokens: readonly string[], at: number, role: QaRole, ctx: GuardCtx): string | null {
  const next = tokens[at + 1]
  const dest = next === undefined || isOp(next) ? '~' : next
  const stays = role === 'fixer' && !dest.startsWith('-') && !dest.includes('$') && isInside(resolveIn(dest, workDirOf(role, ctx), ctx.home), ctx.fixDir)
  if (stays) return null
  return role === 'fixer' ? `${tokens[at]} para fora da worktree de correção é proibido` : `${tokens[at]} é proibido para runner e observer`
}

function denyReason(role: QaRole, command: string, ctx: GuardCtx): string | null {
  const tokens = command.match(/[^\s'"`;&|()<>]+|[;&|()<>\n]/g) ?? []
  for (const ws of [tokens.filter(t => !isOp(t)), shellWords(command)]) {
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i] ?? ''
      const name = programOf(w)
      const reason =
        name === 'gh'
          ? 'gh (GitHub CLI) é proibido para agentes de QA'
          : name === 'git'
            ? role === 'fixer'
              ? gitDenyReason(ws, i)
              : 'git é proibido para runner e observer'
            : checkoutPathReason(w, role, ctx)
      if (reason !== null) return reason
    }
  }
  // `tokens` guarda os operadores (`cd && x` vai para a home); `shellWords` junta as aspas (`c''d`)
  for (const ws of [tokens, shellWords(command)]) {
    for (let i = 0; i < ws.length; i++) {
      const cd = ws[i] === 'cd' || ws[i] === 'pushd' ? cdDenyReason(ws, i, role, ctx) : null
      if (cd !== null) return cd
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

function valueOk(v: string, role: QaRole, ctx: GuardCtx): boolean {
  if (SCHEME.test(v)) return urlOk(v, ctx)
  if (!v.includes('/') && v !== '..' && v !== '~') return true
  const p = resolveIn(v, workDirOf(role, ctx), ctx.home)
  return isInside(p, ctx.runDir) || (role === 'fixer' && isInside(p, ctx.fixDir))
}

// Palavra inteira e, se houver `=`, o trecho depois dele.
function wordOk(w: string, role: QaRole, ctx: GuardCtx): boolean {
  const eq = w.indexOf('=')
  return valueOk(w, role, ctx) && (eq < 0 || valueOk(w.slice(eq + 1), role, ctx))
}

const argsOk = (args: readonly string[], role: QaRole, ctx: GuardCtx): boolean => args.every(w => wordOk(w, role, ctx))

// Opções do agent-browser: separa em posicionais e `null` se aparecer opção fora da lista.
function abParts(rest: readonly string[], network: boolean): { pos: string[]; opts: string[] } | null {
  const pos: string[] = []
  const opts: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? ''
    if (AB_FLAGS.includes(w)) {
      opts.push(w)
    } else if (AB_VALUED.includes(w) || (network && AB_NETWORK_VALUED.includes(w))) {
      const v = rest[++i]
      const bad = v === undefined || v.startsWith('-') || ((w === '-d' || w === '--depth') && !/^\d+$/.test(v))
      if (bad) return null
      opts.push(w)
    } else if (w.startsWith('-')) {
      return null
    } else {
      pos.push(w)
    }
  }
  return { pos, opts }
}

// `screenshot` só grava .png com caminho absoluto dentro de runDir.
function screenshotOk(path: string | undefined, ctx: GuardCtx): boolean {
  if (path === undefined || !path.startsWith('/')) return false
  const p = normalizePath(path)
  return p.endsWith('.png') && isInside(p, ctx.runDir)
}

function abFormOk(sub: string, pos: readonly string[], opts: readonly string[], ctx: GuardCtx): boolean {
  const n = pos.length
  const first = pos[0] ?? ''
  if (AB_NONE.includes(sub)) return n === 0
  if (AB_ONE.includes(sub)) return n === 1
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
      return (n === 3 || n === 4) && AB_FIND_BY.includes(first) && AB_FIND_DO.includes(pos[2] ?? '')
    case 'network':
      // o JSON de `network requests` traz cabeçalhos (cookies, tokens)
      return n === 1 && first === 'requests' && !opts.includes('--json')
    default:
      return false
  }
}

// Só a sessão que o mod preparou, subcomandos da lista e opções da lista: o domínio e a política são fixados pelo script.
function agentBrowserOk(args: readonly string[], ctx: GuardCtx): boolean {
  const [flag, session, sub, ...rest] = args
  if (flag !== '--session' || ctx.session === '' || session !== ctx.session || sub === undefined) return false
  const parts = abParts(rest, sub === 'network')
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
    } else if (w.startsWith('-') || !urlOk(w, ctx)) {
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

// Opção proibida no git da worktree, inclusive abreviada (`--no-ver` vale como `--no-verify`).
function gitOptionBanned(w: string, sub: string): boolean {
  const name = w.split('=')[0] ?? ''
  const long = name.length > 2 && name.startsWith('--') && (GIT_BANNED_LONG.some(b => b.startsWith(name)) || name.startsWith('--output'))
  return w === '-c' || long || (sub === 'commit' && /^-[^-]*n/.test(w))
}

function gitWorktreeOk(args: readonly string[], role: QaRole, ctx: GuardCtx): boolean {
  const [flag, dir, sub, ...rest] = args
  const sameDir = dir !== undefined && dir.startsWith('/') && ctx.fixDir !== '' && normalizePath(dir) === normalizePath(ctx.fixDir)
  if (flag !== '-C' || !sameDir || sub === undefined || !GIT_WORKTREE_SUBS.includes(sub)) return false
  const checked: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? ''
    // a mensagem do commit é texto livre: não passa pela conferência de caminho nem de URL
    if (sub === 'commit' && (w === '-m' || w === '--message')) i++
    else if (!(sub === 'commit' && w.startsWith('--message='))) checked.push(w)
  }
  return !checked.some(w => gitOptionBanned(w, sub)) && argsOk([dir, sub, ...checked], role, ctx)
}

function isAllowed(role: QaRole, command: string, ctx: GuardCtx): boolean {
  const [prog, ...args] = shellWords(command)
  if (prog === undefined || prog === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prog)) return false
  if (role === 'fixer' && ctx.testCommand !== '' && command.trim() === ctx.testCommand) return true
  if (prog === ctx.agentBrowser) return agentBrowserOk(args, ctx)
  if (prog === ctx.impeccable) return impeccableOk(args, ctx)
  if (prog === 'curl') return curlOk(args, ctx)
  if (prog === 'docker') return role === 'observer' && dockerLogsOk(args, ctx) && argsOk(args, role, ctx)
  if (prog === 'git') return role === 'fixer' && gitWorktreeOk(args, role, ctx)
  return false
}

export function bashCheckOf(role: QaRole, command: string, ctx: GuardCtx): BashVerdict {
  const denied = denyReason(role, command, ctx)
  if (denied !== null) return { decision: 'deny', reason: denied }
  if (isUnsafeShape(command)) return { decision: 'pass', reason: 'comando com encadeamento, expansão ou aspas que a trava não interpreta' }
  return isAllowed(role, command, ctx)
    ? { decision: 'allow', reason: 'comando liberado pela trava de QA' }
    : { decision: 'pass', reason: 'comando fora da lista liberada' }
}

// Gravar só no runDir (qualquer papel) ou, para o fixer, na worktree de correção (menos o `.git`, que aponta para outro repositório).
export function writeCheckOf(role: QaRole, filePath: string, ctx: GuardCtx): 'allow' | 'deny' {
  // o bash não expande `~` entre aspas e os agentes recebem caminhos absolutos
  if (filePath === '' || filePath.startsWith('~')) return 'deny'
  const p = resolveIn(filePath, workDirOf(role, ctx), ctx.home)
  if (isInside(p, ctx.runDir)) return 'allow'
  const inFix = role === 'fixer' && isInside(p, ctx.fixDir) && !isInside(p, `${normalizePath(ctx.fixDir)}/.git`)
  return inFix ? 'allow' : 'deny'
}
