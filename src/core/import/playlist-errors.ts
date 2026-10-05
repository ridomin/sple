export class PlaylistError extends Error {
  constructor(message: string, public readonly code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlaylistError'
  }
}

export class PlaylistCreationError extends PlaylistError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PLAYLIST_CREATION_FAILED', options)
  }
}

/**
 * Adding tracks failed after the playlist was created. The playlist exists on
 * the provider and may hold some of the tracks; `cause` is the provider error.
 */
export class PlaylistAddTracksError extends PlaylistError {
  constructor(
    message: string,
    public readonly playlistId: string,
    public readonly playlistUrl: string | undefined,
    options?: ErrorOptions
  ) {
    super(message, 'PLAYLIST_ADD_TRACKS_FAILED', options)
  }
}
