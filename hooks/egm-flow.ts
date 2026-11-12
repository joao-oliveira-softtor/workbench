// I/O da revisão EGM comandada pelo mod (como qa-flow.ts): arquivos, agentes e os átomos `egmJob`, `egmAgents` e
// `planFlow`. As decisões são do egm.ts (puro). Só o timer (sob a trava `isEgmStepping` do register) escreve `egmJob`; o
// `turn.complete` só grava o arquivo da resposta, e o `egm stop` só zera o trabalho.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import {
  EGM_BUSY_TEXT,
  EGM_FIXER,
  EGM_WAIT_TEXT,
  PERSONAS,
  egmFixerSpecOf,
  exitDecisionOf,
  fixOf,
  fixPromptOf,
  newestVersionOf,
  noticeOf,
  outcomeOf,
  parseFix,
  parseReview,
  planEndTextOf,
  planFixPromptOf,
  reasonOf,
  reportOf,
  reportOkOf,
  reviewPromptOf,
  roundOf,
} from './egm'
import type { EgmJob, EgmSlot, Finding, Fix, Outcome, Reason, Review, RoundStep } from './egm'
import { settle } from './model'
import { PLAN_START, docOf, reportPathOf, typedIntentOf } from './plan'
import type { PlanFlow } from './plan'
import { AGENT_TIMEOUT_MS, agentStepOf, hashOf, hookCommandOf, runIdOf } from './qa'
import { exists, homeOf, isNodeReady, mkdirs, readText, run, spawnAgent } from './qa-flow'
import { planfixerStateTextOf } from './qa-guard'
import { ENDED } from './stale'
import type { Listed } from './stale'

// Os três átomos também estão no register.tsx (o validate só lê os declarados no próprio arquivo).
// Etapa do botão EGM e o doc revisado. Não zera no session.start: ele roda também a cada recarga do mod.
const planFlow = atom({ plugin: 'workbench', key: 'planFlow' } as const, PLAN_START)
// O trabalho em curso; não zera no session.start (a recarga continua de onde parou).
const egmJob = atom({ plugin: 'workbench', key: 'egmJob' } as const, null)
// Os agentes lançados pelo EGM (os mais recentes): o aviso de fim deles sai da conversa e nenhum é adotado de novo.
const egmAgents = atom({ plugin: 'workbench', key: 'egmAgents' } as const, [])
// Revisão no plan mode (também no register.tsx): armada pelo pedido do Planejar, o GO que libera a saída, o doc que o
// gancho deixa para o tique e o texto a mandar à conversa. Nenhum zera no session.start (a revisão segue depois da recarga).
const planArmed = atom({ plugin: 'workbench', key: 'planArmed' } as const, false)
const planGo = atom({ plugin: 'workbench', key: 'planGo' } as const, null)
const planQueuedDoc = atom({ plugin: 'workbench', key: 'planQueuedDoc' } as const, null)
const egmOutbox = atom({ plugin: 'workbench', key: 'egmOutbox' } as const, null)

// `home` é o caminho real (a trava compara caminhos reais); `isFixerReady`: o tipo do corretor foi registrado com a trava.
export type EgmEnv = { home: string; guardFile: string; isFixerReady: boolean }
type Round = EgmJob['round']

const MAX_AGENTS = 200
const FIXER = 'fixer'
const INCOMPLETE_TEXT = 'revisão incompleta'
const PERSONA_NAMES: string[] = PERSONAS.map(p => p.persona)

export const egmRootOf = (home: string): string => `${home}/.claude/workbench-egm`
const roundDirOf = (dir: string, round: number): string => `${dir}/r${round}`
const answerPathOf = (dir: string, round: number, name: string): string => `${roundDirOf(dir, round)}/${name === FIXER ? 'correcao' : name}.md`

// AAAAMMDD-HHMMSS: com segundos, duas revisões no mesmo minuto não dividem a pasta (a segunda leria as respostas da primeira).
const stampOf = (now: number): string => `${runIdOf(now)}${String(new Date(now).getSeconds()).padStart(2, '0')}`

