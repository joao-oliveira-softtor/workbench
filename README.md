# workbench

Mod do Claude Code: faixa acima do prompt com as worktrees em voo (push, PR, distância da base, migrations atrás da base) e o painel `/workbench`; botões Compactar e continuar, Retomada (resumo do dia), Planejar (`/plan` refinado com o fluxo EGM), EGM (fluxo Elephant-Goldfish) e QA (testa o app num navegador e corrige o que achar); delegação de tarefas ao modelo certo (`/route auto on|off`).

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

## Compactar e continuar

Compactar troca a conversa longa por um resumo, para liberar espaço na memória de trabalho do Claude. O botão **Compactar e continuar** analisa a conversa, compacta e manda uma mensagem para o Claude voltar ao trabalho sozinho. Ele só retoma se você não mandou nada no meio e o campo de digitação está vazio; senão avisa e deixa a conversa quieta.

- **Compactação automática do Claude Code**: com a sessão parada (nenhum turno rodando), o mod também retoma sozinho, no máximo uma vez por pedido seu. Se o Claude Code compactar de novo sem você ter escrito nada no meio, o mod só grava um aviso e não retoma (evita laço). Se há texto no campo de digitação, também só avisa.
- **`/compact` digitado**: a sessão fica quieta, você decide quando continuar.
- **O que o resumo guarda a mais**, em toda compactação (botão, `/compact` e automática): os agentes em segundo plano ainda rodando, com o id de cada um; as perguntas feitas a você que ficaram sem resposta; as regras que você disse na conversa; e o caminho do registro de progresso (plano, log), se houver. No `/compact` digitado, o seu texto vem primeiro e esses itens depois.
- **Avisos gravados**: ficam na própria conversa (não só num aviso que some em segundos) quando a retomada falha (o turno deu erro, foi interrompido, foi recusado, ou o pedido não entrou), quando a compactação passa de 5 minutos sem terminar (o mod não consegue cancelá-la, só avisa) e quando o mod recarrega no meio de uma compactação.
- **Registro**: cada compactação que chega ao mod deixa uma linha na conversa, com quem compactou (`trigger`), se a sessão estava parada e se a retomada foi marcada. Para conferir em todas as suas conversas: `grep -h -o 'workbench: compactação[^"]*' ~/.claude/projects/*/*.jsonl`.

Limite: ainda não foi visto, numa sessão com tela, a compactação feita com a sessão parada chegando marcada como automática (`trigger=auto`). Se vier com outra marca, nada retoma, e o registro acima mostra qual foi.

## Retomada (resumo do dia)

O botão **Retomada** resume o seu último dia de trabalho, de todos os projetos, para você abrir uma sessão limpa e saber o que ficou em andamento, qual é o próximo passo e o que está pendente.

- Só funciona em **sessão limpa** (você ainda não mandou nenhum pedido); senão, avisa e não faz nada.
- Lê as sessões do último dia de trabalho (o dia vira às 05:00; até 7 dias para trás) e as de hoje, de todos os projetos, só as abertas no terminal ou na IDE. Rodadas sem terminal (`claude -p`, scripts) ficam de fora.
- Cada sessão vira um resumo em três partes: em andamento, próximo passo e pendente. No máximo 12 sessões por clique; as outras aparecem só com projeto e hora, em "ficaram de fora".
- O resumo do dia fica em `~/.claude/workbench-resume/<dia>.md` (ou na pasta de `CLAUDE_CONFIG_DIR`, se definida). Resumos com mais de 14 dias são apagados.
- Um segundo clique sobre o mesmo dia reaproveita o arquivo já gravado, sem chamar o modelo de novo. Para refazer, apague o arquivo daquele dia. Na sessão em que o resumo já entrou, o botão só avisa, sem reenviar.
- Cada arquivo de sessão é lido em dois passos: uma leitura curta do começo (para saber se a sessão foi aberta no terminal) e, só para as do terminal ou da IDE, a leitura longa. O teto é de 400 leituras curtas e 60 longas por clique; ao bater um deles, o mod para de ler, resume o que já leu e diz no arquivo do dia e no aviso final quantos arquivos ficaram sem leitura.
- O mod manda o resumo na conversa pedindo ao Claude que só apresente e pergunte por onde seguir, sem rodar comandos, abrir arquivos nem chamar agentes. Se há texto no campo de digitação, ou a sessão já começou, o arquivo é gravado e o mod só avisa onde ele está.

### Limites e privacidade

