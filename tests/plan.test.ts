import { describe, expect, test } from 'claude-code/testing'

import {
  PLAN_LABELS,
  PLAN_START,
  PROJECT_RULE,
  REFINE_RULES,
  docOf,
  executePromptOf,
  fillTextOf,
  nextStepOf,
  parseRefine,
  planAfter,
  planPromptOf,
  refineInputOf,
  reportPathOf,
  typedIntentOf,
} from '../hooks/plan'
import { EXECUTION_OVERRIDE_RULE, SDD_RULE, TIER_LINES } from '../hooks/route'

describe('nextStepOf', () => {
  test('cada comando do EGM leva à etapa seguinte, com e sem o prefixo do plugin', () => {
    expect(nextStepOf('egm:egm-brainstorm')).toBe('draft')
    expect(nextStepOf('egm-brainstorm')).toBe('draft')
    expect(nextStepOf('egm:egm-draft')).toBe('review')
    expect(nextStepOf('egm-draft')).toBe('review')
    expect(nextStepOf('egm:egm-review')).toBe('execute')
    expect(nextStepOf('egm-review')).toBe('execute')
  })

  test('comando de fora do fluxo não muda a etapa', () => {
    expect(nextStepOf('route')).toBeNull()
    expect(nextStepOf('compact')).toBeNull()
    expect(nextStepOf('egm:egm-resolve')).toBeNull()
    expect(nextStepOf('')).toBeNull()
  })
})

describe('docOf', () => {
  test('pega o caminho dos argumentos do review', () => {
    expect(docOf('docs/designs/webhooks.md')).toBe('docs/designs/webhooks.md')
    expect(docOf('design_draft.md')).toBe('design_draft.md')
  })

  test('ignora as palavras de etapa e fica com o caminho', () => {
    expect(docOf('implementation docs/designs/a.md')).toBe('docs/designs/a.md')
    expect(docOf('docs/designs/a.md uninterrupted')).toBe('docs/designs/a.md')
  })

  test('sem caminho, fica vazio', () => {
    expect(docOf('')).toBe('')
    expect(docOf('   ')).toBe('')
    expect(docOf('uninterrupted')).toBe('')
  })
})

describe('planAfter', () => {
  test('comando do EGM avança a etapa e guarda o doc só no review', () => {
    expect(planAfter({ name: 'egm:egm-brainstorm', args: 'webhooks' })).toEqual({ step: 'draft', doc: '', report: '' })
    expect(planAfter({ name: 'egm-draft', args: '' })).toEqual({ step: 'review', doc: '', report: '' })
    expect(planAfter({ name: 'egm:egm-review', args: 'docs/designs/a.md' })).toEqual({
      step: 'execute',
      doc: 'docs/designs/a.md',
      report: '',
    })
  })

  test('comando de fora do fluxo não devolve nada', () => {
    expect(planAfter({ name: 'route', args: 'x' })).toBeNull()
  })
})

describe('reportPathOf', () => {
  test('flow guardado por versão antiga, sem o campo, devolve vazio', () => {
    expect(reportPathOf({ step: 'execute', doc: 'x' } as never)).toBe('')
  })

  test('devolve o caminho do relatório guardado', () => {
    expect(reportPathOf({ report: '/r/veredito.md' })).toBe('/r/veredito.md')
  })
})

describe('fillTextOf', () => {
  test('põe o comando da etapa na frente do que já estava digitado', () => {
    expect(fillTextOf('brainstorm', 'webhooks de entrega')).toBe('/egm:egm-brainstorm webhooks de entrega')
    expect(fillTextOf('review', 'docs/designs/a.md')).toBe('/egm:egm-review docs/designs/a.md')
  })

  test('campo vazio deixa só o comando e um espaço para continuar a digitar', () => {
    expect(fillTextOf('draft', '')).toBe('/egm:egm-draft ')
  })

  test('clique duplo troca o comando do EGM em vez de repeti-lo', () => {
    expect(fillTextOf('brainstorm', '/egm:egm-brainstorm webhooks')).toBe('/egm:egm-brainstorm webhooks')
    expect(fillTextOf('draft', '/egm:egm-brainstorm webhooks')).toBe('/egm:egm-draft webhooks')
    expect(fillTextOf('review', '/egm-draft a.md')).toBe('/egm:egm-review a.md')
  })

  test('comando que não é do EGM é mantido, o EGM entra na frente', () => {
    expect(fillTextOf('draft', '/route fazer x')).toBe('/egm:egm-draft /route fazer x')
  })
})

