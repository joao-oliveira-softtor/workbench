export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export type PrRef = { number: number; state: PrState; headOid: string }

export type PushState = 'none' | 'gone' | 'unpushed' | 'ok'

export type Row = {
  branch: string
  path: string
  head: string
  issue: string | null
  ahead: number
  behind: number
  push: PushState
  unpushed: number
  pr: PrRef | null
  staleMigrations: string[]
  // Carimbo do ci:local para o HEAD; null quando a árvore não tem scripts/ci/local.sh.
  isStamped: boolean | null
  // Linhas de `git status` (inclui não rastreados); null quando não foi possível ler (prunable, erro).
  dirty: number | null
  // Data do último commit da branch, em milissegundos; null sem commit conhecido.
  lastCommitAt: number | null
  // Maior entre o último commit, o reflog da worktree (criação, checkout) e o index dela, em milissegundos.
  lastActivityAt: number | null
  // Diretório da worktree não existe mais (git worktree prune a limpa).
  isPrunable: boolean
  isLocked: boolean
  // Espaço exclusivo da pasta em KB: o que apagá-la devolve (arquivos com 1 link e diretórios; ignorados entram).
  // Hardlink compartilhado (cache do bun/pnpm) não entra. null enquanto não foi medido, em prunable ou sem GNU find.
  ownKb: number | null
  // 'none': sem submódulo inicializado; 'clean': limpos e sem commit só local; 'unsafe': sujo, commit só local ou falha
  // ao conferir; null: não conferido (só as candidatas à limpeza são conferidas).
  submodules: 'none' | 'clean' | 'unsafe' | null
  // A sessão está nesta worktree ou dentro dela.
  isCurrent: boolean
  // Falha ao coletar só esta worktree; as demais seguem.
  error: string | null
}

// Worktree destacada cujo diretório sumiu: o painel não a lista, mas `git worktree prune` a limpa.
export type DetachedPrunable = { path: string; head: string; isReachable: boolean }

export type Snapshot = {
  root: string
  base: string
  baseHead: string
  baseMigration: string | null
  rows: Row[]
  detachedPrunable: DetachedPrunable[]
  isPrKnown: boolean
  // `.git/FETCH_HEAD` em milissegundos; null quando nunca houve fetch.
  fetchedAt: number | null
  errors: string[]
  at: number
}

export type Verdict = 'remove' | 'review' | 'keep'

// Regra que elegeu a candidata. merged/closed/gone/no-pr: worktree e branch; open/unknown/moved/work: só a pasta.
export type Reason = 'merged' | 'prunable' | 'closed' | 'gone' | 'no-pr' | 'open' | 'unknown' | 'moved' | 'work'

export type Suggestion = {
  path: string
  branch: string
  head: string
  verdict: Verdict
  reason: string
  // 'haiku' só quando o veredito veio do modelo; 'regra' para o que a regra decidiu ou ficou sem resposta.
  origin: 'haiku' | 'regra'
  // Ausente em relatórios gravados antes desta versão: item sem `rule` nunca gera comando.
  rule?: Reason
}

export type StaleReport = {
  hash: string
  at: number
  // 'haiku' quando há ao menos um veredito do Haiku; 'regra' quando só a regra decidiu.
  source: 'haiku' | 'regra'
  note: string | null
  items: Suggestion[]
}

declare module 'claude-code' {
  interface PluginState {
    'workbench': {
      snapshot: Snapshot | null
      busy: boolean
      // Caminho da worktree selecionada (a branch pode se repetir entre worktrees).
      selected: string | null
      stale: StaleReport | null
      suggesting: boolean
      // Confirmação pendente de "Aceitar remoções": quando foi armada e a lista que o usuário viu (linhas juntas por \n).
      armed: { at: number; key: string } | null
      // Remoção em andamento (botão em "Removendo…") e as únicas linhas de Bash que o subagente remover pode rodar.
      // agentId é preenchido depois do spawn.
      removal: { at: number; agentId: string | null; allowed: string[] } | null
      // Etapa de "Compactar e continuar" que o botão mostra; null = parado. A trava de verdade é variável do módulo.
      compacting: 'queued' | 'analyzing' | 'compacting' | null
      // Planejar: etapa que o botão mostra e o doc revisado pelo /egm:egm-review (vazio fora do Executar).
      planFlow: { step: 'brainstorm' | 'draft' | 'review' | 'execute'; doc: string }
      // Planejar refinando ("Refinando…"); só o rótulo. A trava de verdade é variável do módulo.
      refining: boolean
      // QA: etapa do botão e as pastas; não zera no session.start.
      qaFlow: { step: 'plan' | 'login' | 'run' | 'fix'; runDir: string; fixDir: string }
      // QA: o trabalho em curso (fila e item); não zera no session.start, é o que permite retomar.
      // O contrato não importa nada: a forma repete a de `QaJob`/`QaCurrent` do hooks/qa.ts (o tsc confere as duas).
      qaJob: {
        phase: 'run' | 'fix'
        queue: string[]
        total: number
        current: {
          item: string
          role: 'runner' | 'observer' | 'fixer'
          attempt: number
          agentId: string | null
          at: number
          isEnded: boolean
          cell: string
          sha: string
          port: number
          session: string
          cdpPort: number | null
          reasons: string[]
        } | null
      } | null
      // QA: todo agentId de QA já lançado; nunca diminui (o relatório deles é suprimido e nenhum é adotado de novo).
      qaGuarded: string[]
      // QA: HEAD e estado da árvore do app no começo do Executar.
      qaRunBase: { head: string; isDirty: boolean } | null
      // QA: o código do nome do arquivo da trava; criado uma vez, não zera no session.start (o agente lançado antes de um
      // reload continua lendo o mesmo arquivo, e o stop e o fim da execução chegam nele).
      qaGuardToken: string | null
    }
  }
}
