/**
 * Bundled resource lookup (spec 07 §0.1): one resolver for dev (`<repo>/resources`) and packaged builds
 * (`<app.asar>/resources`, with `.asar.unpacked` for executables). Override with `PALMIER_RESOURCES`.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

let cached: string | null = null

export function resourcesRoot(): string {
  if (cached) return cached
  const env = process.env.PALMIER_RESOURCES
  if (env && existsSync(env)) return (cached = env)
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'resources')
    if (existsSync(path.join(candidate, 'models')) || existsSync(path.join(candidate, 'icon.png'))) return (cached = candidate)
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return (cached = path.join(process.cwd(), 'resources'))
}

/** Absolute path of a bundled resource; executables are mapped to the unpacked asar copy. */
export function resourcePath(...parts: string[]): string {
  const p = path.join(resourcesRoot(), ...parts)
  const unpacked = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  return unpacked !== p && existsSync(unpacked) ? unpacked : p
}
