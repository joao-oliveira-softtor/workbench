import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  DELEGATE_CONTEXT,
  ROUTE_MIN_CHARS,
  ROUTE_PROMPT_CAP,
  ROUTE_RULES,
  TIER_LINES,
  buildRoutePrompt,
  formatRoute,
  isUserOrigin,
  parseRoute,
  shouldDelegate,
  tierOf,
} from '../hooks/route'
import type { Route } from '../hooks/route'

// Uma sugestão firme de opus; cada teste muda o que importa.
function route(over: Partial<Route>): Route {
  return { model: 'opus', confidence: 'high', why: 'arquitetura com impacto em vários módulos', fallback: 'sonnet', ...over }
}

const GOOD = '{"model":"opus","confidence":"high","why":"arquitetura","fallback":"sonnet"}'

describe('parseRoute', () => {
  test('lê o objeto JSON puro', () => {
    expect(parseRoute(GOOD)).toEqual({ model: 'opus', confidence: 'high', why: 'arquitetura', fallback: 'sonnet' })
  })

  test('aceita cerca de código e prosa em volta', () => {
    expect(parseRoute(`Claro!\n\`\`\`json\n${GOOD}\n\`\`\`\nEspero ter ajudado.`)?.model).toBe('opus')
  })

  test('recusa faixa fora da lista', () => {
    expect(parseRoute('{"model":"fable","confidence":"high","why":"x","fallback":"sonnet"}')).toBeNull()
  })

  test('recusa fallback fora da lista', () => {
    expect(parseRoute('{"model":"opus","confidence":"high","why":"x","fallback":"gpt"}')).toBeNull()
  })

  test('recusa confiança fora da lista', () => {
    expect(parseRoute('{"model":"opus","confidence":"certeza","why":"x","fallback":"sonnet"}')).toBeNull()
  })

  test('recusa campo ausente', () => {
    expect(parseRoute('{"model":"opus","confidence":"high","fallback":"sonnet"}')).toBeNull()
  })

  test('recusa texto sem chaves e JSON quebrado', () => {
    expect(parseRoute('opus')).toBeNull()
    expect(parseRoute('{"model":"opus",')).toBeNull()
    expect(parseRoute('')).toBeNull()
  })

  test('recusa array e valor que não é objeto', () => {
    expect(parseRoute('[{"model":"opus"}]')).toBeNull()
    expect(parseRoute('{}')).toBeNull()
  })

  test('apara e corta o motivo em 120 caracteres', () => {
    const long = `  ${'a'.repeat(300)}  `
    const parsed = parseRoute(`{"model":"haiku","confidence":"med","why":"${long}","fallback":"sonnet"}`)
    expect(parsed?.why).toBe('a'.repeat(120))
  })
})