- O resumo junta projetos de clientes diferentes e entra na conversa onde você clicou. Abra a Retomada numa sessão na sua pasta pessoal, fora de qualquer projeto.
- A limpeza de segredos cobre formatos conhecidos (chaves de API comuns, tokens, senhas em endereço, em JSON e na linha de comando, chaves privadas) e pode deixar passar um segredo em formato fora da lista, tanto para o modelo quanto para o arquivo do dia; o modelo pode repeti-lo no resumo.
- Arquivos de sessão muito grandes (mais de 3 MB) são lidos só pelo final: o começo da sessão pode faltar.
- O conteúdo das sessões vai para o modelo barato (Haiku), pela conta que o Claude Code estiver usando.
- Não há tarefa agendada: o mod não captura nada sozinho, só lê o que existe no disco quando você clica.

## EGM (revisão do plano)

O botão **EGM** pede a revisão de um plano antes de você mandar executar. Na etapa **Revisão**, escreva o caminho do plano no campo do prompt e clique: o mod lança os cinco revisores do plugin EGM, manda um agente corrigir o plano (ele só pode editar esse arquivo), faz até 3 rodadas e mostra o progresso no próprio botão. Na conversa entra só uma linha com o veredito e o caminho do relatório. Para parar no meio, digite `/workbench egm stop`. Os arquivos ficam em `~/.claude/workbench-egm`. O plano é corrigido no lugar onde está: se ele estiver dentro de um repositório, a correção aparece ali como alteração não commitada (clicar em Revisão conta como pedido para corrigir aquele arquivo). Antes de cada correção, uma cópia do plano fica em `~/.claude/workbench-egm/<revisão>/r<rodada>/doc-antes.md`, para comparar ou voltar.

Precisa do plugin EGM ligado e do Node 22.6 ou mais novo. O comando `/egm:egm-review` digitado continua valendo.

## QA

O botão **QA** testa o seu app de verdade, num navegador de teste, e corrige o que achar. Ele anda por etapas: o nome do botão diz em qual você está, e o clique seguinte aprova o que a etapa anterior mostrou.

1. **QA** (planejar). Um agente lê o repositório (e o que você digitou no campo do prompt; vazio, vale o que o diff mexeu) e grava a matriz: a lista de até 12 testes, cada um com perfil de usuário, largura de tela e critério de sucesso. A sessão mostra a tabela, o que ficou de fora, os três comandos (instalar, subir e testar o app) e os endereços de fora liberados. Clicar em "QA: Login" aprova a matriz.
2. **QA: Login**. Instala as ferramentas que faltarem e, para cada perfil que exige login, abre uma janela do navegador para você entrar. A senha é digitada por você na janela, nunca no chat. Perfil anônimo não precisa de login.
3. **QA: Executar**. Para cada teste, um agente faz os passos no navegador e outro confere o que o primeiro gravou e dá o veredito. Teste que falha roda de novo, do zero; se as duas rodadas discordam, ele vira "instável". No fim sai o relatório e a sessão resume o que passou, o que falhou e o que ficou sem verificar. Clicar em "QA: Corrigir" aprova os defeitos marcados no relatório.
4. **QA: Corrigir**. O primeiro clique só mostra os três comandos e a pasta; o segundo, em até 15 segundos, confirma e então eles rodam no seu computador. Para cada defeito marcado, um agente corrige (até 3 tentativas), o mod faz o commit, roda os testes do projeto e testa de novo no navegador. Antes de corrigir, o mod confere se o defeito ainda acontece na worktree em três casos: a pasta tinha mudanças sem commit no Executar, o último commit (o HEAD) mudou desde o Executar, ou o mod não tem mais a foto do Executar (o Claude Code foi fechado entre as etapas). O teste novo, que deve falhar no app original e passar no corrigido, só roda se o projeto usa Playwright (a matriz tem `testDir`), se o corretor escreveu o teste e se o app original está no ar no Corrigir; fora disso, esse teste não roda e o defeito pode sair "corrigido" com uma pendência escrita no resultado. Os testes gerados das telas que passaram entram num commit à parte. O resultado fica em `correcoes.md`.

### Antes de usar

- O app tem que estar rodando em localhost, no endereço da matriz, quando você clica em "QA: Executar".
- Node 22.6 ou mais novo, no PATH (a trava dos agentes usa TypeScript direto). Vale também para o "Aceitar remoções": sem ele, o mod avisa e não lança nada.
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

Numa worktree `.worktrees/qa-<AAAAMMDD-HHMM>`, em branch própria `qa/<AAAAMMDD-HHMM>`. No seu checkout o mod só cria essa worktree e essa branch e acrescenta linhas ao `.git/info/exclude` (a lista local de arquivos que o git ignora): `.worktrees/` e os `.env` copiados. Os commits são feitos pelo mod, sem os hooks de pré-commit do repositório, então rode o lint e o formatador antes de abrir a PR. O mod nunca faz push: subir a branch e abrir a PR é decisão sua.

