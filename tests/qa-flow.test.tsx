import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  AGENT_TIMEOUT_MS,
  QA_AUTH_TOOL,
  QA_FIXER,
  QA_OBSERVER,
  QA_PLANNER,
  QA_RUNNER,
  authFileOf,
  binOf,
  qaLoginPromptOf,
  qaRootOf,
  toolsDirOf,
  wrapperOf,
} from '../hooks/qa'
import type { Matrix } from '../hooks/qa-evidence'
import { ARM_MS } from '../hooks/stale'

// O fluxo de QA pelo engine: a faixa montada, o botão QA, o timer de 3 s e hooks do teste no lugar do engine para env,
// processos (respostas por comando), arquivos (um mapa em memória), agentes, ferramenta e campo de prompt. Nenhum processo
// de verdade roda: todo `process.run`, `fs.write` e `fs.exists` é respondido aqui.
const BAND = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const HOME = '/home/u'
const REPO = '/work/app'
const QA_ROOT = qaRootOf(HOME, REPO)
const AB = wrapperOf(QA_ROOT, 'ab')
const AUTH = authFileOf(QA_ROOT, 'admin')
const crit = { given: 'logado', when: 'clica em Salvar', then: 'vê a confirmação' }
const cellOf = (id: string, profile: string) => ({
  id,
  requirement: 'r1',
  risk: 'alto' as const,
  flow: 'cadastro',
  route: '/cadastro',
  profile,
  width: 1280 as const,
  reason: 'fluxo principal',
  steps: ['abrir a tela'],
  criteria: [crit],
  expectedStatus: [],
})
const MATRIX: Matrix = {
  baseUrl: 'http://localhost:3000',
  loginRoute: '/entrar',
  allowedDomains: [],
  installCommand: 'npm ci',
  startCommand: 'npm run dev -- --port {QA_PORT}',
  testCommand: 'npm test',
  testDir: '',
  backend: { containers: ['api'] },
  profiles: ['admin', 'anonimo'],
  requirements: [{ id: 'r1', text: 'Salvar item', source: 'issue 1' }],
  cells: [cellOf('c1', 'admin'), cellOf('c2', 'anonimo')],
  cut: [],
}
const mdOf = (m: unknown): string => `# Matriz\n\n\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\`\n`
const authOf = (expires: number) =>
  JSON.stringify({
    cookies: [{ name: 'sid', value: 'SEGREDO', domain: 'localhost', path: '/', expires }],
    origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'tok', value: 'SEGREDO2' }] }],
  })
const verdictOf = (id: string, verdict: string, defects: unknown[] = []) =>
  JSON.stringify({ id, verdict, evidence: [{ criterion: 0, proof: 'ok' }], defects, backend: 'lido' })
const FAIL_DEFECT = { id: 'd1', source: 'criterio', rule: '0', where: 'button.salvar', repro: ['abrir'], kind: 'funcional', severity: 'fail' }

type Run = { exitCode: number; stdout: string }
// `hold`: a resposta àquele comando (a linha do argv, ou 'agent.list') chega HOLD_MS depois, segurando o passo do timer.
// `failWrite`: a gravação daquele arquivo falha (vai ao hook de baixo do engine, que lança).
type Over = {
  home?: string
  typed?: string
  drop?: boolean
  run?: (argv: readonly string[], cwd?: string, env?: Record<string, string>) => Run | undefined
  spawns?: { unlisted?: boolean; deny?: string }[]
  hold?: (key: string) => boolean
  failWrite?: (path: string, text: string) => boolean
  // `stall`: a resposta àquele comando nunca chega (o passo some, como num reload do mod no meio dele).
  stall?: (key: string) => boolean
}
const HOLD_MS = 4_000
type Agent = { id: string; type: string; status: 'running' | 'completed'; description: string }

