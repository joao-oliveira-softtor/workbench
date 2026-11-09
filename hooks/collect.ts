// I/O do workbench: git, gh, arquivos e a chamada ao Haiku. Devolve dados; quem escreve em `$.state` é o register.tsx.
// Regra de ouro: uma falha local (uma worktree, o gh) vira dado da linha ou do snapshot, nunca derruba o painel inteiro.
import type { EngineInterface, ModelEffort, ModelUsage } from 'claude-code'

import type { PrRef, Row, Snapshot } from '../types'
import {
  activityOf,
  countDirty,
  gitdirOf,
  isInside,
  issueOf,
  latestMigration,
  mapLimit,
  parseCounts,
  parseDetachedPrunable,
  parseOwnKb,
  parsePrs,
  parseRefs,
  parseWorktrees,
  settle,
  staleMigrations,
} from './model'
import type { Upstream, Worktree } from './model'
import { ANALYZE_MAX_TOKENS, ANALYZE_RULES, ANALYZE_TIMEOUT_MS, analyzePromptOf } from './compact'
import { REFINE_MAX_TOKENS, REFINE_RULES, REFINE_TIMEOUT_MS } from './plan'
import { ROUTE_EFFORT, ROUTE_MAX_TOKENS, ROUTE_RULES, ROUTE_TIMEOUT_MS, buildRoutePrompt } from './route'
import { RULES, candidatesOf } from './stale'

const MIGRATIONS = 'apps/api/prisma/migrations'
const DEFAULT_BASE = 'origin/main'
const GH_TTL_MS = 3 * 60_000
const CONCURRENCY = 4
// A medida roda em segundo plano (pode levar segundos): vale 30 min e o painel mostra a velha enquanto refaz.
const SIZE_TTL_MS = 30 * 60_000
const SIZE_CONCURRENCY = 2
const SIZE_TIMEOUT_MS = 120_000

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  const run = await $.process.run(['git', ...args], { cwd, timeoutMs: 60_000 })
  if (run.exitCode !== 0) throw new Error(`git ${args[0] ?? ''}: ${firstLine(run.stderr)}`)
  return run.stdout
}

// Chave do carimbo por SHA (depende só da árvore), calculada pelo script da própria worktree. Podada a cada coleta.
const keyBySha = new Map<string, string>()

// Lista do gh guardada por alguns minutos e por repositório; `force` (botão r, gh pr, git push) a ignora.
let ghCache: { root: string; at: number; stdout: string } | null = null

// Por caminho de worktree. `kb: null` = a medida falhou; também vale pelo TTL, para não repetir a falha a cada tick.
const sizeCache = new Map<string, { kb: number | null; at: number }>()

// Worktrees vivas sem medida ou com medida vencida.
export function unsizedPaths(rows: readonly Row[], now: number): string[] {
  return rows
    .filter(r => !r.isPrunable && r.error === null && now - (sizeCache.get(r.path)?.at ?? -Infinity) >= SIZE_TTL_MS)
    .map(r => r.path)
}

// Espaço exclusivo: arquivos com 1 link (hardlink do cache do bun/pnpm fica de fora) e diretórios. A soma sai do awk
// numa linha só, longe do teto de stdout. `-xdev` não atravessa montagens. Exige GNU find (`-printf`); sem ele, null.
// Permissão negada em parte da árvore dá soma parcial: limite inferior, aceito. O caminho vai como $1, nunca no script.
const OWN_SCRIPT = 'find "$1" -xdev \\( -type f -links 1 -o -type d \\) -printf "%b\\n" | awk "{s+=\\$1} END {print s+0, NR}"'

async function ownKb($: EngineInterface, tree: string): Promise<number | null> {
  const run = await settle(() => $.process.run(['sh', '-c', OWN_SCRIPT, 'sh', tree], { timeoutMs: SIZE_TIMEOUT_MS }))
  if (!run.ok || run.value.isStdoutTruncated) return null
  return parseOwnKb(run.value.stdout)
}

export async function measureSizes($: EngineInterface, paths: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  await mapLimit(paths, SIZE_CONCURRENCY, async path => {
    // Falha da medida não apaga a última boa.
    const kb = (await ownKb($, path)) ?? sizeCache.get(path)?.kb ?? null
    sizeCache.set(path, { kb, at: await $.clock.now() })
    out.set(path, kb)
  })
  return out
}

