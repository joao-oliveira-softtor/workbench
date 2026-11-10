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
  run?: (argv: readonly string[]) => Run | undefined
  spawns?: { unlisted?: boolean; deny?: string }[]
  hold?: (key: string) => boolean
  failWrite?: (path: string, text: string) => boolean
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
  }
  let n = 0
  const answer = (argv: readonly string[]): Run => {
    const ok = (stdout = ''): Run => ({ exitCode: 0, stdout })
    const line = argv.join(' ')
    if (line.includes('--git-common-dir')) return ok(`${REPO}/.git\n`)
    if (argv[0] === 'mkdir') {
      dirs.add(argv[2] ?? '')
      return ok()
    }
    if (argv[0] === 'rm') {
      files.delete(argv[2] ?? '')
      return ok()
    }
    if (argv[0] === 'chmod' || argv[0] === 'curl') return ok()
    if (line === 'git rev-parse HEAD') return ok('abc123\n')
    if (line === 'git status --porcelain') return ok('')
    if (argv[0] === AB) return line.endsWith('get cdp-url') ? ok('ws://127.0.0.1:9333/devtools/browser/x\n') : ok()
    return { exitCode: 1, stdout: '' }
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: REPO }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? (over.home ?? HOME) : undefined }))
  on('process.run', async (_$, e) => {
    if (over.hold?.(e.argv.join(' ')) === true) await clock.sleep(HOLD_MS)
    log.runs.push([...e.argv])
    const r = over.run?.(e.argv) ?? answer(e.argv)
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
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
  return { clock, files, dirs, box, listed, log, runDir, guard }
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
    await click(t, ui)
    expect(t.log.toasts.at(-1)).toBe('Corrigir entra na próxima versão desta branch')
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
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(JSON.parse(t.log.guards.at(-2) ?? '{}')).toMatchObject({ role: 'runner', agentId: 'a1' })
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
