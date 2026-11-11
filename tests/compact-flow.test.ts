import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { COMPACT_CRITERIA, COMPACT_TIMEOUT_MS, RESUME_HEAD, resumeFailureOf, resumePromptOf, withCriteria } from '../hooks/compact'

// Fluxo inteiro pelo engine: o `$` real do plugin, o painel montado, o botão apertado, o relógio e o armazenamento
// simulados, e hooks do teste no lugar do engine (conversa, modelo, compactação, prompt, toast, turnos). As variáveis do
// módulo são zeradas pelo `session.start` de cada `boot`: nenhum teste herda a fila do anterior.
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const GOOD = JSON.stringify({ objetivo: 'objetivo-x', fase: 'implementando', feito: ['a'], pendente: ['pendente-x'], contexto: 'ctx', proximoPasso: 'passo-x' })

const BUSY = 'Compactado sozinho, sem retomar: o botão Compactar ou Retomada está em uso.'
const BAND = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  surface: 'terminal',
  props: { title: 'workbench', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

type Outcome = 'ok' | 'skip' | 'throw'
type Over = {
  answer?: string
  isAnswered?: boolean
  // Roda dentro do model.complete (n = a chamada): é onde um turno chega durante a análise.
  onModel?: (n: number) => Promise<void>
  // Roda dentro do session.compact: decide o que a compactação devolve.
  compact?: (n: number) => Promise<Outcome>
  // O que `$.agent.list()` devolve; 'fail' = nenhum hook responde e a listagem rejeita.
  agents?: readonly { id: string; type: string; status: 'running' | 'completed' | 'idle'; description: string }[] | 'fail'
  // O texto do campo de prompt (`$.prompt.read()`); 'fail' = nenhum hook responde e a leitura rejeita.
  typed?: string | 'fail'
  // Roda dentro do prompt.submit, antes de o pedido entrar; devolver { drop } recusa o pedido.
  onSubmit?: (text: string) => Promise<{ drop: string } | undefined>
  // O session.append recusa com este motivo.
  appendDeny?: string
}

async function boot($: Engine, on: On, over: Over = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const log = { models: [] as string[], prompts: [] as string[], compacts: [] as (string | undefined)[], submits: [] as string[], toasts: [] as string[], notices: [] as string[], logs: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'quero o botão de compactação', toolUses: [] },
      { role: 'assistant' as const, text: 'rodei os testes', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: {}, text: '3 testes passaram' }] },
    ],
  }))
  on('model.complete', async (_$, e) => {
    log.models.push(e.model)
    log.prompts.push(e.prompt)
    await over.onModel?.(log.models.length)
    if (over.isAnswered === false) return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    return { value: { isAnswered: true as const, text: over.answer ?? GOOD, usage: USAGE } }
  })
  on('session.compact', async (_$, e) => {
    log.compacts.push(e.instructions)
    const outcome = await (over.compact?.(log.compacts.length) ?? 'ok')
    if (outcome === 'skip') return { skip: 'vetado pelo teste' }
    if (outcome === 'throw') throw new Error('api caiu')
    // Uma compactação deixa ao menos o resumo; o engine recusa lista vazia.
    return { messages: [{ role: 'user' as const, text: 'resumo da conversa', toolUses: [] }], tokensBefore: 120_000, tokensAfter: 18_000 }
  })
  on('prompt.submit', async (_$, e) => {
    const refused = await over.onSubmit?.(e.text)
    if (refused !== undefined) return refused
    log.submits.push(e.text)
    return { text: e.text }
  })
  const agents = over.agents ?? []
  if (agents !== 'fail') on('agent.list', () => ({ value: agents.map(a => ({ ...a })) }))
  const typed = over.typed ?? ''
  if (typed !== 'fail') on('prompt.read', () => ({ value: { text: typed, cursor: 0 } }))
  on('ui.toast', (_$, e) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    log.logs.push(e.text)
    return { value: undefined }
  })
  on('session.append', (_$, e, next) => {
    if (over.appendDeny !== undefined) return { deny: over.appendDeny }
    const text = e.message.content[0]?.text
    if (typeof text === 'string') log.notices.push(text)
    return next(e)
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId, kind: 'engine' as const, ref: 1 }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  const ui = await $.ui.mount(PANE)
  return { clock, log, ui }
}

