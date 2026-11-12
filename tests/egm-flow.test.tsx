import type { On, PromptOrigin } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { EGM_BUSY_TEXT, EGM_FIXER, EGM_WAIT_TEXT, PERSONAS, PLAN_FIX_HEADER } from '../hooks/egm'
import { PLAN_REVIEW_MARK, executePromptOf } from '../hooks/plan'
import { AGENT_TIMEOUT_MS, hashOf } from '../hooks/qa'
import { SPAWN_GRACE_MS } from '../hooks/stale'

// A revisão EGM pelo engine: a faixa montada, o botão EGM na etapa Revisão, o timer de 3 s e hooks do teste no lugar do
// engine para env, processos, arquivos (um mapa em memória), agentes e campo de prompt. O `agent.spawn` do harness nunca
// devolve o id: o agente aparece na lista (`a<n>`, vivo, lançado pelo mod) e o mod o adota no tique seguinte.
const BAND = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const HOME = '/home/user'
const CWD = `${HOME}/proj`
const DOC = `${CWD}/plano.md`
// O plano do plan mode fica em ~/.claude/plans (só ali a revisão do ExitPlanMode roda).
const PLAN = `${HOME}/.claude/plans/plano-x.md`
const ROOT = `${HOME}/.claude/plugins/cache/egm/egm/0.1.0`
const EGM_ROOT = `${HOME}/.claude/workbench-egm`
const HOLD_MS = 10_000
const NAMES = PERSONAS.map(p => p.persona)
const TYPE_OF = Object.fromEntries(PERSONAS.map(p => [p.persona, p.subagentType])) as Record<string, string>

const GO = 'ACHADOS\nVEREDITO: GO'
const blocker = (text = 'falta o prazo') => `ACHADOS\n- [Blocker] seção 2: ${text}\nVEREDITO: NO-GO`
const MAJOR = 'ACHADOS\n- [Major] seção 3: nome confuso\nVEREDITO: GO'
const answers = (...lines: string[]) => ['RESPOSTAS', ...lines, 'FIM'].join('\n')

type Agent = { id: string; type: string; status: 'running' | 'completed'; description: string; spawnedBy?: string }
type Over = {
  typed?: string
  home?: string | null
  node?: string
  hasPlugin?: boolean
  // `withId`: o hook devolve o id na hora (o caso real); o agente também vai à lista.
  spawns?: { deny?: string; unlisted?: boolean; withId?: boolean }[]
  messages?: Record<string, { role: 'user' | 'assistant'; text: string }[]>
  failWrite?: (path: string) => boolean
  failRegister?: boolean
  failMkdir?: boolean
  // O `planFlow` lido como uma versão antiga o gravou (sem o campo `report`).
  isOldFlow?: boolean
  // O `realpath` falha (sem ele, o mod usa o caminho como veio).
  failReal?: boolean
  // Arquivos que o plugin EGM não tem, e pastas a mais (existem, mas não se leem como arquivo).
  dropFiles?: string[]
  extraDirs?: string[]
  // O `session.messages` devolve algo que não é lista.
  badMessages?: boolean
  // A resposta da lista de agentes ou do lançamento chega HOLD_MS depois, uma vez (segura o passo para um `egm stop` no meio).
  // `fix`: a consulta de `correcao.md` (segura o passo do plan mode na fase fix).
  // `job`: a primeira leitura do `egmJob` (segura o markAskTurn do tique).
  holdAt?: 'list' | 'spawn' | 'fix' | 'job'
  // O envio do mod é recusado (`{ drop }`) quando o texto casa.
  dropSubmit?: (text: string) => boolean
}

