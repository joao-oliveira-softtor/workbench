import { describe, expect, test } from 'claude-code/testing'

import {
  acceptFixOf,
  argvOf,
  baseUrlAt,
  checkedDefectsOf,
  defectIdOf,
  diffCheckOf,
  finalVerdictOf,
  fixQueueOf,
  fixReportOf,
  isUnstable,
  normalizedTextOf,
  parseMatrix,
  parseResult,
  parseVerdict,
  reportOf,
  retestCellsOf,
  signatureOf,
  startArgvOf,
} from '../hooks/qa-evidence'
import type { Cell, CellOutcome, CellResult, CellVerdict, Defect, Evidence, FixResult, Matrix, Verdict } from '../hooks/qa-evidence'

const crit = { given: 'logado', when: 'clica em Salvar', then: 'vê a confirmação' }

const cellOf = (over: Partial<Cell> = {}): Cell => ({
  id: 'c1',
  requirement: 'r1',
  risk: 'alto',
  flow: 'cadastro',
  route: '/cadastro',
  profile: 'admin',
  width: 1280,
  reason: 'fluxo principal',
  steps: ['abrir a tela', 'clicar em Salvar'],
  criteria: [crit],
  expectedStatus: [{ url: '/api/itens', status: 200 }],
  ...over,
})

const matrixOf = (over: Partial<Matrix> = {}): Matrix => ({
  baseUrl: 'http://localhost:3000',
  loginRoute: '/entrar',
  installCommand: 'npm ci',
  startCommand: 'npm run dev -- --port {QA_PORT}',
  testCommand: 'npm test',
  backend: { containers: ['app-exemplo-api'] },
  profiles: ['admin', 'vendedor'],
  requirements: [{ id: 'r1', text: 'Salvar item', source: 'issue 1' }],
  cells: [cellOf()],
  cut: [],
  ...over,
})

const mdOf = (m: unknown): string => `# Matriz\n\nTexto livre.\n\n\`\`\`json\n${JSON.stringify(m, null, 2)}\n\`\`\`\n`

const defectOf = (over: Partial<Defect> = {}): Defect => ({
  id: 'd1',
  kind: 'design',
  source: 'geometria',
  where: 'button.salvar',
  severity: 'fail',
  repro: ['abrir a tela'],
  ...over,
})

const verdictOf = (over: Partial<CellVerdict> = {}): CellVerdict => ({
  id: 'c1',
  verdict: 'PASS',
  evidence: [{ criterion: 0, proof: 'texto "Salvo" visível' }],
  defects: [],
  backend: 'lido',
  ...over,
})

const outcomeOf = (final: Verdict, verdict: CellVerdict | null = null): CellOutcome => ({ final, verdict })