async function boot($: Engine, on: On, over: Over = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const box = { text: over.typed ?? '' }
  const listed: Agent[] = []
  const log = {
    runs: [] as string[][],
    submits: [] as string[],
    toasts: [] as string[],
    guards: [] as string[],
    spawns: [] as { type: string; prompt: string }[],
    agents: [] as { name: string; command: string }[],
    tools: [] as string[],
    full: [] as { argv: string[]; cwd: string; env: Record<string, string> }[],
    apps: [] as { argv: string[]; cwd: string; env: Record<string, string> }[],
    appStops: 0,
  }
  // A worktree da fase Corrigir: o `git status` dela (o teste o muda como faria o corretor), os commits feitos pelo mod, o HEAD
  // (anda a cada commit, volta no reset) e `lost` (a pasta perdeu o `.git`: o `rev-parse --show-toplevel` falha).
  const wt = { status: '', commits: [] as string[][], head: 'abc123', lost: false }
  let n = 0
  const answer = (argv: readonly string[], env?: Record<string, string>): Run => {
    const ok = (stdout = ''): Run => ({ exitCode: 0, stdout })
    const line = argv.join(' ')
    if (line.includes('--git-common-dir')) return ok(`${REPO}/.git\n`)
    if (argv[0] === 'mkdir') {
      dirs.add(argv[2] ?? '')
      return ok()
    }
    if (argv[0] === 'rm') {
      const target = argv[2] ?? ''
      for (const k of [...files.keys()]) if (k === target || (argv[1] === '-rf' && k.startsWith(`${target}/`))) files.delete(k)
      return ok()
    }
    if (argv[0] === 'chmod' || argv[0] === 'curl') return ok()
    if (line === 'git rev-parse HEAD') return ok('abc123\n')
    if (line === 'git status --porcelain') return ok('')
    if (argv[0] === AB) return line.endsWith('get cdp-url') ? ok('ws://127.0.0.1:9333/devtools/browser/x\n') : ok()
    // Git na worktree: sempre com o teto que impede o git de subir até o repositório da raiz.
    if (argv[0] === 'env' && argv[1] === `GIT_CEILING_DIRECTORIES=${REPO}/.worktrees` && argv[2] === 'git' && argv[3] === '-C') return worktreeGit(argv[4] ?? '', argv.slice(5), ok)
    if (argv[0] === 'git' && argv[1] === '-C') return rootGit(argv.slice(3), ok)
    if (line.startsWith('git worktree add ')) {
      dirs.add(argv[3] ?? '')
      return ok()
    }
    if (argv[0] === 'cp' && argv[1] === '-r') {
      const [from = '', to = ''] = argv.slice(2)
      for (const [k, v] of [...files]) if (k.startsWith(`${from}/`)) files.set(`${to}${k.slice(from.length)}`, v)
      return ok()
    }
    if (argv[0] === 'cp') {
      files.set(argv[2] ?? '', files.get(argv[1] ?? '') ?? '')
      return ok()
    }
    if (argv[0] === 'node') return ok('4100\n')
    if (argv[0] === 'npm') return ok()
    if (line === 'git ls-files --error-unmatch .env.example') return ok('.env.example\n')
    // O teste de regressão falha no app original e passa no da worktree.
    if (argv[0] === 'npx') return { exitCode: env?.QA_BASE_URL === MATRIX.baseUrl ? 1 : 0, stdout: '' }
    return { exitCode: 1, stdout: '' }
  }
  // O checkout do usuário: HEAD e branch fixos.
  const rootGit = (args: readonly string[], ok: (stdout?: string) => Run): Run => {
    const sub = args.join(' ')
    if (sub === 'rev-parse HEAD') return ok('abc123\n')
    if (sub === 'rev-parse --abbrev-ref HEAD') return ok('main\n')
    return ok()
  }
  const worktreeGit = (dir: string, args: readonly string[], ok: (stdout?: string) => Run): Run => {
    const sub = args.join(' ')
    if (sub === 'rev-parse --show-toplevel') return wt.lost ? { exitCode: 128, stdout: '' } : ok(`${dir}\n`)
    if (sub === 'rev-parse HEAD') return ok(`${wt.head}\n`)
    if (sub === 'rev-parse --abbrev-ref HEAD') return ok('main\n')
    if (sub === 'status --porcelain') return ok(wt.status)
    if (args[0] === 'commit') {
      wt.commits.push([...args])
      wt.status = ''
      wt.head = `c${wt.commits.length}`
      return ok()
    }
    if (args[0] === 'reset') wt.head = args[3] ?? wt.head
    if (args[0] === 'reset' || args[0] === 'clean') wt.status = ''
    if (args[0] === 'log') return ok(wt.commits.map((_, i) => `f${i} corrige`).join('\n'))
    return ok()
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: REPO }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? (over.home ?? HOME) : undefined }))
  on('process.run', async (_$, e) => {
    // O teto do git vai pelo ambiente; aqui ele é escrito na frente do comando, para cada teste conferir comando e teto juntos.
    const ceiling = e.init?.env?.GIT_CEILING_DIRECTORIES
    const argv = ceiling === undefined ? [...e.argv] : ['env', `GIT_CEILING_DIRECTORIES=${ceiling}`, ...e.argv]
    if (over.hold?.(argv.join(' ')) === true) await clock.sleep(HOLD_MS)
    if (over.stall?.(argv.join(' ')) === true) await clock.sleep(1e12)
    log.runs.push(argv)
    log.full.push({ argv: [...e.argv], cwd: e.init?.cwd ?? '', env: { ...e.init?.env } })
    const r = over.run?.(argv, e.init?.cwd, e.init?.env) ?? answer(argv, e.init?.env)
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.list', (_$, e) => ({
    value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  // O app da worktree: vive até o mod chamar return() no iterador (o sinal do hook aborta).
  on('process.spawn', async function* (_$, e, next) {
    log.apps.push({ argv: [...e.argv], cwd: e.cwd ?? '', env: { ...e.env } })
    yield { stream: 'stdout' as const, text: 'pronto' }
    await new Promise<void>(r => next.signal.addEventListener('abort', () => r()))
    log.appStops += 1
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('fs.read', (_$, e, next) => {
    const text = files.get(e.path)
    return text === undefined ? next(e) : { value: text }
  })
  on('fs.write', (_$, e, next) => {
    if (over.failWrite?.(e.path, e.text) === true) return next(e)
    files.set(e.path, e.text)
    if (/\/guard-[a-z0-9]+\.json$/.test(e.path)) log.guards.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => {
    log.agents.push({ name: e.name, command: JSON.stringify(e.hooks ?? null) })
    return { value: { agent: e.name } }
  })
  on('tool.register', (_$, e) => {
    log.tools.push(e.name)
    return { value: { tool: `mcp__workbench__${e.name}` } }
  })
  // O harness só respeita o `{ deny }` deste hook: o resultado de sucesso vira `{ model }`, sem agentId. O agente lançado
  // aparece então na lista (`a<n>`, vivo), e o mod o adota no tique seguinte, como faria num lançamento sem id.
  on('agent.spawn', (_$, e) => {
    // O harness entrega o pedido na forma da ferramenta Agent (`subagent_type`), não no `subagentType` do tipo.
    const type = e.subagentType ?? String(Reflect.get(e, 'subagent_type'))
    log.spawns.push({ type, prompt: e.prompt })
    n += 1
    const r = over.spawns?.shift() ?? {}
    if (r.deny !== undefined) return { deny: r.deny }
    if (r.unlisted !== true) listed.push({ id: `a${n}`, type, status: 'running', description: 'x' })
    return { model: 'sonnet' }
  })
  on('agent.list', async () => {
    if (over.hold?.('agent.list') === true) await clock.sleep(HOLD_MS)
    return { value: listed }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    box.text = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    log.submits.push(e.text)
    return over.drop === true ? { drop: 'recusado no teste' } : { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId, kind: 'engine' as const, ref: 1 }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.offer', () => ({ isOffered: true }))
  await start($)
  const runDir = () => [...dirs].find(d => /\/\d{8}-\d{4}$/.test(d)) ?? ''
  const guard = () => JSON.parse(log.guards.at(-1) ?? '{}')
  return { clock, files, dirs, box, listed, log, runDir, guard, wt }
}

type T = Awaited<ReturnType<typeof boot>>
const start = ($: Engine) => $.session.start({ cwd: REPO, surface: null, isInteractive: true })
const tick = (t: T) => t.clock.advance(3_100)
const mount = ($: Engine) => $.ui.mount(BAND)
type Ui = Awaited<ReturnType<typeof mount>>
const label = async (ui: Ui) => (await ui.find({ type: 'Button', key: 'qa' }))?.text
const click = async (t: T, ui: Ui) => {
  await ui.press({ key: 'qa' })
  await tick(t)
}
const ended = ($: Engine, agentId: string) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason: 'answer', agentId })
const command = ($: Engine, args: string) =>
  $.command.run({ command: 'workbench', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
const types = (t: T) => t.log.spawns.map(s => s.type)

// Planejar e Login, com a matriz gravada no meio (é o que o planner faria).
async function toLogin($: Engine, on: On, over: Over = {}, matrix: unknown = MATRIX) {
  const t = await boot($, on, over)
  const ui = await mount($)
  await click(t, ui)
  t.files.set(`${t.runDir()}/matriz.md`, typeof matrix === 'string' ? matrix : mdOf(matrix))
  await click(t, ui)
  return { t, ui }
}

// Pronto para o clique Executar: ferramentas instaladas e login do admin salvo.
async function toRun($: Engine, on: On, over: Over = {}, matrix: unknown = MATRIX) {
  const r = await toLogin($, on, over, matrix)
  const home = over.home ?? HOME
  r.t.files.set(binOf(toolsDirOf(home), 'agent-browser'), '')
  r.t.files.set(binOf(toolsDirOf(home), 'impeccable'), '')
  r.t.files.set(authFileOf(qaRootOf(home, REPO), 'admin'), authOf(-1))
  return r
}

// Executar clicado: o trabalho existe e o próximo tique começa a primeira célula.
async function running($: Engine, on: On, over: Over = {}) {
  const r = await toRun($, on, over)
  await click(r.t, r.ui)
  return r
}

// Segura uma vez só a primeira resposta cuja chave passa no teste: armado desde já ou, com `isArmed` false, depois do `arm`.
function holdOnce(match: (key: string) => boolean, isArmed = true) {
  const s = { isArmed }
  const hold = (key: string): boolean => {
    const isHit = s.isArmed && match(key)
    if (isHit) s.isArmed = false
    return isHit
  }
  return { hold, arm: () => void (s.isArmed = true) }
}

describe('QA: registro', () => {
  test('registra os quatro tipos, com o comando da trava nos três travados, e a ferramenta qa_auth', async ($, on) => {
    const t = await boot($, on)
    const qa = t.log.agents.filter(a => a.name.startsWith('qa-'))
    expect(qa.map(a => a.name)).toEqual(['qa-planner', 'qa-runner', 'qa-observer', 'qa-fixer'])
    for (const a of qa.slice(1)) {
      expect(a.command).toContain('qa-hook.mjs')
      expect(a.command).toMatch(/guard-[a-z0-9]+\.json/)
    }
    expect(qa[0]?.command).toBe('null')
    expect(t.log.tools).toEqual(['qa_auth'])
  })

  test('runner, observer e fixer ficam escondidos do modelo; o planner não', async ($, on) => {
    await boot($, on)
    const offer = (agent: string) => $.agent.offer({ agent, description: 'x', source: 'plugin', provider: { plugin: 'workbench', tier: 'user' } })
    for (const agent of [QA_RUNNER, QA_OBSERVER, QA_FIXER]) expect((await offer(agent)).isOffered).toBe(false)
    expect((await offer(QA_PLANNER)).isOffered).not.toBe(false)
  })

  test('o arquivo da trava é o mesmo depois de recarregar: o qa stop chega no agente lançado antes', async ($, on) => {
    const { t } = await running($, on)
    await tick(t)
    await start($)
    await command($, 'qa stop')
    const runners = t.log.agents.filter(a => a.name === 'qa-runner').map(a => a.command)
    expect(runners).toHaveLength(2)
    expect(runners[1]).toBe(runners[0])
    const guards = [...t.files.keys()].filter(k => /\/guard-[a-z0-9]+\.json$/.test(k))
    expect(guards).toHaveLength(1)
    expect(t.files.get(guards[0] ?? '')).toBe('{}')
  })
})

describe('QA: Planejar e Login', () => {
  test('Planejar lê o escopo do campo, limpa o campo, cria a pasta e pede o planner; Login manda o pedido de login', async ($, on) => {
    const t = await boot($, on, { typed: 'tela de cadastro' })
    const ui = await mount($)
    expect(await label(ui)).toBe('QA')
    await click(t, ui)
    expect(t.box.text).toBe('')
    expect(t.runDir().startsWith(`${QA_ROOT}/`)).toBe(true)
    expect(t.log.submits[0]).toContain(QA_PLANNER)
    expect(t.log.submits[0]).toContain('tela de cadastro')
    expect(t.log.submits[0]).toContain(`${t.runDir()}/matriz.md`)
    expect(await label(ui)).toBe('QA: Login')
    t.files.set(`${t.runDir()}/matriz.md`, mdOf(MATRIX))
    await click(t, ui)
    const matrixPath = `${t.runDir()}/matriz.md`
    expect(t.log.submits[1]).toBe(qaLoginPromptOf({ matrixPath, matrix: MATRIX, qaRoot: QA_ROOT, toolsDir: toolsDirOf(HOME), home: HOME }))
    expect(await label(ui)).toBe('QA: Executar')
  })

  test('com a sessão ocupada nada é enviado; quando ela para, o pedido sai', async ($, on) => {
    const t = await boot($, on)
    const ui = await mount($)
    await $.turn.start({ text: 'trabalhando', turnId: 't1' })
    await click(t, ui)
    expect(t.log.submits).toEqual([])
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await tick(t)
    expect(t.log.submits).toHaveLength(1)
    t.files.set(`${t.runDir()}/matriz.md`, mdOf(MATRIX))
    await $.turn.start({ text: 'trabalhando', turnId: 't2' })
    await click(t, ui)
    expect(t.log.submits).toHaveLength(1)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await tick(t)
    expect(t.log.submits).toHaveLength(2)
  })

  test('pasta da execução que não deu para criar: o texto do campo fica', async ($, on) => {
    const t = await boot($, on, { typed: 'tela de cadastro', run: argv => (argv[0] === 'mkdir' ? { exitCode: 1, stdout: '' } : undefined) })
    const ui = await mount($)
    await click(t, ui)
    expect(t.box.text).toBe('tela de cadastro')
    expect(t.log.toasts.at(-1)).toContain('não deu para criar a pasta')
    expect(t.log.submits).toEqual([])
  })

  test('{ drop } no envio devolve a etapa anterior', async ($, on) => {
    const t = await boot($, on, { drop: true })
    const ui = await mount($)
    await click(t, ui)
    expect(t.log.submits).toHaveLength(1)
    expect(await label(ui)).toBe('QA')
  })

  test('matriz ausente volta para o começo; matriz inválida avisa e fica', async ($, on) => {
    const { t, ui } = await toLogin($, on, {}, '# sem json')
    expect(await label(ui)).toBe('QA: Login')
    expect(t.log.toasts.some(x => x.startsWith('QA: matriz inválida'))).toBe(true)
    t.files.delete(`${t.runDir()}/matriz.md`)
    await click(t, ui)
    expect(await label(ui)).toBe('QA')
  })
})

describe('QA: portões do Executar', () => {
  test('ferramenta faltando: avisa e volta para o Login', async ($, on) => {
    const { t, ui } = await toRun($, on)
    t.files.delete(binOf(toolsDirOf(HOME), 'impeccable'))
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('impeccable')
    expect(await label(ui)).toBe('QA: Login')
  })

  test('login faltando ou vencido: diz o perfil e volta para o Login', async ($, on) => {
    const { t, ui } = await toRun($, on)
    t.files.delete(AUTH)
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('admin')
    expect(await label(ui)).toBe('QA: Login')
  })

  test('login vencido conta como faltando', async ($, on) => {
    const { t, ui } = await toRun($, on)
    t.files.set(AUTH, authOf(1))
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('admin')
    expect(await label(ui)).toBe('QA: Login')
  })

  test('app fora do ar: avisa e fica no Executar, sem trabalho', async ($, on) => {
    const { t, ui } = await toRun($, on, { run: argv => (argv[0] === 'curl' ? { exitCode: 7, stdout: '' } : undefined) })
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('não respondeu')
    expect(await label(ui)).toBe('QA: Executar')
    await tick(t)
    expect(t.log.spawns).toEqual([])
  })

  test('perfil anônimo não exige arquivo de sessão', async ($, on) => {
    const anon = { ...MATRIX, loginRoute: '', profiles: ['anonimo'], cells: [cellOf('c2', 'anonimo')] }
    const { t, ui } = await toRun($, on, {}, anon)
    t.files.delete(AUTH)
    await click(t, ui)
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER])
    expect(t.log.runs.some(a => a[0] === AB && a.join(' ').endsWith('open http://localhost:3000'))).toBe(true)
  })

  // O Executar confere um contexto de exemplo com a validação da trava antes de lançar: HOME raso ela recusaria.
  test('HOME /root: a trava recusaria o contexto, o Executar diz o motivo e não lança nada', async ($, on) => {
    const { t, ui } = await toRun($, on, { home: '/root' })
    await click(t, ui)
    await tick(t)
    expect(t.log.toasts.at(-1)).toContain('trava recusaria')
    expect(t.log.toasts.at(-1)).toContain('/root')
    expect(t.log.spawns).toEqual([])
    expect(await label(ui)).toBe('QA: Executar')
  })

  test('grava os scripts executáveis e o HEAD do app', async ($, on) => {
    const { t } = await running($, on)
    expect(t.files.get(AB)).toContain('AGENT_BROWSER_ACTION_POLICY')
    expect(t.files.get(`${QA_ROOT}/bin/agent-browser.json`)).toBe('{}')
    expect(t.log.runs.some(a => a[0] === 'chmod' && a.includes(AB))).toBe(true)
  })
})

describe('QA: fase Executar', () => {
  // O clique Executar já começa a primeira célula no mesmo tique; cada agente lançado é adotado no tique seguinte.
  test('runner → observer → próxima célula, com a trava certa em cada passo e a sessão do navegador logada', async ($, on) => {
    const { t } = await running($, on)
    const runDir = t.runDir()
    expect(types(t)).toEqual([QA_RUNNER])
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: null, ctx: { runDir, session: expect.stringContaining('c1'), cdpPort: 9333, origins: ['http://localhost:3000'], containers: ['api'], fixDir: '' } })
    const ab = t.log.runs.filter(a => a[0] === AB).map(a => a.slice(3).join(' '))
    expect(ab).toEqual(['open http://localhost:3000/entrar', expect.stringMatching(/^cookies set --curl .*\/auth\//), 'storage local set tok SEGREDO2', 'set viewport 1280 800', 'get cdp-url'])
    expect([...t.files.keys()].some(k => k.includes('.cookies-'))).toBe(false)
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: 'a1' })
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER])
    await ended($, 'a1')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
    expect(t.guard()).toMatchObject({ role: 'observer', agentId: null, ctx: { session: expect.stringContaining('c1') } })
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'observer', agentId: 'a2' })
    t.files.set(`${runDir}/celulas/c1/veredito.json`, verdictOf('c1', 'PASS'))
    await ended($, 'a2')
    await tick(t)
    expect(t.log.runs.at(-1)?.slice(3)).toEqual(['close'])
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER, QA_RUNNER])
    expect(t.guard()).toMatchObject({ role: 'runner', ctx: { session: expect.stringContaining('c2') } })
  })

  test('célula que falha repete do zero em r2; veredito diferente sai INSTÁVEL e o resumo vai só com a sessão parada', async ($, on) => {
    const { t, ui } = await toRun($, on, {}, { ...MATRIX, cells: [cellOf('c1', 'admin')] })
    await click(t, ui)
    const runDir = t.runDir()
    const finish = async (id: string, verdict?: [string, string]) => {
      await tick(t)
      if (verdict !== undefined) t.files.set(verdict[0], verdict[1])
      await ended($, id)
      await tick(t)
    }
    await finish('a1')
    await finish('a2', [`${runDir}/celulas/c1/veredito.json`, verdictOf('c1', 'FAIL-APP', [FAIL_DEFECT])])
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER, QA_RUNNER])
    expect(t.dirs.has(`${runDir}/celulas/c1/r2`)).toBe(true)
    expect(t.guard().ctx.session).toContain('r2')
    await finish('a3')
    await finish('a4', [`${runDir}/celulas/c1/r2/veredito.json`, verdictOf('c1', 'PASS')])
    await $.turn.start({ text: 'trabalhando', turnId: 'm1' })
    const before = t.log.submits.length
    await tick(t)
    expect(t.files.get(`${runDir}/relatorio.md`)).toContain('INSTÁVEL: 1')
    expect(await label(ui)).toBe('QA: Corrigir')
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    expect(t.log.submits).toHaveLength(before)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer' })
    await tick(t)
    expect(t.log.submits.at(-1)).toContain(`${runDir}/relatorio.md`)
  })

  test('adoção: lançamento sem agentId adota o agente vivo do tipo, que entra na trava e em qaGuarded', async ($, on) => {
    const { t } = await running($, on, { spawns: [{ unlisted: true }] })
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: null })
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: null })
    t.listed.push({ id: 'x9', type: QA_RUNNER, status: 'running', description: 'x' })
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: 'x9' })
    const before = t.log.submits.length
    await $.prompt.submit({ text: '<agent-message from="x9">ok</agent-message>', isMeta: true, wait: false, origin: { kind: 'composer' } })
    expect(t.log.submits).toHaveLength(before)
    await ended($, 'x9')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
  })

  test('conciliação: agente encerrado na lista conta como fim; tempo esgotado também', async ($, on) => {
    const { t } = await running($, on)
    await tick(t)
    const a1 = t.listed.find(a => a.id === 'a1')
    if (a1 !== undefined) a1.status = 'completed'
    await t.clock.advance(20_000)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
    await t.clock.advance(AGENT_TIMEOUT_MS)
    expect(types(t).slice(0, 3)).toEqual([QA_RUNNER, QA_OBSERVER, QA_RUNNER])
  })

  test('deny no lançamento fecha a sessão e a fila segue', async ($, on) => {
    const { t } = await running($, on, { spawns: [{ deny: 'não' }] })
    expect(t.log.runs.at(-1)?.slice(3)).toEqual(['close'])
    expect(t.log.toasts.at(-1)).toContain('recusado')
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_RUNNER])
    expect(t.guard().ctx.session).toContain('c2')
  })

  test('falha ao gravar a trava depois de abrir o navegador: fecha a sessão, avisa e a fila segue', async ($, on) => {
    const fail = { left: 1 }
    const { t } = await running($, on, { failWrite: (path, text) => path.includes('/guard-') && text.includes('"runner"') && fail.left-- > 0 })
    expect(t.log.spawns).toEqual([])
    expect(t.log.runs.at(-1)?.slice(3)).toEqual(['close'])
    expect(t.log.toasts.at(-1)).toContain('c1')
    expect(t.log.toasts.at(-1)).toContain('sem veredito')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER])
    expect(t.guard().ctx.session).toContain('c2')
  })

  // /workbench qa stop enquanto o passo abre o navegador da c1, e clique logo depois: o Executar novo só é montado
  // depois que o passo antigo termina (e acha o trabalho parado), então a c1 não entra duas vezes.
  test('clique durante um passo em curso fica na fila até o passo acabar', async ($, on) => {
    const { t, ui } = await toRun($, on, { hold: holdOnce(k => k.includes(' open ')).hold })
    await click(t, ui)
    await command($, 'qa stop')
    await ui.press({ key: 'qa' })
    await tick(t)
    await t.clock.advance(1_000)
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(await label(ui)).toBe('QA: Executar')
    await tick(t)
    expect(await label(ui)).toMatch(/^QA: c1 \(1\/2\)/)
  })

  test('qa stop enquanto o passo adota o agente: a trava fica em {}', async ($, on) => {
    const list = holdOnce(k => k === 'agent.list', false)
    const { t } = await running($, on, { hold: list.hold })
    list.arm()
    await tick(t)
    await command($, 'qa stop')
    await t.clock.advance(HOLD_MS)
    // O stop guarda o agente vivo: a adoção que estava em curso não o adota mais.
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(t.log.guards.some(g => g.includes('"a1"'))).toBe(false)
  })

  test('retomada: depois de um novo session.start o trabalho segue do item em curso', async ($, on) => {
    const { t } = await running($, on)
    await tick(t)
    await start($)
    await ended($, 'a1')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
  })

  test('clique com trabalho em curso não muda nada; /workbench qa stop zera o trabalho e a trava', async ($, on) => {
    const { t, ui } = await running($, on)
    await tick(t)
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toBe('QA em andamento (use /workbench qa stop)')
    expect(await label(ui)).toMatch(/^QA: c1 \(1\/2\)/)
    await command($, 'qa stop')
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(t.log.runs.at(-1)?.slice(3)).toEqual(['close'])
    expect(await label(ui)).toBe('QA: Executar')
    await ended($, 'a1')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER])
  })
})

