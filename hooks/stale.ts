// Limpeza sugerida: regras puras, sem `$` e sem I/O. A regra decide QUEM é candidata; o Haiku só opina sobre cada uma.
// Os comandos de remoção saem daqui, montados dos Row atuais, nunca do texto do modelo.
import type { DetachedPrunable, Reason, Row, Snapshot, StaleReport, Suggestion, Verdict } from '../types'
import { fetchAgeLabel } from './model'

export const STALE_DAYS = 7
export const MERGED_IDLE_HOURS = 24
// Só a pasta: atravessa um fim de semana (sexta → terça). PR aberta ou PR desconhecida (gh fora) esperam mais.
export const TREE_IDLE_DAYS = 4
export const OPEN_IDLE_DAYS = 7
export const HAIKU_CAP = 20
export const MAX_BATCHES = 5
export const WINDOW_MS = 3_600_000
export const ABORT_BACKOFF_MS = 5 * 60_000

const HOUR = 3_600_000
const DAY = 24 * HOUR

export type { Reason }

export type Candidate = { row: Row; reason: Reason }

export type Scope = 'full' | 'tree' | 'prune'

// full: worktree e branch (o conteúdo já está preservado); tree: só a pasta, a branch fica; prune: só o registro.
export function scopeOf(reason: Reason): Scope {
  switch (reason) {
    case 'prunable':
      return 'prune'
    case 'open':
    case 'unknown':
    case 'moved':
    case 'work':
      return 'tree'
    case 'merged':
    case 'closed':
    case 'gone':
    case 'no-pr':
      return 'full'
    default:
      throw new Error('Caso não tratado: ' + String(reason satisfies never))
  }
}

// Por que a idade mínima: outra sessão pode ter acabado de abrir uma worktree numa branch já contida na base ou
// mergeada, ainda sem commit nem arquivo. O workbench não enxerga outras sessões e o git aceitaria removê-la.
function reasonOf(row: Row, o: { now: number; isPrKnown: boolean }): Reason | null {
  if (row.isLocked || row.error !== null) return null
  // `git worktree prune` só apaga o registro: nunca a branch nem os commits. Vale mesmo com commits só locais.
  if (row.isPrunable) return 'prunable'
  if (row.isCurrent || row.dirty !== 0 || row.lastActivityAt === null) return null
  const idle = o.now - row.lastActivityAt
  return fullReasonOf(row, idle, o.isPrKnown) ?? treeReasonOf(row, idle, o.isPrKnown)
}

// Worktree e branch: só quando todo o conteúdo da branch está preservado fora dela.
function fullReasonOf(row: Row, idle: number, isPrKnown: boolean): Reason | null {
  if (row.pr?.state === 'OPEN') return null
  if (row.pr !== null && row.pr.headOid !== row.head) return null
  if (row.unpushed > 0) return null
  const isMerged = row.pr?.state === 'MERGED'
  // `unpushed` é 0 para `none` e `gone`: commits só locais se enxergam por `ahead`.
  if (row.ahead > 0 && (row.push === 'none' || row.push === 'gone') && !isMerged) return null
  if (isMerged) return idle >= MERGED_IDLE_HOURS * HOUR ? 'merged' : null
  if (idle < STALE_DAYS * DAY) return null
  if (row.pr?.state === 'CLOSED') return row.ahead === 0 || row.push === 'ok' ? 'closed' : null
  if (row.push === 'gone' && row.ahead === 0) return 'gone'
  // Sem a lista do gh, "sem PR" é desconhecido.
  if (row.pr === null && isPrKnown && row.ahead === 0) return 'no-pr'
  return null
}

// Só a pasta: a árvore está limpa e a branch fica com todos os commits, então vale para tudo que não fecha `full`
// (HEAD que andou depois do merge, cherry-pick, commits só locais, sem PR). Perde-se só o que o git ignora.
function treeReasonOf(row: Row, idle: number, isPrKnown: boolean): Reason | null {
  if (!isPrKnown) return idle >= OPEN_IDLE_DAYS * DAY ? 'unknown' : null
  if (row.pr?.state === 'OPEN') return idle >= OPEN_IDLE_DAYS * DAY ? 'open' : null
  if (idle < TREE_IDLE_DAYS * DAY) return null
  return row.pr === null ? 'work' : 'moved'
}

