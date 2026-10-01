#!/usr/bin/env node

import { version } from '../index.js'

const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log(`sple v${version}`)
  process.exit(0)
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`sple v${version}

Usage: sple <command> [options]

Commands:
  auth       Authentication and account management
  search     Search the provider catalog
  playlist   Playlist management
  export     Export playlists to files
  import     Import playlists from files
  migrate    Migrate playlists between providers

Options:
  --provider <name>  Specify the provider (spotify, youtube-music)
  --verbose          Enable verbose output
  --help, -h         Show this help message
  --version, -v      Show version number

See docs/README.md for detailed documentation.
`)
  process.exit(0)
}

console.error(`Unknown command: ${args[0]}`)
console.error('Run "sple --help" for usage information')
process.exit(1)