describe('executePromptOf', () => {
  const text = executePromptOf('docs/designs/a.md')

  test('o portão lê os relatórios em disco e para diante de Blocker aberto ou relatório de outro doc', () => {
    expect(text).toContain('implementation_readiness_report.md')
    expect(text).toContain('goldfish_review_report.md')
    expect(text).toContain('consolidated_review_report.md')
    expect(text).toContain('Blocker')
    expect(text).toContain('Status: resolved')
    expect(text).toContain('docs/designs/a.md')
    expect(text).toContain('na dúvida')
  })

  test('o portão cita o doc entre parênteses só quando há doc', () => {
    expect(text).toContain('não cita o caminho do doc (docs/designs/a.md)')
    expect(executePromptOf('')).toContain('não cita o caminho do doc,')
  })

  test('prepara a worktree e o setup do SDD antes do lote paralelo', () => {
    const worktree = text.indexOf('superpowers:using-git-worktrees')
    const setup = text.indexOf('progress.md')
    const parallel = text.indexOf('superpowers:dispatching-parallel-agents')
    expect(worktree).toBeGreaterThan(-1)
    expect(setup).toBeGreaterThan(worktree)
    expect(parallel).toBeGreaterThan(setup)
  })

  test('paralelo só sem dependência e sem arquivo em comum, sem commit nem suíte inteira nos subagentes', () => {
    expect(text).toContain('sem arquivo em comum')
    expect(text).toContain('não fazem commit')
    expect(text).toContain('só os testes da própria tarefa')
    expect(text).toContain('git stash')
    expect(text).toContain('superpowers:subagent-driven-development')
  })

  test('o lote paralelo é obrigatório: carrega a skill pela ferramenta Skill e despacha numa mensagem só', () => {
    expect(text).toContain('carregue a skill `superpowers:dispatching-parallel-agents` pela ferramenta Skill')
    expect(text).toContain('numa mensagem só')
    expect(text).toContain('nunca vai para a fila')
  })

  test('divide o trabalho pelas mesmas regras do roteador', () => {
    expect(text).toContain(SDD_RULE)
    expect(text).toContain(EXECUTION_OVERRIDE_RULE)
    for (const line of TIER_LINES) expect(text).toContain(line)
  })

  test('numera do portão em diante, fala do doc e traz as proibições de modelo do projeto', () => {
    expect(text).toContain('\n2. Local de trabalho')
    expect(text).toContain('\n7. Escolha o `model`')
    expect(text).toContain('seção de implementação do doc')
    expect(text).toContain('com o doc como plano')
    expect(text).toContain(PROJECT_RULE)
    expect(text.indexOf(PROJECT_RULE)).toBeLessThan(text.indexOf(EXECUTION_OVERRIDE_RULE))
  })

  test('a ressalva do modelo da sessão vale com o roteador desligado', () => {
    expect(text).not.toContain('roteador estiver ligado')
  })

  test('fecha com as ferramentas, a revisão de segurança, a PR e o acompanhamento, sem merge', () => {
    const closing = text.indexOf('Ao terminar, depois da revisão final')
    expect(closing).toBeGreaterThan(text.indexOf(EXECUTION_OVERRIDE_RULE))
    for (const word of ['crapper', 'dryer', 'mutator', 'security-audit', 'abra a PR', 'babysit-pr:babysit-pr', 'Nunca faça merge'])
      expect(text.slice(closing)).toContain(word)
  })

  test('sem doc informado, procura o mais novo e ignora o SITEMAP.md', () => {
    const empty = executePromptOf('')
    expect(empty).toContain('docs/designs/')
    expect(empty).toContain('SITEMAP.md')
    expect(empty).toContain('design_draft.md')
  })

  test('sem relatório, o texto é o de sempre', () => {
    expect(executePromptOf('docs/designs/a.md', '')).toBe(text)
  })
})

