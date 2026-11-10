// I/O do fluxo de QA (como collect.ts): recebe `$` e valores, devolve dados. Quem escreve em `$.state` é o register.tsx.
// As regras ficam nos módulos puros (qa.ts, qa-evidence.ts); aqui só arquivo, processo, agente e ferramenta.
import type { EngineInterface } from 'claude-code'

import { repoRoot } from './collect'
import { settle } from './model'
import type { Settled } from './model'
import {
  ANON_PROFILE,
  acceptFixOf,
  argvOf,
  authSummaryOf,
  baseUrlAt,
  checkedDefectsOf,
  commitMessageOf,
  diffCheckOf,
  finalVerdictOf,
  fixQueueOf,
  fixReportOf,
  parseFix,
  parseMatrix,
  parseResult,
  parseVerdict,
  reportOf,
  sessionLoadOf,
  signatureOf,
  startArgvOf,
} from './qa-evidence'
import type { Cell, CellOutcome, CellVerdict, Defect, Evidence, Fix, FixResult, FixStatus, Matrix } from './qa-evidence'
import { guardDecisionOf } from './qa-guard'
import { ENDED } from './stale'
import type { GuardCtx, QaRole } from './qa-guard'
import {
  DETECT_FAIL_RULES,
  QA_TOOLS,
  QA_TYPE,
  VIEW_HEIGHT,
  abWrapperTextOf,
  authEnvOf,
  authFileOf,
  binOf,
  cellDirOf,
  configFileOf,
  fixOutDirOf,
  guardFileOf,
  guardStateTextOf,
  hookCommandOf,
  impWrapperTextOf,
  outcomeOf,
  policyFileOf,
  policyTextOf,
  qaAgentsOf,
  qaRootOf,
  retestDirOf,
  toolsDirOf,
  wrapperOf,
} from './qa'

export type QaEnv = { home: string; root: string; qaRoot: string; guardFile: string }

export async function qaEnvOf($: EngineInterface, token: string): Promise<QaEnv | null> {
  const home = nonEmpty(await settle(() => $.env.get('HOME'))) ?? nonEmpty(await settle(() => $.env.get('USERPROFILE')))
  const found = await repoRoot($)
  if (home === undefined || found === null) return null
  // O hook da trava resolve links simbólicos: o contexto guarda o caminho real, senão o hook nega tudo. Falhou: fica o lido.
  const [realHome, realRoot] = (await run($, ['realpath', home, found]))?.split('\n') ?? []
  const root = realRoot || found
  const qaRoot = qaRootOf(realHome || home, root)
  return { home: realHome || home, root, qaRoot, guardFile: guardFileOf(qaRoot, token) }
}

// Ids dos agentes de QA vivos na lista: entram em `qaGuarded`, para nunca serem adotados como o agente de um item novo.
export async function liveQaIdsOf($: EngineInterface): Promise<string[]> {
  const listed = await settle(() => $.agent.list())
  const types: string[] = Object.values(QA_TYPE)
  return listed.ok ? listed.value.filter(a => types.includes(a.type) && !ENDED.has(a.status)).map(a => a.id) : []
}

// O validate só aceita `$.env.get` com o nome literal, então a leitura fica no chamador.
const nonEmpty = (got: Settled<string | undefined>): string | undefined => (got.ok && got.value !== '' ? got.value : undefined)

// Devolve o motivo quando os tipos travados não puderam ser registrados; null = tudo registrado.
export async function registerQa($: EngineInterface, env: QaEnv, pluginRoot: string): Promise<string | null> {
  const commands = { runner: hookCommandOf(pluginRoot, 'runner', env.guardFile), observer: hookCommandOf(pluginRoot, 'observer', env.guardFile), fixer: hookCommandOf(pluginRoot, 'fixer', env.guardFile) }
  const blocked = Object.values(commands).some(c => c === null)
  const specs = qaAgentsOf(role => commands[role] ?? '').filter(spec => !blocked || spec.hooks === undefined)
  for (const spec of specs) await $.agent.register(spec)
  // `inputSchema` vem tipado como `object` no qa.ts; a cópia por entradas tem a forma que o register pede.
  for (const tool of QA_TOOLS) await $.tool.register({ ...tool, inputSchema: Object.fromEntries(Object.entries(tool.inputSchema)) })
  return blocked ? `QA desligado: o caminho do mod ou da pasta do QA tem um caractere que quebraria o comando da trava (${pluginRoot})` : null
}

export const matrixPathOf = (runDir: string): string => `${runDir}/matriz.md`
const verdictPathOf = (runDir: string, cell: string, attempt: number): string => `${cellDirOf(runDir, cell, attempt)}/veredito.json`
export const reportPathOf = (runDir: string): string => `${runDir}/relatorio.md`
export const originOf = (matrix: Matrix): string => new URL(matrix.baseUrl).origin