const guardPathOf = (t: T): string => /"[^"]*\/(?:[^"/]+\/)*guard-[a-z0-9]+\.json/.exec(t.log.agents.find(a => a.name === 'qa-runner')?.command.replaceAll('\\"', '"') ?? '')?.[0].slice(1) ?? ''

describe('QA: pendências da revisão da 7a', () => {
  test('agente de uma execução parada antes da adoção não é adotado pela execução nova', async ($, on) => {
    const { t, ui } = await running($, on)
    t.listed.push({ id: 'o1', type: 'general-purpose', status: 'running', description: 'outro' })
    await command($, 'qa stop')
    const before = t.log.submits.length
    await $.prompt.submit({ text: '<agent-message from="o1">ok</agent-message>', isMeta: true, wait: false, origin: { kind: 'composer' } })
    expect(t.log.submits).toHaveLength(before + 1)
    await click(t, ui)
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_RUNNER])
    expect(t.guard()).toMatchObject({ role: 'runner', agentId: 'a2' })
  })

  test('item que acaba sem id: os agentes de QA vivos na lista nunca são adotados depois', async ($, on) => {
    const { t } = await running($, on, { spawns: [{ unlisted: true }] })
    t.listed.push({ id: 'z1', type: QA_OBSERVER, status: 'running', description: 'sobra' })
    await t.clock.advance(61_000)
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'observer', agentId: 'a2' })
  })

  test('stop com a gravação de {} falhando: fecha o navegador, apaga o arquivo da trava e avisa', async ($, on) => {
    const { t } = await running($, on, { failWrite: (path, text) => path.includes('/guard-') && text === '{}' })
    await command($, 'qa stop')
    expect(t.log.runs.some(a => a[0] === AB && a.at(-1) === 'close')).toBe(true)
    expect(t.log.runs).toContainEqual(['rm', '-f', guardPathOf(t)])
    expect(t.log.toasts.at(-1)).toContain('trava')
  })

  test('falha ao gravar a trava do observer: fecha a sessão, a célula fica sem veredito e a fila segue', async ($, on) => {
    const { t } = await running($, on, { failWrite: (path, text) => path.includes('/guard-') && text.includes('"observer"') })
    await tick(t)
    await ended($, 'a1')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER])
    expect(t.log.runs.at(-1)?.slice(3)).toEqual(['close'])
    expect(t.log.toasts.at(-1)).toContain('sem veredito')
    await tick(t)
    expect(types(t)).toEqual([QA_RUNNER, QA_RUNNER])
    expect(t.guard().ctx.session).toContain('c2')
  })

  test('HOME e raiz atrás de link simbólico: os caminhos do QA usam o caminho real', async ($, on) => {
    const t = await boot($, on, { run: argv => (argv[0] === 'realpath' ? { exitCode: 0, stdout: '/data/u\n/srv/app\n' } : undefined) })
    expect(guardPathOf(t).startsWith(`${qaRootOf('/data/u', '/srv/app')}/guard-`)).toBe(true)
  })
})

