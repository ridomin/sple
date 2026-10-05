import { parseArgs, type ParseArgsConfig } from 'node:util'
import type { CommandContext } from '../../cli.js'
import { UsageError } from '../../../core/provider/errors.js'

/** Output mode for single-result commands (ADR 0007 §2). */
export type OutputMode = 'json' | 'quiet' | 'table' | 'tsv'

type Options = NonNullable<ParseArgsConfig['options']>

/**
 * Parse command args with `strict: true` (ADR 0007 §1). Output flags
 * (`--json`, `--quiet`) are accepted after the command name as well.
 * parseArgs failures become a UsageError (exit 2).
 */
export function parseCommandArgs<O extends Options>(args: string[], options: O) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        ...options,
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
      },
    })
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

/** Mode selection order from ADR 0007 §2. */
export function selectOutputMode(
  ctx: CommandContext,
  local: { json?: boolean; quiet?: boolean },
  stdoutIsTTY: boolean
): OutputMode {
  const json = ctx.json || local.json === true
  const quiet = ctx.quiet || local.quiet === true
  if (json && quiet) {
    throw new UsageError('--json and --quiet cannot be used together')
  }
  if (json) return 'json'
  if (quiet) return 'quiet'
  return stdoutIsTTY ? 'table' : 'tsv'
}

/** One TSV row: tabs, CR and LF inside values become a single space (ADR 0007 §2.2). */
export function tsvLine(values: Array<string | undefined>): string {
  return values.map((v) => (v ?? '').replace(/[\t\r\n]/g, ' ')).join('\t')
}
