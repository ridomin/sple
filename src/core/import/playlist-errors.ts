export class PlaylistError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'PlaylistError'
  }
}

export class PlaylistCreationError extends PlaylistError {
  constructor(message: string) {
    super(message, 'PLAYLIST_CREATION_FAILED')
  }
}

export class PlaylistAddTracksError extends PlaylistError {
  constructor(message: string, public readonly added: number = 0, public readonly failed: number = 0) {
    super(message, 'PLAYLIST_ADD_TRACKS_FAILED')
  }
}
