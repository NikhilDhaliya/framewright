import { EditRefusal } from '../../../core/timeline'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import type { ProjectSession } from '../../project/session'
import type { AppContext } from '../../services'
import { ToolError, isObj, type Obj } from './args'
import { fail, type FeedbackState, type ToolHandler, type ToolResult } from './context'
import { CHANGE_PUBLISHERS, MCP_TOOL_NAMES, READ_ONLY_TOOLS } from './definitions'
import { manageProject } from './projects'
import { TOOL_HANDLERS } from './registry'
import { expandIds, idUniverse, shortIdMap, shortenText } from './shortIds'
import { changeActivity, readActivity } from './agentActivity'
import { withEditOrigin } from '../../project/editOrigin'
import type { AgentReadHighlight } from '../../../shared/api'
import { APP_NAME } from '../../../shared/brand'

/** Edits to one project run one at a time across all MCP sessions. */
const editQueues = new WeakMap<ProjectSession, Promise<unknown>>()

function serialized<T>(session: ProjectSession, fn: () => Promise<T>): Promise<T> {
  const next = (editQueues.get(session) ?? Promise.resolve()).then(fn, fn)
  editQueues.set(
    session,
    next.catch(() => undefined),
  )
  return next
}

const dropBlanks = (args: Obj): Obj => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== ''))

/** In-app agent mode (spec 06 §A8.2): bound to its window's project, no focus guard, plus in-app-only tools. */
export interface InAppMode {
  session: ProjectSession
  extraTools: Record<string, ToolHandler>
}

/** One per MCP session (and one for the sessionless fallback): binding, feedback trail, id handling. */
export class ToolExecutor {
  private bound: ProjectSession | null
  readonly feedback: FeedbackState = { recentTools: [], sentKeys: new Set() }

  constructor(
    readonly app: AppContext,
    readonly inApp: InAppMode | null = null,
  ) {
    this.bound = inApp?.session ?? app.sessions.focused()
  }

  bind(session: ProjectSession | null): void {
    this.bound = session
  }

  /** The bound project while it is still open. */
  get session(): ProjectSession | null {
    const b = this.inApp?.session ?? this.bound
    return b && !b.closed && this.app.sessions.all().includes(b) ? b : null
  }

  get boundName(): string | null {
    return this.bound?.name ?? null
  }

  async execute(name: string, rawArgs: unknown): Promise<ToolResult> {
    const args = dropBlanks(isObj(rawArgs) ? rawArgs : {})
    if (!MCP_TOOL_NAMES.has(name) && !this.inApp?.extraTools[name]) return fail(`Unknown tool: ${name}`)
    if (name === 'manage_project') return manageProject(this, args)
    const session = this.session
    const frontmost = this.app.sessions.focused()
    if (!this.inApp && !READ_ONLY_TOOLS.has(name) && session !== frontmost) {
      const sessionName = session?.name ?? this.boundName ?? 'no project'
      return fail(`This session is on '${sessionName}', but '${frontmost?.name ?? 'no project'}' is active in ${APP_NAME}. Activate '${sessionName}' or call manage_project with action='open' before making changes.`)
    }
    if (!session) return fail('Editor not available')
    const run = () => this.run(name, session, args)
    return READ_ONLY_TOOLS.has(name) ? run() : serialized(session, run)
  }

  private async run(name: string, session: ProjectSession, args: Obj): Promise<ToolResult> {
    const docBefore = session.doc
    const idsBefore = idUniverse(docBefore)
    const nonAgentBefore = session.nonAgentTimelineRevision
    let result: ToolResult
    let read: AgentReadHighlight | null = null
    let started = false
    try {
      const expanded = expandIds(args, idsBefore) as Obj
      read = readActivity(name, expanded, activeTimeline(docBefore))
      this.app.ui(session, { type: 'agentActivity', tool: name, status: 'start', ...(read ? { read } : {}) })
      started = true
      const handler = this.inApp?.extraTools[name] ?? TOOL_HANDLERS[name]
      // Edits made by the tool carry the agent origin through every await (Mac `Analytics.origin`).
      result = await withEditOrigin(this.inApp ? 'agent' : 'mcp', () => handler({ app: this.app, session, feedback: this.feedback }, expanded))
    } catch (e) {
      result = fail(e instanceof ToolError || e instanceof EditRefusal || e instanceof Error ? e.message : String(e))
    } finally {
      if (!started) this.app.ui(session, { type: 'agentActivity', tool: name, status: 'start' })
      this.app.ui(session, { type: 'agentActivity', tool: name, status: 'end', ...(read ? { ok: !result!.isError } : {}) })
    }
    if (!result.isError && CHANGE_PUBLISHERS.has(name) && session.nonAgentTimelineRevision === nonAgentBefore) this.highlightChanges(session, docBefore)
    this.finish(name, result)
    const map = shortIdMap(new Set([...idsBefore, ...idUniverse(session.doc)]))
    return { ...result, content: result.content.map((b) => (b.type === 'text' ? { ...b, text: shortenText(b.text, map) } : b)) }
  }

  private finish(name: string, result: ToolResult): void {
    if (name === 'send_feedback') return
    this.feedback.recentTools.push(name)
    if (this.feedback.recentTools.length > 15) this.feedback.recentTools.shift()
    const first = result.content[0]
    if (result.isError && first?.type === 'text') this.feedback.lastError = first.text
  }

  /** Glows the clips/tracks an agent edit added or changed on the (unchanged) active timeline (Mac `publishAgentChanges`). */
  private highlightChanges(session: ProjectSession, before: Doc): void {
    const after = session.doc
    if (after === before || after.file.activeTimelineId !== before.file.activeTimelineId) return
    const prev = before.file.timelines.find((t) => t.id === before.file.activeTimelineId)
    if (!prev) return
    const changes = changeActivity(prev, activeTimeline(after))
    if (changes) this.app.ui(session, { type: 'agentChanges', changes })
  }
}
