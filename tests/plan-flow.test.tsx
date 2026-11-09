import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { executePromptOf, planPromptOf } from '../hooks/plan'

// Planejar pelo engine: a faixa montada, o botão apertado, o timer de 3 s, e hooks do teste no lugar do engine (campo de
// prompt, envio, toast, turnos). O `session.start` de cada `boot` zera as variáveis do módulo; o estado `planFlow` fica
// em `$.state`, que o teste só zera ao criar o engine.
const BAND = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REFINED = { intencao: 'intencao-x', contexto: ['contexto-x'], duvidas: ['duvida-x'] }

type Over = {
  typed?: string
  isFilled?: boolean
  answer?: string
  isAnswered?: boolean
  // Roda dentro do model.complete (n = a chamada): é onde o usuário edita o campo ou clica de novo durante o refinamento.
  onModel?: (n: number) => Promise<void>
}

async function boot($: Engine, on: On, over: Over = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  // O campo de prompt: o teste muda `box.text` no meio do refinamento para simular a edição do usuário.
  const box = { text: over.typed ?? '' }
  const log = { fills: [] as string[], submits: [] as string[], toasts: [] as string[], logs: [] as string[], models: [] as string[], prompts: [] as string[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('ui.log', (_$, e) => {
    log.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    log.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'conversa-x', toolUses: [] }] }))
  // Só o CLAUDE.md existe (o engine entrega o caminho já absoluto): o AGENTS.md cai no engine do teste e fica de fora.
  on('fs.read', (_$, e, next) => (/[\\/]CLAUDE\.md$/.test(e.path) ? { value: 'claude-x' } : next(e)))
  on('model.complete', async (_$, e) => {
    log.models.push(e.model)
    log.prompts.push(e.prompt)
    await over.onModel?.(log.models.length)
    if (over.isAnswered === false) return { value: { isAnswered: false as const, reason: 'aborted' as const, usage: USAGE } }
    return { value: { isAnswered: true as const, text: over.answer ?? JSON.stringify(REFINED), usage: USAGE } }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    log.fills.push(e.text)
    const isFilled = over.isFilled !== false
    if (isFilled) box.text = e.text
    return { isFilled }
  })
  on('prompt.submit', (_$, e) => {
    log.submits.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId, kind: 'engine' as const, ref: 1 }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return { clock, log, box }
}

const tick = (t: { clock: { advance: (ms: number) => unknown } }) => t.clock.advance(3_100)
const mountBand = ($: Engine) => $.ui.mount(BAND)
const labelOf = async (ui: Awaited<ReturnType<typeof mountBand>>) => (await ui.find({ type: 'Button', key: 'plan' }))?.text

// Um comando do EGM digitado: o engine raise prompt.submit com `command`.
const typeCommand = ($: Engine, name: string, args = '') =>
  $.prompt.submit({ text: `/${name} ${args}`.trim(), wait: false, origin: { kind: 'composer' }, command: { name, args } })

