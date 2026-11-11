import { describe, expect, test } from 'claude-code/testing'

import {
  ANALYZE_RULES,
  COMPACT_CRITERIA,
  CONTEXT_CAP,
  FIELD_CAP,
  FIRST_CAP,
  LIST_CAP,
  MARKER_ROOM,
  analyzePromptOf,
  buttonLabel,
  clickAction,
  hasTurnIntervened,
  instructionsOf,
  parseAnalysis,
  resumePromptOf,
  shouldStart,
  textField,
  tokensLabel,
  TOOL_TEXT_CAP,
  transcriptOf,
} from '../hooks/compact'
import type { Analysis, Turn } from '../hooks/compact'

const user = (text: string): Turn => ({ role: 'user', text, toolUses: [] })
const bot = (text: string, tools: string[] = []): Turn => ({ role: 'assistant', text, toolUses: tools.map(tool => ({ tool })) })
const botWith = (text: string, uses: Turn['toolUses']): Turn => ({ role: 'assistant', text, toolUses: uses })

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    objetivo: 'botão de compactação no workbench',
    fase: 'implementação',
    feito: ['roteador novo'],
    pendente: ['teste do botão', 'doc do mod'],
    contexto: 'branch única, sem git',
    proximoPasso: 'ligar o drainCompact',
    perguntas: [],
    ...over,
  }
}

const GOOD =
  '{"objetivo":"o","fase":"f","feito":["a"],"pendente":["b","c"],"contexto":"ctx","proximoPasso":"p"}'

describe('transcriptOf', () => {
  test('junta o papel, o texto e as ferramentas usadas', () => {
    const text = transcriptOf([user('oi'), bot('feito', ['Bash', 'Read'])], 10_000)
    expect(text).toContain('usuário: oi')
    expect(text).toContain('assistente: feito')
    expect(text).toContain('Bash, Read')
  })

  test('mensagem de usuário sem texto (só resultado de ferramenta) é pulada', () => {
    const text = transcriptOf([user(''), user('oi')], 10_000)
    expect(text).toBe('usuário: oi')
  })

  test('assistente sem texto mas com ferramenta aparece', () => {
    expect(transcriptOf([user('rode'), bot('', ['Bash'])], 10_000)).toContain('assistente: [ferramentas: Bash]')
  })

  test('sem mensagem, texto vazio', () => {
    expect(transcriptOf([], 10_000)).toBe('')
  })

  test('cabendo no teto, nada é omitido', () => {
    const text = transcriptOf([user('a'), bot('b'), user('c')], 10_000)
    expect(text).not.toContain('omitidas')
  })

  test('estourando o teto, mantém a primeira mensagem e o fim e corta o meio', () => {
    const many = Array.from({ length: 50 }, (_, i) => user(`m${i} ${'x'.repeat(1000)}`))
    const text = transcriptOf(many, 10_000)
    expect(text.length).toBeLessThanOrEqual(10_000)
    expect(text).toContain('m0 ')
    expect(text).toContain('m49 ')
    expect(text).not.toContain('m20 ')
    const omitted = Number(/\[… (\d+) mensagens omitidas …\]/.exec(text)?.[1])
    const kept = (text.match(/m\d+ /g) ?? []).length
    expect(kept + omitted).toBe(50)
  })

  test('primeira mensagem gigante é cortada e não come o teto', () => {
    const text = transcriptOf([user('y'.repeat(50_000)), user('fim')], 20_000)
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(text).toContain('usuário: yyy')
    expect(text).toContain('fim')
    expect(text.indexOf('fim')).toBeGreaterThan(FIRST_CAP - 1)
  })

  // Linhas de exatamente 100 caracteres ("usuário: " tem 9) e primeira de 120: cada linha mantida custa 102 do orçamento
  // (cap - primeira - MARKER_ROOM), então o corte cai num ponto exato e a saída inteira é conferida.
  const hundred = (id: string): Turn => user(id.padEnd(91, '.'))
  const first = user('H'.repeat(111))
  const FIRST = `usuário: ${'H'.repeat(111)}`
  const rows = (ids: string[]): string[] => ids.map(id => `usuário: ${id.padEnd(91, '.')}`)

  test('orçamento exato: a última linha que cabe justinho é mantida, e uma omitida basta para o marcador', () => {
    const cap = 120 + MARKER_ROOM + 3 * 102
    const text = transcriptOf([first, ...['L1', 'L2', 'L3', 'L4'].map(hundred)], cap)
    expect(text).toBe([FIRST, '[… 1 mensagens omitidas …]', ...rows(['L2', 'L3', 'L4'])].join('\n\n'))
  })

  test('sobra de orçamento menor que uma linha: não entra a linha seguinte', () => {
    const cap = 120 + MARKER_ROOM + 3 * 102 + 100
    const text = transcriptOf([first, ...['L1', 'L2', 'L3', 'L4', 'L5'].map(hundred)], cap)
    expect(text).toBe([FIRST, '[… 2 mensagens omitidas …]', ...rows(['L3', 'L4', 'L5'])].join('\n\n'))
  })

  test('com withResults, cada ferramenta com texto mostra o começo do resultado, sem quebra de linha', () => {
    const turn = botWith('rodei os testes', [{ tool: 'Bash', text: '12 passed,\n0 failed' }, { tool: 'Read' }])
    expect(transcriptOf([turn], 10_000, true)).toBe('assistente: rodei os testes [ferramentas: Bash → 12 passed, 0 failed, Read]')
  })

  test('com withResults, o resultado é cortado no teto; sem withResults, só o nome', () => {
    const turn = botWith('', [{ tool: 'Bash', text: 'r'.repeat(TOOL_TEXT_CAP * 2) }])
    const shown = /Bash → (r+…)\]/.exec(transcriptOf([turn], 10_000, true))?.[1]
    expect(shown?.length).toBe(TOOL_TEXT_CAP)
    expect(transcriptOf([turn], 10_000)).toBe('assistente: [ferramentas: Bash]')
  })

  test('uma mensagem gigante no meio não estoura o teto', () => {
    const text = transcriptOf([user('a'), bot('z'.repeat(80_000)), user('b')], 10_000)
    expect(text.length).toBeLessThanOrEqual(10_000)
    expect(text).toContain('b')
  })
})