describe('QA: fim dos agentes e qa_auth', () => {
  const handback = ($: Engine, id: string) => $.prompt.submit({ text: `<agent-message from="${id}">ok</agent-message>`, isMeta: true, wait: false, origin: { kind: 'composer' } })

  test('o aviso de fim de um agente de QA é suprimido; o de outro agente não', async ($, on) => {
    const { t } = await running($, on)
    await tick(t)
    const before = t.log.submits.length
    await handback($, 'a1')
    expect(t.log.submits).toHaveLength(before)
    await handback($, 'outro')
    expect(t.log.submits).toHaveLength(before + 1)
  })

  // Com uma ferramenta MCP o tipo de `$.tool.call` estoura o tsc (a união de todas as ferramentas): a chamada vai pelo
  // Reflect.get e a resposta é conferida pelo texto dela.
  const auth = async ($: Engine, profile: string): Promise<string> => {
    const tool: object = $.tool
    const call = Reflect.get(tool, 'call')
    return JSON.stringify(await call.call(tool, { tool: QA_AUTH_TOOL, profile }))
  }

  test('o hook do qa_auth deixa passar, sem mudar, a chamada de qualquer outra ferramenta', async ($, on) => {
    on('tool.call', (_$, e, next) => {
      const call: object = e
      return Reflect.get(call, 'tool') === 'mcp__outro__x' ? { result: 'r', text: 'resposta-x' } : next(e)
    })
    await boot($, on)
    const tool: object = $.tool
    const call = Reflect.get(tool, 'call')
    expect(JSON.stringify(await call.call(tool, { tool: 'mcp__outro__x', a: 1 }))).toContain('resposta-x')
  })

  test('qa_auth responde só as contagens e recusa perfil de fora da matriz', async ($, on) => {
    const { t } = await toRun($, on)
    const ok = await auth($, 'admin')
    expect(ok).not.toContain('SEGREDO')
    expect(ok).toContain('"result":{"cookies":1,"expired":0}')
    expect(ok).toContain('vencidos: 0. serve')
    t.files.delete(AUTH)
    expect(await auth($, 'admin')).toContain('não serve')
    expect(await auth($, 'outro')).toContain('fora da matriz')
  })
})

// ---- Fase Corrigir ----

