/**
 * Track metadata from a YouTube video (ADR-0002 R3, #29). YouTube has no
 * track/artist fields, so title and artists are guessed from the video title
 * and channel name.
 */

const TOPIC_SUFFIX = / - Topic$/
const VEVO_SUFFIX = /\s*VEVO$/
/** `Artist - Title`, split at the first dash surrounded by whitespace. */
const ARTIST_TITLE = /^(.+?)\s+[-–—]\s+(.+)$/s
/** Video decorations such as `(Official Video)`, `[Official Audio]`, `(Lyrics)`. */
const DECORATION =
  /\s*[([]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|lyric\s+video|visuali[sz]er|hd|hq|4k)\s*[)\]]/gi
/** Credits inside an artist part: `A ft. B`, `A feat. B`, `A & B`, `A, B`. */
const CREDIT_SEPARATOR = /\s+(?:feat\.?|ft\.?|featuring)\s+|\s+&\s+|\s*,\s*/i

/** Auto-generated "Artist - Topic" channels carry the label's audio tracks ("Art Tracks"). */
export function isTopicChannel(channelTitle: string): boolean {
  return TOPIC_SUFFIX.test(channelTitle)
}

export function videoTrackMetadata(videoTitle: string, channelTitle: string): { title: string; artists: string[] } {
  const clean = (s: string) => s.replace(DECORATION, '').trim()

  // Art Tracks: the title is the track title (it may contain " - Remastered …").
  if (isTopicChannel(channelTitle)) {
    return { title: clean(videoTitle), artists: [channelTitle.replace(TOPIC_SUFFIX, '').trim()] }
  }

  const m = ARTIST_TITLE.exec(clean(videoTitle))
  if (m) {
    const artists = m[1].split(CREDIT_SEPARATOR).map((a) => a.trim()).filter(Boolean)
    if (artists.length > 0) return { title: m[2].trim(), artists }
  }

  const channel = channelTitle.replace(VEVO_SUFFIX, '').trim()
  return { title: clean(videoTitle), artists: [channel || 'Unknown Artist'] }
}