`/workbench qa stop` para o trabalho em curso, fecha o navegador de teste e deixa o botão na mesma etapa; clicar de novo retoma. `/workbench qa` faz o mesmo que o botão, sem texto depois (o escopo do Planejar vem só do campo do prompt). Os dois só valem pedidos por você: digitados no Claude Code, pelo Remote Control ou pelo `claude -p`; vindos do modelo, de outro mod, de tarefa agendada ou de outra sessão, são recusados.

Dá para fechar e reabrir o Claude Code entre as etapas: no mesmo repositório, o botão volta na etapa em que estava. Fechar no meio de uma etapa em andamento (Executar ou Corrigir) também deixa o botão nela, mas a etapa recomeça no clique seguinte: o Executar pula os testes que já têm veredito e o Corrigir pede a confirmação de novo e segue só pelos defeitos ainda sem resultado.

### Limites e riscos

Leia antes de usar em um projeto com dados que importam.

1. O `.env` do projeto (e os `.env.*` que o git não versiona) é copiado para a worktree de correção.
2. O código escrito pelo agente corretor roda no seu computador, como você, quando o mod sobe o app e os testes da worktree: com o `.env` ao lado e, no ambiente, o caminho dos arquivos de login de todos os perfis (`QA_AUTH_*`). Um corretor mal-comportado poderia, em princípio, alcançar esses segredos e tudo o que você lê.
3. A trava dos agentes funciona por padrões de comando: recusa o que não reconhece, mas não é uma caixa de areia (um ambiente isolado do resto do computador). Link simbólico ou segundo nome do mesmo arquivo (hardlink) que já exista dentro da worktree é seguido. O agente que roda o "Aceitar remoções" usa a mesma trava: só roda, letra por letra, as linhas de remoção que você aprovou. O agente planejador NÃO passa pela trava: ele tem o Bash (o terminal) com as permissões normais da sessão, e a tarefa dele é ler o repositório e gravar a matriz.
4. Os testes escrevem no banco de desenvolvimento local, o mesmo que o app da worktree usa.
5. O corretor só busca no código por palavra simples: padrão de busca com `|`, `<`, `>`, `$` ou `\` é recusado.
6. Nunca use contra produção. A matriz só aceita `localhost` e `127.0.0.1`, e os endereços de fora liberados são só os que as telas carregam (fontes, por exemplo). Os agentes podem abrir esses endereços de fora no navegador de teste.
7. A lista de programas recusados nos três comandos da matriz só pega descuido: `npx`, `make` ou `node -e` rodam qualquer coisa. Por isso os comandos são mostrados e pedem dois cliques.
8. O login vale por endereço: `localhost` e `127.0.0.1` são logins diferentes. Se a matriz trocar o endereço, refaça o Login. Sem terminal (`claude -p`), o QA roda, mas o Login para no ponto em que pediria para você entrar no navegador: não há como perguntar.
9. Se o app original estiver fora do ar no Corrigir, o teste de regressão (o que deve falhar no app original) não roda e fica uma pendência escrita no resultado.
10. Duas sessões abertas no mesmo repositório dividem a etapa guardada do botão e a pasta da execução: use uma por vez.
11. Só os `.env*` da raiz do repositório são copiados para a worktree; os de subpastas não.
12. Os valores de localStorage da sessão salva (o armazenamento do navegador) passam como argumento de processo e aparecem por um instante na lista de processos do computador.
13. Se o corretor for cortado no meio, o mod avisa que sobrou mudança na worktree e para. Um novo clique em "QA: Corrigir" só começa com a worktree limpa: commite ou descarte a sobra antes. O mesmo vale depois da instalação: se o comando de instalar mudar arquivos do repositório (um `npm install` que reescreve o `package-lock.json`, por exemplo), a fase não começa e o aviso pede outro comando (`npm ci`).
14. Pasta pessoal ou pasta do mod com `"`, `$`, crase ou `\` no caminho desligam o QA e as remoções (o comando da trava quebraria).
15. A regra "só você dispara o QA" depende de o Claude Code dizer de onde veio o comando (a origem que ele carimba em cada pedido). Se ele carimbar errado, o mod não tem como saber.
16. O verificador da trava foi provado com o Node 24; o Node 22 (o mínimo, 22.6) não foi testado.
17. O Corrigir não confere a versão do Node antes de começar. Sem Node, a trava nega todos os comandos dos agentes (não libera nada), então a correção não anda.