export function candidatesOf(rows: readonly Row[], o: { now: number; isPrKnown: boolean }): Candidate[] {
  const out: Candidate[] = []
  for (const row of rows) {
    const reason = reasonOf(row, o)
    if (reason !== null) out.push({ row, reason })
  }
  return out
}

// Viva com submódulo sujo, com commit só local ou ainda não conferido: nenhum comando sai para ela.
export function isBlocked(row: Row): boolean {
  return !row.isPrunable && row.submodules !== 'none' && row.submodules !== 'clean'
}

// Prunable não precisa de veredito (o comando é sempre `prune`) e bloqueada não ganha comando: só as demais vivas vão
// ao Haiku, as mais paradas primeiro.
export function splitCandidates(cands: readonly Candidate[]): { prunable: Candidate[]; live: Candidate[]; blocked: Candidate[] } {
  const prunable = cands.filter(c => c.reason === 'prunable')
  const alive = cands
    .filter(c => c.reason !== 'prunable')
    .sort((a, b) => (a.row.lastActivityAt ?? 0) - (b.row.lastActivityAt ?? 0) || a.row.path.localeCompare(b.row.path))
  return { prunable, live: alive.filter(c => !isBlocked(c.row)), blocked: alive.filter(c => isBlocked(c.row)) }
}

// Chave do veredito: caminho, HEAD e regra. Um veredito dado com uma regra (escopo) não vale para outra.
export function keyOf(c: Candidate): string {
  return `${c.row.path}@${c.row.head}:${c.reason}`
}

// Lotes de até 20, no máximo 5: primeiro as sem veredito; com `isForced` (botão s) as já julgadas vêm depois delas.
export function batchesOf(live: readonly Candidate[], known: Known, isForced: boolean): { batches: Candidate[][]; overflow: Candidate[] } {
  const fresh = live.filter(c => !known.has(keyOf(c)))
  const queue = isForced ? [...fresh, ...live.filter(c => known.has(keyOf(c)))] : fresh
  const cap = HAIKU_CAP * MAX_BATCHES
  const batches: Candidate[][] = []
  for (let i = 0; i < Math.min(queue.length, cap); i += HAIKU_CAP) batches.push(queue.slice(i, Math.min(i + HAIKU_CAP, cap)))
  return { batches, overflow: queue.slice(cap) }
}

// O hash cobre só as vivas que vão ao Haiku e o motivo, nunca `isCurrent`: igual em toda sessão.
export function candidateHash(cands: readonly Candidate[]): string {
  const key = splitCandidates(cands)
    .live.map(keyOf)
    .sort()
    .join('\n')
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return `${h.toString(36)}.${key.length}`
}

export const RULES = [
  'Você ajuda a decidir quais worktrees git podem ser removidas para liberar disco.',
  'Todo item está com a árvore limpa (nenhum arquivo alterado ou não rastreado); você só mede a confiança.',
  'Escopo "worktree+branch": o conteúdo já está preservado (PR mergeada com este HEAD ou nada além da base).',
  'Escopo "só a pasta (branch fica)": a branch e os commits ficam e podem ter PR aberta ou commits que só existem nela;',
  'git worktree add recria só o que está commitado, e arquivos ignorados (.env, bancos locais, builds) se perdem.',
  'Responda APENAS um array JSON, sem texto fora dele, com um objeto por item recebido:',
  '{"id":"c1","verdict":"remove"|"review"|"keep","reason":"motivo curto em português, até 100 caracteres"}',
  '- "remove": parada e o trabalho parece concluído ou abandonado (PR mergeada, correção já levada à base, dias sem atividade).',
  '- "review": há dúvida (PR aberta, poucos dias parada, nome de trabalho recente).',
  '- "keep": parece trabalho em andamento.',
  'Na dúvida, escolha "review".',
].join('\n')