async function boot($: Engine, on: On, over: Over = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const files = new Map<string, string>([
    [DOC, 'plano v1'],
    [PLAN, 'plano v1'],
    ...PERSONAS.map(p => [`${ROOT}/agents/${p.file}`, `PERSONA ${p.persona}`] as [string, string]),
    ...PERSONAS.flatMap(p => (p.standard === null ? [] : [[`${ROOT}/resources/document_standards/${p.standard}`, 'PADRAO'] as [string, string]])),
  ])
  for (const f of over.dropFiles ?? []) files.delete(f)
  const dirs = new Set<string>([...(over.hasPlugin === false ? [] : [ROOT]), ...(over.extraDirs ?? [])])
  const box = { text: over.typed ?? '' }
  const listed: Agent[] = []
  const log = { toasts: [] as string[], submits: [] as string[], notices: [] as string[], guards: [] as string[], spawns: [] as { id: string; type: string; prompt: string }[], agents: [] as string[] }
  let n = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' && over.home !== null ? (over.home ?? HOME) : undefined }))
  on('process.run', (_$, e) => {
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [cmd, ...args] = e.argv
    if (cmd === 'realpath') return over.failReal === true ? { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : ok(`${args.filter(a => a !== '--').join('\n')}\n`)
    if (cmd === 'mkdir') {
      if (over.failMkdir === true) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      dirs.add(args.at(-1) ?? '')
      return ok()
    }
    if (cmd === 'node') return ok(`${over.node ?? 'v22.6.0'}\n`)
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => {
    if (e.path.endsWith('/correcao.md')) await holdOnce('fix')
    return { value: files.has(e.path) || dirs.has(e.path) }
  })
  on('fs.list', (_$, e) => ({
    value: [...dirs].filter(d => d.startsWith(`${e.path}/`) && !d.slice(e.path.length + 1).includes('/')).map(d => ({ name: d.slice(e.path.length + 1), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$, e, next) => {
    const text = files.get(e.path)
    return text === undefined ? next(e) : { value: text }
  })
  on('fs.write', (_$, e, next) => {
    if (over.failWrite?.(e.path) === true) return next(e)
    files.set(e.path, e.text)
    if (/\/workbench-egm\/guard-[a-z0-9]+\.json$/.test(e.path)) log.guards.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e, next) => {
    if (over.failRegister === true && e.name === 'egm-fixer') return next(e)
    log.agents.push(e.name)
    return { value: { agent: e.name } }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__workbench__${e.name}` } }))
  const holdOnce = async (at: 'list' | 'spawn' | 'fix' | 'job') => {
    if (over.holdAt !== at) return
    over.holdAt = undefined
    await clock.sleep(HOLD_MS)
  }
  on('agent.spawn', async (_$, e) => {
    await holdOnce('spawn')
    const type = e.subagentType ?? String(Reflect.get(e, 'subagent_type'))
    n += 1
    const id = `a${n}`
    log.spawns.push({ id, type, prompt: e.prompt })
    const r = over.spawns?.shift() ?? {}
    if (r.deny !== undefined) return { deny: r.deny }
    if (r.unlisted !== true) listed.push({ id, type, status: 'running', description: 'x', spawnedBy: 'workbench' })
    return r.withId === true ? { model: 'opus', agentId: id } : { model: 'opus' }
  })
  on('agent.list', async () => {
    await holdOnce('list')
    return { value: listed }
  })
  on('session.messages', (_$, e) => ({ value: over.badMessages === true ? ('x' as never) : (over.messages?.[e.agentId ?? ''] ?? []).map(m => ({ ...m, toolUses: [] })) }))
  on('session.append', (_$, e, next) => {
    const text = e.message.content[0]?.text
    if (typeof text === 'string') log.notices.push(text)
    return next(e)
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
    if (over.dropSubmit?.(e.text) === true) return { drop: 'recusado-x' }
    log.submits.push(e.text)
    return { text: e.text }
  })
  // A saída do plan mode quando o mod deixa passar.
  on('tool.call', () => ({ result: 'saiu', text: 'saiu' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId, kind: 'engine' as const, ref: 1 }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.offer', () => ({ isOffered: true }))
  // Um hook só (o harness recusa dois): segura a leitura do `egmJob` e, com `isOldFlow`, lê o `planFlow` sem `report`.
  on('state.get', (_$, e, next) => {
    if (e.key === 'egmJob' && over.holdAt === 'job') return holdOnce('job').then(() => next(e))
    if (over.isOldFlow !== true || e.key !== 'planFlow') return next(e)
    return next(e).then(got => {
      const flow: unknown = got.value?.value
      if (typeof flow !== 'object' || flow === null) return got
      const { report: _, ...old } = flow as Record<string, unknown>
      return { ...got, value: { ...got.value, value: old } } as typeof got
    })
  })
  await start($)
  const setHome = (h: string | null) => { over.home = h }
  const dir = () => [...dirs].find(d => d.startsWith(`${EGM_ROOT}/`)) ?? ''
  const guard = () => JSON.parse(log.guards.at(-1) ?? '{}')
  return { clock, files, dirs, box, listed, log, dir, guard, setHome }
}

type T = Awaited<ReturnType<typeof boot>>
const start = ($: Engine) => $.session.start({ cwd: CWD, surface: null, isInteractive: true })
const tick = (t: T) => t.clock.advance(3_100)
const mount = ($: Engine) => $.ui.mount(BAND)
type Ui = Awaited<ReturnType<typeof mount>>
const label = async (ui: Ui) => (await ui.find({ type: 'Button', key: 'plan' }))?.text
const typeCommand = ($: Engine, name: string, args = '') =>
  $.prompt.submit({ text: `/${name} ${args}`.trim(), wait: false, origin: { kind: 'composer' }, command: { name, args } })
const reply = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, reason: 'answer', agentId })
const command = ($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.command.run({ command: 'workbench', args, origin, presentation: { isFullscreen: false, columns: 120 } })
const idOf = (t: T, type: string) => t.log.spawns.filter(s => s.type === type).at(-1)?.id ?? ''
const report = (t: T) => t.files.get(`${t.dir()}/veredito.md`) ?? ''

// Etapa em Revisão (comandos digitados) e o caminho do plano no campo, relativo à pasta da sessão.
async function ready($: Engine, on: On, over: Over = {}) {
  over.typed ??= 'plano.md'
  const t = await boot($, on, over) // o mesmo objeto: o teste arma `holdAt` depois
  const ui = await $.ui.mount(BAND)
  await typeCommand($, 'egm:egm-brainstorm', 'x')
  await typeCommand($, 'egm:egm-draft')
  t.box.text = over.typed ?? 'plano.md'
  t.log.submits.length = 0
  return { t, ui }
}

async function clickPlan(t: T, ui: Ui) {
  await ui.press({ key: 'plan' })
  await tick(t)
}

// Clique e os 5 revisores lançados e adotados (um lançamento por tique, a adoção no tique seguinte).
async function launched($: Engine, on: On, over: Over = {}) {
  const r = await ready($, on, over)
  await clickPlan(r.t, r.ui)
  for (let i = 0; i < NAMES.length + 1; i++) await tick(r.t)
  return r
}

// As respostas dos revisores desta rodada (GO para quem não está em `by`) e o tique que decide.
async function answerRound($: Engine, t: T, by: Record<string, string>, names: readonly string[] = NAMES) {
  for (const name of names) await reply($, idOf(t, TYPE_OF[name] ?? ''), by[name] ?? GO)
  await tick(t)
}

// O corretor lançado é adotado, edita o plano (quando `newDoc`) e responde; o tique decide.
async function fixerReplies($: Engine, t: T, text: string, newDoc: string | null) {
  await tick(t)
  if (newDoc !== null) t.files.set(DOC, newDoc)
  await reply($, idOf(t, EGM_FIXER), text)
  await tick(t)
}

describe('EGM: clique em Revisão', () => {
  test('passo 1: revisão em andamento', async ($, on) => {
    const { t, ui } = await ready($, on)
    await clickPlan(t, ui)
    t.box.text = 'plano.md'
    await clickPlan(t, ui)
    expect(t.log.toasts.at(-1)).toBe('EGM: revisão em andamento (use /workbench egm stop)')
    expect(t.box.text).toBe('plano.md')
  })

  test('passo 2: corretor da revisão anterior ainda vivo', async ($, on) => {
    const { t, ui } = await ready($, on)
    t.listed.push({ id: 'old', type: EGM_FIXER, status: 'running', description: 'x', spawnedBy: 'workbench' })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: o corretor da revisão anterior ainda está rodando; espere ele terminar'])
    expect(t.log.spawns).toEqual([])
  })

  test('passo 3: campo sem caminho (só o comando do EGM)', async ($, on) => {
    const { t, ui } = await ready($, on, { typed: '/egm:egm-review' })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: escreva o caminho do plano no campo e clique em Revisão'])
    expect(t.box.text).toBe('/egm:egm-review')
  })

  test('passo 4: sem HOME', async ($, on) => {
    const { t, ui } = await ready($, on, { home: null })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: não achei a pasta do usuário (HOME)'])
  })

  test('passo 5: arquivo que não existe', async ($, on) => {
    const { t, ui } = await ready($, on, { typed: 'docs/nada.md' })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: não consegui ler o arquivo docs/nada.md'])
    expect(t.box.text).toBe('docs/nada.md')
  })

  test('passo 6: plugin egm não instalado', async ($, on) => {
    const { t, ui } = await ready($, on, { hasPlugin: false })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: plugin egm não encontrado (claude plugin enable egm@egm)'])
  })

  test('passo 7: Node velho ou corretor sem registro', async ($, on) => {
    const old = await ready($, on, { node: 'v20.1.0' })
    await clickPlan(old.t, old.ui)
    expect(old.t.log.toasts).toEqual(['EGM: o corretor não pode rodar aqui (precisa do Node 22.6 ou mais novo)'])
  })

  test('passo 7: o tipo do corretor não registrou', async ($, on) => {
    const { t, ui } = await ready($, on, { failRegister: true })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: o corretor não pode rodar aqui (precisa do Node 22.6 ou mais novo)'])
  })

  test('passo 8: não cria a pasta', async ($, on) => {
    const { t, ui } = await ready($, on, { failMkdir: true })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: não consegui criar a pasta da revisão'])
    expect(t.box.text).toBe('plano.md')
  })

  test('sucesso: limpa o campo, cria a pasta e lança os 5 revisores, um por tique, com persona, padrão e plano no pedido', async ($, on) => {
    const { t, ui } = await ready($, on, { typed: '/egm:egm-review ~/proj/plano.md' })
    await clickPlan(t, ui)
    expect(t.box.text).toBe('')
    expect(t.dir()).toMatch(/\/workbench-egm\/\d{8}-\d{6}$/)
    expect(await label(ui)).toBe('EGM: r1 revisando 0/5')
    for (let i = 1; i <= NAMES.length; i++) {
      await tick(t)
      expect(t.log.spawns).toHaveLength(i)
    }
    expect(t.log.spawns.map(s => s.type)).toEqual(PERSONAS.map(p => p.subagentType))
    const design = t.log.spawns[2]?.prompt ?? ''
    expect(design).toContain(`TargetFile: ${DOC}`)
    expect(design).toContain('PERSONA design')
    expect(design).toContain('PADRAO')
    expect(design).toContain('1: plano v1')
  })
})

describe('EGM: rodadas', () => {
  test('a resposta é gravada no turn.complete; GO na rodada 1 leva a etapa a Executar com o relatório', async ($, on) => {
    const { t, ui } = await launched($, on)
    await reply($, idOf(t, TYPE_OF['design'] ?? ''), GO)
    expect(t.files.get(`${t.dir()}/r1/design.md`)).toBe(GO)
    expect(await label(ui)).toBe('EGM: r1 revisando 0/5')
    await answerRound($, t, {})
    expect(report(t)).toContain('Veredito: GO')
    expect(report(t)).toContain(`Marca: ${hashOf('plano v1')}`)
    expect(t.log.notices.at(-1)).toBe(`EGM: revisão GO em 1 rodada(s): 0 Blocker(s) e 0 Major(s) corrigidos, 0 rejeitado(s). Relatório: ${t.dir()}/veredito.md`)
    expect(await label(ui)).toBe('EGM: Executar')
    expect(t.log.spawns.some(s => s.type === EGM_FIXER)).toBe(false)
  })

  test('Blocker: corretor, rodada 2 só com quem reprovou, GO, e o Executar passa com a marca de depois da correção', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    expect(t.log.spawns.at(-1)?.type).toBe(EGM_FIXER)
    expect(t.log.spawns.at(-1)?.prompt).toContain('- [Blocker] design #1: seção 2: falta o prazo')
    expect(t.files.get(`${t.dir()}/r1/doc-antes.md`)).toBe('plano v1')
    expect(t.guard()).toEqual({ role: 'planfixer', agentId: null, doc: DOC, dir: t.dir(), cwd: CWD })
    expect(await label(ui)).toBe('EGM: r1 corrigindo')
    await tick(t)
    expect(t.guard().agentId).toBe(idOf(t, EGM_FIXER))
    t.files.set(DOC, 'plano v2')
    await reply($, idOf(t, EGM_FIXER), answers('- [corrigido] design #1'))
    await tick(t)
    expect(t.log.guards.at(-1)).toBe('{}')
    await tick(t)
    await tick(t)
    expect(t.log.spawns.slice(-1).map(s => s.type)).toEqual([TYPE_OF['design']])
    const again = t.log.spawns.at(-1)?.prompt ?? ''
    expect(again).toContain('falta o prazo')
    expect(again).toContain('- [corrigido] design #1')
    expect(t.log.spawns.find(s => s.type === TYPE_OF['design'])?.prompt).not.toContain('Rodada anterior')
    await answerRound($, t, {}, ['design'])
    expect(report(t)).toContain('Veredito: GO')
    expect(report(t)).toContain(`Marca: ${hashOf('plano v2')}`)
    expect(report(t)).toContain('- [Blocker] design #1 (r1): seção 2: falta o prazo')
    expect(await label(ui)).toBe('EGM: Executar')
    await clickPlan(t, ui)
    expect(t.log.submits.at(-1)).toBe(executePromptOf(DOC, `${t.dir()}/veredito.md`))
    expect(await label(ui)).toBe('EGM')
  })

  test('só Majors: corretor e GO sem nova rodada', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, { 'zoom-out': MAJOR })
    const before = t.log.spawns.length
    await fixerReplies($, t, answers('- [rejeitado] zoom-out #1: o usuário pediu esse nome'), null)
    expect(t.log.spawns).toHaveLength(before)
    expect(report(t)).toContain('Veredito: GO')
    expect(report(t)).toContain('- [Major] zoom-out #1 (r1): seção 3: nome confuso — motivo: o usuário pediu esse nome')
    expect(await label(ui)).toBe('EGM: Executar')
  })

  test('Blocker na rodada 3: NO-GO sem corretor e a etapa fica em Revisão', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    await fixerReplies($, t, answers('- [corrigido] design #1'), 'plano v2')
    await tick(t)
    await tick(t)
    await answerRound($, t, { design: blocker() }, ['design'])
    await fixerReplies($, t, answers('- [corrigido] design #1'), 'plano v3')
    await tick(t)
    await tick(t)
    const fixers = t.log.spawns.filter(s => s.type === EGM_FIXER).length
    await answerRound($, t, { design: blocker() }, ['design'])
    expect(t.log.spawns.filter(s => s.type === EGM_FIXER)).toHaveLength(fixers)
    expect(t.log.notices.at(-1)).toBe(`EGM: revisão NO-GO: 1 Blocker(s) aberto(s) depois de 3 rodadas. Relatório: ${t.dir()}/veredito.md`)
    expect(report(t)).toContain('Rodadas: 3')
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('deny no lançamento: NO-GO na hora, sem lançar mais ninguém', async ($, on) => {
    const { t, ui } = await ready($, on, { spawns: [{ deny: 'sem permissão' }] })
    await clickPlan(t, ui)
    await tick(t)
    await tick(t)
    expect(t.log.spawns).toHaveLength(1)
    expect(t.log.notices.at(-1)).toBe(`EGM: revisão NO-GO: não consegui lançar zoom-out: sem permissão. Relatório: ${t.dir()}/veredito.md`)
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('lançamento sem id: espera a adoção e adota quando o agente aparece na lista', async ($, on) => {
    const { t, ui } = await ready($, on, { spawns: [{ unlisted: true }] })
    await clickPlan(t, ui)
    await tick(t)
    await tick(t)
    t.listed.push({ id: 'late', type: TYPE_OF['zoom-out'] ?? '', status: 'running', description: 'x', spawnedBy: 'workbench' })
    for (let i = 0; i < NAMES.length; i++) await tick(t)
    await reply($, 'late', MAJOR)
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe(MAJOR)
    expect(await label(ui)).toBe('EGM: r1 revisando 0/5')
  })

  test('agente egm:egm-* que o mod não lançou não é adotado nem calado', async ($, on) => {
    const { t, ui } = await ready($, on, { spawns: [{ unlisted: true }] })
    t.listed.push({ id: 'chat', type: TYPE_OF['zoom-out'] ?? '', status: 'running', description: 'x' })
    await clickPlan(t, ui)
    for (let i = 0; i < NAMES.length + 1; i++) await tick(t)
    await reply($, 'chat', blocker())
    expect(t.files.has(`${t.dir()}/r1/zoom-out.md`)).toBe(false)
    const handback = await $.prompt.submit({ text: '<agent-message from="chat">oi</agent-message>', wait: false, isMeta: true, origin: { kind: 'peer' } })
    expect('drop' in handback).toBe(false)
    await t.clock.advance(SPAWN_GRACE_MS)
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe('revisão incompleta')
  })

  test('revisor encerrado sem resposta: a última mensagem vem do session.messages; sem texto vira incompleto', async ($, on) => {
    const { t } = await launched($, on, {
      messages: {
        a1: [
          { role: 'assistant', text: 'primeira' },
          { role: 'assistant', text: 'segunda' },
          { role: 'assistant', text: MAJOR },
          { role: 'user', text: 'pergunta' },
          { role: 'assistant', text: '  ' },
        ],
      },
    })
    for (const id of ['a1', 'a2']) t.listed.find(a => a.id === id)!.status = 'completed'
    await t.clock.advance(20_000)
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe(MAJOR)
    expect(t.files.get(`${t.dir()}/r1/comprehension.md`)).toBe('revisão incompleta')
  })

  test('revisor vivo além do prazo vira incompleto, e roda de novo na rodada seguinte', async ($, on) => {
    const { t } = await launched($, on)
    for (const name of NAMES.slice(1)) await reply($, idOf(t, TYPE_OF[name] ?? ''), GO)
    await t.clock.advance(AGENT_TIMEOUT_MS)
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe('revisão incompleta')
    await tick(t)
    expect(t.log.spawns.at(-1)?.type).toBe(TYPE_OF['zoom-out'])
    expect(t.log.spawns).toHaveLength(6)
  })

  test('corretor com "precisa do usuário": NO-GO na hora com a pergunta em Abertos', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    await fixerReplies($, t, answers('- [precisa do usuário] design #1: qual prazo vale?'), null)
    expect(t.log.notices.at(-1)).toContain('EGM: revisão NO-GO: o corretor precisa de você.')
    expect(report(t)).toContain('- [Blocker] design #1 (r1): seção 2: falta o prazo — qual prazo vale?')
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('corretor que diz corrigido sem mudar o plano: NO-GO', async ($, on) => {
    const { t } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    await fixerReplies($, t, answers('- [corrigido] design #1'), null)
    expect(t.log.notices.at(-1)).toContain('o corretor disse que corrigiu, mas o plano não mudou')
  })

  test('corretor encerrado sem resposta: NO-GO "não terminou"', async ($, on) => {
    const { t } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    await tick(t)
    t.listed.find(a => a.id === idOf(t, EGM_FIXER))!.status = 'completed'
    await t.clock.advance(20_000)
    expect(t.log.notices.at(-1)).toContain('o corretor não terminou')
  })

  test('falha ao gravar a cópia do plano: NO-GO sem lançar o corretor', async ($, on) => {
    const { t } = await launched($, on, { failWrite: path => path.endsWith('/doc-antes.md') })
    await answerRound($, t, { design: blocker() })
    expect(t.log.spawns.some(s => s.type === EGM_FIXER)).toBe(false)
    expect(t.log.notices.at(-1)).toContain('não consegui gravar os arquivos da correção')
  })

  test('plano mudado no meio da revisão: NO-GO', async ($, on) => {
    const { t, ui } = await launched($, on)
    t.files.set(DOC, 'plano editado')
    await answerRound($, t, {})
    expect(t.log.notices.at(-1)).toContain('o plano mudou durante a revisão; clique em Revisão de novo')
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('relatório que não grava: o trabalho termina com o aviso e a etapa fica em Revisão', async ($, on) => {
    const { t, ui } = await launched($, on, { failWrite: path => path.endsWith('/veredito.md') })
    await answerRound($, t, {})
    expect(t.log.notices.at(-1)).toBe(`EGM: não consegui gravar o relatório em ${t.dir()}/veredito.md; clique em Revisão de novo`)
    expect(await label(ui)).toBe('EGM: Revisão')
  })
})

describe('EGM: bordas do clique e do passo', () => {
  test('realpath que falha: o mod segue com o caminho como veio', async ($, on) => {
    const { t, ui } = await ready($, on, { failReal: true })
    await clickPlan(t, ui)
    expect(t.dir()).toMatch(/\/workbench-egm\/\d{8}-\d{6}$/)
    expect(await label(ui)).toBe('EGM: r1 revisando 0/5')
  })

  test('passo 2: corretor encerrado e agente de outro tipo vivo não barram o clique', async ($, on) => {
    const { t, ui } = await ready($, on)
    t.listed.push({ id: 'old', type: EGM_FIXER, status: 'completed', description: 'x', spawnedBy: 'workbench' })
    t.listed.push({ id: 'live', type: TYPE_OF['design'] ?? '', status: 'running', description: 'x', spawnedBy: 'workbench' })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual([])
    expect(t.dir()).not.toBe('')
  })

  test('passo 5: o caminho existe mas não se lê (uma pasta)', async ($, on) => {
    const { t, ui } = await ready($, on, { typed: 'pasta.md', extraDirs: [`${CWD}/pasta.md`] })
    await clickPlan(t, ui)
    expect(t.log.toasts).toEqual(['EGM: não consegui ler o arquivo pasta.md'])
    expect(t.box.text).toBe('pasta.md')
  })

  test('persona do plugin que some: NO-GO sem lançar o revisor', async ($, on) => {
    const first = PERSONAS[0]!
    const { t, ui } = await ready($, on, { dropFiles: [`${ROOT}/agents/${first.file}`] })
    await clickPlan(t, ui)
    await tick(t)
    expect(t.log.spawns).toEqual([])
    expect(t.log.notices.at(-1)).toContain(`${first.persona}: não consegui ler a persona, o padrão ou o plano`)
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('mensagens do agente que não são lista: o revisor encerrado vira incompleto', async ($, on) => {
    const { t } = await launched($, on, { badMessages: true })
    t.listed.find(a => a.id === 'a1')!.status = 'completed'
    await t.clock.advance(20_000)
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe('revisão incompleta')
    expect(t.log.toasts.some(x => x.includes('passo falhou'))).toBe(false)
  })

  test('resposta em branco de um agente do trabalho não vira arquivo', async ($, on) => {
    const { t } = await launched($, on)
    await reply($, idOf(t, TYPE_OF['design'] ?? ''), '   ')
    expect(t.files.has(`${t.dir()}/r1/design.md`)).toBe(false)
  })

  test('egm stop no meio da adoção do corretor: a trava termina em {} e nada falha', async ($, on) => {
    const over: Over = {}
    const { t } = await launched($, on, over)
    await answerRound($, t, { design: blocker() })
    expect(t.log.spawns.at(-1)?.type).toBe(EGM_FIXER)
    over.holdAt = 'list'
    await tick(t)
    await command($, 'egm stop')
    await t.clock.advance(HOLD_MS)
    expect(t.log.guards.at(-2)).toContain('"a6"')
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(t.log.toasts.some(x => x.includes('passo falhou'))).toBe(false)
  })

  test('um passo em curso segura o tique seguinte: o mesmo revisor não é lançado duas vezes', async ($, on) => {
    const over: Over = {}
    const { t, ui } = await ready($, on, over)
    await clickPlan(t, ui)
    over.holdAt = 'list'
    await tick(t)
    await tick(t)
    await t.clock.advance(HOLD_MS)
    expect(t.log.spawns.filter(s => s.type === TYPE_OF['zoom-out'])).toHaveLength(1)
  })

  test('segundo clique durante o primeiro espera na fila e recebe o aviso de revisão em andamento', async ($, on) => {
    const over: Over = {}
    const { t, ui } = await ready($, on, over)
    over.holdAt = 'list'
    await ui.press({ key: 'plan' })
    await tick(t)
    await ui.press({ key: 'plan' })
    await tick(t)
    await t.clock.advance(HOLD_MS)
    await tick(t)
    await tick(t)
    expect(t.log.toasts).toContain('EGM: revisão em andamento (use /workbench egm stop)')
    expect([...t.dirs].filter(d => /\/workbench-egm\/[^/]+$/.test(d))).toHaveLength(1)
  })

  test('recarga sem HOME com a revisão em curso: o tique não dá passo nem falha', async ($, on) => {
    const { t } = await launched($, on)
    const before = t.log.spawns.length
    t.setHome(null)
    await start($)
    await tick(t)
    await tick(t)
    expect(t.log.toasts.some(x => x.includes('passo falhou'))).toBe(false)
    expect(t.log.spawns).toHaveLength(before)
  })

  test('egm stop durante o lançamento negado: não grava relatório nem avisa', async ($, on) => {
    const { t, ui } = await ready($, on, { holdAt: 'spawn', spawns: [{ deny: 'sem permissão' }] })
    await clickPlan(t, ui)
    await tick(t)
    await command($, 'egm stop')
    await t.clock.advance(HOLD_MS)
    expect(report(t)).toBe('')
    expect(t.log.toasts.some(x => x.includes('passo falhou'))).toBe(false)
    expect(t.log.notices.some(x => x.includes('não consegui lançar'))).toBe(false)
  })
})

describe('EGM: lançamento que devolve o id', () => {
  // O harness descarta o `agentId` que o hook `agent.spawn` devolve quando quem lança é o mod (chega `{ model }`): o id
  // na hora vira adoção. O código usa um só caminho (`bindAgent`) para os dois casos, e este teste o prova pela adoção:
  // slot com id, resposta gravada, id calado e a trava do corretor regravada com o id.
  test('revisor e corretor: o id entra no slot, a resposta é gravada, o aviso é calado e a trava leva o id', async ($, on) => {
    const { t, ui } = await ready($, on, { spawns: [{ withId: true }, {}, {}, {}, {}, { withId: true }] })
    await clickPlan(t, ui)
    await tick(t)
    await tick(t)
    await reply($, 'a1', blocker())
    expect(t.files.get(`${t.dir()}/r1/zoom-out.md`)).toBe(blocker())
    const drop = await $.prompt.submit({ text: '<agent-message from="a1">feito</agent-message>', wait: false, isMeta: true, origin: { kind: 'peer' } })
    expect('drop' in drop).toBe(true)
    for (let i = 0; i < NAMES.length; i++) await tick(t)
    await answerRound($, t, {}, NAMES.slice(1))
    expect(t.log.spawns.at(-1)?.type).toBe(EGM_FIXER)
    await tick(t)
    expect(t.guard()).toEqual({ role: 'planfixer', agentId: 'a6', doc: DOC, dir: t.dir(), cwd: CWD })
    await reply($, 'a6', answers('- [corrigido] zoom-out #1'))
    expect(t.files.get(`${t.dir()}/r1/correcao.md`)).toBe(answers('- [corrigido] zoom-out #1'))
  })
})

describe('EGM: parada, recarga e avisos', () => {
  test('egm stop zera o trabalho e grava {} na trava; outra origem não pode parar', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, { design: blocker() })
    expect((await command($, 'egm stop', { kind: 'plugin', name: 'outro' })).text).toBe('EGM: só o usuário pode parar a revisão.')
    expect((await command($, 'egm stop')).text).toBe(`EGM: revisão parada. O plano fica como está; as respostas já recebidas estão em ${t.dir()}.`)
    expect(t.log.guards.at(-1)).toBe('{}')
    expect(await label(ui)).toBe('EGM: Revisão')
    await tick(t)
    expect(t.log.guards.at(-1)).toBe('{}')
    expect((await command($, 'egm stop')).text).toBe('EGM: nenhuma revisão em andamento; a saída do plan mode não é mais segurada.')
  })

  test('egm stop com o ambiente nulo (registro sem HOME na recarga) ainda grava {} na trava', async ($, on) => {
    const { t } = await launched($, on)
    const guardFile = t.log.guards.length
    t.setHome(null)
    await start($)
    t.setHome(HOME)
    await command($, 'egm stop')
    expect(t.log.guards.length).toBeGreaterThan(guardFile)
    expect(t.log.guards.at(-1)).toBe('{}')
  })

  test('segundo session.start no meio: o trabalho continua de onde parou', async ($, on) => {
    const { t, ui } = await ready($, on)
    await clickPlan(t, ui)
    await tick(t)
    await tick(t)
    await start($)
    for (let i = 0; i < NAMES.length; i++) await tick(t)
    expect(t.log.spawns.map(s => s.type)).toEqual(PERSONAS.map(p => p.subagentType))
    await answerRound($, t, {})
    expect(await label(ui)).toBe('EGM: Executar')
  })

  test('o aviso de fim de um agente do EGM sai da conversa; o de outro agente entra', async ($, on) => {
    const { t } = await launched($, on)
    const submit = (id: string) => $.prompt.submit({ text: `<agent-message from="${id}">feito</agent-message>`, wait: false, isMeta: true, origin: { kind: 'peer' } })
    expect('drop' in (await submit(idOf(t, TYPE_OF['design'] ?? '')))).toBe(true)
    expect('drop' in (await submit('outro'))).toBe(false)
  })

  test('o corretor fica escondido do modelo', async ($, on) => {
    await boot($, on)
    const offer = await $.agent.offer({ agent: EGM_FIXER, description: 'x', source: 'plugin', provider: { plugin: 'workbench', tier: 'user' } })
    expect(offer.isOffered).toBe(false)
  })
})

describe('EGM: Executar', () => {
  test('plano mudado depois do GO: volta a Revisão com o mesmo doc e não envia nada', async ($, on) => {
    const { t, ui } = await launched($, on)
    await answerRound($, t, {})
    t.files.set(DOC, 'plano mexido')
    await clickPlan(t, ui)
    expect(t.log.submits).toEqual([])
    expect(t.log.toasts.at(-1)).toBe('EGM: o plano mudou depois da revisão (ou o relatório sumiu); clique em Revisão de novo')
    expect(await label(ui)).toBe('EGM: Revisão')
  })

  test('planFlow de versão antiga (sem report): o portão de sempre', async ($, on) => {
    const t = await boot($, on, { isOldFlow: true })
    const ui = await $.ui.mount(BAND)
    await typeCommand($, 'egm:egm-review', 'docs/designs/a.md')
    expect(await label(ui)).toBe('EGM: Executar')
    t.log.submits.length = 0
    await clickPlan(t, ui)
    expect(t.log.submits).toEqual([executePromptOf('docs/designs/a.md')])
  })
})

// ---- Revisão no plan mode (ExitPlanMode) ----

// O evento do ExitPlanMode montado à mão: os campos `plan` e `planFilePath` não estão nos tipos da API (o spike os mostrou).
// Pelo Reflect.get, como o qa_auth: o tipo de `$.tool.call` com ferramenta fora da lista estoura o tsc.
async function exitPlan($: Engine, planFilePath = PLAN): Promise<string> {
  const tool: object = $.tool
  const call = Reflect.get(tool, 'call')
  const r: unknown = await call.call(tool, { tool: 'ExitPlanMode', tool_use_id: 'u1', plan: 'texto do plano', planFilePath })
  const deny = typeof r === 'object' && r !== null ? Reflect.get(r, 'deny') : undefined
  return typeof deny === 'string' ? deny : 'passou'
}
const arm = ($: Engine) => typeCommand($, 'plan', `faça x. ${PLAN_REVIEW_MARK}.`)
const mainStart = ($: Engine, turnId: string, text: string) => $.turn.start({ text, turnId })
const mainEnd = ($: Engine, turnId: string, answer: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId, reason })
const asked = (t: T) => t.log.submits.filter(x => x.startsWith(PLAN_FIX_HEADER))

// Armado, o ExitPlanMode negado, o tique que cria o trabalho e os 5 revisores lançados e adotados.
async function planReview($: Engine, on: On, over: Over = {}) {
  const t = await boot($, on, over)
  const ui = await mount($)
  await arm($)
  const first = await exitPlan($)
  await tick(t)
  for (let i = 0; i < NAMES.length + 1; i++) await tick(t)
  return { t, ui, first }
}

// Blocker do design na rodada 1: o pedido de correção sai (sessão parada) e a conversa começa o turno dele.
async function planAsked($: Engine, on: On, over: Over = {}) {
  const r = await planReview($, on, over)
  await answerRound($, r.t, { design: blocker() })
  return r
}

describe('EGM no plan mode: o gancho do ExitPlanMode', () => {
  test('não armado: a saída passa e nada começa', async ($, on) => {
    const t = await boot($, on)
    const ui = await mount($)
    expect(await exitPlan($)).toBe('passou')
    await tick(t)
    expect(t.dir()).toBe('')
    expect(await label(ui)).toBe('EGM')
  })

  test('armado: nega com o texto de espera e a revisão começa no tique seguinte, com o plano do plan mode', async ($, on) => {
    const t = await boot($, on)
    const ui = await mount($)
    await arm($)
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
    expect(t.dir()).toBe('')
    await tick(t)
    expect(t.dir()).toMatch(/\/workbench-egm\/\d{8}-\d{6}$/)
    expect(await label(ui)).toBe('EGM: r1 revisando 0/5')
    await tick(t)
    expect(t.log.spawns[0]?.prompt).toContain(`TargetFile: ${PLAN}`)
  })

  test('segundo ExitPlanMode durante a revisão: nega com o texto de espera e não cria outra', async ($, on) => {
    const { t } = await planReview($, on)
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
    await tick(t)
    expect([...t.dirs].filter(d => /\/workbench-egm\/[^/]+$/.test(d))).toHaveLength(1)
  })

  test('trabalho do botão em curso: nega com o texto de ocupado', async ($, on) => {
    const { t, ui } = await ready($, on)
    await clickPlan(t, ui)
    await arm($)
    expect(await exitPlan($)).toBe(EGM_BUSY_TEXT)
  })

  test('plano fora de ~/.claude/plans: a saída passa', async ($, on) => {
    const t = await boot($, on)
    await arm($)
    expect(await exitPlan($, DOC)).toBe('passou')
    await tick(t)
    expect(t.dir()).toBe('')
  })

  test('clique no botão entre o gancho e o tique: o trabalho do botão fica e a conversa recebe o texto de ocupado', async ($, on) => {
    const { t, ui } = await ready($, on)
    await arm($)
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
    await ui.press({ key: 'plan' })
    await tick(t)
    await tick(t)
    await tick(t)
    expect(t.log.submits).toContain(EGM_BUSY_TEXT)
    expect([...t.dirs].filter(d => /\/workbench-egm\/[^/]+$/.test(d))).toHaveLength(1)
    expect(t.log.spawns[0]?.prompt).toContain(`TargetFile: ${DOC}`)
  })
})

describe('EGM no plan mode: correção pela conversa', () => {
  test('Blocker: o pedido sai só com a sessão parada, a resposta do turno certo é capturada e vem a rodada 2', async ($, on) => {
    const { t, ui } = await planReview($, on)
    await mainStart($, 'm1', 'outro pedido')
    await answerRound($, t, { design: blocker() })
    expect(await label(ui)).toBe('EGM: r1 corrigindo')
    expect(asked(t)).toEqual([])
    await mainEnd($, 'm1', 'feito')
    await tick(t)
    expect(asked(t)).toHaveLength(1)
    const ask = asked(t)[0] ?? ''
    expect(ask).toContain(`${PLAN_FIX_HEADER} ${PLAN} (rodada 1)`)
    expect(ask).toContain('- [Blocker] design #1: seção 2: falta o prazo')
    expect(t.log.spawns.some(s => s.type === EGM_FIXER)).toBe(false)
    await tick(t)
    expect(asked(t)).toHaveLength(1)
    await mainStart($, 'c1', ask)
    t.files.set(PLAN, 'plano v2')
    await mainEnd($, 'c1', answers('- [corrigido] design #1'))
    expect(t.files.get(`${t.dir()}/r1/correcao.md`)).toBe(answers('- [corrigido] design #1'))
    await tick(t)
    await tick(t)
    expect(t.log.spawns.at(-1)?.type).toBe(TYPE_OF['design'])
    expect(await label(ui)).toBe('EGM: r2 revisando 0/1')
  })

  test('resposta de outro turno não é capturada', async ($, on) => {
    const { t, ui } = await planAsked($, on)
    await mainStart($, 'u1', 'pergunta do usuário')
    await mainEnd($, 'u1', answers('- [corrigido] design #1'))
    await tick(t)
    expect(t.files.has(`${t.dir()}/r1/correcao.md`)).toBe(false)
    expect(await label(ui)).toBe('EGM: r1 corrigindo')
  })

  test('turno do pedido interrompido: NO-GO M5 com o texto do plan mode', async ($, on) => {
    const { t } = await planAsked($, on)
    await mainStart($, 'c1', asked(t)[0] ?? '')
    await mainEnd($, 'c1', '', 'aborted')
    await tick(t)
    expect(t.log.submits.at(-1)).toContain('NO-GO: a resposta da correção veio fora do formato (falta o bloco RESPOSTAS)')
  })

  test('o turn.start do pedido com a trava ocupada: o id é guardado e a resposta ainda é capturada', async ($, on) => {
    const over: Over = {}
    const { t, ui } = await planAsked($, on, over)
    over.holdAt = 'fix'
    await tick(t)
    await mainStart($, 'c1', asked(t)[0] ?? '')
    t.files.set(PLAN, 'plano v2')
    await mainEnd($, 'c1', answers('- [corrigido] design #1'))
    expect(t.files.get(`${t.dir()}/r1/correcao.md`)).toBe(answers('- [corrigido] design #1'))
    await t.clock.advance(HOLD_MS)
    await tick(t)
    await tick(t)
    expect(await label(ui)).toBe('EGM: r2 revisando 0/1')
  })

  test('id pendente aplicado no tique: o turno interrompido no meio da aplicação ainda dá M5', async ($, on) => {
    const over: Over = {}
    const { t } = await planAsked($, on, over)
    over.holdAt = 'fix'
    await tick(t)
    await mainStart($, 'c1', asked(t)[0] ?? '')
    await t.clock.advance(HOLD_MS)
    over.holdAt = 'job'
    await tick(t)
    await mainEnd($, 'c1', '', 'aborted')
    await t.clock.advance(HOLD_MS)
    await tick(t)
    expect(t.files.get(`${t.dir()}/r1/correcao.md`)).toBe('revisão incompleta')
    expect(t.log.submits.at(-1)).toContain('NO-GO: a resposta da correção veio fora do formato')
  })

  test('envio do pedido recusado: NO-GO M7 e o turno seguinte do usuário não é capturado', async ($, on) => {
    const { t } = await planAsked($, on, { dropSubmit: text => text.startsWith(PLAN_FIX_HEADER) })
    await tick(t)
    expect(t.log.notices.at(-1)).toContain('NO-GO: não consegui mandar o pedido de correção à conversa')
    await mainStart($, 'u1', 'oi')
    await mainEnd($, 'u1', answers('- [corrigido] design #1'))
    expect(t.files.has(`${t.dir()}/r1/correcao.md`)).toBe(false)
  })
})

describe('EGM no plan mode: fim e parada', () => {
  test('GO: a mensagem vai à conversa, o próximo ExitPlanMode passa e desarma', async ($, on) => {
    const { t, ui } = await planReview($, on)
    await answerRound($, t, {})
    expect(t.log.submits.at(-1)).toBe(`Revisão EGM do workbench: GO em 1 rodada(s). Relatório: ${t.dir()}/veredito.md. Chame ExitPlanMode agora.`)
    expect(t.log.notices.at(-1)).toBe(t.log.submits.at(-1))
    expect(await label(ui)).toBe('EGM')
    expect(await exitPlan($)).toBe('passou')
    t.files.set(PLAN, 'plano v2')
    expect(await exitPlan($)).toBe('passou')
  })

  test('GO antigo não solta a saída durante uma revisão nova, mesmo com o texto aprovado de volta', async ($, on) => {
    const { t } = await planReview($, on)
    await answerRound($, t, {})
    t.files.set(PLAN, 'plano v2')
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
    await tick(t)
    t.files.set(PLAN, 'plano v1')
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
  })

  test('recusa ao criar a revisão (plano ilegível): desarma e o próximo ExitPlanMode passa', async ($, on) => {
    const t = await boot($, on)
    await arm($)
    t.files.delete(PLAN)
    t.dirs.add(PLAN)
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
    await tick(t)
    expect(t.log.submits.at(-1)).toBe(`EGM: não consegui ler o arquivo ${PLAN}; a revisão do workbench foi desligada neste plano e o próximo ExitPlanMode passa sem ela.`)
    expect(await exitPlan($)).toBe('passou')
  })

  test('realpath que falha: não está pronto e a saída passa sem revisão (nunca prefixo sobre caminho não resolvido)', async ($, on) => {
    const t = await boot($, on, { failReal: true })
    await arm($)
    expect(await exitPlan($, `${HOME}/.claude/plans/../../x.md`)).toBe('passou')
    expect(await exitPlan($)).toBe('passou')
    await tick(t)
    expect(t.dir()).toBe('')
  })

  test('plano mudado depois do GO: volta a segurar', async ($, on) => {
    const { t } = await planReview($, on)
    await answerRound($, t, {})
    t.files.set(PLAN, 'plano v2')
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
  })

  test('NO-GO: a mensagem vai à conversa e continua armado', async ($, on) => {
    const { t } = await planReview($, on)
    t.files.set(PLAN, 'plano editado')
    await answerRound($, t, {})
    expect(t.log.submits.at(-1)).toBe(
      `Revisão EGM do workbench: NO-GO: o plano mudou durante a revisão. Os itens abertos estão em ${t.dir()}/veredito.md. Resolva com o usuário pelo AskUserQuestion, corrija o plano e chame ExitPlanMode de novo; o workbench revisa de novo.`,
    )
    expect(await exitPlan($)).toBe(EGM_WAIT_TEXT)
  })

  test('stop durante a revisão desarma: o próximo ExitPlanMode passa', async ($, on) => {
    const { t } = await planReview($, on)
    expect((await command($, 'egm stop')).text).toContain('EGM: revisão parada.')
    expect(await exitPlan($)).toBe('passou')
    await tick(t)
    expect(t.log.submits.filter(x => !x.startsWith('/plan '))).toEqual([])
  })

  test('stop sem trabalho desarma o plano abandonado', async ($, on) => {
    const t = await boot($, on)
    await arm($)
    expect((await command($, 'egm stop')).text).toBe('EGM: nenhuma revisão em andamento; a saída do plan mode não é mais segurada.')
    expect(await exitPlan($)).toBe('passou')
    await tick(t)
    expect(t.dir()).toBe('')
  })
})