async function stampOf($: EngineInterface, tree: string, stamps: string, head: string): Promise<boolean | null> {
  const script = `${tree}/scripts/ci/local.sh`
  const found = await settle(() => $.fs.exists(script))
  if (!found.ok || !found.value) return null
  let key = keyBySha.get(head)
  if (key === undefined) {
    const run = await settle(() => $.process.run(['bash', script, 'key', head], { cwd: tree, timeoutMs: 30_000 }))
    if (!run.ok || run.value.exitCode !== 0 || run.value.stdout.trim() === '') return null
    key = run.value.stdout.trim()
    keyBySha.set(head, key)
  }
  const stamp = await settle(() => $.fs.read(`${stamps}/${key}`))
  return stamp.ok
}

export async function baseFor($: EngineInterface, root: string): Promise<string> {
  const stored = await $.store.get(`base:${root}`)
  return typeof stored === 'string' && stored !== '' ? stored : DEFAULT_BASE
}

// null fora de um repositório git, ou quando o cwd da sessão já não existe.
export async function repoRoot($: EngineInterface): Promise<string | null> {
  const cwd = await settle(() => $.session.cwd())
  if (!cwd.ok) return null
  const run = await settle(() => $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: cwd.value }))
  if (!run.ok || run.value.exitCode !== 0) return null
  // O diretório comum é <checkout principal>/.git: a mesma raiz de qualquer worktree.
  return run.value.stdout.trim().replace(/\/\.git\/?$/, '')
}

type GhResult = { prs: Map<string, PrRef> | null; error: string | null }

async function ghPrs($: EngineInterface, root: string, force: boolean): Promise<GhResult> {
  const now = await $.clock.now()
  let stdout: string
  if (!force && ghCache !== null && ghCache.root === root && now - ghCache.at < GH_TTL_MS) {
    stdout = ghCache.stdout
  } else {
    const run = await settle(() =>
      $.process.run(['gh', 'pr', 'list', '--state', 'all', '--limit', '3000', '--json', 'number,headRefName,headRefOid,state'], {
        cwd: root,
        timeoutMs: 120_000,
      }),
    )
    if (!run.ok) return { prs: null, error: `gh: ${firstLine(run.error)}` }
    if (run.value.exitCode !== 0) return { prs: null, error: `gh: ${firstLine(run.value.stderr) || 'falhou'}` }
    stdout = run.value.stdout
  }
  const parsed = await settle(async () => parsePrs(stdout))
  if (!parsed.ok) {
    ghCache = null
    return { prs: null, error: 'gh: resposta inválida' }
  }
  ghCache = { root, at: now, stdout }
  return { prs: parsed.value, error: null }
}

async function dirtyOf($: EngineInterface, tree: string): Promise<number | null> {
  // `--no-optional-locks`: nunca pega o index.lock e quebra um commit de outra sessão nessa worktree.
  const run = await settle(() =>
    $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'], { cwd: tree, timeoutMs: 60_000 }),
  )
  return run.ok && run.value.exitCode === 0 ? countDirty(run.value.stdout) : null
}

type GitInfo = { reflog: number | null; index: number | null; hasModules: boolean | null }

async function mtimeOf($: EngineInterface, path: string): Promise<number | null> {
  const stat = await settle(() => $.fs.stat(path))
  return stat.ok ? stat.value.mtimeMs : null
}

// Lê só o gitdir da worktree: o reflog (criação, checkout, commit), o index e se há submódulo inicializado
// (`<gitdir>/modules`). Quem decide o que fazer com isso são as regras puras.
async function gitInfoOf($: EngineInterface, tree: string): Promise<GitInfo> {
  const dot = await settle(() => $.fs.read(`${tree}/.git`))
  const gitdir = dot.ok ? gitdirOf(dot.value, tree) : null
  if (gitdir === null) return { reflog: null, index: null, hasModules: null }
  const [logs, head, index, modules] = await Promise.all([
    mtimeOf($, `${gitdir}/logs/HEAD`),
    mtimeOf($, `${gitdir}/HEAD`),
    mtimeOf($, `${gitdir}/index`),
    settle(() => $.fs.exists(`${gitdir}/modules`)),
  ])
  return { reflog: logs ?? head, index, hasModules: modules.ok ? modules.value : null }
}

