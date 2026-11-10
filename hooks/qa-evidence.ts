// Evidência do QA: puro, sem `$`, sem I/O e sem relógio (testável). Os agentes de QA gravam JSON numa pasta de execução;
// aqui o código confere esses arquivos e decide o veredito de cada teste e o aceite de cada correção.
// Todo JSON que chega aqui foi escrito por um agente de IA: é entrada de fora, e o que não confere é recusado, nunca consertado.
import type { Settled } from './model'
import { jsonObjectIn } from './route'

export type Risk = 'alto' | 'medio' | 'baixo'
export const WIDTHS = [360, 768, 1280] as const
export type Width = (typeof WIDTHS)[number]
export type Criterion = { given: string; when: string; then: string }
export type Cell = {
  id: string
  requirement: string
  risk: Risk
  flow: string
  route: string
  profile: string
  width: Width
  reason: string
  steps: string[]
  criteria: Criterion[]
  expectedStatus: { url: string; status: number }[]
}
export type Matrix = {
  baseUrl: string
  loginRoute: string
  installCommand: string
  startCommand: string
  testCommand: string
  testDir: string // pasta dos testes Playwright, relativa à raiz do repositório; '' sem Playwright
  backend: { containers: string[] }
  profiles: string[]
  requirements: { id: string; text: string; source: string }[]
  cells: Cell[]
  cut: string[]
}
export type CellResult = {
  id: string
  startedAt: string
  endedAt: string
  completed: boolean
  steps: { n: number; action: string; url: string; screenshot: string; text: string }[]
  console: { type: string; text: string }[]
  pageErrors: string[]
  error?: string
}
export const SOURCES = ['impeccable-detect', 'geometria', 'rede', 'console', 'criterio', 'impeccable-audit', 'pergunta-visual'] as const
export type Source = (typeof SOURCES)[number]
export type Defect = {
  id: string
  kind: 'design' | 'funcional'
  source: Source
  rule?: string
  where: string
  text?: string // texto visível do elemento apontado em `where` (defeito de design)
  severity: 'fail' | 'candidate'
  repro: string[]
}
export type Verdict = 'AMBIENTE' | 'FAIL-AGENTE' | 'FAIL-APP' | 'FAIL-VISUAL' | 'INSTÁVEL' | 'CANDIDATO-VISUAL' | 'PASS' | 'NÃO VERIFICADO'
export type CellVerdict = {
  id: string
  verdict: Verdict
  evidence: { criterion: number; proof: string }[]
  defects: Defect[]
  backend: 'lido' | 'indisponível'
}
export type CellOutcome = { final: Verdict; verdict: CellVerdict | null }
export type Evidence = { result: CellResult | null; verdict: CellVerdict | null }
export type FixStatus = 'corrigido' | 'não reverificado' | 'não reproduzido na worktree' | 'desistiu'
export type Fix = { retestable: boolean; reason?: string; regressionTest?: string; subject?: string; body?: string[] }
export type FixResult = {
  defect: string
  status: FixStatus
  attempts: number
  commits: string[]
  reasons: string[]
  retest: { cell: string; verdict: Verdict }[]
  before: string
  after: string
  regressionTest?: string
  pending: string[]
}

// Identificadores viram nome de pasta: sem `/`, `.` nem `..`.
const ID = '[a-z0-9][a-z0-9-]{0,30}'
const CELL_ID = new RegExp(`^${ID}$`)
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,30}$/
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
// O mod roda os comandos por vetor de argumentos, sem shell: nada de aspas nem metacaractere.
const COMMAND_CHARS = /^[A-Za-z0-9 _.:/=@+,-]*$/
const PORT_MARK = /\{QA_PORT\}/g
const MAX_CELLS = 12

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

// Objeto próprio: um id como `constructor` não pode achar entrada herdada do protótipo.
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined)

function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

function attempt<T>(fn: () => T): Settled<T> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function orNull<T>(fn: () => T): T | null {
  const r = attempt(fn)
  return r.ok ? r.value : null
}

function recOf(v: unknown, at: string): Rec {
  need(isRec(v), `${at}: precisa ser um objeto`)
  return v
}

function textAt(o: Rec, key: string, at = ''): string {
  const v = o[key]
  need(typeof v === 'string', `${at}${key}: precisa ser texto`)
  return v
}

function listAt(o: Rec, key: string, at = ''): unknown[] {
  const v = o[key]
  need(Array.isArray(v), `${at}${key}: precisa ser uma lista`)
  return v
}

function stringsAt(o: Rec, key: string, at = ''): string[] {
  const list = listAt(o, key, at)
  list.forEach((v, i) => need(typeof v === 'string', `${at}${key}[${i}]: precisa ser texto`))
  return list as string[]
}

