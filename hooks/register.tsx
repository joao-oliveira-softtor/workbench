import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Row, Snapshot, StaleReport } from '../types'
import { askAnalysis, askHaiku, askRefine, askRoute, collect, measureSizes, repoRoot, unsizedPaths } from './collect'
import {
  buttonLabel,
  clickAction,
  hasTurnIntervened,
  instructionsOf,
  parseAnalysis,
  resumePromptOf,
  shouldStart,
  tokensLabel,
  transcriptOf,
} from './compact'
import type { Analysis, Phase, Step } from './compact'
import {
  EGM_COMMANDS,
  PLAN_LABELS,
  PLAN_START,
  executePromptOf,
  fillTextOf,
  parseRefine,
  planAfter,
  planPromptOf,
  refineInputOf,
  typedIntentOf,
} from './plan'
import type { PlanStep, Refined } from './plan'
import {
  QA_AUTH_TOOL,
  QA_FIXER,
  QA_OBSERVER,
  QA_RUNNER,
  QA_START,
  QA_TYPE,
  agentStepOf,
  cellDirOf,
  guardStateTextOf,
  handbackAgentOf,
  nextRunOf,
  qaLabelOf,
  qaLoginPromptOf,
  qaPlanPromptOf,
  runDirOf,
  runDonePromptOf,
  runIdOf,
  sessionOf,
  spawnPromptOf,
  toolsDirOf,
  wrapperOf,
} from './qa'
import type { QaCurrent, QaFlow, QaStep, SpawnInput } from './qa'
import { finalVerdictOf } from './qa-evidence'
import type { Cell, Matrix } from './qa-evidence'
import {
  authReplyOf,
  cellVerdictOf,
  closeSession,
  guardCtxOf,
  loadMatrix,
  matrixPathOf,
  mkdirs,
  pendingCellsOf,
  prepareSession,
  qaEnvOf,
  registerQa,
  reportPathOf,
  runBaseOf,
  runGateOf,
  spawnQa,
  writeReport,
  writeScripts,
} from './qa-flow'
import type { QaEnv } from './qa-flow'
import { bandOf, fetchAgeLabel, freedKb, handoffTable, idleDays, isFetchStale, lineOf, pushLabel, settle, sizeLabel, sortRows, summaryOf } from './model'
import { DELEGATE_CONTEXT, formatRoute, isUserOrigin, parseRoute, shouldDelegate, tierOf } from './route'
import {
  ABORT_BACKOFF_MS,
  ARM_MS,
  MAX_REMOVAL_LINES,
  REMOVER_AGENT,
  REMOVER_PROMPT,
  actionableOf,
  batchesOf,
  buildPrompt,
  buildReport,
  candidateHash,
  candidatesOf,
  commandsOf,
  isStored,
  keyOf,
  knownFromReport,
  knownFromVerdicts,
  labelOf,
  listOf,
  mergeKnown,
  parseVerdicts,
  persistOf,
  removalCheckOf,
  removalLinesOf,
  removalPromptOf,
  removalStepOf,
  shouldAutoSuggest,
  splitCandidates,
} from './stale'
import type { Failure, Judged, Known, Listed, Stored } from './stale'

const PANE = 'workbench'
const REFRESH_MS = 5 * 60 * 1000
// Quanto o pedido de sugestão espera na fila até o timer do session.start pegá-lo.
const SUGGEST_POLL_MS = 3000
// Comandos que mudam o que o painel mostra: depois deles o snapshot é refeito.
const CHANGES = /\bgit\s+(push|commit|merge|worktree|switch|checkout|branch|fetch|pull)\b|\bgh\s+pr\b/
// Estes mudam as PRs: a lista do gh guardada deixa de valer.
const CHANGES_PRS = /\bgh\s+pr\b|\bgit\s+push\b/

const snapshot = atom({ plugin: 'workbench', key: 'snapshot' } as const, null)
const busy = atom({ plugin: 'workbench', key: 'busy' } as const, false)
const selected = atom({ plugin: 'workbench', key: 'selected' } as const, null)
const stale = atom({ plugin: 'workbench', key: 'stale' } as const, null)
const suggesting = atom({ plugin: 'workbench', key: 'suggesting' } as const, false)
const armed = atom({ plugin: 'workbench', key: 'armed' } as const, null)
const removal = atom({ plugin: 'workbench', key: 'removal' } as const, null)
const compacting = atom({ plugin: 'workbench', key: 'compacting' } as const, null)
// Etapa do botão EGM e o doc revisado. Não zera no session.start: ele roda também a cada recarga do mod.
const planFlow = atom({ plugin: 'workbench', key: 'planFlow' } as const, PLAN_START)
const refining = atom({ plugin: 'workbench', key: 'refining' } as const, false)
// QA: nenhum destes zera no session.start (é o que permite retomar e o que mantém suprimidos os agentes já lançados).
const qaFlow = atom({ plugin: 'workbench', key: 'qaFlow' } as const, QA_START)
const qaJob = atom({ plugin: 'workbench', key: 'qaJob' } as const, null)
const qaGuarded = atom({ plugin: 'workbench', key: 'qaGuarded' } as const, [])
const qaRunBase = atom({ plugin: 'workbench', key: 'qaRunBase' } as const, null)
// Tentativas de refazer a coleta antes de a remoção abortar (um refresh em voo faz o launchRemoval voltar cedo).
const MAX_TRIES = 3

// Variáveis do módulo zeram num reload, de propósito: nenhuma delas é estado que precise sobreviver
// (`removal` e `armed` ficam em $.state justamente para a trava sobreviver ao reload).
let removeQueued: { key: string; tries: number } | null = null
let pending: { root: string; isForced: boolean } | null = null
let isRunning = false
let again: { force: boolean } | null = null
let inFlight = false
let isSizing = false
let abortedUntil = 0
// "Compactar e continuar": a trava é `compactPhase` (variável do módulo, como o `inFlight`); `compacting` em $.state é só
// o rótulo do botão. `isMainTurn` e `mainTurns` dizem se o loop principal roda e quantos turnos já começaram (a fork da
// compactação tem agentId e não conta).
let compactPhase: Phase = 'idle'
let isMainTurn = false
let mainTurns = 0
// EGM: o clique só enfileira a etapa (o dispatch de um botão pode ser abandonado); o drainPlan faz o trabalho no timer.
let planQueued: PlanStep | null = null
// Planejar (refinamento): a trava é `refinePhase`, como o `compactPhase`; `refining` em $.state é só o rótulo.
let refinePhase: Phase = 'idle'

// Delegação de modelo (/route auto on): lida do `$.store` no session.start e mantida aqui, porque o hook do prompt nunca
// espera o armazenamento. Desligada por padrão.
let isDelegateOn = false

// QA (zeram no session.start): o clique na fila (o trabalho roda no timer), a trava do passo do timer, o pedido pendente
// para a sessão, o ambiente (HOME, raiz, pasta do QA, arquivo da trava) e o motivo de o QA estar desligado.
const QA_OFF = 'QA: esta sessão não está num repositório git (ou falta HOME).'
let qaQueued: QaStep | null = null
let isQaStepping = false
let qaPending: string | null = null
let qaEnv: QaEnv | null = null
let qaBlocked: string | null = QA_OFF

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function storeKey(root: string): string {
  return `stale:${root}`
}

async function readStored($: EngineInterface, root: string): Promise<Stored | null> {
  const raw = await settle(() => $.store.get(storeKey(root)))
  return raw.ok && isStored(raw.value) ? raw.value : null
}

// Conta só o que o `x` de fato copiaria agora (mesma regra, mesmo HEAD, sem submódulo bloqueado).
function removableOf(snap: Snapshot, report: StaleReport | null): number {
  return report === null ? 0 : actionableOf(snap, report.items, snap.at).length
}

