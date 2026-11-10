# workbench

Mod do Claude Code: faixa acima do prompt com as worktrees em voo (push, PR, distância da base, migrations atrás da base) e o painel `/workbench`; botões Compactar e continuar, Planejar (`/plan` refinado com o fluxo EGM), EGM (fluxo Elephant-Goldfish) e QA (testa o app num navegador e corrige o que achar); delegação de tarefas ao modelo certo (`/route auto on|off`).

Os botões Planejar e EGM usam os plugins `superpowers` e `egm`, quando instalados.

## Instalar

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install workbench --marketplace joao-oliveira-softtor/workbench
```

Responda `y` para adicionar o marketplace e escolha o escopo `user`.

Pelo shell:

```
claude plugin marketplace add joao-oliveira-softtor/workbench
claude plugin install workbench@workbench --scope user
```

## Atualizar

```
claude plugin marketplace update workbench
claude plugin update workbench@workbench
```

Depois, reinicie a sessão.

Para atualizar sozinho a cada sessão nova, ligue o auto-update do marketplace: em `/plugin`, aba Marketplaces, escolha `workbench` e ative o auto-update. Ou, no `~/.claude/settings.json`, ponha `"autoUpdate": true` em `extraKnownMarketplaces.workbench`.

## QA

O botão **QA** testa o seu app de verdade, num navegador de teste, e corrige o que achar. Ele anda por etapas: o nome do botão diz em qual você está, e o clique seguinte aprova o que a etapa anterior mostrou.

1. **QA** (planejar). Um agente lê o repositório (e o que você digitou no campo do prompt; vazio, vale o que o diff mexeu) e grava a matriz: a lista de até 12 testes, cada um com perfil de usuário, largura de tela e critério de sucesso. A sessão mostra a tabela, o que ficou de fora, os três comandos (instalar, subir e testar o app) e os endereços de fora liberados. Clicar em "QA: Login" aprova a matriz.
2. **QA: Login**. Instala as ferramentas que faltarem e, para cada perfil que exige login, abre uma janela do navegador para você entrar. A senha é digitada por você na janela, nunca no chat. Perfil anônimo não precisa de login.
3. **QA: Executar**. Para cada teste, um agente faz os passos no navegador e outro confere o que o primeiro gravou e dá o veredito. Teste que falha roda de novo, do zero; se as duas rodadas discordam, ele vira "instável". No fim sai o relatório e a sessão resume o que passou, o que falhou e o que ficou sem verificar. Clicar em "QA: Corrigir" aprova os defeitos marcados no relatório.
4. **QA: Corrigir**. O primeiro clique só mostra os três comandos e a pasta; o segundo, em até 15 segundos, confirma e então eles rodam no seu computador. Para cada defeito marcado, o mod confere que ele se repete, um agente corrige (até 3 tentativas), o mod faz o commit, roda os testes do projeto e um teste novo que deve falhar no app original e passar no corrigido, e testa de novo no navegador. Os testes gerados das telas que passaram entram num commit à parte. O resultado fica em `correcoes.md`.

### Antes de usar

- O app tem que estar rodando em localhost, no endereço da matriz, quando você clica em "QA: Executar".
- Node 22.6 ou mais novo (a trava dos agentes usa TypeScript direto).
- Só Linux e WSL nesta versão.
- O "QA: Login" instala em `~/.claude/workbench-qa/tools` o `agent-browser` 0.41.2 (o navegador de teste) e o `impeccable` 4.8.1 (detector de falhas de design), e copia a skill do impeccable (tag `skill-v4.8.1`) para `~/.claude/skills/impeccable` se ela não existir.

### Onde ficam os arquivos

Tudo fora do git, em `~/.claude/workbench-qa/<projeto>-<código>/`:

- `<AAAAMMDD-HHMM>/matriz.md`: a matriz. Você pode editar antes de clicar em "QA: Login".
- `<AAAAMMDD-HHMM>/relatorio.md`: o relatório; `celulas/<id>/` guarda as provas e o teste gerado de cada célula; `correcoes.md` o resultado da correção.
- `auth/<perfil>.json`: as sessões de login. São segredo: não copie nem versione.

### Escolher o que corrigir

No `relatorio.md`, cada defeito é uma linha com `[x]` ou `[ ]`. Vêm marcados com `[x]` os que falharam com certeza; os que o detector só desconfia vêm com `[ ]`. Marque ou desmarque antes de clicar em "QA: Corrigir": só os `[x]` entram.

### Onde a correção acontece

Numa worktree `.worktrees/qa-<AAAAMMDD-HHMM>`, em branch própria `qa/<AAAAMMDD-HHMM>`; o seu checkout não é mexido. Os commits são feitos pelo mod, sem os hooks de pré-commit do repositório, então rode o lint e o formatador antes de abrir a PR. O mod nunca faz push: subir a branch e abrir a PR é decisão sua.

`/workbench qa stop` para o trabalho em curso, fecha o navegador de teste e deixa o botão na mesma etapa; clicar de novo retoma. `/workbench qa` faz o mesmo que o botão.

### Limites e riscos

Leia antes de usar em um projeto com dados que importam.

1. O `.env` do projeto (e os `.env.*` que o git não versiona) é copiado para a worktree de correção.
2. O código escrito pelo agente corretor roda no seu computador quando o mod sobe o app e os testes da worktree, e o `.env` está ao lado. Um corretor mal-comportado poderia, em princípio, alcançar os segredos dele.
3. A trava dos agentes funciona por padrões de comando: recusa o que não reconhece, mas não é uma caixa de areia (um ambiente isolado do resto do computador).
4. Os testes escrevem no banco de desenvolvimento local, o mesmo que o app da worktree usa.
5. O corretor só busca no código por palavra simples: padrão de busca com `|`, `<`, `>` ou `$` é recusado.
6. Nunca use contra produção. A matriz só aceita `localhost` e `127.0.0.1`, e os endereços de fora liberados são só os que as telas carregam (fontes, por exemplo).