function intAt(o: Rec, key: string, at: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key]
  need(typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max, `${at}${key}: precisa ser um inteiro entre ${min} e ${max}`)
  return v
}

function optionalTextAt(o: Rec, key: string, at: string): string | undefined {
  const v = o[key]
  need(v === undefined || typeof v === 'string', `${at}${key}: precisa ser texto`)
  return v
}

function oneOf<T extends string | number>(allowed: readonly T[], v: unknown, at: string): T {
  need(allowed.includes(v as T), `${at}: precisa ser um de ${allowed.join(', ')}`)
  return v as T
}

// Identificador no padrão; com `seen`, também sem repetição.
function identAt(v: unknown, re: RegExp, at: string, seen?: Set<string>): string {
  need(typeof v === 'string' && re.test(v), `${at}: identificador fora do padrão ${re.source}`)
  need(!seen?.has(v), `${at}: "${v}" repetido`)
  seen?.add(v)
  return v
}

function routeAt(o: Rec, key: string, at = ''): string {
  const v = textAt(o, key, at)
  need(/^\/(?![/\\])/.test(v), `${at}${key}: precisa começar com um só "/"`)
  return v
}

function baseUrlOf(o: Rec): string {
  const v = textAt(o, 'baseUrl')
  const u = attempt(() => new URL(v))
  need(u.ok, 'baseUrl: não é uma URL')
  const { protocol, hostname, username, password, pathname } = u.value
  const local = hostname === 'localhost' || hostname === '127.0.0.1'
  need(
    (protocol === 'http:' || protocol === 'https:') && local && username === '' && password === '' && pathname === '/' && !/[?#\s]/.test(v),
    'baseUrl: só http(s) em localhost ou 127.0.0.1, sem usuário, senha, caminho, query nem hash',
  )
  return v
}

// Caminho relativo à raiz do repositório; vira argumento de comando, então nada de `..`, `~`, `\`, segmento vazio ou só de
// pontos, segmento que comece com `-` (leria como opção) nem caractere fora da lista. Só `''` é vazio (e só se `required` for falso).
function relPathAt(o: Rec, key: string, opts: { required: boolean }, at = ''): string {
  const v = textAt(o, key, at)
  need(!opts.required || v !== '', `${at}${key}: não pode ser vazio`)
  need(
    v === '' || v.split('/').every(seg => /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(seg) && !/^\.+$/.test(seg)),
    `${at}${key}: precisa ser um caminho relativo, sem segmento vazio, "." nem "..", sem "-" no começo de segmento, só com letras, números e _ . / -`,
  )
  return v
}

function commandAt(o: Rec, key: string, opts: { required: boolean; port?: boolean }): string {
  const v = textAt(o, key)
  need(!opts.required || v.trim() !== '', `${key}: não pode ser vazio`)
  need(COMMAND_CHARS.test(opts.port ? v.replace(PORT_MARK, '') : v), `${key}: só letras, números, espaço e _ . : / = @ + , - (sem aspas nem shell)`)
  return v
}

function cellAt(raw: unknown, i: number, known: { requirements: Set<string>; profiles: Set<string> }, seen: Set<string>): Cell {
  const at = `cells[${i}].`
  const o = recOf(raw, `cells[${i}]`)
  const id = identAt(o.id, CELL_ID, `${at}id`, seen)
  const requirement = textAt(o, 'requirement', at)
  need(known.requirements.has(requirement), `${at}requirement: "${requirement}" não existe em requirements`)
  const profile = textAt(o, 'profile', at)
  need(known.profiles.has(profile), `${at}profile: "${profile}" não existe em profiles`)
  const steps = stringsAt(o, 'steps', at)
  need(steps.length > 0, `${at}steps: precisa ter ao menos um passo`)
  const criteria = listAt(o, 'criteria', at).map((c, j): Criterion => {
    const cat = `${at}criteria[${j}].`
    const r = recOf(c, `${at}criteria[${j}]`)
    return { given: textAt(r, 'given', cat), when: textAt(r, 'when', cat), then: textAt(r, 'then', cat) }
  })
  need(criteria.length > 0, `${at}criteria: precisa ter ao menos um critério`)
  const expectedStatus = listAt(o, 'expectedStatus', at).map((e, j) => {
    const eat = `${at}expectedStatus[${j}].`
    const r = recOf(e, `${at}expectedStatus[${j}]`)
    return { url: textAt(r, 'url', eat), status: intAt(r, 'status', eat, 100, 599) }
  })
  return {
    id,
    requirement,
    risk: oneOf(['alto', 'medio', 'baixo'] as const, o.risk, `${at}risk`),
    flow: textAt(o, 'flow', at),
    route: routeAt(o, 'route', at),
    profile,
    width: oneOf(WIDTHS, o.width, `${at}width`),
    reason: textAt(o, 'reason', at),
    steps,
    criteria,
    expectedStatus,
  }
}

function matrixOf(markdown: string): Matrix {
  const blocks = [...markdown.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g)]
  need(blocks.length === 1, `matriz.md precisa ter exatamente um bloco json (achei ${blocks.length})`)
  const m = recOf(jsonObjectIn(blocks[0]?.[1] ?? ''), 'bloco json')
  const baseUrl = baseUrlOf(m)
  const loginRoute = routeAt(m, 'loginRoute')
  const installCommand = commandAt(m, 'installCommand', { required: true })
  const startCommand = commandAt(m, 'startCommand', { required: true, port: true })
  const testCommand = commandAt(m, 'testCommand', { required: false })
  const testDir = relPathAt(m, 'testDir', { required: false })
  const containers = stringsAt(recOf(m.backend, 'backend'), 'containers', 'backend.')
  containers.forEach((c, i) => identAt(c, CONTAINER_ID, `backend.containers[${i}]`))
  const profiles = stringsAt(m, 'profiles')
  const seenProfiles = new Set<string>()
  profiles.forEach((p, i) => identAt(p, PROFILE_ID, `profiles[${i}]`, seenProfiles))
  const seenReqs = new Set<string>()
  const requirements = listAt(m, 'requirements').map((r, i) => {
    const at = `requirements[${i}].`
    const o = recOf(r, `requirements[${i}]`)
    return { id: identAt(o.id, CELL_ID, `${at}id`, seenReqs), text: textAt(o, 'text', at), source: textAt(o, 'source', at) }
  })
  const rawCells = listAt(m, 'cells')
  need(rawCells.length >= 1 && rawCells.length <= MAX_CELLS, `cells: precisa ter de 1 a ${MAX_CELLS} células (achei ${rawCells.length})`)
  const seenCells = new Set<string>()
  const cells = rawCells.map((c, i) => cellAt(c, i, { requirements: seenReqs, profiles: seenProfiles }, seenCells))
  return { baseUrl, loginRoute, installCommand, startCommand, testCommand, testDir, backend: { containers }, profiles, requirements, cells, cut: stringsAt(m, 'cut') }
}