// Mostra a limpeza a partir das candidatas ATUAIS pela regra, reaproveitando vereditos do Haiku que ainda valem.
async function afterRefresh($: EngineInterface, snap: Snapshot): Promise<void> {
  const cands = candidatesOf(snap.rows, { now: snap.at, isPrKnown: snap.isPrKnown })
  const hash = candidateHash(cands)
  const stored = await readStored($, snap.root)
  const prev = (await read($, stale)) ?? stored?.report ?? null
  const fromHaiku = prev?.source === 'haiku'
  const report = buildReport({
    cands,
    detached: snap.detachedPrunable,
    known: knownFromReport(prev),
    overflow: new Set(),
    missingReason: 'sem veredito ainda',
    hash,
    at: fromHaiku ? prev.at : snap.at,
    note: fromHaiku ? (prev.hash === hash ? prev.note : `Haiku de ${hhmm(prev.at)} (o conjunto mudou)`) : null,
  })
  await update($, stale, () => report)
  const surfaces = await settle(() => $.session.surfaces())
  const live = splitCandidates(cands).live
  const isDue = shouldAutoSuggest({
    liveCount: live.length,
    hash,
    stored,
    now: snap.at,
    hasSurface: surfaces.ok && surfaces.value.length > 0,
    abortedUntil,
  })
  if (isDue) scheduleSuggest(snap.root, false)
}

async function refresh($: EngineInterface, force = false): Promise<void> {
  if (isRunning) {
    // Um pedido durante o refresh vira UMA repetição depois dele; o `force` do botão r não se perde.
    again = { force: force || (again?.force ?? false) }
    return
  }
  isRunning = true
  try {
    await update($, busy, () => true)
    const snap = await collect($, { force })
    if (snap === null) {
      return
    }
    await update($, snapshot, () => snap)
    // Falha da limpeza sugerida nunca vira erro do painel.
    await settle(() => afterRefresh($, snap))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failed: Snapshot = {
      root: '',
      base: '',
      baseHead: '',
      baseMigration: null,
      rows: [],
      detachedPrunable: [],
      isPrKnown: false,
      fetchedAt: null,
      errors: [message],
      at: await $.clock.now(),
    }
    await update($, snapshot, last => (last === null ? failed : { ...last, errors: [message] }))
  } finally {
    isRunning = false
    await settle(() => update($, busy, () => false))
  }
  const next = again
  again = null
  if (next !== null) await refresh($, next.force)
}

// `$.model.complete` resolve `aborted` quando o dispatch que a fez é abandonado: hooks e botões só deixam o pedido
// na fila, e quem o executa é o timer aberto no session.start (o engine não deixa guardar o `$` num módulo).
function scheduleSuggest(root: string, isForced: boolean): void {
  pending = { root, isForced: isForced || (pending?.root === root && pending.isForced) }
}

async function drainSuggest($: EngineInterface): Promise<void> {
  // Pedido feito com uma consulta em voo fica na fila até ela terminar, em vez de ser descartado.
  if (inFlight) return
  const job = pending
  if (job === null) return
  pending = null
  await suggest($, job.root, job.isForced)
}

function noteOf(o: { failure: Failure; reason: string; fresh: number; isComplete: boolean; now: number }): string {
  if (o.failure !== null) return `Haiku indisponível: ${o.reason}${o.fresh > 0 ? ` (${o.fresh} vereditos novos guardados)` : ''}`
  if (o.isComplete) return `Haiku às ${hhmm(o.now)}`
  return `Haiku às ${hhmm(o.now)}; faltam vereditos, o resto vai na próxima consulta`
}

// Lotes de até 20 (no máximo 5) só com as candidatas sem veredito válido; o que gravar no fim sai de persistOf.
async function suggest($: EngineInterface, root: string, isForced: boolean): Promise<void> {
  if (inFlight) return
  const snap = await read($, snapshot)
  if (snap === null || snap.root !== root) return
  const now = await $.clock.now()
  if (!isForced && now < abortedUntil) return
  const cands = candidatesOf(snap.rows, { now, isPrKnown: snap.isPrKnown })
  const { live } = splitCandidates(cands)
  if (live.length === 0) {
    if (isForced) $.ui.toast('Nenhuma worktree viva candidata à limpeza.')
    return
  }
  inFlight = true
  await update($, suggesting, () => true)
  try {
    const hash = candidateHash(cands)
    const stored = await readStored($, root)
    const prev = (await read($, stale)) ?? stored?.report ?? null
    const before = knownFromReport(prev)
    const { batches, overflow } = batchesOf(live, before, isForced)
    let known: Known = before
    let failure: Failure = null
    let reason = ''
    let fresh = 0
    $.ui.log(`workbench: Haiku chamado, ${batches.reduce((n, b) => n + b.length, 0)} candidatas em ${batches.length} lotes`)
    for (const batch of batches) {
      const { prompt, ids } = buildPrompt(batch, now)
      const asked = await askHaiku($, prompt)
      const verdicts = asked.ok ? parseVerdicts(asked.text, ids) : new Map<string, Judged>()
      if (verdicts.size === 0) {
        failure = !asked.ok && asked.isAborted ? 'aborted' : 'other'
        reason = asked.ok ? 'resposta sem vereditos válidos' : asked.reason
        break
      }
      fresh += verdicts.size
      known = mergeKnown(known, knownFromVerdicts(verdicts, batch))
    }
    const isComplete = live.every(c => known.has(keyOf(c)))
    const plan = persistOf({ isComplete, failure })
    const note = noteOf({ failure, reason, fresh, isComplete, now })
    const report = buildReport({
      cands,
      detached: snap.detachedPrunable,
      known,
      overflow: new Set(overflow.map(c => c.row.path)),
      missingReason: fresh > 0 || failure === null ? 'sem resposta do Haiku' : 'sem veredito ainda',
      hash,
      at: now,
      note,
    })
    if (plan.backoff) abortedUntil = now + ABORT_BACKOFF_MS
    if (plan.store === 'full') await settle(() => $.store.set(storeKey(root), { hash, at: now, report }))
    if (plan.store === 'at') await settle(() => $.store.set(storeKey(root), { hash: stored?.hash ?? '', at: now, report }))
    await update($, stale, () => report)
    const removable = report?.items.filter(item => item.verdict === 'remove' && item.origin === 'haiku').length ?? 0
    if (fresh > 0 && removable > 0) $.ui.toast(`workbench: Haiku sugere remover ${removable} worktrees (/workbench › s)`)
  } finally {
    inFlight = false
    await settle(() => update($, suggesting, () => false))
  }
}

// Mede em segundo plano as worktrees sem medida (ou com a medida vencida) e preenche o snapshot sem refazer a coleta.
async function drainSizes($: EngineInterface): Promise<void> {
  if (isSizing) return
  const snap = await read($, snapshot)
  if (snap === null) return
  const paths = unsizedPaths(snap.rows, await $.clock.now())
  if (paths.length === 0) return
  isSizing = true
  try {
    const sizes = await measureSizes($, paths)
    await update($, snapshot, last =>
      last === null || last.root !== snap.root
        ? last
        : {
            ...last,
            rows: last.rows.map(r => {
              const kb = sizes.get(r.path)
              return kb === undefined ? r : { ...r, ownKb: kb }
            }),
          },
    )
  } finally {
    isSizing = false
  }
}

function commandOf(input: unknown): string | null {
  return typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' ? input.command : null
}

async function agentsOf($: EngineInterface): Promise<Listed[] | null> {
  const listed = await settle(() => $.agent.list())
  return listed.ok ? listed.value.map(a => ({ id: a.id, type: a.type, status: a.status })) : null
}

// O agente é o remover? `whenUnlisted` é a resposta quando ele não está na lista (ou a consulta falhou): o tool.check
// falha fechado (true); o turn.complete não encerra nada por um agente que não conseguiu identificar (false).
async function isListedRemover($: EngineInterface, agentId: string, whenUnlisted: boolean): Promise<boolean> {
  const listed = await agentsOf($)
  const found = listed?.find(a => a.id === agentId)
  return found === undefined ? whenUnlisted : found.type === REMOVER_AGENT
}

function acceptLabel(isRemoving: boolean, isArmed: boolean, count: number): string {
  if (isRemoving) return 'Removendo…'
  if (isArmed) return `Confirmar remoção (${count})`
  return `Aceitar remoções (${count})`
}

