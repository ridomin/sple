import type { Provider } from '../provider/provider.js'
import type { MatchReport } from '../matching/types.js'
import { ProviderError } from '../provider/errors.js'
import { PlaylistCreationError, PlaylistAddTracksError } from './playlist-errors.js'

export interface PlaylistCreationResult {
  playlist: { id: string; ref: string; name: string; url?: string }
  playlistId: string
  playlistUrl?: string
  tracksAdded: number
  tracksFailed: number
  failures: Array<{ ref: string; error: string }>
}

/**
 * How far the writing of one playlist has got (a `RunItem` satisfies this).
 * `cursor` counts the `toAdd` entries processed, added or failed.
 */
export interface AddProgress {
  playlist?: { id: string; ref: string; name: string; url?: string }
  toAdd: string[]
  cursor: number
  added: number
  failed: Array<{ ref: string; error: string }>
}

export interface WriteOptions {
  /** Called after the playlist is created and after each batch; the caller persists `progress`. */
  checkpoint?: () => void
  /**
   * Resuming: read the playlist's track count once and skip the tracks that
   * were added after the last checkpoint (ADR 0002 §4.1, ADR 0007 Amendment 4).
   */
  reconcile?: boolean
}

/** The report's `matched` refs in position order. Low-confidence matches are left out until they can be reviewed. */
export function matchedRefs(report: MatchReport): string[] {
  return report.results.filter((r) => r.status === 'matched' && r.candidate).map((r) => r.candidate!.ref)
}

export class PlaylistCreator {
  /** Create a private playlist and add the report's `matched` tracks in order. */
  async createPlaylistFromMatches(
    provider: Provider,
    report: MatchReport,
    playlistName: string
  ): Promise<PlaylistCreationResult> {
    return this.writeMatches(provider, { toAdd: matchedRefs(report), cursor: 0, added: 0, failed: [] }, playlistName)
  }

  /**
   * Create the playlist unless `progress` already has one, then add the rest of
   * `toAdd` in batches of `maxTracksPerRequest`, updating `progress` as it goes.
   */
  async writeMatches(
    provider: Provider,
    progress: AddProgress,
    playlistName: string,
    opts: WriteOptions = {}
  ): Promise<PlaylistCreationResult> {
    const checkpoint = opts.checkpoint ?? (() => {})

    if (!progress.playlist) {
      try {
        const playlist = await provider.createPlaylist({ name: playlistName, public: false })
        progress.playlist = { id: playlist.id, ref: playlist.ref, name: playlist.name, ...(playlist.url && { url: playlist.url }) }
      } catch (error) {
        // Provider errors carry the exit code and hint the CLI reports (e.g. "run sple auth login")
        if (error instanceof ProviderError) throw error
        throw new PlaylistCreationError(
          `Failed to create playlist "${playlistName}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }
      // Saved before any add, so a resume never creates a second playlist.
      checkpoint()
    } else if (opts.reconcile && progress.cursor < progress.toAdd.length) {
      const { trackCount } = await provider.getPlaylist(progress.playlist.ref)
      if (trackCount !== undefined && trackCount > progress.added) {
        // sple created this private playlist and adds in order, so extra items are ours.
        const extra = Math.min(trackCount - progress.added, progress.toAdd.length - progress.cursor)
        progress.cursor += extra
        progress.added += extra
        checkpoint()
      }
    }

    const playlist = progress.playlist
    const batch = Math.max(1, provider.capabilities.maxTracksPerRequest)
    while (progress.cursor < progress.toAdd.length) {
      const refs = progress.toAdd.slice(progress.cursor, progress.cursor + batch)
      let result
      try {
        result = await provider.populatePlaylist(playlist.ref, refs, { skipExisting: false })
      } catch (error) {
        throw new PlaylistAddTracksError(
          `Playlist ${playlist.url ?? playlist.ref} was created, but adding tracks failed: ${error instanceof Error ? error.message : String(error)}`,
          playlist.ref,
          playlist.url,
          { cause: error }
        )
      }
      progress.cursor += refs.length
      progress.added += result.added.length
      progress.failed.push(...result.failed)
      checkpoint()
    }

    return {
      playlist,
      playlistId: playlist.ref,
      playlistUrl: playlist.url,
      tracksAdded: progress.added,
      tracksFailed: progress.failed.length,
      failures: progress.failed,
    }
  }
}
