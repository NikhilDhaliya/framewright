import { tk } from './i18n'
/** Settings ▸ Skills (spec 05 §11.7, 02 §5): renderer view of `~/.framewright/skills` (Mac `~/.palmier/skills`) and the community catalog. */

export type SkillStatus = 'local' | 'community' | 'update' | 'modified'

export interface InstalledSkillView {
  id: string
  name: string
  description: string
  /** Absolute SKILL.md path. */
  path: string
  /** Folder with `~` for the home directory (delete confirmation). */
  displayDir: string
  status: SkillStatus
}

export interface CommunitySkillView {
  id: string
  name: string
  description: string
  /** Installed status, or 'available' when not installed. */
  status: SkillStatus | 'available'
}

export interface SkillsSnapshot {
  installed: InstalledSkillView[]
  community: CommunitySkillView[]
  catalog: 'unknown' | 'ok' | 'unavailable'
  /** Last catalog refresh error (Mac `SkillCatalog.lastError`), shown when no entries are available. */
  catalogError: string | null
  syncing: boolean
}

export type ExternalAgent = 'claude' | 'codex' | 'cursor'

export interface SkillsApi {
  list(): Promise<SkillsSnapshot>
  /** Waits for a running catalog sync, then returns a fresh snapshot. */
  waitSync(): Promise<SkillsSnapshot>
  /** Re-fetches the community catalog (and installs/updates per the sync rules). */
  refresh(): Promise<SkillsSnapshot>
  read(id: string): Promise<string | null>
  /** Creates a skill from raw SKILL.md text; returns the new id or an error. */
  create(raw: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>
  save(id: string, raw: string): Promise<{ ok: true } | { ok: false; error: string }>
  rename(id: string, name: string): Promise<{ ok: true } | { ok: false; error: string }>
  delete(id: string): Promise<boolean>
  /** Installs or updates a community skill. */
  install(id: string): Promise<boolean>
  showInFolder(id: string): void
  openFolder(): void
  addToExternal(id: string, agent: ExternalAgent): Promise<{ ok: true; path: string; displayPath: string } | { ok: false; error: string }>
}

/** Status column text (05 §11.7). */
export const STATUS_LABEL: Record<SkillStatus | 'available', string> = {
  local: tk('Local'),
  community: tk('Community'),
  update: tk('Update available'),
  modified: tk('Modified'),
  available: tk('Available'),
}

export const EXTERNAL_AGENT_LABEL: Record<ExternalAgent, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' }

export const NEW_SKILL_TEMPLATE = `---
name: New skill
description: Describe in one line when the assistant should use this skill.
---

## Workflow
1. First step.
2. Second step.
`