describe('parseMatrix', () => {
  test('uma matriz válida passa', () => {
    const r = parseMatrix(mdOf(matrixOf()))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(matrixOf())
  })

  test('aceita 127.0.0.1, https, porta e barra final', () => {
    for (const baseUrl of ['http://127.0.0.1:4000', 'https://localhost', 'http://localhost:3000/']) {
      expect(parseMatrix(mdOf(matrixOf({ baseUrl }))).ok).toBe(true)
    }
  })

  const refused: [string, unknown, string][] = [
    ['host falso localhost.evil.com', { baseUrl: 'http://localhost.evil.com' }, 'baseUrl'],
    ['host falso 127.0.0.1.nip.io', { baseUrl: 'http://127.0.0.1.nip.io' }, 'baseUrl'],
    ['usuário na url', { baseUrl: 'http://localhost@evil.com' }, 'baseUrl'],
    ['senha na url', { baseUrl: 'http://admin:segredo@localhost:3000' }, 'baseUrl'],
    ['esquema ftp', { baseUrl: 'ftp://localhost' }, 'baseUrl'],
    ['caminho', { baseUrl: 'http://localhost:3000/app' }, 'baseUrl'],
    ['query', { baseUrl: 'http://localhost:3000/?a=1' }, 'baseUrl'],
    ['hash', { baseUrl: 'http://localhost:3000/#x' }, 'baseUrl'],
    ['baseUrl que não é url', { baseUrl: 'localhost' }, 'baseUrl'],
    ['loginRoute sem barra', { loginRoute: 'entrar' }, 'loginRoute'],
    ['loginRoute //evil', { loginRoute: '//evil.com/x' }, 'loginRoute'],
    ['installCommand vazio', { installCommand: '  ' }, 'installCommand'],
    ['startCommand vazio', { startCommand: '' }, 'startCommand'],
    ['installCommand com ;', { installCommand: 'npm ci; rm -rf x' }, 'installCommand'],
    ['startCommand com &&', { startCommand: 'npm run dev && echo oi' }, 'startCommand'],
    ['testCommand com $(', { testCommand: 'npm test $(id)' }, 'testCommand'],
    ['testCommand com aspas', { testCommand: 'npm test "a b"' }, 'testCommand'],
    ['testCommand com crase', { testCommand: 'npm test `id`' }, 'testCommand'],
    ['installCommand com {QA_PORT}', { installCommand: 'npm ci --port {QA_PORT}' }, 'installCommand'],
    ['testCommand com {QA_PORT}', { testCommand: 'npm test {QA_PORT}' }, 'testCommand'],
    ['startCommand com outra chave', { startCommand: 'npm run dev {OUTRA}' }, 'startCommand'],
    ['campo faltando', { profiles: undefined }, 'profiles'],
    ['tipo errado', { cut: 'nada' }, 'cut'],
    ['sem células', { cells: [] }, 'cells'],
    ['13 células', { cells: Array.from({ length: 13 }, (_, i) => cellOf({ id: `c${i}` })) }, 'cells'],
    ['id de célula repetido', { cells: [cellOf(), cellOf()] }, 'c1'],
    ['id de célula com ..', { cells: [cellOf({ id: '..' })] }, 'id'],
    ['id de célula com /', { cells: [cellOf({ id: 'a/b' })] }, 'id'],
    ['id de célula com ponto', { cells: [cellOf({ id: 'a.b' })] }, 'id'],
    ['id de célula com maiúscula', { cells: [cellOf({ id: 'C1' })] }, 'id'],
    ['id de célula com 32 caracteres', { cells: [cellOf({ id: 'a'.repeat(32) })] }, 'id'],
    ['id de requisito repetido', { requirements: [{ id: 'r1', text: 'a', source: 's' }, { id: 'r1', text: 'b', source: 's' }] }, 'r1'],
    ['id de requisito inválido', { requirements: [{ id: 'R/1', text: 'a', source: 's' }] }, 'id'],
    ['perfil repetido', { profiles: ['admin', 'admin'] }, 'admin'],
    ['perfil inválido', { profiles: ['../admin'] }, 'profiles'],
    ['contêiner inválido', { backend: { containers: ['a b'] } }, 'containers'],
    ['requisito inexistente', { cells: [cellOf({ requirement: 'r9' })] }, 'requirement'],
    ['perfil inexistente', { cells: [cellOf({ profile: 'gerente' })] }, 'profile'],
    ['largura fora da lista', { cells: [cellOf({ width: 500 as 360 })] }, 'width'],
    ['risco fora da lista', { cells: [cellOf({ risk: 'critico' as 'alto' })] }, 'risk'],
    ['route sem barra', { cells: [cellOf({ route: 'cadastro' })] }, 'route'],
    ['route //evil', { cells: [cellOf({ route: '//evil.com' })] }, 'route'],
    ['criteria vazio', { cells: [cellOf({ criteria: [] })] }, 'criteria'],
    ['critério sem then', { cells: [cellOf({ criteria: [{ given: 'a', when: 'b' } as never] })] }, 'then'],
    ['steps vazio', { cells: [cellOf({ steps: [] })] }, 'steps'],
    ['status 99', { cells: [cellOf({ expectedStatus: [{ url: '/a', status: 99 }] })] }, 'status'],
    ['status 600', { cells: [cellOf({ expectedStatus: [{ url: '/a', status: 600 }] })] }, 'status'],
    ['status 200.5', { cells: [cellOf({ expectedStatus: [{ url: '/a', status: 200.5 }] })] }, 'status'],
  ]
  for (const [name, patch, field] of refused) {
    test(`recusa: ${name}`, () => {
      const r = parseMatrix(mdOf({ ...matrixOf(), ...(patch as object) }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(field)
    })
  }

  test('recusa texto sem bloco json, com dois blocos e com json quebrado', () => {
    expect(parseMatrix('sem bloco').ok).toBe(false)
    expect(parseMatrix(mdOf(matrixOf()) + mdOf(matrixOf())).ok).toBe(false)
    expect(parseMatrix('```json\n{ "baseUrl": \n```').ok).toBe(false)
  })

  test('{QA_PORT} vale só em startCommand e testCommand pode ser vazio', () => {
    expect(parseMatrix(mdOf(matrixOf({ testCommand: '' }))).ok).toBe(true)
  })
})

describe('argvOf, startArgvOf e baseUrlAt', () => {
  test('quebra por espaço em branco e vazio vira lista vazia', () => {
    expect(argvOf('npm  run   dev')).toEqual(['npm', 'run', 'dev'])
    expect(argvOf('')).toEqual([])
  })

  test('troca {QA_PORT} pela porta em cada argumento', () => {
    expect(startArgvOf(matrixOf({ startCommand: 'npm run dev -- --port {QA_PORT} --host=localhost:{QA_PORT}' }), 4123)).toEqual([
      'npm', 'run', 'dev', '--', '--port', '4123', '--host=localhost:4123',
    ])
  })

  test('troca a porta da baseUrl sem barra final', () => {
    expect(baseUrlAt('http://localhost:3000', 4123)).toBe('http://localhost:4123')
    expect(baseUrlAt('https://127.0.0.1/', 4123)).toBe('https://127.0.0.1:4123')
  })
})

const resultOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  startedAt: '2026-11-09T10:00:00Z',
  endedAt: '2026-11-09T10:01:00Z',
  completed: true,
  steps: [{ n: 1, action: 'abrir', url: '/cadastro', screenshot: 'p1.png', text: 'Salvar' }],
  console: [{ type: 'error', text: 'falha' }],
  pageErrors: [],
  ...over,
})

describe('parseResult', () => {
  test('aceita um resultado válido, com e sem error', () => {
    expect(parseResult(JSON.stringify(resultOf()))).toEqual(resultOf() as unknown as CellResult)
    expect(parseResult(JSON.stringify(resultOf({ error: 'caiu' })))?.error).toBe('caiu')
  })

  const bad: [string, Record<string, unknown>][] = [
    ['id fora do padrão', { id: '../x' }],
    ['completed texto', { completed: 'sim' }],
    ['startedAt faltando', { startedAt: undefined }],
    ['passo sem screenshot', { steps: [{ n: 1, action: 'a', url: 'u', text: 't' }] }],
    ['n fracionário', { steps: [{ n: 1.5, action: 'a', url: 'u', screenshot: 's', text: 't' }] }],
    ['console com texto solto', { console: ['falha'] }],
    ['pageErrors com número', { pageErrors: [1] }],
    ['error com número', { error: 5 }],
  ]
  for (const [name, patch] of bad) {
    test(`recusa: ${name}`, () => expect(parseResult(JSON.stringify(resultOf(patch)))).toBeNull())
  }

  test('recusa texto que não é json', () => {
    expect(parseResult('não é json')).toBeNull()
  })
})

const rawVerdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  verdict: 'PASS',
  evidence: [{ criterion: 0, proof: 'ok' }],
  defects: [],
  backend: 'lido',
  ...over,
})

const rawDefect = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'd1',
  source: 'geometria',
  where: 'button.salvar',
  repro: ['abrir'],
  ...over,
})

const parseV = (v: Record<string, unknown>, rules: readonly string[] = ['overlap']): CellVerdict | null => parseVerdict(JSON.stringify(v), rules)

describe('parseVerdict', () => {
  test('aceita um veredito válido', () => {
    expect(parseV(rawVerdict())).toEqual(verdictOf({ evidence: [{ criterion: 0, proof: 'ok' }] }))
  })

  test('INSTÁVEL e NÃO VERIFICADO só o mod decide: o veredito do agente é inválido', () => {
    expect(parseV(rawVerdict({ verdict: 'INSTÁVEL' }))).toBeNull()
    expect(parseV(rawVerdict({ verdict: 'NÃO VERIFICADO' }))).toBeNull()
    expect(parseV(rawVerdict({ verdict: 'qualquer' }))).toBeNull()
  })

  test('aceita os seis vereditos do agente', () => {
    for (const verdict of ['AMBIENTE', 'FAIL-AGENTE', 'FAIL-APP', 'FAIL-VISUAL', 'CANDIDATO-VISUAL', 'PASS']) {
      expect(parseV(rawVerdict({ verdict }))?.verdict).toBe(verdict)
    }
  })

  test('opinião de modelo nunca reprova: impeccable-audit e pergunta-visual viram candidate', () => {
    for (const source of ['impeccable-audit', 'pergunta-visual']) {
      const v = parseV(rawVerdict({ defects: [rawDefect({ source, rule: 'overlap', severity: 'fail' })] }))
      expect(v?.defects[0]?.severity).toBe('candidate')
    }
  })

  test('impeccable-detect só reprova com regra de failRules', () => {
    const sev = (rule?: string): string | undefined =>
      parseV(rawVerdict({ defects: [rawDefect({ source: 'impeccable-detect', rule })] }))?.defects[0]?.severity
    expect(sev('overlap')).toBe('fail')
    expect(sev('outra')).toBe('candidate')
    expect(sev(undefined)).toBe('candidate')
  })

  test('geometria, rede e console reprovam; o agente não rebaixa nem sobe a gravidade', () => {
    for (const source of ['geometria', 'rede', 'console']) {
      expect(parseV(rawVerdict({ defects: [rawDefect({ source, severity: 'candidate' })] }))?.defects[0]?.severity).toBe('fail')
    }
  })

  test('o kind sai da fonte, ignorando o que o agente escreveu', () => {
    const kind = (source: string, extra: Record<string, unknown> = {}): string | undefined =>
      parseV(rawVerdict({ defects: [rawDefect({ source, kind: 'funcional', ...extra })] }))?.defects[0]?.kind
    expect(kind('impeccable-detect')).toBe('design')
    expect(kind('geometria')).toBe('design')
    expect(kind('impeccable-audit')).toBe('design')
    expect(kind('pergunta-visual')).toBe('design')
    expect(kind('rede')).toBe('funcional')
    expect(kind('console')).toBe('funcional')
    expect(kind('criterio', { rule: '0' })).toBe('funcional')
  })

  test('criterio mantém o kind informado e exige um dos dois valores', () => {
    const d = (kind: unknown): CellVerdict | null => parseV(rawVerdict({ defects: [rawDefect({ source: 'criterio', rule: '1', kind })] }))
    expect(d('design')?.defects[0]?.kind).toBe('design')
    expect(d('outro')).toBeNull()
    expect(d(undefined)).toBeNull()
  })

  test('criterio sem rule, ou com rule que não é índice decimal, invalida o veredito', () => {
    const d = (rule: unknown): CellVerdict | null => parseV(rawVerdict({ defects: [rawDefect({ source: 'criterio', kind: 'funcional', rule })] }))
    expect(d(undefined)).toBeNull()
    expect(d('primeiro')).toBeNull()
    expect(d('-1')).toBeNull()
    expect(d('01')).toBeNull()
    expect(d('2')?.defects[0]?.rule).toBe('2')
  })

  test('guarda text e rule quando o agente informa', () => {
    const d = parseV(rawVerdict({ defects: [rawDefect({ source: 'impeccable-detect', rule: 'overlap', text: 'Salvar' })] }))?.defects[0]
    expect(d).toEqual({ id: 'd1', kind: 'design', source: 'impeccable-detect', rule: 'overlap', where: 'button.salvar', text: 'Salvar', severity: 'fail', repro: ['abrir'] })
  })

  const bad: [string, Record<string, unknown>][] = [
    ['id da célula fora do padrão', { id: 'A/B' }],
    ['backend desconhecido', { backend: 'talvez' }],
    ['criterion negativo', { evidence: [{ criterion: -1, proof: 'x' }] }],
    ['criterion fracionário', { evidence: [{ criterion: 0.5, proof: 'x' }] }],
    ['proof que não é texto', { evidence: [{ criterion: 0, proof: 1 }] }],
    ['id de defeito fora do padrão', { defects: [rawDefect({ id: 'D.1' })] }],
    ['id de defeito repetido', { defects: [rawDefect(), rawDefect()] }],
    ['fonte desconhecida', { defects: [rawDefect({ source: 'palpite' })] }],
    ['where vazio', { defects: [rawDefect({ where: '' })] }],
    ['repro com número', { defects: [rawDefect({ repro: [1] })] }],
    ['defects que não é lista', { defects: {} }],
  ]
  for (const [name, patch] of bad) {
    test(`recusa: ${name}`, () => expect(parseV(rawVerdict(patch))).toBeNull())
  }

  test('recusa texto que não é json', () => {
    expect(parseVerdict('nada', [])).toBeNull()
  })
})