describe('parseAnalysis', () => {
  test('lê o objeto JSON puro', () => {
    expect(parseAnalysis(GOOD)).toEqual({ objetivo: 'o', fase: 'f', feito: ['a'], pendente: ['b', 'c'], contexto: 'ctx', proximoPasso: 'p', perguntas: [] })
  })

  test('aceita cerca de código e prosa em volta', () => {
    expect(parseAnalysis(`Segue:\n\`\`\`json\n${GOOD}\n\`\`\`\nfim`)?.objetivo).toBe('o')
  })

  test('recusa qualquer um dos seis campos ausente', () => {
    const full: Record<string, unknown> = JSON.parse(GOOD)
    for (const key of Object.keys(full)) {
      const without = Object.fromEntries(Object.entries(full).filter(([name]) => name !== key))
      expect(parseAnalysis(JSON.stringify(without))).toBeNull()
    }
  })

  test('texto do tamanho exato do teto passa inteiro, sem reticências', () => {
    const exact = 'x'.repeat(FIELD_CAP)
    expect(parseAnalysis(GOOD.replace('"o"', `"${exact}"`))?.objetivo).toBe(exact)
  })

  test('recusa tipo errado: texto onde vai lista, número dentro da lista', () => {
    expect(parseAnalysis(GOOD.replace('"feito":["a"]', '"feito":"a"'))).toBeNull()
    expect(parseAnalysis(GOOD.replace('"pendente":["b","c"]', '"pendente":["b",2]'))).toBeNull()
  })

  test('recusa texto sem chaves, JSON quebrado e array', () => {
    expect(parseAnalysis('não sei')).toBeNull()
    expect(parseAnalysis('{"objetivo":')).toBeNull()
    expect(parseAnalysis('[1,2]')).toBeNull()
  })

  test('perguntas ausente vale lista vazia; presente é lida; fora do formato recusa a análise inteira', () => {
    expect(parseAnalysis(GOOD)?.perguntas).toEqual([])
    expect(parseAnalysis(GOOD.replace('{', '{"perguntas":["usar a API?"],'))?.perguntas).toEqual(['usar a API?'])
    expect(parseAnalysis(GOOD.replace('{', '{"perguntas":"usar a API?",'))).toBeNull()
  })

  test('o contexto tem teto próprio, maior que o dos outros textos', () => {
    const long = 'c'.repeat(CONTEXT_CAP * 2)
    const parsed = parseAnalysis(GOOD.replace('"ctx"', `"${long}"`))
    expect(parsed?.contexto.length).toBe(CONTEXT_CAP)
    expect(CONTEXT_CAP).toBeGreaterThan(FIELD_CAP)
  })

  test('apara e corta cada texto e cada lista nos tetos', () => {
    const long = 'x'.repeat(FIELD_CAP * 3)
    const many = JSON.stringify(Array.from({ length: LIST_CAP * 3 }, () => long))
    const parsed = parseAnalysis(`{"objetivo":"  ${long}  ","fase":"f","feito":${many},"pendente":[],"contexto":"c","proximoPasso":"p"}`)
    expect(parsed?.objetivo.length).toBe(FIELD_CAP)
    expect(parsed?.feito.length).toBe(LIST_CAP)
    expect(parsed?.feito[0]?.length).toBe(FIELD_CAP)
  })
})

