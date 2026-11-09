import { describe, expect, test } from 'claude-code/testing'

import type { DetachedPrunable, Row, Snapshot, StaleReport } from '../types'
import {
  HAIKU_CAP,
  buildPrompt,
  buildReport,
  candidateHash,
  candidatesOf,
  MAX_BATCHES,
  RULES,
  END_GRACE_MS,
  REMOVER_AGENT,
  SPAWN_GRACE_MS,
  actionableOf,
  batchesOf,
  commandsOf,
  isStored,
  keyOf,
  knownFromReport,
  knownFromVerdicts,
  labelOf,
  listOf,
  parseVerdicts,
  persistOf,
  removableCount,
  removalCheckOf,
  removalLinesOf,
  removalPromptOf,
  removalStepOf,
  scopeOf,
  shellQuote,
  shouldAutoSuggest,
  splitCandidates,
} from '../hooks/stale'
import type { Candidate, Judged } from '../hooks/stale'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

// Uma worktree viva, limpa e parada há 30 dias, contida na base e com remota em dia; cada teste muda o que importa.
function row(over: Partial<Row>): Row {
  return {
    branch: 'fix/1163-x',
    path: '/repo/.worktrees/a',
    head: 'aaa111',
    issue: '1163',
    ahead: 0,
    behind: 0,
    push: 'ok',
    unpushed: 0,
    pr: null,
    staleMigrations: [],
    isStamped: null,
    dirty: 0,
    lastCommitAt: NOW - 30 * DAY,
    lastActivityAt: NOW - 30 * DAY,
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
    base: 'origin/main',
    baseHead: 'abc1234',
    baseMigration: null,
    rows,
    detachedPrunable: [],
    isPrKnown: true,
    fetchedAt: NOW - HOUR,
    errors: [],
    at: NOW,
    ...over,
  }
}

function reasons(rows: Row[], isPrKnown = true): string[] {
  return candidatesOf(rows, { now: NOW, isPrKnown }).map(c => `${c.row.path}:${c.reason}`)
}

const merged = { number: 9, state: 'MERGED' as const, headOid: 'aaa111' }

