import { describe, expect, test } from 'claude-code/testing'

import { bashCheckOf, writeCheckOf } from '../hooks/qa-guard'
import type { GuardCtx, QaRole } from '../hooks/qa-guard'

const ROLES: QaRole[] = ['runner', 'observer', 'fixer']

const FIX = '/home/u/app/.worktrees/qa-1'
const RUN = '/home/u/.claude/workbench-qa/app/20261109-1000'
const AUTH = '/home/u/.claude/workbench-qa/app/auth'
const AB = '/home/u/.claude/workbench-qa/bin/agent-browser'
const IMP = '/home/u/.claude/workbench-qa/bin/impeccable'

const CTX: GuardCtx = {
  home: '/home/u',
  repoRoot: '/home/u/app',
  fixDir: FIX,
  runDir: RUN,
  authDir: AUTH,
  agentBrowser: AB,
  impeccable: IMP,
  testCommand: 'npm test',
  containers: ['api'],
}

const AB_OK = `${AB} --allowed-domains localhost,127.0.0.1`

const decision = (role: QaRole, command: string, ctx: GuardCtx = CTX) => bashCheckOf(role, command, ctx).decision

describe('bashCheckOf: nega', () => {
  const denied = [
    'git push',
    `git -C ${FIX} push`,
    'git -c x=y push',
    'git --no-pager push',
    'VAR=x git push',
    '/usr/bin/git push',
    'env git push',
    "bash -c 'git push'",
    'git -c alias.p=push p',
    'git --git-dir=/x push',
    'git -c core.pager=cat push',
    'gh pr create',
    '/usr/bin/gh pr create',
    'curl http://localhost:3000 && git push',
    'echo ok; git reset --hard',
    'git stash',
    'git checkout main',
    'git switch -c x',
    'git merge x',
    'git rebase x',
    'git clean -fd',
    'git branch -D x',
    'git worktree remove x',
    'git config user.email x',
    'git remote add o url',
    'cat /home/u/app/src/a.ts',
    'tool --out=/home/u/app/x.txt',
    // furos fechados além do brief
    'git.exe push',
    'g""it push',
    'git branch -vd x',
    'git branch --del x',
    'git --config-env=alias.p=X p',
    'git -c ALIAS.p=push p',
    'tool --out=/home/u/app/a://b',
    'tool VAR=~/app/x',
  ]
  for (const role of ROLES) {
    for (const command of denied) {
      test(`${role} nega: ${command}`, () => {
        expect(decision(role, command)).toBe('deny')
      })
    }
  }

  test('o motivo da negação vem em português e diz o que foi negado', () => {
    expect(bashCheckOf('runner', 'git push', CTX).reason).toContain('push')
    expect(bashCheckOf('runner', 'gh pr list', CTX).reason).toContain('gh')
    expect(bashCheckOf('runner', 'cat /home/u/app/a', CTX).reason).toContain('/home/u/app/a')
  })

  test('fixer nega caminho relativo que sai da worktree para o checkout principal', () => {
    expect(decision('fixer', 'cat ../../src/a.ts')).toBe('deny')
  })

  test('fixer nega cd para fora da worktree', () => {
    expect(decision('fixer', 'cd /tmp')).toBe('deny')
    expect(decision('fixer', 'cd ../..')).toBe('deny')
    expect(decision('fixer', 'cd')).toBe('deny')
    expect(decision('fixer', 'cd && ls')).toBe('deny')
    expect(decision('fixer', 'cd -')).toBe('deny')
    expect(decision('fixer', 'pushd ~')).toBe('deny')
  })

  test('caminho relativo do runner vale contra o checkout principal', () => {
    expect(decision('runner', `${AB_OK} screenshot ./shot.png`)).toBe('deny')
  })

  test('fixer nega git add com caminho que sai da worktree', () => {
    expect(decision('fixer', `git -C ${FIX} add ../../src/a.ts`)).toBe('deny')
  })

  test('runner e observer negam todo cd', () => {
    expect(decision('runner', 'cd src')).toBe('deny')
    expect(decision('observer', 'cd src')).toBe('deny')
    expect(decision('runner', `cd ${FIX}`)).toBe('deny')
  })

  test('fixer sem fixDir nega qualquer caminho dentro do checkout principal e qualquer cd', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(decision('fixer', `cat ${FIX}/a`, ctx)).toBe('deny')
    expect(decision('fixer', 'cd src', ctx)).toBe('deny')
  })
})

