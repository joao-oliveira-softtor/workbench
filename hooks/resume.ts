// Resumo do dia (botão "Retomada"): regras puras, sem `$` e sem I/O (testáveis). A leitura dos transcritos e a chamada ao
// modelo vivem em collect.ts; o botão e o timer, em register.tsx.

export const SLICE_CAP = 12_000
export const PROMPT_CAP = 500
export const REPLY_CAP = 800
export const SUMMARY_CAP = 3_000
export const LABEL_CAP = 120
// Entradas que contam: `cli` (terminal) e `claude-vscode` (IDE). `sdk-cli` são rodadas sem terminal.
export const INTERACTIVE = ['cli', 'claude-vscode']
// Primeira frase fixa da mensagem que o botão manda. `sliceOf` a reconhece na sessão em que o botão rodou.
export const RESUME_MESSAGE_HEAD =
  'Abaixo está o resumo automático do último dia de trabalho, feito a partir dos transcritos.'

const REMOVED = '[removido]'

export type Slice =
  | {
      kind: 'ok'
      cwd: string
      branch: string
      title: string
      startedAt: number
      lastHumanAt: number
      firstPrompts: string[]
      lastPrompts: string[]
      lastSummary: string
      awaySummary: string
      lastReplies: string[]
      isMidway: boolean
    }
  | { kind: 'automatic' }
  | { kind: 'empty' }
  | { kind: 'broken' }

type Ok = Extract<Slice, { kind: 'ok' }>

const two = (n: number): string => String(n).padStart(2, '0')