describe('candidatas', () => {
  test('worktree recém-criada por outra sessão não é candidata, mesmo com commit antigo', async () => {
    // ahead 0, sem PR, limpa: o último commit é o da base (30 dias), mas o reflog da criação é de 1 hora atrás.
    expect(reasons([row({ lastActivityAt: NOW - HOUR })])).toEqual([])
    expect(reasons([row({ lastActivityAt: NOW - 8 * DAY })])).toEqual(['/repo/.worktrees/a:no-pr'])
  })

  test('mergeada com o mesmo HEAD precisa de 24h de inatividade', async () => {
    expect(reasons([row({ pr: merged, lastActivityAt: NOW - HOUR })])).toEqual([])
    expect(reasons([row({ pr: merged, lastActivityAt: NOW - 25 * HOUR })])).toEqual(['/repo/.worktrees/a:merged'])
  })

  test('mergeada com HEAD que andou: nunca apaga a branch, só a pasta depois de 4 dias', async () => {
    const moved = { pr: { ...merged, headOid: 'zzz999' }, ahead: 2, push: 'none' as const }
    expect(reasons([row({ ...moved, lastActivityAt: NOW - 5 * DAY })])).toEqual(['/repo/.worktrees/a:moved'])
    expect(reasons([row({ ...moved, lastActivityAt: NOW - 3 * DAY })])).toEqual([])
  })

  test('sem diretório: candidata mesmo com commits só locais, mas não se estiver travada', async () => {
    expect(reasons([row({ isPrunable: true, ahead: 19, push: 'none', dirty: null, lastActivityAt: null })])).toEqual([
      '/repo/.worktrees/a:prunable',
    ])
    expect(reasons([row({ isPrunable: true, isLocked: true, lastActivityAt: null })])).toEqual([])
    expect(reasons([row({ isPrunable: true, error: 'x', lastActivityAt: null })])).toEqual([])
  })

  test('PR fechada: só com o HEAD do PR e sem commit só local, parada há 7 dias', async () => {
    const closed = { number: 4, state: 'CLOSED' as const, headOid: 'aaa111' }
    const idle = NOW - 8 * DAY
    expect(reasons([row({ pr: closed, lastActivityAt: idle })])).toEqual(['/repo/.worktrees/a:closed'])
    expect(reasons([row({ pr: closed, ahead: 3, push: 'ok', lastActivityAt: idle })])).toEqual(['/repo/.worktrees/a:closed'])
    // Commit só local ou HEAD diferente: a branch fica, só a pasta sai.
    expect(reasons([row({ pr: closed, ahead: 3, push: 'none', lastActivityAt: idle })])).toEqual(['/repo/.worktrees/a:moved'])
    expect(reasons([row({ pr: { ...closed, headOid: 'zzz999' }, lastActivityAt: idle })])).toEqual(['/repo/.worktrees/a:moved'])
    // Abaixo dos 7 dias do `closed`, mas acima dos 4 do `moved`: só a pasta.
    expect(reasons([row({ pr: closed, lastActivityAt: NOW - 5 * DAY })])).toEqual(['/repo/.worktrees/a:moved'])
    expect(reasons([row({ pr: closed, lastActivityAt: NOW - 2 * DAY })])).toEqual([])
  })

  test('remota apagada sem commit além da base, parada há 7 dias', async () => {
    expect(reasons([row({ push: 'gone', lastActivityAt: NOW - 8 * DAY })])).toEqual(['/repo/.worktrees/a:gone'])
    expect(reasons([row({ push: 'gone', ahead: 2, lastActivityAt: NOW - 8 * DAY })])).toEqual(['/repo/.worktrees/a:work'])
  })

  test('sem a lista do gh, "sem PR" é desconhecido: só a pasta, e só depois de 7 dias', async () => {
    expect(reasons([row({ lastActivityAt: NOW - 8 * DAY })], false)).toEqual(['/repo/.worktrees/a:unknown'])
    expect(reasons([row({ lastActivityAt: NOW - 5 * DAY })], false)).toEqual([])
    expect(reasons([row({ push: 'gone', lastActivityAt: NOW - 8 * DAY })], false)).toEqual(['/repo/.worktrees/a:gone'])
  })

  test('sem PR com commits (o caso comum): só a pasta depois de 4 dias, nunca a branch', async () => {
    const work = { ahead: 150, push: 'ok' as const }
    expect(reasons([row({ ...work, lastActivityAt: NOW - 5 * DAY })])).toEqual(['/repo/.worktrees/a:work'])
    expect(reasons([row({ ...work, lastActivityAt: NOW - 3 * DAY })])).toEqual([])
    expect(reasons([row({ push: 'unpushed', unpushed: 2, ahead: 2, lastActivityAt: NOW - 5 * DAY })])).toEqual(['/repo/.worktrees/a:work'])
    expect(reasons([row({ push: 'unpushed', unpushed: 2, ahead: 2, lastActivityAt: NOW - 3 * DAY })])).toEqual([])
  })

  test('PR aberta: só a pasta depois de 7 dias', async () => {
    const open = { pr: { number: 1, state: 'OPEN' as const, headOid: 'aaa111' } }
    expect(reasons([row({ ...open, lastActivityAt: NOW - 8 * DAY })])).toEqual(['/repo/.worktrees/a:open'])
    expect(reasons([row({ ...open, lastActivityAt: NOW - 6 * DAY })])).toEqual([])
  })

  test('escopo: worktree e branch, só a pasta ou só o registro', async () => {
    expect(scopeOf('merged')).toBe('full')
    expect(scopeOf('no-pr')).toBe('full')
    expect(scopeOf('work')).toBe('tree')
    expect(scopeOf('moved')).toBe('tree')
    expect(scopeOf('open')).toBe('tree')
    expect(scopeOf('unknown')).toBe('tree')
    expect(scopeOf('prunable')).toBe('prune')
  })

  test('nunca, em escopo nenhum: sujo (inclusive não rastreado), dirty desconhecido, atual, travada, com erro', async () => {
    const work = { ahead: 2, push: 'none' as const }
    for (const over of [{ dirty: 1 }, { dirty: null }, { isCurrent: true }, { isLocked: true }, { error: 'falhou' }]) {
      expect(reasons([row(over)])).toEqual([])
      expect(reasons([row({ ...work, ...over })])).toEqual([])
      expect(reasons([row({ pr: merged, ...over })])).toEqual([])
    }
  })

  test('commit só local, sem push, PR aberta ou HEAD que andou nunca apagam a branch', async () => {
    const old = NOW - 30 * DAY
    const cases = [
      row({ push: 'unpushed', unpushed: 2, ahead: 2 }),
      row({ ahead: 2, push: 'none' }),
      row({ ahead: 2, push: 'gone' }),
      row({ pr: { number: 1, state: 'OPEN', headOid: 'aaa111' } }),
      row({ pr: { number: 1, state: 'MERGED', headOid: 'zzz999' }, lastActivityAt: old }),
    ]
    for (const c of cases) {
      const scopes = candidatesOf([c], { now: NOW, isPrKnown: true }).map(x => scopeOf(x.reason))
      expect(scopes).toEqual(['tree'])
    }
  })

  test('sem como medir a atividade, não sugere', async () => {
    expect(reasons([row({ lastActivityAt: null })])).toEqual([])
    expect(reasons([row({ pr: merged, lastActivityAt: null })])).toEqual([])
  })

  test('hash: estável à ordem, ignora as sem diretório e muda com o HEAD', async () => {
    const a = row({ path: '/a', lastActivityAt: NOW - 8 * DAY })
    const b = row({ path: '/b', lastActivityAt: NOW - 8 * DAY })
    const gone = row({ path: '/g', isPrunable: true })
    const hash = (rows: Row[]) => candidateHash(candidatesOf(rows, { now: NOW, isPrKnown: true }))
    expect(hash([a, b])).toBe(hash([b, a]))
    expect(hash([a, b, gone])).toBe(hash([a, b]))
    expect(hash([a, b])).not.toBe(hash([a, { ...b, head: 'bbb222' }]))
  })

  test('lotes: só as sem veredito, as mais paradas primeiro, até 5 lotes de 20; sem diretório não entra', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => row({ path: `/w/${String(i).padStart(3, '0')}`, branch: `b${i}`, lastActivityAt: NOW - (8 + i) * DAY }))
    const liveOf = (rows: Row[]) => splitCandidates(candidatesOf(rows, { now: NOW, isPrKnown: true })).live
    const cands = candidatesOf([...many(45), row({ path: '/gone', isPrunable: true })], { now: NOW, isPrKnown: true })
    const { prunable, live } = splitCandidates(cands)
    expect(prunable.length).toBe(1)
    const first = batchesOf(live, new Map(), false)
    expect(first.batches.map(b => b.length)).toEqual([HAIKU_CAP, HAIKU_CAP, 5])
    expect(first.batches[0]?.[0]?.row.path).toBe('/w/044')
    expect(first.overflow).toEqual([])
    // 30 já julgadas (mesmo caminho, HEAD e regra): só as 15 restantes vão.
    const known = new Map(live.slice(0, 30).map(c => [keyOf(c), { verdict: 'keep' as const, reason: 'x' }]))
    expect(batchesOf(live, known, false).batches.flat().length).toBe(15)
    // Botão s: as sem veredito primeiro, depois as já julgadas.
    const forced = batchesOf(live, known, true).batches.flat()
    expect(forced.length).toBe(45)
    expect(forced[0]?.row.path).toBe(live[30]?.row.path)
    // Regra diferente não conta como julgada.
    const otherRule = new Map(live.map(c => [`${c.row.path}@${c.row.head}:moved`, { verdict: 'keep' as const, reason: 'x' }]))
    expect(batchesOf(live, otherRule, false).batches.flat().length).toBe(45)
    // 130: 5 lotes e 30 excedentes.
    const big = batchesOf(liveOf(many(130)), new Map(), false)
    expect(big.batches.length).toBe(MAX_BATCHES)
    expect(big.overflow.length).toBe(30)
  })

  test('submódulo sujo ou não conferido não vai ao Haiku', async () => {
    const rows = [
      row({ path: '/ok', submodules: 'clean', lastActivityAt: NOW - 8 * DAY }),
      row({ path: '/sujo', submodules: 'unsafe', lastActivityAt: NOW - 8 * DAY }),
      row({ path: '/novo', submodules: null, lastActivityAt: NOW - 8 * DAY }),
    ]
    const { live, blocked } = splitCandidates(candidatesOf(rows, { now: NOW, isPrKnown: true }))
    expect(live.map(c => c.row.path)).toEqual(['/ok'])
    expect(blocked.map(c => c.row.path).sort()).toEqual(['/novo', '/sujo'])
  })
})