describe('tierOf', () => {
  test('reconhece id e nome de exibição de uma faixa só', () => {
    expect(tierOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(tierOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(tierOf('Haiku 5.5')).toBe('haiku')
  })

  test('opusplan é ambíguo, pelo alias e pelo nome de exibição', () => {
    expect(tierOf('opusplan')).toBeUndefined()
    expect(tierOf('Opus in plan mode, else Sonnet')).toBeUndefined()
  })

  test('Fable, vazio e desconhecido não são faixa', () => {
    expect(tierOf('claude-fable-5-1')).toBeUndefined()
    expect(tierOf('')).toBeUndefined()
    expect(tierOf('algum-modelo')).toBeUndefined()
  })

  test('texto que cita duas faixas é ambíguo', () => {
    expect(tierOf('sonnet ou opus')).toBeUndefined()
  })
})

describe('isUserOrigin', () => {
  test('conta o Enter do usuário e o Remote Control', () => {
    expect(isUserOrigin('composer')).toBe(true)
    expect(isUserOrigin('bridge')).toBe(true)
  })

  test('não conta notificação, peer, agendamento nem SDK', () => {
    for (const kind of ['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger', 'sdk', 'unclassified']) {
      expect(isUserOrigin(kind)).toBe(false)
    }
  })
})

describe('shouldDelegate', () => {
  const base = { isOn: true, length: ROUTE_MIN_CHARS, isUser: true, isCommand: false, isMeta: false }

  test('delega quando todos os portões abrem', () => {
    expect(shouldDelegate(base)).toBe(true)
  })

  test('desligado fecha o portão', () => {
    expect(shouldDelegate({ ...base, isOn: false })).toBe(false)
  })

  test('prompt curto fecha o portão', () => {
    expect(shouldDelegate({ ...base, length: ROUTE_MIN_CHARS - 1 })).toBe(false)
  })

  test('origem que não é do usuário fecha o portão', () => {
    expect(shouldDelegate({ ...base, isUser: false })).toBe(false)
  })

  test('slash command e prompt de meta fecham o portão', () => {
    expect(shouldDelegate({ ...base, isCommand: true })).toBe(false)
    expect(shouldDelegate({ ...base, isMeta: true })).toBe(false)
  })
})

describe('formatRoute', () => {
  test('traz faixa, confiança em português, motivo e fallback', () => {
    const text = formatRoute(route({}), 'sonnet')
    expect(text).toContain('opus (confiança alta)')
    expect(text).toContain('arquitetura com impacto em vários módulos')
    expect(text).toContain('Fallback: sonnet.')
  })

  test('avisa quando o modelo atual é indeterminado ou já é o certo', () => {
    expect(formatRoute(route({}), undefined)).toContain('Modelo atual indeterminado.')
    expect(formatRoute(route({ model: 'sonnet' }), 'sonnet')).toContain('Já é o modelo atual.')
    expect(formatRoute(route({}), 'sonnet')).not.toContain('Modelo atual')
  })
})

describe('DELEGATE_CONTEXT', () => {
  test('cita as três faixas, as mesmas linhas das regras do /route', () => {
    for (const line of TIER_LINES) {
      expect(DELEGATE_CONTEXT).toContain(line)
      expect(ROUTE_RULES).toContain(line)
    }
  })

  test('manda delegar pela ferramenta Agent, para baixo e para cima', () => {
    expect(DELEGATE_CONTEXT).toContain('Agent')
    expect(DELEGATE_CONTEXT).toContain('model')
    expect(DELEGATE_CONTEXT).toContain('para cima')
  })

  test('diz que vale sobre a regra de implementação do CLAUDE.md e que as proibições continuam', () => {
    expect(DELEGATE_CONTEXT).toContain('CLAUDE.md')
    expect(DELEGATE_CONTEXT).toContain('proibições')
  })

  test('só vale para trabalho a executar, não para pergunta solta', () => {
    expect(DELEGATE_CONTEXT).toContain('trabalho a executar')
  })

  test('plano com várias tarefas vai pela skill subagent-driven-development, tarefa simples segue direta', () => {
    expect(DELEGATE_CONTEXT).toContain('superpowers:subagent-driven-development')
    expect(DELEGATE_CONTEXT).toContain('plano com várias tarefas')
    expect(DELEGATE_CONTEXT).toContain('sem plano')
    expect(DELEGATE_CONTEXT).toContain('não estiver instalada')
    expect(DELEGATE_CONTEXT).toContain('uma tarefa por subagente')
  })
})

describe('buildRoutePrompt e ROUTE_RULES', () => {
  test('manda a tarefa como dado JSON, aparada', () => {
    expect(buildRoutePrompt('  renomear variável  ')).toBe('{"tarefa":"renomear variável"}')
  })

  test('corta prompt gigante no teto', () => {
    const sent = JSON.parse(buildRoutePrompt('x'.repeat(ROUTE_PROMPT_CAP * 3)))
    expect(sent.tarefa.length).toBe(ROUTE_PROMPT_CAP)
  })

  test('as regras citam as três faixas e o formato de saída', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) expect(ROUTE_RULES).toContain(`"${tier}"`)
    expect(ROUTE_RULES).toContain('"fallback"')
  })
})

// Delegação inteira pelo engine: o `$` real do plugin, o relógio e o armazenamento simulados, e hooks do teste no lugar
// do engine (modelo, toast, o próprio prompt). O hook de `prompt.submit` do teste fica embaixo do plugin e guarda o
// `context` que chegou até o engine. Cada `boot` roda o `session.start`, que relê o liga/desliga do armazenamento: nenhum
// teste herda o estado do anterior.
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PROMPT = 'refatorar a autenticação do sistema cruzando três módulos'