async function realOf($: EngineInterface, path: string): Promise<string> {
  return (await run($, ['realpath', '--', path]))?.trim() || path
}

// Sem o ambiente registrado (registro que falhou), o arquivo da trava ainda se monta; sem HOME, null.
async function guardFileOf($: EngineInterface, tokenOf: () => Promise<string>): Promise<string | null> {
  const found = await homeOf($)
  return found === undefined ? null : `${egmRootOf(await realOf($, found))}/guard-${await tokenOf()}.json`
}

// Registra o corretor (tipo travado). Sem HOME: null, e o clique avisa no passo 4.
export async function registerEgm($: EngineInterface, tokenOf: () => Promise<string>, modRoot: string): Promise<EgmEnv | null> {
  const found = await homeOf($)
  if (found === undefined) return null
  const home = await realOf($, found)
  const guardFile = `${egmRootOf(home)}/guard-${await tokenOf()}.json`
  const hook = hookCommandOf(modRoot, 'planfixer', guardFile)
  const isFixerReady = hook !== null && (await settle(() => $.agent.register(egmFixerSpecOf(hook)))).ok
  return { home, guardFile, isFixerReady }
}

// A versão mais nova do plugin EGM instalada pelo marketplace.
export async function pluginRootOf($: EngineInterface, home: string): Promise<string | null> {
  const base = `${home}/.claude/plugins/cache/egm/egm`
  const listed = await settle(() => $.fs.list(base))
  const version = listed.ok ? newestVersionOf(listed.value.filter(e => e.kind === 'dir').map(e => e.name)) : null
  return version === null ? null : `${base}/${version}`
}

// Só os agentes que este mod lançou: um `egm:egm-*` lançado pela conversa nunca é adotado.
async function ownAgentsOf($: EngineInterface): Promise<Listed[] | null> {
  const listed = await settle(() => $.agent.list())
  return listed.ok ? listed.value.filter(a => a.spawnedBy === $.plugin.name).map(a => ({ id: a.id, type: a.type, status: a.status })) : null
}

async function addAgent($: EngineInterface, id: string): Promise<void> {
  await update($, egmAgents, ids => [...ids.filter(x => x !== id), id].slice(-MAX_AGENTS))
}

// Muda o trabalho só se ainda é o mesmo (um `egm stop` no meio do passo não é desfeito).
async function setJob($: EngineInterface, dir: string, change: (job: EgmJob) => EgmJob | null): Promise<boolean> {
  const after = await update($, egmJob, cur => (cur !== null && cur.dir === dir ? change(cur) : cur))
  return after?.dir === dir
}

// ---- Clique em "EGM: Revisão" ----

// O motivo da recusa (toast) ou null quando o trabalho começou. Roda sob a trava do timer.
export async function startReview($: EngineInterface, env: EgmEnv | null): Promise<string | null> {
  const typed = await typedDocOf($)
  if (typed.kind === 'refused') return typed.text
  if (env === null) return 'EGM: não achei a pasta do usuário (HOME)'
  const doc = await docPathOf($, typed.path, env.home)
  if (doc === null) return `EGM: não consegui ler o arquivo ${typed.path}`
  if (!env.isFixerReady || !(await isNodeReady($))) return 'EGM: o corretor não pode rodar aqui (precisa do Node 22.6 ou mais novo)'
  const refused = await createJob($, env, doc, 'button', typed.path)
  if (refused === null) await $.prompt.fill({ text: '' })
  return refused
}

// Passos 1 a 3: nenhum trabalho nem corretor antigo vivo (a lista que falha também recusa), e o caminho do campo.
async function typedDocOf($: EngineInterface): Promise<{ kind: 'ok'; path: string } | { kind: 'refused'; text: string }> {
  const refused = (text: string) => ({ kind: 'refused' as const, text })
  if ((await read($, egmJob)) !== null) return refused('EGM: revisão em andamento (use /workbench egm stop)')
  const listed = await ownAgentsOf($)
  if (listed === null || listed.some(a => a.type === EGM_FIXER && !ENDED.has(a.status))) return refused('EGM: o corretor da revisão anterior ainda está rodando; espere ele terminar')
  const path = docOf(typedIntentOf((await $.prompt.read()).text) ?? '')
  return path === '' ? refused('EGM: escreva o caminho do plano no campo e clique em Revisão') : { kind: 'ok', path }
}

