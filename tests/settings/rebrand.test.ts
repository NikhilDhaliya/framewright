import { TEST_ROOT } from './env'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEnvAliases } from '../../src/main/envAliases'
import { appDirs, defaultProjectsDir, migrateLegacyDirs } from '../../src/main/paths'
import { APP_ID, APP_NAME, APP_SLUG, ATTRIBUTION, REPO_URL } from '../../src/shared/brand'

const xdg = (key: string, ...rest: string[]) => path.join(TEST_ROOT, key, ...rest)

describe('rebrand to Framewright', () => {
  it('uses the Framewright identity and keeps the upstream attribution', () => {
    expect({ APP_NAME, APP_SLUG, APP_ID, REPO_URL }).toEqual({
      APP_NAME: 'Framewright',
      APP_SLUG: 'framewright',
      APP_ID: 'io.github.nikhildhaliya.framewright',
      REPO_URL: 'https://github.com/NikhilDhaliya/framewright',
    })
    expect(ATTRIBUTION).toBe('Based on Palmier Pro (GPLv3) by Palmier, Inc.')
    expect(appDirs.config).toBe(xdg('xdg_config_home', 'framewright'))
    expect(defaultProjectsDir).toBe(xdg('xdg_documents_dir', 'Framewright'))
  })

  it('moves pre-rebrand palmier-pro folders once, never over an existing Framewright folder', () => {
    fs.mkdirSync(xdg('xdg_config_home', 'palmier-pro'), { recursive: true })
    fs.writeFileSync(xdg('xdg_config_home', 'palmier-pro', 'settings.json'), '{"mcpPort":20001}')
    fs.mkdirSync(xdg('xdg_data_home', 'palmier-pro', 'Models'), { recursive: true })
    fs.mkdirSync(xdg('xdg_cache_home', 'palmier-pro'), { recursive: true })
    fs.mkdirSync(xdg('xdg_cache_home', 'framewright'), { recursive: true })

    const moved = migrateLegacyDirs({ skills: false })
    expect(moved).toHaveLength(2)
    expect(fs.readFileSync(path.join(appDirs.config, 'settings.json'), 'utf8')).toBe('{"mcpPort":20001}')
    expect(fs.existsSync(xdg('xdg_config_home', 'palmier-pro'))).toBe(false)
    expect(fs.existsSync(path.join(appDirs.data, 'Models'))).toBe(true)
    // Both exist: left alone.
    expect(fs.existsSync(xdg('xdg_cache_home', 'palmier-pro'))).toBe(true)
    expect(migrateLegacyDirs({ skills: false })).toEqual([])
  })

  it('exposes FRAMEWRIGHT_* variables under their PALMIER_* names unless set explicitly', () => {
    const env: NodeJS.ProcessEnv = { FRAMEWRIGHT_FAL_BASE_URL: 'http://a', FRAMEWRIGHT_LANG: 'de', PALMIER_LANG: 'fr' }
    applyEnvAliases(env)
    expect(env).toMatchObject({ PALMIER_FAL_BASE_URL: 'http://a', PALMIER_LANG: 'fr' })
  })
})