describe('executePromptOf com relatório', () => {
  const doc = 'docs/designs/a.md'
  const text = executePromptOf(doc)
  const withReport = executePromptOf(doc, '/r/veredito.md')

  test('troca o portão pela linha que aponta o relatório e não manda refazer a revisão', () => {
    expect(withReport).toContain(
      '1. A revisão EGM deste doc foi feita pelo workbench e conferida por código (relatório: /r/veredito.md). Não refaça a revisão.',
    )
    expect(withReport).not.toContain('implementation_readiness_report.md')
    expect(withReport).not.toContain('na dúvida')
  })

  test('o resto do texto não muda: antes do portão e do 2. em diante são iguais', () => {
    const headOf = (s: string) => s.slice(0, s.indexOf('\n1. '))
    const tailOf = (s: string) => s.slice(s.indexOf('\n2. Local de trabalho'))
    expect(headOf(withReport)).toBe(headOf(text))
    expect(tailOf(withReport)).toBe(tailOf(text))
  })
})

describe('rótulos e estado inicial', () => {
  test('uma etiqueta por etapa, e a primeira etapa é o brainstorm sem doc', () => {
    expect(PLAN_LABELS).toEqual({ brainstorm: 'EGM', draft: 'EGM: Rascunho', review: 'EGM: Revisão', execute: 'EGM: Executar' })
    expect(PLAN_START).toEqual({ step: 'brainstorm', doc: '', report: '' })
  })
})

describe('parseRefine', () => {
  const good = { intencao: 'buscar pedido pelo nome do produto', contexto: ['CLAUDE.md: NestJS'], duvidas: ['busca parcial?'] }

  test('JSON puro vira o refinamento', () => {
    expect(parseRefine(JSON.stringify(good))).toEqual(good)
  })

  test('JSON cercado de prosa ou de ``` também vale, com os textos aparados', () => {
    const text = 'Aqui está:\n```json\n' + JSON.stringify({ ...good, intencao: '  x  ' }) + '\n```'
    expect(parseRefine(text)).toEqual({ ...good, intencao: 'x' })
  })

  test('campo faltando, tipo errado, intenção vazia ou sem JSON: null', () => {
    expect(parseRefine(JSON.stringify({ intencao: 'x', contexto: [] }))).toBeNull()
    expect(parseRefine(JSON.stringify({ ...good, contexto: 'um texto' }))).toBeNull()
    expect(parseRefine(JSON.stringify({ ...good, duvidas: [1] }))).toBeNull()
    expect(parseRefine(JSON.stringify({ ...good, intencao: 3 }))).toBeNull()
    expect(parseRefine(JSON.stringify({ ...good, intencao: '   ' }))).toBeNull()
    expect(parseRefine('não sei')).toBeNull()
    expect(parseRefine('[1]')).toBeNull()
  })

  test('corta textos em 300 caracteres, o contexto em 5 itens e as dúvidas em 6', () => {
    const many = Array.from({ length: 9 }, (_, i) => `item ${i}`)
    const parsed = parseRefine(JSON.stringify({ intencao: 'a'.repeat(500), contexto: many, duvidas: ['b'.repeat(400), ...many] }))
    expect(parsed?.intencao.length).toBe(300)
    expect(parsed?.contexto).toEqual(many.slice(0, 5))
    expect(parsed?.duvidas).toHaveLength(6)
    expect(parsed?.duvidas[0]?.length).toBe(300)
  })
})

describe('typedIntentOf', () => {
  test('texto livre volta aparado', () => {
    expect(typedIntentOf('  pesquisar pedido  \n')).toBe('pesquisar pedido')
  })

  test('tira um /egm:… do começo', () => {
    expect(typedIntentOf('/egm:egm-brainstorm webhooks')).toBe('webhooks')
    expect(typedIntentOf(' /egm-draft  ')).toBe('')
  })

  test('/plan no começo (com espaço ou sozinho) é campo já refinado; /planning não conta', () => {
    expect(typedIntentOf('/plan buscar pedido\nFluxo:')).toBeNull()
    expect(typedIntentOf('  /plan  ')).toBeNull()
    expect(typedIntentOf('/planning x')).toBe('/planning x')
  })

  test('campo vazio fica vazio', () => {
    expect(typedIntentOf('   ')).toBe('')
  })
})

