// Regras puras do workbench: sem `$`, sem I/O. O collect.ts traz a saída do git e do gh; aqui só se decide.
import type { PrRef, PrState, PushState, Row, Snapshot } from '../types'

export type Worktree = { path: string; branch: string; head: string; isPrunable: boolean; isLocked: boolean }

function blocksOf(porcelain: string): string[] {
  return porcelain.split(/\n\n+/)
}

// A primeira entrada do porcelain é sempre o checkout principal: fica de fora, assim como worktree destacada.
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  let isFirst = true
  for (const block of blocksOf(porcelain)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (path === undefined) continue
    if (isFirst) {
      isFirst = false
      continue
    }
    if (head === undefined || branch === undefined) continue
    out.push({ path, branch, head, isPrunable: /^prunable\b/m.test(block), isLocked: /^locked\b/m.test(block) })
  }
  return out
}

export type DetachedEntry = { path: string; head: string }

// Destacadas sem diretório e sem trava: `git worktree prune` as limpa e apaga o reflog delas.
export function parseDetachedPrunable(porcelain: string): DetachedEntry[] {
  const out: DetachedEntry[] = []
  let isFirst = true
  for (const block of blocksOf(porcelain)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined) continue
    if (isFirst) {
      isFirst = false
      continue
    }
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]
    const isDetached = !/^branch /m.test(block)
    if (head !== undefined && isDetached && /^prunable\b/m.test(block) && !/^locked\b/m.test(block)) out.push({ path, head })
  }
  return out
}

export type PushInfo = { push: PushState; unpushed: number }

export type Upstream = PushInfo & { lastCommitAt: number | null }

// Formato esperado: `%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(committerdate:unix)` por linha.
export function parseRefs(text: string): Map<string, Upstream> {
  const out = new Map<string, Upstream>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const [branch = '', upstream = '', track = '', committed = ''] = line.split('\t')
    out.set(branch, { ...pushStateOf(upstream, track), lastCommitAt: commitMs(committed) })
  }
  return out
}

// `%(committerdate:unix)` vem em segundos; o resto do mod trabalha em milissegundos.
function commitMs(seconds: string): number | null {
  const value = Number(seconds)
  return seconds !== '' && Number.isFinite(value) && value > 0 ? value * 1000 : null
}

export function pushStateOf(upstream: string, track: string): PushInfo {
  if (upstream === '') return { push: 'none', unpushed: 0 }
  if (track.includes('gone')) return { push: 'gone', unpushed: 0 }
  const ahead = /ahead (\d+)/.exec(track)?.[1]
  if (ahead !== undefined) return { push: 'unpushed', unpushed: Number(ahead) }
  return { push: 'ok', unpushed: 0 }
}

type GhPr = { number: number; headRefName: string; headRefOid: string; state: string }

function isGhPr(value: unknown): value is GhPr {
  if (typeof value !== 'object' || value === null) return false
  return (
    'number' in value && typeof value.number === 'number' &&
    'headRefName' in value && typeof value.headRefName === 'string' &&
    'headRefOid' in value && typeof value.headRefOid === 'string' &&
    'state' in value && typeof value.state === 'string'
  )
}

function isPrState(state: string): state is PrState {
  return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED'
}

// O gh lista da PR mais nova para a mais antiga: vale a primeira por branch, salvo uma aberta depois dela.
export function parsePrs(json: string): Map<string, PrRef> {
  const out = new Map<string, PrRef>()
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) return out
  for (const item of parsed) {
    if (!isGhPr(item) || !isPrState(item.state)) continue
    const known = out.get(item.headRefName)
    if (known !== undefined && (known.state === 'OPEN' || item.state !== 'OPEN')) continue
    out.set(item.headRefName, { number: item.number, state: item.state, headOid: item.headRefOid })
  }
  return out
}

const MIGRATION = /(?:^|\/)(\d{14})_[^/]+/

export function latestMigration(paths: string): string | null {
  let latest: string | null = null
  for (const line of paths.split('\n')) {
    const stamp = MIGRATION.exec(line)?.[1]
    if (stamp !== undefined && (latest === null || stamp > latest)) latest = stamp
  }
  return latest
}

// Migration que a branch adiciona com timestamp anterior à última da base: o Prisma a aplicaria fora de ordem.
export function staleMigrations(addedPaths: string, baseLatest: string | null): string[] {
  if (baseLatest === null) return []
  const names = new Set<string>()
  for (const line of addedPaths.split('\n')) {
    const match = MIGRATION.exec(line)
    if (match?.[1] !== undefined && match[1] < baseLatest) names.add(match[0].replace(/^\//, ''))
  }
  return [...names].sort()
}

export function parseCounts(text: string): { behind: number; ahead: number } {
  const [behind = '0', ahead = '0'] = text.trim().split(/\s+/)
  return { behind: Number(behind), ahead: Number(ahead) }
}

export function issueOf(branch: string): string | null {
  return /(?:^|\/)(\d{3,5})(?=-|$)/.exec(branch)?.[1] ?? null
}

// --- Coleta: pequenas peças puras que o collect.ts usa ---

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string }

// Isola uma falha: quem chama decide se ela vira erro de uma linha ou de todo o painel.
export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Roda `fn` sobre os itens com no máximo `limit` em voo, devolvendo os resultados na ordem de entrada.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index] as T, index)
    }
  }
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, worker))
  return out
}