// Um clique arma e mostra o que vai rodar; o segundo, em até ARM_MS e com a mesma lista, enfileira. Quem executa é o
// drainRemove (o dispatch de um botão pode ser abandonado, como no scheduleSuggest).
async function pressAccept($: EngineInterface): Promise<void> {
  if ((await read($, removal)) !== null) {
    $.ui.toast('Uma remoção já está em andamento.')
    return
  }
  const snap = await read($, snapshot)
  const report = await read($, stale)
  const plan = snap === null || report === null ? null : removalLinesOf(snap, report.items)
  if (plan === null || plan.lines.length === 0) {
    $.ui.toast('Nenhuma worktree removível pela automação agora (Copiar comandos cobre o resto).')
    return
  }
  if (plan.lines.length > MAX_REMOVAL_LINES) {
    $.ui.toast(`${plan.lines.length} comandos passam do teto de ${MAX_REMOVAL_LINES}: use Copiar comandos.`)
    return
  }
  const key = plan.lines.join('\n')
  const now = await $.clock.now()
  const was = await read($, armed)
  if (was === null || now - was.at > ARM_MS || was.key !== key) {
    await update($, armed, () => ({ at: now, key }))
    const preview = plan.lines.slice(0, 3).map(line => line.slice(0, 90)).join(' | ')
    const left = plan.skipped > 0 ? `; ${plan.skipped} ficam de fora (Copiar comandos)` : ''
    const prune = plan.lines.some(line => line.endsWith('worktree prune')) ? '; prune limpa TODAS as worktrees sem diretório' : ''
    $.ui.toast(`Remover ${plan.count} worktrees${left}${prune}. ${preview}. Aperte de novo em ${ARM_MS / 1000} s.`)
    return
  }
  await update($, armed, () => null)
  removeQueued = { key, tries: 0 }
}

type Launch = { kind: 'started' } | { kind: 'retry' } | { kind: 'abort'; text: string } | { kind: 'unsure'; text: string }

// Recoleta de verdade, confere que a lista é a confirmada, grava a allowlist ANTES do spawn e só então chama o Haiku.
async function launchRemoval($: EngineInterface, job: { key: string }): Promise<Launch> {
  const startedAt = await $.clock.now()
  await refresh($, true)
  const snap = await read($, snapshot)
  const report = await read($, stale)
  if (snap === null || report === null) return { kind: 'abort', text: 'Sem snapshot: nada foi removido.' }
  // O refresh engole falhas e mantém o snapshot velho: só vale uma coleta nova e sem erro (o gh fora do ar também aborta).
  if (snap.errors.length > 0) return { kind: 'abort', text: `Coleta falhou, nada foi removido: ${snap.errors[0]}` }
  if (snap.at < startedAt) return { kind: 'retry' }
  const plan = removalLinesOf(snap, report.items)
  if (plan.lines.length === 0 || plan.lines.join('\n') !== job.key) {
    return { kind: 'abort', text: 'A lista mudou depois da confirmação: confira e aceite de novo.' }
  }
  await update($, removal, cur => (cur === null ? null : { ...cur, allowed: plan.lines }))
  $.ui.toast(`Haiku removendo ${plan.count} worktrees…`)
  const spawned = await settle(() =>
    $.agent.spawn({ subagentType: REMOVER_AGENT, prompt: removalPromptOf(plan.lines), description: 'remover worktrees', cwd: snap.root }),
  )
  // Rejeição ou timeout do spawn não prova que o agente não nasceu: a trava fica e o drainRemove adota ou encerra.
  if (!spawned.ok) return { kind: 'unsure', text: `Remoção sem confirmação do spawn (${spawned.error.slice(0, 80)}); aguardando.` }
  const { deny, agentId } = spawned.value
  if (deny !== undefined) return { kind: 'abort', text: `Remoção recusada: ${deny}` }
  // `agentId` é opcional no tipo; sem ele fica null e o drainRemove o adota pela lista. No-op se a remoção já terminou.
  if (agentId !== undefined) await update($, removal, cur => (cur === null ? null : { ...cur, agentId }))
  return { kind: 'started' }
}

// Idempotente: o turn.complete e o drainRemove podem chegar os dois.
async function finishRemoval($: EngineInterface, answer: string | null): Promise<void> {
  if ((await read($, removal)) === null) return
  await update($, removal, () => null)
  const first = answer?.trim().split('\n')[0] ?? ''
  $.ui.toast(`Remoção encerrada: ${first.slice(0, 160) || 'sem resposta do remover'}`)
  await refresh($, true)
}

async function startRemoval($: EngineInterface, job: { key: string; tries: number }): Promise<void> {
  if ((await read($, removal)) !== null) return
  const now = await $.clock.now()
  // `allowed: []` nega todo Bash de subagente enquanto a recoleta roda e mostra "Removendo…" desde já.
  await update($, removal, () => ({ at: now, agentId: null, allowed: [] }))
  const run = await settle(() => launchRemoval($, job))
  if (!run.ok) {
    // Só zera se a allowlist ainda não foi gravada; depois disso o spawn pode ter nascido.
    const cur = await read($, removal)
    if (cur !== null && cur.allowed.length > 0) {
      $.ui.toast(`Remoção interrompida por erro (${run.error.slice(0, 80)}); aguardando o agente.`)
      return
    }
    await update($, removal, () => null)
    $.ui.toast(`Remoção não iniciou: ${run.error.slice(0, 120)}`)
    return
  }
  const result = run.value
  switch (result.kind) {
    case 'started':
      return
    case 'unsure':
      $.ui.toast(result.text)
      return
    case 'abort':
      await update($, removal, () => null)
      $.ui.toast(result.text)
      return
    case 'retry':
      await update($, removal, () => null)
      if (job.tries + 1 < MAX_TRIES) removeQueued = { key: job.key, tries: job.tries + 1 }
      else $.ui.toast('Coleta em andamento, nada foi removido: aceite de novo.')
      return
    default:
      throw new Error('Caso não tratado: ' + String(result satisfies never))
  }
}

// Roda no timer de 3 s: reconcilia uma remoção em curso (turn.complete que não veio, reload no meio do spawn), expira a
// confirmação vencida e inicia a remoção enfileirada quando não há coleta em voo.
async function drainRemove($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const current = await read($, removal)
  if (current !== null) {
    const next = removalStepOf(current, await agentsOf($), now)
    switch (next.step) {
      case 'wait':
        break
      case 'adopt':
        await update($, removal, cur => (cur === null ? null : { ...cur, agentId: next.agentId }))
        break
      case 'finish':
        await finishRemoval($, null)
        break
      default:
        throw new Error('Caso não tratado: ' + String(next satisfies never))
    }
  }
  const was = await read($, armed)
  if (was !== null && now - was.at > ARM_MS) await update($, armed, () => null)
  if (removeQueued === null) return
  if ((await read($, removal)) !== null) {
    removeQueued = null
    return
  }
  if (isRunning) return
  const job = removeQueued
  removeQueued = null
  await startRemoval($, job)
}

// Lê a fase por função: o TypeScript não vê que outro hook a muda durante os `await` e estreitaria o tipo.
function phaseNow(): Phase {
  return compactPhase
}

async function setStep($: EngineInterface, step: Step): Promise<void> {
  await update($, compacting, () => step)
}

// Um clique enfileira, cancela a fila ou diz que já está rodando. Quem executa é o drainCompact (o dispatch de um botão
// pode ser abandonado, como no scheduleSuggest).
async function pressCompact($: EngineInterface): Promise<void> {
  const click = clickAction(compactPhase)
  switch (click) {
    case 'busy':
      $.ui.toast('Compactação em andamento.')
      return
    case 'cancel':
      compactPhase = 'idle'
      await setStep($, null)
      $.ui.toast('Fila cancelada: nada foi compactado.')
      return
    case 'queue':
      compactPhase = 'queued'
      await setStep($, 'queued')
      if (isMainTurn) $.ui.toast('Compactação na fila: roda quando o turno acabar.')
      return
    default:
      throw new Error('Caso não tratado: ' + String(click satisfies never))
  }
}