describe('Haiku: prompt e resposta', () => {
  const cands: Candidate[] = [
    { row: row({ path: '/a', branch: 'fix/dup' }), reason: 'no-pr' },
    { row: row({ path: '/b', branch: 'fix/dup' }), reason: 'gone' },
  ]

  test('cada candidata vai com um id, e a mesma branch em duas worktrees não se confunde', async () => {
    const { prompt, ids } = buildPrompt(cands, NOW)
    expect([...ids.entries()]).toEqual([['c1', '/a'], ['c2', '/b']])
    expect(prompt).toContain('"id":"c1"')
    expect(prompt).toContain('"diasSemAtividade":30')
  })

  test('parse: JSON cercado de texto, id inventado, veredito fora do enum e texto vazio', async () => {
    const ids = new Map([['c1', '/a'], ['c2', '/b']])
    const text = [
      'Claro! Aqui está:',
      '[{"id":"c1","verdict":"remove","reason":"  PR mergeada há semanas  "},',
      '{"id":"c9","verdict":"remove","reason":"inventada"},',
      '{"id":"c2","verdict":"apagar","reason":"verdict inválido"}]',
    ].join('\n')
    const out = parseVerdicts(text, ids)
    expect([...out.entries()]).toEqual([['/a', { verdict: 'remove', reason: 'PR mergeada há semanas' }]])
    expect(parseVerdicts('', ids).size).toBe(0)
    expect(parseVerdicts('sem json nenhum', ids).size).toBe(0)
    expect(parseVerdicts('[{"id":"c1"', ids).size).toBe(0)
  })

  test('parse corta o motivo em 100 caracteres', async () => {
    const out = parseVerdicts(`[{"id":"c1","verdict":"keep","reason":"${'x'.repeat(300)}"}]`, new Map([['c1', '/a']]))
    expect(out.get('/a')?.reason.length).toBe(100)
  })
})