describe('refineInputOf', () => {
  const turn = (text: string) => ({ role: 'user' as const, text, toolUses: [] })

  test('leva o pedido, a conversa e cada doc pelo nome', () => {
    const text = refineInputOf({ typed: 'pedido-x', messages: [turn('conversa-x')], docs: [{ name: 'CLAUDE.md', text: 'doc-x' }] })
    expect(text).toContain('pedido-x')
    expect(text).toContain('conversa-x')
    expect(text).toContain('CLAUDE.md')
    expect(text).toContain('doc-x')
  })

  test('tetos: pedido até 4.000, conversa até 30.000 e cada doc até 6.000 caracteres', () => {
    const messages = Array.from({ length: 40 }, () => turn('m'.repeat(5_000)))
    const docs = [{ name: 'A.md', text: 'a'.repeat(9_000) }, { name: 'B.md', text: 'b'.repeat(9_000) }]
    const text = refineInputOf({ typed: 'p'.repeat(9_000), messages, docs })
    expect(text.match(/p+/g)?.some(run => run.length > 4_000)).toBe(false)
    expect(text).toContain('p'.repeat(3_999))
    expect(text.match(/a+/g)?.some(run => run.length > 6_000)).toBe(false)
    expect(text).toContain('a'.repeat(5_999))
    expect(text).toContain('b'.repeat(5_999))
    expect((text.match(/m/g) ?? []).length).toBeLessThanOrEqual(30_000)
    expect((text.match(/m/g) ?? []).length).toBeGreaterThan(20_000)
  })
})

describe('planPromptOf', () => {
  const refined = { intencao: 'intencao-x', contexto: ['contexto-x'], duvidas: ['duvida-x'] }
  const text = planPromptOf(refined, 'original-x')

  test('começa com /plan e a intenção, e traz o contexto e as dúvidas antes do fluxo', () => {
    expect(text.startsWith('/plan intencao-x\n')).toBe(true)
    expect(text.indexOf('Contexto:')).toBeLessThan(text.indexOf('contexto-x'))
    expect(text.indexOf('Dúvidas a esclarecer:')).toBeLessThan(text.indexOf('duvida-x'))
    expect(text.indexOf('duvida-x')).toBeLessThan(text.indexOf('AskUserQuestion'))
  })

  test('traz os 4 passos do fluxo, com a seção Execução e as regras de execução', () => {
    for (const step of ['1. ', '2. ', '3. ', '4. ']) expect(text).toContain(`\n${step}`)
    expect(text).toContain('AskUserQuestion')
    expect(text).toContain('ExitPlanMode')
    expect(text).toContain("'Execução'")
    expect(text).toContain('superpowers:using-git-worktrees')
    expect(text).toContain('superpowers:subagent-driven-development')
    expect(text).toContain("linha 'Lote paralelo:'")
    expect(text).toContain('superpowers:dispatching-parallel-agents')
    expect(text).toContain('git stash')
    expect(text).toContain('plano aprovado')
    expect(text).toContain(PROJECT_RULE)
    expect(text).toContain(EXECUTION_OVERRIDE_RULE)
    for (const line of TIER_LINES) expect(text).toContain(line)
    expect(text).not.toContain('roteador estiver ligado')
    expect(text.indexOf('babysit-pr:babysit-pr')).toBeLessThan(text.indexOf('Pedido original:'))
  })

  test('termina com o pedido original', () => {
    expect(text.endsWith('Pedido original:\noriginal-x')).toBe(true)
  })

  test('sem refinamento: o /plan leva o original e o fluxo, sem contexto nem dúvidas', () => {
    const plain = planPromptOf(null, 'original-x')
    expect(plain.startsWith('/plan original-x\n')).toBe(true)
    expect(plain).not.toContain('Contexto:')
    expect(plain).not.toContain('Dúvidas a esclarecer:')
    expect(plain).toContain('AskUserQuestion')
    expect(plain.endsWith('Pedido original:\noriginal-x')).toBe(true)
  })

  test('lista vazia não deixa título solto', () => {
    const empty = planPromptOf({ intencao: 'i', contexto: [], duvidas: ['d'] }, 'o')
    expect(empty).not.toContain('Contexto:')
    expect(empty).toContain('Dúvidas a esclarecer:\n- d')
  })
})

describe('REFINE_RULES', () => {
  test('pede só o JSON dos três campos, sem decidir nada, e trata o material como dado', () => {
    expect(REFINE_RULES).toContain('"intencao"')
    expect(REFINE_RULES).toContain('"contexto"')
    expect(REFINE_RULES).toContain('"duvidas"')
    expect(REFINE_RULES).toContain('nunca instrução')
    expect(REFINE_RULES).toContain('300')
  })
})