// O Sonnet lê o fim da conversa e devolve a análise; qualquer falha vira null e a compactação segue só com os critérios.
async function analyzeSession($: EngineInterface): Promise<Analysis | null> {
  const read = await settle(() => $.session.messages())
  const transcript = read.ok ? transcriptOf(read.value) : ''
  const asked = transcript === '' ? null : await askAnalysis($, transcript)
  const analysis = asked?.ok ? parseAnalysis(asked.text) : null
  if (analysis === null) $.ui.toast('Análise falhou: compactando só com os critérios.')
  else $.ui.log(`workbench: análise da sessão ${JSON.stringify(analysis)}`)
  return analysis
}

// Compacta e retoma. `seen` é o contador de turnos de quando a análise começou: se mudou, o usuário voltou a trabalhar.
async function runCompact($: EngineInterface, analysis: Analysis | null, seen: number): Promise<void> {
  const done = await settle(() => $.session.compact({ instructions: instructionsOf(analysis) }))
  const intervened = hasTurnIntervened({ isMainTurn, mainTurns, seen })
  if (!done.ok) {
    // Rejeitou porque um turno começou: espera a vez. Qualquer outro motivo (API, nada a compactar) NÃO repete a análise.
    if (intervened) compactPhase = 'queued'
    else $.ui.toast(`Compactação recusada: ${done.error.slice(0, 120)}`)
    return
  }
  if (done.value.skip !== undefined) {
    $.ui.toast(`Compactação vetada: ${done.value.skip}`)
    return
  }
  $.ui.toast(`Compactado ${tokensLabel(done.value.tokensBefore, done.value.tokensAfter)}`.trim())
  if (intervened) {
    $.ui.toast('Compactado, mas um prompt entrou antes: não retomou sozinho.')
    return
  }
  await $.prompt.submit({ text: resumePromptOf(analysis) })
}

