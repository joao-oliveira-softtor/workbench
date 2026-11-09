import { describe, expect, test } from 'claude-code/testing'

import type { Row, Snapshot } from '../types'
import {
  activityOf,
  countDirty,
  fetchAgeLabel,
  freedKb,
  gitdirOf,
  handoffTable,
  isFetchStale,
  isInside,
  issueOf,
  latestMigration,
  lineOf,
  mapLimit,
  parseCounts,
  parseDetachedPrunable,
  parseOwnKb,
  parsePrs,
  parseRefs,
  parseWorktrees,
  settle,
  sizeLabel,
  sortRows,
  staleMigrations,
  stateOf,
  bandOf,
  summaryOf,
  totalSizeKb,
} from '../hooks/model'

function row(over: Partial<Row>): Row {
  return {
    branch: 'fix/1163-reserva',
    path: '/repo/.worktrees/a',
    head: 'aaa111',
    issue: '1163',
    ahead: 1,
    behind: 0,
    push: 'none',
    unpushed: 0,
    pr: null,
    staleMigrations: [],
    isStamped: null,
    dirty: 0,
    lastCommitAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    isPrunable: false,
    isLocked: false,
    ownKb: null,
    submodules: 'none',
    isCurrent: false,
    error: null,
    ...over,
  }
}

function snap(rows: Row[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    root: '/repo',
    base: 'origin/v2.1.0',
    baseHead: 'abc1234',
    baseMigration: '20261006100000',
    rows,
    detachedPrunable: [],
    isPrKnown: true,
    fetchedAt: null,
    errors: [],
    at: 0,
    ...over,
  }
}

describe('parsers', () => {
  test('worktrees: ignora o checkout principal e as destacadas', async () => {
    const porcelain = [
      'worktree /repo\nHEAD 111\nbranch refs/heads/main',
      'worktree /repo/.worktrees/a\nHEAD 222\nbranch refs/heads/fix/1163-x',
      'worktree /repo/.worktrees/b\nHEAD 333\ndetached',
    ].join('\n\n')
    expect(parseWorktrees(porcelain)).toEqual([
      { path: '/repo/.worktrees/a', branch: 'fix/1163-x', head: '222', isPrunable: false, isLocked: false },
    ])
  })

  test('worktrees: lê prunable e locked, e lista as destacadas sem diretório e sem trava', async () => {
    const porcelain = [
      'worktree /repo\nHEAD 111\nbranch refs/heads/main',
      'worktree /tmp/gone\nHEAD 222\nbranch refs/heads/fix/gone\nprunable gitdir file points to non-existent location',
      'worktree /repo/.worktrees/lock\nHEAD 333\nbranch refs/heads/fix/lock\nlocked trabalhando',
      'worktree /tmp/detached\nHEAD 444\ndetached\nprunable gitdir file points to non-existent location',
      'worktree /tmp/detached-locked\nHEAD 555\ndetached\nlocked\nprunable gitdir file points to non-existent location',
    ].join('\n\n')
    expect(parseWorktrees(porcelain)).toEqual([
      { path: '/tmp/gone', branch: 'fix/gone', head: '222', isPrunable: true, isLocked: false },
      { path: '/repo/.worktrees/lock', branch: 'fix/lock', head: '333', isPrunable: false, isLocked: true },
    ])
    expect(parseDetachedPrunable(porcelain)).toEqual([{ path: '/tmp/detached', head: '444' }])
  })

  test('refs: sem upstream, remota apagada, commits sem push e em dia, com a data do último commit', async () => {
    const refs = parseRefs('a\t\t\t\nb\torigin/b\t[gone]\t1700000000\nc\torigin/c\t[ahead 3, behind 2]\t1700000100\nd\torigin/d\t\t\n')
    expect(refs.get('a')).toEqual({ push: 'none', unpushed: 0, lastCommitAt: null })
    expect(refs.get('b')).toEqual({ push: 'gone', unpushed: 0, lastCommitAt: 1_700_000_000_000 })
    expect(refs.get('c')).toEqual({ push: 'unpushed', unpushed: 3, lastCommitAt: 1_700_000_100_000 })
    expect(refs.get('d')).toEqual({ push: 'ok', unpushed: 0, lastCommitAt: null })
  })

  test('PRs: a mais nova vence, salvo uma aberta mais antiga', async () => {
    const json = JSON.stringify([
      { number: 30, headRefName: 'x', headRefOid: 'h3', state: 'CLOSED' },
      { number: 20, headRefName: 'x', headRefOid: 'h2', state: 'OPEN' },
      { number: 10, headRefName: 'y', headRefOid: 'h1', state: 'MERGED' },
      { number: 5, headRefName: 'y', headRefOid: 'h0', state: 'CLOSED' },
    ])
    const prs = parsePrs(json)
    expect(prs.get('x')?.number).toBe(20)
    expect(prs.get('y')?.number).toBe(10)
  })

  test('migrations: última da base e as da branch com timestamp anterior', async () => {
    const base = 'apps/api/prisma/migrations/20261001000000_a\napps/api/prisma/migrations/20261006100000_b\napps/api/prisma/migrations/migration_lock.toml\n'
    expect(latestMigration(base)).toBe('20261006100000')
    const added = [
      'apps/api/prisma/migrations/20260928160000_old/migration.sql',
      'apps/api/prisma/migrations/20261006120000_new/migration.sql',
    ].join('\n')
    expect(staleMigrations(added, '20261006100000')).toEqual(['20260928160000_old'])
    expect(staleMigrations(added, null)).toEqual([])
  })

  test('contagens e número da issue', async () => {
    expect(parseCounts('25\t9\n')).toEqual({ behind: 25, ahead: 9 })
    expect(issueOf('fix/1163-reserva-atomica-tools')).toBe('1163')
    expect(issueOf('feat/hosted-chat-link-exchange')).toBe(null)
    expect(issueOf('chore/2131-retirar')).toBe('2131')
  })

  test('status: conta arquivos alterados e não rastreados', async () => {
    expect(countDirty('')).toBe(0)
    expect(countDirty(' M a.ts\n?? novo.ts\nA  b.ts\n')).toBe(3)
  })
})