type Rig = Awaited<ReturnType<typeof boot>>

const startTurn = ($: Engine, id: string) => $.turn.start({ text: 'trabalhando', turnId: id })
const endTurn = ($: Engine, id: string) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
const press = (t: Rig) => t.ui.press({ key: 'compact' })
const label = async (t: Rig) => (await t.ui.find({ type: 'Button', key: 'compact' }))?.text
const tick = (t: Rig) => t.clock.advance(3_100)

describe('botão Compactar e continuar', () => {
  test('aparece no painel mesmo sem dados de git', async ($, on) => {
    const t = await boot($, on)
    expect(await label(t)).toBe('Compactar e continuar')
  })

  test('sessão parada: o clique vira análise com o Sonnet, compactação com as instruções e retomada', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    expect(await label(t)).toBe('Na fila…')
    await tick(t)
    expect(t.log.models).toEqual(['sonnet'])
    expect(t.log.prompts[0]).toContain('Bash → 3 testes passaram')
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.compacts[0]).toContain(COMPACT_CRITERIA)
    expect(t.log.compacts[0]).toContain('objetivo-x')
    expect(t.log.compacts[0]).toContain('passo-x')
    expect(t.log.submits.length).toBe(1)
    expect(t.log.submits[0]).toContain('passo-x')
    expect(t.log.submits[0]).toContain('pendente-x')
    expect(t.log.toasts).toContain('Compactado 120k → 18k tokens')
    expect(await label(t)).toBe('Compactar e continuar')
  })

  test('análise fora do formato: compacta só com os critérios e retoma pelo resumo', async ($, on) => {
    const t = await boot($, on, { answer: 'não sei' })
    await press(t)
    await tick(t)
    expect(t.log.compacts).toEqual([COMPACT_CRITERIA])
    expect(t.log.submits).toEqual([resumePromptOf(null)])
    expect(t.log.toasts.some(text => text.includes('Análise falhou'))).toBe(true)
  })

  test('modelo sem resposta: mesmo caminho, só com os critérios', async ($, on) => {
    const t = await boot($, on, { isAnswered: false })
    await press(t)
    await tick(t)
    expect(t.log.compacts).toEqual([COMPACT_CRITERIA])
    expect(t.log.submits.length).toBe(1)
  })

  test('compactação vetada: avisa o motivo, não retoma e o botão volta ao normal', async ($, on) => {
    const t = await boot($, on, { compact: async () => 'skip' })
    await press(t)
    await tick(t)
    expect(t.log.submits).toEqual([])
    expect(t.log.toasts.some(text => text.includes('vetado pelo teste'))).toBe(true)
    expect(await label(t)).toBe('Compactar e continuar')
  })

  test('clique com turno ativo: fica "Na fila…" e roda quando o turno acaba', async ($, on) => {
    const t = await boot($, on)
    await startTurn($, 't1')
    await press(t)
    expect(await label(t)).toBe('Na fila…')
    expect(t.log.toasts.some(text => text.includes('na fila'))).toBe(true)
    await tick(t)
    expect(t.log.compacts).toEqual([])
    await endTurn($, 't1')
    await tick(t)
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.submits.length).toBe(1)
  })

  test('segundo clique com a compactação na fila cancela, e nada roda depois', async ($, on) => {
    const t = await boot($, on)
    await startTurn($, 't1')
    await press(t)
    await press(t)
    expect(t.log.toasts.some(text => text.includes('cancelada'))).toBe(true)
    expect(await label(t)).toBe('Compactar e continuar')
    await endTurn($, 't1')
    await tick(t)
    expect(t.log.models).toEqual([])
    expect(t.log.compacts).toEqual([])
  })

  test('turno que começa e acaba durante a análise: volta para a fila e refaz depois', async ($, on) => {
    const t = await boot($, on, {
      onModel: async n => {
        if (n === 1) {
          await startTurn($, 't2')
          await endTurn($, 't2')
        }
      },
    })
    await press(t)
    await tick(t)
    expect(t.log.models.length).toBe(1)
    expect(t.log.compacts).toEqual([])
    expect(await label(t)).toBe('Na fila…')
    await tick(t)
    expect(t.log.models.length).toBe(2)
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.submits.length).toBe(1)
  })

  test('segundo clique durante a execução não roda duas vezes', async ($, on) => {
    const rig: { current?: Rig } = {}
    const t = await boot($, on, {
      onModel: async () => {
        if (rig.current !== undefined) await press(rig.current)
      },
    })
    rig.current = t
    await press(t)
    await tick(t)
    expect(t.log.toasts.some(text => text.includes('em andamento'))).toBe(true)
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.submits.length).toBe(1)
  })

  test('compact rejeita com a sessão parada: avisa o motivo e não repete a análise', async ($, on) => {
    const t = await boot($, on, { compact: async () => 'throw' })
    await press(t)
    await tick(t)
    // O texto do motivo é o do engine (o harness ignora o hook que lança e responde com o seu próprio erro).
    expect(t.log.toasts.some(text => text.startsWith('Compactação recusada: '))).toBe(true)
    expect(await label(t)).toBe('Compactar e continuar')
    await tick(t)
    await tick(t)
    expect(t.log.models.length).toBe(1)
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.submits).toEqual([])
  })

  test('compact rejeita porque um turno começou no meio: volta para a fila e tenta de novo depois', async ($, on) => {
    const t = await boot($, on, {
      compact: async n => {
        if (n > 1) return 'ok'
        await startTurn($, 't3')
        return 'throw'
      },
    })
    await press(t)
    await tick(t)
    expect(await label(t)).toBe('Na fila…')
    await endTurn($, 't3')
    await tick(t)
    expect(t.log.compacts.length).toBe(2)
    expect(t.log.submits.length).toBe(1)
  })

  test('prompt do usuário depois da compactação: não retoma por cima dele', async ($, on) => {
    const t = await boot($, on, {
      compact: async () => {
        await startTurn($, 't4')
        return 'ok'
      },
    })
    await press(t)
    await tick(t)
    expect(t.log.submits).toEqual([])
    expect(t.log.toasts.some(text => text.includes('não retomou'))).toBe(true)
    await endTurn($, 't4')
  })

  test('reload do mod (novo session.start) zera a fila', async ($, on) => {
    const t = await boot($, on)
    await startTurn($, 't5')
    await press(t)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    expect(await label(t)).toBe('Compactar e continuar')
    await endTurn($, 't5')
    await tick(t)
    expect(t.log.models).toEqual([])
  })
})