describe('relatório', () => {
  const gone = row({ path: '/tmp/gone', branch: 'fix/gone', head: 'ggg333', isPrunable: true, lastActivityAt: null })
  const live = row({ path: '/a', branch: 'fix/a', head: 'aaa111', lastActivityAt: NOW - 8 * DAY })
  const cands = candidatesOf([live, gone], { now: NOW, isPrKnown: true })
  const input = {
    cands,
    detached: [] as DetachedPrunable[],
    overflow: new Set<string>(),
    missingReason: 'sem veredito ainda',
    hash: 'h1',
    at: NOW,
    note: null,
  }

  test('sem diretório é remove pela regra; viva sem veredito é review', async () => {
    const report = buildReport({ ...input, known: new Map() })
    expect(report?.source).toBe('regra')
    expect(report?.items.map(i => `${i.verdict}:${i.branch}:${i.origin}`)).toEqual(['remove:fix/gone:regra', 'review:fix/a:regra'])
  })

  test('veredito do Haiku é reaproveitado por caminho e HEAD, e some quando o HEAD muda', async () => {
    const verdicts = new Map<string, Judged>([['/a', { verdict: 'remove', reason: 'parada' }]])
    const first = buildReport({ ...input, known: knownFromVerdicts(verdicts, cands) })
    expect(first?.source).toBe('haiku')
    const reused = buildReport({ ...input, known: knownFromReport(first) })
    expect(reused?.items.find(i => i.path === '/a')?.origin).toBe('haiku')
    const moved = candidatesOf([{ ...live, head: 'bbb222' }, gone], { now: NOW, isPrKnown: true })
    const after = buildReport({ ...input, cands: moved, known: knownFromReport(first) })
    expect(after?.items.find(i => i.path === '/a')?.reason).toBe('sem veredito ainda')
  })

  test('candidata que deixou de ser candidata sai do relatório', async () => {
    const first = buildReport({ ...input, known: new Map() })
    const now = candidatesOf([{ ...live, dirty: 3 }, gone], { now: NOW, isPrKnown: true })
    const after = buildReport({ ...input, cands: now, known: knownFromReport(first) })
    expect(after?.items.map(i => i.path)).toEqual(['/tmp/gone'])
  })

  test('as que passaram do teto aparecem como review com o motivo', async () => {
    const report = buildReport({ ...input, known: new Map(), overflow: new Set(['/a']) })
    expect(report?.items.find(i => i.path === '/a')?.reason).toBe(`fora do limite de ${HAIKU_CAP * MAX_BATCHES} do Haiku`)
  })

  test('sem nenhuma candidata não há relatório', async () => {
    expect(buildReport({ ...input, cands: [], known: new Map() })).toBe(null)
    expect(removableCount(null)).toBe(0)
  })

  test('lista para o modelo da sessão traz só o veredito, nunca comandos', async () => {
    const report = buildReport({ ...input, known: new Map() })
    const text = listOf(report)
    expect(text).toContain('REMOVER fix/gone')
    expect(text).not.toContain('git -C')
    expect(text).not.toContain('worktree remove')
    expect(listOf(null)).toBe('Nenhuma worktree candidata à limpeza.')
  })
})