export function buildPrompt(sent: readonly Candidate[], now: number): { prompt: string; ids: Map<string, string> } {
  const ids = new Map<string, string>()
  const facts = sent.map((c, index) => {
    const id = `c${index + 1}`
    ids.set(id, c.row.path)
    return {
      id,
      branch: c.row.branch,
      issue: c.row.issue,
      regra: c.reason,
      escopo: scopeOf(c.reason) === 'full' ? 'worktree+branch' : 'só a pasta (branch fica)',
      espacoMB: c.row.ownKb === null ? null : Math.round(c.row.ownKb / 1024),
      pr: c.row.pr === null ? null : `${c.row.pr.state} #${c.row.pr.number}`,
      push: c.row.push,
      ahead: c.row.ahead,
      behind: c.row.behind,
      diasSemAtividade: c.row.lastActivityAt === null ? null : Math.floor((now - c.row.lastActivityAt) / DAY),
    }
  })
  return { prompt: JSON.stringify(facts), ids }
}

export type Judged = { verdict: Verdict; reason: string }

function isVerdict(value: unknown): value is Verdict {
  return value === 'remove' || value === 'review' || value === 'keep'
}

function isJudgement(value: unknown): value is { id: string; verdict: Verdict; reason: string } {
  if (typeof value !== 'object' || value === null) return false
  return (
    'id' in value && typeof value.id === 'string' &&
    'verdict' in value && isVerdict(value.verdict) &&
    'reason' in value && typeof value.reason === 'string'
  )
}

// Defensivo: ignora `id` inventado e veredito fora do enum. Zero vereditos válidos conta como falha para quem chama.
export function parseVerdicts(text: string, ids: ReadonlyMap<string, string>): Map<string, Judged> {
  const out = new Map<string, Judged>()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const item of parsed) {
    if (!isJudgement(item)) continue
    const path = ids.get(item.id)
    if (path !== undefined) out.set(path, { verdict: item.verdict, reason: item.reason.trim().slice(0, 100) })
  }
  return out
}

// Chave `caminho@HEAD:regra` (keyOf): a mesma branch pode estar em duas worktrees, e um HEAD ou uma regra nova
// invalidam o veredito antigo.
export type Known = ReadonlyMap<string, Judged>

export function knownFromVerdicts(verdicts: ReadonlyMap<string, Judged>, cands: readonly Candidate[]): Known {
  const out = new Map<string, Judged>()
  for (const c of cands) {
    const judged = verdicts.get(c.row.path)
    if (judged !== undefined) out.set(keyOf(c), judged)
  }
  return out
}

// Item sem `rule` (relatório de antes desta versão) não conta: a candidata é julgada de novo.
export function knownFromReport(report: StaleReport | null): Known {
  const out = new Map<string, Judged>()
  for (const item of report?.items ?? []) {
    if (item.origin === 'haiku' && item.rule !== undefined) {
      out.set(`${item.path}@${item.head}:${item.rule}`, { verdict: item.verdict, reason: item.reason })
    }
  }
  return out
}

export function mergeKnown(a: Known, b: Known): Known {
  return new Map([...a, ...b])
}

export type ReportInput = {
  cands: readonly Candidate[]
  detached: readonly DetachedPrunable[]
  known: Known
  overflow: ReadonlySet<string>
  missingReason: string
  hash: string
  at: number
  note: string | null
}

const ORDER: Record<Verdict, number> = { remove: 0, review: 1, keep: 2 }