// `matriz.md` é texto livre com exatamente um bloco ```json; o erro vai para um aviso na tela.
export function parseMatrix(markdown: string): Settled<Matrix> {
  return attempt(() => matrixOf(markdown))
}

// O comando já passou no parseMatrix: sem aspas, então quebrar por espaço em branco basta.
export function argvOf(command: string): string[] {
  return command.split(/\s+/).filter(Boolean)
}

export function startArgvOf(matrix: Matrix, port: number): string[] {
  return argvOf(matrix.startCommand).map(arg => arg.replace(PORT_MARK, String(port)))
}

export function baseUrlAt(baseUrl: string, port: number): string {
  const u = new URL(baseUrl)
  u.port = String(port)
  return u.origin
}

export function parseResult(text: string): CellResult | null {
  return orNull(() => {
    const o = recOf(jsonObjectIn(text), 'resultado')
    const error = optionalTextAt(o, 'error', '')
    const steps = listAt(o, 'steps').map((s, i) => {
      const at = `steps[${i}].`
      const r = recOf(s, `steps[${i}]`)
      return { n: intAt(r, 'n', at), action: textAt(r, 'action', at), url: textAt(r, 'url', at), screenshot: textAt(r, 'screenshot', at), text: textAt(r, 'text', at) }
    })
    const logs = listAt(o, 'console').map((c, i) => {
      const r = recOf(c, `console[${i}]`)
      return { type: textAt(r, 'type', `console[${i}].`), text: textAt(r, 'text', `console[${i}].`) }
    })
    const completed = o.completed
    need(typeof completed === 'boolean', 'completed: precisa ser verdadeiro ou falso')
    return {
      id: identAt(o.id, CELL_ID, 'id'),
      startedAt: textAt(o, 'startedAt'),
      endedAt: textAt(o, 'endedAt'),
      completed,
      steps,
      console: logs,
      pageErrors: stringsAt(o, 'pageErrors'),
      ...(error === undefined ? {} : { error }),
    }
  })
}

// `fix.json` do agente corretor. `regressionTest` é o teste que o MOD roda duas vezes, então é caminho e nada mais.
// Texto de uma linha só (sem controle nem separador de linha), com algo visível e de até `max` caracteres (o commit sai por código, a partir disto).
function lineOf(v: unknown, max: number, at: string): string {
  need(typeof v === 'string' && /[^\s\u200b-\u200d\ufeff]/.test(v) && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v), `${at}: precisa ser texto de uma linha, não vazio, com até ${max} caracteres`)
  return v
}

