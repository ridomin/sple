// YouTube Data API response types
export interface YouTubePlaylist {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    thumbnails?: { high?: { url: string } };
    publishedAt?: string;
  };
  contentDetails?: { itemCount: number };
  status?: { privacyStatus: 'public' | 'private' | 'unlisted' };
}

export interface YouTubePlaylistItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    playlistId: string;
    position: number;
    resourceId: { videoId: string };
    publishedAt: string;
  };
  contentDetails?: { videoId: string };
}

export interface YouTubeVideo {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    publishedAt: string;
    thumbnails?: { default?: { url: string } };
  };
  contentDetails?: { duration: string };  // ISO 8601 format
}

export interface YouTubeSearchResult {
  id: { kind?: string; videoId?: string; playlistId?: string; channelId?: string };
  snippet: { title: string; description?: string; channelId?: string; channelTitle: string };
}

export interface YouTubeListResponse<T> {
  items: T[];
  pageInfo: { totalResults: number; resultsPerPage: number };
  nextPageToken?: string;
}