// `git worktree remove` recusa worktree com submódulo inicializado sem `--force`, e o `--force` apaga junto o gitdir do
// submódulo. Só 'clean' (nenhum arquivo alterado e nenhum commit fora das remotas, em todo submódulo) libera o --force.
// Qualquer falha conta como 'unsafe'.
async function submodulesOf($: EngineInterface, tree: string): Promise<'clean' | 'unsafe'> {
  const check = 'git --no-optional-locks status --porcelain --untracked-files=normal | head -n 1; git rev-list -n 1 HEAD --not --remotes'
  const run = await settle(() =>
    $.process.run(['git', '--no-optional-locks', 'submodule', 'foreach', '--quiet', '--recursive', check], { cwd: tree, timeoutMs: 60_000 }),
  )
  return run.ok && run.value.exitCode === 0 && run.value.stdout.trim() === '' ? 'clean' : 'unsafe'
}

type Shared = {
  root: string
  base: string
  baseMigration: string | null
  refs: Map<string, Upstream>
  prs: Map<string, PrRef>
  cwd: string
}

async function rowOf($: EngineInterface, s: Shared, tree: Worktree): Promise<Row> {
  const upstream = s.refs.get(tree.branch) ?? { push: 'none' as const, unpushed: 0, lastCommitAt: null }
  const common = {
    branch: tree.branch,
    path: tree.path,
    head: tree.head,
    issue: issueOf(tree.branch),
    push: upstream.push,
    unpushed: upstream.unpushed,
    pr: s.prs.get(tree.branch) ?? null,
    lastCommitAt: upstream.lastCommitAt,
    isPrunable: tree.isPrunable,
    isLocked: tree.isLocked,
    ownKb: tree.isPrunable ? null : (sizeCache.get(tree.path)?.kb ?? null),
    isCurrent: isInside(s.cwd, tree.path),
  }
  const range = `${s.base}...${tree.head}`
  const counts = await settle(async () => parseCounts(await git($, s.root, ['rev-list', '--left-right', '--count', range])))
  if (tree.isPrunable) {
    // Sem diretório: nenhum processo roda dentro dela. Os contadores vêm do root e, se falharem, ficam em 0.
    const { behind, ahead } = counts.ok ? counts.value : { behind: 0, ahead: 0 }
    const gone = { staleMigrations: [], isStamped: null, dirty: null, lastActivityAt: null, submodules: null, error: null }
    return { ...common, ahead, behind, ...gone }
  }
  const failed = (message: string): Row => ({
    ...common, ahead: 0, behind: 0, staleMigrations: [], isStamped: null, dirty: null, lastActivityAt: null, submodules: null, error: message,
  })
  if (!counts.ok) return failed(counts.error)
  const added = await settle(async () =>
    s.baseMigration === null ? '' : git($, s.root, ['diff', '--name-only', '--diff-filter=A', range, '--', MIGRATIONS]),
  )
  if (!added.ok) return failed(added.error)
  const [dirty, isStamped, info] = await Promise.all([
    dirtyOf($, tree.path),
    stampOf($, tree.path, `${s.root}/.git/ci-local/stamps`, tree.head),
    gitInfoOf($, tree.path),
  ])
  return {
    ...common,
    ahead: counts.value.ahead,
    behind: counts.value.behind,
    staleMigrations: staleMigrations(added.value, s.baseMigration),
    isStamped,
    dirty,
    lastActivityAt: activityOf(upstream.lastCommitAt, info.reflog, info.index),
    // Com submódulo, null até a conferência (feita só nas candidatas, no collect).
    submodules: info.hasModules === false ? 'none' : null,
    error: null,
  }
}

