import { describe, expect, test } from 'claude-code/testing'

import { bashCheckOf, guardDecisionOf, readCheckOf, writeCheckOf } from '../hooks/qa-guard'
import type { GuardCtx, QaRole } from '../hooks/qa-guard'

const ROLES: QaRole[] = ['runner', 'observer', 'fixer']

const FIX = '/home/u/app/.worktrees/qa-1'
const RUN = '/home/u/.claude/workbench-qa/app/20261109-1000'
const SAVED = '/home/u/.claude/workbench-qa/app/auth/s.json'
const AB = '/home/u/.claude/workbench-qa/bin/agent-browser'
const IMP = '/home/u/.claude/workbench-qa/bin/impeccable'
const S = 'qa-c01'
const REF = '/home/u/.claude/skills/ref'
const CWD = '/home/u/app' // a pasta da sessão do usuário: o cwd que o hook recebe

const CTX: GuardCtx = {
  home: '/home/u',
  repoRoot: '/home/u/app',
  fixDir: FIX,
  runDir: RUN,
  readDirs: [REF],
  agentBrowser: AB,
  impeccable: IMP,
  session: S,
  cdpPort: 45655,
  origins: ['http://localhost:3000'],
  containers: ['api'],
}

const AB_S = `${AB} --session ${S}`

const verdict = (role: QaRole, command: string, ctx: GuardCtx = CTX, cwd: string = CWD) => bashCheckOf(role, command, ctx, cwd)
const decision = (role: QaRole, command: string, ctx: GuardCtx = CTX, cwd: string = CWD) => verdict(role, command, ctx, cwd).decision
const wc = (role: QaRole, path: string, ctx: GuardCtx = CTX, cwd: string = CWD) => writeCheckOf(role, path, ctx, cwd)
const rc = (role: QaRole, path: string, ctx: GuardCtx = CTX, cwd: string = CWD) => readCheckOf(role, path, ctx, cwd)

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
    'git --inventada x branch -D main',
    'git --inventada x branch --delete main',
  ]
  for (const role of ROLES) {
    for (const command of denied) {
      test(`${role} nega: ${command}`, () => {
        expect(decision(role, command)).toBe('deny')
      })
    }
  }

  test('o motivo da negação vem em português e diz o que foi negado', () => {
    expect(verdict('runner', 'git push').reason).toContain('git')
    expect(verdict('fixer', 'git push').reason).toContain('push')
    expect(verdict('runner', 'gh pr list').reason).toContain('gh')
    expect(verdict('runner', 'cat /home/u/app/a').reason).toContain('/home/u/app/a')
  })

  test('caminho relativo vale contra a pasta da sessão, para o fixer também', () => {
    expect(decision('fixer', 'cat ../../src/a.ts', CTX, FIX)).toBe('deny')
    expect(decision('fixer', 'cat ./src/a.ts')).toBe('deny')
    expect(decision('fixer', 'cat src/a.ts')).toBe('pass')
    expect(decision('fixer', 'cat ./src/a.ts', CTX, FIX)).toBe('pass')
  })

  test('caminho relativo do runner vale contra o checkout principal', () => {
    expect(decision('runner', `${AB_S} screenshot ./shot.png`)).toBe('deny')
  })

  test('caminho que sai da worktree para o checkout é negado, não só deixado passar', () => {
    expect(decision('fixer', `ls ${FIX}/../../x`)).toBe('deny')
    expect(decision('fixer', `git -C ${FIX} commit -F../../x`)).toBe('deny')
  })

  test('fixer nega git diff com caminho que sai da worktree para o checkout', () => {
    expect(decision('fixer', `git -C ${FIX} diff ${CWD}/src/a.ts`)).toBe('deny')
    expect(decision('fixer', `git -C ${FIX} diff ../../src/a.ts`, CTX, FIX)).toBe('deny')
    expect(decision('fixer', `git -C ${FIX} diff ../x`)).toBe('pass')
  })
})