describe('comandos', () => {
  const verdict = (rows: Row[], over: Partial<Snapshot> = {}, v: Judged['verdict'] = 'remove') => {
    const s = snap(rows, over)
    const cands = candidatesOf(s.rows, { now: NOW, isPrKnown: s.isPrKnown })
    const known = knownFromVerdicts(new Map(cands.map(c => [c.row.path, { verdict: v, reason: 'ok' }])), cands)
    const report = buildReport({ cands, detached: s.detachedPrunable, known, overflow: new Set(), missingReason: '', hash: 'h', at: NOW, note: null })
    return commandsOf(s, report?.items ?? [], NOW)
  }

  test('shellQuote protege aspas simples no caminho', async () => {
    expect(shellQuote('/a/b')).toBe("'/a/b'")
    expect(shellQuote("/a/it's")).toBe("'/a/it'\\''s'")
  })

  test('mergeada: remove + branch -D, com a garantia no comentário e sem --force', async () => {
    const text = verdict([row({ pr: merged, lastActivityAt: NOW - 2 * DAY })])
    expect(text).toContain("git -C '/repo' worktree remove '/repo/.worktrees/a'")
    expect(text).toContain("git -C '/repo' branch -D 'fix/1163-x'")
    expect(text).toContain('# o PR #9 mergeou exatamente este HEAD')
    expect(text.startsWith('# git worktree remove apaga também arquivos ignorados (.env etc.)')).toBe(true)
    expect(text).not.toContain('--force')
    expect(text).not.toContain('&&')
  })

  test('contida na base: o comentário cita a base; PR fechada com push ok cita origin e o fetch', async () => {
    expect(verdict([row({ lastActivityAt: NOW - 8 * DAY })])).toContain('# nenhum commit além de origin/main')
    const closed = row({ pr: { number: 4, state: 'CLOSED', headOid: 'aaa111' }, ahead: 3, push: 'ok', lastActivityAt: NOW - 8 * DAY })
    const text = verdict([closed])
    expect(text).toContain('# commits continuam em origin/fix/1163-x (e em refs/pull/4/head); fetch há 1h')
    expect(text).toContain("branch -D 'fix/1163-x'")
  })

  test('sem diretório: só prune, uma vez, e nunca remove nem branch -D', async () => {
    const gone = (path: string, branch: string) => row({ path, branch, isPrunable: true, lastActivityAt: null, ahead: 4, push: 'none' })
    const text = verdict([gone('/tmp/g1', 'fix/g1'), gone('/tmp/g2', 'fix/g2')])
    expect(text.split('worktree prune').length - 1).toBe(1)
    expect(text).toContain("git -C '/repo' worktree prune")
    expect(text).toContain('(2, incluindo 0 destacadas)')
    // O cabeçalho cita "git worktree remove" num comentário: o que não pode existir é o comando em si.
    expect(text).not.toContain("git -C '/repo' worktree remove")
    expect(text).not.toContain('branch -D')
  })

  test('branch duplicada: a prunable gera só prune e nada aponta para a worktree viva e suja', async () => {
    const live = row({ path: '/home/x/app-exemplo', branch: 'fix/dup', head: 'h1', dirty: 1 })
    const gone = row({ path: '/tmp/app-exemplo', branch: 'fix/dup', head: 'h1', isPrunable: true, lastActivityAt: null })
    const text = verdict([live, gone])
    expect(text).toContain('worktree prune')
    expect(text).not.toContain('/home/x/app-exemplo')
    expect(text).not.toContain('branch -D')
  })

  test('destacada sem diretório com commit fora de qualquer ref: cria a branch rescue antes do prune', async () => {
    const gone = row({ path: '/tmp/g1', branch: 'fix/g1', isPrunable: true, lastActivityAt: null })
    const detached: DetachedPrunable[] = [
      { path: '/tmp/d1', head: 'abcdef1234', isReachable: false },
      { path: '/tmp/d2', head: '9999999999', isReachable: true },
    ]
    const text = verdict([gone], { detachedPrunable: detached })
    expect(text).toContain("git -C '/repo' branch rescue/abcdef1 abcdef1234")
    expect(text).not.toContain('rescue/9999999')
    expect(text).toContain('(3, incluindo 2 destacadas)')
    expect(text.indexOf('branch rescue/')).toBeLessThan(text.indexOf('worktree prune'))
  })

  test('um item velho do relatório que já não é candidato não gera comando', async () => {
    const before = row({ lastActivityAt: NOW - 8 * DAY })
    const s = snap([before])
    const cands = candidatesOf(s.rows, { now: NOW, isPrKnown: true })
    const known = knownFromVerdicts(new Map([['/repo/.worktrees/a', { verdict: 'remove' as const, reason: 'ok' }]]), cands)
    const report = buildReport({ cands, detached: [], known, overflow: new Set(), missingReason: '', hash: 'h', at: NOW, note: null })
    // Depois do relatório, alguém mexeu na worktree: agora ela está suja.
    const dirtyNow = snap([{ ...before, dirty: 2 }])
    expect(commandsOf(dirtyNow, report?.items ?? [], NOW)).toBe('')
  })

  test('só o que o veredito marca como remove vira comando', async () => {
    expect(verdict([row({ lastActivityAt: NOW - 8 * DAY })], {}, 'review')).toBe('')
    expect(verdict([row({ lastActivityAt: NOW - 8 * DAY })], {}, 'keep')).toBe('')
  })

  test('só a pasta: worktree remove sem branch -D, com o aviso dos ignorados e como recriar', async () => {
    const text = verdict([row({ ahead: 150, push: 'ok', lastActivityAt: NOW - 5 * DAY })])
    expect(text).toContain("git -C '/repo' worktree remove '/repo/.worktrees/a'")
    expect(text).not.toContain('branch -D')
    expect(text).toContain('# só a pasta: a branch fix/1163-x fica (150 commits além de origin/main) e some do painel;')
    expect(text).toContain("worktree add '/repo/.worktrees/a' 'fix/1163-x' recria só o commitado (ignorados como .env se perdem)")
    expect(text).not.toContain('--force')
  })

  test('regra que mudou entre o veredito e a cópia: nenhum comando, nunca branch -D', async () => {
    // Julgada como `moved` (PR fechada há 5 dias, só a pasta); na hora de copiar já passou dos 7 dias e virou `closed`.
    const closed = row({ pr: { number: 4, state: 'CLOSED', headOid: 'aaa111' }, lastActivityAt: NOW - 5 * DAY })
    const s = snap([closed])
    const cands = candidatesOf(s.rows, { now: NOW, isPrKnown: true })
    expect(cands.map(c => c.reason)).toEqual(['moved'])
    const known = knownFromVerdicts(new Map([['/repo/.worktrees/a', { verdict: 'remove' as const, reason: 'ok' }]]), cands)
    const report = buildReport({ cands, detached: [], known, overflow: new Set(), missingReason: '', hash: 'h', at: NOW, note: null })
    const later = NOW + 3 * DAY
    expect(candidatesOf(s.rows, { now: later, isPrKnown: true }).map(c => c.reason)).toEqual(['closed'])
    expect(commandsOf(s, report?.items ?? [], later)).toBe('')
    expect(actionableOf(s, report?.items ?? [], later)).toEqual([])
  })

  test('item sem regra (relatório de antes desta versão) não gera comando', async () => {
    const s = snap([row({ lastActivityAt: NOW - 8 * DAY })])
    const old = [{ path: '/repo/.worktrees/a', branch: 'fix/1163-x', head: 'aaa111', verdict: 'remove' as const, reason: 'ok', origin: 'haiku' as const }]
    expect(commandsOf(s, old, NOW)).toBe('')
  })

  test('submódulo: limpo usa --force com o motivo; sujo ou não conferido vira revisar e não gera comando', async () => {
    const clean = verdict([row({ pr: merged, submodules: 'clean', lastActivityAt: NOW - 2 * DAY })])
    expect(clean).toContain("worktree remove --force '/repo/.worktrees/a'")
    expect(clean).toContain('# --force só por causa do submódulo')
    for (const submodules of ['unsafe', null] as const) {
      const r = row({ pr: merged, submodules, lastActivityAt: NOW - 2 * DAY })
      expect(verdict([r])).toBe('')
      const cands = candidatesOf([r], { now: NOW, isPrKnown: true })
      const report = buildReport({ cands, detached: [], known: new Map(), overflow: new Set(), missingReason: '', hash: 'h', at: NOW, note: null })
      expect(report?.items[0]?.verdict).toBe('review')
      expect(report?.items[0]?.reason).toContain('submódulo')
    }
  })

  test('rótulo: REMOVER (só a pasta) para o escopo tree', async () => {
    const item = { path: '/a', branch: 'b', head: 'h', verdict: 'remove' as const, reason: 'r', origin: 'haiku' as const }
    expect(labelOf({ ...item, rule: 'work' })).toBe('REMOVER (só a pasta)')
    expect(labelOf({ ...item, rule: 'merged' })).toBe('REMOVER')
    expect(labelOf(item)).toBe('REMOVER')
    expect(labelOf({ ...item, rule: 'work', verdict: 'keep' })).toBe('MANTER')
  })
})