// Tarefa 0: o hook de `session.compact` só registra quem compactou, sem mudar nada, num aviso gravado no transcrito. É a
// prova de qual `trigger` chega ao mod quando o próprio Claude Code compacta.
describe('registro de toda compactação', () => {
  const MESSAGES = [{ role: 'user' as const, text: 'conversa longa', toolUses: [] }]
  const compactLog = (t: Rig) => t.log.notices.filter(text => text.startsWith('workbench: compactação '))

  test('automática com a sessão parada: registra trigger, agente, parada, resultado e retomada, e soma os critérios', async ($, on) => {
    const t = await boot($, on)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES, instructions: 'texto do engine' })
    expect(compactLog(t)).toEqual(['workbench: compactação trigger=auto, agente=não, parada=sim, resultado=compactou, retomada=não'])
    expect(t.log.compacts).toEqual([withCriteria('texto do engine')])
  })

  test('no meio de um turno e de subagente: parada=não e o id do agente', async ($, on) => {
    const t = await boot($, on)
    await startTurn($, 't1')
    await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'ag-1' })
    expect(compactLog(t)).toEqual(['workbench: compactação trigger=auto, agente=ag-1, parada=não, resultado=compactou, retomada=não'])
    expect(t.log.compacts).toEqual([undefined])
    await endTurn($, 't1')
  })

  test('compactação vetada embaixo: o registro diz o motivo', async ($, on) => {
    const t = await boot($, on, { compact: async () => 'skip' })
    await $.session.compact({ trigger: 'auto', messages: MESSAGES })
    expect(compactLog(t)).toEqual(['workbench: compactação trigger=auto, agente=não, parada=sim, resultado=vetada (vetado pelo teste), retomada=não'])
  })

  test('manual leva os critérios; precompute e a de outro mod passam intactos; todos aparecem; a do próprio botão não passa pelo hook', async ($, on) => {
    const t = await boot($, on)
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await $.session.compact({ trigger: 'precompute', messages: MESSAGES, instructions: 'pré' })
    await $.session.compact({ trigger: 'plugin', messages: MESSAGES, instructions: 'de outro mod' })
    await press(t)
    await tick(t)
    expect(t.log.compacts.slice(0, 3)).toEqual([COMPACT_CRITERIA, 'pré', 'de outro mod'])
    expect(t.log.compacts.length).toBe(4)
    expect(compactLog(t)).toEqual([
      'workbench: compactação trigger=manual, agente=não, parada=sim, resultado=compactou, retomada=não',
      'workbench: compactação trigger=precompute, agente=não, parada=sim, resultado=compactou, retomada=não',
      'workbench: compactação trigger=plugin, agente=não, parada=sim, resultado=compactou, retomada=não',
    ])
    expect(t.log.submits.length).toBe(1)
  })
})

