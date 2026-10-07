/**
 * Text normalization and metadata scoring for the metadata strategy
 * (ADR-0009 Amendment 1 §3–4). Every implementation must reproduce the test
 * vectors in §5, so the steps below follow the spec literally.
 */

const APOSTROPHES = /['‘’ʼ]/g
const NOT_LETTER_OR_NUMBER = /[^\p{L}\p{N}]+/gu

/** ADR-0009 A1 §3 `normalizeText`. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(NOT_LETTER_OR_NUMBER, ' ')
    .trim()
}

/** The distinct words of `normalizeText(s)`, in first-seen order. */
export function tokens(s: string): string[] {
  const text = normalizeText(s)
  return text ? [...new Set(text.split(' '))] : []
}

const VERSION =
  /^(?:(?:\d{4} )?(?:digital |digitally )?(?:remaster|remastered)(?: \d{4})?(?: version)?|explicit|clean|mono|stereo|radio edit|single version|album version)$/
const CREDIT_BRACKET = /^(?:feat|ft|featuring|with) .+$/
const CREDIT_DASH = /^(?:feat|ft|featuring) .+$/

/** `(…)` or `[…]` without nested brackets, with the whitespace before it. */
const BRACKETED = /\s*(?:\(([^()[\]]*)\)|\[([^()[\]]*)\])/g
/** `<head> <dash> <tail>`, split at the last dash surrounded by whitespace. */
const DASH_SUFFIX = /^(.*)\s+[-–—]\s+(.*)$/s

/**
 * ADR-0009 A1 §3 `stripTitleDecorations`: drop remaster/edition markers and
 * featured-artist credits, but keep words that change the recording (live,
 * remix, acoustic, …).
 */
export function stripTitleDecorations(title: string): string {
  let result = title.replace(BRACKETED, (segment, paren?: string, square?: string) => {
    const content = normalizeText(paren ?? square ?? '')
    return VERSION.test(content) || CREDIT_BRACKET.test(content) ? '' : segment
  })

  for (let m = DASH_SUFFIX.exec(result); m; m = DASH_SUFFIX.exec(result)) {
    const tail = normalizeText(m[2])
    if (!VERSION.test(tail) && !CREDIT_DASH.test(tail)) break
    result = m[1]
  }
  return result
}

export function titleTokens(title: string): string[] {
  return tokens(stripTitleDecorations(title))
}

export interface ScoredTrack {
  title: string
  artists: string[]
  durationMs?: number
}

export interface MetadataScore {
  title: number
  artist: number
  confidence: number
  /** Only accepted hits can become a match candidate. */
  accepted: boolean
}

const isSubset = (a: string[], b: string[]) => a.every((x) => b.includes(x))

/** ADR-0009 A1 §4. */
export function scoreMetadata(source: ScoredTrack, candidate: ScoredTrack): MetadataScore {
  const ts = titleTokens(source.title)
  const tc = titleTokens(candidate.title)
  const title =
    ts.length === 0 || tc.length === 0 ? 0 : ts.filter((w) => tc.includes(w)).length / Math.max(ts.length, tc.length)

  const as = source.artists.map(tokens).filter((t) => t.length > 0)
  const ac = candidate.artists.map(tokens).filter((t) => t.length > 0)
  const artist =
    as.length === 0 || ac.length === 0
      ? 0
      : as.filter((a) => ac.some((x) => isSubset(a, x) || isSubset(x, a))).length / as.length

  let confidence: number
  if (typeof source.durationMs === 'number' && typeof candidate.durationMs === 'number') {
    const duration = Math.abs(source.durationMs - candidate.durationMs) <= 5000 ? 1 : 0
    confidence = 0.5 * title + 0.35 * artist + 0.15 * duration
  } else {
    confidence = (0.5 * title + 0.35 * artist) / 0.85
  }

  return { title, artist, confidence, accepted: title >= 0.5 && artist > 0 && confidence >= 0.4 }
}