export function parseFix(text: string): Fix | null {
  return orNull(() => {
    const o = recOf(jsonObjectIn(text), 'fix')
    need(typeof o.retestable === 'boolean', 'retestable: precisa ser verdadeiro ou falso')
    const reason = optionalTextAt(o, 'reason', '')
    const regressionTest = o.regressionTest === undefined ? undefined : relPathAt(o, 'regressionTest', { required: true })
    const subject = o.subject === undefined ? undefined : lineOf(o.subject, 120, 'subject')
    const rawBody = o.body === undefined ? undefined : listAt(o, 'body')
    need(rawBody === undefined || subject !== undefined, 'body: precisa de subject')
    need(rawBody === undefined || rawBody.length <= 10, 'body: no máximo 10 parágrafos')
    const body = rawBody?.map((p, i) => lineOf(p, 500, `body[${i}]`))
    return {
      retestable: o.retestable,
      ...(reason === undefined ? {} : { reason }),
      ...(regressionTest === undefined ? {} : { regressionTest }),
      ...(subject === undefined ? {} : { subject }),
      ...(body === undefined ? {} : { body }),
    }
  })
}

const ATTRIBUTION = /co-authored-by\s*:|generated\s+with/i

// Parágrafos da mensagem do commit; o mod commita, então a atribuição nunca entra (no assunto, invalida).
export function commitMessageOf(fix: Fix): string[] | null {
  if (fix.subject === undefined || ATTRIBUTION.test(fix.subject)) return null
  return [fix.subject, ...(fix.body ?? []).filter(p => !ATTRIBUTION.test(p))]
}

// Sessão salva do navegador (`auth/<perfil>.json`): é segredo. Nada aqui devolve nem cita um `value` em mensagem de erro.
type Stored = { name: string; value: string }
type Saved = { cookies: Rec[]; origins: { origin: string; local: Stored[]; session: Stored[] }[] }

function storedAt(o: Rec, key: string, at: string): Stored[] {
  return o[key] === undefined ? [] : listAt(o, key, at).map((e, i) => {
    const r = recOf(e, `${at}${key}[${i}]`)
    return { name: textAt(r, 'name', `${at}${key}[${i}].`), value: textAt(r, 'value', `${at}${key}[${i}].`) }
  })
}

function savedOf(text: string): Saved {
  const o = recOf(JSON.parse(text), 'sessão')
  const cookies = listAt(o, 'cookies').map((c, i) => {
    const at = `cookies[${i}].`
    const r = recOf(c, `cookies[${i}]`)
    textAt(r, 'name', at)
    textAt(r, 'value', at)
    textAt(r, 'domain', at)
    need(typeof r.expires === 'number', `${at}expires: precisa ser número`)
    return r
  })
  const origins = listAt(o, 'origins').map((x, i) => {
    const at = `origins[${i}].`
    const r = recOf(x, `origins[${i}]`)
    return { origin: textAt(r, 'origin', at), local: storedAt(r, 'localStorage', at), session: storedAt(r, 'sessionStorage', at) }
  })
  return { cookies, origins }
}

// Só cookie que vale para o hostname da origem do app (`domain` igual ou com ponto na frente). Só http(s): `data:`, `about:`,
// `file:` e `mailto:` não têm hostname, e o `.origin` deles é "null" dos dois lados (casaria cookie e storage que não são do app).
// shortcut: cookie de domínio-pai (`.exemplo.com` para `http://app.exemplo.com`) é descartado, melhorar se um app guardar a sessão no domínio-pai.
function mineOf(text: string, origin: string): { cookies: Rec[]; origins: Saved['origins']; origin: string } {
  const url = new URL(origin)
  need(url.protocol === 'http:' || url.protocol === 'https:', 'origem: só http ou https')
  const saved = savedOf(text)
  const cookies = saved.cookies.filter(c => c.domain === url.hostname || c.domain === `.${url.hostname}`)
  return { cookies, origins: saved.origins, origin: url.origin }
}

// `now` em milissegundos; `expires` do arquivo em segundos, e -1 é cookie de sessão.
export function authSummaryOf(text: string, origin: string, now: number): { cookies: number; expired: number } | null {
  return orNull(() => {
    const { cookies } = mineOf(text, origin)
    return { cookies: cookies.length, expired: cookies.filter(c => c.expires !== -1 && (c.expires as number) * 1000 <= now).length }
  })
}

// O que o mod injeta num navegador novo: `cookies` é o texto que `cookies set --curl <arquivo>` aceita.
export function sessionLoadOf(text: string, origin: string): { cookies: string; storage: { kind: 'local' | 'session'; name: string; value: string }[] } | null {
  return orNull(() => {
    const mine = mineOf(text, origin)
    const here = mine.origins.filter(x => orNull(() => new URL(x.origin).origin) === mine.origin)
    return {
      cookies: JSON.stringify(mine.cookies),
      storage: [
        ...here.flatMap(x => x.local.map(e => ({ kind: 'local' as const, ...e }))),
        ...here.flatMap(x => x.session.map(e => ({ kind: 'session' as const, ...e }))),
      ],
    }
  })
}

