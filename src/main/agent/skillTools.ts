/** In-app-only tools `read_skill` and `manage_skills` (spec 02 Appendix A; ToolExecutor+Skills.swift). */
import { ToolError, validateUnknownKeys, type Obj } from '../mcp/tools/args'
import { fail, ok, type ToolHandler, type ToolResult } from '../mcp/tools/context'
import { jsonString } from '../mcp/tools/json'
import { SKILL_LIMITS, skillContents, suggestedId, type Skill, type SkillStore } from './skills'

const P = 'manage_skills'

const str = (args: Obj, key: string): string | undefined => (typeof args[key] === 'string' && args[key] !== '' ? (args[key] as string) : undefined)

function optionalText(args: Obj, key: string, max: number, singleLine: boolean): string | undefined {
  if (!(key in args)) return undefined
  const raw = args[key]
  if (typeof raw !== 'string') throw new ToolError(`${P}.${key}: expected string`)
  const value = raw.trim()
  if (!value) throw new ToolError(`${P}.${key}: expected non-empty string`)
  if ([...value].length > max) throw new ToolError(`${P}.${key}: maximum length is ${max} characters`)
  if (singleLine && /[\n\r\u0085\u2028\u2029]/.test(value)) throw new ToolError(`${P}.${key}: expected one line`)
  return value
}

function requiredText(args: Obj, key: string, max: number, singleLine: boolean): string {
  const v = optionalText(args, key, max, singleLine)
  if (v === undefined) throw new ToolError(`${P}.${key}: expected non-empty string`)
  return v
}

function receipt(status: string, skill: Skill, changed?: string[]): ToolResult {
  const payload: Obj = { status, skill: { id: skill.id, name: skill.name, description: skill.description } }
  if (changed) payload.changed = changed
  return ok(jsonString(payload))
}

async function createSkill(store: SkillStore, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['action', 'name', 'description', 'instructions'], P)
  const name = requiredText(args, 'name', SKILL_LIMITS.name, true)
  const description = requiredText(args, 'description', SKILL_LIMITS.description, true)
  const instructions = requiredText(args, 'instructions', SKILL_LIMITS.instructions, false)
  const id = suggestedId(name)
  const existing = store.list().find((s) => s.id === id)
  if (existing) {
    if (existing.name !== name || existing.description !== description || store.body(id) !== instructions) {
      throw new ToolError(`A skill with id '${id}' already exists. Use manage_skills with action='update'.`)
    }
    return receipt('unchanged', existing)
  }
  const created = await store.create(skillContents(name, description, instructions), id)
  const skill = created ? store.list().find((s) => s.id === created) : undefined
  if (!skill) throw new ToolError(`Could not create skill '${name}'.`)
  return receipt('created', skill)
}

async function updateSkill(store: SkillStore, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['action', 'id', 'name', 'description', 'instructions'], P)
  const id = str(args, 'id')
  if (!id) throw new ToolError(`${P}.id: expected non-empty string for update`)
  const name = optionalText(args, 'name', SKILL_LIMITS.name, true)
  const description = optionalText(args, 'description', SKILL_LIMITS.description, true)
  const instructions = optionalText(args, 'instructions', SKILL_LIMITS.instructions, false)
  if (name === undefined && description === undefined && instructions === undefined) {
    throw new ToolError(`${P} update requires at least one of: name, description, instructions.`)
  }
  const skill = store.list().find((s) => s.id === id)
  if (!skill) throw new ToolError(`Unknown skill: ${id}`)
  const changed: string[] = []
  if (name !== undefined && name !== skill.name) changed.push('name')
  if (description !== undefined && description !== skill.description) changed.push('description')
  if (instructions !== undefined && instructions !== store.body(id)) changed.push('instructions')
  if (!changed.length) return receipt('unchanged', skill)
  const result = await store.update(skill, { name, description, instructions })
  if (!result) throw new ToolError(`Could not update skill '${id}'.`)
  return result.status === 'updated' ? receipt('updated', result.skill, changed) : receipt('unchanged', result.skill)
}

async function removeSkill(store: SkillStore, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['action', 'id'], P)
  const id = str(args, 'id')
  if (!id) throw new ToolError(`${P}.id: expected non-empty string for remove`)
  const skill = store.list().find((s) => s.id === id)
  if (!skill) throw new ToolError(`Unknown skill: ${id}`)
  if (!(await store.delete(skill))) throw new ToolError(`Could not remove skill '${id}'.`)
  return ok(jsonString({ status: 'removed', id: skill.id, name: skill.name }))
}

export function skillToolHandlers(store: SkillStore): Record<string, ToolHandler> {
  return {
    read_skill: (_env, args) => {
      const id = str(args, 'id')
      if (!id) return fail("read_skill requires an 'id'.")
      const body = store.body(id)
      return body === undefined ? fail(`Unknown skill: ${id}`) : ok(body)
    },
    manage_skills: async (_env, args) => {
      const action = str(args, 'action')
      switch (action) {
        case 'create':
          return createSkill(store, args)
        case 'update':
          return updateSkill(store, args)
        case 'remove':
          return removeSkill(store, args)
        case undefined:
          throw new ToolError(`${P}.action: expected one of: create, update, remove`)
        default:
          throw new ToolError(`Unknown skill action '${action}'. Expected one of: create, update, remove.`)
      }
    },
  }
}