export type Loaded = { kind: 'ok'; matrix: Matrix } | { kind: 'missing' } | { kind: 'invalid'; error: string }

export async function loadMatrix($: EngineInterface, runDir: string): Promise<Loaded> {
  const path = matrixPathOf(runDir)
  if (runDir === '' || !(await exists($, path))) return { kind: 'missing' }
  const text = await settle(() => $.fs.read(path))
  if (!text.ok || typeof text.value !== 'string') return { kind: 'invalid', error: 'não deu para ler o matriz.md' }
  const parsed = parseMatrix(text.value)
  return parsed.ok ? { kind: 'ok', matrix: parsed.value } : { kind: 'invalid', error: parsed.error }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  const found = await settle(() => $.fs.exists(path))
  return found.ok && found.value
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  const read = await settle(() => $.fs.read(path))
  return read.ok && typeof read.value === 'string' ? read.value : null
}

// Processo sem shell; qualquer falha (rejeição ou saída diferente de 0) vira null.
async function run($: EngineInterface, argv: string[], cwd?: string): Promise<string | null> {
  const ran = await settle(() => $.process.run(argv, cwd === undefined ? {} : { cwd }))
  return ran.ok && ran.value.exitCode === 0 ? ran.value.stdout : null
}

export async function mkdirs($: EngineInterface, dir: string): Promise<boolean> {
  return (await run($, ['mkdir', '-p', dir])) !== null
}

export async function isLoginOk($: EngineInterface, env: QaEnv, matrix: Matrix, profile: string, now: number): Promise<boolean> {
  const text = await readText($, authFileOf(env.qaRoot, profile))
  const summary = text === null ? null : authSummaryOf(text, originOf(matrix), now)
  return summary !== null && summary.cookies > 0 && summary.expired === 0
}

// Portões do clique Executar, nesta ordem; `back` diz se a etapa volta para o Login.
export async function runGateOf($: EngineInterface, env: QaEnv, matrix: Matrix, now: number): Promise<{ text: string; back: boolean } | null> {
  const tools = toolsDirOf(env.home)
  for (const name of ['agent-browser', 'impeccable'] as const) {
    if (!(await exists($, binOf(tools, name)))) return { text: `QA: falta instalar o ${name}; clique em "QA: Login" de novo.`, back: true }
  }
  for (const profile of matrix.profiles.filter(p => p !== ANON_PROFILE)) {
    if (!(await isLoginOk($, env, matrix, profile, now))) return { text: `QA: o login do perfil ${profile} falta ou venceu; refaça em "QA: Login".`, back: true }
  }
  if ((await run($, ['curl', '-s', '-o', '/dev/null', '--max-time', '5', matrix.baseUrl])) === null) {
    return { text: `QA: o app não respondeu em ${matrix.baseUrl}; suba o app e clique de novo.`, back: false }
  }
  return null
}

// Os scripts que os agentes usam: o navegador já travado (domínios e política) e o impeccable sem telemetria.
export async function writeScripts($: EngineInterface, env: QaEnv, matrix: Matrix): Promise<boolean> {
  const tools = toolsDirOf(env.home)
  const ab = wrapperOf(env.qaRoot, 'ab')
  const imp = wrapperOf(env.qaRoot, 'imp')
  if (!(await mkdirs($, `${env.qaRoot}/bin`))) return false
  await $.fs.write(ab, abWrapperTextOf({ bin: binOf(tools, 'agent-browser'), policy: policyFileOf(env.qaRoot), config: configFileOf(env.qaRoot), domains: matrix.allowedDomains }))
  await $.fs.write(imp, impWrapperTextOf({ bin: binOf(tools, 'impeccable') }))
  await $.fs.write(policyFileOf(env.qaRoot), policyTextOf())
  await $.fs.write(configFileOf(env.qaRoot), '{}')
  return (await run($, ['chmod', '+x', ab, imp])) !== null
}

export async function runBaseOf($: EngineInterface, root: string): Promise<{ head: string; isDirty: boolean } | null> {
  const head = await run($, ['git', 'rev-parse', 'HEAD'], root)
  const status = await run($, ['git', 'status', '--porcelain'], root)
  return head === null || status === null ? null : { head: head.trim(), isDirty: status.trim() !== '' }
}

export async function pendingCellsOf($: EngineInterface, runDir: string, matrix: Matrix): Promise<string[]> {
  const done = await Promise.all(matrix.cells.map(c => exists($, verdictPathOf(runDir, c.id, 1))))
  return matrix.cells.filter((_, i) => !done[i]).map(c => c.id)
}

const ab = (env: QaEnv, session: string, ...args: string[]): string[] => [wrapperOf(env.qaRoot, 'ab'), '--session', session, ...args]

