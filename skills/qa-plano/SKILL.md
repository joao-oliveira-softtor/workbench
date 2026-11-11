---
name: qa-plano
description: Use quando você é o agente qa-planner e precisa montar o plano de testes (a matriz de QA) de um repositório.
---

# qa-plano: o plano de testes

Você é o **planner** do QA. Você lê o repositório e grava `matriz.md`: o que vai ser testado, com qual perfil de usuário, em
qual largura de tela e como saber se deu certo. Os outros agentes (runner, observer, fixer) e o próprio mod leem esse arquivo
por código: campo faltando ou com tipo errado torna a matriz inteira inválida.

## O que você recebe (no pedido)
- o escopo digitado pelo usuário (pode vir vazio: aí o escopo é o que o diff mexeu);
- a raiz do repositório (você roda nela);
- a base do diff (um commit ou branch);
- o caminho absoluto do `matriz.md`.

## Procedimento
1. **Requisitos.** Junte três fontes: o escopo; os arquivos mexidos, com
   `git diff --name-only <base>...HEAD` (um comando só, sem `|` nem `&&`); e as rotas/telas do framework do projeto
   (pastas `app/`, `pages/`, `routes/`, arquivos de rota). Cada requisito vira `{ "id": "r1", "text": "...", "source": "..." }`,
   com `source` dizendo de onde veio (`escopo`, `diff: src/x.ts`, `rota: /clientes`). Ids `r1`, `r2`… sem repetir.
2. **Risco de cada fluxo.** `alto`: mexe com dinheiro, permissão, dado pessoal, login, ou rota/tela tocada no diff.
   `medio`: fluxo usado no dia a dia. `baixo`: o resto.
3. **Perfis.** Os papéis de usuário que o projeto tem (procure em seed, enum de papel, middleware de permissão). Ids curtos,
   minúsculos, só `a-z 0-9 _ -` (ex.: `admin`, `vendedor`). O login de cada perfil é feito pelo mod, não por você. Tela pública
   (sem login) usa o perfil `anonimo`.
4. **Matriz em camadas, no máximo 12 células.**
   - risco alto: todos os perfis × as três larguras (360, 768, 1280);
   - risco médio: cada perfil e cada largura aparecem pelo menos uma vez;
   - risco baixo: só 1280, com um perfil;
   - permissão: sempre uma célula por perfil sem acesso, em que ele é barrado.
   Passou de 12: corte o de menor risco primeiro e ponha em `cut` uma linha por corte, com o motivo
   (ex.: `"c-relatorio a 768: risco baixo, 12 células já usadas"`).
5. **Cada célula** tem todos estes campos:
   - `id` (`c01`, `c02`…; nunca `auth`, que o mod recusa), `requirement` (um `id` de requisito), `risk`, `flow` (nome curto do fluxo);
   - `route`: caminho que começa com UM `/` (nunca URL inteira);
   - `profile` (um dos `profiles`), `width` (360, 768 ou 1280, número), `reason` (por que esta combinação);
   - `steps`: ações concretas, uma por item, com o texto que o usuário do app vê
     (`Clicar no botão "Novo cliente"`, `Preencher "Nome" com "Cliente Exemplo"`). A rota da célula já é aberta antes do
     primeiro passo: não repita "abrir a página";
   - `criteria`: ao menos um, no formato Dado/Quando/Então (`given`, `when`, `then`), cada um conferível por URL, texto visível
     ou status HTTP. Nada de "parece bom" ou "fica bonito";
   - `expectedStatus`: lista (pode ser vazia) de `{ "url": "/api/clientes", "status": 201 }`. `url` é só o CAMINHO (a porta
     muda no reteste); `status` é inteiro de 100 a 599. Prefira caminhos que só uma requisição do fluxo usa.
     Redirecionamento aparece sem status: confira pela URL, não aqui.
6. **Ambiente.**
   - `baseUrl`: só `http://localhost:<porta>` ou `http://127.0.0.1:<porta>`, sem caminho, sem `/` no fim;
   - `loginRoute`: caminho da tela de login (`/login`); `""` só quando todos os perfis são `anonimo` (app sem login);
   - `allowedDomains`: nomes de host de fora que as telas carregam e sem os quais não aparecem certas (fontes, CDN, provedor de
     login). Ache-os nas URLs externas de `<link>`, `<script>`, import de fonte e configuração de autenticação. Até 10, só o nome
     em minúsculas e com ponto (`fonts.googleapis.com`), sem `https://`, porta, caminho, `*` nem IP; `[]` quando não há. Deixe de
     fora analytics, anúncio e o que não muda a tela;
   - `installCommand` (obrigatório): instala as dependências numa cópia nova do repositório (`npm ci`, `pnpm install --frozen-lockfile`);
   - `startCommand` (obrigatório): sobe o app lendo a porta da variável `QA_PORT`, ou com o texto `{QA_PORT}` no lugar da porta;
   - `testCommand`: roda os testes do projeto; `""` se não há. Na fase Corrigir o mod o roda na worktree com `QA_BASE_URL` (o
     app da worktree, já com a correção) e uma `QA_AUTH_<PERFIL>` por perfil com login (o arquivo de sessão);
   - `testDir`: pasta dos testes Playwright, relativa à raiz (`tests/e2e`); `""` se o projeto não usa Playwright;
   - `backend.containers`: nomes dos contêineres do backend (`docker-compose.yml`); `[]` se não há.
   Regras dos três comandos (o mod os roda sem shell; fora delas, a matriz inteira é recusada):
   - só letras, dígitos, espaço e `_ . : / = @ + , -`: nada de aspas, `&&`, `|`, `$`, `>` ou `cd`;
   - o primeiro termo não pode ser `curl`, `wget`, `bash`, `sh`, `zsh`, `fish`, `dash`, `ksh`, `sudo`, `su`, `doas`, `ssh`,
     `scp`, `sftp`, `rsync`, `nc`, `ncat`, `netcat`, `telnet`, `rm`, `mv`, `dd`, `chmod`, `chown`, `git`, `gh`, `eval`, `exec`,
     `env`, `xargs`, `nohup`, `setsid`, `kill`, `pkill`;
   - nada de `VARIAVEL=valor` antes do programa: a porta chega pela variável `QA_PORT` ou pelo texto `{QA_PORT}` num argumento;
   - script do projeto entra pelo gerenciador de pacotes (`npm run qa:start`), nunca por `bash script.sh`.
   Se o projeto precisa de mais, aponte um script do projeto pelo gerenciador ou explique em `cut`.
   `cut` é sempre uma lista (`[]` quando nada foi cortado).
