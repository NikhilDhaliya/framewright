/** Settings ▸ Skills backend (spec 05 §11.7): snapshots, validation and "Add to External Agent" on top of SkillStore. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExternalAgent, SkillsSnapshot } from '../../shared/skills'
import { APP_SLUG } from '../../shared/brand'
import { requiredFields, uniqueSkillId, type SkillStore } from './skills'

export const externalHome = (): string => process.env.PALMIER_EXTERNAL_SKILLS_HOME || os.homedir()

/** `/home/me/x` → `~/x`. */
export function tildePath(p: string, home = os.homedir()): string {
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p
}

export function skillsSnapshot(store: SkillStore, home = os.homedir()): SkillsSnapshot {
  const installed = store.list().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    path: s.path,
    displayDir: tildePath(path.dirname(s.path), home),
    status: store.statusOf(s.id),
  }))
  const ids = new Set(installed.map((s) => s.id))
  const community = store.catalog.map((c) => ({ id: c.id, name: c.name, description: c.description, status: ids.has(c.id) ? store.statusOf(c.id) : ('available' as const) }))
  return { installed, community, catalog: store.catalogState, catalogError: store.catalogError, syncing: store.isSyncing }
}

export const SKILL_SAVE_ERROR = 'Add nonempty name and description fields to the skill frontmatter.'

/** Mac `SkillStore.save/createSkill`: the text must parse with a nonempty name and description; null = valid. */
export function validateSkillText(raw: string): string | null {
  return requiredFields(raw) ? null : SKILL_SAVE_ERROR
}

/** Creates a skill from raw text under the first free `new-skill`, `new-skill-2`, … id (Mac `createSkillFile` without a preferred id). */
export async function createSkillFromText(store: SkillStore, raw: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const error = validateSkillText(raw)
  if (error) return { ok: false, error }
  await store.reload()
  const taken = new Set(store.list().map((s) => s.id))
  const entries = await fs.readdir(store.dir).catch(() => [] as string[])
  for (const e of entries) taken.add(e)
  const created = await store.create(raw, uniqueSkillId('new-skill', taken))
  return created ? { ok: true, id: created } : { ok: false, error: SKILL_SAVE_ERROR }
}

const AGENT_DIR: Record<ExternalAgent, string> = { claude: '.claude', codex: '.codex', cursor: '.cursor' }

/** Copies the skill folder to `~/.<agent>/skills/framewright-<id>/` (Mac: `palmier-<id>`), replacing an older copy. */
export async function copyToExternalAgent(store: SkillStore, id: string, agent: ExternalAgent, home = externalHome()): Promise<{ ok: true; path: string; displayPath: string } | { ok: false; error: string }> {
  const skill = store.list().find((s) => s.id === id)
  if (!skill || !AGENT_DIR[agent]) return { ok: false, error: 'Unknown skill.' }
  const dest = path.join(home, AGENT_DIR[agent], 'skills', `${APP_SLUG}-${id}`)
  try {
    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(path.dirname(skill.path), dest, { recursive: true })
    return { ok: true, path: dest, displayPath: tildePath(dest, home) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