// null fora de um repositório. Erros globais (base inexistente, `worktree list`) sobem: o chamador os mostra no painel.
export async function collect($: EngineInterface, o: { force: boolean }): Promise<Snapshot | null> {
  const root = await repoRoot($)
  if (root === null) return null
  const base = await baseFor($, root)
  const errors: string[] = []
  const baseHead = (await git($, root, ['rev-parse', '--short', base])).trim()
  const porcelain = await git($, root, ['worktree', 'list', '--porcelain'])
  const trees = parseWorktrees(porcelain)
  const refs = parseRefs(
    await git($, root, [
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)',
      'refs/heads',
    ]),
  )
  const baseMigration = latestMigration(await git($, root, ['ls-tree', '--name-only', base, `${MIGRATIONS}/`]))

  const gh = await ghPrs($, root, o.force)
  if (gh.error !== null) errors.push(gh.error)
  const cwd = await settle(() => $.session.cwd())
  const fetched = await settle(() => $.fs.stat(`${root}/.git/FETCH_HEAD`))

  const shared: Shared = { root, base, baseMigration, refs, prs: gh.prs ?? new Map(), cwd: cwd.ok ? cwd.value : '' }
  const collected = await mapLimit(trees, CONCURRENCY, tree => rowOf($, shared, tree))
  // Submódulo só pesa na limpeza: confere só as candidatas vivas, que são as que podem ganhar comando.
  const now = await $.clock.now()
  const toCheck = new Set(
    candidatesOf(collected, { now, isPrKnown: gh.prs !== null })
      .filter(c => !c.row.isPrunable && c.row.submodules === null)
      .map(c => c.row.path),
  )
  const rows = await mapLimit(collected, CONCURRENCY, async row =>
    toCheck.has(row.path) ? { ...row, submodules: await submodulesOf($, row.path) } : row,
  )
  // `git worktree prune` também limpa as destacadas sem diretório: confere se o commit delas está em alguma ref.
  const detachedPrunable = await mapLimit(parseDetachedPrunable(porcelain), CONCURRENCY, async d => {
    const refsWith = await settle(() => git($, root, ['for-each-ref', '--contains', d.head, '--count=1', '--format=%(refname)']))
    return { path: d.path, head: d.head, isReachable: refsWith.ok && refsWith.value.trim() !== '' }
  })

  const heads = new Set(rows.map(row => row.head))
  for (const key of keyBySha.keys()) if (!heads.has(key)) keyBySha.delete(key)

  return {
    root,
    base,
    baseHead,
    baseMigration,
    rows,
    detachedPrunable,
    isPrKnown: gh.prs !== null,
    fetchedAt: fetched.ok ? fetched.value.mtimeMs : null,
    errors,
    at: await $.clock.now(),
  }
}

export type Asked = { ok: true; text: string; usage?: ModelUsage } | { ok: false; reason: string; isAborted: boolean }

// Sem opções vale o que a limpeza de worktrees sempre usou: Haiku, `RULES`, teto de 2500 tokens e 60 s.
export type AskOptions = { model?: string; system?: string; effort?: ModelEffort; maxTokens?: number; timeoutMs?: number }

// `$.model.complete` rejeita só quando o engine recusa enviar (modelo fora da allowlist); o resto vem como `isAnswered: false`.
// O nome ficou por ser o chamador de sempre; `opts.model` troca o modelo (a análise de compactação usa o Sonnet).
export async function askHaiku($: EngineInterface, prompt: string, opts: AskOptions = {}): Promise<Asked> {
  const run = await settle(() =>
    $.model.complete({
      model: opts.model ?? 'haiku',
      system: opts.system ?? RULES,
      prompt,
      effort: opts.effort,
      maxTokens: opts.maxTokens ?? 2500,
      timeoutMs: opts.timeoutMs ?? 60_000,
    }),
  )
  if (!run.ok) return { ok: false, reason: `modelo indisponível (${firstLine(run.error).slice(0, 80)})`, isAborted: false }
  const result = run.value
  if (!result.isAnswered) return { ok: false, reason: result.reason, isAborted: result.reason === 'aborted' }
  return { ok: true, text: result.text, usage: result.usage }
}

// Análise da sessão antes de compactar: o Sonnet lê a conversa e devolve o JSON de `parseAnalysis`.
export function askAnalysis($: EngineInterface, transcript: string): Promise<Asked> {
  return askHaiku($, analyzePromptOf(transcript), { model: 'sonnet', system: ANALYZE_RULES, maxTokens: ANALYZE_MAX_TOKENS, timeoutMs: ANALYZE_TIMEOUT_MS })
}

// Refinamento do Planejar: o Sonnet reescreve a intenção do campo e devolve o JSON de `parseRefine`.
export function askRefine($: EngineInterface, prompt: string): Promise<Asked> {
  return askHaiku($, prompt, { model: 'sonnet', system: REFINE_RULES, maxTokens: REFINE_MAX_TOKENS, timeoutMs: REFINE_TIMEOUT_MS })
}

// Classificação do /route manual: regras da skill, effort alto e teto curto de resposta.
export function askRoute($: EngineInterface, task: string): Promise<Asked> {
  return askHaiku($, buildRoutePrompt(task), { system: ROUTE_RULES, effort: ROUTE_EFFORT, maxTokens: ROUTE_MAX_TOKENS, timeoutMs: ROUTE_TIMEOUT_MS })
}