export async function closeSession($: EngineInterface, env: QaEnv, session: string): Promise<void> {
  if (session !== '') await run($, ab(env, session, 'close'))
}

// Injeta a sessão salva do perfil. O arquivo de cookies fica na pasta `auth`, nunca na da execução (que o agente lê).
async function loadAuth($: EngineInterface, env: QaEnv, matrix: Matrix, profile: string, session: string): Promise<boolean> {
  const text = await readText($, authFileOf(env.qaRoot, profile))
  const load = text === null ? null : sessionLoadOf(text, originOf(matrix))
  if (load === null) return false
  const tmp = `${env.qaRoot}/auth/.cookies-${session}.json`
  await $.fs.write(tmp, load.cookies)
  const isSet = (await run($, ab(env, session, 'cookies', 'set', '--curl', tmp))) !== null
  await run($, ['rm', '-f', tmp])
  if (!isSet) return false
  for (const s of load.storage) {
    if ((await run($, ab(env, session, 'storage', s.kind, 'set', s.name, s.value))) === null) return false
  }
  return true
}

// Abre, loga, ajusta a largura e lê a porta de depuração; qualquer passo que falha devolve null.
async function openSession($: EngineInterface, env: QaEnv, matrix: Matrix, cell: Cell, session: string, url: string): Promise<number | null> {
  const isAnon = cell.profile === ANON_PROFILE
  if ((await run($, ab(env, session, 'open', isAnon ? url : `${url}${matrix.loginRoute}`))) === null) return null
  if (!isAnon && !(await loadAuth($, env, matrix, cell.profile, session))) return null
  if ((await run($, ab(env, session, 'set', 'viewport', String(cell.width), String(VIEW_HEIGHT)))) === null) return null
  return cdpPortOf(await run($, ab(env, session, 'get', 'cdp-url')))
}

// `ws://127.0.0.1:<porta>/…` → a porta.
function cdpPortOf(url: string | null): number | null {
  const found = /^ws:\/\/[^/:]+:(\d+)\//.exec(url?.trim() ?? '')?.[1]
  return found === undefined ? null : Number(found)
}

// O navegador da célula já logado e na largura dela; devolve a porta de depuração. Falhou: fecha e devolve null.
// `url`: a do app da worktree na fase Corrigir; a sessão salva continua vindo pela origem da matriz.
export async function prepareSession($: EngineInterface, env: QaEnv, matrix: Matrix, cell: Cell, session: string, url = matrix.baseUrl): Promise<number | null> {
  const port = await settle(() => openSession($, env, matrix, cell, session, url))
  if (port.ok && port.value !== null) return port.value
  await closeSession($, env, session)
  return null
}

export function guardCtxOf(env: QaEnv, matrix: Matrix, runDir: string, session: string, cdpPort: number | null, fixDir = ''): GuardCtx {
  return {
    home: env.home,
    repoRoot: env.root,
    fixDir,
    runDir,
    readDirs: [`${env.home}/.claude/skills/impeccable`],
    agentBrowser: wrapperOf(env.qaRoot, 'ab'),
    impeccable: wrapperOf(env.qaRoot, 'imp'),
    session,
    cdpPort,
    origins: [originOf(matrix)],
    containers: matrix.backend.containers,
  }
}

// Fase Corrigir: os agentes gravam só na pasta do defeito (`correcoes/<defeito>`, onde fica também o reteste); a pasta da
// execução inteira (matriz, vereditos, resultado dos outros defeitos) só é lida.
export function fixGuardCtxOf(env: QaEnv, matrix: Matrix, at: { runDir: string; defect: string; fixDir: string }, session: string, cdpPort: number | null): GuardCtx {
  const ctx = guardCtxOf(env, matrix, fixOutDirOf(at.runDir, at.defect), session, cdpPort, at.fixDir)
  return { ...ctx, readDirs: [...ctx.readDirs, at.runDir] }
}

// A validação da própria trava sobre um contexto de exemplo (o runner lendo a matriz; o corretor lendo um arquivo da worktree):
// o motivo da recusa, null = aceita. O exemplo não toca o disco: cada caminho é o próprio caminho real e todo alvo é arquivo.
export function guardRefusalOf(ctx: GuardCtx, role: QaRole = 'runner'): string | null {
  const probe = { tool_name: 'Read', tool_input: { file_path: probeFileOf(role, ctx.runDir, ctx.fixDir) }, cwd: ctx.repoRoot, agent_id: '' }
  const asIs = { realOf: (p: string) => p, isFile: () => true }
  const got = guardDecisionOf(role, probe, guardStateTextOf(role, null, ctx), asIs)
  return got.decision === 'allow' ? null : got.reason
}

