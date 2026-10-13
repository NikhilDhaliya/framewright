/**
 * Agent skills (spec 06 §A13, 02 §5): ~/.framewright/skills/<id>/SKILL.md (Mac: ~/.framewright/skills), the install ledger and the
 * community catalog sync. Mutations run one at a time through a promise chain.
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillsHome } from '../paths'
import type { SkillIndexEntry } from './instructions'

export const SKILL_LIMITS = { name: 120, description: 500, instructions: 50_000 } as const
const DEFAULT_CATALOG_BASE = 'https://raw.githubusercontent.com/palmier-io/palmier-skills/main'

export interface Skill {
  id: string
  name: string
  description: string
  /** SKILL.md path */
  path: string
}

export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  sha: string
  path: string
}

interface Ledger {
  installed: Record<string, string>
  suppressed: Set<string>
}

export const defaultSkillsDir = (): string => process.env.PALMIER_SKILLS_DIR || skillsHome()

export const sha12 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex').slice(0, 12)

// ---------- SKILL.md frontmatter (SkillFrontmatter) ----------

export function skillContents(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${instructions}`
}

export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {}
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { fields, body: text }
  let i = 1
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon >= 0) {
      const key = line.slice(0, colon).trim()
      let value = line.slice(colon + 1).trim()
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (key) fields[key] = value
    }
    i++
  }
  const body = i + 1 < lines.length ? lines.slice(i + 1).join('\n').trim() : ''
  return { fields, body }
}

export function requiredFields(text: string): { name: string; description: string; body: string } | null {
  const { fields, body } = parseFrontmatter(text)
  const name = fields.name
  const description = fields.description
  if (!name?.trim() || !description?.trim()) return null
  return { name, description, body }
}

/** Patches frontmatter fields in place; `instructions` replaces the whole body. */
export function replacingFields(text: string, patch: { name?: string; description?: string; instructions?: string }): string {
  const lines = text.split('\n')
  let closing = lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1
  if (closing < 0) {
    const parsed = parseFrontmatter(text)
    return skillContents(
      patch.name ?? parsed.fields.name ?? 'New skill',
      patch.description ?? parsed.fields.description ?? 'Describe when to use this skill.',
      patch.instructions ?? parsed.body,
    )
  }
  const replace = (key: string, value: string) => {
    let found = -1
    for (let i = 1; i < closing; i++) {
      const colon = lines[i].indexOf(':')
      if (colon >= 0 && lines[i].slice(0, colon).trim() === key) {
        found = i
        break
      }
    }
    if (found >= 0) lines[found] = `${key}: ${value}`
    else {
      lines.splice(closing, 0, `${key}: ${value}`)
      closing++
    }
  }
  if (patch.name !== undefined) replace('name', patch.name)
  if (patch.description !== undefined) replace('description', patch.description)
  if (patch.instructions === undefined) return lines.join('\n')
  return lines.slice(0, closing + 1).join('\n') + '\n\n' + patch.instructions
}

/** suggestedID: lowercase, split on non-alphanumerics, join with `-`, ≤ 64 chars, trim `-`; empty → new-skill. */
export function suggestedId(name: string): string {
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const candidate = [...words.join('-')].slice(0, 64).join('').replace(/^-+|-+$/g, '')
  return candidate || 'new-skill'
}

export const isValidSkillId = (id: string): boolean => !!id && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\')

/** shouldAutomaticallyInstall: never suppressed; absent → only if never installed; present → only unmodified and outdated. */
export function shouldAutomaticallyInstall(localSha: string | undefined, installedSha: string | undefined, catalogSha: string, suppressed: boolean): boolean {
  if (suppressed) return false
  if (localSha === undefined) return installedSha === undefined
  if (installedSha === undefined) return false
  return localSha === installedSha && installedSha !== catalogSha
}

/** Settings ▸ Skills status of an installed skill (05 §11.7): no ledger entry → local; edited since install → modified. */
export function skillStatus(localSha: string | undefined, installedSha: string | undefined, catalogSha: string | undefined): 'local' | 'community' | 'update' | 'modified' {
  if (localSha === undefined || installedSha === undefined) return 'local'
  if (localSha !== installedSha) return 'modified'
  return catalogSha !== undefined && catalogSha !== installedSha ? 'update' : 'community'
}

/** First free id: `base`, then `base-2`, `base-3`, … (`taken` = existing ids). */
export function uniqueSkillId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

export function decodeLedger(text: string): Ledger | null {
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object' && v.version === 1 && v.installed && typeof v.installed === 'object' && Array.isArray(v.suppressed)) {
      return { installed: { ...v.installed }, suppressed: new Set(v.suppressed.filter((s: unknown) => typeof s === 'string')) }
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')) return { installed: { ...v }, suppressed: new Set() }
  } catch {
    // fall through
  }
  return null
}

const isCatalogEntry = (e: SkillCatalogEntry): e is SkillCatalogEntry =>
  !!e && typeof e.id === 'string' && typeof e.sha === 'string' && typeof e.path === 'string' && typeof e.name === 'string' && typeof e.description === 'string'

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

export interface SkillStoreOptions {
  dir?: string
  /** Catalog base URL (env PALMIER_SKILLS_BASE); `file://` bases are read from disk. */
  catalogBase?: string
  /** Where `skills-catalog.json` is cached. */
  cacheFile?: string
  fetchImpl?: typeof fetch
}

