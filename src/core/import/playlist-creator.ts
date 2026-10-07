import type { Provider } from '../provider/provider.js'
import type { MatchReport } from '../matching/types.js'
import { ProviderError } from '../provider/errors.js'
import { PlaylistCreationError, PlaylistAddTracksError } from './playlist-errors.js'

export interface PlaylistCreationResult {
  playlistId: string
  playlistUrl?: string
  tracksAdded: number
  tracksFailed: number
  failures: Array<{ ref: string; error: string }>
}

export class PlaylistCreator {
  /**
   * Create a private playlist and add the report's `matched` tracks in order.
   * Low-confidence matches are left out until they can be reviewed.
   */
  async createPlaylistFromMatches(
    provider: Provider,
    report: MatchReport,
    playlistName: string
  ): Promise<PlaylistCreationResult> {
    // Create the playlist
    let playlistId: string
    let playlistUrl: string | undefined

    try {
      const playlist = await provider.createPlaylist({
        name: playlistName,
        public: false
      })
      playlistId = playlist.ref
      playlistUrl = playlist.url
    } catch (error) {
      // Provider errors carry the exit code and hint the CLI reports (e.g. "run sple auth login")
      if (error instanceof ProviderError) throw error
      throw new PlaylistCreationError(
        `Failed to create playlist "${playlistName}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }

    const tracksToAdd: string[] = []
    for (const result of report.results) {
      if (result.status === 'matched' && result.candidate) {
        tracksToAdd.push(result.candidate.ref)
      }
    }

    if (tracksToAdd.length === 0) {
      return { playlistId, playlistUrl, tracksAdded: 0, tracksFailed: 0, failures: [] }
    }

    // Add tracks to playlist
    try {
      const result = await provider.populatePlaylist(playlistId, tracksToAdd, {
        skipExisting: false
      })
      return {
        playlistId,
        playlistUrl,
        tracksAdded: result.added.length,
        tracksFailed: result.failed.length,
        failures: result.failed
      }
    } catch (error) {
      throw new PlaylistAddTracksError(
        `Playlist ${playlistUrl ?? playlistId} was created, but adding tracks failed: ${error instanceof Error ? error.message : String(error)}`,
        playlistId,
        playlistUrl,
        { cause: error }
      )
    }
  }
}
