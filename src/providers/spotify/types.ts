// Spotify API response types (exact shapes from Spotify Web API docs)
export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  public: boolean;
  owner: { id: string; display_name: string };
  tracks: { total: number; href: string };
  images: Array<{ url: string; height?: number; width?: number }>;
  uri: string;
  external_urls: { spotify: string };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ name: string; id: string }>;
  album: { name: string; id: string; release_date: string };
  duration_ms: number;
  external_ids?: { isrc?: string };
  uri: string;
}

export interface SpotifyPlaylistTrack {
  track: SpotifyTrack | null;  // null for removed/unavailable tracks
  added_at: string;
}

export interface SpotifySearchResponse {
  tracks: { items: SpotifyTrack[]; total: number; next: string | null };
}

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  external_urls: { spotify: string };
}

export interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
  total: number;
  next: string | null;
}