// Tarefa 3: a retomada do botão confere o envio, vigia o turno dela e grava o aviso quando ele morre.
describe('retomada do botão', () => {
  const failed = (t: Rig) => t.log.notices.filter(text => text.startsWith('Retomada falhou'))
  const resumeText = (t: Rig) => t.log.submits.find(text => text.includes(RESUME_HEAD))
  const endWith = ($: Engine, id: string, reason: 'answer' | 'aborted' | 'refusal' | 'error') => {
    const fields = { answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: id }
    return reason === 'refusal'
      ? $.turn.complete({ ...fields, reason, refusal: { category: null, explanation: null } })
      : $.turn.complete({ ...fields, reason })
  }

  test('agentes rodando entram nas instruções e na retomada; os acabados não', async ($, on) => {
    const t = await boot($, on, {
      agents: [
        { id: 'ag-1', type: 'executor', status: 'running', description: 'roda os testes' },
        { id: 'ag-2', type: 'scout', status: 'completed', description: 'já voltou' },
      ],
    })
    await press(t)
    await tick(t)
    const line = 'Agentes ainda rodando: ag-1 (executor): roda os testes'
    expect(t.log.compacts[0]).toContain(line)
    expect(resumeText(t)).toContain(line)
    expect(resumeText(t)).not.toContain('ag-2')
  })

  test('a listagem de agentes falha: compacta e retoma sem a linha de agentes', async ($, on) => {
    const t = await boot($, on, { agents: 'fail' })
    await press(t)
    await tick(t)
    expect(t.log.submits.length).toBe(1)
    expect(t.log.submits[0]).not.toContain('Agentes ainda rodando')
  })

  test('campo de prompt com texto: compacta, não retoma e grava o aviso', async ($, on) => {
    const t = await boot($, on, { typed: 'rascunho meu' })
    await press(t)
    await tick(t)
    expect(t.log.compacts.length).toBe(1)
    expect(t.log.submits).toEqual([])
    expect(t.log.notices).toContain('Compactado, mas há texto no campo de prompt: não retomou sozinho.')
  })

  test('pedido recusado ({ drop }): grava o aviso com o motivo', async ($, on) => {
    const t = await boot($, on, { onSubmit: async () => ({ drop: 'limite de uso' }) })
    await press(t)
    await tick(t)
    expect(failed(t)).toEqual(['Retomada falhou: o prompt não entrou (limite de uso).'])
  })

  test('turno da retomada com erro, na ordem real (o turno começa antes de o envio resolver): grava o aviso', async ($, on) => {
    const t = await boot($, on, {
      onSubmit: async text => {
        if (text.includes(RESUME_HEAD)) await $.turn.start({ text, turnId: 'r1' })
        return undefined
      },
    })
    await press(t)
    await tick(t)
    expect(failed(t)).toEqual([])
    await endWith($, 'r1', 'error')
    expect(failed(t)).toEqual([resumeFailureOf('error')])
  })

  test('mesma coisa na ordem inversa (o envio resolve e o turno começa depois): o aviso sai igual', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    await tick(t)
    const text = resumeText(t) ?? ''
    await $.turn.start({ text: `moldura\n${text}`, turnId: 'r2' })
    await endWith($, 'r2', 'refusal')
    expect(failed(t)).toEqual([resumeFailureOf('refusal')])
  })

  test('turno da retomada que responde: nenhum aviso', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    await tick(t)
    await $.turn.start({ text: resumeText(t) ?? '', turnId: 'r3' })
    await endWith($, 'r3', 'answer')
    expect(failed(t)).toEqual([])
  })

  test('outro turno começa antes do da retomada: a vigia sai e o erro dele não vira aviso', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    await tick(t)
    await $.turn.start({ text: 'outro pedido', turnId: 'o1' })
    await endWith($, 'o1', 'error')
    await $.turn.start({ text: resumeText(t) ?? '', turnId: 'r4' })
    await endWith($, 'r4', 'error')
    expect(failed(t)).toEqual([])
  })

  test('recarga do mod zera a vigia: o turno da retomada depois dela não gera aviso', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    await tick(t)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await $.turn.start({ text: resumeText(t) ?? '', turnId: 'r5' })
    await endWith($, 'r5', 'error')
    expect(failed(t)).toEqual([])
  })

  test('aviso recusado pelo session.append: fica o toast e uma linha no log', async ($, on) => {
    const t = await boot($, on, { typed: 'rascunho', appendDeny: 'outro mod barrou' })
    await press(t)
    await tick(t)
    expect(t.log.toasts).toContain('Compactado, mas há texto no campo de prompt: não retomou sozinho.')
    expect(t.log.logs).toContain('workbench: aviso não gravado (outro mod barrou)')
  })
})