// Passos 5, 6 e 8 com o caminho já resolvido (`shown` é o que o aviso mostra); o motivo da recusa ou null.
async function createJob($: EngineInterface, env: EgmEnv, doc: string, origin: EgmJob['origin'], shown: string): Promise<string | null> {
  const text = await readText($, doc)
  if (text === null) return `EGM: não consegui ler o arquivo ${shown}`
  if ((await pluginRootOf($, env.home)) === null) return 'EGM: plugin egm não encontrado (claude plugin enable egm@egm)'
  const dir = `${egmRootOf(env.home)}/${stampOf(await $.clock.now())}`
  if (!(await mkdirs($, dir))) return 'EGM: não consegui criar a pasta da revisão'
  const job: EgmJob = { doc, dir, round: 1, phase: 'review', mark: hashOf(text), slots: [], todo: [...PERSONA_NAMES], origin, ask: null }
  await update($, egmJob, () => job)
  return null
}

// ---- ExitPlanMode no plan mode ----

// Os fatos do gancho (I/O) e a decisão pura; devolve o motivo da recusa ou null (a saída passa).
export async function holdExit($: EngineInterface, env: EgmEnv | null, planFilePath: string): Promise<string | null> {
  const doc = await realOf($, planFilePath)
  const job = await read($, egmJob)
  const decision = exitDecisionOf({ isArmed: await read($, planArmed), isReady: await isReadyOf($, env, doc), isGoOk: await isGoOkOf($, doc), jobOrigin: job?.origin ?? null })
  switch (decision) {
    case 'pass':
      return null
    case 'pass-go':
      await update($, planArmed, () => false)
      await update($, planGo, () => null)
      return null
    case 'wait':
      return EGM_WAIT_TEXT
    case 'busy':
      return EGM_BUSY_TEXT
    case 'start':
      await update($, planQueuedDoc, () => doc)
      return EGM_WAIT_TEXT
    default:
      throw new Error('Caso não tratado: ' + String(decision satisfies never))
  }
}

// Ambiente registrado, plano dentro de ~/.claude/plans (caminho real) e plugin EGM instalado.
async function isReadyOf($: EngineInterface, env: EgmEnv | null, doc: string): Promise<boolean> {
  return env !== null && doc.startsWith(`${env.home}/.claude/plans/`) && (await pluginRootOf($, env.home)) !== null
}

// O GO guardado vale para este doc com o texto de agora (a mesma conferência do "EGM: Executar").
async function isGoOkOf($: EngineInterface, doc: string): Promise<boolean> {
  const go = await read($, planGo)
  const docText = go === null || go.doc !== doc ? null : await readText($, doc)
  return go !== null && docText !== null && reportOkOf(await readText($, go.report), doc, hashOf(docText))
}

// Sob a trava do tique: o doc que o gancho deixou vira trabalho, se ninguém começou outro no meio.
async function startPlanReview($: EngineInterface, env: EgmEnv, doc: string): Promise<null> {
  await update($, planQueuedDoc, () => null)
  if ((await read($, egmJob)) !== null) return send($, EGM_BUSY_TEXT, 'end')
  const refused = await createJob($, env, doc, 'planmode', doc)
  return refused === null ? null : send($, `${refused}. Chame ExitPlanMode de novo.`, 'end')
}

async function send($: EngineInterface, text: string, kind: 'ask' | 'end'): Promise<null> {
  await update($, egmOutbox, () => ({ text, kind }))
  return null
}