// Dia de trabalho de um horário, na hora local: antes de `cutoffHour` ainda é o dia anterior.
export function workDayOf(at: number, cutoffHour: number): string {
  const d = new Date(at)
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function hhmmOf(at: number): string {
  const d = new Date(at)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

// Título, branch e pasta entram em uma linha só da mensagem e do arquivo: sem quebra nem caractere de controle.
export function labelOf(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, LABEL_CAP).trimEnd()
}

export function projectOf(cwd: string): string {
  return labelOf(cwd.split(/[\\/]/).filter(Boolean).pop() ?? '')
}

type Line = {
  type?: string
  subtype?: string
  isCompactSummary?: boolean
  origin?: { kind?: string }
  message?: { content?: unknown }
  content?: unknown
  aiTitle?: unknown
  cwd?: unknown
  gitBranch?: unknown
  entrypoint?: unknown
  timestamp?: unknown
}

type Block = { type?: string; text?: unknown }

const blocksOf = (line: Line): Block[] => {
  const c = line.message?.content
  return Array.isArray(c) ? c.filter((b): b is Block => typeof b === 'object' && b !== null) : []
}

// Texto de uma mensagem: a string, ou os blocos `text` juntos. Resultado de ferramenta não é texto.
function textOf(line: Line): string {
  const c = line.message?.content
  if (typeof c === 'string') return c
  return blocksOf(line)
    .flatMap(b => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n')
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// `JSON.parse` do transcrito inteiro numa linha só: linha cortada ou inválida é pulada.
function parseLine(raw: string): Line | null {
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Line) : null
  } catch {
    return null
  }
}

type Acc = {
  prompts: string[]
  replies: string[]
  startedAt: number
  lastHumanAt: number
  lastSummary: string
  awaySummary: string
  isMidway: boolean
  skipReply: boolean
}

const fresh = (): Acc => ({
  prompts: [],
  replies: [],
  startedAt: 0,
  lastHumanAt: 0,
  lastSummary: '',
  awaySummary: '',
  isMidway: false,
  skipReply: false,
})

// `text` é o conteúdo do transcrito (ou o fim dele, com `isTail`, e então a primeira linha pode vir cortada).
export function sliceOf(text: string, isTail: boolean): Slice {
  const raw = text.split('\n')
  const parsed = (isTail ? raw.slice(1) : raw).map(parseLine).filter((l): l is Line => l !== null)
  if (parsed.length === 0) return { kind: 'broken' }

  const entry = parsed.map(l => str(l.entrypoint)).find(e => e !== '')
  if (entry !== undefined && !INTERACTIVE.includes(entry)) return { kind: 'automatic' }

  let cwd = ''
  let branch = ''
  let title = ''
  let acc = fresh()
  for (const l of parsed) {
    cwd = str(l.cwd) || cwd
    branch = str(l.gitBranch) || branch
    const at = Date.parse(str(l.timestamp))
    const body = textOf(l)
    if (l.type === 'ai-title') title = str(l.aiTitle) || title
    else if (l.type === 'system' && l.subtype === 'away_summary') acc.awaySummary = str(l.content).slice(0, SUMMARY_CAP)
    else if (l.type === 'assistant') {
      const last = blocksOf(l).at(-1)
      if (body !== '' && acc.skipReply) acc.skipReply = false
      else if (body !== '') acc.replies.push(body.slice(0, REPLY_CAP))
      if (body !== '' || last?.type === 'tool_use') acc.isMidway = last?.type === 'tool_use'
    } else if (l.type === 'user') {
      if (body.includes(RESUME_MESSAGE_HEAD)) {
        // A sessão em que o botão rodou: o que veio antes já está no resumo de todos os clientes.
        acc = fresh()
        acc.skipReply = true
      } else if (l.isCompactSummary) acc.lastSummary = body.slice(0, SUMMARY_CAP)
      else if (l.origin?.kind === 'human' && body !== '') {
        acc.prompts.push(body.slice(0, PROMPT_CAP))
        acc.startedAt = acc.startedAt || at
        acc.lastHumanAt = at
        acc.isMidway = true
      } else if (blocksOf(l).some(b => b.type === 'tool_result')) acc.isMidway = true
    }
  }
  if (acc.prompts.length === 0) return { kind: 'empty' }

  return {
    kind: 'ok',
    cwd: labelOf(cwd),
    branch: labelOf(branch),
    title: labelOf(title),
    startedAt: acc.startedAt,
    lastHumanAt: acc.lastHumanAt,
    firstPrompts: acc.prompts.slice(0, 2),
    lastPrompts: acc.prompts.slice(2).slice(-5),
    lastSummary: acc.lastSummary,
    awaySummary: acc.awaySummary,
    lastReplies: acc.replies.slice(-3),
    isMidway: acc.isMidway,
  }
}

const listOf = (head: string, items: string[]): string[] =>
  items.length === 0 ? [] : [head, ...items.map(i => `- ${i}`)]
const textBlock = (head: string, body: string): string[] => (body === '' ? [] : [head, body])

function sliceLines(s: Ok): string {
  const project = projectOf(s.cwd)
  return [
    ...(project === '' ? [] : [`Projeto: ${project}`]),
    ...(s.branch === '' ? [] : [`Branch: ${s.branch}`]),
    ...(s.title === '' ? [] : [`Título: ${s.title}`]),
    `Horários: ${hhmmOf(s.startedAt)} a ${hhmmOf(s.lastHumanAt)}`,
    ...listOf('Primeiros pedidos:', s.firstPrompts),
    ...textBlock('Último resumo de compactação:', s.lastSummary),
    ...textBlock('Recado do Claude Code:', s.awaySummary),
    ...listOf('Últimos pedidos:', s.lastPrompts),
    ...listOf('Últimas respostas:', s.lastReplies),
    ...(s.isMidway ? ['Terminou no meio: sim'] : []),
  ].join('\n')
}

// Acima de SLICE_CAP corta primeiro as respostas, depois o resumo de compactação.
export function sliceTextOf(slice: Ok): string {
  const noReplies = { ...slice, lastReplies: [] }
  const bare = sliceLines({ ...noReplies, lastSummary: '' })
  const tiers = [sliceLines(slice), sliceLines(noReplies), bare]
  return tiers.find(t => t.length <= SLICE_CAP) ?? bare.slice(0, SLICE_CAP)
}

// Cada padrão tem o tamanho mínimo da tabela do plano, para não apagar texto comum. O valor termina no primeiro espaço,
// aspas, vírgula ou fim de linha.
const NOT_ALNUM_BEFORE = '(?<![A-Za-z0-9])'
const VALUE = `[^\\s"',]{4,}`
const SCRUBS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REMOVED],
  [/([a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, `$1${REMOVED}`],
  [/\b(Bearer )[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REMOVED}`],
  [/(?=[\w.-]{30})eyJ[\w-]*\.[\w-]+\.[\w-]+/g, REMOVED],
  [new RegExp(`${NOT_ALNUM_BEFORE}sk-[A-Za-z0-9_-]{20,}`, 'g'), REMOVED],
  [new RegExp(`${NOT_ALNUM_BEFORE}gh[po]_[A-Za-z0-9]{30,}`, 'g'), REMOVED],
  [new RegExp(`${NOT_ALNUM_BEFORE}xox[abp]-[A-Za-z0-9-]{10,}`, 'g'), REMOVED],
  [new RegExp(`${NOT_ALNUM_BEFORE}AKIA[A-Z0-9]{16}(?![A-Z0-9])`, 'g'), REMOVED],
  [new RegExp(`\\b(password|senha|token)=${VALUE}`, 'gi'), `$1=${REMOVED}`],
  [new RegExp(`\\b([A-Z0-9_]*(?:_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*=["']?)${VALUE}`, 'g'), `$1${REMOVED}`],
]

export function scrub(text: string): string {
  return SCRUBS.reduce((t, [re, to]) => t.replace(re, to), text)
}
