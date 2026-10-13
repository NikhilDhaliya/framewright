/** In-app agent system prompt (spec 06 §A4.1): serverInstructions + the skills section. */
import { BRANDED_SPEC } from '../mcp/brandedSpec'

/**
 * `serverInstructions` verbatim (no `# Projects (MCP)` section) apart from the rebrand in src/main/mcp/brandedSpec.ts,
 * which also points the Mac's "sign in to Palmier and subscribe" sentence at BYOK keys (lead decision for Linux).
 */
export const AGENT_INSTRUCTIONS: string = (() => {
  const base = BRANDED_SPEC.serverInstructions as string
  if (base.includes('sign in to Palmier')) throw new Error('serverInstructions changed: update the BYOK rewrite in mcp/brandedSpec.ts')
  return base
})()

export interface SkillIndexEntry {
  id: string
  description: string
}

/** Empty with no skills; otherwise `\n# Skills\n<playbook line>\n- <id>: <description>…` sorted by id, no trailing newline. */
export function skillsSection(index: SkillIndexEntry[]): string {
  if (!index.length) return ''
  const lines = [...index].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((s) => `- ${s.id}: ${s.description}`)
  return `\n# Skills\nPlaybooks for specific tasks. Before a task that matches one, call read_skill(id) to load its full procedure, then follow it.\n${lines.join('\n')}`
}

export const systemPrompt = (index: SkillIndexEntry[]): string => AGENT_INSTRUCTIONS + skillsSection(index)