describe('finalVerdictOf', () => {
  const cell = cellOf({ criteria: [crit, crit] })
  const p0 = { criterion: 0, proof: 'a' }
  const p1 = { criterion: 1, proof: 'b' }
  const proofs = [p0, p1]
  const fail = (over: Partial<Defect> = {}): Defect => defectOf({ severity: 'fail', ...over })

  test('sem veredito, ou veredito de outra célula, é NÃO VERIFICADO', () => {
    expect(finalVerdictOf(cell, null)).toBe('NÃO VERIFICADO')
    expect(finalVerdictOf(cell, verdictOf({ id: 'c2', evidence: proofs }))).toBe('NÃO VERIFICADO')
  })

  test('AMBIENTE e FAIL-AGENTE passam como estão', () => {
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'AMBIENTE' }))).toBe('AMBIENTE')
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-AGENTE' }))).toBe('FAIL-AGENTE')
  })

  test('FAIL-APP sem defeito fail é NÃO VERIFICADO; com defeito fail é FAIL-APP', () => {
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-APP' }))).toBe('NÃO VERIFICADO')
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-APP', defects: [defectOf({ severity: 'candidate' })] }))).toBe('NÃO VERIFICADO')
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-APP', defects: [fail({ kind: 'funcional' })] }))).toBe('FAIL-APP')
  })

  test('PASS com todas as provas e sem defeito é PASS', () => {
    expect(finalVerdictOf(cell, verdictOf({ evidence: proofs }))).toBe('PASS')
  })

  test('PASS com defeito fail funcional vira FAIL-APP; com fail de design vira FAIL-VISUAL', () => {
    expect(finalVerdictOf(cell, verdictOf({ evidence: proofs, defects: [fail({ kind: 'funcional', source: 'rede' })] }))).toBe('FAIL-APP')
    expect(finalVerdictOf(cell, verdictOf({ evidence: proofs, defects: [fail()] }))).toBe('FAIL-VISUAL')
  })

  test('funcional pesa mais que design quando os dois falham', () => {
    const defects = [fail(), fail({ id: 'd2', kind: 'funcional', source: 'console' })]
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-VISUAL', evidence: proofs, defects }))).toBe('FAIL-APP')
  })

  test('FAIL-VISUAL só com candidatos não reprova: sai CANDIDATO-VISUAL (ou PASS sem defeito)', () => {
    const cand = defectOf({ severity: 'candidate' })
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-VISUAL', evidence: proofs, defects: [cand] }))).toBe('CANDIDATO-VISUAL')
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'FAIL-VISUAL', evidence: proofs }))).toBe('PASS')
  })

  test('PASS sem prova de um critério é NÃO VERIFICADO, também com prova vazia', () => {
    expect(finalVerdictOf(cell, verdictOf({ evidence: [p0] }))).toBe('NÃO VERIFICADO')
    expect(finalVerdictOf(cell, verdictOf({ evidence: [p0, { criterion: 1, proof: '  ' }] }))).toBe('NÃO VERIFICADO')
  })

  test('falta de prova não esconde um defeito fail', () => {
    expect(finalVerdictOf(cell, verdictOf({ evidence: [], defects: [fail()] }))).toBe('FAIL-VISUAL')
  })

  test('CANDIDATO-VISUAL declarado, sem nenhum candidato, vira PASS', () => {
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'CANDIDATO-VISUAL', evidence: proofs }))).toBe('PASS')
  })

  test('os vereditos que só o mod decide, vindos num veredito, são NÃO VERIFICADO', () => {
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'INSTÁVEL', evidence: proofs }))).toBe('NÃO VERIFICADO')
    expect(finalVerdictOf(cell, verdictOf({ verdict: 'NÃO VERIFICADO', evidence: proofs }))).toBe('NÃO VERIFICADO')
  })
})

describe('isUnstable', () => {
  test('é instável quando o veredito mudou', () => {
    expect(isUnstable('FAIL-APP', 'PASS')).toBe(true)
    expect(isUnstable('FAIL-APP', 'FAIL-APP')).toBe(false)
  })
})

describe('normalizedTextOf', () => {
  test('minúsculas, dígitos viram # e espaços colapsam', () => {
    expect(normalizedTextOf('  Salvar   ITEM \n 12 ')).toBe('salvar item #')
  })

  test('contador e data não diferenciam o texto', () => {
    expect(normalizedTextOf('3 itens em 09/11/2026')).toBe(normalizedTextOf('12 itens em 10/12/2027'))
    expect(normalizedTextOf('Total: 1.234,50')).toBe('total: #.#,#')
  })
})

describe('defectIdOf e signatureOf', () => {
  test('junta célula e defeito com ponto', () => {
    expect(defectIdOf('c1', 'd2')).toBe('c1.d2')
  })

  test('opinião de modelo só tem fonte e regra; as demais incluem o where normalizado', () => {
    expect(signatureOf(defectOf({ source: 'impeccable-audit', rule: 'contraste', where: 'a 1' }))).toBe('impeccable-audit|contraste')
    expect(signatureOf(defectOf({ source: 'pergunta-visual', where: 'b' }))).toBe('pergunta-visual|')
    expect(signatureOf(defectOf({ source: 'geometria', where: 'Botão   Salvar 3' }))).toBe('geometria||botão salvar #')
    expect(signatureOf(defectOf({ source: 'impeccable-detect', rule: 'overlap', where: 'x' }))).toBe('impeccable-detect|overlap|x')
  })

  test('o id do defeito não entra na assinatura', () => {
    expect(signatureOf(defectOf({ id: 'd1' }))).toBe(signatureOf(defectOf({ id: 'd9' })))
  })
})