describe('Haiku: instruções e gravação', () => {
  test('RULES não promete reversível nem diz que todo item não tem PR aberta, e avisa dos ignorados', async () => {
    expect(RULES).not.toContain('reversível')
    expect(RULES).not.toContain('sem PR aberta')
    expect(RULES).toContain('ignorados')
  })

  test('o prompt leva o escopo e o espaço de cada candidata', async () => {
    const { prompt } = buildPrompt([{ row: row({ ownKb: 704 * 1024 }), reason: 'work' }], NOW)
    expect(prompt).toContain('"escopo":"só a pasta (branch fica)"')
    expect(prompt).toContain('"espacoMB":704')
  })

  test('persistOf: completo grava o hash; aborted não grava nada e pede backoff; o resto grava só o horário', async () => {
    expect(persistOf({ isComplete: true, failure: null })).toEqual({ store: 'full', backoff: false })
    expect(persistOf({ isComplete: false, failure: 'aborted' })).toEqual({ store: 'none', backoff: true })
    expect(persistOf({ isComplete: false, failure: 'other' })).toEqual({ store: 'at', backoff: false })
    // Haiku pulou itens ou sobrou excedente acima de 100: sem falha, mas incompleto.
    expect(persistOf({ isComplete: false, failure: null })).toEqual({ store: 'at', backoff: false })
  })

  test('execução incompleta grava o horário e não redispara na janela seguinte de 1h', async () => {
    const stored = { hash: 'antigo', at: NOW, report: null }
    expect(shouldAutoSuggest({ liveCount: 130, hash: 'novo', stored, now: NOW + 5 * 60_000, hasSurface: true, abortedUntil: 0 })).toBe(false)
    expect(shouldAutoSuggest({ liveCount: 130, hash: 'novo', stored, now: NOW + 2 * HOUR, hasSurface: true, abortedUntil: 0 })).toBe(true)
  })
})

