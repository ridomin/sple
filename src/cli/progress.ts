/**
 * In-place progress line on stderr (ADR-0007 §8).
 *
 * - Enabled only when the stream is a TTY and neither --quiet nor --json is set
 *   (the caller passes `enabled: false` for those modes).
 * - One line, redrawn with `\r` at most 10 times per second; the final update
 *   is always drawn.
 * - `done()` clears the line, so it never mixes with later stderr output.
 */

export interface ProgressStream {
  isTTY?: boolean
  write(chunk: string): unknown
}

export interface Progress {
  /** Report `current` of `total` units (total omitted when unknown). */
  update(current: number, total?: number): void
  /** Clear the progress line. Safe to call more than once. */
  done(): void
}

export interface ProgressOptions {
  /** False for --quiet / --json; the stream must also be a TTY. */
  enabled: boolean
  /** Defaults to process.stderr. */
  stream?: ProgressStream
  /** Clock, for tests. */
  now?: () => number
}

const BAR_WIDTH = 10
const MIN_INTERVAL_MS = 100
const SPINNER = ['|', '/', '-', '\\']
const CLEAR_LINE = '\r\x1b[K'

const NOOP: Progress = { update() {}, done() {} }

export function createProgress(label: string, unit: string, opts: ProgressOptions): Progress {
  const stream = opts.stream ?? process.stderr
  if (!opts.enabled || !stream.isTTY) return NOOP

  const now = opts.now ?? Date.now
  let lastDraw = -Infinity
  let frame = 0
  let drawn = false

  const render = (current: number, total?: number): string => {
    if (total !== undefined && total > 0) {
      const filled = Math.min(BAR_WIDTH, Math.round((current / total) * BAR_WIDTH))
      const bar = '#'.repeat(filled) + '-'.repeat(BAR_WIDTH - filled)
      return `${label} [${bar}] ${current}/${total} ${unit}`
    }
    const spin = SPINNER[frame++ % SPINNER.length]
    return `${label} ${spin} ${current} ${unit}`
  }

  return {
    update(current, total) {
      const t = now()
      const final = total !== undefined && current >= total
      if (!final && t - lastDraw < MIN_INTERVAL_MS) return
      lastDraw = t
      stream.write(`${CLEAR_LINE}${render(current, total)}`)
      drawn = true
    },
    done() {
      if (drawn) stream.write(CLEAR_LINE)
      drawn = false
    },
  }
}