export class SkillStore {
  readonly dir: string
  private skills: Skill[] = []
  private bodies = new Map<string, string>()
  private shas = new Map<string, string>()
  private ledger: Ledger | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private syncing: Promise<void> | null = null
  catalog: SkillCatalogEntry[] = []
  /** Catalog fetch state for Settings ▸ Skills: never tried, loaded (live or cached), or unavailable. */
  catalogState: 'unknown' | 'ok' | 'unavailable' = 'unknown'
  catalogError: string | null = null

  constructor(private readonly opts: SkillStoreOptions = {}) {
    this.dir = opts.dir ?? defaultSkillsDir()
  }

  private get catalogBase(): string {
    return (this.opts.catalogBase ?? process.env.PALMIER_SKILLS_BASE ?? DEFAULT_CATALOG_BASE).replace(/\/+$/, '')
  }

  list(): Skill[] {
    return this.skills
  }
  body(id: string): string | undefined {
    return this.bodies.get(id)
  }
  index(): SkillIndexEntry[] {
    return this.skills.map((s) => ({ id: s.id, description: s.description }))
  }

  /** One mutation at a time (SkillStore.serializeMutation). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async scan(): Promise<void> {
    const skills: Skill[] = []
    const bodies = new Map<string, string>()
    const shas = new Map<string, string>()
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      if (ent.name.startsWith('.') && !ent.isDirectory()) continue
      const md = path.join(this.dir, ent.name, 'SKILL.md')
      const bytes = await fs.readFile(md).catch(() => null)
      if (!bytes) continue
      const parsed = requiredFields(bytes.toString('utf8'))
      if (!parsed) continue
      skills.push({ id: ent.name, name: parsed.name, description: parsed.description, path: md })
      bodies.set(ent.name, parsed.body)
      shas.set(ent.name, sha12(bytes))
    }
    skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    this.skills = skills
    this.bodies = bodies
    this.shas = shas
    const ledgerFile = path.join(this.dir, '.installed.json')
    const text = await fs.readFile(ledgerFile, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : null))
    if (text === '') this.ledger = { installed: {}, suppressed: new Set() }
    else if (text !== null) this.ledger = decodeLedger(text) ?? this.ledger
  }

  /** Rescans the folder (once per agent run). */
  reload(): Promise<void> {
    return this.serialize(() => this.scan())
  }

  private async persistLedger(ledger: Ledger): Promise<void> {
    const json = JSON.stringify({ installed: ledger.installed, suppressed: [...ledger.suppressed].sort(), version: 1 })
    await writeAtomic(path.join(this.dir, '.installed.json'), json)
  }