describe('bashCheckOf: nega cd e pushd', () => {
  const cds = ['cd /tmp', 'cd ../..', 'cd', 'cd && ls', 'cd -', 'pushd ~', 'cd src', `cd ${FIX}`, `cd ${FIX}/src`, "c''d /tmp", 'c""d /', "pu''shd /tmp"]
  for (const role of ROLES) {
    for (const command of cds) {
      test(`${role} nega: ${command}`, () => {
        expect(decision(role, command)).toBe('deny')
      })
    }
  }

  test('o motivo diz que cd é proibido', () => {
    expect(verdict('fixer', `cd ${FIX}/src`).reason).toContain('cd')
  })

  test('fixer sem fixDir nega qualquer caminho dentro do checkout principal', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(decision('fixer', `cat ${FIX}/a`, ctx)).toBe('deny')
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

const SEARCHES = [
  `ls -la ${FIX}/src`,
  `ls ${RUN}`,
  `ls -R ${FIX} ${RUN}`,
  `rg -n "useState" ${FIX}/src`,
  `rg -n -g "*.tsx" -e "foo bar" ${FIX}`,
  `rg -in -A 3 "foo" ${FIX}/src ${RUN}`,
  `grep -n --include "*.css" "overflow" ${FIX}/src/a.css`,
  `grep -n -m 2 "x" ${FIX}/src/a.css ${FIX}/src/b.css`,
  `grep -in x ${FIX}/src/a.css`,
  `find ${FIX}/src -name "*.tsx" -type f -maxdepth 3`,
  `find ${FIX} ${RUN} -iname "*.png" -not -path "*/node_modules/*" -mindepth 1`,
]

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
    `${AB_S} snapshot -i -c -d 3`,
    `${AB_S} snapshot -s "#main"`,
    `${AB_S} snapshot -u --json`,
    `${AB_S} screenshot ${RUN}/x.png --full`,
    `${AB_S} screenshot ${RUN}/x.png --annotate -f`,
    `${AB_S} wait --load networkidle`,
    `${AB_S} wait 500 --json`,
    `${AB_S} wait --load networkidle --json`,
    `${AB_S} wait --text Salvo --json`,
    `${AB_S} wait --text "Salvo"`,
    `${AB_S} console --clear`,
    `${AB_S} errors --clear`,
    `${AB_S} network requests --clear`,
    `${AB_S} find label "Nome" fill "Maria"`,
    `${AB_S} find text "Entrar"`,
    `${AB_S} find nth 2 ".card" hover`,
    `${AB_S} find nth 2 ".card"`,
    `${AB_S} find role heading text --name "Bem-vindo"`,
    `${AB_S} find role button click --name Salvar --exact`,
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
  test('git da worktree como fixer, só leitura', () => {
    expect(decision('fixer', `git -C ${FIX} diff`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} status`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} log`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} diff --stat`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} diff HEAD`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} diff --cached -- src/a.ts`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} status --short`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} status -s -b`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} log --oneline -n 5`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} log -5`)).toBe('allow')
    expect(decision('fixer', `git -C ${FIX} log --max-count=3 -p src/a.ts`)).toBe('allow')
  })
  test('busca no código pelo Bash, só para o fixer, só com caminho absoluto em fixDir ou runDir', () => {
    for (const command of SEARCHES) expect(decision('fixer', command)).toBe('allow')
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
    ['runner', `${AB_S} find nth 2 click`],
    ['runner', `${AB_S} find role button dblclick`],
    ['runner', `${AB_S} find label "Nome" click "x"`],
    ['runner', `${AB_S} find nada x`],
    ['runner', `${AB_S} find role`],
    ['runner', `${AB_S} find nth x ".card" hover`],
    // opção só vale no subcomando dela
    ['runner', `${AB_S} screenshot ${RUN}/x.png --name package.json`],
    ['runner', `${AB_S} screenshot ${RUN}/x.png -d 3`],
    ['runner', `${AB_S} click @e1 --name x`],
    ['runner', `${AB_S} snapshot --full`],
    ['runner', `${AB_S} get text body --clear`],
    ['runner', `${AB_S} wait --fn "1"`],
    ['runner', `${AB_S} wait --download /tmp/x`],
    ['runner', `${AB_S} wait @e1 --state hidden`],
    ['runner', `${AB_S} wait --load forever`],
    ['runner', `${AB_S} wait --load networkidle @e1`],
    ['runner', `${AB_S} wait --text`],
    ['runner', `${AB_S} wait`],
    ['runner', `${AB_S} wait a b`],
    ['runner', `${AB_S} snapshot -d`],
    ['runner', `${AB_S} snapshot -s --full`],
    ['runner', `${AB_S} console --json --clear x`],
    ['runner', `${AB_S} network requests --exact`],
    ['runner', `${AB_S} find role button click --name --exact`],
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
    ['runner', 'curl "http://localhost:3000/{a,b}"'],
    ['runner', 'curl "http://localhost:3000/[1-100000]"'],
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
    ['fixer', `git -C ${FIX} commit -F ${RUN}/msg.txt`],
    ['fixer', `git -C ${FIX} commit -F/etc/passwd`],
    ['fixer', `git -C ${FIX} commit -F /etc/passwd`],
    ['fixer', `git -C ${FIX} commit -F/home/u/.ssh/id_ed25519`],
    ['fixer', `git -C ${FIX} commit -F/home/u/app/src/a.ts`],
    ['fixer', `git -C ${FIX} commit -t/x`],
    ['fixer', `git -C ${FIX} commit --amend -m x`],
    ['fixer', `git -C ${FIX} commit -m`],
    ['fixer', `git -C ${FIX} commit -m x extra`],
    ['fixer', `git -C ${FIX} commit -am x`],
    ['fixer', `git -C ${FIX} diff -O/etc/passwd`],
    ['fixer', `git -C ${FIX} diff HEAD:x`],
    ['fixer', `git -C ${FIX} diff -- --output=x`],
    ['fixer', `git -C ${FIX} log --output=/tmp/x`],
    ['fixer', `git -C ${FIX} log -n x`],
    ['fixer', `git -C ${FIX} log --max-count=`],
    ['fixer', `git -C ${FIX} log -`],
    ['fixer', `git -C ${FIX} log -n5`],
    ['fixer', `git -C ${FIX} log --`],
    ['fixer', `git -C ${FIX} status --ignored`],
    ['fixer', `git -C ${FIX} status --`],
    ['fixer', `git -C ${FIX} add --pathspec-from-file=/etc/passwd`],
    ['fixer', `git -C ${FIX} add --chmod=+x src/a.ts`],
    ['fixer', `git -C ${FIX}/src status`],
    ['fixer', 'git -C src status'],
    // add e commit saíram: quem commita é o mod
    ['fixer', `git -C ${FIX} add x`],
    ['fixer', `git -C ${FIX} add -A`],
    ['fixer', `git -C ${FIX} commit -m x`],
    ['fixer', `git -C ${FIX} commit -m "Corrige estouro em /estouro" -m "Como foi provado: reteste"`],
    // busca fora da forma fechada
    ['fixer', 'rg -n foo'],
    ['fixer', 'rg foo src'],
    ['fixer', 'rg foo /etc'],
    ['fixer', 'ls'],
    ['fixer', 'ls -la'],
    ['fixer', 'ls src'],
    ['fixer', `ls ${FIX}/.env`],
    ['fixer', `ls ${FIX}/.env.local`],
    ['fixer', `ls ~/x`],
    ['fixer', `ls -la --color=always ${FIX}`],
    ['fixer', `ls -z ${FIX}`],
    ['fixer', `rg --pre cat foo ${FIX}`],
    ['fixer', `rg -f /etc/passwd ${FIX}`],
    ['fixer', `grep -f/etc/passwd x ${FIX}`],
    ['fixer', `grep -f /etc/passwd x ${FIX}`],
    ['fixer', `rg -A x foo ${FIX}`],
    ['fixer', `ls ${FIX.slice(1)}/src`],
    ['fixer', `rg foo ${FIX.slice(1)}`],
    ['fixer', `find ${FIX.slice(1)} -name x`],
    ['fixer', `rg -m x foo ${FIX}`],
    ['fixer', `rg --max-depth 2x foo ${FIX}`],
    ['fixer', `rg -e -foo ${FIX}`],
    ['fixer', `rg -n foo`],
    // recursão do grep e opções do rg que mostram oculto/ignorado (o `.env` copiado para a worktree)
    ['fixer', `grep -rn x ${FIX}/src`],
    ['fixer', `grep -R x ${FIX}`],
    ['fixer', `grep -r x ${FIX}`],
    ['fixer', `grep -nR x ${FIX}`],
    ['fixer', `rg -rn x ${FIX}`],
    ['fixer', `rg -r x foo ${FIX}`],
    ['fixer', `rg -R x ${FIX}`],
    ['fixer', `rg --hidden x ${FIX}`],
    ['fixer', `rg -u x ${FIX}`],
    ['fixer', `rg -uu x ${FIX}`],
    ['fixer', `rg --no-ignore x ${FIX}`],
    ['fixer', `grep -rn --include "*.css" "overflow" ${FIX}/src`],
    ['fixer', `rg -n ${FIX}`],
    ['fixer', `rg -g ${FIX}`],
    ['fixer', `grep -rn --include=*.css x ${FIX}`],
    ['fixer', `find ${FIX} -delete`],
    ['fixer', `find ${FIX} -fprint /tmp/x`],
    ['fixer', `find ${FIX} -type x`],
    ['fixer', `find ${FIX} -maxdepth x`],
    ['fixer', `find ${FIX} -name`],
    ['fixer', `find ${FIX} -name x y`],
    ['fixer', `find -name x`],
    ['fixer', `find -L ${FIX}`],
    ['fixer', `find src -name x`],
    ['fixer', `find /etc -name x`],
    ['fixer', `find ${FIX} -exec rm x`],
    ['fixer', `ls ${FIX}/.env/x`],
    ['runner', `ls -la ${FIX}/src`],
    ['observer', `ls ${RUN}`],
    ['runner', `rg -n "useState" ${FIX}/src`],
    ['observer', `grep -rn "x" ${FIX}`],
    ['runner', `find ${FIX}/src -name "*.tsx"`],
    // vazio
    ['fixer', 'npm test'],
    ['fixer', ''],
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

  test('comando vazio ou só espaços não libera nada', () => {
    expect(decision('fixer', '')).toBe('pass')
    expect(decision('fixer', '   ')).toBe('pass')
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
      expect(wc(role, `${RUN}/shot.png`, CTX)).toBe('allow')
    })
  }
  for (const role of ['runner', 'observer'] as const) {
    test(`${role} não escreve fora de runDir`, () => {
      for (const path of [SAVED, AB, '/home/u/app/src/a.ts', `${FIX}/a.ts`, '/tmp/x', 'rel.txt', '/home/u/.bashrc']) {
        expect(wc(role, path, CTX)).toBe('deny')
      }
    })
  }
  test('fixer escreve dentro de fixDir', () => {
    expect(wc('fixer', `${FIX}/src/a.ts`, CTX)).toBe('allow')
  })
  test('fixer não escreve no checkout principal fora de fixDir', () => {
    expect(wc('fixer', '/home/u/app/src/a.ts', CTX)).toBe('deny')
    expect(wc('fixer', '/home/u/app/.worktrees/qa-10/a.ts', CTX)).toBe('deny')
  })
  test('nega arquivo .env* em qualquer pasta, inclusive fixDir e runDir', () => {
    for (const path of [`${FIX}/.env`, `${FIX}/.env.local`, `${FIX}/apps/api/.env`, `${FIX}/.envrc`, `${RUN}/.env`, `${RUN}/x/.env.test`]) {
      expect(wc('fixer', path)).toBe('deny')
    }
    expect(wc('runner', `${RUN}/.env`)).toBe('deny')
    expect(wc('fixer', `${FIX}/src/env.ts`)).toBe('allow')
    expect(wc('fixer', `${FIX}/environment.ts`)).toBe('allow')
  })
  test('fixer não escreve em .git da worktree', () => {
    expect(wc('fixer', `${FIX}/.git`, CTX)).toBe('deny')
    expect(wc('fixer', `${FIX}/.git/config`, CTX)).toBe('deny')
    expect(wc('fixer', `${FIX}/src/../.git`, CTX)).toBe('deny')
    expect(wc('fixer', `${FIX}/.gitignore`, CTX)).toBe('allow')
  })
  test('fixer não escapa de fixDir com ..', () => {
    expect(wc('fixer', `${FIX}/../../src/a.ts`, CTX)).toBe('deny')
  })
  test('barra invertida vale como barra', () => {
    expect(wc('fixer', `${FIX}\\src\\a.ts`, CTX)).toBe('allow')
    expect(wc('fixer', `${FIX}\\..\\..\\src\\a.ts`, CTX)).toBe('deny')
    expect(wc('fixer', `${FIX}\\.git\\config`, CTX)).toBe('deny')
  })
  test('caminho relativo vale contra a pasta da sessão, para todo papel', () => {
    expect(wc('fixer', 'src/a.ts')).toBe('deny')
    expect(wc('fixer', 'src/a.ts', CTX, FIX)).toBe('allow')
    expect(wc('fixer', '../a.ts', CTX, FIX)).toBe('deny')
    expect(wc('fixer', '.git/config', CTX, FIX)).toBe('deny')
    expect(wc('runner', 'src/a.ts')).toBe('deny')
    expect(wc('runner', 'x.png', CTX, RUN)).toBe('allow')
    expect(wc('observer', '../x.png', CTX, RUN)).toBe('deny')
  })
  test('caminho que começa com til é negado, mesmo apontando para o runDir', () => {
    for (const role of ROLES) {
      expect(wc(role, '~/.claude/workbench-qa/app/20261109-1000/x', CTX)).toBe('deny')
      expect(wc(role, '~/.bashrc', CTX)).toBe('deny')
      expect(wc(role, '~', CTX)).toBe('deny')
      expect(wc(role, '~u/x', CTX)).toBe('deny')
    }
  })
  test('fixDir vazio não libera nada ao fixer', () => {
    const ctx = { ...CTX, fixDir: '' }
    expect(wc('fixer', `${FIX}/a.ts`, ctx)).toBe('deny')
    expect(wc('fixer', 'a.ts', ctx, FIX)).toBe('deny')
    expect(wc('fixer', `${RUN}/a`, ctx)).toBe('allow')
  })
  test('runDir vazio não libera nada', () => {
    const ctx = { ...CTX, runDir: '' }
    for (const role of ROLES) {
      expect(wc(role, '/x', ctx)).toBe('deny')
      expect(wc(role, '', ctx)).toBe('deny')
    }
    expect(wc('runner', 'x', ctx, RUN)).toBe('deny')
    expect(wc('fixer', `${FIX}/a.ts`, ctx)).toBe('allow')
  })
  test('caminho vazio é negado', () => {
    expect(wc('fixer', '', CTX)).toBe('deny')
  })
})

describe('bashCheckOf: a busca no código é só do fixer', () => {
  for (const role of ['runner', 'observer'] as const) {
    test(`${role} não libera a busca`, () => {
      for (const command of SEARCHES) expect(decision(role, command)).toBe('pass')
    })
  }
  test('o checkout principal continua negado pela regra de caminho', () => {
    expect(decision('fixer', `rg -n x ${CWD}/src`)).toBe('deny')
    expect(decision('fixer', `ls ${CWD}`)).toBe('deny')
  })
})

describe('readCheckOf', () => {
  test('libera runDir, readDirs e, só para o fixer, fixDir', () => {
    for (const role of ROLES) {
      expect(rc(role, `${RUN}/shot.png`)).toBe('allow')
      expect(rc(role, `${REF}/SKILL.md`)).toBe('allow')
      expect(rc(role, REF)).toBe('allow')
    }
    expect(rc('fixer', `${FIX}/src/a.ts`)).toBe('allow')
    expect(rc('runner', `${FIX}/src/a.ts`)).toBe('deny')
    expect(rc('observer', `${FIX}/src/a.ts`)).toBe('deny')
  })
  test('nega arquivo .env em qualquer pasta liberada', () => {
    for (const role of ROLES) {
      expect(rc(role, `${RUN}/.env`)).toBe('deny')
      expect(rc(role, `${REF}/.env.local`)).toBe('deny')
    }
    expect(rc('fixer', `${FIX}/.env`)).toBe('deny')
    expect(rc('fixer', `${FIX}/.envrc`)).toBe('deny')
    expect(rc('fixer', `${FIX}/sub/.env.production`)).toBe('deny')
    expect(rc('fixer', `${FIX}/.environment/x.ts`)).toBe('deny')
    expect(rc('fixer', `${FIX}/env.ts`)).toBe('allow')
  })
  test('nega til, vazio, o checkout principal e o resto', () => {
    for (const role of ROLES) {
      expect(rc(role, '~/.claude/workbench-qa/app/20261109-1000/x')).toBe('deny')
      expect(rc(role, '~')).toBe('deny')
      expect(rc(role, '')).toBe('deny')
      expect(rc(role, `${CWD}/src/a.ts`)).toBe('deny')
      expect(rc(role, '/etc/passwd')).toBe('deny')
      expect(rc(role, `${RUN}/../x`)).toBe('deny')
    }
  })
  test('caminho relativo vale contra a pasta da sessão e barra invertida vale como barra', () => {
    expect(rc('fixer', 'src/a.ts')).toBe('deny')
    expect(rc('fixer', 'src/a.ts', CTX, FIX)).toBe('allow')
    expect(rc('fixer', `${FIX}\\src\\a.ts`)).toBe('allow')
  })
  test('pastas vazias não liberam nada', () => {
    const ctx = { ...CTX, runDir: '', fixDir: '', readDirs: [''] }
    for (const role of ROLES) expect(rc(role, '/x', ctx)).toBe('deny')
    expect(rc('fixer', 'x', ctx, '/')).toBe('deny')
  })
})

describe('guardDecisionOf', () => {
  const stateOf = (over: Record<string, unknown> = {}) => JSON.stringify({ role: 'fixer', agentId: null, ctx: CTX, ...over })
  const inputOf = (tool_name: unknown, tool_input: unknown, over: Record<string, unknown> = {}) => ({
    agent_id: 'a1',
    agent_type: 'qa-fixer',
    cwd: CWD,
    tool_name,
    tool_input,
    ...over,
  })
  const bash = (command: unknown) => inputOf('Bash', { command })
  const guard = (role: string, input: unknown, text: string | null = stateOf()) => guardDecisionOf(role, input, text)

  test('libera o que a trava libera e devolve um motivo', () => {
    const d = guard('fixer', bash(`git -C ${FIX} status`))
    expect(d.decision).toBe('allow')
    expect(d.reason).not.toBe('')
  })

  test('nega papel desconhecido', () => {
    expect(guard('boss', bash('curl http://localhost:3000')).decision).toBe('deny')
    expect(guard('', bash('curl http://localhost:3000')).decision).toBe('deny')
    expect(guard('Fixer', bash('curl http://localhost:3000')).decision).toBe('deny')
  })

  test('nega arquivo de contexto ausente, que não é JSON ou com forma errada', () => {
    expect(guard('fixer', bash('curl http://localhost:3000'), null).decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), '{').decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), '').decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), 'null').decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), '[]').decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), JSON.stringify({ role: 'fixer', agentId: null })).decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), stateOf({ role: 'boss' })).decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), stateOf({ agentId: 7 })).decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), stateOf({ agentId: undefined })).decision).toBe('deny')
    expect(guard('fixer', bash('curl http://localhost:3000'), stateOf({ ctx: null })).decision).toBe('deny')
  })

  test('nega contexto com qualquer campo errado', () => {
    const bad: Array<[string, unknown]> = [
      ['home', 1],
      ['repoRoot', null],
      ['fixDir', undefined],
      ['runDir', 2],
      ['readDirs', 'x'],
      ['readDirs', [1]],
      ['agentBrowser', {}],
      ['impeccable', false],
      ['session', 3],
      ['cdpPort', '45655'],
      ['cdpPort', undefined],
      ['origins', 'http://localhost:3000'],
      ['origins', [1]],
      ['containers', null],
      ['containers', ['api', 2]],
    ]
    for (const [key, value] of bad) {
      const text = stateOf({ ctx: { ...CTX, [key]: value } })
      expect(guard('fixer', bash('curl http://localhost:3000'), text).decision).toBe('deny')
    }
  })

  test('aceita cdpPort nulo e listas vazias', () => {
    const text = stateOf({ ctx: { ...CTX, cdpPort: null, readDirs: [], origins: ['http://localhost:3000'], containers: [] } })
    expect(guard('fixer', bash('curl -sS http://localhost:3000/x'), text).decision).toBe('allow')
  })

  test('nega agente de outro papel', () => {
    expect(guard('runner', bash('curl -sS http://localhost:3000/x'), stateOf()).decision).toBe('deny')
    expect(guard('fixer', bash('curl -sS http://localhost:3000/x'), stateOf({ role: 'runner' })).decision).toBe('deny')
  })

  test('agentId do arquivo: nulo aceita qualquer agente do papel; igual aceita; diferente ou ausente nega', () => {
    const cmd = bash('curl -sS http://localhost:3000/x')
    expect(guard('fixer', cmd, stateOf({ agentId: null })).decision).toBe('allow')
    expect(guard('fixer', cmd, stateOf({ agentId: 'a1' })).decision).toBe('allow')
    expect(guard('fixer', cmd, stateOf({ agentId: 'a2' })).decision).toBe('deny')
    const semId = inputOf('Bash', { command: 'curl -sS http://localhost:3000/x' }, { agent_id: undefined })
    expect(guard('fixer', semId, stateOf({ agentId: 'a1' })).decision).toBe('deny')
    expect(guard('fixer', semId, stateOf({ agentId: null })).decision).toBe('allow')
  })

  test('nega entrada com forma errada', () => {
    const cmd = { command: 'curl -sS http://localhost:3000/x' }
    expect(guard('fixer', null).decision).toBe('deny')
    expect(guard('fixer', 'texto').decision).toBe('deny')
    expect(guard('fixer', [bash('x')]).decision).toBe('deny')
    expect(guard('fixer', inputOf(7, cmd)).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', 'curl x')).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', null)).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', ['curl'])).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', cmd, { cwd: 'app' })).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', cmd, { cwd: undefined })).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', cmd, { cwd: 3 })).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', {})).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', { command: 3 })).decision).toBe('deny')
  })

  test('Bash: o pass vira deny com o motivo da lista liberada', () => {
    const d = guard('fixer', bash('ls'))
    expect(d.decision).toBe('deny')
    expect(d.reason).toContain('comando fora da lista liberada pela trava de QA')
    expect(guard('fixer', bash('echo oi')).decision).toBe('deny')
    expect(guard('fixer', bash('git push')).decision).toBe('deny')
  })

  test('Bash: busca com caminho absoluto em fixDir libera; sem caminho nega', () => {
    expect(guard('fixer', bash(`rg -n "useState" ${FIX}/src`)).decision).toBe('allow')
    expect(guard('fixer', bash('rg -n foo')).decision).toBe('deny')
    expect(guard('fixer', bash(`rg -n foo ${CWD}/src`)).decision).toBe('deny')
  })

  test('Bash: o cwd da entrada vale para caminhos relativos', () => {
    expect(guard('fixer', inputOf('Bash', { command: 'cat ./src/a.ts' }, { cwd: CWD })).decision).toBe('deny')
    expect(guard('fixer', inputOf('Bash', { command: 'curl -sS -H x ../app/x' }, { cwd: CWD })).decision).toBe('deny')
  })

  test('Write e Edit: dentro de runDir libera, fora nega; o fixer também na worktree', () => {
    for (const tool of ['Write', 'Edit']) {
      expect(guard('runner', inputOf(tool, { file_path: `${RUN}/x.json` }), stateOf({ role: 'runner' })).decision).toBe('allow')
      expect(guard('runner', inputOf(tool, { file_path: `${FIX}/x.ts` }), stateOf({ role: 'runner' })).decision).toBe('deny')
      expect(guard('fixer', inputOf(tool, { file_path: `${FIX}/src/a.ts` })).decision).toBe('allow')
      expect(guard('fixer', inputOf(tool, { file_path: `${CWD}/src/a.ts` })).decision).toBe('deny')
      expect(guard('fixer', inputOf(tool, { file_path: `${FIX}/.git/config` })).decision).toBe('deny')
      expect(guard('fixer', inputOf(tool, { file_path: 7 })).decision).toBe('deny')
      expect(guard('fixer', inputOf(tool, {})).decision).toBe('deny')
    }
  })

  test('Write e Edit de .env* na worktree nega, de env.ts libera', () => {
    for (const tool of ['Write', 'Edit']) {
      for (const path of [`${FIX}/.env`, `${FIX}/.env.local`, `${FIX}/apps/api/.env`]) {
        expect(guard('fixer', inputOf(tool, { file_path: path })).decision).toBe('deny')
      }
      expect(guard('fixer', inputOf(tool, { file_path: `${FIX}/src/env.ts` })).decision).toBe('allow')
    }
  })

  test('Read: runDir, readDirs, fixDir só para o fixer, .env e fora', () => {
    const asRunner = (path: string) => guard('runner', inputOf('Read', { file_path: path }), stateOf({ role: 'runner' })).decision
    const asFixer = (path: string) => guard('fixer', inputOf('Read', { file_path: path })).decision
    expect(asRunner(`${RUN}/shot.png`)).toBe('allow')
    expect(asRunner(`${REF}/SKILL.md`)).toBe('allow')
    expect(asRunner(`${FIX}/src/a.ts`)).toBe('deny')
    expect(asFixer(`${FIX}/src/a.ts`)).toBe('allow')
    expect(asFixer(`${FIX}/.env`)).toBe('deny')
    expect(asFixer(`${CWD}/src/a.ts`)).toBe('deny')
    expect(asFixer('/etc/passwd')).toBe('deny')
    expect(guard('fixer', inputOf('Read', {})).decision).toBe('deny')
  })

  test('qualquer outra ferramenta nega', () => {
    for (const tool of ['MultiEdit', 'Grep', 'Glob', 'NotebookEdit', 'WebFetch', 'Agent', 'bash', '']) {
      expect(guard('fixer', inputOf(tool, { file_path: `${FIX}/a`, command: 'curl http://localhost:3000' })).decision).toBe('deny')
    }
  })

  test('nunca lança: erro interno vira deny', () => {
    const hostile = { agent_id: 'a1', cwd: CWD, tool_input: { command: 'ls' } }
    Object.defineProperty(hostile, 'tool_name', {
      get() {
        throw new Error('boom')
      },
    })
    const d = guard('fixer', hostile)
    expect(d.decision).toBe('deny')
    expect(d.reason).not.toBe('')
    const proxy = new Proxy({}, { get: () => { throw new Error('boom') }, getPrototypeOf: () => { throw new Error('boom') } })
    expect(guard('fixer', proxy).decision).toBe('deny')
  })
})