// `git status --porcelain`: uma linha por arquivo alterado ou não rastreado.
export function countDirty(status: string): number {
  return status.split('\n').filter(line => line.trim() !== '').length
}

// Resolve `.` e `..` de um caminho absoluto e tira a barra final.
export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// Em uma worktree, `.git` é um arquivo com `gitdir: <caminho>`, absoluto ou relativo à árvore.
export function gitdirOf(text: string, treePath: string): string | null {
  const raw = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (raw === undefined) return null
  return normalizePath(raw.startsWith('/') ? raw : `${treePath}/${raw}`)
}

// `cwd` é a própria worktree ou fica dentro dela; compara por segmento, então `/a` não casa com `/ab`.
export function isInside(cwd: string, path: string): boolean {
  if (cwd === '' || path === '') return false
  const inner = normalizePath(cwd)
  const outer = normalizePath(path)
  return inner === outer || inner.startsWith(outer === '/' ? '/' : `${outer}/`)
}

// A atividade de uma worktree é a mais recente entre o último commit, o reflog dela (criação, checkout) e o index
// (add, commit, checkout e, às vezes, `git status` de outra sessão ou IDE: sinal extra, não garantido).
export function activityOf(commitAt: number | null, reflogAt: number | null, indexAt: number | null): number | null {
  const known = [commitAt, reflogAt, indexAt].filter((at): at is number => at !== null)
  return known.length === 0 ? null : Math.max(...known)
}

function agoLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `há ${hours}h`
  return `há ${Math.floor(hours / 24)}d`
}

export function fetchAgeLabel(fetchedAt: number | null, now: number): string {
  return fetchedAt === null ? 'sem fetch' : `fetch ${agoLabel(fetchedAt, now)}`
}

// Base velha esconde "atrás da base" e migrations: acima de 2h (ou sem fetch nenhum) o painel avisa.
export function isFetchStale(fetchedAt: number | null, now: number): boolean {
  return fetchedAt === null || now - fetchedAt > 2 * 3_600_000
}

// Saída do find+awk do collect.ts: "<blocos de 512 B> <linhas>". Zero linhas = o find não imprimiu nem a pasta raiz
// (find sem -printf, pasta inacessível): null, nunca 0.
export function parseOwnKb(stdout: string): number | null {
  const m = /^(\d+)\s+(\d+)$/.exec(stdout.trim())
  if (m === null || Number(m[2]) === 0) return null
  return Math.round(Number(m[1]) / 2)
}

export function sizeLabel(kb: number): string {
  if (kb < 1024) return `${kb} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
}

export function totalSizeKb(rows: readonly Row[]): number {
  return rows.reduce((sum, r) => sum + (r.ownKb ?? 0), 0)
}

// Espaço que os caminhos dados liberam (só o que já foi medido).
export function freedKb(rows: readonly Row[], removePaths: ReadonlySet<string>): number {
  return totalSizeKb(rows.filter(r => removePaths.has(r.path)))
}

export function idleDays(row: Row, now: number): number | null {
  return row.lastActivityAt === null ? null : Math.max(0, Math.floor((now - row.lastActivityAt) / 86_400_000))
}

// --- Apresentação ---

// Sem a lista do gh não se sabe se há PR: "sem PR" ali seria afirmação falsa.
export function stateOf(row: Row, isPrKnown: boolean): string {
  if (!isPrKnown) return 'PR ?'
  if (row.pr === null) return 'sem PR'
  if (row.pr.state === 'OPEN') return `PR #${row.pr.number} aberta`
  if (row.pr.state === 'CLOSED') return `PR #${row.pr.number} fechada`
  return row.pr.headOid === row.head ? `PR #${row.pr.number} mergeada` : `PR #${row.pr.number} mergeada, HEAD andou`
}

export function pushLabel(row: Row): string {
  if (row.push === 'none') return 'sem push'
  if (row.push === 'gone') return 'remota apagada'
  if (row.push === 'unpushed') return `${row.unpushed} sem push`
  return 'push ok'
}

export function stampLabel(row: Row): string {
  if (row.isStamped === null) return ''
  return row.isStamped ? 'carimbado' : 'sem carimbo'
}

// Ordem de atenção: erro ou migration fora de ordem, trabalho sem PR, PR aberta, o que já entrou e, no fim, o que não tem diretório.
function rank(row: Row): number {
  if (row.isPrunable) return 4
  if (row.error !== null || row.staleMigrations.length > 0) return 0
  if (row.pr === null) return 1
  if (row.pr.state === 'OPEN') return 2
  return 3
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.ahead - a.ahead || a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path))
}