describe('coleta', () => {
  test('settle isola a falha: a rejeição vira dado, não exceção', async () => {
    const bad = await settle(async () => {
      throw new Error('spawn bash ENOENT')
    })
    expect(bad).toEqual({ ok: false, error: 'spawn bash ENOENT' })
    expect(await settle(async () => 7)).toEqual({ ok: true, value: 7 })
  })

  test('settle numa lista: só a worktree que falhou vira erro', async () => {
    const results = await mapLimit(['a', 'b', 'c'], 2, name =>
      settle(async () => {
        if (name === 'b') throw new Error('sem diretório')
        return name
      }),
    )
    expect(results.map(r => r.ok)).toEqual([true, false, true])
  })

  test('mapLimit mantém a ordem e nunca passa do limite em voo', async () => {
    let live = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise<void>(resolve => resolve())
      await new Promise<void>(resolve => resolve())
      live -= 1
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
    expect(peak <= 3).toBe(true)
    expect(await mapLimit([], 4, async n => n)).toEqual([])
  })

  test('gitdir: absoluto, relativo e conteúdo inválido', async () => {
    expect(gitdirOf('gitdir: /repo/.git/worktrees/a\n', '/repo/.worktrees/a')).toBe('/repo/.git/worktrees/a')
    expect(gitdirOf('gitdir: ../../.git/worktrees/a\n', '/repo/.worktrees/a')).toBe('/repo/.git/worktrees/a')
    expect(gitdirOf('lixo', '/repo/.worktrees/a')).toBe(null)
  })

  test('isInside compara por segmento: /a não casa com /ab', async () => {
    expect(isInside('/repo/.worktrees/a', '/repo/.worktrees/a')).toBe(true)
    expect(isInside('/repo/.worktrees/a/apps/api', '/repo/.worktrees/a')).toBe(true)
    expect(isInside('/repo/.worktrees/ab', '/repo/.worktrees/a')).toBe(false)
    expect(isInside('', '/repo/.worktrees/a')).toBe(false)
  })

  test('atividade: a mais recente entre o último commit, o reflog e o index, em ms', async () => {
    expect(activityOf(1_000, 5_000, null)).toBe(5_000)
    expect(activityOf(9_000, 5_000, null)).toBe(9_000)
    expect(activityOf(null, 5_000, null)).toBe(5_000)
    expect(activityOf(1_000, 5_000, 7_000)).toBe(7_000)
    expect(activityOf(null, null, 3_000)).toBe(3_000)
    expect(activityOf(null, null, null)).toBe(null)
  })

  test('fetch: rótulo e aviso de base velha', async () => {
    const now = 10 * 3_600_000
    expect(fetchAgeLabel(null, now)).toBe('sem fetch')
    expect(fetchAgeLabel(now - 30_000, now)).toBe('fetch agora')
    expect(fetchAgeLabel(now - 3 * 3_600_000, now)).toBe('fetch há 3h')
    expect(isFetchStale(now - 3_600_000, now)).toBe(false)
    expect(isFetchStale(now - 3 * 3_600_000, now)).toBe(true)
    expect(isFetchStale(null, now)).toBe(true)
  })
})