const D1 = 'c1.d1'
const FIX_MATRIX: Matrix = { ...MATRIX, testDir: 'e2e' }
const FIX_OK = JSON.stringify({ retestable: true, regressionTest: 'e2e/qa-c1.d1.spec.ts', subject: 'Salvar volta a confirmar', body: ['Por quê: x', 'O que mudou: y'] })
const wtOf = (t: T) => `${REPO}/.worktrees/qa-${t.runDir().split('/').pop()}`
const outOf = (t: T) => `${t.runDir()}/correcoes/${D1}`
const resultOf = (t: T) => JSON.parse(t.files.get(`${outOf(t)}.json`) ?? '{}')
const lastId = (t: T) => `a${t.log.spawns.length}`
const gitIn = (t: T, ...args: string[]) => ['env', `GIT_CEILING_DIRECTORIES=${REPO}/.worktrees`, 'git', '-C', wtOf(t), ...args]

// Executar sem célula pendente (os vereditos já existem): o relatório sai com c1.d1 marcado e a etapa vai para Corrigir.
async function toFix($: Engine, on: On, over: Over = {}, matrix: Matrix = FIX_MATRIX, defects: unknown[] = [FAIL_DEFECT]) {
  const r = await toRun($, on, over, matrix)
  const runDir = r.t.runDir()
  r.t.files.set(`${runDir}/celulas/c1/veredito.json`, verdictOf('c1', 'FAIL-APP', defects))
  r.t.files.set(`${runDir}/celulas/c2/veredito.json`, verdictOf('c2', 'PASS'))
  r.t.files.set(`${runDir}/celulas/c2/teste.spec.ts`, 'test()')
  r.t.files.set(`${REPO}/.env`, 'SEGREDO=1')
  r.t.files.set(`${REPO}/.env.example`, 'X=')
  r.t.files.set(`${REPO}/package.json`, '{}')
  await click(r.t, r.ui)
  return r
}

// Os dois cliques do Corrigir: o segundo, no prazo, prepara a worktree e começa o primeiro defeito no mesmo tique.
async function fixing($: Engine, on: On, over: Over = {}, matrix: Matrix = FIX_MATRIX, defects: unknown[] = [FAIL_DEFECT]) {
  const r = await toFix($, on, over, matrix, defects)
  await click(r.t, r.ui)
  await click(r.t, r.ui)
  return r
}

// O agente mais recente é adotado, grava os arquivos dele e termina; o tique seguinte avança o item.
async function finishAgent($: Engine, t: T, written: Record<string, string> = {}) {
  const id = lastId(t)
  await tick(t)
  for (const [path, text] of Object.entries(written)) t.files.set(path, text)
  await ended($, id)
  await tick(t)
}

// O corretor termina com o fix.json dado (null = sem arquivo) e, se `status`, com a worktree mudada.
async function fixerEnds($: Engine, t: T, fix: string | null = FIX_OK, status = ' M src/salvar.ts') {
  t.wt.status = status
  await finishAgent($, t, fix === null ? {} : { [`${outOf(t)}/fix.json`]: fix })
}

describe('QA: clique Corrigir', () => {
  test('sem defeito marcado: avisa onde ficaram os testes gerados e volta para o começo', async ($, on) => {
    const { t, ui } = await toFix($, on)
    const rel = `${t.runDir()}/relatorio.md`
    t.files.set(rel, (t.files.get(rel) ?? '').replace(`- [x] ${D1}`, `- [ ] ${D1}`))
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('celulas/<id>/teste.spec.ts')
    expect(await label(ui)).toBe('QA')
  })

  test('o primeiro clique só mostra os comandos, o segundo fora do prazo arma de novo; instalação que falha não avança', async ($, on) => {
    const { t, ui } = await toFix($, on, { run: argv => (argv.join(' ') === 'npm ci' ? { exitCode: 1, stdout: 'ERR dependencias' } : undefined) })
    expect(await label(ui)).toBe('QA: Corrigir')
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('- instalar: npm ci')
    await t.clock.advance(ARM_MS)
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('Aperte de novo')
    expect(t.log.runs.some(a => a.includes('worktree'))).toBe(false)
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toContain('o comando npm ci falhou (código 1)')
    expect(t.log.toasts.join('\n')).not.toContain('ERR dependencias')
    await tick(t)
    expect(t.log.spawns).toEqual([])
    expect(await label(ui)).toBe('QA: Corrigir')
  })

  test('a trava recusaria o corretor na worktree real: avisa e não lança nada', async ($, on) => {
    const { t } = await fixing($, on, { run: argv => (argv[0] === 'realpath' && argv.length === 2 ? { exitCode: 0, stdout: '/fora/wt\n' } : undefined) })
    expect(t.log.toasts.at(-1)).toContain('trava recusaria o corretor')
    expect(t.log.spawns).toEqual([])
  })
})

