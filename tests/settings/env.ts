// Throwaway XDG dirs (and HOME-relative skill targets) before app modules compute paths.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'palmier-settings-test-'))

for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DOCUMENTS_DIR']) {
  const dir = path.join(TEST_ROOT, key.toLowerCase())
  fs.mkdirSync(dir, { recursive: true })
  process.env[key] = dir
}
process.env.PALMIER_SKILLS_DIR = path.join(TEST_ROOT, 'skills')
process.env.PALMIER_EXTERNAL_SKILLS_HOME = path.join(TEST_ROOT, 'home')