// O código decide a gravidade, não o agente: opinião de modelo nunca reprova.
function severityOf(source: Source, rule: string | undefined, failRules: readonly string[]): Defect['severity'] {
  switch (source) {
    case 'impeccable-audit':
    case 'pergunta-visual':
      return 'candidate'
    case 'impeccable-detect':
      return rule !== undefined && failRules.includes(rule) ? 'fail' : 'candidate'
    case 'geometria':
    case 'rede':
    case 'console':
    case 'criterio':
      return 'fail'
    default:
      throw new Error('Caso não tratado: ' + String(source satisfies never))
  }
}

// O tipo também sai da fonte; só `criterio` aceita o que o agente informou.
function kindOf(source: Source, informed: Defect['kind']): Defect['kind'] {
  switch (source) {
    case 'impeccable-detect':
    case 'geometria':
    case 'impeccable-audit':
    case 'pergunta-visual':
      return 'design'
    case 'rede':
    case 'console':
      return 'funcional'
    case 'criterio':
      return informed
    default:
      throw new Error('Caso não tratado: ' + String(source satisfies never))
  }
}

function defectAt(raw: unknown, i: number, failRules: readonly string[], seen: Set<string>): Defect {
  const at = `defects[${i}].`
  const o = recOf(raw, `defects[${i}]`)
  const id = identAt(o.id, CELL_ID, `${at}id`, seen)
  const source = oneOf(SOURCES, o.source, `${at}source`)
  const rule = optionalTextAt(o, 'rule', at)
  need(source !== 'criterio' || (rule !== undefined && /^(0|[1-9]\d*)$/.test(rule)), `${at}rule: defeito de critério exige o índice do critério`)
  const where = textAt(o, 'where', at)
  need(where.trim() !== '', `${at}where: não pode ser vazio`)
  const text = optionalTextAt(o, 'text', at)
  // O campo tem que existir e ser válido, mesmo que o código decida o valor final.
  const informedKind = oneOf(['design', 'funcional'] as const, o.kind, `${at}kind`)
  oneOf(['fail', 'candidate'] as const, o.severity, `${at}severity`)
  return {
    id,
    kind: kindOf(source, informedKind),
    source,
    ...(rule === undefined ? {} : { rule }),
    where,
    ...(text === undefined ? {} : { text }),
    severity: severityOf(source, rule, failRules),
    repro: stringsAt(o, 'repro', at),
  }
}

// `INSTÁVEL` e `NÃO VERIFICADO` só o mod decide: se o agente escrever um deles, o veredito inteiro é inválido.
const AGENT_VERDICTS = ['AMBIENTE', 'FAIL-AGENTE', 'FAIL-APP', 'FAIL-VISUAL', 'CANDIDATO-VISUAL', 'PASS'] as const satisfies readonly Verdict[]

export function parseVerdict(text: string, failRules: readonly string[]): CellVerdict | null {
  return orNull(() => {
    const o = recOf(jsonObjectIn(text), 'veredito')
    const seen = new Set<string>()
    return {
      id: identAt(o.id, CELL_ID, 'id'),
      verdict: oneOf(AGENT_VERDICTS, o.verdict, 'verdict'),
      evidence: listAt(o, 'evidence').map((e, i) => {
        const r = recOf(e, `evidence[${i}]`)
        return { criterion: intAt(r, 'criterion', `evidence[${i}].`), proof: textAt(r, 'proof', `evidence[${i}].`) }
      }),
      defects: listAt(o, 'defects').map((d, i) => defectAt(d, i, failRules, seen)),
      backend: oneOf(['lido', 'indisponível'] as const, o.backend, 'backend'),
    }
  })
}

const hasProof = (v: CellVerdict, i: number): boolean => v.evidence.some(e => e.criterion === i && e.proof.trim() !== '')

export function finalVerdictOf(cell: Cell, verdict: CellVerdict | null): Verdict {
  if (verdict === null || verdict.id !== cell.id) return 'NÃO VERIFICADO'
  switch (verdict.verdict) {
    case 'AMBIENTE':
    case 'FAIL-AGENTE':
      return verdict.verdict
    case 'FAIL-APP':
      // Falha sem registro não conta.
      return verdict.defects.some(d => d.severity === 'fail') ? 'FAIL-APP' : 'NÃO VERIFICADO'
    case 'FAIL-VISUAL':
    case 'CANDIDATO-VISUAL':
    case 'PASS': {
      const fails = verdict.defects.filter(d => d.severity === 'fail')
      if (fails.some(d => d.kind === 'funcional')) return 'FAIL-APP'
      if (fails.length > 0) return 'FAIL-VISUAL'
      if (cell.criteria.some((_, i) => !hasProof(verdict, i))) return 'NÃO VERIFICADO'
      return verdict.defects.length > 0 ? 'CANDIDATO-VISUAL' : 'PASS'
    }
    case 'INSTÁVEL':
    case 'NÃO VERIFICADO':
      return 'NÃO VERIFICADO'
    default:
      throw new Error('Caso não tratado: ' + String(verdict.verdict satisfies never))
  }
}