// Roda no timer de 3 s. Só começa com o pedido na fila e a sessão parada; um turno que aparece durante a análise devolve
// o pedido à fila (a análise ficou velha e é refeita quando a sessão parar).
async function drainCompact($: EngineInterface): Promise<void> {
  if (!shouldStart(compactPhase, isMainTurn)) return
  compactPhase = 'running'
  const seen = mainTurns
  try {
    await setStep($, 'analyzing')
    const analysis = await analyzeSession($)
    if (hasTurnIntervened({ isMainTurn, mainTurns, seen })) {
      compactPhase = 'queued'
      return
    }
    await setStep($, 'compacting')
    await runCompact($, analysis, seen)
  } catch (err) {
    $.ui.toast(`Compactação interrompida por erro: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
  } finally {
    if (phaseNow() === 'running') compactPhase = 'idle'
    await settle(() => setStep($, phaseNow() === 'queued' ? 'queued' : null))
  }
}

// Roda no timer de 3 s. O "Executar" espera a sessão parar; as etapas do EGM só escrevem o comando no campo de prompt,
// porque as skills dele não rodam por chamada do modelo.
async function runPlan($: EngineInterface, step: PlanStep): Promise<void> {
  switch (step) {
    case 'execute': {
      const flow = await read($, planFlow)
      // Volta ao começo antes de enviar: o envio pode durar o turno inteiro, e um segundo clique não pode executar de novo.
      await update($, planFlow, () => PLAN_START)
      try {
        await $.prompt.submit({ text: executePromptOf(flow.doc) })
      } catch (err) {
        await update($, planFlow, () => flow)
        throw err
      }
      return
    }
    case 'brainstorm':
    case 'draft':
    case 'review': {
      const box = await $.prompt.read()
      const filled = await $.prompt.fill({ text: fillTextOf(step, box.text) })
      if (!filled.isFilled) $.ui.toast(`Não deu para escrever no campo de prompt (há um diálogo aberto?): digite /${EGM_COMMANDS[step]}`)
      return
    }
    default:
      throw new Error('Caso não tratado: ' + String(step satisfies never))
  }
}

async function pressPlan($: EngineInterface): Promise<void> {
  planQueued = (await read($, planFlow)).step
}

async function drainPlan($: EngineInterface): Promise<void> {
  const step = planQueued
  if (step === null || (step === 'execute' && isMainTurn)) return
  planQueued = null
  try {
    await runPlan($, step)
  } catch (err) {
    $.ui.toast(`EGM falhou: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
  }
}

// Um clique só enfileira e já mostra "Refinando…"; clique com o refinamento na fila ou rodando é ignorado.
async function pressRefine($: EngineInterface): Promise<void> {
  if (refinePhase !== 'idle') return
  refinePhase = 'queued'
  await update($, refining, () => true)
}

// O Sonnet refina com a conversa e o CLAUDE.md/AGENTS.md; fonte que falha fica de fora, e qualquer falha do modelo vira null.
async function refineOf($: EngineInterface, typed: string): Promise<Refined | null> {
  const [messages, ...files] = await Promise.all([
    settle(() => $.session.messages()),
    ...['CLAUDE.md', 'AGENTS.md'].map(name => settle(async () => ({ name, text: await $.fs.read(name) }))),
  ])
  const docs = files.flatMap(file => (file.ok ? [file.value] : []))
  const asked = await askRefine($, refineInputOf({ typed, messages: messages.ok ? messages.value : [], docs }))
  return asked.ok ? parseRefine(asked.text) : null
}

async function runRefine($: EngineInterface): Promise<void> {
  const box = (await $.prompt.read()).text
  const original = typedIntentOf(box)
  if (original === null) {
    $.ui.toast('O campo já tem um /plan refinado: aperte Enter, ou apague para refinar de novo')
    return
  }
  if (original === '') {
    $.ui.toast('Escreva a intenção no campo antes de clicar em Planejar')
    return
  }
  const refined = await refineOf($, original)
  const text = planPromptOf(refined, original)
  // O usuário mexeu no campo enquanto o Sonnet pensava: o texto dele vale mais que o refinamento.
  if ((await $.prompt.read()).text !== box) {
    $.ui.toast('Você editou o campo: refinamento descartado (está no log do workbench)')
    $.ui.log(`workbench: refinamento descartado\n${text}`)
    return
  }
  const filled = await $.prompt.fill({ text })
  if (refined === null) $.ui.toast('Refinamento falhou: segue com o seu texto')
  if (!filled.isFilled) {
    $.ui.toast('Não deu para escrever no campo de prompt (há um diálogo aberto?): o texto está no log do workbench')
    $.ui.log(`workbench: texto do Planejar\n${text}`)
  }
}

// Roda no timer de 3 s, só com o pedido na fila (o dispatch de um botão pode ser abandonado).
async function drainRefine($: EngineInterface): Promise<void> {
  if (refinePhase !== 'queued') return
  refinePhase = 'running'
  try {
    await runRefine($)
  } catch (err) {
    $.ui.toast(`Planejar falhou: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
  } finally {
    refinePhase = 'idle'
    await settle(() => update($, refining, () => false))
  }
}

// ---- QA: botão, cliques e a fase Executar (o timer é o único escritor de `qaJob`, fora o `isEnded` do turn.complete) ----

const isAuthCall = (call: unknown): call is { tool: string; profile?: unknown } =>
  typeof call === 'object' && call !== null && 'tool' in call && call.tool === QA_AUTH_TOOL

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 120)
const isoOf = (at: number): string => new Date(at).toISOString()

// O clique só enfileira a etapa atual; com trabalho em curso devolve o aviso e nada muda.
async function pressQa($: EngineInterface): Promise<string> {
  if ((await read($, qaJob)) !== null) return 'QA em andamento (use /workbench qa stop)'
  const step = (await read($, qaFlow)).step
  qaQueued = step
  return `QA: "${qaLabelOf(await read($, qaFlow), null)}" na fila`
}

// Grava a etapa nova ANTES de enviar (o envio pode durar o turno inteiro); `{ drop }` ou erro devolve a anterior.
async function sendQaStep($: EngineInterface, before: QaFlow, after: QaFlow, text: string): Promise<void> {
  await update($, qaFlow, () => after)
  const sent = await settle(() => $.prompt.submit({ text }))
  if (sent.ok && sent.value.drop === undefined) return
  await update($, qaFlow, () => before)
  $.ui.toast(`QA: o pedido não entrou (${sent.ok ? sent.value.drop : sent.error.slice(0, 80)})`)
}

async function qaPlan($: EngineInterface, env: QaEnv, flow: QaFlow): Promise<void> {
  const scope = (await $.prompt.read()).text
  await $.prompt.fill({ text: '' })
  const runDir = runDirOf(env.qaRoot, runIdOf(await $.clock.now()))
  if (!(await mkdirs($, runDir))) {
    $.ui.toast(`QA: não deu para criar a pasta ${runDir}`)
    return
  }
  const base = (await read($, snapshot))?.base || 'origin/main'
  await sendQaStep($, flow, { step: 'login', runDir, fixDir: '' }, qaPlanPromptOf({ scope, root: env.root, base, matrixPath: matrixPathOf(runDir) }))
}

// Portões, scripts e a fila com as células que ainda não têm veredito.
async function qaRun($: EngineInterface, env: QaEnv, flow: QaFlow, matrix: Matrix): Promise<void> {
  const gate = await runGateOf($, env, matrix, await $.clock.now())
  if (gate !== null) {
    $.ui.toast(gate.text)
    if (gate.back) await update($, qaFlow, () => ({ ...flow, step: 'login' }))
    return
  }
  if (!(await writeScripts($, env, matrix))) {
    $.ui.toast('QA: não deu para gravar os scripts do navegador.')
    return
  }
  const runBase = await runBaseOf($, env.root)
  await update($, qaRunBase, () => runBase)
  const queue = await pendingCellsOf($, flow.runDir, matrix)
  await update($, qaJob, cur => cur ?? { phase: 'run' as const, queue, total: queue.length, current: null })
}

async function runQaClick($: EngineInterface, step: QaStep): Promise<void> {
  const env = qaEnv
  if (env === null || qaBlocked !== null) {
    $.ui.toast(qaBlocked ?? QA_OFF)
    return
  }
  const flow = await read($, qaFlow)
  if (step === 'plan') return qaPlan($, env, flow)
  const loaded = await loadMatrix($, flow.runDir)
  switch (loaded.kind) {
    case 'missing':
      await update($, qaFlow, () => QA_START)
      $.ui.toast('QA: não achei o matriz.md desta execução; o botão voltou para o começo.')
      return
    case 'invalid':
      $.ui.toast(`QA: matriz inválida: ${loaded.error.slice(0, 120)}`)
      return
    case 'ok':
      break
    default:
      throw new Error('Caso não tratado: ' + String(loaded satisfies never))
  }
  const matrix = loaded.matrix
  switch (step) {
    case 'login':
      return sendQaStep($, flow, { ...flow, step: 'run' }, qaLoginPromptOf({ matrixPath: matrixPathOf(flow.runDir), matrix, qaRoot: env.qaRoot, toolsDir: toolsDirOf(env.home), home: env.home }))
    case 'run':
      return qaRun($, env, flow, matrix)
    case 'fix':
      $.ui.toast('Corrigir entra na próxima versão desta branch')
      return
    default:
      throw new Error('Caso não tratado: ' + String(step satisfies never))
  }
}

function spawnInputOf(o: { env: QaEnv; matrix: Matrix; cell: Cell; outDir: string; session: string; cdpPort: number | null; startedAt: string; endedAt: string }): SpawnInput {
  return {
    cell: o.cell,
    baseUrl: o.matrix.baseUrl,
    outDir: o.outDir,
    ab: wrapperOf(o.env.qaRoot, 'ab'),
    session: o.session,
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    imp: wrapperOf(o.env.qaRoot, 'imp'),
    cdpPort: o.cdpPort,
    loginRoute: o.matrix.loginRoute,
    containers: o.matrix.backend.containers,
    defect: null,
    worktree: '',
    testDir: '',
    attempt: 0,
    reasons: [],
  }
}

// Depois do lançamento: `deny` fecha a sessão (a célula fica sem veredito); o id entra em `qaGuarded` e na trava.
async function launchedOf($: EngineInterface, env: QaEnv, ctxText: (agentId: string) => string, spawned: { agentId: string | null } | { deny: string }, item: QaCurrent): Promise<QaCurrent | null> {
  if ('deny' in spawned) {
    $.ui.toast(`QA: agente recusado na célula ${item.cell} (${spawned.deny.slice(0, 80)}); ela fica sem veredito.`)
    await closeSession($, env, item.session)
    return null
  }
  const id = spawned.agentId
  if (id !== null) {
    await update($, qaGuarded, ids => [...ids, id])
    await $.fs.write(env.guardFile, ctxText(id))
  }
  return { ...item, agentId: id }
}

// Começa a célula do zero (attempt 2 = repetição na pasta r2, sessão nova). Falhou ao preparar: null, a fila segue.
async function startCell($: EngineInterface, env: QaEnv, runDir: string, matrix: Matrix, cellId: string, attempt: number): Promise<QaCurrent | null> {
  const cell = matrix.cells.find(c => c.id === cellId)
  if (cell === undefined) return null
  const now = await $.clock.now()
  const runId = runDir.split('/').pop() ?? ''
  const session = sessionOf(runId, attempt === 2 ? `${cellId}-r2` : cellId)
  const outDir = cellDirOf(runDir, cellId, attempt)
  const cdpPort = (await mkdirs($, outDir)) ? await prepareSession($, env, matrix, cell, session) : null
  if (cdpPort === null) {
    $.ui.toast(`QA: não deu para abrir o navegador da célula ${cellId}; ela fica sem veredito.`)
    return null
  }
  const ctx = guardCtxOf(env, matrix, runDir, session, cdpPort)
  await $.fs.write(env.guardFile, guardStateTextOf('runner', null, ctx))
  const prompt = spawnPromptOf('runner', spawnInputOf({ env, matrix, cell, outDir, session, cdpPort, startedAt: isoOf(now), endedAt: '' }))
  const spawned = await spawnQa($, 'runner', prompt, `QA ${cellId}`)
  const item: QaCurrent = { item: cellId, role: 'runner', attempt, agentId: null, at: now, isEnded: false, cell: cellId, sha: '', port: 0, session, cdpPort, reasons: [] }
  return launchedOf($, env, id => guardStateTextOf('runner', id, ctx), spawned, item)
}

// O agente do item acabou: runner → observer na mesma sessão; observer → fecha a sessão e repete uma vez se falhou.
async function advanceCell($: EngineInterface, env: QaEnv, runDir: string, matrix: Matrix, c: QaCurrent): Promise<QaCurrent | null> {
  const cell = matrix.cells.find(x => x.id === c.cell)
  if (cell === undefined || c.role === 'fixer') {
    await closeSession($, env, c.session)
    return null
  }
  if (c.role === 'runner') {
    const now = await $.clock.now()
    const ctx = guardCtxOf(env, matrix, runDir, c.session, c.cdpPort)
    await $.fs.write(env.guardFile, guardStateTextOf('observer', null, ctx))
    const outDir = cellDirOf(runDir, c.cell, c.attempt)
    const prompt = spawnPromptOf('observer', spawnInputOf({ env, matrix, cell, outDir, session: c.session, cdpPort: c.cdpPort, startedAt: isoOf(c.at), endedAt: isoOf(now) }))
    const spawned = await spawnQa($, 'observer', prompt, `QA ${c.cell} (verificação)`)
    return launchedOf($, env, id => guardStateTextOf('observer', id, ctx), spawned, { ...c, role: 'observer', agentId: null, at: now, isEnded: false })
  }
  await closeSession($, env, c.session)
  const final = finalVerdictOf(cell, await cellVerdictOf($, runDir, c.cell, c.attempt))
  return nextRunOf(c, final) === 'repeat' ? startCell($, env, runDir, matrix, c.cell, 2) : null
}

// Grava o item novo; se o trabalho foi parado no meio, fecha a sessão que acabou de abrir.
async function setCurrent($: EngineInterface, env: QaEnv, next: QaCurrent | null): Promise<void> {
  await update($, qaJob, cur => (cur === null ? null : { ...cur, current: next }))
  if (next !== null && (await read($, qaJob)) === null) await closeSession($, env, next.session)
}

// Fila vazia: relatório, etapa Corrigir, trava zerada e o resumo pendente para a sessão.
async function closeRun($: EngineInterface, env: QaEnv, runDir: string, matrix: Matrix): Promise<void> {
  const counts = await writeReport($, runDir, matrix)
  await update($, qaFlow, f => ({ ...f, step: 'fix' as const }))
  await update($, qaJob, () => null)
  await $.fs.write(env.guardFile, '{}')
  qaPending = runDonePromptOf({ reportPath: reportPathOf(runDir), counts })
}

// Um passo por tique: começa o próximo item, adota o agente sem id, ou avança o item cujo agente acabou.
async function stepQaJob($: EngineInterface, env: QaEnv): Promise<void> {
  const job = await read($, qaJob)
  if (job === null || job.phase !== 'run') return
  const flow = await read($, qaFlow)
  const loaded = await loadMatrix($, flow.runDir)
  if (loaded.kind !== 'ok') {
    await update($, qaJob, () => null)
    $.ui.toast('QA: a matriz sumiu ou mudou no meio da execução; o trabalho parou.')
    return
  }
  const c = job.current
  if (c === null) {
    const [next, ...rest] = job.queue
    if (next === undefined) return closeRun($, env, flow.runDir, loaded.matrix)
    await update($, qaJob, cur => (cur === null ? null : { ...cur, queue: rest }))
    return setCurrent($, env, await startCell($, env, flow.runDir, loaded.matrix, next, 1))
  }
  const step = agentStepOf(c, QA_TYPE[c.role], await agentsOf($), await $.clock.now(), await read($, qaGuarded))
  switch (step.step) {
    case 'wait':
      return
    case 'adopt': {
      const id = step.agentId
      await update($, qaGuarded, ids => [...ids, id])
      await $.fs.write(env.guardFile, guardStateTextOf(c.role, id, guardCtxOf(env, loaded.matrix, flow.runDir, c.session, c.cdpPort)))
      await update($, qaJob, cur => (cur?.current?.item === c.item && cur.current.role === c.role ? { ...cur, current: { ...cur.current, agentId: id } } : cur))
      return
    }
    case 'ended':
      return setCurrent($, env, await advanceCell($, env, flow.runDir, loaded.matrix, c))
    default:
      throw new Error('Caso não tratado: ' + String(step satisfies never))
  }
}

// Roda no timer de 3 s. O clique e o pedido pendente são tirados da fila antes de qualquer `await`; os envios à sessão
// esperam a sessão parar. O passo do trabalho não espera a sessão, mas nunca roda dois ao mesmo tempo.
async function drainQa($: EngineInterface): Promise<void> {
  const step = qaQueued
  if (step !== null && !(isMainTurn && (step === 'plan' || step === 'login'))) {
    qaQueued = null
    const ran = await settle(() => runQaClick($, step))
    if (!ran.ok) $.ui.toast(`QA falhou: ${ran.error.slice(0, 120)}`)
  }
  const prompt = qaPending
  if (prompt !== null && !isMainTurn) {
    qaPending = null
    await settle(() => $.prompt.submit({ text: prompt }))
  }
  const env = qaEnv
  if (isQaStepping || env === null) return
  isQaStepping = true
  try {
    await stepQaJob($, env)
  } catch (err) {
    $.ui.toast(`QA: passo falhou (${errorText(err)})`)
  } finally {
    isQaStepping = false
  }
}

// Para o trabalho: a trava nega todo agente antigo, a sessão do navegador fecha e a etapa do botão fica (um clique retoma).
async function stopQa($: EngineInterface): Promise<string> {
  const job = await read($, qaJob)
  const env = qaEnv
  if (env !== null) await $.fs.write(env.guardFile, '{}')
  await update($, qaJob, () => null)
  qaQueued = null
  if (env !== null && job?.current) await closeSession($, env, job.current.session)
  return job === null ? 'QA: nenhum trabalho em curso.' : 'QA parado. Clique em QA para retomar.'
}

// Abre o painel com foco e, se ainda não leu o git, dispara a primeira leitura (o comando e o botão da faixa usam).
async function openPanel($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'workbench', focus: true })
  if ((await read($, snapshot)) === null) void refresh($).catch(() => {})
}

async function copyText($: EngineInterface, surface: RenderSurface, text: string, done: string): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? done : `Não copiou: ${copied.reason}`)
}

async function copyHandoff($: EngineInterface, surface: RenderSurface): Promise<void> {
  const current = await read($, snapshot)
  if (current === null) return
  await copyText($, surface, handoffTable(current), 'Seção 3 do handoff copiada')
}

async function copyCommands($: EngineInterface, surface: RenderSurface): Promise<void> {
  const current = await read($, snapshot)
  const report = await read($, stale)
  if (current === null || report === null) return
  const text = commandsOf(current, report.items, await $.clock.now())
  if (text === '') {
    $.ui.toast('Nenhuma worktree removível agora.')
    return
  }
  await copyText($, surface, text, 'Comandos copiados: leia antes de colar')
}

async function copySelected($: EngineInterface, surface: RenderSurface, what: 'path' | 'branch'): Promise<void> {
  const current = await read($, snapshot)
  const path = await read($, selected)
  const row = current?.rows.find(r => r.path === path)
  if (row === undefined) {
    $.ui.toast('Selecione uma worktree com j/k.')
    return
  }
  await copyText($, surface, what === 'path' ? row.path : row.branch, what === 'path' ? 'Caminho copiado' : 'Branch copiada')
}

async function move($: EngineInterface, delta: number): Promise<void> {
  const current = await read($, snapshot)
  if (current === null) return
  const rows = sortRows(current.rows)
  const path = await read($, selected)
  const index = rows.findIndex(r => r.path === path)
  const target = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]
  if (target === undefined) return
  await update($, selected, () => target.path)
  await $.ui.scroll({ in: PANE, to: { key: `row:${target.path}` } })
}

function colorOf(row: Row): string {
  if (row.error !== null || row.staleMigrations.length > 0) return 'error'
  if (row.isPrunable) return 'subtle'
  if (row.pr === null) return 'warning'
  if (row.pr.state === 'OPEN') return 'text'
  return 'subtle'
}

function detailOf(row: Row, now: number): string {
  const days = idleDays(row, now)
  const dirty = row.dirty === null ? 'mudanças locais: ?' : `${row.dirty} arquivos alterados`
  const idle = days === null ? 'atividade: ?' : `parada há ${days}d`
  const size = row.isPrunable ? '' : row.ownKb === null ? ' · espaço: ?' : ` · ${sizeLabel(row.ownKb)} exclusivos`
  const sub = row.submodules === 'unsafe' ? ' · submódulo com mudança ou commit só local' : ''
  return `${pushLabel(row)} · ${dirty} · ${idle}${size}${sub}`
}

// Chave nova de propósito: o `route:auto` da versão antiga (aviso por prompt) não liga a delegação. Só um `true` liga.
const ROUTE_DELEGATE_KEY = 'route:delegate'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // O engine mantém a linha que uma versão antiga fixou com `$.ui.status` até alguém trocá-la; a faixa é a única fonte.
    $.ui.status(undefined)
    // Um reload no meio de uma consulta ao Haiku não deixa a flag presa.
    await update($, suggesting, () => false)
    // Só `armed` zera: `removal` NÃO, para a allowlist continuar valendo se um remover ainda roda depois do reload.
    await update($, armed, () => null)
    // Reload no meio não deixa a compactação presa na fila nem o botão travado.
    compactPhase = 'idle'
    isMainTurn = false
    mainTurns = 0
    planQueued = null
    refinePhase = 'idle'
    await update($, compacting, () => null)
    await update($, refining, () => false)
    qaQueued = null
    isQaStepping = false
    qaPending = null
    qaEnv = null
    qaBlocked = QA_OFF
    // Cada item num settle: o QA que falha fica desligado com o motivo, sem derrubar o painel.
    const env = await settle(() => qaEnvOf($, Math.random().toString(36).slice(2, 10)))
    if (env.ok && env.value !== null) {
      const ready = env.value
      qaEnv = ready
      const registered = await settle(() => registerQa($, ready, $.plugin.root))
      qaBlocked = registered.ok ? registered.value : `QA: falha ao registrar os agentes (${registered.error.slice(0, 80)})`
    }
    const delegate = await settle(() => $.store.get(ROUTE_DELEGATE_KEY))
    isDelegateOn = delegate.ok && delegate.value === true
    await $.command.register({
      name: 'workbench',
      description:
        'Painel das worktrees em voo. `/workbench base <ref>` troca a base; `/workbench stale` pede a sugestão de limpeza; `/workbench qa` faz o mesmo que o botão QA; `/workbench qa stop` para o QA em curso.',
      argumentHint: '[base <ref> | stale | qa [stop]]',
    })
    await $.command.register({
      name: 'route',
      description: 'Sugere o modelo (haiku, sonnet ou opus) para uma tarefa. `/route auto on|off` liga ou desliga a delegação automática por modelo.',
      argumentHint: '<tarefa> | auto on|off',
    })
    // Falha aqui não derruba o painel: o botão só recusa, no spawn, com o motivo.
    await settle(() =>
      $.agent.register({
        name: 'remover',
        description: 'Roda a remoção de worktrees já aprovada no painel do workbench, só as linhas recebidas.',
        prompt: REMOVER_PROMPT,
        tools: ['Bash'],
        model: 'haiku',
        maxTurns: 200,
        omitClaudeMd: true,
      }),
    )
    $.clock.every(REFRESH_MS, () => {
      void refresh($).catch(() => {})
    })
    $.clock.every(SUGGEST_POLL_MS, () => {
      void drainSuggest($).catch(() => {})
      void drainSizes($).catch(() => {})
      void drainRemove($).catch(() => {})
      void drainCompact($).catch(() => {})
      void drainPlan($).catch(() => {})
      void drainRefine($).catch(() => {})
      void drainQa($).catch(() => {})
    })
    void refresh($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'workbench' }, async ($, e) => {
    const args = e.args.trim()
    const wanted = /^base\s+(\S+)$/.exec(args)?.[1]
    if (wanted !== undefined) {
      const root = await repoRoot($)
      if (root === null) return { text: 'Esta sessão não está num repositório git.' }
      await $.store.set(`base:${root}`, wanted)
      void refresh($, true).catch(() => {})
      return { text: `Base de ${root} agora é ${wanted}.` }
    }
    if (args === 'stale') {
      const root = await repoRoot($)
      if (root === null) return { text: 'Esta sessão não está num repositório git.' }
      scheduleSuggest(root, true)
      const list = listOf(await read($, stale))
      return { text: `${list}\n(o Haiku está sendo consultado em segundo plano; o painel mostra o resultado)` }
    }
    if (args === 'qa stop') return { text: await stopQa($) }
    if (args === 'qa') return { text: await pressQa($) }
    await openPanel($)
    return { text: 'Painel do workbench aberto.' }
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const args = e.args.trim()
    const switched = /^auto\s+(on|off)$/i.exec(args)?.[1]
    if (switched !== undefined) {
      const isOn = switched.toLowerCase() === 'on'
      await $.store.set(ROUTE_DELEGATE_KEY, isOn)
      isDelegateOn = isOn
      const state = isOn ? 'ligada' : 'desligada'
      return { text: `Delegação automática por modelo ${state}. Vale nesta sessão e nas próximas; sessões já abertas seguem como estavam até reiniciar.` }
    }
    if (args === '' || /^auto\b/i.test(args)) return { text: 'Uso: /route <tarefa> sugere o modelo; /route auto on|off liga ou desliga a delegação automática por modelo.' }
    // Pedido explícito: ignora os portões baratos e responde na hora (a spike mostrou que a completion roda aqui).
    const asked = await askRoute($, args)
    if (!asked.ok) return { text: asked.isAborted ? 'Consulta ao Haiku interrompida.' : `Não consegui consultar o Haiku: ${asked.reason}` }
    if (asked.usage !== undefined) $.ui.log(`route: ${asked.usage.input_tokens} tokens de entrada, ${asked.usage.output_tokens} de saída`)
    const route = parseRoute(asked.text)
    if (route === null) return { text: 'O Haiku respondeu fora do formato esperado; tente de novo.' }
    return { text: formatRoute(route, tierOf(await $.session.model())) }
  })

  // Nunca segura o prompt: sem chamada de modelo nem de armazenamento, só soma a instrução de delegar ao `context`.
  on('prompt.submit', async ($, e, next) => {
    // O aviso de fim de um agente de QA: quem lê o resultado é o mod, nos arquivos. Nenhum outro texto é derrubado.
    const handback = e.isMeta === true ? handbackAgentOf(e.text) : null
    if (handback !== null && (await read($, qaGuarded)).includes(handback)) return { drop: 'workbench: o relatório do agente de QA é lido pelo mod' }
    // Um comando do EGM que entrou avança a etapa do botão EGM (e guarda o doc no review). Nunca segura o prompt.
    const flow = e.command === undefined ? null : planAfter(e.command)
    if (flow !== null) void update($, planFlow, () => flow).catch(() => {})
    try {
      const isOpen = shouldDelegate({
        isOn: isDelegateOn,
        length: e.text.length,
        isUser: isUserOrigin(e.origin.kind),
        isCommand: e.command !== undefined,
        isMeta: e.isMeta === true,
      })
      if (isOpen) return next({ ...e, context: [...(e.context ?? []), DELEGATE_CONTEXT] })
    } catch {
      // A delegação é só conselho: um erro aqui não pode impedir o prompt de entrar.
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (CHANGES.test(e.command)) void refresh($, CHANGES_PRS.test(e.command)).catch(() => {})
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  // O remover não é oferecido ao modelo principal: só o botão o dispara.
  on('agent.offer', { agent: REMOVER_AGENT }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  // Runner, observer e fixer só o mod lança (por código); o planner fica oferecido, porque é a sessão que o despacha.
  on('agent.offer', { agent: QA_RUNNER }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: QA_OBSERVER }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: QA_FIXER }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  // A ferramenta qa_auth (o Login a chama): só as contagens do login salvo de um perfil da matriz atual. Sem filtro por
  // nome no `on` e com o evento lido como `unknown`: a união dos tipos das ferramentas MCP estoura a memória do tsc.
  on('tool.call', async ($, e, next) => {
    const call: unknown = e
    if (!isAuthCall(call)) return next(e)
    const env = qaEnv
    if (env === null) return { deny: qaBlocked ?? QA_OFF }
    return authReplyOf($, env, (await read($, qaFlow)).runDir, call.profile, await $.clock.now())
  })


  // Portão do Bash do remover: com uma remoção em curso, só a linha exata da allowlist roda (e nunca o que o engine já negou).
  // Com o agentId conhecido compara o id; só na janela em que ele ainda é null consulta a lista, e agente não listado conta
  // como remover (falha fechado).
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const core = await next(e)
    const current = await read($, removal)
    if (current === null || e.agentId === undefined) return core
    const isRemover = current.agentId === null ? await isListedRemover($, e.agentId, true) : e.agentId === current.agentId
    if (!isRemover) return core
    const decision = removalCheckOf(current.allowed, commandOf(e.input), core.decision)
    return { decision, reason: decision === 'allow' ? 'linha aprovada no painel do workbench' : 'fora da lista de remoção aprovada no painel' }
  }).catch(async ($, e, next) => {
    // Erro no hook nunca abre a trava; e fora do remover (ou fora de uma remoção) não bloqueia nada.
    const current = await read($, removal)
    const isGuarded = current !== null && e.agentId !== undefined && (current.agentId === null || e.agentId === current.agentId)
    return isGuarded ? { decision: 'deny' as const, reason: 'workbench: erro ao conferir a lista de remoção' } : next(e)
  })

  // Só o loop principal conta (subagentes e a fork da compactação trazem agentId): a compactação espera a sessão parar.
  on('turn.start', async (_$, e, next) => {
    if (e.agentId === undefined) {
      isMainTurn = true
      mainTurns += 1
    }
    return next(e)
  })

  // Fim do turno do remover: limpa a trava e refaz o snapshot. Aqui um agente que não se consegue identificar NÃO encerra nada.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) isMainTurn = false
    // Só marca o fim do agente do item de QA em curso: quem avança é o timer.
    const agentId = e.agentId
    if (agentId !== undefined && (await read($, qaJob))?.current?.agentId === agentId) {
      await update($, qaJob, cur => (cur?.current?.agentId === agentId ? { ...cur, current: { ...cur.current, isEnded: true } } : cur))
    }
    const current = e.agentId === undefined ? null : await read($, removal)
    if (current !== null && e.agentId !== undefined) {
      const isRemover = current.agentId === null ? await isListedRemover($, e.agentId, false) : e.agentId === current.agentId
      if (isRemover) await settle(() => finishRemoval($, e.answer))
    }
    return next(e)
  })

  // Faixa fixa acima do prompt (como a do ponytail): resumo das worktrees e os atalhos. Cede a vez a uma pesquisa e divide
  // o espaço com a faixa de outros mods, que continua desenhada embaixo da nossa.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // `next(e)` só rejeita quando nada responde embaixo (o harness de teste): a faixa desenha do mesmo jeito.
    const below = await next(e).catch(() => undefined)
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, snapshot)
    const mine = (
      <Box flexDirection="row" alignItems="center" gap={2} width={e.props.bodyColumns}>
        <Text wrap="truncate">{current === null ? 'workbench: sem dados' : bandOf(current, removableOf(current, await read($, stale)))}</Text>
        <Box flexGrow={1} />
        <Button key="compact" plain onPress={() => void pressCompact($).catch(() => {})}>
          {buttonLabel(await read($, compacting))}
        </Button>
        <Button key="refine" plain onPress={() => void pressRefine($).catch(() => {})}>
          {(await read($, refining)) ? 'Refinando…' : 'Planejar'}
        </Button>
        <Button key="plan" plain onPress={() => void pressPlan($).catch(() => {})}>
          {PLAN_LABELS[(await read($, planFlow)).step]}
        </Button>
        <Button key="qa" plain onPress={() => void pressQa($).then(text => $.ui.toast(text)).catch(() => {})}>
          {qaLabelOf(await read($, qaFlow), await read($, qaJob))}
        </Button>
        <Button key="refresh" plain label="Atualizar" onPress={() => void refresh($, true).catch(() => {})} />
        <Button key="panel" plain label="Painel" onPress={() => void openPanel($).catch(() => {})} />
      </Box>
    )
    return below === undefined ? mine : <Box flexDirection="column">{mine}{below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, snapshot)
    const isBusy = await read($, busy)
    const isSuggesting = await read($, suggesting)
    const report = await read($, stale)
    const selectedPath = await read($, selected)
    const pending = await read($, armed)
    const active = await read($, removal)
    // Sem hotkey de propósito, como o "Aceitar remoções": compactar não se desfaz. Fora do `if` do snapshot porque
    // compactar não depende de git.
    const compactButton = (
      <Button key="compact" onPress={() => void pressCompact($).catch(() => {})}>
        {buttonLabel(await read($, compacting))}
      </Button>
    )

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{isBusy ? 'Lendo worktrees, branches e PRs…' : 'Sem dados. Esta sessão está num repositório git?'}</Text>
          {compactButton}
        </Box>
      )
    }

    const rows = sortRows(current.rows)
    const chosen = rows.find(row => row.path === selectedPath)
    const verdict = report?.items.find(item => item.path === selectedPath)
    const actionable = report === null ? [] : actionableOf(current, report.items, current.at)
    const removable = actionable.length
    const freed = freedKb(current.rows, new Set(actionable.map(c => c.row.path)))
    // O que o botão "Aceitar remoções" executaria agora (o resto, p. ex. worktree com submódulo, fica só no "Copiar comandos").
    const plan = report === null ? null : removalLinesOf(current, report.items)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" hotkey="r" onPress={() => void refresh($, true).catch(() => {})}>
            Atualizar
          </Button>
          <Button key="copy" hotkey="c" variant="primary" onPress={() => void copyHandoff($, e.surface)}>
            Copiar handoff
          </Button>
          <Button key="suggest" hotkey="s" onPress={() => scheduleSuggest(current.root, true)}>
            {isSuggesting ? 'Consultando o Haiku…' : 'Sugerir limpeza'}
          </Button>
          {removable > 0 && (
            <Button key="commands" hotkey="x" onPress={() => void copyCommands($, e.surface)}>
              Copiar comandos
            </Button>
          )}
        </Box>
        {/* Linha própria: com cinco botões na primeira linha, num painel estreito este ficava cortado. */}
        {(plan !== null && plan.lines.length > 0) || active !== null ? (
          <Box flexDirection="row" gap={2}>
            {/* Sem hotkey de propósito: apaga worktrees e branches, e o segundo clique é a confirmação. */}
            <Button key="accept" variant="primary" onPress={() => void pressAccept($).catch(() => {})}>
              {acceptLabel(active !== null, pending !== null, plan?.count ?? 0)}
            </Button>
          </Box>
        ) : removable > 0 ? (
          <Text dimColor wrap="truncate">
            Sem remoção automática: só worktree com submódulo ou nome com quebra de linha. Use Copiar comandos (x).
          </Text>
        ) : null}
        <Box flexDirection="row" gap={2}>
          <Button key="down" hotkey="j" plain onPress={() => void move($, 1).catch(() => {})}>
            ↓
          </Button>
          <Button key="up" hotkey="k" plain onPress={() => void move($, -1).catch(() => {})}>
            ↑
          </Button>
          <Button key="path" hotkey="p" onPress={() => void copySelected($, e.surface, 'path')}>
            Caminho
          </Button>
          <Button key="branch" hotkey="b" onPress={() => void copySelected($, e.surface, 'branch')}>
            Branch
          </Button>
        </Box>
        <Box flexDirection="row" gap={2}>
          {compactButton}
        </Box>
        <Text> </Text>
        <Text bold wrap="truncate">
          {summaryOf(current).replace(/^workbench: /, '')}
        </Text>
        <Text dimColor wrap="truncate">
          base {current.base} @{current.baseHead} · última migration {current.baseMigration ?? '—'} · {hhmm(current.at)}
          {isBusy ? ' · atualizando…' : ''}
        </Text>
        <Text color={isFetchStale(current.fetchedAt, current.at) ? 'warning' : 'subtle'} wrap="truncate">
          {fetchAgeLabel(current.fetchedAt, current.at)}
        </Text>
        {current.errors.map(error => (
          <Text color="error" wrap="truncate">
            {error}
          </Text>
        ))}
        <Text> </Text>
        {rows.map(row => (
          <Box key={`row:${row.path}`}>
            <Text color={colorOf(row)} dimColor={colorOf(row) === 'subtle'} bold={row.path === selectedPath} wrap="truncate">
              {lineOf(row, current.isPrKnown, row.path === selectedPath)}
            </Text>
          </Box>
        ))}
        {chosen !== undefined && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold wrap="truncate">
              {chosen.branch}
            </Text>
            <Text dimColor wrap="truncate">
              {chosen.path}
            </Text>
            <Text dimColor wrap="truncate">
              {detailOf(chosen, current.at)}
            </Text>
            {chosen.staleMigrations.length > 0 && (
              <Text color="error" wrap="truncate">
                migrations atrás da base: {chosen.staleMigrations.join(', ')}
              </Text>
            )}
            {chosen.error !== null && (
              <Text color="error" wrap="truncate">
                {chosen.error}
              </Text>
            )}
            {verdict !== undefined && (
              <Text wrap="truncate">
                {labelOf(verdict)}: {verdict.reason}
              </Text>
            )}
          </Box>
        )}
        {report !== null && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold wrap="truncate">
              Limpeza sugerida ({report.source === 'haiku' ? `Haiku ${hhmm(report.at)}` : 'regra'}){freed > 0 ? ` · libera ~${sizeLabel(freed)}` : ''}
            </Text>
            {report.note !== null && (
              <Text dimColor wrap="truncate">
                {report.note}
              </Text>
            )}
            {report.items.map(item => (
              <Text color={item.verdict === 'remove' ? 'warning' : 'subtle'} wrap="truncate">
                {labelOf(item)} {item.branch} · {item.reason}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