  /** Starts the launch-time catalog sync once; later calls return the same promise. */
  startSync(): Promise<void> {
    this.syncing ??= this.performSync()
      .catch((e) => console.error(`[skills] sync failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  get isSyncing(): boolean {
    return this.syncing !== null
  }

  /** Status shown in Settings ▸ Skills for an installed skill id. */
  statusOf(id: string): 'local' | 'community' | 'update' | 'modified' {
    return skillStatus(this.shas.get(id), this.ledger?.installed[id], this.catalog.find((c) => c.id === id)?.sha)
  }

  /** Raw SKILL.md text of an installed skill. */
  async readRaw(id: string): Promise<string | null> {
    const skill = this.skills.find((s) => s.id === id)
    return skill ? fs.readFile(skill.path, 'utf8').catch(() => null) : null
  }

  /** Replaces SKILL.md of an installed skill; the text must keep a name and description. */
  saveRaw(id: string, raw: string): Promise<Skill | null> {
    if (!requiredFields(raw)) return Promise.resolve(null)
    return this.serialize(async () => {
      const skill = this.skills.find((s) => s.id === id)
      if (!skill) return null
      await writeAtomic(skill.path, raw)
      await this.scan()
      return this.skills.find((s) => s.id === id) ?? null
    }).catch(() => null)
  }

  /** Resolves when a running sync finishes (immediately when none is running). */
  async waitForSync(): Promise<void> {
    await this.syncing
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    if (url.startsWith('file:')) return fs.readFile(fileURLToPath(url))
    const res = await (this.opts.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(30_000) })
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`)
    return Buffer.from(await res.arrayBuffer())
  }

  private async performSync(): Promise<void> {
    await this.reload()
    if (!this.ledger) return
    try {
      const bytes = await this.fetchBytes(`${this.catalogBase}/catalog.json`)
      const parsed = JSON.parse(bytes.toString('utf8'))
      if (!Array.isArray(parsed)) throw new Error('catalog.json is not an array')
      this.catalog = parsed.filter(isCatalogEntry)
      if (this.opts.cacheFile) await writeAtomic(this.opts.cacheFile, bytes).catch(() => undefined)
      this.catalogState = 'ok'
      this.catalogError = null
    } catch (e) {
      this.catalogError = e instanceof Error ? e.message : String(e)
      console.error(`[skills] catalog refresh failed (${this.catalogBase}): ${e instanceof Error ? e.message : String(e)}`)
      const cached = await this.cachedCatalog()
      if (cached) {
        this.catalog = cached
        this.catalogState = 'ok'
      } else if (!this.catalog.length) this.catalogState = 'unavailable'
      return
    }
    for (const entry of this.catalog) {
      if (this.autoInstalls(entry)) await this.install(entry, true)
    }
  }

  private async cachedCatalog(): Promise<SkillCatalogEntry[] | null> {
    if (!this.opts.cacheFile) return null
    try {
      const parsed = JSON.parse(await fs.readFile(this.opts.cacheFile, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isCatalogEntry) : null
    } catch {
      return null
    }
  }

  private autoInstalls(entry: SkillCatalogEntry): boolean {
    if (!this.ledger) return false
    return shouldAutomaticallyInstall(this.shas.get(entry.id), this.ledger.installed[entry.id], entry.sha, this.ledger.suppressed.has(entry.id))
  }

  async install(entry: SkillCatalogEntry, automatically = false): Promise<boolean> {
    if (!this.ledger || !isValidSkillId(entry.id)) return false
    const dir = path.join(this.dir, entry.id)
    try {
      const data = await this.fetchBytes(`${this.catalogBase}/${entry.path}`)
      if (sha12(data) !== entry.sha || !requiredFields(data.toString('utf8'))) return false
      return await this.serialize(async () => {
        if (automatically) {
          await this.scan()
          if (!this.autoInstalls(entry)) return false
        }
        if (!this.ledger) return false
        await writeAtomic(path.join(dir, 'SKILL.md'), data)
        await this.scan()
        if (!this.skills.some((s) => s.id === entry.id)) {
          await fs.rm(dir, { recursive: true, force: true })
          return false
        }
        const ledger: Ledger = { installed: { ...this.ledger.installed, [entry.id]: entry.sha }, suppressed: new Set(this.ledger.suppressed) }
        ledger.suppressed.delete(entry.id)
        await this.persistLedger(ledger)
        this.ledger = ledger
        return true
      })
    } catch (e) {
      console.error(`[skills] install ${entry.id} failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /** Writes a new skill; an existing folder with identical contents is reused, different contents fail. */
  create(raw: string, preferredId: string): Promise<string | null> {
    if (!requiredFields(raw) || !isValidSkillId(preferredId)) return Promise.resolve(null)
    return this.serialize(async () => {
      const md = path.join(this.dir, preferredId, 'SKILL.md')
      const existing = await fs.readFile(md, 'utf8').catch(() => null)
      if (existing !== null && existing !== raw) return null
      if (existing === null) await writeAtomic(md, raw)
      await this.scan()
      return preferredId
    }).catch(() => null)
  }

  update(skill: Skill, patch: { name?: string; description?: string; instructions?: string }): Promise<{ status: 'updated' | 'unchanged'; skill: Skill } | null> {
    return this.serialize(async () => {
      const raw = await fs.readFile(skill.path, 'utf8')
      const updated = replacingFields(raw, patch)
      const changed = updated !== raw
      if (changed) await writeAtomic(skill.path, updated)
      await this.scan()
      const saved = this.skills.find((s) => s.id === skill.id)
      return saved ? { status: changed ? ('updated' as const) : ('unchanged' as const), skill: saved } : null
    }).catch(() => null)
  }

  /** Deletes the folder and suppresses the id so the catalog does not reinstall it. */
  delete(skill: Skill): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.ledger) return false
      const original = this.ledger
      const ledger: Ledger = { installed: { ...original.installed }, suppressed: new Set(original.suppressed) }
      delete ledger.installed[skill.id]
      ledger.suppressed.add(skill.id)
      await this.persistLedger(ledger)
      this.ledger = ledger
      try {
        await fs.rm(path.dirname(skill.path), { recursive: true })
      } catch (e) {
        await this.persistLedger(original).catch(() => undefined)
        this.ledger = original
        throw e
      }
      await this.scan()
      return true
    }).catch(() => false)
  }
}