// Tarefa 4: a compactação do botão tem prazo (só avisa: a API não cancela) e a recarga no meio não deixa outra começar por cima.
describe('prazo e recarga da compactação do botão', () => {
  // A compactação fica presa até o teste soltar.
  const held = () => {
    const gate: { open?: () => void } = {}
    const wait = new Promise<void>(resolve => {
      gate.open = resolve
    })
    return { gate, compact: async () => {
      await wait
      return 'ok' as const
    } }
  }

  test('prazo estourado: grava o aviso, mantém a trava e, quando termina, não retoma', async ($, on) => {
    const h = held()
    const t = await boot($, on, { compact: h.compact })
    await press(t)
    await tick(t)
    expect(t.log.compacts.length).toBe(1)
    await t.clock.advance(COMPACT_TIMEOUT_MS)
    expect(t.log.notices).toContain('A compactação passou de 5 min sem terminar; o mod não vai retomar sozinho.')
    await press(t)
    expect(t.log.toasts).toContain('Compactação em andamento.')
    h.gate.open?.()
    await tick(t)
    expect(t.log.submits).toEqual([])
    expect(await label(t)).toBe('Compactar e continuar')
  })

  test('compactação que termina no prazo não grava o aviso de prazo', async ($, on) => {
    const t = await boot($, on)
    await press(t)
    await tick(t)
    await t.clock.advance(COMPACT_TIMEOUT_MS)
    expect(t.log.notices.some(text => text.includes('5 min'))).toBe(false)
    expect(t.log.submits.length).toBe(1)
  })

  test('um prompt entrou durante a compactação: o aviso fica gravado', async ($, on) => {
    const t = await boot($, on, {
      compact: async () => {
        await startTurn($, 't6')
        return 'ok'
      },
    })
    await press(t)
    await tick(t)
    expect(t.log.notices).toContain('Compactado, mas um prompt entrou antes: não retomou sozinho.')
    await endTurn($, 't6')
  })

  test('recarga durante a compactação: grava o aviso, e o botão recusa até um turno começar', async ($, on) => {
    const h = held()
    const t = await boot($, on, { compact: h.compact })
    await press(t)
    await tick(t)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    expect(t.log.notices).toContain('O mod recarregou durante a compactação: confira a conversa e clique de novo se precisar.')
    await press(t)
    expect(t.log.toasts).toContain('Compactação em andamento (começou antes de o mod recarregar).')
    expect(await label(t)).toBe('Compactar e continuar')
    await startTurn($, 't7')
    await endTurn($, 't7')
    await press(t)
    expect(await label(t)).toBe('Na fila…')
    h.gate.open?.()
  })

  test('recarga durante a compactação com o relógio longe do zero: o botão recusa do mesmo jeito', async ($, on) => {
    const h = held()
    const t = await boot($, on, { compact: h.compact })
    await t.clock.advance(10 * COMPACT_TIMEOUT_MS)
    await press(t)
    await tick(t)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await press(t)
    expect(t.log.toasts).toContain('Compactação em andamento (começou antes de o mod recarregar).')
    h.gate.open?.()
  })

  test('recarga sem compactação em curso: nenhum aviso', async ($, on) => {
    const t = await boot($, on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    expect(t.log.notices.some(text => text.includes('recarregou'))).toBe(false)
  })
})

// Tarefa 5: depois da compactação automática com a sessão parada, o mod retoma sozinho, no máximo uma vez por pedido seu.
describe('retomada depois da compactação automática', () => {
  const MESSAGES = [{ role: 'user' as const, text: 'conversa longa', toolUses: [] }]
  const auto = ($: Engine) => $.session.compact({ trigger: 'auto', messages: MESSAGES })
  const resumes = (t: Rig) => t.log.submits.filter(text => text.includes(RESUME_HEAD))
  const userSays = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  // Um turno visto desde a carga do mod: sem isso a sessão "parada" pode ser só o contador zerado pela recarga.
  const warm = async ($: Engine) => {
    await startTurn($, 'w1')
    await endTurn($, 'w1')
  }

  test('sessão parada depois de um turno: retoma no tique seguinte, com a frase de parar se acabou', async ($, on) => {
    const t = await boot($, on, { agents: [{ id: 'ag-9', type: 'executor', status: 'running', description: 'revisa' }] })
    await warm($)
    await auto($)
    expect(t.log.notices).toContain('workbench: compactação trigger=auto, agente=não, parada=sim, resultado=compactou, retomada=marcada')
    await tick(t)
    expect(resumes(t)).toEqual([resumePromptOf(null, [{ id: 'ag-9', type: 'executor', description: 'revisa' }])])
    await tick(t)
    expect(resumes(t).length).toBe(1)
  })

  test('no meio de um turno não retoma (o próprio Claude Code segue o turno)', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await startTurn($, 'm1')
    await auto($)
    await endTurn($, 'm1')
    await tick(t)
    expect(resumes(t)).toEqual([])
  })

  test('sem nenhum turno visto desde a carga do mod, não retoma', async ($, on) => {
    const t = await boot($, on)
    await auto($)
    await tick(t)
    expect(resumes(t)).toEqual([])
  })

  test('/compact digitado: leva os critérios depois do texto do usuário e não retoma', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'foque no frete' })
    await tick(t)
    expect(t.log.compacts).toEqual([withCriteria('foque no frete')])
    expect(resumes(t)).toEqual([])
  })

  test('compactação de outro mod ou de subagente não retoma', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await $.session.compact({ trigger: 'plugin', messages: MESSAGES })
    await tick(t)
    await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'ag-1' })
    await tick(t)
    expect(resumes(t)).toEqual([])
  })

  test('compactação vetada embaixo não retoma', async ($, on) => {
    const t = await boot($, on, { compact: async () => 'skip' })
    await warm($)
    await auto($)
    await tick(t)
    expect(resumes(t)).toEqual([])
  })

  test('segunda automática sem pedido seu: grava o aviso de teto e não retoma; depois de um pedido seu, retoma de novo', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await auto($)
    await tick(t)
    expect(resumes(t).length).toBe(1)
    await startTurn($, 'r1')
    await endTurn($, 'r1')
    await auto($)
    await tick(t)
    expect(resumes(t).length).toBe(1)
    expect(t.log.notices).toContain('Compactado sozinho, sem retomar: já houve uma retomada automática sem pedido seu depois.')
    await userSays($, 'segue')
    await startTurn($, 'u1')
    await endTurn($, 'u1')
    await auto($)
    await tick(t)
    expect(resumes(t).length).toBe(2)
  })

  test('campo de prompt com texto: grava o aviso e não manda', async ($, on) => {
    const t = await boot($, on, { typed: 'rascunho' })
    await warm($)
    await auto($)
    await tick(t)
    expect(resumes(t)).toEqual([])
    expect(t.log.notices).toContain('Compactado sozinho, sem retomar: há texto no campo de prompt.')
  })

  test('não lê o campo de prompt: grava o aviso em vez de ficar calado', async ($, on) => {
    const t = await boot($, on, { typed: 'fail' })
    await warm($)
    await auto($)
    await tick(t)
    expect(resumes(t)).toEqual([])
    expect(t.log.notices).toContain('Retomada automática não enviada: não deu para ler o campo de digitação.')
  })

  test('botão Compactar na fila ou rodando: descarta a retomada automática com aviso, e o tique seguinte não manda', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await auto($)
    await press(t)
    await tick(t)
    await tick(t)
    expect(t.log.submits).not.toContain(resumePromptOf(null))
    expect(resumes(t)).toHaveLength(1)
    expect(t.log.notices).toContain(BUSY)
  })

  test('botão Retomada na fila: descarta a retomada automática com aviso', async ($, on) => {
    const t = await boot($, on)
    const band = await $.ui.mount(BAND)
    await warm($)
    await auto($)
    await band.press({ key: 'resume' })
    await tick(t)
    expect(resumes(t)).toEqual([])
    expect(t.log.notices).toContain(BUSY)
  })

  test('um turno começa antes do tique: descarta sem aviso', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await auto($)
    await startTurn($, 'u2')
    await tick(t)
    await endTurn($, 'u2')
    await tick(t)
    expect(resumes(t)).toEqual([])
    expect(t.log.notices.some(text => text.startsWith('Compactado sozinho'))).toBe(false)
  })

  test('recarga zera a retomada marcada e o turno visto', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await auto($)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await tick(t)
    await auto($)
    await tick(t)
    expect(resumes(t)).toEqual([])
  })

  test('a retomada automática que morre com erro também grava o aviso', async ($, on) => {
    const t = await boot($, on)
    await warm($)
    await auto($)
    await tick(t)
    await $.turn.start({ text: resumes(t)[0] ?? '', turnId: 'r9' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'r9', reason: 'error' })
    expect(t.log.notices).toContain(resumeFailureOf('error'))
  })
})
