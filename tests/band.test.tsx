import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// A faixa fixa acima do prompt (como a do ponytail) e o nome do comando. Mesmo esquema dos outros testes de engine:
// o `$` real do plugin, relógio e armazenamento simulados, e hooks do teste no lugar do engine.
const BAND = {
  plugin: 'workbench',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

const SNAPSHOT = {
  root: '/repo',
  base: 'origin/main',
  baseHead: 'abc1234',
  baseMigration: null,
  rows: [],
  detachedPrunable: [],
  isPrKnown: true,
  fetchedAt: null,
  errors: [],
  at: 0,
}

async function boot($: Engine, on: On, over: { snapshot?: boolean } = {}) {
  mock.clock(on)
  mock.store(on)
  const log = { registered: [] as string[], opened: [] as { id: string; focus?: boolean }[], statuses: [] as (string | undefined)[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    log.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('ui.open', (_$, e) => {
    log.opened.push({ id: e.id, focus: e.focus })
    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    log.statuses.push(e.text)
    return { value: undefined }
  })
  // Outra faixa embaixo do plugin (o engine ou outro mod): a do workbench tem que conviver com ela.
  on('ui.render', ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>outra faixa</Text>
  })
  // Só o teste que precisa de uma leitura de git anterior troca o estado do engine por um mapa: esse mapa não avisa os
  // desenhos quando algo muda, então os demais testes usam o estado reativo de verdade.
  if (over.snapshot === true) {
    const held = new Map<string, unknown>([['snapshot', SNAPSHOT]])
    on('state.get', (_$, e) => ({ value: { value: held.get(e.key), version: 1 } }))
    on('state.set', (_$, e) => {
      held.set(e.key, e.value)
      return { value: { isSet: true as const, version: 1 } }
    })
  }
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return { log }
}

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

describe('faixa do workbench acima do prompt', () => {
  test('sem leitura de git: diz que não há dados e ainda oferece Compactar e abrir o painel', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(BAND)
    expect((await ui.find({ type: 'Text', text: /workbench/ }))?.text).toContain('sem dados')
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'panel' })).toBeDefined()
  })

  test('com leitura de git: mostra o resumo das worktrees', async ($, on) => {
    await boot($, on, { snapshot: true })
    const ui = await $.ui.mount(BAND)
    expect((await ui.find({ type: 'Text', text: /workbench/ }))?.text).toContain('0 worktrees')
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  })

  test('o botão Painel abre o painel com foco', async ($, on) => {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'panel' })
    expect(t.log.opened).toEqual([{ id: 'workbench', focus: true }])
  })

  test('o botão Compactar e continuar enfileira a compactação', async ($, on) => {
    const t = await boot($, on)
    const ui = await $.ui.mount(BAND)
    expect((await ui.find({ type: 'Button', key: 'compact' }))?.text).toBe('Compactar e continuar')
    await ui.press({ key: 'compact' })
    expect((await ui.find({ type: 'Button', key: 'compact' }))?.text).toBe('Na fila…')
  })

  test('convive com a faixa de outro mod: a outra continua desenhada embaixo', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /outra faixa/ })).toBeDefined()
  })

  test('cede a vez a uma pesquisa em andamento', async ($, on) => {
    await boot($, on)
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /outra faixa/ })).toBeDefined()
  })
})

describe('statusline', () => {
  test('o mod nunca escreve nela: só apaga, no início, a linha que uma versão antiga deixou fixa', async ($, on) => {
    const t = await boot($, on)
    await $.ui.mount(BAND)
    await run($, 'workbench', 'stale')
    expect(t.log.statuses).toEqual([undefined])
  })
})

describe('comando /workbench', () => {
  test('registra workbench e não registra mais drift', async ($, on) => {
    const t = await boot($, on)
    expect(t.log.registered).toContain('workbench')
    expect(t.log.registered).not.toContain('drift')
  })

  test('sem argumento abre o painel', async ($, on) => {
    const t = await boot($, on)
    const answered = await run($, 'workbench')
    expect(answered.text).toContain('Painel do workbench aberto')
    expect(t.log.opened).toEqual([{ id: 'workbench', focus: true }])
  })

  test('stale e base respondem fora de um repositório git', async ($, on) => {
    await boot($, on)
    expect((await run($, 'workbench', 'stale')).text).toContain('repositório git')
    expect((await run($, 'workbench', 'base origin/develop')).text).toContain('repositório git')
  })
})