describe('QA: fase Corrigir', () => {
  test('caminho feliz: corretor, commit pelo mod, testes, regressão, reteste, aceito e o fim da fila', async ($, on) => {
    const { t, ui } = await fixing($, on)
    const wt = wtOf(t)
    expect(t.log.runs).toContainEqual(['git', 'worktree', 'add', wt, '-b', `qa/${t.runDir().split('/').pop()}`])
    expect(t.files.get(`${wt}/.env`)).toBe('SEGREDO=1')
    expect(t.files.has(`${wt}/.env.example`)).toBe(false)
    expect(t.files.has(`${wt}/package.json`)).toBe(false)
    expect(t.files.get(`${REPO}/.git/info/exclude`)).toBe('.worktrees/\n/.env\n')
    expect(t.log.full).toContainEqual(expect.objectContaining({ argv: ['npm', 'ci'], cwd: wt }))
    expect(t.log.apps[0]).toEqual({ argv: ['npm', 'run', 'dev', '--', '--port', '4100'], cwd: wt, env: { QA_PORT: '4100', PORT: '4100' } })
    expect(types(t)).toEqual([QA_FIXER])
    expect(JSON.parse(t.log.guards.at(-2) ?? '{}')).toMatchObject({ role: 'fixer', agentId: null, ctx: { fixDir: wt, origins: ['http://localhost:4100'] } })
    expect(t.log.guards.at(-1)).toBe('{}')
    const ab = t.log.runs.filter(a => a[0] === AB).map(a => a.slice(3).join(' '))
    expect(ab).toContain('open http://localhost:4100/entrar')
    expect(ab).toContain('storage local set tok SEGREDO2')
    expect(t.log.spawns[0]?.prompt).toContain(`Worktree (W): ${wt}`)
    await fixerEnds($, t)
    expect(t.wt.commits[0]).toEqual(['commit', '-q', '-m', 'Salvar volta a confirmar', '-m', 'Por quê: x', '-m', 'O que mudou: y'])
    expect(t.log.full).toContainEqual(expect.objectContaining({ argv: ['npm', 'test'], cwd: wt }))
    const pw = t.log.full.filter(r => r.argv[0] === 'npx')
    expect(pw.map(r => r.env['QA_BASE_URL'])).toEqual(['http://localhost:3000', 'http://localhost:4100'])
    expect(pw[0]?.env['QA_AUTH_ADMIN']).toBe(AUTH)
    expect(t.log.apps).toHaveLength(2)
    expect(t.log.appStops).toBe(1)
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER])
    expect(t.log.spawns[1]?.prompt).toContain('"id":"c1"')
    await tick(t)
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER])
    expect(t.log.toasts.some(x => x.includes('checkout principal'))).toBe(false)
    const re = (cell: string) => `${outOf(t)}/reteste-1/${cell}/veredito.json`
    await finishAgent($, t)
    await finishAgent($, t, { [re('c1')]: verdictOf('c1', 'PASS') })
    await finishAgent($, t)
    await finishAgent($, t, { [re('c2')]: verdictOf('c2', 'PASS') })
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER, QA_OBSERVER, QA_RUNNER, QA_OBSERVER])
    expect(t.log.spawns.slice(2).map(x => /"id":"(c\d)"/.exec(x.prompt)?.[1])).toEqual(['c1', 'c2', 'c2'])
    expect(resultOf(t)).toMatchObject({ defect: D1, status: 'corrigido', attempts: 1, commits: ['f0 corrige'], regressionTest: 'e2e/qa-c1.d1.spec.ts', pending: [], retest: [{ cell: 'c1', verdict: 'PASS' }, { cell: 'c2', verdict: 'PASS' }] })
    await $.turn.start({ text: 'trabalhando', turnId: 'm1' })
    const before = t.log.submits.length
    await tick(t)
    expect(t.files.get(`${wt}/e2e/qa-c2.spec.ts`)).toBe('test()')
    expect(t.wt.commits[1]?.slice(0, 4)).toEqual(['commit', '-q', '-m', 'Testes de regressão gerados pelo QA'])
    const report = t.files.get(`${t.runDir()}/correcoes.md`) ?? ''
    expect(report).toContain('- corrigido: 1')
    expect(report).toContain('sem os hooks de pré-commit')
    expect(await label(ui)).toBe('QA')
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    expect(t.log.submits).toHaveLength(before)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer' })
    await tick(t)
    expect(t.log.submits.at(-1)).toContain(`${t.runDir()}/correcoes.md`)
  })

  const refusals: [string, () => Over, string | null, string, string][] = [
    ['4a fix.json ausente', () => ({}), null, ' M a.ts', 'fix.json ausente ou inválido'],
    ['4b mudança sem descrição', () => ({}), JSON.stringify({ retestable: true }), ' M a.ts', 'mudança sem descrição de commit'],
    ['4b nada mudou', () => ({}), FIX_OK, '', 'o corretor não mudou nada'],
    ['4c teste alterado', () => ({ run: a => (a.includes('--name-status') ? { exitCode: 0, stdout: 'M\te2e/velho.spec.ts\n' } : undefined) }), FIX_OK, ' M a.ts', 'teste ou configuração de teste alterado'],
    ['4f testes do projeto', () => ({ run: a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'FALHOU x' } : undefined) }), FIX_OK, ' M a.ts', 'FALHOU x'],
    ['4g passa no original', () => ({ run: a => (a[0] === 'npx' ? { exitCode: 0, stdout: '' } : undefined) }), FIX_OK, ' M a.ts', 'não falhou no app original'],
    ['4g falha na worktree', () => ({ run: a => (a[0] === 'npx' ? { exitCode: 1, stdout: '' } : undefined) }), FIX_OK, ' M a.ts', 'não passou no app da worktree'],
  ]
  for (const [name, over, fix, status, reason] of refusals) {
    test(`recusa ${name}: vira motivo e o corretor volta`, async ($, on) => {
      const { t } = await fixing($, on, over())
      await fixerEnds($, t, fix, status)
      expect(types(t)).toEqual([QA_FIXER, QA_FIXER])
      expect(t.log.spawns[1]?.prompt).toContain('- Tentativa: 2')
      expect(t.log.spawns[1]?.prompt).toContain(reason)
    })
  }

  // A saída de um comando pode ter segredo: ela só vai no pedido da próxima tentativa do corretor, nunca em aviso nem em arquivo.
  const outputs: [string, (a: readonly string[], env?: Record<string, string>) => Run | undefined, string][] = [
    ['testCommand', a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'SAIDA-SECRETA' } : undefined), 'o comando npm test falhou (código 1)'],
    ['Playwright', (a, env) => (a[0] === 'npx' && env?.QA_BASE_URL !== MATRIX.baseUrl ? { exitCode: 1, stdout: 'SAIDA-SECRETA' } : undefined), 'não passou no app da worktree (código 1)'],
  ]
  for (const [name, run, reason] of outputs) {
    test(`saída do ${name} que falha: só no pedido da tentativa seguinte`, async ($, on) => {
      const { t } = await fixing($, on, { run: (a, _cwd, env) => run(a, env) })
      for (let i = 0; i < 3; i++) await fixerEnds($, t)
      expect(t.log.spawns[1]?.prompt).toContain('SAIDA-SECRETA')
      expect(t.log.spawns[2]?.prompt).toContain('SAIDA-SECRETA')
      expect(resultOf(t)).toMatchObject({ status: 'desistiu' })
      expect(resultOf(t).reasons).toHaveLength(3)
      expect(resultOf(t).reasons[0]).toContain(reason)
      await tick(t)
      expect(t.files.get(`${t.runDir()}/correcoes.md`)).toContain(reason)
      expect(JSON.stringify(resultOf(t))).not.toContain('SAIDA-SECRETA')
      expect(t.files.get(`${t.runDir()}/correcoes.md`)).not.toContain('SAIDA-SECRETA')
      expect(t.log.toasts.join('\n')).not.toContain('SAIDA-SECRETA')
    })
  }

  test('migração: desfaz e o defeito fica não reverificado', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a.includes('--name-status') ? { exitCode: 0, stdout: 'A\tdb/migrations/001.sql\n' } : undefined) })
    await fixerEnds($, t)
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'abc123'))
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', reasons: ['a correção cria migração'] })
    expect(t.wt.commits).toEqual([])
  })

  test('retestable false: commita o que mudou e fica não reverificado, com o motivo do corretor', async ($, on) => {
    const { t } = await fixing($, on)
    await fixerEnds($, t, JSON.stringify({ retestable: false, reason: 'backend em contêiner', subject: 'Corrige a API' }))
    expect(t.wt.commits).toHaveLength(1)
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', reasons: ['backend em contêiner'], commits: ['f0 corrige'] })
    expect(types(t)).toEqual([QA_FIXER])
  })

  test('três recusas: desistiu, com reset e clean na worktree', async ($, on) => {
    const { t } = await fixing($, on)
    for (let i = 0; i < 3; i++) await fixerEnds($, t, null)
    expect(types(t)).toEqual([QA_FIXER, QA_FIXER, QA_FIXER])
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'abc123'))
    expect(t.log.runs).toContainEqual(gitIn(t, 'clean', '-fdq'))
    expect(resultOf(t)).toMatchObject({ status: 'desistiu', attempts: 3, reasons: ['fix.json ausente ou inválido', 'fix.json ausente ou inválido', 'fix.json ausente ou inválido'] })
  })

  test('árvore suja na execução: confere antes de corrigir; defeito que não aparece dá não reproduzido', async ($, on) => {
    const dirty = (a: readonly string[], cwd?: string) => (a.join(' ') === 'git status --porcelain' && cwd === REPO ? { exitCode: 0, stdout: ' M x\n' } : undefined)
    const { t } = await fixing($, on, { run: dirty })
    expect(types(t)).toEqual([QA_RUNNER])
    expect(t.dirs.has(`${outOf(t)}/reteste-0/c1`)).toBe(true)
    await finishAgent($, t)
    await finishAgent($, t, { [`${outOf(t)}/reteste-0/c1/veredito.json`]: verdictOf('c1', 'PASS') })
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER])
    expect(resultOf(t)).toMatchObject({ status: 'não reproduzido na worktree', attempts: 0 })
  })

  test('app que não sobe pela worktree: o defeito fica não reverificado', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a[0] === 'curl' && a.includes('http://localhost:4100') ? { exitCode: 7, stdout: '' } : undefined) })
    await t.clock.advance(61_000)
    expect(t.log.spawns).toEqual([])
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', attempts: 0, reasons: ['o app não subiu pela worktree'] })
  })

  test('retomada depois de um session.start no meio do reteste: o app sobe de novo na mesma porta', async ($, on) => {
    const { t } = await fixing($, on)
    await fixerEnds($, t)
    expect(t.log.apps).toHaveLength(2)
    await start($)
    await finishAgent($, t)
    expect(t.log.apps).toHaveLength(3)
    expect(t.log.apps[2]?.env).toEqual({ QA_PORT: '4100', PORT: '4100' })
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER, QA_OBSERVER])
  })

  test('stop no meio das conferências do corretor: o commit que chega depois do stop também é desfeito', async ($, on) => {
    const { t } = await fixing($, on, { hold: holdOnce(k => k.includes(' commit -q -m Corrige a API')).hold })
    t.wt.status = ' M a.ts'
    await finishAgent($, t, { [`${outOf(t)}/fix.json`]: JSON.stringify({ retestable: false, reason: 'backend', subject: 'Corrige a API' }) })
    await command($, 'qa stop')
    await t.clock.advance(HOLD_MS)
    await tick(t)
    expect(t.wt.commits).toHaveLength(1)
    expect(t.wt.head).toBe('abc123')
  })

  test('/workbench qa stop desfaz o defeito em curso e a etapa continua Corrigir', async ($, on) => {
    const { t, ui } = await fixing($, on)
    await command($, 'qa stop')
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'abc123'))
    expect(t.log.runs).toContainEqual(gitIn(t, 'clean', '-fdq'))
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(await label(ui)).toBe('QA: Corrigir')
  })

  test('aviso quando o HEAD do checkout principal muda durante a correção', async ($, on) => {
    const root = { head: 'abc123' }
    const { t } = await fixing($, on, { run: a => (a.join(' ') === `git -C ${REPO} rev-parse HEAD` ? { exitCode: 0, stdout: `${root.head}\n` } : undefined) })
    root.head = 'outro'
    await fixerEnds($, t)
    expect(t.log.toasts.some(x => x.includes('checkout principal'))).toBe(true)
  })
})

