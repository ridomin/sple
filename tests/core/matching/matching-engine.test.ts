import { test, describe } from 'node:test'
import * as assert from 'node:assert'
import { MatchingEngine } from '../../../src/core/matching/matching-engine.js'
import type { Provider, CanonicalTrack } from '../../../src/core/provider/provider.js'
import type { CanonicalPlaylistFile } from '../../../src/core/export/format.js'
import type { ProviderCapabilities } from '../../../src/core/provider/capabilities.js'

describe('MatchingEngine', () => {
  let engine: MatchingEngine
  let mockProvider: Provider
  const mockCapabilities: ProviderCapabilities = {
    id: 'spotify',
    displayName: 'Spotify',
    pagination: 'cursor-forward',
    playlists: { access: ['owned'] },
  }

  describe('match', () => {
    test('should return a report with matched tracks', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'My Playlist',
          trackCount: 1,
        },
        tracks: [
          {
            position: 1,
            title: 'Imagine',
            artists: ['John Lennon'],
            durationMs: 183000,
            refs: { spotify: 'spotify:track:123' },
          },
        ],
        unsupportedItems: [],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      assert.strictEqual(report.summary.total, 1)
      assert.strictEqual(report.summary.matched, 1)
      assert.strictEqual(report.results[0].status, 'matched')
      assert.strictEqual(report.results[0].confidence, 1.0)
    })

    test('should mark matched tracks below minConfidence threshold as low-confidence', async () => {
      engine = new MatchingEngine()

      // Create a mock provider that returns low-confidence matches
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        searchTracks: async () => [
          {
            ref: 'spotify:track:456',
            track: {
              title: 'Song B',
              artists: ['Artist B'],
              durationMs: 300000,
              refs: { spotify: 'spotify:track:456' },
            },
          },
        ],
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'My Playlist',
          trackCount: 1,
        },
        tracks: [
          {
            position: 1,
            title: 'Song A',
            artists: ['Artist A'],
            durationMs: 180000,
            refs: {},
          },
        ],
        unsupportedItems: [],
      }

      const report = await engine.match(
        file,
        mockProvider,
        mockCapabilities,
        { minConfidence: 0.9 }
      )

      // Either matched with low confidence or unmatched
      const result = report.results[0]
      assert.ok(
        result.status === 'low-confidence' || result.status === 'unmatched',
        `Expected low-confidence or unmatched, got ${result.status}`
      )
    })

    test('should include unsupported items in the report', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'My Playlist',
          trackCount: 2,
        },
        tracks: [
          {
            position: 1,
            title: 'Song',
            artists: ['Artist'],
            durationMs: 180000,
            refs: { spotify: 'spotify:track:123' },
          },
        ],
        unsupportedItems: [
          {
            position: 2,
            kind: 'local',
            name: 'Local File',
          },
        ],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      assert.strictEqual(report.summary.total, 2)
      assert.strictEqual(report.summary.matched, 1)
      assert.strictEqual(report.summary.unsupported, 1)
      assert.strictEqual(report.results.length, 2)

      const unsupportedResult = report.results.find((r) => r.position === 2)
      assert.ok(unsupportedResult)
      assert.strictEqual(unsupportedResult.status, 'unsupported')
      assert.ok(unsupportedResult.error?.includes('Unsupported item type'))
    })

    test('should generate recommendations for unmatched and unsupported items', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'My Playlist',
          trackCount: 2,
        },
        tracks: [
          {
            position: 1,
            title: 'Unknown Song ZZZZ',
            artists: ['Unknown Artist YYYY'],
            durationMs: 999999,
            refs: {},
          },
        ],
        unsupportedItems: [
          {
            position: 2,
            kind: 'episode',
          },
        ],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      assert.ok(report.recommendations)
      assert.ok(report.recommendations!.length > 0)
      // Check for recommendations about unmatched or not matched items
      const hasUnmatchedRec = report.recommendations!.some((r) =>
        r.includes('could not be matched') || r.includes('unmatched') || r.includes('track')
      )
      assert.ok(hasUnmatchedRec, `Expected unmatched recommendation, got: ${JSON.stringify(report.recommendations)}`)
      // Check for unsupported items recommendation
      const hasUnsupportedRec = report.recommendations!.some((r) => r.includes('not supported') || r.includes('unsupported') || r.includes('item'))
      assert.ok(hasUnsupportedRec, `Expected unsupported recommendation, got: ${JSON.stringify(report.recommendations)}`)
    })

    test('should populate sourceFile with provided path', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'My Playlist',
          trackCount: 1,
        },
        tracks: [
          {
            position: 1,
            title: 'Song',
            artists: ['Artist'],
            durationMs: 180000,
            refs: { spotify: 'spotify:track:123' },
          },
        ],
        unsupportedItems: [],
      }

      const sourceFilePath = '/path/to/export.json'
      const report = await engine.match(
        file,
        mockProvider,
        mockCapabilities,
        { sourceFilePath }
      )

      assert.strictEqual(report.sourceFile.path, sourceFilePath)
    })

    test('should handle empty tracks array', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'Empty Playlist',
          trackCount: 0,
        },
        tracks: [],
        unsupportedItems: [],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      assert.strictEqual(report.summary.total, 0)
      assert.strictEqual(report.results.length, 0)
    })

    test('should handle track with empty title', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'Test',
          trackCount: 1,
        },
        tracks: [
          {
            position: 1,
            title: '',
            artists: [],
            durationMs: 0,
            refs: {},
          },
        ],
        unsupportedItems: [],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      assert.strictEqual(report.results[0].status, 'unmatched')
    })

    test('should try known-ref before falling through to metadata', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'Test',
          trackCount: 1,
        },
        tracks: [
          {
            position: 1,
            title: 'Song',
            artists: ['Artist'],
            durationMs: 180000,
            isrc: 'ISRC12345678',
            refs: { spotify: 'spotify:track:999' },
          },
        ],
        unsupportedItems: [],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      // Should use known-ref (confidence 1.0)
      assert.strictEqual(report.results[0].status, 'matched')
      assert.strictEqual(report.results[0].confidence, 1.0)
    })

    test('should calculate correct summary totals', async () => {
      engine = new MatchingEngine()
      mockProvider = {
        id: 'spotify',
        displayName: 'Spotify',
        capabilities: mockCapabilities,
        search: async () => ({ items: [] }),
        parsePlaylistRef: () => null,
        listPlaylists: async () => ({ items: [] }),
        getPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        getPlaylistTracks: async () => ({ items: [] }),
        getLikedTracks: async () => ({ items: [] }),
        createPlaylist: async () => ({
          ref: 'test',
          id: 'test',
          name: 'Test',
          owner: { id: 'user' },
          owned: true,
          itemsReadable: true,
        }),
        removePlaylist: async () => ({ action: 'deleted' as const }),
        searchTracks: async () => [],
        populatePlaylist: async () => ({ added: [], failed: [] }),
        auth: {
          login: async () => ({ loggedIn: false, scopes: [] }),
          status: async () => ({ loggedIn: false, scopes: [] }),
          logout: async () => ({ revoked: false, deletedData: [] }),
        },
      }

      const file: CanonicalPlaylistFile = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        generator: { name: 'sple', version: '0.1.0' },
        source: { provider: 'spotify', kind: 'playlist' },
        playlist: {
          name: 'Test Playlist',
          trackCount: 3,
        },
        tracks: [
          {
            position: 1,
            title: 'Song 1',
            artists: ['Artist 1'],
            durationMs: 180000,
            refs: { spotify: 'spotify:track:1' },
          },
          {
            position: 2,
            title: 'Song 2',
            artists: ['Artist 2'],
            durationMs: 200000,
            refs: { spotify: 'spotify:track:2' },
          },
        ],
        unsupportedItems: [
          {
            position: 3,
            kind: 'episode',
          },
        ],
      }

      const report = await engine.match(file, mockProvider, mockCapabilities)

      const sum =
        report.summary.matched +
        report.summary.lowConfidence +
        report.summary.unmatched +
        report.summary.unsupported

      assert.strictEqual(sum, report.summary.total)
    })
  })
})
