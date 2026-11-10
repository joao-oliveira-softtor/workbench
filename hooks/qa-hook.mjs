// Hook PreToolUse dos agentes de QA, rodado pelo node. Só a decisão "deny" e o código de saída 2 barram a chamada:
// código 1, JSON inválido ou demora deixam a ferramenta seguir. Por isso toda falha, em qualquer ponto, sai com código 2.
import { readFileSync } from 'node:fs'

function fail(reason) {
  process.stderr.write(`workbench QA: ${reason}\n`)
  process.exit(2)
}

process.on('uncaughtException', error => fail(`erro inesperado: ${error?.message ?? error}`))
process.on('unhandledRejection', error => fail(`erro inesperado: ${error?.message ?? error}`))

try {
  const [role, contextFile] = process.argv.slice(2)
  if (role === undefined || contextFile === undefined) fail('uso: qa-hook.mjs <papel> <arquivo de contexto>')

  const timer = setTimeout(() => fail('a entrada padrão não terminou em 10 s'), 10_000)
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  clearTimeout(timer)
  const input = JSON.parse(text)

  let stateText = null
  try {
    stateText = readFileSync(contextFile, 'utf8')
  } catch {
    stateText = null
  }

  const { guardDecisionOf } = await import('./qa-guard.ts')
  const { decision, reason } = guardDecisionOf(role, input, stateText)
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