describe('botão EGM na faixa', () => {
  test('começa em "EGM" e o clique escreve o comando no campo, com o que já estava digitado', async ($, on) => {
    const t = await boot($, on, { typed: 'webhooks de entrega' })
    const ui = await $.ui.mount(BAND)
    expect(await labelOf(ui)).toBe('EGM')
    await ui.press({ key: 'plan' })
    await tick(t)
    expect(t.log.fills).toEqual(['/egm:egm-brainstorm webhooks de entrega'])
  })

  test('o clique só enfileira: sem o timer nada é escrito', async ($, on) => {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'plan' })
    expect(t.log.fills).toEqual([])
  })

  test('um clique escreve uma vez só, mesmo com o timer girando de novo', async ($, on) => {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'plan' })
    await tick(t)
    await tick(t)
    expect(t.log.fills).toHaveLength(1)
  })

  test('a etapa avança quando o comando do EGM entra, não no clique', async ($, on) => {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'plan' })
    await tick(t)
    expect(await labelOf(ui)).toBe('EGM')
    await typeCommand($, 'egm:egm-brainstorm', 'webhooks')
    expect(await labelOf(ui)).toBe('EGM: Rascunho')
    await typeCommand($, 'egm:egm-draft')
    expect(await labelOf(ui)).toBe('EGM: Revisão')
    await typeCommand($, 'egm:egm-review', 'docs/designs/a.md')
    expect(await labelOf(ui)).toBe('EGM: Executar')
  })

  test('comando de fora do fluxo não muda a etapa', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(BAND)
    await typeCommand($, 'route', 'algo')
    expect(await labelOf(ui)).toBe('EGM')
  })

  test('campo bloqueado por diálogo: avisa por toast e a etapa fica onde estava', async ($, on) => {
    const t = await boot($, on, { isFilled: false })
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'plan' })
    await tick(t)
    expect(t.log.toasts.some(text => text.includes('/egm:egm-brainstorm'))).toBe(true)
    expect(await labelOf(ui)).toBe('EGM')
  })

  test('uma recarga do mod no meio do fluxo não volta a etapa para o começo', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(BAND)
    await typeCommand($, 'egm:egm-brainstorm', 'x')
    expect(await labelOf(ui)).toBe('EGM: Rascunho')
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    expect(await labelOf(ui)).toBe('EGM: Rascunho')
  })
})

describe('Executar', () => {
  async function readyToExecute($: Engine, on: On) {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    await typeCommand($, 'egm:egm-brainstorm', 'x')
    await typeCommand($, 'egm:egm-draft')
    await typeCommand($, 'egm:egm-review', 'docs/designs/a.md')
    t.log.submits.length = 0
    return { t, ui }
  }

  test('envia o pedido de execução com o doc revisado e volta para "EGM"', async ($, on) => {
    const { t, ui } = await readyToExecute($, on)
    expect(await labelOf(ui)).toBe('EGM: Executar')
    await ui.press({ key: 'plan' })
    await tick(t)
    expect(t.log.submits).toEqual([executePromptOf('docs/designs/a.md')])
    expect(await labelOf(ui)).toBe('EGM')
  })

  test('com um turno em andamento espera a sessão parar antes de enviar', async ($, on) => {
    const { t, ui } = await readyToExecute($, on)
    await $.turn.start({ text: 'trabalhando', turnId: 't1' })
    await ui.press({ key: 'plan' })
    await tick(t)
    expect(t.log.submits).toEqual([])
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await tick(t)
    expect(t.log.submits).toEqual([executePromptOf('docs/designs/a.md')])
  })
})

