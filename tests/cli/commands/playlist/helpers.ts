import type { CommandContext } from '../../../../src/cli/cli.js'
import type { Config } from '../../../../src/cli/config.js'
import { ProviderRegistry } from '../../../../src/cli/provider-registry.js'
import { getExitCode, formatErrorMessage } from '../../../../src/cli/exit-codes.js'
import type { Provider } from '../../../../src/core/provider/provider.js'

export interface Captured {
  code: number
  out: string
  err: string
}

/** A CommandContext whose registry always returns `provider`, with captured stdout/stderr. */
export function makeCtx(
  provider: Provider,
  flags: Partial<Pick<CommandContext, 'json' | 'quiet' | 'yes'>> = {}
): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const config: Config = { provider: provider.id, verbose: false }
  const ctx: CommandContext = {
    registry: new ProviderRegistry().register(provider.id, () => provider),
    config,
    io: { out: (m) => out.push(m), err: (m) => err.push(m) },
    version: 'test',
    json: flags.json ?? false,
    quiet: flags.quiet ?? false,
    debug: false,
    yes: flags.yes ?? false,
  }
  return { ctx, out, err }
}

/** Run a command the way cli.run does: errors become stderr text plus an exit code. */
export async function runCommand(
  provider: Provider,
  fn: (ctx: CommandContext) => Promise<number>,
  flags: Partial<Pick<CommandContext, 'json' | 'quiet' | 'yes'>> = {}
): Promise<Captured> {
  const { ctx, out, err } = makeCtx(provider, flags)
  let code: number
  try {
    code = await fn(ctx)
  } catch (e) {
    err.push(formatErrorMessage(e))
    code = getExitCode(e)
  }
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** Count calls to the write methods of a provider (spies, calls still go through). */
export function spyWrites(provider: Provider): { create: number; remove: number } {
  const counts = { create: 0, remove: 0 }
  const create = provider.createPlaylist.bind(provider)
  const remove = provider.removePlaylist.bind(provider)
  ;(provider as { createPlaylist: Provider['createPlaylist'] }).createPlaylist = (input) => {
    counts.create++
    return create(input)
  }
  ;(provider as { removePlaylist: Provider['removePlaylist'] }).removePlaylist = (ref) => {
    counts.remove++
    return remove(ref)
  }
  return counts
}

export interface FetchCall {
  method: string
  url: string
  body?: string
}

/** Replace globalThis.fetch with a URL-routed mock that records every call. */
export function mockFetch(
  routes: Record<string, (call: FetchCall) => Response>,
  calls: FetchCall[]
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.url}`]
    if (!route) throw new Error(`Unexpected fetch: ${call.method} ${call.url}`)
    return route(call)
  }) as typeof fetch
}

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
