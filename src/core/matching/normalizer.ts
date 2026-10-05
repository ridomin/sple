/**
 * TrackNormalizer provides static methods for normalizing track metadata
 * and calculating confidence scores for track matching.
 *
 * Uses simple word-based overlap for title and artist similarity,
 * with no external fuzzy-matching libraries.
 */
export class TrackNormalizer {
  /**
   * Normalize title: remove (feat., remix, etc.), normalize unicode NFD, lowercase.
   * @param title Track title to normalize
   * @returns Normalized title string
   */
  static normalizeTitle(title: string): string {
    if (!title) return ''

    // NFD: decompose accents and combining characters
    let normalized = title.normalize('NFD')

    // Remove common suffixes: (feat. X), (ft. X), (remix), (cover), (acoustic), (instrumental)
    normalized = normalized
      .replace(/\s*\(feat\.\s+[^)]+\)/gi, '')
      .replace(/\s*\(ft\.\s+[^)]+\)/gi, '')
      .replace(/\s*\(remix\)/gi, '')
      .replace(/\s*\(remix by [^)]+\)/gi, '')
      .replace(/\s*\(cover\)/gi, '')
      .replace(/\s*\(acoustic\)/gi, '')
      .replace(/\s*\(instrumental\)/gi, '')

    // Lowercase and trim
    normalized = normalized.toLowerCase().trim()

    return normalized
  }

  /**
   * Normalize artist name: normalize unicode NFD, lowercase, trim.
   * @param artist Artist name to normalize
   * @returns Normalized artist name
   */
  static normalizeArtist(artist: string): string {
    if (!artist) return ''

    let normalized = artist.normalize('NFD')
    normalized = normalized.toLowerCase().trim()

    return normalized
  }

  /**
   * Calculate title similarity using word-based overlap (0-1).
   * Splits titles into words and counts matching words.
   * @param query Query title
   * @param candidate Candidate title to compare
   * @returns Similarity score between 0 and 1
   */
  static calculateTitleSimilarity(query: string, candidate: string): number {
    const normQuery = this.normalizeTitle(query).split(/\s+/).filter(w => w)
    const normCandidate = this.normalizeTitle(candidate).split(/\s+/).filter(w => w)

    if (normQuery.length === 0 || normCandidate.length === 0) {
      return 0
    }

    const matches = normQuery.filter(word => normCandidate.includes(word)).length
    return matches / Math.max(normQuery.length, normCandidate.length)
  }

  /**
   * Calculate artist similarity as percentage of query artists found in candidates.
   * Uses substring matching for flexibility (e.g., "The Beatles" contains "Beatles").
   * @param queryArtists Artists from the query
   * @param candidateArtists Artists from the candidate
   * @returns Similarity score between 0 and 1 (percentage of query artists matched)
   */
  static calculateArtistSimilarity(queryArtists: string[], candidateArtists: string[]): number {
    const normQuery = queryArtists.map(a => this.normalizeArtist(a))
    const normCandidate = candidateArtists.map(a => this.normalizeArtist(a))

    if (normQuery.length === 0 || normCandidate.length === 0) {
      return 0
    }

    const matches = normQuery.filter(qa =>
      normCandidate.some(ca => ca.includes(qa) || qa.includes(ca))
    ).length
    return matches / normQuery.length // Percentage of query artists found
  }

  /**
   * Check if two durations are within tolerance (default ±5 seconds).
   * @param duration1 First duration in milliseconds
   * @param duration2 Second duration in milliseconds
   * @param toleranceMs Tolerance in milliseconds (default 5000)
   * @returns true if durations are within tolerance
   */
  static isWithinDurationTolerance(
    duration1: number,
    duration2: number,
    toleranceMs: number = 5000
  ): boolean {
    return Math.abs(duration1 - duration2) <= toleranceMs
  }

  /**
   * Calculate combined confidence score for metadata match.
   * Weights: title 50%, artist 35%, duration 15%.
   * @param queryTitle Query track title
   * @param queryArtists Query track artists
   * @param queryDuration Query track duration in milliseconds
   * @param candidateTitle Candidate track title
   * @param candidateArtists Candidate track artists
   * @param candidateDuration Candidate track duration in milliseconds
   * @returns Confidence score between 0 and 1
   */
  static calculateMetadataConfidence(
    queryTitle: string,
    queryArtists: string[],
    queryDuration: number,
    candidateTitle: string,
    candidateArtists: string[],
    candidateDuration: number
  ): number {
    const titleScore = this.calculateTitleSimilarity(queryTitle, candidateTitle)
    const artistScore = this.calculateArtistSimilarity(queryArtists, candidateArtists)
    const durationOk = this.isWithinDurationTolerance(queryDuration, candidateDuration) ? 1 : 0

    const confidence = titleScore * 0.5 + artistScore * 0.35 + durationOk * 0.15
    return Math.min(1, confidence)
  }
}