export function buildReport(i: ReportInput): StaleReport | null {
  const items: Suggestion[] = []
  for (const c of i.cands) {
    const base = { path: c.row.path, branch: c.row.branch, head: c.row.head, rule: c.reason }
    if (c.reason === 'prunable') {
      items.push({ ...base, verdict: 'remove', reason: 'diretório não existe mais', origin: 'regra' })
      continue
    }
    if (isBlocked(c.row)) {
      const why = c.row.submodules === null ? 'submódulo ainda não conferido' : 'submódulo com mudança ou commit só local'
      items.push({ ...base, verdict: 'review', reason: why, origin: 'regra' })
      continue
    }
    const judged = i.known.get(keyOf(c))
    if (judged !== undefined) {
      items.push({ ...base, ...judged, origin: 'haiku' })
      continue
    }
    const reason = i.overflow.has(c.row.path) ? `fora do limite de ${HAIKU_CAP * MAX_BATCHES} do Haiku` : i.missingReason
    items.push({ ...base, verdict: 'review', reason, origin: 'regra' })
  }
  for (const d of i.detached) {
    if (d.isReachable) continue
    const reason = 'commit fora de qualquer ref: o comando cria uma branch rescue antes do prune'
    items.push({ path: d.path, branch: '(destacada)', head: d.head, verdict: 'review', reason, origin: 'regra', rule: 'prunable' })
  }
  if (items.length === 0) return null
  items.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path))
  const source = items.some(item => item.origin === 'haiku') ? 'haiku' : 'regra'
  return { hash: i.hash, at: i.at, source, note: i.note, items }
}

export function removableCount(report: StaleReport | null): number {
  return report === null ? 0 : report.items.filter(item => item.verdict === 'remove').length
}

export type Stored = { hash: string; at: number; report: StaleReport | null }

export type Failure = 'aborted' | 'other' | null

// O que gravar depois de uma execução de lotes. Fora do `aborted`, `at` é sempre gravado: assim uma execução
// incompleta (lote que falhou, Haiku que pulou itens, excedente acima de 100) nunca redispara a cada refresh.
// - completa (toda viva com veredito): hash, at e relatório.
// - `aborted` (dispatch abandonado): nada no $.store; relatório parcial só no $.state; backoff curto em memória.
// - incompleta: at e relatório parcial com o hash ANTERIOR, e a janela seguinte manda só as que faltam.
export function persistOf(o: { isComplete: boolean; failure: Failure }): { store: 'full' | 'at' | 'none'; backoff: boolean } {
  if (o.failure === 'aborted') return { store: 'none', backoff: true }
  if (o.isComplete && o.failure === null) return { store: 'full', backoff: false }
  return { store: 'at', backoff: false }
}

export function isStored(value: unknown): value is Stored {
  if (typeof value !== 'object' || value === null) return false
  if (!('hash' in value) || typeof value.hash !== 'string') return false
  if (!('at' in value) || typeof value.at !== 'number') return false
  if (!('report' in value)) return false
  const report = value.report
  if (report === null) return true
  return typeof report === 'object' && 'items' in report && Array.isArray(report.items)
}