function probeFileOf(role: QaRole, runDir: string, fixDir: string): string {
  switch (role) {
    case 'fixer':
      return `${fixDir}/package.json`
    case 'runner':
    case 'observer':
      return matrixPathOf(runDir)
    default:
      throw new Error('Caso não tratado: ' + String(role satisfies never))
  }
}

// `{ deny }` volta como texto; uma rejeição não prova que o agente não nasceu (agentId null: o timer adota ou encerra).
export async function spawnQa($: EngineInterface, role: QaRole, prompt: string, description: string): Promise<{ agentId: string | null } | { deny: string }> {
  const spawned = await settle(() => $.agent.spawn({ subagentType: QA_TYPE[role], prompt, description }))
  if (!spawned.ok) return { agentId: null }
  if (spawned.value.deny !== undefined) return { deny: spawned.value.deny }
  return { agentId: spawned.value.agentId ?? null }
}

async function verdictIn($: EngineInterface, dir: string): Promise<CellVerdict | null> {
  const text = await readText($, `${dir}/veredito.json`)
  return text === null ? null : parseVerdict(text, DETECT_FAIL_RULES)
}

export async function cellVerdictOf($: EngineInterface, runDir: string, cell: string, attempt: number): Promise<CellVerdict | null> {
  return verdictIn($, cellDirOf(runDir, cell, attempt))
}

// O resultado final de cada célula: o veredito e, quando r2/veredito.json existe, o da repetição.
export async function outcomesOf($: EngineInterface, runDir: string, matrix: Matrix): Promise<Record<string, CellOutcome>> {
  const outcomes: Record<string, CellOutcome> = {}
  for (const cell of matrix.cells) {
    const first = await cellVerdictOf($, runDir, cell.id, 1)
    const second = (await exists($, verdictPathOf(runDir, cell.id, 2))) ? await cellVerdictOf($, runDir, cell.id, 2) : undefined
    outcomes[cell.id] = outcomeOf(cell, first, second)
  }
  return outcomes
}

// Grava o relatorio.md e devolve a contagem.
export async function writeReport($: EngineInterface, runDir: string, matrix: Matrix): Promise<string> {
  const outcomes = await outcomesOf($, runDir, matrix)
  await $.fs.write(reportPathOf(runDir), reportOf({ runId: runDir.split('/').pop() ?? runDir, matrix, outcomes }))
  const counts = new Map<string, number>()
  for (const o of Object.values(outcomes)) counts.set(o.final, (counts.get(o.final) ?? 0) + 1)
  return [...counts].map(([v, n]) => `${v} ${n}`).join(', ')
}

// A ferramenta qa_auth: só contagens, nunca o conteúdo do arquivo de sessão.
export async function authReplyOf($: EngineInterface, env: QaEnv, runDir: string, profile: unknown, now: number): Promise<{ deny: string } | { result: { cookies: number; expired: number }; text: string }> {
  const loaded = await loadMatrix($, runDir)
  if (loaded.kind !== 'ok' || typeof profile !== 'string' || profile === ANON_PROFILE || !loaded.matrix.profiles.includes(profile)) {
    return { deny: 'qa_auth: perfil fora da matriz da execução atual' }
  }
  const text = await readText($, authFileOf(env.qaRoot, profile))
  const summary = (text === null ? null : authSummaryOf(text, originOf(loaded.matrix), now)) ?? { cookies: 0, expired: 0 }
  const isOk = summary.cookies > 0 && summary.expired === 0
  return { result: summary, text: `cookies: ${summary.cookies}, vencidos: ${summary.expired}. ${isOk ? 'serve' : 'não serve: faça o login'}` }
}

// ---- Fase Corrigir ----

const TEN_MIN = 600_000
const APP_TRIES = 30 // com 2 s entre elas: o app tem uns 60 s para responder

// `code` null: o comando não rodou (não começou ou estourou o tempo), que nunca conta como "falhou de propósito".
export type Ran = { code: number | null; out: string }