export function flagsOf(row: Row): string {
  if (row.isPrunable) return 'PRUNE'
  if (row.error !== null) return 'ERRO'
  if (row.staleMigrations.length > 0) return `MIG ${row.staleMigrations.length}`
  if (row.isLocked) return 'LOCK'
  return ''
}

export function lineOf(row: Row, isPrKnown: boolean, isSelected: boolean): string {
  const mark = isSelected ? '›' : ' '
  const flag = flagsOf(row).padEnd(7)
  const issue = (row.issue === null ? '' : `#${row.issue}`).padEnd(6)
  const distance = `${row.ahead}↑ ${row.behind}↓`.padEnd(9)
  const dirty = row.dirty !== null && row.dirty > 0 ? ` · ±${row.dirty}` : ''
  const size = row.ownKb === null ? '' : ` · ${sizeLabel(row.ownKb)}`
  const stamp = stampLabel(row) === '' ? '' : ` · ${stampLabel(row)}`
  return `${mark} ${flag} ${issue} ${distance} ${pushLabel(row)}${dirty}${size}${stamp} · ${stateOf(row, isPrKnown)} · ${row.branch}`
}

export type Counts = { total: number; noPr: number; open: number; merged: number; stale: number; dirty: number; prunable: number }

export function countsOf(rows: Row[]): Counts {
  return {
    total: rows.length,
    noPr: rows.filter(r => r.pr === null).length,
    open: rows.filter(r => r.pr?.state === 'OPEN').length,
    merged: rows.filter(r => r.pr?.state === 'MERGED' && r.pr.headOid === r.head).length,
    stale: rows.filter(r => r.staleMigrations.length > 0).length,
    dirty: rows.filter(r => (r.dirty ?? 0) > 0).length,
    prunable: rows.filter(r => r.isPrunable).length,
  }
}

export function summaryOf(snapshot: Snapshot): string {
  const c = countsOf(snapshot.rows)
  const parts = [`${c.total} worktrees`]
  if (snapshot.isPrKnown) parts.push(`${c.noPr} sem PR`, `${c.open} PR aberta`)
  else parts.push('PRs indisponíveis')
  if (c.stale > 0) parts.push(`${c.stale} migration atrás da base`)
  if (c.dirty > 0) parts.push(`${c.dirty} com mudanças locais`)
  if (c.prunable > 0) parts.push(`${c.prunable} sem diretório`)
  if (c.merged > 0) parts.push(`${c.merged} mergeadas`)
  const totalKb = totalSizeKb(snapshot.rows)
  if (totalKb > 0) parts.push(`${sizeLabel(totalKb)} exclusivos`)
  return `workbench: ${parts.join(' · ')}`
}

// O texto da faixa fixa (a única fonte do resumo: o mod não escreve na statusline). Sem leitura anterior e com erro, mostra
// só o erro; com dados, o resumo e, havendo, a contagem de removíveis.
export function bandOf(snapshot: Snapshot, removable: number): string {
  const [firstError] = snapshot.errors
  if (snapshot.root === '' && firstError !== undefined) return `workbench: erro (${firstError.slice(0, 80)})`
  return removable > 0 ? `${summaryOf(snapshot)} · ${removable} removíveis` : summaryOf(snapshot)
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

// Seção 3 do TEMPLATE de handoff (crm-artifacts/handoff-2026-10-06/TEMPLATE.md), preenchida a partir do snapshot.
export function handoffTable(snapshot: Snapshot): string {
  const head = [
    '## 3. Trabalho em voo (NÃO mergeado)',
    `Gerado pelo workbench contra \`${snapshot.base}\` (${snapshot.baseHead}); ${fetchAgeLabel(snapshot.fetchedAt, snapshot.at)}.`,
    '| Item | Issue | Branch | Worktree | HEAD | Push? | Estado | Bundle de backup |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const lines = sortRows(snapshot.rows)
    .filter(r => !(r.pr?.state === 'MERGED' && r.pr.headOid === r.head))
    .map(r => {
      const alerts = r.staleMigrations.length > 0 ? `; migration atrás da base: ${r.staleMigrations.join(', ')}` : ''
      const stamp = stampLabel(r) === '' ? '' : `; ${stampLabel(r)}`
      const dirty = r.dirty !== null && r.dirty > 0 ? `; ${r.dirty} arquivos não commitados` : ''
      const prunable = r.isPrunable ? '; worktree prunable' : ''
      const size = r.ownKb === null ? '' : `; ${sizeLabel(r.ownKb)} exclusivos em disco`
      const state = `${stateOf(r, snapshot.isPrKnown)}; ${r.ahead} à frente, ${r.behind} atrás${stamp}${dirty}${size}${alerts}${prunable}`
      return `| ${cell(r.branch)} | ${r.issue === null ? '—' : `#${r.issue}`} | \`${cell(r.branch)}\` | \`${cell(r.path)}\` | ${r.head.slice(0, 9)} | ${pushLabel(r)} | ${cell(state)} | — |`
    })
  return [...head, ...lines].join('\n')
}