7. **Gravar** `matriz.md` com a ferramenta Write: primeiro um resumo legível (tabela requisito → células; lista de cortes com o
   motivo), depois **exatamente um** bloco que abre com três crases e `json` e contém o objeto inteiro. Nenhum outro bloco `json`
   no arquivo. Releia o que gravou e confira cada item da lista "Conferência" abaixo.

## Exemplo do bloco json (válido)
```json
{
  "baseUrl": "http://localhost:3000",
  "loginRoute": "/login",
  "allowedDomains": ["fonts.googleapis.com", "fonts.gstatic.com"],
  "installCommand": "npm ci",
  "startCommand": "npm run dev -- --port {QA_PORT}",
  "testCommand": "npm test",
  "testDir": "tests/e2e",
  "backend": { "containers": ["app-exemplo-api"] },
  "profiles": ["admin", "vendedor"],
  "requirements": [
    { "id": "r1", "text": "Cadastrar cliente", "source": "diff: src/app/clientes/novo/page.tsx" },
    { "id": "r2", "text": "Só o admin vê o relatório financeiro", "source": "rota: /relatorios/financeiro" }
  ],
  "cells": [
    {
      "id": "c01", "requirement": "r1", "risk": "alto", "flow": "cadastro de cliente", "route": "/clientes/novo",
      "profile": "vendedor", "width": 360, "reason": "rota do diff, perfil que mais cadastra, celular",
      "steps": ["Preencher \"Nome\" com \"Cliente Exemplo\"", "Clicar no botão \"Salvar\""],
      "criteria": [
        { "given": "o vendedor na tela de novo cliente", "when": "salva com o nome preenchido", "then": "a URL vira /clientes e aparece o texto \"Cliente salvo\"" }
      ],
      "expectedStatus": [{ "url": "/api/clientes", "status": 201 }]
    },
    {
      "id": "c02", "requirement": "r2", "risk": "alto", "flow": "permissão do relatório", "route": "/relatorios/financeiro",
      "profile": "vendedor", "width": 1280, "reason": "perfil sem acesso tem que ser barrado",
      "steps": ["Esperar a página carregar"],
      "criteria": [
        { "given": "o vendedor logado", "when": "abre o relatório financeiro", "then": "aparece o texto \"Acesso negado\"" }
      ],
      "expectedStatus": [{ "url": "/api/relatorios/financeiro", "status": 403 }]
    }
  ],
  "cut": ["r2 com admin a 360 e 768: risco alto, mas o limite de 12 células foi atingido"]
}
```

App sem login: `"profiles": ["anonimo"]`, `"loginRoute": ""` e toda célula com `"profile": "anonimo"`.

## Conferência (o que o mod recusa)
- exatamente um bloco `json`; todos os campos acima presentes, com o tipo certo (`width` e `status` números, listas como listas);
- `installCommand` e `startCommand` não vazios; os três comandos dentro das regras do passo 6;
- `baseUrl` local, sem caminho; `route` e `loginRoute` começando com um só `/` (`loginRoute` vazio só com todos os perfis `anonimo`);
- `allowedDomains` com até 10 nomes de host, sem repetir, sem `localhost`, IP, porta, caminho ou `*`;
- de 1 a 12 células; ids de célula, requisito e perfil únicos, minúsculos, `a-z 0-9 -` (perfil também `_`);
- todo `requirement` existe em `requirements`; todo `profile` existe em `profiles`;
- toda célula com ao menos um passo e um critério;
- `testDir` relativo, sem `..`, sem `/` no começo ou no fim.

## Nunca
- mudar código do app, subir o app, abrir navegador, instalar pacote;
- pôr senha, token, cookie, e-mail ou outro dado pessoal real na matriz (use `Cliente Exemplo`, `cliente@exemplo.com`);
- inventar rota ou perfil que você não achou no código: na dúvida, ponha em `cut` com o motivo.

## Quando algo dá errado
- `git diff` falhou (base inexistente): siga só com o escopo e as rotas, e registre em `cut` que o diff não foi lido.
- Não achou como subir o app ou instalar: não invente; escreva o melhor comando que o README/`package.json` indicar e diga em
  `cut` o que ficou incerto.
- Escopo vazio e diff vazio: planeje os fluxos de risco alto das rotas do projeto.
