import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { COMPACT_CRITERIA, resumePromptOf } from '../hooks/compact'

// Fluxo inteiro pelo engine: o `$` real do plugin, o painel montado, o botão apertado, o relógio e o armazenamento
// simulados, e hooks do teste no lugar do engine (conversa, modelo, compactação, prompt, toast, turnos). As variáveis do
// módulo são zeradas pelo `session.start` de cada `boot`: nenhum teste herda a fila do anterior.
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const GOOD = JSON.stringify({ objetivo: 'objetivo-x', fase: 'implementando', feito: ['a'], pendente: ['pendente-x'], contexto: 'ctx', proximoPasso: 'passo-x' })

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
}

async function boot($: Engine, on: On, over: Over = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const log = { models: [] as string[], compacts: [] as (string | undefined)[], submits: [] as string[], toasts: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'quero o botão de compactação', toolUses: [] }] }))
  on('model.complete', async (_$, e) => {
    log.models.push(e.model)
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
  on('prompt.submit', (_$, e) => {
    log.submits.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', (_$, e) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
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