describe('botão Planejar (refinamento para o /plan)', () => {
  type Rig = Awaited<ReturnType<typeof boot>> & { ui: Awaited<ReturnType<typeof mountBand>> }
  const press = (r: Rig) => r.ui.press({ key: 'refine' })
  const label = async (r: Rig) => (await r.ui.find({ type: 'Button', key: 'refine' }))?.text

  async function rig($: Engine, on: On, over: Over = {}): Promise<Rig> {
    const t = await boot($, on, over)
    return { ...t, ui: await mountBand($) }
  }

  test('texto no campo: o Sonnet refina com a conversa e o CLAUDE.md, e o campo vira /plan', async ($, on) => {
    const r = await rig($, on, { typed: '/egm:egm-brainstorm pesquisar pedido pelo produto' })
    expect(await label(r)).toBe('Planejar')
    await press(r)
    expect(await label(r)).toBe('Refinando…')
    await tick(r)
    expect(r.log.models).toEqual(['sonnet'])
    expect(r.log.prompts[0]).toContain('pesquisar pedido pelo produto')
    expect(r.log.prompts[0]).toContain('conversa-x')
    expect(r.log.prompts[0]).toContain('claude-x')
    expect(r.log.prompts[0]).not.toContain('AGENTS.md')
    expect(r.log.fills).toEqual([planPromptOf(REFINED, 'pesquisar pedido pelo produto')])
    expect(r.log.toasts).toEqual([])
    expect(await label(r)).toBe('Planejar')
  })

  test('o clique só enfileira: sem o timer o modelo não é chamado', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido' })
    await press(r)
    expect(r.log.models).toEqual([])
  })

  test('campo vazio ou só com /egm:…: pede a intenção e não chama o modelo', async ($, on) => {
    const r = await rig($, on, { typed: '  /egm:egm-brainstorm  ' })
    await press(r)
    await tick(r)
    expect(r.log.toasts).toEqual(['Escreva a intenção no campo antes de clicar em Planejar'])
    expect(r.log.models).toEqual([])
    expect(r.log.fills).toEqual([])
    expect(await label(r)).toBe('Planejar')
  })

  test('campo já com /plan: avisa e não chama o modelo', async ($, on) => {
    const r = await rig($, on, { typed: '/plan buscar pedido\nFluxo:' })
    await press(r)
    await tick(r)
    expect(r.log.toasts).toEqual(['O campo já tem um /plan refinado: aperte Enter, ou apague para refinar de novo'])
    expect(r.log.models).toEqual([])
    expect(r.log.fills).toEqual([])
  })

  test('modelo sem resposta: escreve o /plan com o texto original e o fluxo, e avisa', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido', isAnswered: false })
    await press(r)
    await tick(r)
    expect(r.log.fills).toEqual([planPromptOf(null, 'pesquisar pedido')])
    expect(r.log.toasts).toEqual(['Refinamento falhou: segue com o seu texto'])
  })

  test('resposta fora do formato: mesmo caminho do original', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido', answer: 'não sei' })
    await press(r)
    await tick(r)
    expect(r.log.fills).toEqual([planPromptOf(null, 'pesquisar pedido')])
  })

  test('campo editado durante o refinamento: não sobrescreve, avisa e guarda o texto no log', async ($, on) => {
    const holder: { current?: Rig } = {}
    const r = await rig($, on, {
      typed: 'pesquisar pedido',
      onModel: async () => {
        if (holder.current !== undefined) holder.current.box.text = 'pesquisar pedido e cliente'
      },
    })
    holder.current = r
    await press(r)
    await tick(r)
    expect(r.log.fills).toEqual([])
    expect(r.log.toasts).toEqual(['Você editou o campo: refinamento descartado (está no log do workbench)'])
    expect(r.log.logs.some(text => text.includes(planPromptOf(REFINED, 'pesquisar pedido')))).toBe(true)
    expect(await label(r)).toBe('Planejar')
  })

  test('campo bloqueado por diálogo: avisa e guarda o texto no log', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido', isFilled: false })
    await press(r)
    await tick(r)
    expect(r.log.toasts).toEqual(['Não deu para escrever no campo de prompt (há um diálogo aberto?): o texto está no log do workbench'])
    expect(r.log.logs.some(text => text.includes(planPromptOf(REFINED, 'pesquisar pedido')))).toBe(true)
  })

  test('cliques repetidos, na fila ou durante o refinamento, fazem uma chamada só', async ($, on) => {
    const holder: { current?: Rig } = {}
    const r = await rig($, on, {
      typed: 'pesquisar pedido',
      onModel: async () => {
        if (holder.current !== undefined) await press(holder.current)
      },
    })
    holder.current = r
    await press(r)
    await press(r)
    await tick(r)
    await tick(r)
    expect(r.log.models).toHaveLength(1)
    expect(r.log.fills).toHaveLength(1)
  })

  test('depois de terminar, um clique novo volta a funcionar (campo novo)', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido' })
    await press(r)
    await tick(r)
    r.box.text = 'outra intencao'
    await press(r)
    await tick(r)
    expect(r.log.models).toHaveLength(2)
    expect(r.log.fills[1]).toBe(planPromptOf(REFINED, 'outra intencao'))
  })

  test('uma recarga do mod zera a trava e o rótulo', async ($, on) => {
    const r = await rig($, on, { typed: 'pesquisar pedido' })
    await press(r)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    expect(await label(r)).toBe('Planejar')
    await tick(r)
    expect(r.log.models).toEqual([])
  })
})
