import { describe, expect, test } from 'claude-code/testing'

import { bashCheckOf, writeCheckOf } from '../hooks/qa-guard'
import type { GuardCtx, QaRole } from '../hooks/qa-guard'

const ROLES: QaRole[] = ['runner', 'observer', 'fixer']

const FIX = '/home/u/app/.worktrees/qa-1'
const RUN = '/home/u/.claude/workbench-qa/app/20261109-1000'
const SAVED = '/home/u/.claude/workbench-qa/app/auth/s.json'
const AB = '/home/u/.claude/workbench-qa/bin/agent-browser'
const IMP = '/home/u/.claude/workbench-qa/bin/impeccable'
const S = 'qa-c01'

const CTX: GuardCtx = {
  home: '/home/u',
  repoRoot: '/home/u/app',
  fixDir: FIX,
  runDir: RUN,
  agentBrowser: AB,
  impeccable: IMP,
  session: S,
  cdpPort: 45655,
  origins: ['http://localhost:3000'],
  testCommand: 'npm test',
  containers: ['api'],
}

const AB_S = `${AB} --session ${S}`

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
    // opção global do git com argumento separado, conhecida ou não
    'git --attr-source HEAD push',
    'git --shallow-file x push',
    'git --opcao-inventada push',
    'git --opcao-inventada x push',
  ]
  for (const role of ROLES) {
    for (const command of denied) {
      test(`${role} nega: ${command}`, () => {
        expect(decision(role, command)).toBe('deny')
      })
    }
  }

  test('o motivo da negação vem em português e diz o que foi negado', () => {
    expect(bashCheckOf('runner', 'git push', CTX).reason).toContain('git')
    expect(bashCheckOf('fixer', 'git push', CTX).reason).toContain('push')
    expect(bashCheckOf('runner', 'gh pr list', CTX).reason).toContain('gh')
    expect(bashCheckOf('runner', 'cat /home/u/app/a', CTX).reason).toContain('/home/u/app/a')
  })

  test('fixer nega caminho relativo que sai da worktree para o checkout principal', () => {
    expect(decision('fixer', 'cat ../../src/a.ts')).toBe('deny')
  })

  test('caminho relativo do runner vale contra o checkout principal', () => {
    expect(decision('runner', `${AB_S} screenshot ./shot.png`)).toBe('deny')
  })

  test('fixer nega git add com caminho que sai da worktree', () => {
    expect(decision('fixer', `git -C ${FIX} add ../../src/a.ts`)).toBe('deny')
  })
})

describe('bashCheckOf: nega cd e pushd', () => {
  test('fixer nega cd para fora da worktree', () => {
    expect(decision('fixer', 'cd /tmp')).toBe('deny')
    expect(decision('fixer', 'cd ../..')).toBe('deny')
    expect(decision('fixer', 'cd')).toBe('deny')
    expect(decision('fixer', 'cd && ls')).toBe('deny')
    expect(decision('fixer', 'cd -')).toBe('deny')
    expect(decision('fixer', 'pushd ~')).toBe('deny')
  })

  test('cd escrito com aspas no meio também é visto', () => {
    expect(decision('fixer', "c''d /tmp")).toBe('deny')
    expect(decision('fixer', 'c""d /')).toBe('deny')
    expect(decision('runner', "c''d /tmp")).toBe('deny')
    expect(decision('fixer', "pu''shd /tmp")).toBe('deny')
  })

  test('runner e observer negam todo cd', () => {
    expect(decision('runner', 'cd src')).toBe('deny')
    expect(decision('observer', 'cd src')).toBe('deny')
    expect(decision('runner', `cd ${FIX}`)).toBe('deny')
  })

  test('o motivo do cd de runner e observer não fala em worktree de correção', () => {
    const reason = bashCheckOf('runner', 'cd src', CTX).reason
    expect(reason).toContain('cd')
    expect(reason).not.toContain('worktree')
    expect(bashCheckOf('fixer', 'cd /tmp', CTX).reason).toContain('worktree')
  })

  test('fixer sem fixDir nega qualquer caminho dentro do checkout principal e qualquer cd', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(decision('fixer', `cat ${FIX}/a`, ctx)).toBe('deny')
    expect(decision('fixer', 'cd src', ctx)).toBe('deny')
  })
})