// Sob a trava: tira o texto da caixa de saída e, no pedido de correção, marca o envio (o tique seguinte não reenvia).
export async function takeOutbox($: EngineInterface): Promise<{ text: string; kind: 'ask' | 'end'; dir: string } | null> {
  const box = await read($, egmOutbox)
  if (box === null) return null
  await update($, egmOutbox, () => null)
  const job = await read($, egmJob)
  if (box.kind === 'ask' && job !== null) await setJob($, job.dir, cur => ({ ...cur, ask: cur.ask === null ? null : { ...cur.ask, isSent: true } }))
  return { ...box, dir: job?.dir ?? '' }
}

// Sob a trava: o turno que começou com o pedido de correção enviado é o que responde a ele.
export async function markAskTurn($: EngineInterface, turnId: string): Promise<void> {
  const job = await read($, egmJob)
  if (job === null || job.phase !== 'fix' || job.ask?.isSent !== true || job.ask.turnId !== null) return
  await setJob($, job.dir, cur => ({ ...cur, ask: cur.ask === null ? null : { ...cur.ask, turnId } }))
}

// Absoluto (`~/` é o HOME, relativo vem da pasta da sessão) e real; null quando o arquivo não existe.
async function docPathOf($: EngineInterface, typed: string, home: string): Promise<string | null> {
  const abs = typed.startsWith('~/') ? `${home}${typed.slice(1)}` : typed.startsWith('/') ? typed : `${await $.session.cwd()}/${typed}`
  return (await exists($, abs)) ? realOf($, abs) : null
}

// ---- Passo do timer ----

// Um passo; devolve o aviso a gravar (fim do trabalho) ou null.
// `dropped`: a pasta do trabalho cujo pedido de correção o envio recusou.
export async function stepEgm($: EngineInterface, env: EgmEnv, dropped: string | null = null): Promise<string | null> {
  const queued = await read($, planQueuedDoc)
  if (queued !== null) return startPlanReview($, env, queued)
  const job = await read($, egmJob)
  if (job === null) return null
  switch (job.phase) {
    case 'review':
      return stepReview($, env, job)
    case 'fix':
      return job.origin === 'planmode' ? stepPlanFix($, env, job, dropped) : stepFix($, env, job)
    default:
      throw new Error('Caso não tratado: ' + String(job.phase satisfies never))
  }
}

// Revisor sem arquivo de resposta: espera, adota o lançado sem id, ou encerra (tenta a última mensagem do agente; o revisor
// sem texto fica `revisão incompleta`, o corretor sem texto fica sem arquivo, que o `parseFix` lê como sem resposta).
async function pollSlot($: EngineInterface, env: EgmEnv, job: EgmJob, slot: EgmSlot, listed: Listed[] | null, now: number, known: readonly string[]): Promise<EgmSlot> {
  const path = answerPathOf(job.dir, job.round, slot.name)
  if (slot.hasAnswer || (await exists($, path))) return { ...slot, hasAnswer: true }
  const timeoutMs = slot.name === FIXER ? null : AGENT_TIMEOUT_MS
  const step = agentStepOf({ timeoutMs, agentId: slot.agentId, at: slot.at, isEnded: false }, slot.type, listed, now, known)
  switch (step.step) {
    case 'wait':
      return slot
    case 'adopt':
      await bindAgent($, env, job, slot.name, step.agentId)
      return { ...slot, agentId: step.agentId }
    case 'ended':
      return endSlot($, slot, path)
    default:
      throw new Error('Caso não tratado: ' + String(step satisfies never))
  }
}

async function endSlot($: EngineInterface, slot: EgmSlot, path: string): Promise<EgmSlot> {
  const recovered = slot.agentId === null ? null : await recoverAnswer($, slot.agentId)
  const text = recovered ?? (slot.name === FIXER ? null : INCOMPLETE_TEXT)
  if (text !== null) await settle(() => $.fs.write(path, text))
  return { ...slot, hasAnswer: true }
}