describe('disparo automático', () => {
  const base = { liveCount: 2, hash: 'h2', stored: null, now: NOW, hasSurface: true, abortedUntil: 0 }
  const stored = (hash: string, at: number) => ({ hash, at, report: null })

  test('dispara com candidatas vivas, conjunto novo e nenhuma tentativa recente', async () => {
    expect(shouldAutoSuggest(base)).toBe(true)
    expect(shouldAutoSuggest({ ...base, stored: stored('h1', NOW - 2 * HOUR) })).toBe(true)
  })

  test('não dispara: sem vivas, mesmo conjunto, dentro de 1h, sem tela ou em backoff de aborted', async () => {
    expect(shouldAutoSuggest({ ...base, liveCount: 0 })).toBe(false)
    expect(shouldAutoSuggest({ ...base, stored: stored('h2', NOW - 5 * HOUR) })).toBe(false)
    expect(shouldAutoSuggest({ ...base, stored: stored('h1', NOW - 10 * 60_000) })).toBe(false)
    expect(shouldAutoSuggest({ ...base, hasSurface: false })).toBe(false)
    expect(shouldAutoSuggest({ ...base, abortedUntil: NOW + 60_000 })).toBe(false)
  })

  test('o que vem do $.store só vale com o formato certo', async () => {
    const report: StaleReport = { hash: 'h', at: 1, source: 'haiku', note: null, items: [] }
    expect(isStored({ hash: 'h', at: 1, report })).toBe(true)
    expect(isStored({ hash: 'h', at: 1, report: null })).toBe(true)
    expect(isStored({ hash: 'h', at: '1', report: null })).toBe(false)
    expect(isStored({ hash: 'h', at: 1, report: { items: 'x' } })).toBe(false)
    expect(isStored(null)).toBe(false)
    expect(isStored('texto')).toBe(false)
  })
})