describe('bashCheckOf: não nega quando o subcomando é outro', () => {
  test('commit cuja mensagem cita switch', () => {
    expect(decision('fixer', `git -C ${FIX} commit -m "Corrige o switch de tema"`)).not.toBe('deny')
  })
  test('log que procura reset', () => {
    expect(decision('fixer', `git -C ${FIX} log --grep reset`)).not.toBe('deny')
  })
  test('caminho dentro da worktree como fixer', () => {
    expect(decision('fixer', `cat ${FIX}/src/a.ts`)).not.toBe('deny')
  })
  test('cd para dentro da worktree como fixer', () => {
    expect(decision('fixer', `cd ${FIX}/src`)).not.toBe('deny')
  })
  test('URL não é caminho', () => {
    expect(decision('runner', 'curl http://localhost:3000/../x')).not.toBe('deny')
  })
})

describe('bashCheckOf: nunca libera comando encadeado, expandido ou com aspas soltas', () => {
  const shapes = [
    `${AB_OK} open http://localhost:3000; ls`,
    `${AB_OK} open http://localhost:3000 && ls`,
    `${AB_OK} open http://localhost:3000 | cat`,
    `${AB_OK} open \`ls\``,
    `${AB_OK} open $(ls)`,
    `${AB_OK} open $HOME`,
    `${AB_OK} open http://localhost:3000 > ${RUN}/o`,
    `${AB_OK} open < ${RUN}/o`,
    `${AB_OK} open a\\b`,
    `${AB_OK} open a\nls`,
    `${AB_OK} open a\rls`,
    `${AB_OK} open *.png`,
    `${AB_OK} open a?`,
    `${AB_OK} open [a]`,
    `${AB_OK} open {a,b}`,
    `${AB_OK} open !x`,
    `${AB_OK} open #x`,
    `${AB_OK} open ~x`,
    `${AB_OK} open a~`,
    `${AB_OK} open "http://localhost:3000`,
    `${AB_OK} open 'http://localhost:3000`,
    `VAR=x ${AB_OK} open http://localhost:3000`,
    `${AB_OK} open "a;b"`,
    `${AB_OK} open "$HOME"`,
  ]
  for (const command of shapes) {
    test(`pass: ${JSON.stringify(command)}`, () => {
      expect(decision('runner', command)).toBe('pass')
    })
  }

  test('o mesmo agent-browser sem os extras é liberado', () => {
    expect(decision('runner', `${AB_OK} open http://localhost:3000`)).toBe('allow')
  })

  test('glob e til dentro de aspas, e ~/ no começo da palavra, não travam sozinhos', () => {
    expect(decision('runner', `${AB_OK} fill "*" "x"`)).toBe('allow')
  })
})

