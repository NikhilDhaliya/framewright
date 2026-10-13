import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_NAME, APP_SLUG, LEGACY_SLUG } from '../shared/brand'

const home = os.homedir()

function xdg(variable: string, fallback: string): string {
  const value = process.env[variable]
  return value && path.isAbsolute(value) ? value : path.join(home, fallback)
}

/** The desktop's Documents folder: $XDG_DOCUMENTS_DIR, else user-dirs.dirs (what `xdg-user-dir DOCUMENTS` reads), else ~/Documents. */
function documentsDir(configHome: string): string {
  const env = process.env.XDG_DOCUMENTS_DIR
  if (env && path.isAbsolute(env)) return env
  try {
    const text = readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8')
    const m = /^XDG_DOCUMENTS_DIR="([^"]+)"/m.exec(text)
    const dir = m?.[1].replace(/^\$HOME/, home)
    if (dir && path.isAbsolute(dir) && dir !== home) return dir
  } catch {
    // No user-dirs config.
  }
  return path.join(home, 'Documents')
}

const configHome = xdg('XDG_CONFIG_HOME', '.config')

const bases = {
  config: configHome,
  data: xdg('XDG_DATA_HOME', '.local/share'),
  cache: xdg('XDG_CACHE_HOME', '.cache'),
  state: xdg('XDG_STATE_HOME', '.local/state'),
}

export const appDirs = {
  config: path.join(bases.config, APP_SLUG),
  data: path.join(bases.data, APP_SLUG),
  cache: path.join(bases.cache, APP_SLUG),
  /** Crash log and crash dumps (spec 01 §2.2). */
  state: path.join(bases.state, APP_SLUG),
}

export const defaultProjectsDir = path.join(documentsDir(configHome), APP_NAME)

/** Skills folder (spec 06 §A13): `~/.framewright/skills` (the Mac uses `~/.framewright/skills`). */
export const skillsHome = (): string => path.join(home, `.${APP_SLUG}`, 'skills')
const legacySkillsHome = (): string => path.join(home, '.palmier', 'skills')

/**
 * One-time rebrand migration: moves the pre-rebrand `palmier-pro` XDG directories (and `~/.palmier/skills`) to
 * their Framewright names when the new one doesn't exist yet. Never merges or overwrites; returns what moved.
 */
export function migrateLegacyDirs(opts: { skills?: boolean } = {}): string[] {
  const moves: [string, string][] = (Object.keys(bases) as (keyof typeof bases)[]).map((k) => [path.join(bases[k], LEGACY_SLUG), appDirs[k]])
  if (opts.skills !== false) moves.push([legacySkillsHome(), skillsHome()])
  const moved: string[] = []
  for (const [from, to] of moves) {
    try {
      if (!existsSync(from) || existsSync(to)) continue
      mkdirSync(path.dirname(to), { recursive: true })
      renameSync(from, to)
      moved.push(`${from} -> ${to}`)
    } catch {
      // Cross-device or permission problem: leave the old folder in place and start fresh.
    }
  }
  return moved
}