describe('apresentação', () => {
  test('estado: sem a lista do gh não afirma "sem PR"', async () => {
    expect(stateOf(row({}), true)).toBe('sem PR')
    expect(stateOf(row({}), false)).toBe('PR ?')
    expect(stateOf(row({ pr: { number: 9, state: 'MERGED', headOid: 'aaa111' } }), true)).toBe('PR #9 mergeada')
    expect(stateOf(row({ pr: { number: 9, state: 'MERGED', headOid: 'zzz' } }), true)).toBe('PR #9 mergeada, HEAD andou')
  })

  test('ordem: migration fora de ordem, sem PR, PR aberta, mergeada, sem diretório por último', async () => {
    const merged = row({ branch: 'm', pr: { number: 1, state: 'MERGED', headOid: 'aaa111' } })
    const open = row({ branch: 'o', pr: { number: 2, state: 'OPEN', headOid: 'x' } })
    const loose = row({ branch: 'l' })
    const stale = row({ branch: 's', pr: { number: 3, state: 'OPEN', headOid: 'x' }, staleMigrations: ['20260101000000_x'] })
    const gone = row({ branch: 'g', isPrunable: true })
    expect(sortRows([gone, merged, open, loose, stale]).map(r => r.branch)).toEqual(['s', 'l', 'o', 'm', 'g'])
  })

  test('linha: marca a selecionada e mostra mudanças locais e sem diretório', async () => {
    const dirty = lineOf(row({ dirty: 3 }), true, true)
    expect(dirty.startsWith('›')).toBe(true)
    expect(dirty).toContain('±3')
    expect(lineOf(row({ dirty: 0 }), true, false)).not.toContain('±')
    expect(lineOf(row({ isPrunable: true }), true, false)).toContain('PRUNE')
    expect(lineOf(row({ isLocked: true }), true, false)).toContain('LOCK')
  })

  test('resumo e handoff deixam de fora o que já entrou igual', async () => {
    const merged = row({ branch: 'feat/merged', pr: { number: 1, state: 'MERGED', headOid: 'aaa111' } })
    const loose = row({ branch: 'fix/1163-reserva', staleMigrations: ['20260928160000_old'] })
    const s = snap([merged, loose])
    expect(summaryOf(s)).toBe('workbench: 2 worktrees · 1 sem PR · 0 PR aberta · 1 migration atrás da base · 1 mergeadas')
    const table = handoffTable(s)
    expect(table).toContain('| fix/1163-reserva | #1163 |')
    expect(table).toContain('| sem PR; 1 à frente, 0 atrás; migration atrás da base: 20260928160000_old |')
    expect(handoffTable(snap([row({ isStamped: false })]))).toContain('| sem PR; 1 à frente, 0 atrás; sem carimbo |')
    expect(handoffTable(snap([row({ isStamped: true })]))).toContain('| sem PR; 1 à frente, 0 atrás; carimbado |')
    expect(table).not.toContain('feat/merged')
    expect(summaryOf(snap([loose], { isPrKnown: false }))).toBe('workbench: 1 worktrees · PRs indisponíveis · 1 migration atrás da base')
  })

  test('texto da faixa: resumo, mais os removíveis quando houver', async () => {
    const s = snap([row({ branch: 'fix/1' })])
    expect(bandOf(s, 0)).toBe(summaryOf(s))
    expect(bandOf(s, 1)).toBe(`${summaryOf(s)} · 1 removíveis`)
    expect(bandOf(s, 3)).toBe(`${summaryOf(s)} · 3 removíveis`)
  })

  test('texto da faixa: leitura que falhou sem dados anteriores mostra só o erro, cortado', async () => {
    const failed = snap([], { root: '', errors: ['x'.repeat(200)] })
    expect(bandOf(failed, 0)).toBe(`workbench: erro (${'x'.repeat(80)})`)
    const kept = snap([row({ branch: 'fix/1' })], { errors: ['gh fora do ar'] })
    expect(bandOf(kept, 0)).toBe(summaryOf(kept))
  })

  test('resumo e handoff mostram mudanças locais, worktree sem diretório e a idade do fetch', async () => {
    const dirty = row({ branch: 'fix/1163-reserva', dirty: 2 })
    const gone = row({ branch: 'fix/gone', path: '/tmp/gone', isPrunable: true, dirty: null })
    const s = snap([dirty, gone], { fetchedAt: 10 * 3_600_000 - 3 * 3_600_000, at: 10 * 3_600_000 })
    expect(summaryOf(s)).toBe('workbench: 2 worktrees · 2 sem PR · 0 PR aberta · 1 com mudanças locais · 1 sem diretório')
    const table = handoffTable(s)
    expect(table).toContain('2 arquivos não commitados')
    expect(table).toContain('worktree prunable')
    expect(table).toContain('fetch há 3h')
  })

  test('parseOwnKb: blocos de 512 B viram KB; sem nenhuma linha do find é null, nunca 0', async () => {
    expect(parseOwnKb('1408 20\n')).toBe(704)
    expect(parseOwnKb('1554432 33872')).toBe(777216)
    expect(parseOwnKb('0 0')).toBeNull()
    expect(parseOwnKb('')).toBeNull()
    expect(parseOwnKb('find: unknown predicate')).toBeNull()
  })

  test('sizeLabel: KB, MB inteiro e GB com uma casa e vírgula', async () => {
    expect(sizeLabel(512)).toBe('512 KB')
    expect(sizeLabel(2048)).toBe('2 MB')
    expect(sizeLabel(1_572_864)).toBe('1,5 GB')
  })

  test('totalSizeKb e freedKb somam só o que foi medido e só os caminhos pedidos', async () => {
    const a = row({ path: '/a', ownKb: 1000 })
    const b = row({ path: '/b', ownKb: 3000 })
    const unknown = row({ path: '/c', ownKb: null })
    expect(totalSizeKb([a, b, unknown])).toBe(4000)
    expect(freedKb([a, b, unknown], new Set(['/b', '/c']))).toBe(3000)
    expect(freedKb([a, b], new Set())).toBe(0)
  })

  test('tamanho aparece na linha, no resumo e no handoff, e some quando não foi medido', async () => {
    const sized = row({ ownKb: 1_572_864 })
    expect(lineOf(sized, true, false)).toContain('1,5 GB')
    expect(lineOf(row({ ownKb: null }), true, false)).not.toContain(' KB')
    expect(summaryOf(snap([sized]))).toContain('1,5 GB exclusivos')
    expect(summaryOf(snap([row({ ownKb: null })]))).not.toContain('exclusivos')
    expect(handoffTable(snap([sized]))).toContain('; 1,5 GB exclusivos em disco |')
  })
})