describe('bashCheckOf: git para runner e observer', () => {
  for (const role of ['runner', 'observer'] as const) {
    test(`${role} nega qualquer git, até os de leitura`, () => {
      expect(decision(role, 'git status')).toBe('deny')
      expect(decision(role, 'git log')).toBe('deny')
      expect(decision(role, `git -C ${FIX} status`)).toBe('deny')
      expect(decision(role, `${AB_S} fill @e6 "git"`)).toBe('deny')
    })
  }
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
    `${AB_S} open http://localhost:3000; ls`,
    `${AB_S} open http://localhost:3000 && ls`,
    `${AB_S} open http://localhost:3000 | cat`,
    `${AB_S} open \`ls\``,
    `${AB_S} open $(ls)`,
    `${AB_S} open $HOME`,
    `${AB_S} open http://localhost:3000 > ${RUN}/o`,
    `${AB_S} open < ${RUN}/o`,
    `${AB_S} open a\\b`,
    `${AB_S} open a\nls`,
    `${AB_S} open a\rls`,
    `${AB_S} open *.png`,
    `${AB_S} open a?`,
    `${AB_S} open [a]`,
    `${AB_S} open {a,b}`,
    `${AB_S} open !x`,
    `${AB_S} open #x`,
    `${AB_S} open ~x`,
    `${AB_S} open a~`,
    `${AB_S} open "http://localhost:3000`,
    `${AB_S} open 'http://localhost:3000`,
    `VAR=x ${AB_S} open http://localhost:3000`,
    `${AB_S} fill @e1 "a;b"`,
    `${AB_S} fill @e1 "$HOME"`,
    // til: só `~/` solto no começo de uma palavra fora de aspas escapa da trava
    `${AB_S} screenshot "~/.claude/workbench-qa/app/20261109-1000/x.png"`,
    `${AB_S} screenshot '~/.claude/workbench-qa/app/20261109-1000/x.png'`,
    `${AB_S} screenshot ~u/x.png`,
    `${AB_S} fill @e1 "um ~ solto"`,
    `${AB_S} fill @e1 "a ~/b"`,
  ]
  for (const command of shapes) {
    test(`pass: ${JSON.stringify(command)}`, () => {
      expect(decision('runner', command)).toBe('pass')
    })
  }

  test('o mesmo agent-browser sem os extras é liberado', () => {
    expect(decision('runner', `${AB_S} open http://localhost:3000`)).toBe('allow')
  })

  test('glob dentro de aspas não trava sozinho', () => {
    expect(decision('runner', `${AB_S} fill @e1 "*"`)).toBe('allow')
  })
})

describe('bashCheckOf: libera', () => {
  const allowed = [
    `${AB_S} open http://localhost:3000/login`,
    `${AB_S} snapshot -i`,
    `${AB_S} click @e5`,
    `${AB_S} fill @e6 "João da Silva / Ação"`,
    `${AB_S} fill @e6 "10/11/2026"`,
    `${AB_S} press Enter`,
    `${AB_S} find role button click --name Salvar`,
    `${AB_S} get text body`,
    `${AB_S} errors --json`,
    `${AB_S} network requests --status 500`,
    `${AB_S} screenshot ${RUN}/celulas/c01/passo-1.png`,
    `${AB_S} screenshot --full ${RUN}/celulas/c01/passo-1.png`,
    `${AB_S} snapshot -d 3 -c`,
    `${AB_S} dblclick @e1`,
    `${AB_S} select @e1 a b`,
    `${AB_S} keyboard type abc`,
    `${AB_S} scroll down 300`,
    `${AB_S} scroll up`,
    `${AB_S} is visible @e1`,
    `${AB_S} get url`,
    `${AB_S} find text Salvar click`,
    `${AB_S} find label Nome fill João`,
    `${AB_S} reload`,
    `${AB_S} console`,
    `${AB_S} back`,
    `${AB_S} wait 500`,
    `${AB_S} network requests --filter api --method POST`,
    `${IMP} detect --json --cdp 45655 --target sobreposto`,
    `${IMP} detect --cdp 45655 --scope layout,texto --no-advisory`,
    'curl -sS http://localhost:3000/api/x',
    'curl -sS -X POST -H "Accept: text/html" http://localhost:3000/api',
    `curl -sSf -m 5 -d '{"a":1}' http://localhost:3000/api`,
  ]
  for (const command of allowed) {
    for (const role of ROLES) {
      test(`${role} allow: ${command}`, () => {
        expect(decision(role, command)).toBe('allow')
      })
    }
  }
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
    expect(decision('fixer', `git -C ${FIX} commit -F ${RUN}/msg.txt`)).toBe('allow')
  })
  test('comando de testes exato como fixer', () => {
    expect(decision('fixer', 'npm test')).toBe('allow')
    expect(decision('fixer', '  npm test  ')).toBe('allow')
  })
})