// A última mensagem do agente com texto, quando o `turn.complete` não a trouxe (recarga no meio, resposta vazia).
export async function recoverAnswer($: EngineInterface, agentId: string): Promise<string | null> {
  const got = await settle(() => $.session.messages({ agentId }))
  if (!got.ok || !Array.isArray(got.value)) return null
  return got.value.filter(m => m.role === 'assistant' && m.text.trim() !== '').at(-1)?.text ?? null
}

async function pollSlots($: EngineInterface, env: EgmEnv, job: EgmJob): Promise<EgmSlot[]> {
  const listed = await ownAgentsOf($)
  const now = await $.clock.now()
  const known = await read($, egmAgents)
  const slots: EgmSlot[] = []
  for (const slot of job.slots) slots.push(await pollSlot($, env, job, slot, listed, now, known))
  return slots
}

async function stepReview($: EngineInterface, env: EgmEnv, before: EgmJob): Promise<string | null> {
  const slots = await pollSlots($, env, before)
  if (!(await setJob($, before.dir, cur => ({ ...cur, slots })))) return null
  const job = { ...before, slots }
  const [next, ...rest] = job.todo
  if (next !== undefined) return launchReviewer($, env, job, next, rest)
  if (!slots.every(s => s.hasAnswer)) return null
  const reviews = await reviewsOf($, job.dir, job.round, slots.map(s => s.name))
  const docText = await readText($, job.doc)
  return applyStep($, env, job, roundOf({ round: job.round, reviews, isDocChanged: docText === null || hashOf(docText) !== job.mark }), docText)
}

// O slot entra antes do lançamento (uma recarga no meio cai na adoção); `{ deny }` é NO-GO na hora.
async function launchReviewer($: EngineInterface, env: EgmEnv, job: EgmJob, name: string, rest: string[]): Promise<string | null> {
  const persona = PERSONAS.find(p => p.persona === name)
  const prompt = persona === undefined ? null : await reviewPromptFor($, env, job, persona)
  if (persona === undefined || prompt === null) return finishEgm($, env, job, 'NO-GO', reasonOf('M6', `${name}: não consegui ler a persona, o padrão ou o plano`))
  const slot: EgmSlot = { name, type: persona.subagentType, agentId: null, at: await $.clock.now(), hasAnswer: false }
  if (!(await setJob($, job.dir, cur => ({ ...cur, slots: [...cur.slots, slot], todo: rest })))) return null
  const spawned = await spawnAgent($, persona.subagentType, prompt, `EGM: ${name} r${job.round}`)
  if ('deny' in spawned) return finishEgm($, env, job, 'NO-GO', reasonOf('M6', `${name}: ${spawned.deny}`))
  if (spawned.agentId !== null) await bindAgent($, env, job, name, spawned.agentId)
  return null
}

// O id do agente de um slot, venha do lançamento ou da adoção: entra em `egmAgents`, no slot e, no corretor, na trava.
// Um caminho só para os dois casos: o harness de teste descarta o id que o lançamento devolve, então só a adoção o exercita.
async function bindAgent($: EngineInterface, env: EgmEnv, job: EgmJob, name: string, id: string): Promise<void> {
  await addAgent($, id)
  await setJob($, job.dir, cur => ({ ...cur, slots: cur.slots.map(s => (s.name === name ? { ...s, agentId: id } : s)) }))
  if (name === FIXER) await guardFixer($, env, job, id)
}

// O revisor não lê fora da pasta da sessão: persona, padrão, plano e a rodada anterior vão no pedido.
async function reviewPromptFor($: EngineInterface, env: EgmEnv, job: EgmJob, persona: (typeof PERSONAS)[number]): Promise<string | null> {
  const texts = await personaTextsOf($, env, persona)
  const docText = await readText($, job.doc)
  if (texts === null || docText === null) return null
  const { personaText, standardText } = texts
  const prev = job.round === 1 ? null : roundDirOf(job.dir, job.round - 1)
  const prevAnswer = prev === null ? null : await readText($, `${prev}/${persona.persona}.md`)
  const prevFix = prev === null ? null : await readText($, `${prev}/correcao.md`)
  return reviewPromptOf({ persona: persona.persona, doc: job.doc, docText, personaText, standardText, dir: job.dir, round: job.round, prevAnswer, prevFix })
}