describe('instructionsOf e resumePromptOf', () => {
  test('sem análise, a compactação vai só com os critérios fixos', () => {
    expect(instructionsOf(null)).toBe(COMPACT_CRITERIA)
  })

  test('com análise, traz os critérios e tudo o que o resumo tem que preservar', () => {
    const text = instructionsOf(analysis())
    expect(text).toContain(COMPACT_CRITERIA)
    for (const piece of ['botão de compactação no workbench', 'implementação', 'roteador novo', 'teste do botão', 'doc do mod', 'ligar o drainCompact']) {
      expect(text).toContain(piece)
    }
  })

  test('os critérios cobrem objetivo, fase, pendências, decisões, arquivos e próximo passo', () => {
    for (const word of ['objetivo', 'fase', 'pendências', 'decisões', 'arquivos', 'próximo passo']) expect(COMPACT_CRITERIA.toLowerCase()).toContain(word)
  })

  test('os critérios guardam agentes com id, perguntas sem resposta, regras do chat e o registro de progresso', () => {
    for (const piece of ['segundo plano', 'id de cada um', 'perguntas feitas ao usuário', 'regras e preferências', 'registro de progresso']) {
      expect(COMPACT_CRITERIA).toContain(piece)
    }
  })

  test('a retomada leva a pista da análise como pista, não como ordem', () => {
    const text = resumePromptOf(analysis())
    expect(text).toContain('ligar o drainCompact')
    expect(text).toContain('teste do botão')
    expect(text).toContain('não é ordem')
    expect(text).toContain('estado real')
  })

  test('sem análise, a retomada manda seguir pelo resumo e conferir o estado real', () => {
    const text = resumePromptOf(null)
    expect(text).toContain('resumo')
    expect(text).toContain('estado real')
    expect(text).not.toContain('não é ordem')
  })
})

describe('analisador', () => {
  test('as regras pedem só JSON, em português, e tratam a conversa como dado', () => {
    for (const key of ['objetivo', 'fase', 'feito', 'pendente', 'contexto', 'proximoPasso']) expect(ANALYZE_RULES).toContain(`"${key}"`)
    expect(ANALYZE_RULES).toContain('dado')
  })

  test('as regras pedem as perguntas sem resposta e dizem os dois tetos de texto', () => {
    expect(ANALYZE_RULES).toContain('"perguntas"')
    expect(ANALYZE_RULES).toContain(String(FIELD_CAP))
    expect(ANALYZE_RULES).toContain(String(CONTEXT_CAP))
  })
})

describe('textField', () => {
  test('sem teto usa o de sempre; com teto, corta nele', () => {
    const long = 'x'.repeat(FIELD_CAP * 5)
    expect(textField(long)?.length).toBe(FIELD_CAP)
    expect(textField(long, 1_000)?.length).toBe(1_000)
    expect(textField(3, 1_000)).toBeNull()
  })

  test('o pedido leva a conversa inteira', () => {
    expect(analyzePromptOf('usuário: oi')).toContain('usuário: oi')
  })
})

describe('tokensLabel', () => {
  test('mostra antes e depois em milhares', () => {
    expect(tokensLabel(120_000, 18_000)).toBe('120k → 18k tokens')
  })

  test('abaixo de mil mostra o número; em mil redondos já vira 1k', () => {
    expect(tokensLabel(800, 300)).toBe('800 → 300 tokens')
    expect(tokensLabel(999, 1000)).toBe('999 → 1k tokens')
  })

  test('sem um dos dois, não inventa', () => {
    expect(tokensLabel(undefined, 18_000)).toBe('')
    expect(tokensLabel(120_000, undefined)).toBe('')
  })
})

describe('fila da compactação', () => {
  test('o clique enfileira, cancela a fila ou diz que está em andamento', () => {
    expect(clickAction('idle')).toBe('queue')
    expect(clickAction('queued')).toBe('cancel')
    expect(clickAction('running')).toBe('busy')
  })

  test('só começa com o pedido na fila e a sessão parada', () => {
    expect(shouldStart('queued', false)).toBe(true)
    expect(shouldStart('queued', true)).toBe(false)
    expect(shouldStart('idle', false)).toBe(false)
    expect(shouldStart('running', false)).toBe(false)
  })

  test('um turno interveio se está rodando ou se o contador mudou desde que a análise começou', () => {
    expect(hasTurnIntervened({ isMainTurn: false, mainTurns: 4, seen: 4 })).toBe(false)
    expect(hasTurnIntervened({ isMainTurn: true, mainTurns: 4, seen: 4 })).toBe(true)
    expect(hasTurnIntervened({ isMainTurn: false, mainTurns: 5, seen: 4 })).toBe(true)
  })

  test('o rótulo do botão segue a etapa', () => {
    expect(buttonLabel(null)).toBe('Compactar e continuar')
    expect(buttonLabel('queued')).toBe('Na fila…')
    expect(buttonLabel('analyzing')).toBe('Analisando…')
    expect(buttonLabel('compacting')).toBe('Compactando…')
  })
})