describe('remoção pelo botão', () => {
  // Marca todas as candidatas como `remove` (como o Haiku faria) e devolve o que a automação executaria.
  const plan = (rows: Row[], over: Partial<Snapshot> = {}) => {
    const s = snap(rows, over)
    const cands = candidatesOf(s.rows, { now: NOW, isPrKnown: s.isPrKnown })
    const known = knownFromVerdicts(new Map(cands.map(c => [c.row.path, { verdict: 'remove' as const, reason: 'ok' }])), cands)
    const report = buildReport({ cands, detached: s.detachedPrunable, known, overflow: new Set(), missingReason: '', hash: 'h', at: NOW, note: null })
    return removalLinesOf(s, report?.items ?? [])
  }
  const done = row({ pr: merged, lastActivityAt: NOW - 2 * DAY })

  test('mergeada: só os comandos, na ordem, sem comentário nem linha vazia', async () => {
    expect(plan([done])).toEqual({
      lines: ["git -C '/repo' worktree remove '/repo/.worktrees/a'", "git -C '/repo' branch -D 'fix/1163-x'"],
      count: 1,
      skipped: 0,
    })
  })

  test('sem item acionável não há linha', async () => {
    expect(plan([])).toEqual({ lines: [], count: 0, skipped: 0 })
  })

  test('sem diretório: só o prune, contado como uma worktree', async () => {
    const gone = row({ path: '/repo/.worktrees/gone', isPrunable: true })
    expect(plan([gone])).toEqual({ lines: ["git -C '/repo' worktree prune"], count: 1, skipped: 0 })
  })

  test('submódulo limpo (comando com --force) fica de fora, e as outras seguem', async () => {
    const withModule = row({ path: '/repo/.worktrees/m', branch: 'fix/2-m', pr: merged, submodules: 'clean', lastActivityAt: NOW - 2 * DAY })
    const only = plan([withModule])
    expect(only).toEqual({ lines: [], count: 0, skipped: 1 })
    const both = plan([withModule, done])
    expect(both.count).toBe(1)
    expect(both.skipped).toBe(1)
    expect(both.lines.some(line => line.includes('--force') || line.includes('/m'))).toBe(false)
  })

  test('nome com quebra de linha fica de fora e não vira fragmento de comando', async () => {
    const evil = row({ path: '/repo/.worktrees/x\nrm -rf /', branch: 'fix/3-x', pr: merged, lastActivityAt: NOW - 2 * DAY })
    expect(plan([evil])).toEqual({ lines: [], count: 0, skipped: 1 })
    const branchEvil = row({ path: '/repo/.worktrees/y', branch: 'fix/4\nx', pr: merged, lastActivityAt: NOW - 2 * DAY })
    expect(plan([branchEvil, done]).lines.join('\n')).not.toContain('rm -rf')
    expect(plan([branchEvil, done]).skipped).toBe(1)
  })

  test('nenhuma linha devolvida contém --force', async () => {
    const withModule = row({ path: '/repo/.worktrees/m', pr: merged, submodules: 'clean', lastActivityAt: NOW - 2 * DAY })
    expect(plan([withModule, done]).lines.every(line => !line.includes('--force'))).toBe(true)
  })

  test('o tool.check só libera a linha exata da lista, e nunca o que o engine já negou', async () => {
    const allowed = ["git -C '/repo' worktree remove '/repo/.worktrees/a'", "git -C '/repo' worktree prune"]
    expect(removalCheckOf(allowed, allowed[0] ?? '', 'ask')).toBe('allow')
    expect(removalCheckOf(allowed, `  ${allowed[1]}\n`, 'allow')).toBe('allow')
    expect(removalCheckOf(allowed, allowed[0] ?? '', 'deny')).toBe('deny')
    expect(removalCheckOf(allowed, "git -C '/repo' worktree remove '/outro'", 'ask')).toBe('deny')
    expect(removalCheckOf(allowed, `${allowed[0]} && rm -rf /`, 'ask')).toBe('deny')
    expect(removalCheckOf(allowed, null, 'ask')).toBe('deny')
    expect(removalCheckOf([], allowed[0] ?? '', 'ask')).toBe('deny')
  })

  test('o prompt do spawn leva todas as linhas, na ordem', async () => {
    const lines = ['git -C a worktree remove b', 'git -C a branch -D c']
    const prompt = removalPromptOf(lines)
    expect(prompt.indexOf(lines[0] ?? '')).toBeGreaterThan(-1)
    expect(prompt.indexOf(lines[1] ?? '')).toBeGreaterThan(prompt.indexOf(lines[0] ?? ''))
  })

  describe('ciclo de vida (removalStepOf)', () => {
    const started = { at: NOW, agentId: 'a1' as string | null, allowed: ['x'] }
    const alive = [{ id: 'a1', type: REMOVER_AGENT, status: 'running' }]

    test('agente vivo espera, por mais tempo que passe', async () => {
      expect(removalStepOf(started, alive, NOW + 3 * DAY)).toEqual({ step: 'wait' })
    })

    test('agente terminado ou sumido só encerra depois da carência', async () => {
      const ended = [{ id: 'a1', type: REMOVER_AGENT, status: 'completed' }]
      expect(removalStepOf(started, ended, NOW + END_GRACE_MS - 1)).toEqual({ step: 'wait' })
      expect(removalStepOf(started, ended, NOW + END_GRACE_MS)).toEqual({ step: 'finish' })
      expect(removalStepOf(started, [], NOW + END_GRACE_MS)).toEqual({ step: 'finish' })
    })

    test('lista que falhou nunca encerra', async () => {
      expect(removalStepOf(started, null, NOW + 3 * DAY)).toEqual({ step: 'wait' })
      expect(removalStepOf({ ...started, agentId: null }, null, NOW + 3 * DAY)).toEqual({ step: 'wait' })
    })

    test('sem agentId: adota o remover vivo; sem ele, encerra só depois da carência do spawn', async () => {
      const lost = { ...started, agentId: null }
      expect(removalStepOf(lost, [{ id: 'a2', type: REMOVER_AGENT, status: 'running' }], NOW + 1)).toEqual({ step: 'adopt', agentId: 'a2' })
      const other = [{ id: 'z9', type: 'general-purpose', status: 'running' }]
      expect(removalStepOf(lost, other, NOW + SPAWN_GRACE_MS - 1)).toEqual({ step: 'wait' })
      expect(removalStepOf(lost, other, NOW + SPAWN_GRACE_MS)).toEqual({ step: 'finish' })
    })
  })
})