// A célula que falhou é repetida uma vez; se o veredito mudou, ela é instável.
export const isUnstable = (first: Verdict, second: Verdict): boolean => first !== second

// Compara texto de tela sem que um contador ou uma data recusem uma correção certa.
export const normalizedTextOf = (text: string): string => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

// O ponto não existe nos identificadores, então separa sem ambiguidade (e vira nome de pasta).
export const defectIdOf = (cellId: string, defectId: string): string => `${cellId}.${defectId}`

// Identidade de um defeito entre duas execuções (o `id` muda a cada execução).
export function signatureOf(defect: Defect): string {
  const head = `${defect.source}|${defect.rule ?? ''}`
  return defect.source === 'impeccable-audit' || defect.source === 'pergunta-visual' ? head : `${head}|${normalizedTextOf(defect.where)}`
}

type Outcomes = Readonly<Record<string, CellOutcome>>

const VERDICTS = ['AMBIENTE', 'FAIL-AGENTE', 'FAIL-APP', 'FAIL-VISUAL', 'INSTÁVEL', 'CANDIDATO-VISUAL', 'PASS', 'NÃO VERIFICADO'] as const satisfies readonly Verdict[]

const finalOf = (outcomes: Outcomes, id: string): Verdict => own(outcomes, id)?.final ?? 'NÃO VERIFICADO'

// Texto escrito pelo agente vai em UMA linha: uma quebra de linha não pode forjar uma linha `- [x]`.
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function boxOf(final: Verdict, defect: Defect): string {
  if (final === 'INSTÁVEL') return '(instável)'
  return defect.severity === 'fail' && (final === 'FAIL-APP' || final === 'FAIL-VISUAL') ? '[x]' : '[ ]'
}

function defectLines(cellId: string, final: Verdict, d: Defect): string[] {
  const source = d.rule === undefined ? d.source : `${d.source}:${oneLine(d.rule)}`
  return [`- ${boxOf(final, d)} ${defectIdOf(cellId, d.id)} · ${d.kind} · ${source} · ${oneLine(d.where)}`, ...d.repro.map((s, i) => `  ${i + 1}. ${oneLine(s)}`)]
}

export function reportOf(input: { runId: string; matrix: Matrix; outcomes: Outcomes }): string {
  const { matrix, outcomes } = input
  const finals = matrix.cells.map(c => finalOf(outcomes, c.id))
  const trace = matrix.requirements.flatMap(r => {
    const mine = matrix.cells.filter(c => c.requirement === r.id)
    return [
      `### ${r.id} · ${oneLine(r.text)}`,
      ...(mine.length === 0
        ? ['- (nenhuma célula)']
        : mine.map(c => `- ${c.id} · ${oneLine(c.flow)} · ${c.profile} · ${c.width}px · risco ${c.risk} · ${finalOf(outcomes, c.id)}`)),
    ]
  })
  const defects = matrix.cells.flatMap(c => (own(outcomes, c.id)?.verdict?.defects ?? []).flatMap(d => defectLines(c.id, finalOf(outcomes, c.id), d)))
  const proofs = matrix.cells.flatMap(c => {
    const final = finalOf(outcomes, c.id)
    if (final !== 'PASS' && final !== 'CANDIDATO-VISUAL') return []
    const verdict = own(outcomes, c.id)?.verdict
    return [
      `### ${c.id}`,
      ...c.criteria.map((_, i) => `- critério ${i}: ${oneLine(verdict?.evidence.find(e => e.criterion === i && e.proof.trim() !== '')?.proof ?? '(sem prova)')}`),
    ]
  })
  return [
    `# QA ${oneLine(input.runId)} · ${matrix.baseUrl}`,
    '',
    ...VERDICTS.map(v => `- ${v}: ${finals.filter(f => f === v).length}`),
    '',
    'Desmarque (`[ ]`) o que você não quer corrigir e clique em "QA: Corrigir". Os testes gerados ficam em `celulas/<id>/teste.spec.ts`.',
    '',
    '## Rastreabilidade',
    ...trace,
    '',
    '## Defeitos',
    ...defects,
    '',
    '## Provas',
    ...proofs,
    '',
    '## Cortes',
    ...matrix.cut.map(item => `- ${oneLine(item)}`),
    '',
  ].join('\n')
}

// Só casa a linha no formato exato que o reportOf grava.
const CHECKED_LINE = new RegExp(`^- \\[[xX]\\] (${ID}\\.${ID}) · `)