describe('bashCheckOf: não libera (pass)', () => {
  const cases: Array<[QaRole, string]> = [
    // agent-browser: só a sessão preparada pelo mod, subcomandos e opções da lista
    ['runner', `${AB} open http://localhost:3000`],
    ['runner', `${AB} --session outra snapshot`],
    ['runner', `${AB} --cdp 9222 --session ${S} snapshot`],
    ['runner', `${AB_S} --cdp 9222 snapshot`],
    ['runner', `${AB_S} snapshot --allowed-domains x`],
    ['runner', `${AB_S} snapshot --allowed-domains=localhost`],
    ['runner', `${AB_S} --headed snapshot`],
    ['runner', `${AB_S}`],
    ['runner', `${AB_S} open https://example.com`],
    ['runner', `${AB_S} open http://localhost:9222/json`],
    ['runner', `${AB_S} open http://127.0.0.1:3000`],
    ['runner', `${AB_S} open file:///etc/passwd`],
    ['runner', `${AB_S} open http://user:pw@localhost:3000`],
    ['runner', `${AB_S} open http:localhost`],
    ['runner', `${AB_S} open`],
    ['runner', `${AB_S} open http://localhost:3000 http://localhost:3000`],
    ['runner', `${AB_S} screenshot package.json`],
    ['runner', `${AB_S} screenshot .env`],
    ['runner', `${AB_S} screenshot /home/u/.bashrc`],
    ['runner', `${AB_S} screenshot ${AB}`],
    ['runner', `${AB_S} screenshot ${RUN}/x.txt`],
    ['runner', `${AB_S} screenshot ${RUN}/../../x.png`],
    ['runner', `${AB_S} screenshot ${RUN}/a.png ${RUN}/b.png`],
    ['runner', `${AB_S} screenshot`],
    ['runner', `${AB_S} state save ${RUN}/s.json`],
    ['runner', `${AB_S} cookies`],
    ['runner', `${AB_S} eval "document.cookie"`],
    ['runner', `${AB_S} get html body`],
    ['runner', `${AB_S} get cdp-url`],
    ['runner', `${AB_S} network requests --json`],
    ['runner', `${AB_S} network har start`],
    ['runner', `${AB_S} network requests --filter`],
    ['runner', `${AB_S} snapshot --filter api`],
    ['runner', `${AB_S} batch "open http://localhost:3000"`],
    ['runner', `${AB_S} close`],
    ['runner', `${AB_S} set viewport 1280 800`],
    ['runner', `${AB_S} fill @e6 --headed`],
    ['runner', `${AB_S} fill @e6`],
    ['runner', `${AB_S} fill @e6 a b`],
    ['runner', `${AB_S} snapshot extra`],
    ['runner', `${AB_S} snapshot -d x`],
    ['runner', `${AB_S} scroll sideways`],
    ['runner', `${AB_S} keyboard press a`],
    ['runner', `${AB_S} is hidden @e1`],
    ['runner', `${AB_S} find role button explode`],
    ['runner', `${AB_S} find role button click --name --headed`],
    ['runner', `/tmp/agent-browser --session ${S} snapshot`],
    // impeccable: só `detect` com a porta do mod
    ['runner', `${IMP} detect --json --cdp 9222 --target x`],
    ['runner', `${IMP} detect --json http://localhost:3000`],
    ['runner', `${IMP} detect --json --cdp 45655 --no-config`],
    ['runner', `${IMP} detect --json --cdp 45655 extra`],
    ['runner', `${IMP} detect --json`],
    ['runner', `${IMP} detect --cdp 45655 --target --x`],
    ['runner', `${IMP} detect --cdp 45655 --scope Layout`],
    ['runner', `${IMP} install`],
    ['runner', `${IMP}`],
    // curl
    ['runner', 'curl https://example.com'],
    ['runner', 'curl http://localhost:3000.evil.com'],
    ['runner', 'curl http://localhost:9222/json/version'],
    ['runner', 'curl http://127.0.0.1:3000/x'],
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
    // docker logs
    ['runner', 'docker logs api'],
    ['fixer', 'docker logs api'],
    ['observer', 'docker logs -f api'],
    ['observer', 'docker logs --follow api'],
    ['observer', 'docker logs db'],
    ['observer', 'docker logs api db'],
    ['observer', 'docker logs --tail api'],
    ['observer', 'docker ps'],
    ['observer', 'docker exec api sh'],
    // git da worktree
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
    ['fixer', `git -C ${FIX} commit -F ${SAVED}`],
    ['fixer', `git -C ${FIX}/src status`],
    ['fixer', 'git -C src status'],
    // testes e vazio
    ['fixer', 'npm test -- x'],
    ['fixer', ''],
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

  test('sessão vazia no contexto não libera agent-browser, nem com palavra vazia', () => {
    const ctx = { ...CTX, session: '' }
    expect(decision('runner', `${AB} --session ${S} snapshot`, ctx)).toBe('pass')
    expect(decision('runner', `${AB} --session "" snapshot`, ctx)).toBe('pass')
  })

  test('porta de depuração nula no contexto não libera impeccable', () => {
    const ctx = { ...CTX, cdpPort: null }
    expect(decision('runner', `${IMP} detect --json --cdp 45655`, ctx)).toBe('pass')
  })

  test('sem origens no contexto nenhuma URL é liberada', () => {
    const ctx = { ...CTX, origins: [] }
    expect(decision('runner', `${AB_S} open http://localhost:3000`, ctx)).toBe('pass')
    expect(decision('runner', 'curl http://localhost:3000', ctx)).toBe('pass')
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
      for (const path of [SAVED, AB, '/home/u/app/src/a.ts', `${FIX}/a.ts`, '/tmp/x', 'rel.txt', '/home/u/.bashrc']) {
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
  test('caminho que começa com til é negado, mesmo apontando para o runDir', () => {
    for (const role of ROLES) {
      expect(writeCheckOf(role, '~/.claude/workbench-qa/app/20261109-1000/x', CTX)).toBe('deny')
      expect(writeCheckOf(role, '~/.bashrc', CTX)).toBe('deny')
      expect(writeCheckOf(role, '~', CTX)).toBe('deny')
      expect(writeCheckOf(role, '~u/x', CTX)).toBe('deny')
    }
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