describe('QA: fase Corrigir, bordas', () => {
  test('árvore suja e o defeito aparece na worktree: o corretor começa na tentativa 1', async ($, on) => {
    const dirty = (a: readonly string[], cwd?: string) => (a.join(' ') === 'git status --porcelain' && cwd === REPO ? { exitCode: 0, stdout: ' M x\n' } : undefined)
    const { t } = await fixing($, on, { run: dirty })
    await finishAgent($, t)
    await finishAgent($, t, { [`${outOf(t)}/reteste-0/c1/veredito.json`]: verdictOf('c1', 'FAIL-APP', [FAIL_DEFECT]) })
    expect(types(t)).toEqual([QA_RUNNER, QA_OBSERVER, QA_FIXER])
    expect(t.log.spawns[2]?.prompt).toContain('- Tentativa: 1')
  })

  test('navegador do reteste que não abre: o defeito fica não reverificado', async ($, on) => {
    const opens = { n: 0 }
    const { t } = await fixing($, on, { run: a => (a[0] === AB && a[3] === 'open' && ++opens.n === 2 ? { exitCode: 1, stdout: '' } : undefined) })
    await fixerEnds($, t)
    expect(types(t)).toEqual([QA_FIXER])
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', reasons: ['não deu para abrir o navegador do reteste de c1'] })
  })

  test('stop durante a preparação da worktree: o trabalho não nasce', async ($, on) => {
    const { t, ui } = await toFix($, on, { hold: holdOnce(k => k === 'npm ci').hold })
    await click(t, ui)
    await click(t, ui)
    await command($, 'qa stop')
    await t.clock.advance(HOLD_MS)
    await tick(t)
    expect(t.log.toasts.at(-1)).toContain('parado durante a preparação')
    expect(t.log.spawns).toEqual([])
    expect(await label(ui)).toBe('QA: Corrigir')
  })

  test('veredito velho na pasta do reteste não vale: a pasta começa vazia', async ($, on) => {
    const dirty = (a: readonly string[], cwd?: string) => (a.join(' ') === 'git status --porcelain' && cwd === REPO ? { exitCode: 0, stdout: ' M x\n' } : undefined)
    const r = await toFix($, on, { run: dirty })
    r.t.files.set(`${outOf(r.t)}/reteste-0/c1/veredito.json`, verdictOf('c1', 'FAIL-APP', [FAIL_DEFECT]))
    await click(r.t, r.ui)
    await click(r.t, r.ui)
    await finishAgent($, r.t)
    await finishAgent($, r.t)
    expect(resultOf(r.t)).toMatchObject({ status: 'não reproduzido na worktree' })
  })

  test('linha de base relida antes de cada corretor: a worktree suja depois da instalação não engana o "não mudou nada"', async ($, on) => {
    const { t, ui } = await toFix($, on, { run: a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'FALHOU' } : undefined) })
    t.wt.status = ' M package-lock.json'
    await click(t, ui)
    await click(t, ui)
    await fixerEnds($, t)
    await fixerEnds($, t, FIX_OK, '')
    expect(t.log.spawns[2]?.prompt).toContain('o corretor não mudou nada')
  })

  test('clique durante a preparação da worktree espera ela acabar', async ($, on) => {
    const { t, ui } = await toFix($, on, { hold: holdOnce(k => k === 'npm ci').hold })
    await click(t, ui)
    await click(t, ui)
    const before = t.log.toasts.length
    await ui.press({ key: 'qa' })
    await tick(t)
    expect(t.log.toasts).toHaveLength(before)
  })
})

// A pasta da worktree sem o `.git` (o usuário a apagou e algo a recriou): nenhum git destrutivo roda, a fase para e avisa.
describe('QA: fase Corrigir, worktree que sumiu', () => {
  // Git com `-C` (na worktree ou na raiz) cujo subcomando é um dos dados.
  const touched = (t: T, ...subs: string[]) => t.log.runs.filter(a => a.includes('-C') && subs.some(s => a.includes(s)))
  const LOST = 'a worktree de correção sumiu'

  test('antes do defeito: nada é lançado nem sobe', async ($, on) => {
    const r = await toFix($, on)
    r.t.wt.lost = true
    await click(r.t, r.ui)
    await click(r.t, r.ui)
    expect(r.t.log.toasts.at(-1)).toContain(LOST)
    expect(r.t.log.spawns).toEqual([])
    expect(r.t.log.apps).toEqual([])
    expect(await label(r.ui)).toBe('QA: Corrigir')
  })

  test('o corretor termina: nem add, nem commit, nem reset; a fase para com a trava em {}', async ($, on) => {
    const { t, ui } = await fixing($, on)
    t.wt.lost = true
    await fixerEnds($, t)
    expect(touched(t, 'add', 'commit', 'reset', 'clean')).toEqual([])
    expect(t.log.toasts.at(-1)).toContain(LOST)
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(types(t)).toEqual([QA_FIXER])
    expect(await label(ui)).toBe('QA: Corrigir')
  })

  test('stop: nem reset nem clean, e avisa', async ($, on) => {
    const { t } = await fixing($, on)
    t.wt.lost = true
    await command($, 'qa stop')
    expect(touched(t, 'reset', 'clean')).toEqual([])
    expect(t.log.toasts.at(-1)).toContain(LOST)
  })

  test('fim da fila: os testes das células PASS nem são copiados; o correcoes.md sai e a fase volta ao começo', async ($, on) => {
    const { t, ui } = await fixing($, on)
    await fixerEnds($, t, JSON.stringify({ retestable: false, reason: 'backend', subject: 'Corrige a API' }))
    t.wt.lost = true
    await tick(t)
    expect(t.wt.commits).toHaveLength(1)
    expect(touched(t, 'add').filter(a => a.includes('--'))).toEqual([])
    expect(t.files.has(`${wtOf(t)}/e2e/qa-c2.spec.ts`)).toBe(false)
    expect(t.files.get(`${t.runDir()}/correcoes.md`)).toContain('não reverificado')
    expect(t.log.toasts.at(-1)).toContain(LOST)
    expect(await label(ui)).toBe('QA')
  })

  test('reload com a worktree sumida: o app não sobe de novo nela e a fase para', async ($, on) => {
    const { t, ui } = await fixing($, on)
    const apps = t.log.apps.length
    await start($)
    t.wt.lost = true
    await tick(t)
    expect(t.log.apps).toHaveLength(apps)
    expect(t.log.toasts.at(-1)).toContain(LOST)
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(await label(ui)).toBe('QA: Corrigir')
  })
})

describe('QA: fase Corrigir, corretor cortado e contexto sem id', () => {
  test('lançamento sem id: a trava fica {} até a adoção, que grava o contexto com o id', async ($, on) => {
    const { t } = await fixing($, on)
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    expect(t.guard()).toMatchObject({ role: 'fixer', agentId: 'a1', ctx: { fixDir: wtOf(t) } })
  })

  test('corretor que muda a worktree sem fix.json: a mudança é desfeita, não vira linha de base nem vai no commit do defeito seguinte', async ($, on) => {
    const D2 = { ...FAIL_DEFECT, id: 'd2', where: 'button.outro' }
    const { t } = await fixing($, on, { spawns: [{}, { deny: 'x' }] }, FIX_MATRIX, [FAIL_DEFECT, D2])
    await fixerEnds($, t, null, ' M src/sem-descricao.ts')
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'abc123'))
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', reasons: ['fix.json ausente ou inválido', 'o corretor foi recusado'] })
    await tick(t)
    expect(t.wt.status).toBe('')
    expect(types(t)).toEqual([QA_FIXER, QA_FIXER, QA_FIXER])
  })

  test('mudança de um corretor cortado: o defeito seguinte não começa, nada é commitado nem desfeito e o aviso sai', async ($, on) => {
    const D2 = { ...FAIL_DEFECT, id: 'd2', where: 'button.outro' }
    const app = { down: 0 }
    const curl = (a: readonly string[]) => (a[0] === 'curl' && a.includes('http://localhost:4100') && app.down > 0 && app.down-- > 0 ? { exitCode: 7, stdout: '' } : undefined)
    const { t, ui } = await fixing($, on, { run: curl }, FIX_MATRIX, [FAIL_DEFECT, D2])
    await tick(t)
    t.wt.status = ' M src/meio.ts'
    // Reload com o corretor no meio: o app morreu e não volta nas 30 tentativas; o defeito acaba com a mudança no meio.
    await start($)
    app.down = 30
    await t.clock.advance(66_000)
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', reasons: ['o app não subiu pela worktree'] })
    await tick(t)
    expect(types(t)).toEqual([QA_FIXER])
    expect(t.wt.commits).toEqual([])
    expect(t.log.runs.some(a => a.includes('-C') && (a.includes('reset') || a.includes('add')))).toBe(false)
    expect(t.log.toasts.at(-1)).toContain('mudanças que nenhum commit levou')
    expect(await label(ui)).toBe('QA: Corrigir')
  })
})