export async function runFull($: EngineInterface, argv: string[], init: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<Ran> {
  const ran = await settle(() => $.process.run(argv, init))
  return ran.ok ? { code: ran.value.exitCode, out: `${ran.value.stdout}\n${ran.value.stderr}` } : { code: null, out: ran.error }
}

export const tailOf = (out: string): string => out.trim().split('\n').slice(-5).join(' | ').slice(-300)
const git = (dir: string, ...args: string[]): string[] => ['git', '-C', dir, ...args]
// Todo git na worktree de correção passa por aqui. O teto (a pasta `.worktrees` que a contém) impede o git de subir até o
// repositório da raiz quando a pasta perdeu o `.git`: ele falha com "not a git repository" em vez de mexer no checkout do usuário.
const wtGit = (fixDir: string, ...args: string[]): string[] => ['env', `GIT_CEILING_DIRECTORIES=${fixDir.slice(0, fixDir.lastIndexOf('/'))}`, 'git', '-C', fixDir, ...args]

// A pasta da worktree sem o `.git`: a fase para sem rodar nada destrutivo (quem pega é o passo da fase, no register.tsx).
export class LostWorktree extends Error {}

// Antes de todo git destrutivo: a raiz do repositório que o git vê na pasta é a própria worktree.
export async function assertFixDir($: EngineInterface, fixDir: string): Promise<void> {
  if ((await run($, wtGit(fixDir, 'rev-parse', '--show-toplevel')))?.trim() !== fixDir) {
    throw new LostWorktree(`a worktree de correção sumiu (${fixDir}); nada foi desfeito nem commitado nela`)
  }
}

export const fixResultPathOf = (runDir: string, defect: string): string => `${fixOutDirOf(runDir, defect)}.json`
export const fixReportPathOf = (runDir: string): string => `${runDir}/correcoes.md`
export const appMatrixOf = (matrix: Matrix, port: number): Matrix => ({ ...matrix, baseUrl: baseUrlAt(matrix.baseUrl, port) })
// A foto dos vereditos "antes" e dos testes das células, tirada no clique do Corrigir: nenhum agente da fase grava nela.
export const baseDirOf = (runDir: string): string => `${runDir}/antes`

// Os defeitos marcados no relatório, na ordem da fila, e os que ainda não têm `correcoes/<defeito>.json`.
export async function fixQueueAt($: EngineInterface, runDir: string, outcomes: Record<string, CellOutcome>): Promise<{ all: string[]; left: string[] }> {
  const all = fixQueueOf(checkedDefectsOf((await readText($, reportPathOf(runDir))) ?? ''), outcomes)
  const done = await Promise.all(all.map(d => exists($, fixResultPathOf(runDir, d))))
  return { all, left: all.filter((_, i) => !done[i]) }
}

// HEAD, branch e stash do checkout do usuário: o corretor não pode mexer nele.
export async function rootSnapOf($: EngineInterface, root: string): Promise<string> {
  const parts = [await run($, git(root, 'rev-parse', 'HEAD')), await run($, git(root, 'rev-parse', '--abbrev-ref', 'HEAD')), await run($, git(root, 'stash', 'list'))]
  return parts.map(p => p ?? '?').join('\n')
}

export async function headOf($: EngineInterface, fixDir: string): Promise<string> {
  return ((await run($, wtGit(fixDir, 'rev-parse', 'HEAD'))) ?? '').trim()
}

async function worktreeOf($: EngineInterface, root: string, fixDir: string, branch: string): Promise<string | null> {
  if (await exists($, fixDir)) {
    const head = (await run($, wtGit(fixDir, 'rev-parse', '--abbrev-ref', 'HEAD')))?.trim()
    return head === branch ? null : `a pasta ${fixDir} já existe e não é a worktree da branch ${branch}`
  }
  const made = await runFull($, ['git', 'worktree', 'add', fixDir, '-b', branch], { cwd: root, timeoutMs: TEN_MIN })
  return made.code === 0 ? null : `não deu para criar a worktree (${tailOf(made.out)})`
}

const ENV_FILE = /^\.env(\..+)?$/

// Copia os `.env` da raiz que não são versionados, sem ler o conteúdo; devolve as linhas do exclude (null = a cópia falhou).
async function copyEnvFiles($: EngineInterface, root: string, fixDir: string): Promise<string[] | null> {
  const listed = await settle(() => $.fs.list(root))
  const names = listed.ok ? listed.value.filter(e => e.kind === 'file' && ENV_FILE.test(e.name)).map(e => e.name) : []
  const copied: string[] = []
  for (const name of names) {
    if ((await run($, ['git', 'ls-files', '--error-unmatch', name], root)) !== null) continue
    if ((await run($, ['cp', `${root}/${name}`, `${fixDir}/${name}`])) === null) return null
    copied.push(`/${name}`)
  }
  return copied
}

// `.worktrees/` e os `.env` copiados ficam fora do status (e do `git clean`) pelo info/exclude comum.
async function excludeAndCopyEnv($: EngineInterface, root: string, fixDir: string): Promise<boolean> {
  const common = (await run($, ['git', 'rev-parse', '--git-common-dir'], root))?.trim()
  const copied = common ? await copyEnvFiles($, root, fixDir) : null
  if (!common || copied === null) return false
  return appendLines($, `${common.startsWith('/') ? common : `${root}/${common}`}/info/exclude`, ['.worktrees/', ...copied])
}

// Acrescenta ao arquivo as linhas que ele ainda não tem.
async function appendLines($: EngineInterface, file: string, lines: readonly string[]): Promise<boolean> {
  const text = (await readText($, file)) ?? ''
  const add = lines.filter(line => !text.split('\n').includes(line))
  if (add.length === 0) return true
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  return (await settle(() => $.fs.write(file, `${text}${sep}${add.join('\n')}\n`))).ok
}

// A pasta `celulas` da execução copiada para a foto (a cópia começa vazia).
async function snapBase($: EngineInterface, runDir: string): Promise<boolean> {
  const base = baseDirOf(runDir)
  return (await freshDir($, base)) && (await run($, ['cp', '-r', `${runDir}/celulas`, `${base}/celulas`])) !== null
}

// A worktree da correção pronta: criada (ou reaproveitada), conferida pela trava do corretor (no contexto do primeiro defeito),
// com os `.env` não versionados, a foto dos vereditos e as dependências instaladas. Devolve o caminho real e o `git status` de
// base, ou o motivo.
export async function setupWorktree($: EngineInterface, env: QaEnv, matrix: Matrix, at: { runDir: string; defect: string; fixDir: string }, branch: string): Promise<{ fixDir: string; baseline: string } | { error: string }> {
  const made = await worktreeOf($, env.root, at.fixDir, branch)
  if (made !== null) return { error: made }
  const real = (await run($, ['realpath', at.fixDir]))?.trim() || at.fixDir
  const refusal = guardRefusalOf(fixGuardCtxOf(env, matrix, { ...at, fixDir: real }, '', null), 'fixer')
  if (refusal !== null) return { error: `a trava recusaria o corretor na worktree ${real} (${refusal})` }
  if (!(await excludeAndCopyEnv($, env.root, real))) return { error: 'não deu para preparar o info/exclude e os .env da worktree' }
  if (!(await snapBase($, at.runDir))) return { error: `não deu para copiar os vereditos da execução para ${baseDirOf(at.runDir)}` }
  const installed = await runFull($, argvOf(matrix.installCommand), { cwd: real, timeoutMs: TEN_MIN })
  if (installed.code !== 0) return { error: `a instalação (${matrix.installCommand}) falhou: ${tailOf(installed.out)}` }
  const baseline = await run($, wtGit(real, 'status', '--porcelain'))
  return baseline === null ? { error: 'não deu para ler o git status da worktree' } : { fixDir: real, baseline }
}

export async function freePortOf($: EngineInterface): Promise<number | null> {
  const out = await run($, ['node', '-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"])
  const port = Number(out?.trim())
  return Number.isInteger(port) && port > 0 ? port : null
}

export type QaApp = { it: AsyncGenerator<unknown, unknown>; port: number; isDone: boolean }

// O app da worktree, pelo startCommand com a porta. O laço em segundo plano puxa e descarta a saída (o processo vive com ele).
export async function startApp($: EngineInterface, matrix: Matrix, fixDir: string, port: number): Promise<QaApp | null> {
  const it = $.process.spawn({ argv: startArgvOf(matrix, port), cwd: fixDir, env: { QA_PORT: String(port), PORT: String(port) } })
  const app: QaApp = { it, port, isDone: false }
  void (async () => {
    try {
      for await (const piece of it) void piece
    } catch {
      // não subiu: o laço acaba e a espera abaixo desiste
    }
    app.isDone = true
  })()
  const url = baseUrlAt(matrix.baseUrl, port)
  for (let i = 0; i < APP_TRIES && !app.isDone; i++) {
    if ((await run($, ['curl', '-s', '-o', '/dev/null', '--max-time', '2', url])) !== null) return app
    await $.clock.sleep(2_000)
  }
  await stopApp(app)
  return null
}

// `return()` no iterador mata a árvore inteira do processo e libera a porta.
export async function stopApp(app: QaApp | null): Promise<void> {
  if (app !== null && !app.isDone) await settle(() => app.it.return(undefined))
}

// O defeito `célula.defeito` no veredito original da célula.
export async function targetOf($: EngineInterface, runDir: string, matrix: Matrix, defectId: string): Promise<{ cell: Cell; defect: Defect } | null> {
  const [cellId = '', id] = defectId.split('.')
  const cell = matrix.cells.find(c => c.id === cellId)
  const defect = (await cellVerdictOf($, runDir, cellId, 1))?.defects.find(d => d.id === id)
  return cell === undefined || defect === undefined ? null : { cell, defect }
}

// Conferência antes de corrigir: o veredito da tentativa 0 tem um defeito com a mesma assinatura do alvo?
export async function isReproduced($: EngineInterface, runDir: string, defectId: string, target: { cell: Cell; defect: Defect }): Promise<boolean> {
  const verdict = await verdictIn($, retestDirOf(runDir, defectId, 0, target.cell.id))
  return verdict?.defects.some(d => signatureOf(d) === signatureOf(target.defect)) ?? false
}

async function evidenceIn($: EngineInterface, dir: string): Promise<Evidence> {
  const result = await readText($, `${dir}/resultado.json`)
  return { result: result === null ? null : parseResult(result), verdict: await verdictIn($, dir) }
}

export async function judgeOf($: EngineInterface, o: { runDir: string; matrix: Matrix; target: { cell: Cell; defect: Defect }; defectId: string; attempt: number; cells: readonly string[] }): Promise<{ accepted: boolean; reasons: string[] }> {
  const cells = o.matrix.cells.filter(c => o.cells.includes(c.id))
  const before: Record<string, Evidence> = {}
  const after: Record<string, Evidence> = {}
  for (const c of cells) {
    before[c.id] = await evidenceIn($, cellDirOf(baseDirOf(o.runDir), c.id, 1))
    after[c.id] = await evidenceIn($, retestDirOf(o.runDir, o.defectId, o.attempt, c.id))
  }
  return acceptFixOf({ target: { cell: o.target.cell.id, defect: o.target.defect }, cells, before, after })
}

export async function undoFix($: EngineInterface, fixDir: string, sha: string): Promise<void> {
  if (sha === '') return
  await assertFixDir($, fixDir)
  await run($, wtGit(fixDir, 'reset', '-q', '--hard', sha))
  await run($, wtGit(fixDir, 'clean', '-fdq'))
}

// A pasta de um reteste começa vazia: um veredito de uma rodada parada não vale como o desta.
export async function freshDir($: EngineInterface, dir: string): Promise<boolean> {
  return (await run($, ['rm', '-rf', dir])) !== null && (await mkdirs($, dir))
}

export async function statusOf($: EngineInterface, fixDir: string): Promise<string | null> {
  return run($, wtGit(fixDir, 'status', '--porcelain'))
}

// Antes de cada corretor: a pasta de saída existe e o fix.json da tentativa anterior some.
export async function resetFixOut($: EngineInterface, outDir: string): Promise<boolean> {
  return (await mkdirs($, outDir)) && (await run($, ['rm', '-f', `${outDir}/fix.json`])) !== null
}

export type FixCheck = { kind: 'refuse'; reason: string } | { kind: 'unverified'; reason: string } | { kind: 'ok'; regression: string | null; pending: string[] }
type FixIn = { env: QaEnv; matrix: Matrix; runDir: string; defectId: string; fixDir: string; sha: string; baseline: string; port: number }

const refuse = (reason: string): FixCheck => ({ kind: 'refuse', reason })
const unverified = (fix: Fix): FixCheck => ({ kind: 'unverified', reason: fix.reason ?? 'o corretor marcou a correção como não retestável' })

// Etapas b a d: o que mudou vira UM commit feito pelo mod, ou é desfeito. null = commitado (ou nada a commitar e retestável: segue).
async function commitFix($: EngineInterface, o: FixIn, fix: Fix): Promise<FixCheck | null> {
  await assertFixDir($, o.fixDir)
  const isChanged = (await statusOf($, o.fixDir)) !== o.baseline
  const message = commitMessageOf(fix)
  if (!isChanged) return fix.retestable ? refuse('o corretor não mudou nada') : unverified(fix)
  const undone = async (check: FixCheck): Promise<FixCheck> => {
    await undoFix($, o.fixDir, o.sha)
    return check
  }
  if (message === null) return undone(refuse('mudança sem descrição de commit'))
  await run($, wtGit(o.fixDir, 'add', '-A'))
  const nameStatus = (await run($, wtGit(o.fixDir, '-c', 'core.quotepath=off', 'diff', '--cached', '--name-status', o.sha))) ?? ''
  const patch = (await run($, wtGit(o.fixDir, 'diff', '--cached', '-U0', o.sha))) ?? ''
  const checked = diffCheckOf(nameStatus, patch)
  if (checked.migration) return undone({ kind: 'unverified', reason: 'a correção cria migração' })
  if (checked.reasons.length > 0) return undone(refuse(checked.reasons.join('; ')))
  if ((await run($, wtGit(o.fixDir, 'commit', '-q', ...message.flatMap(p => ['-m', p])))) === null) return undone(refuse('o commit da correção falhou'))
  return null
}

// Etapa g: o teste novo FALHA no app original e PASSA no da worktree.
async function regressionOf($: EngineInterface, o: FixIn, fix: Fix): Promise<FixCheck> {
  const file = fix.regressionTest
  if (file === undefined || o.matrix.testDir === '') return { kind: 'ok', regression: file ?? null, pending: ['teste de regressão não rodado'] }
  const auth = Object.fromEntries(o.matrix.profiles.filter(p => p !== ANON_PROFILE).map(p => [authEnvOf(p), authFileOf(o.env.qaRoot, p)]))
  const runAt = (url: string): Promise<Ran> => runFull($, ['npx', 'playwright', 'test', file], { cwd: o.fixDir, env: { ...auth, QA_BASE_URL: url }, timeoutMs: TEN_MIN })
  const original = await runAt(o.matrix.baseUrl)
  if (original.code === null || original.code === 0) return refuse(`o teste de regressão ${file} não falhou no app original`)
  const fixed = await runAt(baseUrlAt(o.matrix.baseUrl, o.port))
  if (fixed.code !== 0) return refuse(`o teste de regressão ${file} não passou no app da worktree (${tailOf(fixed.out)})`)
  return { kind: 'ok', regression: file, pending: [] }
}

// Quando o corretor termina, nesta ordem (a primeira que falha decide): fix.json, commit, testes do projeto, regressão.
export async function checkFix($: EngineInterface, o: FixIn): Promise<FixCheck> {
  const fix = parseFix((await readText($, `${fixOutDirOf(o.runDir, o.defectId)}/fix.json`)) ?? '')
  if (fix === null) return refuse('fix.json ausente ou inválido')
  const committed = await commitFix($, o, fix)
  if (committed !== null) return committed
  if (!fix.retestable) return unverified(fix)
  if (o.matrix.testCommand !== '') {
    const tested = await runFull($, argvOf(o.matrix.testCommand), { cwd: o.fixDir, timeoutMs: TEN_MIN })
    if (tested.code !== 0) return refuse(`os testes do projeto falharam (${tailOf(tested.out)})`)
  }
  return regressionOf($, o, fix)
}

export async function writeFixResult(
  $: EngineInterface,
  o: { runDir: string; matrix: Matrix; fixDir: string; defectId: string; sha: string; status: FixStatus; attempt: number; reasons: string[]; cells: readonly string[]; regression: string | null; pending: string[] },
): Promise<void> {
  const log = o.sha === '' ? null : await run($, wtGit(o.fixDir, 'log', '--format=%h %s', `${o.sha}..HEAD`))
  const retest: FixResult['retest'] = []
  for (const cell of o.matrix.cells.filter(c => o.cells.includes(c.id))) {
    retest.push({ cell: cell.id, verdict: finalVerdictOf(cell, await verdictIn($, retestDirOf(o.runDir, o.defectId, o.attempt, cell.id))) })
  }
  const out = fixOutDirOf(o.runDir, o.defectId)
  const result: FixResult = {
    defect: o.defectId,
    status: o.status,
    attempts: o.attempt,
    commits: (log ?? '').split('\n').filter(l => l.trim() !== ''),
    reasons: o.reasons,
    retest,
    before: `${out}/antes.png`,
    after: `${out}/depois.png`,
    ...(o.regression === null ? {} : { regressionTest: o.regression }),
    pending: o.pending,
  }
  await $.fs.write(fixResultPathOf(o.runDir, o.defectId), JSON.stringify(result, null, 2))
}

// Fim da fila: os testes das células PASS (da foto tirada no clique) vão para a pasta de testes da worktree, num commit próprio.
export async function commitPassTests($: EngineInterface, runDir: string, matrix: Matrix, outcomes: Record<string, CellOutcome>, fixDir: string): Promise<void> {
  if (matrix.testDir === '') return
  const dir = `${fixDir}/${matrix.testDir}`
  const copied: string[] = []
  for (const cell of matrix.cells.filter(c => outcomes[c.id]?.final === 'PASS')) {
    const src = `${cellDirOf(baseDirOf(runDir), cell.id, 1)}/teste.spec.ts`
    const dst = `${dir}/qa-${cell.id}.spec.ts`
    if ((await exists($, src)) && (await mkdirs($, dir)) && (await run($, ['cp', src, dst])) !== null) copied.push(cell.id)
  }
  if (copied.length === 0) return
  await assertFixDir($, fixDir)
  await run($, wtGit(fixDir, 'add', '--', ...copied.map(id => `${matrix.testDir}/qa-${id}.spec.ts`)))
  const from = `Vieram de celulas/<id>/teste.spec.ts da execução ${runDir.split('/').pop() ?? runDir}, das células que passaram: ${copied.join(', ')}.`
  await run($, wtGit(fixDir, 'commit', '-q', '-m', 'Testes de regressão gerados pelo QA', '-m', from))
}

const NO_HOOKS = 'Os commits foram feitos sem os hooks de pré-commit do repositório: rode o lint e o formatador antes de abrir a PR.'

// O correcoes.md a partir dos `correcoes/<defeito>.json` gravados; devolve o caminho.
export async function writeFixReport($: EngineInterface, runDir: string, defects: readonly string[]): Promise<string> {
  const results: FixResult[] = []
  for (const d of defects) {
    const parsed = await settle(async () => JSON.parse((await readText($, fixResultPathOf(runDir, d))) ?? 'null'))
    if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object') results.push(parsed.value)
  }
  const path = fixReportPathOf(runDir)
  await $.fs.write(path, `${fixReportOf(results)}${NO_HOOKS}\n`)
  return path
}