export function checkedDefectsOf(relatorio: string): string[] {
  return relatorio.split('\n').flatMap(line => CHECKED_LINE.exec(line)?.[1] ?? [])
}

export function fixQueueOf(checked: readonly string[], outcomes: Outcomes): string[] {
  const kinds = new Map<string, Defect['kind']>() // o Map tira os repetidos e guarda a ordem
  for (const id of checked) {
    const [cell, defect, ...rest] = id.split('.')
    if (cell === undefined || defect === undefined || rest.length > 0) continue
    const outcome = own(outcomes, cell)
    const found = outcome?.verdict?.defects.find(d => d.id === defect)
    if (outcome && outcome.final !== 'INSTÁVEL' && found) kinds.set(id, found.kind)
  }
  const ids = [...kinds.keys()]
  return [...ids.filter(id => kinds.get(id) === 'design'), ...ids.filter(id => kinds.get(id) !== 'design')]
}

const CONCLUDED = new Set<Verdict>(['PASS', 'CANDIDATO-VISUAL', 'FAIL-APP', 'FAIL-VISUAL'])

export function retestCellsOf(matrix: Matrix, cellId: string, outcomes: Outcomes): string[] {
  const route = matrix.cells.find(c => c.id === cellId)?.route
  const others = matrix.cells.filter(c => c.id !== cellId && c.route === route && CONCLUDED.has(finalOf(outcomes, c.id)))
  return [cellId, ...others.slice(0, 3).map(c => c.id)]
}

// Heurísticas (listas, não uma prova): o que o commit de uma correção não pode conter.
export const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|e2e|specs?|cypress|playwright)\//i,
  /([.-](test|spec)\.[cm]?[jt]sx?|_test\.(py|go)|Test\.(php|java|kt)|\.feature)$/,
  /(^|\/)test_[^/]*\.py$/,
  // Mexer no `exclude` da configuração desliga teste.
  /(^|\/)(playwright|vitest|jest|cypress)\.config\.[^/]*$/,
]
export const SNAPSHOT_PATTERNS = [/(^|\/)(__snapshots__|__image_snapshots__|[^/]*-snapshots)\//i, /\.snap$/]
export const IMPECCABLE_PATTERNS = [/(^|\/)\.?impeccable/i]
export const MIGRATION_PATTERNS = [/(^|\/)(migrations?|drizzle|db\/migrate|alembic\/versions)(\/|$)/i, /(^|\/)schema\.prisma$/]
export const SUPPRESSION_MARKERS = ['impeccable-disable', 'impeccable-ignore', 'eslint-disable', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'stylelint-disable', 'biome-ignore']

// `changed`: o caminho já existia e foi mexido (alterado, apagado, tipo trocado ou lado antigo de renomeação).
type Touched = { path: string; changed: boolean }

// null = linha que não dá para entender; na dúvida, recusa.
function touchedOf(line: string): Touched[] | null {
  const f = line.split('\t')
  // O git cita o caminho com acento, aspas, `\\` ou controle (octal escapado): não dá para casar padrão, então recusa.
  if (f.slice(1).some(p => p.startsWith('"'))) return null
  const [status = '', a = '', b = ''] = f
  if (/^[MDT]$/.test(status) && f.length === 2 && a) return [{ path: a, changed: true }]
  if (status === 'A' && f.length === 2 && a) return [{ path: a, changed: false }]
  if (/^R\d*$/.test(status) && f.length === 3 && a && b) return [{ path: a, changed: true }, { path: b, changed: false }]
  if (/^C\d*$/.test(status) && f.length === 3 && a && b) return [{ path: b, changed: false }]
  return null
}

const matches = (patterns: readonly RegExp[], path: string): boolean => patterns.some(p => p.test(path))

export function diffCheckOf(nameStatus: string, patch: string): { migration: boolean; reasons: string[] } {
  const reasons = new Set<string>()
  let migration = false
  for (const line of nameStatus.split(/\r?\n/).filter(l => l.trim() !== '')) {
    const touched = touchedOf(line)
    if (touched === null) reasons.add(`linha do name-status não reconhecida: "${line}"`)
    for (const { path, changed } of touched ?? []) {
      if (changed && matches(TEST_PATTERNS, path)) reasons.add(`teste ou configuração de teste alterado ou apagado: ${path}`)
      if (changed && matches(SNAPSHOT_PATTERNS, path)) reasons.add(`base de print alterada ou apagada: ${path}`)
      if (matches(IMPECCABLE_PATTERNS, path)) reasons.add(`configuração do Impeccable mexida: ${path}`)
      if (matches(MIGRATION_PATTERNS, path)) {
        migration = true
        reasons.add(`migração: ${path}`)
      }
    }
  }
  let file = '(arquivo desconhecido)'
  // Dois estados: entre `diff --git` e o primeiro `@@` é cabeçalho (de onde sai o caminho); no resto, toda linha `+` é
  // acrescentada, inclusive `+++ y`. Sem nenhum `diff --git` (formato inesperado) o estado fica em "trecho": na dúvida, recusa.
  let inHeader = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) inHeader = true
    else if (line.startsWith('@@')) inHeader = false
    else if (inHeader) file = (line.startsWith('+++ ') ? /^\+\+\+ (?:b\/)?(.*)$/.exec(line)?.[1] : undefined) ?? file
    else if (line.startsWith('+')) {
      for (const marker of SUPPRESSION_MARKERS) if (line.includes(marker)) reasons.add(`supressão de regra (${marker}) em ${file}`)
    }
  }
  return { migration, reasons: [...reasons] }
}