async function personaTextsOf($: EngineInterface, env: EgmEnv, persona: (typeof PERSONAS)[number]): Promise<{ personaText: string; standardText: string | null } | null> {
  const root = await pluginRootOf($, env.home)
  const personaText = root === null ? null : await readText($, `${root}/agents/${persona.file}`)
  if (root === null || personaText === null) return null
  if (persona.standard === null) return { personaText, standardText: null }
  const standardText = await readText($, `${root}/resources/document_standards/${persona.standard}`)
  return standardText === null ? null : { personaText, standardText }
}

// As respostas de uma rodada, lidas dos arquivos (a fonte). Com `names`, quem rodou e falta o arquivo conta como incompleto;
// sem, entra só quem tem arquivo.
async function reviewsOf($: EngineInterface, dir: string, round: number, names: readonly string[] | null): Promise<Record<string, Review>> {
  const reviews: Record<string, Review> = {}
  for (const name of names ?? PERSONA_NAMES) {
    const text = await readText($, answerPathOf(dir, round, name))
    if (text !== null) reviews[name] = parseReview(name, text)
    else if (names !== null) reviews[name] = { kind: 'incomplete' }
  }
  return reviews
}

const askedOf = (reviews: Record<string, Review>): Finding[] =>
  Object.values(reviews)
    .flatMap(r => (r.kind === 'ok' ? r.findings : []))
    .filter(f => f.severity !== 'Nit')

async function applyStep($: EngineInterface, env: EgmEnv, job: EgmJob, step: RoundStep, docText: string | null): Promise<string | null> {
  if (docText === null) return finishEgm($, env, job, 'NO-GO', reasonOf('M1'))
  switch (step.next) {
    case 'go':
      return finishEgm($, env, job, 'GO', null)
    case 'nogo':
      return finishEgm($, env, job, 'NO-GO', step.reason)
    case 'fix':
      return startFix($, env, job, step.findings, docText)
    case 'round': {
      const round = (job.round + 1) as Round
      await setJob($, job.dir, cur => ({ ...cur, round, phase: 'review', mark: hashOf(docText), slots: [], todo: step.todo }))
      return null
    }
    default:
      throw new Error('Caso não tratado: ' + String(step satisfies never))
  }
}

// ---- Fase fix ----

async function guardTextOf($: EngineInterface, job: EgmJob, agentId: string | null): Promise<string> {
  return planfixerStateTextOf({ agentId, doc: job.doc, dir: job.dir, cwd: await realOf($, await $.session.cwd()) })
}

// A trava com o id do corretor; se o trabalho parou no meio, ela volta a `{}`.
async function guardFixer($: EngineInterface, env: EgmEnv, job: EgmJob, id: string): Promise<void> {
  await settle(async () => $.fs.write(env.guardFile, await guardTextOf($, job, id)))
  if ((await read($, egmJob))?.dir !== job.dir) await settle(() => $.fs.write(env.guardFile, '{}'))
}

async function startFix($: EngineInterface, env: EgmEnv, job: EgmJob, findings: Finding[], docText: string): Promise<string | null> {
  const before = await settle(() => $.fs.write(`${roundDirOf(job.dir, job.round)}/doc-antes.md`, docText))
  if (job.origin === 'planmode') return before.ok ? askFix($, job, findings) : finishEgm($, env, job, 'NO-GO', reasonOf('M7'))
  const guard = before.ok ? await settle(async () => $.fs.write(env.guardFile, await guardTextOf($, job, null))) : before
  if (!guard.ok) return finishEgm($, env, job, 'NO-GO', reasonOf('M7'))
  const slot: EgmSlot = { name: FIXER, type: EGM_FIXER, agentId: null, at: await $.clock.now(), hasAnswer: false }
  if (!(await setJob($, job.dir, cur => ({ ...cur, phase: 'fix', slots: [slot], todo: [] })))) {
    await settle(() => $.fs.write(env.guardFile, '{}'))
    return null
  }
  const spawned = await spawnAgent($, EGM_FIXER, fixPromptOf(job.doc, findings, job.dir, job.round), `EGM: corretor r${job.round}`)
  if ('deny' in spawned) return finishEgm($, env, job, 'NO-GO', reasonOf('M6', `corretor: ${spawned.deny}`))
  if (spawned.agentId !== null) await bindAgent($, env, job, FIXER, spawned.agentId)
  return null
}

