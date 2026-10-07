import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getConfigDir } from '../config/paths.js'
import type { CanonicalPlaylistFile } from '../export/format.js'
import type { MatchReport, MatchResult } from '../matching/types.js'
import type { ProviderId } from '../provider/capabilities.js'

export const RUNS_DIR = 'runs'
const SCHEMA_VERSION = 1
const RUN_ID = /^\d{8}-[0-9a-f]{6}$/

/** Run files hold provider data (match results), so the 30-day rule applies (ADR 0002 §4.1). */
export const RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One playlist being imported (ADR 0007 Amendment 4). Phases:
 * `matching` (results grow one track at a time) → `matched` (report ready,
 * nothing created) → `adding` (playlist created; `cursor` of `toAdd` processed) → `done`.
 */
export interface RunItem {
  /** Snapshot of the source, so a resume needs neither the file nor the source provider. */
  file: CanonicalPlaylistFile
  /** Target playlist name. */
  name: string
  sourceFilePath: string
  phase: 'matching' | 'matched' | 'adding' | 'done'
  /** Track results so far, in position order (unsupported items are added to `report` only). */
  results: MatchResult[]
  report?: MatchReport
  playlist?: { id: string; ref: string; name: string; url?: string }
  /** Matched refs to add, in position order. */
  toAdd: string[]
  /** Entries of `toAdd` processed (added or failed). */
  cursor: number
  added: number
  failed: Array<{ ref: string; error: string }>
}

export interface RunState {
  schemaVersion: typeof SCHEMA_VERSION
  runId: string
  kind: 'import' | 'migrate'
  target: ProviderId
  createdAt: string
  updatedAt: string
  options: { minConfidence: number; cache: boolean }
  items: RunItem[]
}

export function newRunItem(file: CanonicalPlaylistFile, opts: { name: string; sourceFilePath: string }): RunItem {
  return { file, name: opts.name, sourceFilePath: opts.sourceFilePath, phase: 'matching', results: [], toAdd: [], cursor: 0, added: 0, failed: [] }
}

export interface RunStoreOptions {
  /** Directory holding `runs/`; defaults to the config directory. */
  configDir?: string
  now?: () => Date
}

/**
 * Checkpoint files for resumable imports and migrations (FR-MIG-4):
 * `runs/<runId>.json` in the config directory, mode 0600.
 */
export class RunStore {
  private readonly dir: string
  private readonly now: () => Date

  constructor(opts: RunStoreOptions = {}) {
    this.dir = join(opts.configDir ?? getConfigDir(), RUNS_DIR)
    this.now = opts.now ?? (() => new Date())
  }

  create(kind: RunState['kind'], target: ProviderId, options: RunState['options'], items: RunItem[]): RunState {
    const now = this.now()
    const day = now.toISOString().slice(0, 10).replaceAll('-', '')
    let runId: string
    do runId = `${day}-${randomBytes(3).toString('hex')}`
    while (this.read(runId))
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION, runId, kind, target,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), options, items,
    }
    this.write(state)
    return state
  }

  /** The run, unless it is missing, unreadable or older than 30 days. */
  load(runId: string): RunState | undefined {
    const state = this.read(runId)
    return state && !this.expired(state) ? state : undefined
  }

  save(state: RunState): void {
    state.updatedAt = this.now().toISOString()
    this.write(state)
  }

  delete(runId: string): void {
    if (RUN_ID.test(runId)) rmSync(this.path(runId), { force: true })
  }

  /** Unfinished runs that can still be resumed, newest first. */
  list(): RunState[] {
    return this.all()
      .filter((s) => !this.expired(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Delete runs older than 30 days; returns how many. */
  prune(): number {
    let removed = 0
    for (const state of this.all()) {
      if (this.expired(state)) {
        this.delete(state.runId)
        removed++
      }
    }
    return removed
  }

  /** Delete runs that write to or read from `providerId` (logout, NFR-9); returns how many. */
  removeForProvider(providerId: string): number {
    let removed = 0
    for (const state of this.all()) {
      if (state.target === providerId || state.items.some((i) => i.file.source.provider === providerId)) {
        this.delete(state.runId)
        removed++
      }
    }
    return removed
  }

  private expired(state: RunState): boolean {
    return this.now().getTime() - Date.parse(state.createdAt) >= RUN_TTL_MS
  }

  private path(runId: string): string {
    return join(this.dir, `${runId}.json`)
  }

  private all(): RunState[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => this.read(n.slice(0, -'.json'.length)))
      .filter((s): s is RunState => s !== undefined)
  }

  private read(runId: string): RunState | undefined {
    if (!RUN_ID.test(runId)) return undefined
    try {
      const state = JSON.parse(readFileSync(this.path(runId), 'utf8')) as RunState
      if (
        state.schemaVersion === SCHEMA_VERSION && state.runId === runId &&
        (state.kind === 'import' || state.kind === 'migrate') &&
        typeof state.target === 'string' && !Number.isNaN(Date.parse(state.createdAt)) &&
        Array.isArray(state.items)
      ) {
        return state
      }
    } catch {
      // Missing or unreadable: not a resumable run.
    }
    return undefined
  }

  private write(state: RunState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const target = this.path(state.runId)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 })
    renameSync(temp, target)
  }
}
