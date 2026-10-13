import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PROJECT } from '../../core/model'
import { appDirs, defaultProjectsDir } from '../paths'
import { exists } from './packageIO'

const REF_EPOCH = 978307200
const toRef = (d: Date) => d.getTime() / 1000 - REF_EPOCH
const fromRef = (r: number) => new Date((r + REF_EPOCH) * 1000)

interface ProjectEntry {
  id: string
  url: string
  createdDate: number
  lastOpenedDate: number
}

export interface RecentProject {
  id: string
  path: string
  name: string
  createdAt: string
  lastOpenedAt: string
  accessible: boolean
  thumbnailPath: string | null
}

const registryPath = path.join(appDirs.data, PROJECT.registryFilename)

function normalize(p: string): string {
  return path.resolve(p).replace(/\/+$/, '')
}

function entryPath(e: ProjectEntry): string | null {
  try {
    return normalize(fileURLToPath(e.url))
  } catch {
    return null
  }
}

let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

async function load(): Promise<ProjectEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(registryPath, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((e) => e && typeof e.id === 'string' && typeof e.url === 'string' && typeof e.createdDate === 'number' && typeof e.lastOpenedDate === 'number')
  } catch {
    return importMacRegistry()
  }
}

async function importMacRegistry(): Promise<ProjectEntry[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(defaultProjectsDir, PROJECT.registryFilename), 'utf8'))
    return Array.isArray(raw) ? raw.filter((e) => typeof e?.url === 'string' && entryPath(e)?.startsWith('/home')) : []
  } catch {
    return []
  }
}

async function save(entries: ProjectEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true })
  const tmp = `${registryPath}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(entries))
  await fs.rename(tmp, registryPath)
}

export function registerProject(p: string): Promise<void> {
  return serialized(async () => {
    const entries = await load()
    const target = normalize(p)
    const now = toRef(new Date())
    const existing = entries.find((e) => entryPath(e) === target)
    if (existing) existing.lastOpenedDate = now
    else entries.push({ id: randomUUID().toUpperCase(), url: pathToFileURL(target + '/').href, createdDate: now, lastOpenedDate: now })
    await save(entries)
  })
}

export function updateProjectPath(oldPath: string, newPath: string): Promise<void> {
  return serialized(async () => {
    const entries = await load()
    const e = entries.find((x) => entryPath(x) === normalize(oldPath))
    if (!e) return
    e.url = pathToFileURL(normalize(newPath) + '/').href
    e.lastOpenedDate = toRef(new Date())
    await save(entries)
  })
}

export function removeProject(p: string): Promise<void> {
  return serialized(async () => {
    const entries = await load()
    await save(entries.filter((e) => entryPath(e) !== normalize(p)))
  })
}

export async function projectIdFor(p: string): Promise<string | null> {
  const entries = await load()
  return entries.find((e) => entryPath(e) === normalize(p))?.id ?? null
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const entries = await load()
  const out = await Promise.all(
    entries.map(async (e): Promise<RecentProject | null> => {
      const p = entryPath(e)
      if (!p) return null
      const accessible = await exists(path.join(p, PROJECT.timelineFilename))
      const thumb = path.join(p, PROJECT.thumbnailFilename)
      return {
        id: e.id,
        path: p,
        name: path.basename(p).replace(/\.palmier$/i, ''),
        createdAt: fromRef(e.createdDate).toISOString(),
        lastOpenedAt: fromRef(e.lastOpenedDate).toISOString(),
        accessible,
        thumbnailPath: accessible && (await exists(thumb)) ? thumb : null,
      }
    }),
  )
  return out.filter((x): x is RecentProject => !!x).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
}
