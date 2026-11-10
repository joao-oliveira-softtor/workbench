// Hook PreToolUse dos agentes de QA, rodado pelo node. Só a decisão "deny" e o código de saída 2 barram a chamada:
// código 1, JSON inválido ou demora deixam a ferramenta seguir. Por isso toda falha, em qualquer ponto, sai com código 2.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const MAX_CONTEXT = 1024 * 1024

// Lê o arquivo de contexto sem prender o processo: `O_NONBLOCK` (abrir um FIFO sem escritor prenderia uma thread do node, e aí
// nem o `process.exit` do limite de 10 s sai) e teto de 1 MB contado nos bytes lidos (o `stat` de `/dev/zero` diz tamanho 0).
// Falta, erro ou excesso: `null`, que a trava nega.
async function contextTextOf(file) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const buf = Buffer.alloc(MAX_CONTEXT + 1)
    let size = 0
    while (size <= MAX_CONTEXT) {
      const { bytesRead } = await handle.read(buf, size, MAX_CONTEXT + 1 - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    return size > MAX_CONTEXT ? null : buf.toString('utf8', 0, size)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function fail(reason) {
  process.stderr.write(`workbench QA: ${reason}\n`)
  process.exit(2)
}

process.on('uncaughtException', error => fail(`erro inesperado: ${error?.message ?? error}`))
process.on('unhandledRejection', error => fail(`erro inesperado: ${error?.message ?? error}`))

try {
  const [role, contextFile] = process.argv.slice(2)
  if (role === undefined || contextFile === undefined) fail('uso: qa-hook.mjs <papel> <arquivo de contexto>')

  // o limite só some com a saída do processo, depois de a decisão ser escrita
  setTimeout(() => fail('a trava não respondeu em 10 s'), 10_000)
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  const input = JSON.parse(text)
  const stateText = await contextTextOf(contextFile)

  const { guardDecisionOf } = await import('./qa-guard.ts')
  const { decision, reason } = guardDecisionOf(role, input, stateText)
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
