import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export type Platform = 'linux' | 'darwin' | 'win32'

/**
 * Get the platform-specific config directory for sple.
 *
 * - Linux: follows XDG Base Directory spec ($XDG_CONFIG_HOME/sple or ~/.config/sple)
 * - macOS: ~/Library/Application Support/sple
 * - Windows: %APPDATA%/sple (typically C:\Users\<user>\AppData\Roaming\sple)
 */
export function getConfigDir(plat: Platform = platform() as Platform): string {
  const home = homedir()

  switch (plat) {
    case 'linux': {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME
      if (xdgConfigHome) {
        return join(xdgConfigHome, 'sple')
      }
      return join(home, '.config', 'sple')
    }

    case 'darwin': {
      return join(home, 'Library', 'Application Support', 'sple')
    }

    case 'win32': {
      const appData = process.env.APPDATA
      if (appData) {
        return join(appData, 'sple')
      }
      // Fallback to home/.sple on Windows if APPDATA is not set
      return join(home, '.sple')
    }

    default: {
      // Fallback for unknown platforms
      return join(home, '.sple')
    }
  }
}

/**
 * Get the full path to a config file in the sple config directory.
 *
 * Example: getConfigFilePath('tokens.json') returns ~/.config/sple/tokens.json on Linux
 */
export function getConfigFilePath(filename: string, plat?: Platform): string {
  const configDir = getConfigDir(plat)
  return join(configDir, filename)
}
