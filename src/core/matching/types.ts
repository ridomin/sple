import type { CanonicalTrack, MatchCandidate, Provider } from '../provider/provider.js'

export type { MatchCandidate }
import type { ProviderCapabilities } from '../provider/capabilities.js'

// Result of a single match attempt
export interface MatchResult {
  track: CanonicalTrack
  position: number
  status: 'matched' | 'low-confidence' | 'unmatched' | 'unsupported'
  candidate?: MatchCandidate // Best match (if status is matched or low-confidence)
  confidence?: number // Confidence score (0-1)
  strategies: string[] // Strategies tried, in order (ends with the one that matched)
  error?: string // Error message if matching failed
}

// Collection of all match results for a playlist
/** Match report v1 (ADR-0009 Amendment 1 §6). */
export interface MatchReport {
  schemaVersion: 1
  importedAt: string // ISO 8601 UTC
  sourceFile: {
    path: string
    provider: string
    playlistName: string
    trackCount: number
  }
  targetProvider: string
  targetPlaylistName: string // --name or the file's playlist name
  minConfidence: number
  results: MatchResult[]
  summary: {
    total: number
    matched: number
    lowConfidence: number
    unmatched: number
    unsupported: number
  }
  recommendations: string[] // Suggested actions for the user
}

// Request to match a single track
export interface MatchRequest {
  track: CanonicalTrack
  position: number
  targetProvider: string
  capabilities: ProviderCapabilities
}

// Strategy interface for matching tracks
export interface MatchingStrategy {
  readonly name: string // e.g., 'known-ref', 'isrc', 'metadata'
  readonly priority: number // 1 = highest (tried first)
  isApplicable(request: MatchRequest): boolean // Can this strategy be used?
  execute(request: MatchRequest, provider: Provider): Promise<MatchCandidate | null> // Returns null if no match found
}