const NOT_CONCLUDED = new Set<Verdict>(['NÃO VERIFICADO', 'AMBIENTE', 'FAIL-AGENTE'])

export function acceptFixOf(input: {
  target: { cell: string; defect: Defect } // o defeito que a tentativa quis corrigir (registro de ANTES)
  cells: readonly Cell[] // as células retestadas
  before: Readonly<Record<string, Evidence>> // por id de célula, da execução original
  after: Readonly<Record<string, Evidence>> // por id de célula, do reteste
}): { accepted: boolean; reasons: string[] } {
  const { target, cells, before, after } = input
  const reasons: string[] = []
  const sig = signatureOf(target.defect)
  const sigText = oneLine(sig)
  for (const cell of cells) {
    const now = own(after, cell.id)?.verdict ?? null
    const final = finalVerdictOf(cell, now)
    if (NOT_CONCLUDED.has(final)) reasons.push(`${cell.id}: o reteste não concluiu (${final})`)
    const nowDefects = now?.defects ?? []
    if (nowDefects.some(d => signatureOf(d) === sig)) reasons.push(`${cell.id}: o defeito alvo continua (${sigText})`)
    const oldFails = new Set((own(before, cell.id)?.verdict?.defects ?? []).filter(d => d.severity === 'fail').map(signatureOf))
    for (const d of nowDefects) {
      if (d.severity === 'fail' && !oldFails.has(signatureOf(d))) reasons.push(`${cell.id}: defeito novo (${oneLine(signatureOf(d))})`)
    }
    const old = own(before, cell.id)?.verdict
    cell.criteria.forEach((_, i) => {
      if (old && hasProof(old, i) && !(now && hasProof(now, i))) reasons.push(`${cell.id}: o critério ${i} tinha prova e perdeu no reteste`)
    })
  }
  const targetNow = own(after, target.cell)
  if (!cells.some(c => c.id === target.cell)) reasons.push(`${target.cell}: a célula alvo não foi retestada`)
  if (!targetNow) reasons.push(`${target.cell}: sem evidência do reteste da célula alvo`)
  if (target.defect.source === 'criterio') {
    const i = Number(target.defect.rule)
    if (!targetNow?.verdict || !hasProof(targetNow.verdict, i)) reasons.push(`${target.cell}: o critério ${i} do defeito alvo continua sem prova`)
  }
  const wanted = normalizedTextOf(target.defect.text ?? '')
  if (wanted !== '' && !normalizedTextOf(targetNow?.result?.steps.map(s => s.text).join(' ') ?? '').includes(wanted)) {
    reasons.push(`${target.cell}: o texto "${oneLine(target.defect.text ?? '')}" sumiu da tela no reteste`)
  }
  return { accepted: reasons.length === 0, reasons }
}

const FIX_STATUSES = ['corrigido', 'não reverificado', 'não reproduzido na worktree', 'desistiu'] as const satisfies readonly FixStatus[]

const listOf = (items: readonly string[]): string => (items.length > 0 ? items.map(oneLine).join('; ') : 'nenhum')

export function fixReportOf(results: readonly FixResult[]): string {
  return [
    '# Correções',
    '',
    ...FIX_STATUSES.map(s => `- ${s}: ${results.filter(r => r.status === s).length}`),
    ...results.flatMap(r => [
      '',
      `## ${oneLine(r.defect)}`,
      `- status: ${r.status}`,
      `- tentativas: ${r.attempts}`,
      `- commits: ${listOf(r.commits)}`,
      `- motivos de recusa: ${listOf(r.reasons)}`,
      `- reteste: ${listOf(r.retest.map(t => `${t.cell}: ${t.verdict}`))}`,
      `- print de antes: ${oneLine(r.before)}`,
      `- print de depois: ${oneLine(r.after)}`,
      `- teste de regressão: ${oneLine(r.regressionTest ?? 'nenhum')}`,
      `- pendências: ${listOf(r.pending)}`,
    ]),
    '',
  ].join('\n')
}