describe('bashCheckOf: libera', () => {
  for (const role of ROLES) {
    test(`${role}: agent-browser com --allowed-domains em duas palavras`, () => {
      expect(decision(role, `${AB} --allowed-domains localhost,127.0.0.1 open http://localhost:3000/x`)).toBe('allow')
    })
  }
  test('agent-browser com a forma =', () => {
    expect(decision('runner', `${AB} --allowed-domains=localhost,127.0.0.1 open http://localhost:3000/x`)).toBe('allow')
  })
  test('agent-browser com print dentro de runDir', () => {
    expect(decision('runner', `${AB_OK} screenshot ${RUN}/shot.png`)).toBe('allow')
  })
  test('agent-browser com sessão dentro de authDir', () => {
    expect(decision('runner', `${AB_OK} state save ${AUTH}/admin.json`)).toBe('allow')
  })
  test('impeccable com URL localhost', () => {
    expect(decision('observer', `${IMP} detect http://localhost:3000`)).toBe('allow')
  })
  test('curl com método, cabeçalho e URL 127.0.0.1', () => {
    expect(decision('runner', 'curl -sS -X POST -H "Accept: text/html" http://127.0.0.1:3000/api')).toBe('allow')
  })
  test('curl com corpo e tempo', () => {
    expect(decision('runner', `curl -sSf -m 5 -d '{"a":1}' http://localhost:3000/api`)).toBe('allow')
  })
  test('docker logs como observer', () => {
    expect(decision('observer', 'docker logs --since 2026-11-09T10:00:00 --tail 200 api')).toBe('allow')
    expect(decision('observer', 'docker logs --tail=50 -t api')).toBe('allow')
  })
  test('git da worktree como fixer', () => {
    expect(decision('fixer', `git -C ${FIX} add src/a.ts`)).toBe('allow')
    expect(
      decision('fixer', `git -C ${FIX} commit -m "Corrige estouro em /estouro" -m "Como foi provado: reteste"`),
    ).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} diff`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} status`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} log`)).toBe('allow')
  })
  test('comando de testes exato como fixer', () => {
    expect(decision('fixer', 'npm test')).toBe('allow')
    expect(decision('fixer', '  npm test  ')).toBe('allow')
  })
})

describe('bashCheckOf: não libera (pass)', () => {
  const cases: Array<[QaRole, string]> = [
    ['runner', `${AB} open http://localhost:3000`],
    ['runner', `${AB} --allowed-domains localhost,evil.com open http://localhost:3000`],
    ['runner', `${AB} --allowed-domains localhost,127.0.0.1 --allowed-domains localhost,127.0.0.1 open http://localhost:3000`],
    ['runner', `${AB} --allowed-domains localhost,127.0.0.1 --allowed-domains=localhost,127.0.0.1 open http://localhost:3000`],
    ['runner', `${AB} --allowed-domains=* open http://localhost:3000`],
    ['runner', `${AB} --allowed-domains-extra=localhost,127.0.0.1 open http://localhost:3000`],
    ['runner', `${AB_OK} open https://example.com`],
    ['runner', `${AB_OK} open file:///etc/passwd`],
    ['runner', `${AB_OK} open http://localhost@evil.com`],
    ['runner', `${AB_OK} open http://user:pw@localhost:3000`],
    ['runner', `${AB_OK} open http://localhost.evil.com`],
    ['runner', `${AB_OK} open http:localhost`],
    ['runner', `${AB_OK} screenshot /home/u/.bashrc`],
    ['runner', `${AB_OK} screenshot ${AB}`],
    ['runner', `${AB_OK} screenshot --out=/home/u/.bashrc`],
    ['runner', `${AB_OK} screenshot ${RUN}/../x.png`],
    ['runner', `/tmp/agent-browser --allowed-domains localhost,127.0.0.1 open http://localhost:3000`],
    ['runner', 'curl https://example.com'],
    ['runner', 'curl http://localhost:3000.evil.com'],
    ['runner', 'curl -o x http://localhost:3000'],
    ['runner', 'curl -O http://localhost:3000'],
    ['runner', 'curl -T x http://localhost:3000'],
    ['runner', 'curl -K x http://localhost:3000'],
    ['runner', 'curl -sSo x http://localhost:3000'],
    ['runner', 'curl -d @arquivo http://localhost:3000'],
    ['runner', 'curl --data-binary x http://localhost:3000'],
    ['runner', 'curl -L http://localhost:3000'],
    ['runner', 'curl -sS'],
    ['runner', 'curl -X TRACE http://localhost:3000'],
    ['runner', 'curl -H "X: a@b" http://localhost:3000'],
    ['runner', `curl -w '%output{x}' http://localhost:3000`],
    ['runner', 'curl http://localhost:3000 localhost:3000'],
    ['runner', 'docker logs api'],
    ['fixer', 'docker logs api'],
    ['observer', 'docker logs -f api'],
    ['observer', 'docker logs --follow api'],
    ['observer', 'docker logs db'],
    ['observer', 'docker logs api db'],
    ['observer', 'docker logs --tail api'],
    ['observer', 'docker ps'],
    ['observer', 'docker exec api sh'],
    ['fixer', `git -C ${FIX} commit --no-verify -m x`],
    ['fixer', `git -C ${FIX} commit --no-ver -m x`],
    ['fixer', `git -C ${FIX} commit -n -m x`],
    ['fixer', `git -C ${FIX} commit -nm x`],
    ['fixer', `git -C ${FIX} diff --output=x`],
    ['fixer', `git -C ${FIX} diff --outp x`],
    ['fixer', `git -C ${FIX} diff --ext-diff`],
    ['fixer', `git -C ${FIX} diff --no-index a b`],
    ['fixer', `git -C ${FIX} -c a=b status`],
    ['fixer', 'git status'],
    ['fixer', `git -C ${FIX} show`],
    ['fixer', `git -C ${FIX} add /home/u/.bashrc`],
    ['fixer', `git -C ${FIX}/src status`],
    ['fixer', 'git -C src status'],
    ['fixer', 'npm test -- x'],
    ['fixer', ''],
    ['runner', `git -C ${FIX} status`],
    ['observer', `git -C ${FIX} status`],
    ['runner', 'npm test'],
    ['observer', 'npm test'],
    ['runner', ''],
    ['runner', 'ls'],
  ]
  for (const [role, command] of cases) {
    test(`${role} pass: ${command}`, () => {
      expect(decision(role, command)).toBe('pass')
    })
  }

  test('git -C no checkout principal é negado pela regra de caminho, não só deixado passar', () => {
    expect(decision('fixer', 'git -C /home/u/app status')).toBe('deny')
  })

  test('testCommand vazio não libera comando vazio nem nada', () => {
    const ctx = { ...CTX, testCommand: '' }
    expect(decision('fixer', '', ctx)).toBe('pass')
    expect(decision('fixer', '   ', ctx)).toBe('pass')
  })

  test('binário fixado vazio não libera palavra vazia', () => {
    const ctx = { ...CTX, agentBrowser: '', impeccable: '' }
    expect(decision('runner', '""', ctx)).toBe('pass')
  })

  test('fixer sem fixDir não libera git da worktree', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(decision('fixer', 'git -C  status', ctx)).toBe('pass')
    expect(decision('fixer', 'git -C "" status', ctx)).toBe('pass')
  })
})