// Só dispara sozinho com candidatas vivas, conjunto novo, 1h desde a última tentativa e uma tela para mostrar.
export function shouldAutoSuggest(o: {
  liveCount: number
  hash: string
  stored: Stored | null
  now: number
  hasSurface: boolean
  abortedUntil: number
}): boolean {
  if (o.liveCount === 0 || !o.hasSurface || o.now < o.abortedUntil) return false
  if (o.stored?.hash === o.hash) return false
  return o.now - (o.stored?.at ?? 0) >= WINDOW_MS
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function guarantee(c: Candidate, snapshot: Snapshot, now: number): string {
  const row = c.row
  if (c.reason === 'merged') return `o PR #${row.pr?.number ?? '?'} mergeou exatamente este HEAD`
  if (c.reason === 'closed' && row.ahead > 0) {
    const via = `commits continuam em origin/${row.branch} (e em refs/pull/${row.pr?.number ?? '?'}/head)`
    return `${via}; ${fetchAgeLabel(snapshot.fetchedAt, now)}`
  }
  return `nenhum commit além de ${snapshot.base}`
}

// Item que vira comando agora: tem `rule`, o Row atual continua candidato com o mesmo HEAD e a MESMA regra (o escopo
// copiado é sempre o que o painel mostrou), e não está bloqueado por submódulo.
export function actionableOf(snapshot: Snapshot, items: readonly Suggestion[], now: number): Candidate[] {
  const live = new Map(candidatesOf(snapshot.rows, { now, isPrKnown: snapshot.isPrKnown }).map(c => [c.row.path, c]))
  const out: Candidate[] = []
  for (const item of items) {
    if (item.verdict !== 'remove' || item.rule === undefined) continue
    const c = live.get(item.path)
    if (c === undefined || c.row.head !== item.head || c.reason !== item.rule || isBlocked(c.row)) continue
    out.push(c)
  }
  return out
}

// Recalcula a elegibilidade dos Row ATUAIS (actionableOf). `-D` porque `-d` compara com o upstream (ou com o HEAD do
// checkout principal), não com a base: recusaria branches cujo conteúdo as regras já garantiram preservado.
// `--force` só com submódulo conferido limpo (o git recusa sem ele); sem submódulo, nunca: o git recusa árvore suja.
export function commandsOf(snapshot: Snapshot, items: readonly Suggestion[], now: number): string {
  const root = shellQuote(snapshot.root)
  const lines: string[] = []
  let hasPrune = false
  for (const c of actionableOf(snapshot, items, now)) {
    const scope = scopeOf(c.reason)
    if (scope === 'prune') {
      hasPrune = true
      continue
    }
    const path = shellQuote(c.row.path)
    const force = c.row.submodules === 'clean'
    lines.push('')
    if (scope === 'tree') {
      lines.push(
        `# só a pasta: a branch ${c.row.branch} fica (${c.row.ahead} commits além de ${snapshot.base}) e some do painel;`,
        `# git -C ${root} worktree add ${path} ${shellQuote(c.row.branch)} recria só o commitado (ignorados como .env se perdem)`,
      )
    } else {
      lines.push(`# ${guarantee(c, snapshot, now)}`)
    }
    if (force) lines.push('# --force só por causa do submódulo, conferido sem mudança e sem commit só local; apaga o gitdir dele')
    lines.push(`git -C ${root} worktree remove ${force ? '--force ' : ''}${path}`)
    if (scope === 'full') lines.push(`git -C ${root} branch -D ${shellQuote(c.row.branch)}`)
  }
  if (hasPrune) {
    const rows = snapshot.rows.filter(r => r.isPrunable && !r.isLocked).length
    const detached = snapshot.detachedPrunable
    lines.push('', `# prune limpa TODAS as worktrees sem diretório deste repositório (${rows + detached.length}, incluindo ${detached.length} destacadas); as branches ficam`)
    for (const d of detached) {
      if (!d.isReachable) lines.push(`git -C ${root} branch rescue/${d.head.slice(0, 7)} ${d.head}`)
    }
    lines.push(`git -C ${root} worktree prune`)
  }
  if (lines.length === 0) return ''
  return ['# git worktree remove apaga também arquivos ignorados (.env etc.)', ...lines].join('\n')
}

// Agente que roda a remoção aprovada no painel. O Bash dele só passa pelas linhas aprovadas (hook de comando do tipo, com o
// papel `remover` do qa-guard.ts; o register.tsx grava o contexto antes de lançá-lo).
export const REMOVER_AGENT = 'workbench:remover'
// Segunda pressão de "Aceitar remoções" dentro deste prazo confirma a primeira; depois dele, arma de novo.
export const ARM_MS = 15_000
// Agente sumido ou terminado só encerra a remoção depois disto, para não competir com o resolve do spawn.
export const END_GRACE_MS = 15_000
// Sem agentId (spawn não confirmado, p. ex. reload no meio): espera este tempo antes de dar a remoção por encerrada.
export const SPAWN_GRACE_MS = 60_000
export const MAX_REMOVAL_LINES = 150

export const REMOVER_PROMPT = [
  'Você executa, no painel do workbench, a remoção de worktrees git que o usuário já aprovou.',
  'Rode cada linha que a mensagem trouxer, em ordem, numa chamada Bash por linha, exatamente como está escrita.',
  'Não invente, não reescreva, não junte comandos e não rode outro comando, nem para conferir: o mod recusa tudo fora da lista.',
  'Linhas com `git worktree prune` e `git branch rescue/...` fazem parte da lista quando há worktrees sem diretório.',
  'Pare na primeira linha que falhar (exit diferente de 0) e não rode as seguintes.',
  'Responda em até 15 linhas, em português: quantas linhas rodaram e deram certo e, para cada falha, a linha e a mensagem de erro.',
].join('\n')

const hasBreak = (text: string): boolean => /[\r\n]/.test(text)

// O que o botão "Aceitar remoções" executa: o que `commandsOf` produziria, menos o que a automação não assume.
// Fica de fora (e vai só pelo `x`): worktree com submódulo limpo (o comando leva --force, que apagaria árvore suja se
// ela mudou depois da coleta) e nome com quebra de linha (a trava do remover libera por linha: viraria fragmentos liberados).
// Filtra ANTES do commandsOf, que recalcula o actionableOf por dentro. `snapshot.at` é o único instante usado.
export function removalLinesOf(
  snapshot: Snapshot,
  items: readonly Suggestion[],
): { lines: string[]; count: number; skipped: number } {
  const all = actionableOf(snapshot, items, snapshot.at)
  const kept = all.filter(c => !hasBreak(c.row.path) && !hasBreak(c.row.branch) && (c.reason === 'prunable' || c.row.submodules !== 'clean'))
  const paths = new Set(kept.map(c => c.row.path))
  const lines = commandsOf(
    snapshot,
    items.filter(item => paths.has(item.path)),
    snapshot.at,
  )
    .split('\n')
    .map(line => line.trim())
    // O --force só entra por submódulo limpo; a guarda cobre qualquer caminho futuro que o emita.
    .filter(line => line !== '' && !line.startsWith('#') && !line.includes('--force'))
  return { lines, count: kept.length, skipped: all.length - kept.length }
}

export function removalPromptOf(lines: readonly string[]): string {
  return ['Linhas a rodar, nesta ordem:', ...lines].join('\n')
}

export type Removal = { at: number; agentId: string | null; allowed: string[] }
export type Listed = { id: string; type: string; status: string }
export type RemovalStep = { step: 'wait' } | { step: 'adopt'; agentId: string } | { step: 'finish' }

export const ENDED = new Set(['completed', 'failed', 'killed', 'idle'])

// Ciclo de vida da remoção, sem timeout que solte a trava com o agente vivo (o maxTurns o limita).
// `listed` é o `$.agent.list()` reduzido, ou null quando a consulta falhou.
export function removalStepOf(removal: Removal, listed: readonly Listed[] | null, now: number): RemovalStep {
  if (listed === null) return { step: 'wait' }
  if (removal.agentId !== null) {
    const agent = listed.find(a => a.id === removal.agentId)
    const isOver = agent === undefined || ENDED.has(agent.status)
    return isOver && now - removal.at >= END_GRACE_MS ? { step: 'finish' } : { step: 'wait' }
  }
  const alive = listed.find(a => a.type === REMOVER_AGENT && !ENDED.has(a.status))
  if (alive !== undefined) return { step: 'adopt', agentId: alive.id }
  return now - removal.at >= SPAWN_GRACE_MS ? { step: 'finish' } : { step: 'wait' }
}

export const LABEL: Record<Verdict, string> = { remove: 'REMOVER', review: 'REVISAR', keep: 'MANTER' }

// "REMOVER (só a pasta)" para o escopo tree; item antigo sem `rule` sai como hoje.
export function labelOf(item: Suggestion): string {
  const isTree = item.rule !== undefined && scopeOf(item.rule) === 'tree'
  return isTree && item.verdict === 'remove' ? `${LABEL.remove} (só a pasta)` : LABEL[item.verdict]
}

// Só a lista, sem comandos: o modelo da sessão lê o retorno de `/workbench stale` e não deve receber comandos prontos.
export function listOf(report: StaleReport | null): string {
  if (report === null) return 'Nenhuma worktree candidata à limpeza.'
  const lines = report.items.map(item => `${labelOf(item)} ${item.branch} (${item.path}): ${item.reason}`)
  const origin = report.source === 'haiku' ? 'Haiku' : 'regra'
  return [`Limpeza sugerida (${origin}):`, ...lines, ...(report.note === null ? [] : [report.note])].join('\n')
}