// Plan mode: quem corrige é a conversa (o corretor do mod herda o aviso de plan mode e não edita); o pedido sai pela caixa.
async function askFix($: EngineInterface, job: EgmJob, findings: Finding[]): Promise<null> {
  if (!(await setJob($, job.dir, cur => ({ ...cur, phase: 'fix', slots: [], todo: [], ask: { isSent: false, turnId: null } })))) return null
  return send($, planFixPromptOf(job.doc, findings, job.round), 'ask')
}

// Plan mode: espera a resposta do turno do pedido (o turn.complete grava `correcao.md`); sem prazo, o egm stop encerra.
async function stepPlanFix($: EngineInterface, env: EgmEnv, job: EgmJob, dropped: string | null): Promise<string | null> {
  if (dropped === job.dir) return finishEgm($, env, job, 'NO-GO', { code: 'M7', text: 'não consegui mandar o pedido de correção à conversa' })
  return (await exists($, answerPathOf(job.dir, job.round, FIXER))) ? decideFix($, env, job) : null
}

async function stepFix($: EngineInterface, env: EgmEnv, job: EgmJob): Promise<string | null> {
  const [before] = job.slots
  if (before === undefined) return finishEgm($, env, job, 'NO-GO', reasonOf('M4'))
  const [slot = before] = await pollSlots($, env, job)
  if (!(await setJob($, job.dir, cur => ({ ...cur, slots: [slot] })))) return null
  if (!slot.hasAnswer) return null
  await settle(() => $.fs.write(env.guardFile, '{}'))
  return decideFix($, env, job)
}

async function decideFix($: EngineInterface, env: EgmEnv, job: EgmJob): Promise<string | null> {
  const docText = await readText($, job.doc)
  const reviews = await reviewsOf($, job.dir, job.round, null)
  const fix = parseFix(await readText($, answerPathOf(job.dir, job.round, FIXER)), askedOf(reviews))
  // Aqui `isDocChanged` true é o esperado (o corretor mudou o plano); a leitura que falha vira M1 no applyStep.
  const step = fixOf({ round: job.round, reviews, fix, isDocChanged: docText !== null && hashOf(docText) !== job.mark })
  return applyStep($, env, job, step, docText)
}

// ---- Fim ----

// Relê o doc (a marca do relatório é a de agora, depois da última correção), grava o relatório, zera o trabalho e a trava.
async function finishEgm($: EngineInterface, env: EgmEnv, job: EgmJob, verdict: 'GO' | 'NO-GO', reason: Reason | null): Promise<string | null> {
  if ((await read($, egmJob))?.dir !== job.dir) return null
  const docText = await readText($, job.doc)
  const rounds = await roundsOf($, job)
  const isRead = docText !== null
  const outcome = outcomeOf({ doc: job.doc, mark: isRead ? hashOf(docText) : '', verdict: isRead ? verdict : 'NO-GO', reason: isRead ? reason : reasonOf('M1'), rounds })
  const report = `${job.dir}/veredito.md`
  const wrote = await settle(() => $.fs.write(report, reportOf(outcome)))
  await setJob($, job.dir, () => null)
  await settle(() => $.fs.write(env.guardFile, '{}'))
  const saved = wrote.ok ? outcome : null
  return job.origin === 'planmode' ? endPlan($, job, saved, report) : endButton($, job, saved, report)
}