describe('QA: fase Corrigir, preparação e retomada', () => {
  // A worktree da branch já existe (o rev-parse dela diz a branch): é reaproveitada.
  const ownBranch = (a: readonly string[]) => {
    const dir = a[4] ?? ''
    return a.join(' ').endsWith('rev-parse --abbrev-ref HEAD') && dir.includes('/.worktrees/') ? { exitCode: 0, stdout: `qa/${dir.split('/qa-').pop()}\n` } : undefined
  }

  test('pasta da worktree que já existe e é de outra branch: avisa e não lança nada', async ($, on) => {
    const r = await toFix($, on)
    r.t.dirs.add(wtOf(r.t))
    await click(r.t, r.ui)
    await click(r.t, r.ui)
    expect(r.t.log.toasts.at(-1)).toContain('já existe e não é a worktree')
    expect(r.t.log.spawns).toEqual([])
  })

  test('pasta da worktree que existe sem o .git: o git com teto falha em vez de subir até a raiz, e o clique avisa', async ($, on) => {
    const r = await toFix($, on, { run: a => (a[0] === 'env' && a.includes('--abbrev-ref') ? { exitCode: 128, stdout: '' } : undefined) })
    r.t.dirs.add(wtOf(r.t))
    await click(r.t, r.ui)
    await click(r.t, r.ui)
    expect(r.t.log.runs).toContainEqual(gitIn(r.t, 'rev-parse', '--abbrev-ref', 'HEAD'))
    expect(r.t.log.toasts.at(-1)).toContain('já existe e não é a worktree')
    expect(r.t.log.spawns).toEqual([])
  })

  test('cópia do .env que falha: avisa e não lança nada', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a[0] === 'cp' ? { exitCode: 1, stdout: '' } : undefined) })
    expect(t.log.toasts.at(-1)).toContain('.env da worktree')
    expect(t.log.spawns).toEqual([])
  })

  test('stop e novo clique: reaproveita a worktree, não repete o exclude e o corretor volta', async ($, on) => {
    const { t, ui } = await fixing($, on, { run: ownBranch })
    await command($, 'qa stop')
    await click(t, ui)
    await click(t, ui)
    expect(t.log.runs.filter(a => a[1] === 'worktree')).toHaveLength(1)
    expect(t.files.get(`${REPO}/.git/info/exclude`)).toBe('.worktrees/\n/.env\n')
    expect(types(t)).toEqual([QA_FIXER, QA_FIXER])
  })

  test('recusa no meio da tentativa 2 desfaz até o começo dela: o commit da tentativa 1 fica', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'FALHOU' } : undefined) })
    await fixerEnds($, t)
    expect(t.wt.head).toBe('c1')
    await fixerEnds($, t, JSON.stringify({ retestable: true }))
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'c1'))
    expect(t.wt.head).toBe('c1')
    expect(t.log.spawns[2]?.prompt).toContain('mudança sem descrição de commit')
  })

  test('tentativa 2 que termina não reverificada desfaz até o começo do defeito: o commit recusado da tentativa 1 sai', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'FALHOU' } : undefined) })
    await fixerEnds($, t)
    expect(t.wt.head).toBe('c1')
    await fixerEnds($, t, JSON.stringify({ retestable: false, reason: 'backend', subject: 'Corrige a API' }))
    expect(t.log.runs).toContainEqual(gitIn(t, 'reset', '-q', '--hard', 'abc123'))
    expect(t.wt.head).toBe('abc123')
    expect(resultOf(t)).toMatchObject({ status: 'não reverificado', attempts: 2 })
  })

  test('reload entre o commit e o fim das conferências: segue da etapa depois do commit, sem recusa nem tentativa a mais', async ($, on) => {
    const { t } = await fixing($, on, { stall: holdOnce(k => k === 'npm test').hold })
    await fixerEnds($, t)
    expect(t.wt.commits).toHaveLength(1)
    await start($)
    await tick(t)
    expect(t.wt.commits).toHaveLength(1)
    // O `npm test` parado nunca chega ao log (o fixture registra depois da espera): este é o do passo novo.
    expect(t.log.runs.filter(a => a.join(' ') === 'npm test')).toHaveLength(1)
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER])
  })

  test('o fix.json de uma tentativa recusada não vale para a seguinte', async ($, on) => {
    const { t } = await fixing($, on, { run: a => (a.join(' ') === 'npm test' ? { exitCode: 1, stdout: 'FALHOU' } : undefined) })
    await fixerEnds($, t)
    await fixerEnds($, t, null)
    expect(t.log.spawns[2]?.prompt).toContain('fix.json ausente ou inválido')
  })

  test('o corretor só grava na pasta do defeito; a pasta da execução inteira só é lida', async ($, on) => {
    const { t } = await fixing($, on)
    const fixer = JSON.parse(t.log.guards.find(g => g.includes('"role":"fixer"')) ?? '{}')
    expect(fixer.ctx.runDir).toBe(outOf(t))
    expect(fixer.ctx.readDirs).toContain(t.runDir())
    expect(t.dirs.has(outOf(t))).toBe(true)
  })

  test('matriz e vereditos da execução reescritos no meio da fase não valem: tudo foi lido no clique', async ($, on) => {
    const { t } = await fixing($, on)
    t.files.set(`${t.runDir()}/matriz.md`, mdOf({ ...FIX_MATRIX, testCommand: 'npm run mal', startCommand: 'npm run mal' }))
    t.files.set(`${t.runDir()}/celulas/c1/veredito.json`, verdictOf('c1', 'PASS'))
    t.files.set(`${t.runDir()}/celulas/c2/teste.spec.ts`, 'forjado()')
    await fixerEnds($, t)
    expect(t.log.runs).toContainEqual(['npm', 'test'])
    expect(t.log.runs.some(a => a.includes('mal'))).toBe(false)
    expect(t.log.apps.every(a => !a.argv.includes('mal'))).toBe(true)
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER])
    const re = (cell: string) => `${outOf(t)}/reteste-1/${cell}/veredito.json`
    await finishAgent($, t)
    await finishAgent($, t, { [re('c1')]: verdictOf('c1', 'PASS') })
    await finishAgent($, t)
    await finishAgent($, t, { [re('c2')]: verdictOf('c2', 'PASS') })
    expect(resultOf(t)).toMatchObject({ status: 'corrigido' })
    await tick(t)
    expect(t.files.get(`${wtOf(t)}/e2e/qa-c2.spec.ts`)).toBe('test()')
  })

  test('app original fora do ar: a regressão não roda e vira pendência, sem recusa', async ($, on) => {
    const app = { up: true }
    const { t } = await fixing($, on, { run: a => (a[0] === 'curl' && a.includes(MATRIX.baseUrl) && !app.up ? { exitCode: 7, stdout: '' } : undefined) })
    app.up = false
    await fixerEnds($, t)
    expect(t.log.runs.some(a => a[0] === 'npx')).toBe(false)
    expect(types(t)).toEqual([QA_FIXER, QA_RUNNER])
    const re = (cell: string) => `${outOf(t)}/reteste-1/${cell}/veredito.json`
    await finishAgent($, t)
    await finishAgent($, t, { [re('c1')]: verdictOf('c1', 'PASS') })
    await finishAgent($, t)
    await finishAgent($, t, { [re('c2')]: verdictOf('c2', 'PASS') })
    expect(resultOf(t)).toMatchObject({ status: 'corrigido', attempts: 1, pending: ['teste de regressão não rodado: app original fora do ar'] })
  })

  test('projeto sem Playwright: o teste de regressão não roda e vira pendência', async ($, on) => {
    const { t } = await fixing($, on, {}, MATRIX)
    await fixerEnds($, t)
    expect(t.log.runs.some(a => a[0] === 'npx')).toBe(false)
    const re = (cell: string) => `${outOf(t)}/reteste-1/${cell}/veredito.json`
    await finishAgent($, t)
    await finishAgent($, t, { [re('c1')]: verdictOf('c1', 'PASS') })
    await finishAgent($, t)
    await finishAgent($, t, { [re('c2')]: verdictOf('c2', 'PASS') })
    expect(resultOf(t)).toMatchObject({ status: 'corrigido', regressionTest: 'e2e/qa-c1.d1.spec.ts', pending: ['teste de regressão não rodado'] })
  })
})