describe('reportOf e checkedDefectsOf', () => {
  const m = matrixOf({
    requirements: [
      { id: 'r1', text: 'Salvar item', source: 's' },
      { id: 'r2', text: 'Listar itens', source: 's' },
      { id: 'r3', text: 'Sem célula', source: 's' },
    ],
    cells: [
      cellOf({ id: 'c1', requirement: 'r1' }),
      cellOf({ id: 'c2', requirement: 'r1', flow: 'edição', profile: 'vendedor', width: 360, risk: 'baixo' }),
      cellOf({ id: 'c3', requirement: 'r2', route: '/lista' }),
      cellOf({ id: 'c4', requirement: 'r2', route: '/lista' }),
      cellOf({ id: 'c5', requirement: 'r2', route: '/lista' }),
    ],
    cut: ['relatórios por e-mail', 'tema escuro'],
  })
  const fail1 = defectOf({ id: 'd1', repro: ['abrir', 'clicar'] })
  const cand = defectOf({ id: 'd2', source: 'impeccable-audit', rule: 'contraste', severity: 'candidate', where: 'h1' })
  const outcomes: Record<string, CellOutcome> = {
    c1: outcomeOf('FAIL-VISUAL', verdictOf({ id: 'c1', verdict: 'FAIL-VISUAL', defects: [fail1, cand] })),
    c2: outcomeOf('PASS', verdictOf({ id: 'c2', evidence: [{ criterion: 0, proof: 'viu "Salvo"' }] })),
    c3: outcomeOf('INSTÁVEL', verdictOf({ id: 'c3', verdict: 'FAIL-APP', defects: [defectOf({ id: 'd1', kind: 'funcional', source: 'rede', where: 'POST /api' })] })),
    c4: outcomeOf('CANDIDATO-VISUAL', verdictOf({ id: 'c4', verdict: 'CANDIDATO-VISUAL', evidence: [{ criterion: 0, proof: 'ok c4' }], defects: [cand] })),
  }
  const report = reportOf({ runId: 'run-7', matrix: m, outcomes })

  test('título com runId e baseUrl, e uma linha de contagem por veredito', () => {
    expect(report.split('\n')[0]).toContain('run-7')
    expect(report.split('\n')[0]).toContain('http://localhost:3000')
    expect(report).toContain('- PASS: 1')
    expect(report).toContain('- FAIL-VISUAL: 1')
    expect(report).toContain('- INSTÁVEL: 1')
    expect(report).toContain('- CANDIDATO-VISUAL: 1')
    expect(report).toContain('- NÃO VERIFICADO: 1')
    expect(report).toContain('- FAIL-APP: 0')
  })

  test('instruções: desmarcar, o botão e onde ficam os testes gerados', () => {
    expect(report).toContain('[ ]')
    expect(report).toContain('QA: Corrigir')
    expect(report).toContain('celulas/<id>/teste.spec.ts')
  })

  test('rastreabilidade por requisito, com a célula sem entrada como NÃO VERIFICADO', () => {
    expect(report).toContain('Salvar item')
    expect(report).toContain('Sem célula')
    expect(report).toContain('- c2 · edição · vendedor · 360px · risco baixo · PASS')
    expect(report).toContain('- c5 · cadastro · admin · 1280px · risco alto · NÃO VERIFICADO')
    expect(report.indexOf('Salvar item')).toBeLessThan(report.indexOf('- c2 ·'))
    expect(report.indexOf('- c2 ·')).toBeLessThan(report.indexOf('Listar itens'))
  })

  test('defeito fail em FAIL-VISUAL vem marcado, candidato vem desmarcado, instável sem caixa', () => {
    expect(report).toContain('- [x] c1.d1 · design · geometria · button.salvar\n  1. abrir\n  2. clicar')
    expect(report).toContain('- [ ] c1.d2 · design · impeccable-audit:contraste · h1')
    expect(report).toContain('- (instável) c3.d1 · funcional · rede · POST /api')
    expect(report).not.toContain('[x] c3.d1')
  })

  test('provas só das células PASS e CANDIDATO-VISUAL; cortes no fim', () => {
    const provas = report.slice(report.indexOf('## Provas'), report.indexOf('## Cortes'))
    expect(provas).toContain('viu "Salvo"')
    expect(provas).toContain('ok c4')
    expect(provas).not.toContain('c1')
    expect(report.slice(report.indexOf('## Cortes'))).toContain('- relatórios por e-mail\n- tema escuro')
  })

  test('as seções vêm na ordem do brief', () => {
    const at = ['Rastreabilidade', 'Defeitos', 'Provas', 'Cortes'].map(s => report.indexOf(`## ${s}`))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('ida e volta: o que o relatório marca, checkedDefectsOf devolve', () => {
    expect(checkedDefectsOf(report)).toEqual(['c1.d1'])
  })

  test('checkedDefectsOf aceita [X], ignora o resto e só casa o formato exato', () => {
    const text = ['- [x] c1.d1 · a', '- [X] c2.d3 · b', '- [ ] c3.d1 · c', '- [x] c4.d1 sem separador', '- [x] semponto · d', 'texto - [x] c5.d1 · e', '  - [x] c6.d1 · f'].join('\n')
    expect(checkedDefectsOf(text)).toEqual(['c1.d1', 'c2.d3'])
  })

  test('um where com quebra de linha não forja um item marcado', () => {
    const evil = defectOf({ id: 'd1', where: 'x\n- [x] c99.d9 · design · geometria · y', repro: ['a\n- [x] c98.d9 · z'] })
    const r = reportOf({
      runId: 'r',
      matrix: matrixOf(),
      outcomes: { c1: outcomeOf('FAIL-VISUAL', verdictOf({ verdict: 'FAIL-VISUAL', defects: [evil] })) },
    })
    expect(checkedDefectsOf(r)).toEqual(['c1.d1'])
    expect(r).not.toContain('\n- [x] c99')
  })

  test('quebras de linha de outros textos do agente também não abrem linha nova', () => {
    const evilMatrix = matrixOf({
      requirements: [{ id: 'r1', text: 'a\n- [x] c9.d9 · z', source: 's' }],
      cells: [cellOf({ flow: 'f - [x] c8.d8 · z' })],
    })
    const r = reportOf({ runId: 'r\n- [x] c7.d7 · z', matrix: evilMatrix, outcomes: { c1: outcomeOf('PASS', verdictOf({ evidence: [{ criterion: 0, proof: 'p\n- [x] c6.d6 · z' }] })) } })
    expect(checkedDefectsOf(r)).toEqual([])
  })

  test('fail em célula que não concluiu fica desmarcado', () => {
    const r = reportOf({ runId: 'r', matrix: matrixOf(), outcomes: { c1: outcomeOf('AMBIENTE', verdictOf({ verdict: 'AMBIENTE', defects: [fail1] })) } })
    expect(r).toContain('- [ ] c1.d1 ·')
    expect(checkedDefectsOf(r)).toEqual([])
  })
})

describe('fixQueueOf', () => {
  const des = (id: string): Defect => defectOf({ id, kind: 'design' })
  const fun = (id: string): Defect => defectOf({ id, kind: 'funcional', source: 'rede' })
  const outcomes: Record<string, CellOutcome> = {
    c1: outcomeOf('FAIL-APP', verdictOf({ id: 'c1', verdict: 'FAIL-APP', defects: [fun('d1'), des('d2')] })),
    c2: outcomeOf('FAIL-VISUAL', verdictOf({ id: 'c2', verdict: 'FAIL-VISUAL', defects: [des('d1'), fun('d2')] })),
    c3: outcomeOf('INSTÁVEL', verdictOf({ id: 'c3', verdict: 'FAIL-APP', defects: [fun('d1')] })),
    c4: outcomeOf('NÃO VERIFICADO'),
  }

  test('design antes de funcional, ordem estável dentro de cada grupo', () => {
    expect(fixQueueOf(['c1.d1', 'c2.d2', 'c1.d2', 'c2.d1'], outcomes)).toEqual(['c1.d2', 'c2.d1', 'c1.d1', 'c2.d2'])
  })

  test('sai o id inexistente, o de célula instável e o repetido', () => {
    expect(fixQueueOf(['c9.d1', 'c1.d9', 'c3.d1', 'c4.d1', 'c1.d1', 'c1.d1', 'lixo', 'a.b.c', 'constructor.d1'], outcomes)).toEqual(['c1.d1'])
  })

  test('lista vazia dá fila vazia', () => {
    expect(fixQueueOf([], outcomes)).toEqual([])
  })
})

describe('retestCellsOf', () => {
  const cells = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => cellOf({ id, route: id === 'f' ? '/outra' : '/lista' }))
  const m = matrixOf({ cells })
  const done = (final: Verdict): CellOutcome => outcomeOf(final)

  test('a célula do defeito primeiro, depois até 3 da mesma rota, em ordem da matriz', () => {
    const outcomes = { a: done('FAIL-APP'), b: done('PASS'), c: done('CANDIDATO-VISUAL'), d: done('FAIL-VISUAL'), e: done('PASS'), f: done('PASS') }
    expect(retestCellsOf(m, 'c', outcomes)).toEqual(['c', 'a', 'b', 'd'])
  })

  test('só rota igual e só veredito concluído', () => {
    const outcomes = { a: done('AMBIENTE'), b: done('FAIL-AGENTE'), c: done('PASS'), d: done('INSTÁVEL'), e: done('NÃO VERIFICADO'), f: done('PASS') }
    expect(retestCellsOf(m, 'a', outcomes)).toEqual(['a', 'c'])
  })

  test('célula sem entrada em outcomes não entra; célula fora da matriz devolve só ela', () => {
    expect(retestCellsOf(m, 'a', {})).toEqual(['a'])
    expect(retestCellsOf(m, 'zz', { a: done('PASS') })).toEqual(['zz'])
  })
})

describe('diffCheckOf', () => {
  const ok = { migration: false, reasons: [] }

  test('diff vazio e arquivo comum passam', () => {
    expect(diffCheckOf('', '')).toEqual(ok)
    expect(diffCheckOf('M\tsrc/app/page.tsx\nA\tsrc/novo.ts\nD\tsrc/velho.ts', '')).toEqual(ok)
  })

  test('teste novo pode', () => {
    expect(diffCheckOf('A\tsrc/a.test.ts\nA\ttests/b.py\nA\te2e/c.spec.ts', '')).toEqual(ok)
  })

  test('teste alterado, apagado ou com tipo trocado não pode, e a razão cita o caminho', () => {
    for (const status of ['M', 'D', 'T']) {
      const r = diffCheckOf(`${status}\tsrc/a.test.ts`, '')
      expect(r.reasons).toHaveLength(1)
      expect(r.reasons[0]).toContain('src/a.test.ts')
    }
  })

  test('renomear um teste não pode (o caminho antigo é alterado)', () => {
    const r = diffCheckOf('R100\ttests/a.ts\ttests/b.ts', '')
    expect(r.reasons).toHaveLength(1)
    expect(r.reasons[0]).toContain('tests/a.ts')
  })

  test('reconhece os formatos de teste das linguagens do brief', () => {
    const paths = ['a.test.js', 'a.spec.tsx', 'a.test.mjs', 'a.test.cjs', 'test_a.py', 'a_test.py', 'a_test.go', 'ATest.php', 'ATest.java', 'ATest.kt', 'x.feature', 'x/__tests__/a.ts', 'cypress/a.ts', 'playwright/a.ts', 'spec/a.rb', 'specs/a.rb', 'src/test/a.java']
    for (const p of paths) expect(diffCheckOf(`M\t${p}`, '').reasons).toHaveLength(1)
  })

  test('arquivo parecido, mas que não é teste, passa', () => {
    expect(diffCheckOf('M\tsrc/contest.ts\nM\tsrc/latest/a.ts\nM\tsrc/protester.ts', '').reasons).toEqual([])
  })

  test('base de print: novo pode; alterado, apagado e renomeado não', () => {
    expect(diffCheckOf('A\tsrc/__snapshots__/a.snap', '')).toEqual(ok)
    for (const line of ['M\tsrc/__snapshots__/a.png', 'D\tvisual-snapshots/a.png', 'M\ta.snap', 'R90\tsrc/__image_snapshots__/a.png\tsrc/b.png']) {
      expect(diffCheckOf(line, '').reasons.length).toBeGreaterThan(0)
    }
  })

  test('configuração do Impeccable: qualquer status, qualquer caixa', () => {
    for (const line of ['A\t.impeccable/config.json', 'M\timpeccable.config.js', 'D\tpkg/Impeccable-rules/a.json', 'A\t.impeccablerc']) {
      const r = diffCheckOf(line, '')
      expect(r.reasons).toHaveLength(1)
      expect(r.reasons[0]).toContain(line.split('\t')[1])
    }
  })

  test('migração: qualquer status liga migration e dá motivo', () => {
    for (const line of ['A\tdb/migrate/001.rb', 'M\tprisma/schema.prisma', 'A\tsrc/migrations/001.sql', 'A\talembic/versions/a.py', 'A\tdrizzle/0001.sql', 'D\tapp/migration/a.sql']) {
      const r = diffCheckOf(line, '')
      expect(r.migration).toBe(true)
      expect(r.reasons).toHaveLength(1)
      expect(r.reasons[0]).toContain(line.split('\t')[1])
    }
  })

  test('arquivo comum não liga migration', () => {
    expect(diffCheckOf('M\tsrc/a.ts', '').migration).toBe(false)
  })

  const header = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n'
  test('cada marcador de supressão em linha acrescentada é recusado, citando o arquivo', () => {
    for (const marker of ['impeccable-disable', 'impeccable-ignore', 'eslint-disable', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'stylelint-disable', 'biome-ignore']) {
      const r = diffCheckOf('M\tsrc/a.ts', `${header}+// ${marker} regra\n`)
      expect(r.reasons).toHaveLength(1)
      expect(r.reasons[0]).toContain(marker)
      expect(r.reasons[0]).toContain('src/a.ts')
    }
  })

  test('o mesmo marcador em linha removida, em contexto ou no cabeçalho não conta', () => {
    expect(diffCheckOf('M\tsrc/a.ts', `${header}-// eslint-disable-next-line\n // @ts-ignore\n`)).toEqual(ok)
  })

  test('o arquivo certo é citado quando o patch tem vários', () => {
    const patch = '+++ b/src/a.ts\n+ok\n+++ b/src/b.ts\n+// @ts-ignore\n'
    expect(diffCheckOf('M\tsrc/a.ts\nM\tsrc/b.ts', patch).reasons[0]).toContain('src/b.ts')
  })

  test('linha irreconhecível do name-status é recusada', () => {
    for (const line of ['lixo', 'X\ta.ts', 'M\t', 'R100\tsó-um', 'M\ta\tb', 'MM\ta.ts']) {
      const r = diffCheckOf(line, '')
      expect(r.reasons).toHaveLength(1)
    }
  })

  test('todos os motivos aparecem, sem repetir', () => {
    const r = diffCheckOf('M\ta.test.ts\nM\tprisma/schema.prisma', '')
    expect(r.reasons).toHaveLength(2)
    expect(r.migration).toBe(true)
  })

  test('cópia para fora de teste passa; cópia criada dentro de snapshots é nova e passa', () => {
    expect(diffCheckOf('C100\ttests/a.ts\tsrc/b.ts', '')).toEqual(ok)
  })
})

describe('acceptFixOf', () => {
  const cells = [cellOf({ id: 'c1', criteria: [crit, crit] })]
  const p0 = { criterion: 0, proof: 'a' }
  const p1 = { criterion: 1, proof: 'b' }
  const proofs = [p0, p1]
  const target = defectOf({ id: 'd1', source: 'impeccable-detect', rule: 'overlap', where: 'button.salvar', text: 'Salvar 3' })
  const old = defectOf({ id: 'd2', source: 'geometria', where: 'h1' })
  const result: CellResult = {
    id: 'c1', startedAt: '', endedAt: '', completed: true, console: [], pageErrors: [],
    steps: [{ n: 1, action: 'abrir', url: '/', screenshot: 'p.png', text: 'Cadastro\nSALVAR 9 \nSair' }],
  }
  const evOf = (verdict: CellVerdict | null, res: CellResult | null = result): Evidence => ({ result: res, verdict })
  const before = { c1: evOf(verdictOf({ verdict: 'FAIL-VISUAL', evidence: proofs, defects: [target, old] })) }
  const clean = { c1: evOf(verdictOf({ evidence: proofs, defects: [old] })) }
  const run = (after: Record<string, Evidence>, over: { t?: Defect; b?: Record<string, Evidence> } = {}) =>
    acceptFixOf({ target: { cell: 'c1', defect: over.t ?? target }, cells, before: over.b ?? before, after })

  test('aceita o caso limpo, mesmo com outro defeito antigo ainda aberto', () => {
    expect(run(clean)).toEqual({ accepted: true, reasons: [] })
  })

  test('1: reteste que não concluiu', () => {
    for (const verdict of [null, verdictOf({ verdict: 'AMBIENTE' }), verdictOf({ verdict: 'FAIL-AGENTE' }), verdictOf({ evidence: [] })]) {
      const r = run({ c1: evOf(verdict) })
      expect(r.accepted).toBe(false)
      expect(r.reasons.some(x => x.includes('c1') && x.includes('concluiu'))).toBe(true)
    }
    expect(run({}).accepted).toBe(false)
  })

  test('2: o defeito alvo continua, mesmo com outro id e outro número no where', () => {
    const again = defectOf({ id: 'd7', source: 'impeccable-detect', rule: 'overlap', where: 'button.salvar' })
    const r = run({ c1: evOf(verdictOf({ verdict: 'FAIL-VISUAL', evidence: proofs, defects: [again, old] })) })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('continua'))).toBe(true)
  })

  test('3: defeito fail novo na mesma célula', () => {
    const novo = defectOf({ id: 'd9', source: 'rede', kind: 'funcional', where: 'POST /api/itens' })
    const r = run({ c1: evOf(verdictOf({ verdict: 'FAIL-APP', evidence: proofs, defects: [old, novo] })) })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('c1') && x.includes('novo') && x.includes('rede'))).toBe(true)
  })

  test('3: candidato novo não recusa', () => {
    const cand = defectOf({ id: 'd9', source: 'impeccable-audit', severity: 'candidate' })
    expect(run({ c1: evOf(verdictOf({ verdict: 'CANDIDATO-VISUAL', evidence: proofs, defects: [old, cand] })) }).accepted).toBe(true)
  })

  test('4: critério que tinha prova e perdeu', () => {
    const r = run({ c1: evOf(verdictOf({ evidence: [p0], defects: [old] })) })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('c1') && x.includes('critério 1'))).toBe(true)
  })

  test('4: critério que já não tinha prova antes não conta como regressão', () => {
    const b = { c1: evOf(verdictOf({ verdict: 'FAIL-VISUAL', evidence: [p0], defects: [target, old] })) }
    const r = run({ c1: evOf(verdictOf({ evidence: [p0], defects: [old] })) }, { b })
    expect(r.reasons.some(x => x.includes('critério 1'))).toBe(false)
  })

  test('5: alvo de fonte criterio exige prova do critério alvo no reteste', () => {
    const t = defectOf({ id: 'd1', kind: 'funcional', source: 'criterio', rule: '1', where: 'form' })
    const b = { c1: evOf(verdictOf({ verdict: 'FAIL-APP', evidence: [p0], defects: [t] })) }
    const r = run({ c1: evOf(verdictOf({ evidence: [p0] })) }, { t, b })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('c1') && x.includes('critério 1'))).toBe(true)
    expect(run({ c1: evOf(verdictOf({ evidence: proofs })) }, { t, b }).accepted).toBe(true)
  })

  test('6: a correção apagou o texto do botão', () => {
    const gone: CellResult = { ...result, steps: [{ ...result.steps[0]!, text: 'Cadastro Sair' }] }
    const r = run({ c1: evOf(verdictOf({ evidence: proofs, defects: [old] }), gone) })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('c1') && x.includes('texto'))).toBe(true)
  })

  test('6: sem resultado no reteste, o texto não pode ser conferido', () => {
    const r = run({ c1: evOf(verdictOf({ evidence: proofs, defects: [old] }), null) })
    expect(r.accepted).toBe(false)
    expect(r.reasons.some(x => x.includes('texto'))).toBe(true)
  })

  test('6: alvo sem texto não confere texto', () => {
    const t = { ...target, text: '' }
    expect(run({ c1: evOf(verdictOf({ evidence: proofs, defects: [old] }), null) }, { t }).accepted).toBe(true)
  })

  test('junta todos os motivos que valem', () => {
    const novo = defectOf({ id: 'd9', source: 'console', kind: 'funcional', where: 'erro' })
    const r = run({ c1: evOf(verdictOf({ verdict: 'FAIL-APP', evidence: [], defects: [target, novo] })) })
    expect(r.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('fixReportOf', () => {
  const fix = (status: FixResult['status'], over: Partial<FixResult> = {}): FixResult => ({
    defect: 'c1.d1', status, attempts: 2, commits: ['abc123'], reasons: ['o defeito continua'],
    retest: [{ cell: 'c1', verdict: 'PASS' }], before: 'antes.png', after: 'depois.png', regressionTest: 'tests/x.spec.ts', pending: ['conferir em produção'], ...over,
  })
  const results = [fix('corrigido'), fix('não reverificado', { defect: 'c2.d1' }), fix('não reproduzido na worktree', { defect: 'c3.d1' }), fix('desistiu', { defect: 'c4.d1', commits: [], regressionTest: undefined })]
  const text = fixReportOf(results)

  test('conta por status e os quatro aparecem', () => {
    for (const s of ['corrigido', 'não reverificado', 'não reproduzido na worktree', 'desistiu']) expect(text).toContain(`- ${s}: 1`)
  })

  test('traz, por defeito, tentativas, commits, motivos, reteste, prints, teste e pendências', () => {
    for (const piece of ['c1.d1', 'c4.d1', 'abc123', 'o defeito continua', 'c1: PASS', 'antes.png', 'depois.png', 'tests/x.spec.ts', 'conferir em produção']) {
      expect(text).toContain(piece)
    }
    expect(text).toContain('tentativas: 2')
  })

  test('lista vazia mostra contagem zero', () => {
    expect(fixReportOf([])).toContain('- corrigido: 0')
  })
})