// Botão: o GO leva a etapa a Executar com o relatório.
async function endButton($: EngineInterface, job: EgmJob, outcome: Outcome | null, report: string): Promise<string> {
  if (outcome === null) return `EGM: não consegui gravar o relatório em ${report}; clique em Revisão de novo`
  if (outcome.verdict === 'GO') await update($, planFlow, () => ({ step: 'execute', doc: job.doc, report }))
  return noticeOf(outcome, report)
}

// Plan mode: o botão EGM não muda; o GO libera o próximo ExitPlanMode e a mesma mensagem vai à conversa e ao usuário.
async function endPlan($: EngineInterface, job: EgmJob, outcome: Outcome | null, report: string): Promise<string> {
  if (outcome?.verdict === 'GO') await update($, planGo, () => ({ doc: job.doc, report }))
  const text = planEndTextOf(outcome, job.dir)
  await send($, text, 'end')
  return text
}

async function roundsOf($: EngineInterface, job: EgmJob): Promise<{ reviews: Record<string, Review>; fix: Fix | null }[]> {
  const rounds: { reviews: Record<string, Review>; fix: Fix | null }[] = []
  for (let n = 1; n <= job.round; n++) {
    const reviews = await reviewsOf($, job.dir, n, null)
    const fixText = await readText($, answerPathOf(job.dir, n, FIXER))
    rounds.push({ reviews, fix: fixText === null ? null : parseFix(fixText, askedOf(reviews)) })
  }
  return rounds
}

// ---- Fora do timer ----

// `turn.complete` de um agente do trabalho: só grava a resposta; o tique a vê no disco.
export async function saveAnswer($: EngineInterface, agentId: string, answer: string): Promise<void> {
  const job = await read($, egmJob)
  const slot = job?.slots.find(s => s.agentId === agentId)
  if (job === null || slot === undefined || answer.trim() === '') return
  await $.fs.write(answerPathOf(job.dir, job.round, slot.name), answer)
}

// `turn.complete` do loop principal: a resposta ao pedido de correção do plan mode vira `correcao.md` (sem a trava, como
// o saveAnswer). `pending`: o id que o turn.start guardou e o tique ainda não aplicou. Turno interrompido: incompleta (M5).
export async function saveMainAnswer($: EngineInterface, e: { turnId: string; answer: string; reason: string }, pending: string | null): Promise<void> {
  const job = await read($, egmJob)
  if (job?.origin !== 'planmode' || job.phase !== 'fix' || job.ask === null) return
  if (e.turnId !== job.ask.turnId && e.turnId !== pending) return
  const text = e.reason !== 'answer' || e.answer.trim() === '' ? INCOMPLETE_TEXT : e.answer
  await $.fs.write(answerPathOf(job.dir, job.round, FIXER), text)
}

// Desarma o plan mode antes de olhar o trabalho: um plano abandonado sem revisão também deixa de segurar a saída.
export async function stopEgm($: EngineInterface, env: EgmEnv | null, tokenOf: () => Promise<string>): Promise<string> {
  await update($, planArmed, () => false)
  await update($, planGo, () => null)
  await update($, egmOutbox, () => null)
  await update($, planQueuedDoc, () => null)
  const job = await read($, egmJob)
  if (job === null) return 'EGM: nenhuma revisão em andamento; a saída do plan mode não é mais segurada.'
  await update($, egmJob, () => null)
  const guardFile = env === null ? await guardFileOf($, tokenOf) : env.guardFile
  if (guardFile !== null) await settle(() => $.fs.write(guardFile, '{}'))
  return `EGM: revisão parada. O plano fica como está; as respostas já recebidas estão em ${job.dir}.`
}

// "EGM: Executar" com relatório do workbench: ele diz GO, para este doc, com a marca de agora.
export async function executeOkOf($: EngineInterface, flow: PlanFlow): Promise<boolean> {
  const docText = await readText($, flow.doc)
  return docText !== null && reportOkOf(await readText($, reportPathOf(flow)), flow.doc, hashOf(docText))
}