async function boot($: Engine, on: On, over: { store?: Record<string, unknown>; answer?: string } = {}) {
  const clock = mock.clock(on)
  mock.store(on, over.store)
  const contexts: (readonly string[] | undefined)[] = []
  let completions = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Chamadas em `$` (operações) respondem `{ value }`; os eventos de sessão e de prompt devolvem o resultado direto.
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('model.complete', () => {
    completions += 1
    return { value: { isAnswered: true as const, text: over.answer ?? GOOD, usage: USAGE } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => {
    contexts.push(e.context)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return { clock, contexts, completions: () => completions }
}

async function submit($: Engine, text: string, over: { kind?: 'composer' | 'peer'; command?: { name: string; args: string } } = {}) {
  const origin = { kind: over.kind ?? 'composer' } as const
  return $.prompt.submit({ text, wait: false, origin, ...(over.command === undefined ? {} : { command: over.command }) })
}

async function runRoute($: Engine, args: string) {
  return $.command.run({ command: 'route', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
}

describe('hook prompt.submit (delegação automática)', () => {
  test('desligada por padrão: o prompt entra sem instrução extra', async ($, on) => {
    const t = await boot($, on)
    const entered = await submit($, PROMPT)
    expect(entered.text).toBe(PROMPT)
    expect(t.contexts).toEqual([undefined])
  })

  test('ligada: o prompt entra igual e leva a instrução de delegar, sem chamar modelo', async ($, on) => {
    const t = await boot($, on, { store: { 'route:delegate': true } })
    const entered = await submit($, PROMPT)
    expect(entered.text).toBe(PROMPT)
    expect(t.contexts).toEqual([[DELEGATE_CONTEXT]])
    await t.clock.advance(3_100)
    expect(t.completions()).toBe(0)
  })

  test('o route:auto = true da versão antiga não liga a delegação', async ($, on) => {
    const t = await boot($, on, { store: { 'route:auto': true } })
    await submit($, PROMPT)
    expect(t.contexts).toEqual([undefined])
  })

  test('origem que não é do usuário não leva a instrução', async ($, on) => {
    const t = await boot($, on, { store: { 'route:delegate': true } })
    await submit($, PROMPT, { kind: 'peer' })
    expect(t.contexts).toEqual([undefined])
  })

  test('slash command não leva a instrução', async ($, on) => {
    const t = await boot($, on, { store: { 'route:delegate': true } })
    await submit($, '/workbench stale com texto longo o bastante', { command: { name: 'workbench', args: 'stale' } })
    expect(t.contexts).toEqual([undefined])
  })

  test('prompt curto não leva a instrução', async ($, on) => {
    const t = await boot($, on, { store: { 'route:delegate': true } })
    await submit($, 'sim')
    expect(t.contexts).toEqual([undefined])
  })

  test('mantém o context que outro hook já tinha posto', async ($, on) => {
    const t = await boot($, on, { store: { 'route:delegate': true } })
    await $.prompt.submit({ text: PROMPT, wait: false, origin: { kind: 'composer' }, context: ['antes'] })
    expect(t.contexts).toEqual([['antes', DELEGATE_CONTEXT]])
  })
})

describe('/route', () => {
  test('auto on liga a delegação já para o próximo prompt, auto off desliga', async ($, on) => {
    const t = await boot($, on)
    const on1 = await runRoute($, 'auto on')
    expect(on1.text).toContain('ligada')
    expect(on1.text).toContain('sessões já abertas')
    await submit($, PROMPT)
    const off = await runRoute($, 'auto off')
    expect(off.text).toContain('desligada')
    await submit($, PROMPT)
    expect(t.contexts).toEqual([[DELEGATE_CONTEXT], undefined])
  })

  test('auto on sobrevive ao reload do mod (novo session.start)', async ($, on) => {
    const t = await boot($, on)
    await runRoute($, 'auto on')
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await submit($, PROMPT)
    expect(t.contexts).toEqual([[DELEGATE_CONTEXT]])
  })

  test('sem argumento ou só "auto" explica o uso, sem chamar modelo', async ($, on) => {
    const t = await boot($, on)
    expect((await runRoute($, '')).text).toContain('Uso:')
    expect((await runRoute($, 'auto')).text).toContain('Uso:')
    expect(t.completions()).toBe(0)
  })

  test('com a tarefa, pede ao Haiku na hora e devolve a faixa', async ($, on) => {
    const t = await boot($, on)
    const answered = await runRoute($, 'refatorar a autenticação')
    expect(t.completions()).toBe(1)
    expect(answered.text).toContain('opus (confiança alta)')
  })

  test('resposta fora do formato vira mensagem, não erro', async ($, on) => {
    await boot($, on, { answer: 'não sei' })
    expect((await runRoute($, 'refatorar a autenticação')).text).toContain('fora do formato')
  })
})