describe('writeCheckOf', () => {
  for (const role of ROLES) {
    test(`${role} escreve dentro de runDir`, () => {
      expect(writeCheckOf(role, `${RUN}/shot.png`, CTX)).toBe('allow')
    })
  }
  for (const role of ['runner', 'observer'] as const) {
    test(`${role} não escreve fora de runDir`, () => {
      for (const path of [`${AUTH}/s.json`, AB, '/home/u/app/src/a.ts', `${FIX}/a.ts`, '/tmp/x', 'rel.txt', '/home/u/.bashrc']) {
        expect(writeCheckOf(role, path, CTX)).toBe('deny')
      }
    })
  }
  test('fixer escreve dentro de fixDir', () => {
    expect(writeCheckOf('fixer', `${FIX}/src/a.ts`, CTX)).toBe('allow')
  })
  test('fixer não escreve no checkout principal fora de fixDir', () => {
    expect(writeCheckOf('fixer', '/home/u/app/src/a.ts', CTX)).toBe('deny')
    expect(writeCheckOf('fixer', '/home/u/app/.worktrees/qa-10/a.ts', CTX)).toBe('deny')
  })
  test('fixer não escreve em .git da worktree', () => {
    expect(writeCheckOf('fixer', `${FIX}/.git`, CTX)).toBe('deny')
    expect(writeCheckOf('fixer', `${FIX}/.git/config`, CTX)).toBe('deny')
    expect(writeCheckOf('fixer', `${FIX}/src/../.git`, CTX)).toBe('deny')
    expect(writeCheckOf('fixer', `${FIX}/.gitignore`, CTX)).toBe('allow')
  })
  test('fixer não escapa de fixDir com ..', () => {
    expect(writeCheckOf('fixer', `${FIX}/../../src/a.ts`, CTX)).toBe('deny')
  })
  test('barra invertida vale como barra', () => {
    expect(writeCheckOf('fixer', `${FIX}\\src\\a.ts`, CTX)).toBe('allow')
    expect(writeCheckOf('fixer', `${FIX}\\..\\..\\src\\a.ts`, CTX)).toBe('deny')
    expect(writeCheckOf('fixer', `${FIX}\\.git\\config`, CTX)).toBe('deny')
  })
  test('caminho relativo do fixer vale contra fixDir, o do runner contra repoRoot', () => {
    expect(writeCheckOf('fixer', 'src/a.ts', CTX)).toBe('allow')
    expect(writeCheckOf('fixer', '../a.ts', CTX)).toBe('deny')
    expect(writeCheckOf('fixer', '.git/config', CTX)).toBe('deny')
    expect(writeCheckOf('runner', 'src/a.ts', CTX)).toBe('deny')
  })
  test('til vale contra a home', () => {
    expect(writeCheckOf('runner', '~/.claude/workbench-qa/app/20261109-1000/x', CTX)).toBe('allow')
    expect(writeCheckOf('runner', '~/.bashrc', CTX)).toBe('deny')
  })
  test('fixDir vazio não libera nada ao fixer', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(writeCheckOf('fixer', `${FIX}/a.ts`, ctx)).toBe('deny')
    expect(writeCheckOf('fixer', 'a.ts', ctx)).toBe('deny')
    expect(writeCheckOf('fixer', `${RUN}/a`, ctx)).toBe('allow')
  })
  test('runDir vazio não libera nada', () => {
    const ctx = { ...CTX, runDir: '' }
    for (const role of ROLES) {
      expect(writeCheckOf(role, '/x', ctx)).toBe('deny')
      expect(writeCheckOf(role, '', ctx)).toBe('deny')
    }
    expect(writeCheckOf('runner', 'x', ctx)).toBe('deny')
    expect(writeCheckOf('fixer', `${FIX}/a.ts`, ctx)).toBe('allow')
  })
  test('caminho vazio é negado', () => {
    expect(writeCheckOf('fixer', '', CTX)).toBe('deny')
  })
})
