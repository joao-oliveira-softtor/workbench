# workbench

Mod do Claude Code: faixa acima do prompt com as worktrees em voo (push, PR, distância da base, migrations atrás da base) e o painel `/workbench`; botões Compactar e continuar, Planejar (`/plan` refinado com o fluxo EGM) e EGM (fluxo Elephant-Goldfish); delegação de tarefas ao modelo certo (`/route auto on|off`).

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
