/** manage_project (MCP only): list, open, create, or close projects and rebind this session. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROJECT } from '../../../core/model'
import { activeTimeline } from '../../../core/ops/context'
import { applyTimelineSettings } from '../../../core/ops/project'
import { listRecentProjects } from '../../project/registry'
import type { ProjectSession } from '../../project/session'
import { ToolError, lenient, validateUnknownKeys, type Obj } from './args'
import { fail, ok, okRawJson, type ToolResult } from './context'
import type { ToolExecutor } from './executor'
import { canGenerate } from './generation'
import { jsonString } from './json'
import { idUniverse, shortIdMap, shortenText } from './shortIds'
import { resolveSettings, validateProjectSettings } from './timeline'
import { timelineEntries } from './timelineView'

type Selector = { kind: 'name' | 'id' | 'path'; value: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir())
const samePath = (a: string, b: string) => path.resolve(a).replace(/\/+$/, '') === path.resolve(b).replace(/\/+$/, '')

function selector(args: Obj, at: string): Selector | null {
  const supplied = (['name', 'id', 'path'] as const).filter((k) => k in args)
  if (supplied.length > 1) throw new ToolError(`${at}: provide only one of: name, id, path.`)
  const key = supplied[0]
  if (!key) return null
  const value = lenient.string(args, key)
  if (!value?.trim()) throw new ToolError(`${at}: '${key}' must be a non-empty string.`)
  if (key === 'id' && !UUID_RE.test(value)) throw new ToolError(`${at}: 'id' must be a project id returned by action='list'.`)
  return { kind: key, value }
}

async function resolvePath(sel: Selector): Promise<string> {
  if (sel.kind === 'path') return path.resolve(expandHome(sel.value))
  const known = await listRecentProjects()
  if (sel.kind === 'id') {
    const hit = known.find((p) => p.id.toUpperCase() === sel.value.toUpperCase())
    if (!hit) throw new ToolError(`No project with id ${sel.value.toUpperCase()}. Call manage_project with action='list' for valid ids.`)
    return hit.path
  }
  const matches = known.filter((p) => p.name.toLowerCase() === sel.value.toLowerCase())
  if (matches.length === 1) return matches[0].path
  if (!matches.length) {
    const names = known.slice(0, 15).map((p) => p.name)
    throw new ToolError(`No project named '${sel.value}'. Known projects: ${names.join(', ')}. Call manage_project with action='list' for the full list.`)
  }
  throw new ToolError(`${matches.length} projects are named '${sel.value}'. Pick one by path: ${matches.map((p) => p.path).join(', ')}`)
}

const nameAndPath = (s: ProjectSession) => ({ name: s.name || PROJECT.defaultProjectName, path: s.path })

function snapshotResult(exec: ToolExecutor, session: ProjectSession, status: string): ToolResult {
  const doc = session.doc
  const t = activeTimeline(doc)
  const payload = {
    status,
    name: session.name || PROJECT.defaultProjectName,
    path: session.path,
    fps: t.fps,
    resolution: `${t.width}x${t.height}`,
    mediaCount: doc.manifest.entries.length,
    canGenerate: canGenerate(exec.app),
    timelines: timelineEntries(doc),
    openCount: exec.app.sessions.all().length,
  }
  return ok(shortenText(jsonString(payload), shortIdMap(idUniverse(doc))))
}

function nowEditing(exec: ToolExecutor, session: ProjectSession): void {
  exec.app.ui(session, { type: 'toast', message: `Now editing: ${session.name || PROJECT.defaultProjectName}` })
}

async function list(exec: ToolExecutor, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, [], "manage_project action='list'")
  const open = exec.app.sessions.all()
  const active = exec.session
  const visible = exec.app.sessions.focused()
  const projects = (await listRecentProjects()).map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    isOpen: open.some((s) => samePath(s.path, p.path)),
    isActive: !!active && samePath(active.path, p.path),
    isVisible: !!visible && samePath(visible.path, p.path),
    isAccessible: p.accessible,
  }))
  const payload: Obj = { openCount: open.length, projects }
  if (active) payload.active = nameAndPath(active)
  if (visible) payload.visible = nameAndPath(visible)
  return okRawJson(payload)
}

async function open(exec: ToolExecutor, args: Obj): Promise<ToolResult> {
  const at = "manage_project action='open'"
  validateUnknownKeys(args, ['name', 'id', 'path'], at)
  const sel = selector(args, at)
  if (!sel) throw new ToolError(`${at} needs a name, an id from action='list', or a path.`)
  const file = await resolvePath(sel)
  if (!(await fs.stat(file).catch(() => null))) throw new ToolError(`No project at ${file}.`)
  const session = await exec.app.sessions.openPath(file)
  exec.bind(session)
  nowEditing(exec, session)
  return snapshotResult(exec, session, 'active')
}

async function uniqueName(exec: ToolExecutor, base: string): Promise<string> {
  const dir = exec.app.settings().projectsDirectory
  const taken = async (n: string) => !!(await fs.stat(path.join(dir, `${n}.${PROJECT.fileExtension}`)).catch(() => null))
  if (!(await taken(base))) return base
  for (let n = 2; ; n++) if (!(await taken(`${base} ${n}`))) return `${base} ${n}`
}

async function create(exec: ToolExecutor, args: Obj): Promise<ToolResult> {
  validateUnknownKeys(args, ['name', 'fps', 'aspectRatio', 'quality'], "manage_project action='create'")
  if ('name' in args && typeof args.name !== 'string') throw new ToolError("manage_project action='create': 'name' must be a string.")
  const settingsArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k === 'fps' || k === 'aspectRatio' || k === 'quality'))
  const settings = Object.keys(settingsArgs).length ? resolveSettings(validateProjectSettings(settingsArgs), { fps: 30, width: 1920, height: 1080 }) : null
  const session = await exec.app.sessions.create(await uniqueName(exec, (args.name as string | undefined) ?? PROJECT.defaultProjectName))
  exec.bind(session)
  if (settings) {
    session.transact('Set Project Settings', (d) => applyTimelineSettings(d, settings.fps, settings.width, settings.height), false)
    await session.save()
  }
  nowEditing(exec, session)
  return snapshotResult(exec, session, 'created')
}

async function close(exec: ToolExecutor, args: Obj): Promise<ToolResult> {
  const at = "manage_project action='close'"
  validateUnknownKeys(args, ['name', 'id', 'path'], at)
  const sel = selector(args, at)
  let target: ProjectSession
  if (sel) {
    const file = await resolvePath(sel)
    const found = exec.app.sessions.all().find((s) => samePath(s.path, file))
    if (!found) throw new ToolError(`Project at ${file} isn't open.`)
    target = found
  } else {
    const active = exec.session
    if (!active) throw new ToolError('No project is open.')
    target = active
  }
  const name = target.name || PROJECT.defaultProjectName
  const wasActive = exec.session === target
  try {
    if (exec.app.sessions.close) await exec.app.sessions.close(target)
    else await target.close()
  } catch (e) {
    throw new ToolError(`Couldn't save '${name}' — project left open. ${e instanceof Error ? e.message : String(e)}`)
  }
  if (wasActive) exec.bind(null)
  const payload: Obj = { status: 'closed', name, openCount: exec.app.sessions.all().length }
  const active = exec.session
  const visible = exec.app.sessions.focused()
  if (active) payload.active = nameAndPath(active)
  if (visible) payload.visible = nameAndPath(visible)
  return okRawJson(payload)
}

export async function manageProject(exec: ToolExecutor, args: Obj): Promise<ToolResult> {
  try {
    validateUnknownKeys(args, ['action', 'name', 'id', 'path', 'fps', 'aspectRatio', 'quality'], 'manage_project')
    const action = lenient.string(args, 'action')
    if (!action) throw new ToolError("manage_project requires an 'action'.")
    const rest = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'action'))
    switch (action) {
      case 'list':
        return await list(exec, rest)
      case 'open':
        return await open(exec, rest)
      case 'create':
        return await create(exec, rest)
      case 'close':
        return await close(exec, rest)
      default:
        throw new ToolError(`Unknown project action '${action}'. Use one of: list, open, create, close.`)
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
