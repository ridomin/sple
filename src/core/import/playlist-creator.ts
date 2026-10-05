import type { Provider } from '../provider/provider.js'
import type { MatchReport } from '../matching/types.js'
import { PlaylistCreationError, PlaylistAddTracksError } from './playlist-errors.js'

export interface PlaylistCreationResult {
  playlistId: string
  playlistUrl?: string
  tracksAdded: number
  tracksFailed: number
  failedTrackIndices?: number[]
}

export class PlaylistCreator {
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
      throw new PlaylistCreationError(
        `Failed to create playlist "${playlistName}": ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Collect matched and low-confidence tracks
    const tracksToAdd: string[] = []

    for (const result of report.results) {
      if ((result.status === 'matched' || result.status === 'low-confidence') && result.candidate) {
        tracksToAdd.push(result.candidate.trackRef)
      }
    }

    if (tracksToAdd.length === 0) {
      return {
        playlistId,
        playlistUrl,
        tracksAdded: 0,
        tracksFailed: 0
      }
    }

    // Add tracks to playlist
    try {
      const result = await provider.populatePlaylist(playlistId, tracksToAdd, {
        skipExisting: false
      })
      const failedIndices: number[] = []
      for (let i = 0; i < tracksToAdd.length; i++) {
        const trackRef = tracksToAdd[i]
        if (result.failed.some(f => f.ref === trackRef)) {
          failedIndices.push(i)
        }
      }
      return {
        playlistId,
        playlistUrl,
        tracksAdded: result.added.length,
        tracksFailed: result.failed.length,
        failedTrackIndices: failedIndices.length > 0 ? failedIndices : undefined
      }
    } catch (error) {
      throw new PlaylistAddTracksError(
        `Failed to add tracks to playlist: ${error instanceof Error ? error.message : String(error)}`,
        0,
        tracksToAdd.length
      )
    }
  }
}
