import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { stdin as processStdin, stderr as processStderr } from 'node:process'

/**
 * Internal function to read refs from a readable stream.
 * For testing, this can be called with a mock stream.
 */
export async function readRefsFromStream(stream: Readable): Promise<string[]> {
  const refs: string[] = []

  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const trimmed = line.trim()
    // Skip blank lines and comments
    if (trimmed && !trimmed.startsWith('#')) {
      refs.push(trimmed)
    }
  }

  return refs
}

/**
 * Read playlist refs from stdin, one per line.
 * Ignores blank lines and lines starting with '#' (comments).
 */
export async function readRefsFromStdin(): Promise<string[]> {
  return readRefsFromStream(processStdin)
}

/**
 * Show a progress indicator to stderr (only when stderr is TTY).
 * No-op when stderr is piped.
 *
 * @param label The progress label to display
 * @param total Optional total number of items (if given, shows count)
 */
export function progress(label: string, total?: number): void {
  // Only write progress when stderr is a TTY
  if (!processStderr.isTTY) {
    return
  }

  let message = label
  if (total !== undefined) {
    message += ` [${total}]`
  }

  processStderr.write(`${message}\n`)
}

/**
 * Prompt the user for confirmation.
 * - If stdin is not a TTY and --yes flag is not set, throws UsageError (exit 2)
 * - Returns true if user responds with Y/y, false for N/n
 *
 * @param question The confirmation question to display
 * @param yes Whether --yes flag was provided
 */
export async function confirm(question: string, yes: boolean): Promise<boolean> {
  const { UsageError } = await import('../core/provider/errors.js')

  // If --yes flag is set, automatically confirm
  if (yes) {
    return true
  }

  // If stdin is not a TTY and no --yes flag, error
  if (!processStdin.isTTY) {
    throw new UsageError('Confirmation required but stdin is not a terminal. Use --yes to skip confirmation.')
  }

  const { createInterface: createReadlineInterface } = await import('node:readline/promises')
  const { stdin: readlineStdin, stdout: readlineStdout } = await import('node:process')

  const rl = createReadlineInterface({
    input: readlineStdin,
    output: readlineStdout,
  })

  try {
    const answer = await rl.question(`${question} (y/n): `)
    const response = answer.toLowerCase().trim()
    return response === 'y' || response === 'yes'
  } finally {
    rl.close()
  }
}
