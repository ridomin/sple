import type { CommandContext } from './cli.js'

export interface ColumnDef {
  name: string
  width?: number
  formatter?: (value: unknown) => string
}

export interface TableContent {
  table: Array<Record<string, unknown>>
  columns: ColumnDef[]
}

export interface JsonContent {
  json: unknown
}

export interface QuietContent {
  quiet: string[]
}

export type OutputContent = TableContent | JsonContent | QuietContent

function formatValue(value: unknown, formatter?: (v: unknown) => string): string {
  if (formatter) return formatter(value)
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 0) {
      // Could be duration in ms
      return String(value)
    }
    return String(value)
  }
  return String(value)
}

interface TableLayout {
  columnWidths: number[]
  terminalWidth: number
  flexibleColumns: number[]
}

function calculateLayout(
  data: Array<Record<string, unknown>>,
  columns: ColumnDef[],
  terminalWidth: number
): TableLayout {
  // Initial column widths: max of header and values
  const columnWidths = columns.map((col) => {
    let maxWidth = col.name.length
    for (const row of data) {
      const val = formatValue(row[col.name], col.formatter)
      maxWidth = Math.max(maxWidth, val.length)
    }
    return Math.min(maxWidth, col.width || Infinity)
  })

  // Find flexible columns (typically title, name, album, artists)
  const flexibleNames = new Set(['title', 'name', 'album', 'artists', 'description', 'url'])
  const flexibleColumns = columns
    .map((col, idx) => (flexibleNames.has(col.name) ? idx : -1))
    .filter((idx) => idx >= 0)

  return { columnWidths, terminalWidth, flexibleColumns }
}

function renderTableRow(
  values: string[],
  widths: number[],
  padding: number = 2
): string {
  const cells = values.map((val, idx) => {
    const width = widths[idx]
    if (val.length > width) {
      return val.substring(0, Math.max(1, width - 1)) + '…'
    }
    return val.padEnd(width)
  })
  return cells.join(' '.repeat(padding))
}

function shouldTruncate(layout: TableLayout): boolean {
  const totalWidth = layout.columnWidths.reduce((a, b) => a + b, 0) + (layout.columnWidths.length - 1) * 2
  return totalWidth > layout.terminalWidth
}

function truncateColumns(layout: TableLayout): number[] {
  const targetWidth = layout.terminalWidth - 2 // Leave small margin
  let totalWidth = layout.columnWidths.reduce((a, b) => a + b, 0) + (layout.columnWidths.length - 1) * 2

  if (totalWidth <= targetWidth) {
    return layout.columnWidths
  }

  const widths = [...layout.columnWidths]
  const flexibleIndices = [...layout.flexibleColumns].sort((a, b) => widths[b] - widths[a])

  for (const idx of flexibleIndices) {
    if (totalWidth <= targetWidth) break
    const reduction = Math.min(Math.max(widths[idx] - 10, 5), totalWidth - targetWidth)
    widths[idx] -= reduction
    totalWidth -= reduction
  }

  return widths
}

function renderTable(
  data: Array<Record<string, unknown>>,
  columns: ColumnDef[],
  terminalWidth: number,
  isTTY: boolean
): string {
  if (data.length === 0) {
    return ''
  }

  const layout = calculateLayout(data, columns, terminalWidth)
  const finalWidths = shouldTruncate(layout) ? truncateColumns(layout) : layout.columnWidths

  const lines: string[] = []

  // Header
  if (isTTY) {
    const headerValues = columns.map((c) => c.name)
    lines.push(renderTableRow(headerValues, finalWidths, 2))
    lines.push(''.padEnd(finalWidths.reduce((a, b) => a + b + 2, -2), '-'))
  }

  // Rows
  for (const row of data) {
    const rowValues = columns.map((col) => formatValue(row[col.name], col.formatter))
    lines.push(renderTableRow(rowValues, finalWidths, 2))
  }

  return lines.join('\n')
}

function renderTabSeparated(
  data: Array<Record<string, unknown>>,
  columns: ColumnDef[]
): string {
  const lines: string[] = []

  for (const row of data) {
    const rowValues = columns.map((col) => {
      const val = formatValue(row[col.name], col.formatter)
      // Replace tabs, CR, LF with spaces
      return val.replace(/[\t\r\n]/g, ' ')
    })
    lines.push(rowValues.join('\t'))
  }

  return lines.join('\n')
}

/**
 * Emit output based on the command context and content.
 * Handles --json, --quiet, table (TTY), and tab-separated (non-TTY) modes.
 */
export function emit(ctx: CommandContext, content: OutputContent): void {
  if ('json' in content) {
    // JSON mode
    ctx.io.out(JSON.stringify(content.json, null, 2))
  } else if ('quiet' in content) {
    // Quiet mode
    if (content.quiet.length > 0) {
      ctx.io.out(content.quiet.join('\n'))
    }
  } else if ('table' in content) {
    // Table or tab-separated mode
    const isTTY = process.stdout.isTTY ?? false
    const terminalWidth = process.stdout.columns ?? 80

    if (isTTY && !ctx.quiet) {
      // Table mode
      const rendered = renderTable(content.table, content.columns, terminalWidth, true)
      if (rendered) {
        ctx.io.out(rendered)
      }
    } else {
      // Tab-separated mode (non-TTY or quiet)
      const rendered = renderTabSeparated(content.table, content.columns)
      if (rendered) {
        ctx.io.out(rendered)
      }
    }
  }
}
