import { test } from 'node:test'
import * as assert from 'node:assert'
import { getConfigDir, getConfigFilePath } from '../../../src/core/config/paths.js'

test('config paths', async (t) => {
  // Save original env
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
  const originalAppData = process.env.APPDATA

  await t.test('linux', async (t) => {
    await t.test('uses XDG_CONFIG_HOME when set', () => {
      process.env.XDG_CONFIG_HOME = '/custom/xdg'
      const dir = getConfigDir('linux')
      assert.strictEqual(dir, '/custom/xdg/sple')
    })

    await t.test('falls back to ~/.config/sple when XDG_CONFIG_HOME not set', () => {
      delete process.env.XDG_CONFIG_HOME
      const dir = getConfigDir('linux')
      assert.match(dir, /\.config[/\\]sple$/)
    })

    await t.test('getConfigFilePath works on linux', () => {
      process.env.XDG_CONFIG_HOME = '/custom/xdg'
      const path = getConfigFilePath('tokens.json', 'linux')
      assert.strictEqual(path, '/custom/xdg/sple/tokens.json')
    })
  })

  await t.test('darwin', async (t) => {
    await t.test('uses ~/Library/Application Support/sple', () => {
      const dir = getConfigDir('darwin')
      assert.match(dir, /Library[/\\]Application Support[/\\]sple$/)
    })

    await t.test('getConfigFilePath works on darwin', () => {
      const path = getConfigFilePath('.env', 'darwin')
      assert.match(path, /Library[/\\]Application Support[/\\]sple[/\\]\.env$/)
    })
  })

  await t.test('win32', async (t) => {
    await t.test('uses %APPDATA%/sple when APPDATA is set', () => {
      process.env.APPDATA = 'C:\\Users\\TestUser\\AppData\\Roaming'
      const dir = getConfigDir('win32')
      assert.ok(dir.includes('AppData') && dir.includes('Roaming') && dir.includes('sple'))
    })

    await t.test('falls back to home/.sple when APPDATA not set', () => {
      delete process.env.APPDATA
      const dir = getConfigDir('win32')
      assert.match(dir, /\.sple$/)
    })

    await t.test('getConfigFilePath works on win32', () => {
      process.env.APPDATA = 'C:\\Users\\TestUser\\AppData\\Roaming'
      const path = getConfigFilePath('config.json', 'win32')
      assert.ok(
        path.includes('AppData') &&
          path.includes('Roaming') &&
          path.includes('sple') &&
          path.endsWith('config.json')
      )
    })
  })

  await t.test('path structure', async (t) => {
    await t.test('returns absolute paths', () => {
      const linuxPath = getConfigDir('linux')
      const darwinPath = getConfigDir('darwin')
      const win32Path = getConfigDir('win32')

      // Linux and darwin start with / (absolute)
      // Windows paths contain drive letter or UNC path
      assert.ok(
        linuxPath.startsWith('/') || linuxPath.includes(':'),
        'linux path should be absolute'
      )
      assert.ok(
        darwinPath.startsWith('/') || darwinPath.includes(':'),
        'darwin path should be absolute'
      )
      assert.ok(
        win32Path.includes(':') || win32Path.startsWith('/'),
        'win32 path should be absolute'
      )
    })

    await t.test('file paths include directory separator', () => {
      const filePath = getConfigFilePath('test.json', 'linux')
      assert.match(filePath, /sple[/\\]test\.json$/)
    })
  })

  // Restore original env
  process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  process.env.APPDATA = originalAppData
})
