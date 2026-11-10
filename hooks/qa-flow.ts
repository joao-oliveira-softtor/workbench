// I/O do fluxo de QA (como collect.ts): recebe `$` e valores, devolve dados. Quem escreve em `$.state` é o register.tsx.
// As regras ficam nos módulos puros (qa.ts, qa-evidence.ts); aqui só arquivo, processo, agente e ferramenta.
import type { EngineInterface } from 'claude-code'

import { repoRoot } from './collect'
import { settle } from './model'
import type { Settled } from './model'
import { ANON_PROFILE, authSummaryOf, parseMatrix, parseVerdict, reportOf, sessionLoadOf } from './qa-evidence'
import type { Cell, CellOutcome, CellVerdict, Matrix } from './qa-evidence'
import { guardDecisionOf } from './qa-guard'
import type { GuardCtx, QaRole } from './qa-guard'
import {
  DETECT_FAIL_RULES,
  QA_TOOLS,
  QA_TYPE,
  VIEW_HEIGHT,
  abWrapperTextOf,
  authFileOf,
  binOf,
  cellDirOf,
  configFileOf,
  guardFileOf,
  guardStateTextOf,
  hookCommandOf,
  impWrapperTextOf,
  outcomeOf,
  policyFileOf,
  policyTextOf,
  qaAgentsOf,
  qaRootOf,
  toolsDirOf,
  wrapperOf,
} from './qa'

export type QaEnv = { home: string; root: string; qaRoot: string; guardFile: string }

export async function qaEnvOf($: EngineInterface, token: string): Promise<QaEnv | null> {
  const home = nonEmpty(await settle(() => $.env.get('HOME'))) ?? nonEmpty(await settle(() => $.env.get('USERPROFILE')))
  const root = await repoRoot($)
  if (home === undefined || root === null) return null
  const qaRoot = qaRootOf(home, root)
  return { home, root, qaRoot, guardFile: guardFileOf(qaRoot, token) }
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
async function openSession($: EngineInterface, env: QaEnv, matrix: Matrix, cell: Cell, session: string): Promise<number | null> {
  const isAnon = cell.profile === ANON_PROFILE
  if ((await run($, ab(env, session, 'open', isAnon ? matrix.baseUrl : `${matrix.baseUrl}${matrix.loginRoute}`))) === null) return null
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
export async function prepareSession($: EngineInterface, env: QaEnv, matrix: Matrix, cell: Cell, session: string): Promise<number | null> {
  const port = await settle(() => openSession($, env, matrix, cell, session))
  if (port.ok && port.value !== null) return port.value
  await closeSession($, env, session)
  return null
}

export function guardCtxOf(env: QaEnv, matrix: Matrix, runDir: string, session: string, cdpPort: number | null): GuardCtx {
  return {
    home: env.home,
    repoRoot: env.root,
    fixDir: '',
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

// A validação da própria trava sobre um contexto de exemplo (o runner lendo a matriz): o motivo da recusa, null = aceita.
// O exemplo não toca o disco: cada caminho é o próprio caminho real e todo alvo é arquivo.
export function guardRefusalOf(env: QaEnv, matrix: Matrix, runDir: string): string | null {
  const probe = { tool_name: 'Read', tool_input: { file_path: matrixPathOf(runDir) }, cwd: env.root, agent_id: '' }
  const asIs = { realOf: (p: string) => p, isFile: () => true }
  const got = guardDecisionOf('runner', probe, guardStateTextOf('runner', null, guardCtxOf(env, matrix, runDir, '', null)), asIs)
  return got.decision === 'allow' ? null : got.reason
}

// `{ deny }` volta como texto; uma rejeição não prova que o agente não nasceu (agentId null: o timer adota ou encerra).
export async function spawnQa($: EngineInterface, role: QaRole, prompt: string, description: string): Promise<{ agentId: string | null } | { deny: string }> {
  const spawned = await settle(() => $.agent.spawn({ subagentType: QA_TYPE[role], prompt, description }))
  if (!spawned.ok) return { agentId: null }
  if (spawned.value.deny !== undefined) return { deny: spawned.value.deny }
  return { agentId: spawned.value.agentId ?? null }
}

export async function cellVerdictOf($: EngineInterface, runDir: string, cell: string, attempt: number): Promise<CellVerdict | null> {
  const text = await readText($, verdictPathOf(runDir, cell, attempt))
  return text === null ? null : parseVerdict(text, DETECT_FAIL_RULES)
}

// Lê os vereditos (e o da repetição, quando r2/veredito.json existe), grava o relatorio.md e devolve a contagem.
export async function writeReport($: EngineInterface, runDir: string, matrix: Matrix): Promise<string> {
  const outcomes: Record<string, CellOutcome> = {}
  for (const cell of matrix.cells) {
    const first = await cellVerdictOf($, runDir, cell.id, 1)
    const second = (await exists($, verdictPathOf(runDir, cell.id, 2))) ? await cellVerdictOf($, runDir, cell.id, 2) : undefined
    outcomes[cell.id] = outcomeOf(cell, first, second)
  }
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
