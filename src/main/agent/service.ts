/**
 * The in-app agent of one project window (spec 06 §A2–§A3, §A8): chat sessions, the send pipeline,
 * the provider run loop and the tool step. Runs are bound to their session id (fixes Q-A1).
 */
import { BRANDED_SPEC as spec } from '../mcp/brandedSpec'
import type { AppContext } from '../services'
import { ToolExecutor } from '../mcp/tools/executor'
import { MCP_TOOLS } from '../mcp/tools/definitions'
import type { ProjectSession } from '../project/session'
import {
  modelInfo,
  type AgentContentBlock,
  type AgentMention,
  type AgentMessage,
  type AgentModelId,
  type AgentPanelState,
  type AgentProvider,
  type AgentReasoningEffort,
  type AgentStreamError,
  type AgentStreamUpdate,
  type ChatSessionInfo,
  type ToolResultBlock,
} from '../../shared/agent'
import { isoNow, loadChatSessions, saveChatSessions, type ChatSession } from './chatStore'
import { InlineImageEncoder } from './images'
import { systemPrompt } from './instructions'
import { mentionHint, referencedMentions } from './mentions'
import type { AgentPrefs } from './prefs'
import { presentAgentStream } from './presentation'
import { AnthropicClient } from './providers/anthropic'
import { OpenAIClient } from './providers/openai'
import type { AgentClient, ToolSchema } from './providers/types'
import { skillToolHandlers } from './skillTools'
import type { SkillStore } from './skills'
import { isAbortError } from './sse'
import {
  apiMessages,
  cancelledResult,
  dropEmptyAssistantTurn,
  newMessageId,
  NEW_CHAT_TITLE,
  resolvedToolUseIds,
  resolveOrphanToolUses,
  titleFrom,
  userMessage,
  type InlinedImages,
  type MentionContextProvider,
} from './transcript'

/** `ToolDefinitions.inAppAgent`: the MCP tools minus manage_project, then read_skill and manage_skills (§A8.1). */
export const IN_APP_TOOLS: ToolSchema[] = [
  ...MCP_TOOLS.filter((t) => t.name !== 'manage_project'),
  ...(spec.inAppOnlyTools as { name: string; description: string; inputSchema: Record<string, unknown> }[]),
].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

export type ApiKeys = Partial<Record<AgentProvider, string>>

export interface AgentServiceDeps {
  app: AppContext
  project: ProjectSession
  prefs: AgentPrefs
  skills: SkillStore
  /** API keys, re-read at the start of every run. */
  keys(): ApiKeys
  onState(state: AgentPanelState): void
  onStream(update: AgentStreamUpdate): void
  /** Test hook: builds the provider client. */
  clientFor?(provider: AgentProvider, apiKey: string): AgentClient
  encoder?: InlineImageEncoder
  /** Snapshot coalescing interval (ms). */
  streamIntervalMs?: number
}

interface Run {
  sessionId: string
  abort: AbortController
  done: Promise<void>
}

const defaultClient = (provider: AgentProvider, apiKey: string): AgentClient =>
  provider === 'anthropic' ? new AnthropicClient({ apiKey }) : new OpenAIClient({ apiKey })

const newSession = (): ChatSession => ({ id: newMessageId(), title: NEW_CHAT_TITLE, updatedAt: isoNow(), messages: [], isOpen: true })

function parseArgs(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

export class AgentService {
  sessions: ChatSession[] = []
  currentId: string
  streamError: AgentStreamError | null = null
  readonly executor: ToolExecutor
  readonly ready: Promise<void>
  private run: Run | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly encoder: InlineImageEncoder

  constructor(private readonly deps: AgentServiceDeps) {
    this.executor = new ToolExecutor(deps.app, { session: deps.project, extraTools: skillToolHandlers(deps.skills) })
    this.encoder = deps.encoder ?? new InlineImageEncoder()
    const fresh = newSession()
    this.sessions = [fresh]
    this.currentId = fresh.id
    this.ready = this.load()
  }

  // ---------- Loading and persistence ----------

  /** Load: undecodable files skipped, empty sessions dropped, all closed, newest first, plus a fresh open "New chat". */
  private async load(): Promise<void> {
    const loaded = (await loadChatSessions(this.deps.project.path)).filter((s) => s.messages.length > 0)
    for (const s of loaded) s.isOpen = false
    loaded.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    const current = this.current
    this.sessions = [current, ...loaded.filter((s) => s.id !== current.id)]
    this.emitState()
  }

  private save(): void {
    if (this.disposed) return
    const sessions = this.sessions.map((s) => ({ ...s, messages: [...s.messages] }))
    const run = async () => {
      if (this.deps.project.closed && this.disposed) return
      await saveChatSessions(this.deps.project.path, sessions)
    }
    this.saveChain = this.saveChain.then(run, run).catch((e) => console.error(`[agent] saving chats failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Queues a write of every session and resolves once it is on disk. */
  saveNow(): Promise<void> {
    this.save()
    return this.saveChain
  }

  async dispose(): Promise<void> {
    this.cancel()
    this.save()
    this.disposed = true
    await this.saveChain
  }

  // ---------- State ----------

  get current(): ChatSession {
    return this.sessions.find((s) => s.id === this.currentId) ?? this.sessions[0]
  }

  private sessionById(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  get model(): AgentModelId {
    return this.deps.prefs.model
  }

  get effort(): AgentReasoningEffort {
    return this.deps.prefs.effort()
  }

  private keyFor(model: AgentModelId): string | null {
    return this.deps.keys()[modelInfo(model).provider]?.trim() || null
  }

  /** BYOK routing: `direct` when the provider has a key, else unavailable (§A1.3). */
  get canStream(): boolean {
    return this.keyFor(this.model) !== null
  }

  get isStreaming(): boolean {
    return this.run !== null && this.run.sessionId === this.currentId
  }

  state(): AgentPanelState {
    const model = this.model
    const sessions: ChatSessionInfo[] = this.sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, isOpen: s.isOpen, messageCount: s.messages.length }))
    return {
      sessions,
      currentId: this.current.id,
      messages: this.current.messages,
      isStreaming: this.isStreaming,
      streamError: this.streamError,
      model,
      effort: this.effort,
      canStream: this.canStream,
      activeBYOKProvider: this.canStream ? modelInfo(model).provider : null,
    }
  }

  emitState(): void {
    if (!this.disposed) this.deps.onState(this.state())
  }

  private unavailableError(model = this.model): AgentStreamError {
    return { kind: 'unavailable', model, provider: modelInfo(model).provider }
  }

  /** After a model change: unavailable → show the key error; available → clear a stale key error (§A1.3). */
  onModelChanged(): void {
    if (!this.canStream) this.streamError = this.unavailableError()
    else if (this.streamError?.kind === 'unavailable') this.streamError = null
    this.emitState()
  }

  /** Keys changed in Settings: same rule, without forcing an error onto an idle panel that had none. */
  onKeysChanged(): void {
    if (this.canStream && this.streamError?.kind === 'unavailable') this.streamError = null
    this.emitState()
  }

  // ---------- Session lifecycle (§A2.2) ----------

  /** Sync: updatedAt = now; a "New chat" title becomes the first user text (≤ 40 graphemes). */
  private touch(s: ChatSession): void {
    s.updatedAt = isoNow()
    if (s.title === NEW_CHAT_TITLE) s.title = titleFrom(s.messages)
  }

  private insertFresh(): void {
    const fresh = newSession()
    this.sessions.unshift(fresh)
    this.currentId = fresh.id
    this.streamError = null
    this.resetFeedback()
  }

  private resetFeedback(): void {
    this.executor.feedback.recentTools = []
    this.executor.feedback.lastError = undefined
    this.executor.feedback.sentKeys.clear()
  }

  newChat(): void {
    this.cancel()
    const cur = this.current
    if (cur.messages.length) this.touch(cur)
    else this.sessions = this.sessions.filter((s) => s !== cur)
    this.insertFresh()
    this.save()
    this.emitState()
  }

  select(id: string): void {
    const target = this.sessionById(id)
    if (!target) return
    this.cancel()
    const cur = this.current
    if (cur.messages.length && cur !== target) this.touch(cur)
    target.isOpen = true
    this.currentId = target.id
    this.streamError = null
    this.save()
    this.emitState()
  }

  /** Closing a tab never cancels its run (the run keeps writing to its own session). */
  closeTab(id: string): void {
    const s = this.sessionById(id)
    if (!s) return
    s.isOpen = false
    if (!s.messages.length && this.run?.sessionId !== id) this.sessions = this.sessions.filter((x) => x !== s)
    if (this.currentId === id) {
      const next = this.sessions.find((x) => x.isOpen)
      if (next) {
        this.currentId = next.id
        this.streamError = null
      } else this.insertFresh()
    }
    this.save()
    this.emitState()
  }

  deleteSession(id: string): void {
    const s = this.sessionById(id)
    if (!s) return
    if (this.run?.sessionId === id) this.cancel()
    this.sessions = this.sessions.filter((x) => x !== s)
    if (this.currentId === id) {
      const next = this.sessions.find((x) => x.isOpen)
      if (next) {
        this.currentId = next.id
        this.streamError = null
      }
    }
    if (!this.sessions.some((x) => x.isOpen)) this.insertFresh()
    this.save()
    this.emitState()
  }

  setModel(model: AgentModelId): void {
    this.deps.prefs.setModel(model)
  }

  setEffort(effort: AgentReasoningEffort): void {
    this.deps.prefs.setEffort(effort)
  }

  /** UI notice in the current chat (e.g. `Now editing: <project>`); never sent to the model. */
  postSystemNotice(text: string): void {
    this.current.messages.push({ id: newMessageId(), role: 'system', blocks: [{ kind: 'text', text }], mentions: [] })
    this.save()
    this.emitState()
  }

  // ---------- Send pipeline (§A3.1–§A3.2) ----------

  send(text: string, mentions: AgentMention[]): void {
    if (!this.canStream) {
      this.streamError = this.unavailableError()
      this.emitState()
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return
    const referenced = referencedMentions(mentions, trimmed)
    const hint = referenced.length ? mentionHint(referenced, this.liveDoc()) : undefined
    const settings = { model: this.model, effort: this.effort }
    const s = this.current
    resolveOrphanToolUses(s.messages)
    s.messages.push(userMessage([{ kind: 'text', text: trimmed }], referenced, hint))
    this.touch(s)
    this.streamError = null
    this.kickOff(s.id, settings)
  }

  /** Stop: aborts the fetch and SSE reader; no error banner (§A3.7). */
  cancel(): void {
    const run = this.run
    if (!run) return
    this.run = null
    run.abort.abort()
    this.emitState()
  }

  /** Resolves when the active run (if any) has finished unwinding. */
  async idle(): Promise<void> {
    while (this.run) await this.run.done
  }

  private kickOff(sessionId: string, settings: { model: AgentModelId; effort: AgentReasoningEffort }): void {
    this.cancel()
    const abort = new AbortController()
    const run: Run = { sessionId, abort, done: Promise.resolve() }
    this.run = run
    this.emitState()
    run.done = this.runLoop(run, settings)
      .catch((e) => {
        if (!abort.signal.aborted) this.streamError = { kind: 'upstream', message: e instanceof Error ? e.message : String(e) }
      })
      .finally(() => {
        if (this.run === run) this.run = null
        const s = this.sessionById(sessionId)
        if (s) this.touch(s)
        this.save()
        this.emitState()
      })
  }

  private liveDoc() {
    return this.deps.project.closed ? null : this.deps.project.doc
  }

  private mentionContext(): MentionContextProvider {
    return {
      hint: (mentions) => mentionHint(mentions, this.liveDoc()),
      inlineImages: (mentions) => this.inlineImages(mentions),
    }
  }

  private async inlineImages(mentions: AgentMention[]): Promise<InlinedImages> {
    const out: InlinedImages = { images: [], inlinedIds: [], failures: {} }
    const doc = this.liveDoc()
    for (const m of mentions) {
      if (m.type !== 'image' || !m.mediaRef) continue
      if (!doc) {
        out.failures[m.mediaRef] = 'editor unavailable'
        continue
      }
      const entry = doc.manifest.entries.find((e) => e.id === m.mediaRef)
      const file = entry ? this.deps.project.resolveMedia(entry) : null
      if (!entry) {
        out.failures[m.mediaRef] = 'asset not in media library'
        continue
      }
      const encoded = file ? await this.encoder.encode(file) : null
      if (!encoded) {
        out.failures[m.mediaRef] = 'could not read or decode image file'
        continue
      }
      out.images.push({ base64: encoded.data.toString('base64'), mediaType: encoded.mediaType })
      if (!out.inlinedIds.includes(m.mediaRef)) out.inlinedIds.push(m.mediaRef)
    }
    return out
  }

  // ---------- Run loop (§A3.3) ----------

  private async runLoop(run: Run, settings: { model: AgentModelId; effort: AgentReasoningEffort }): Promise<void> {
    const { model, effort } = settings
    const signal = run.abort.signal
    const provider = modelInfo(model).provider
    const key = this.keyFor(model)
    if (!key) {
      this.streamError = this.unavailableError(model)
      return
    }
    const client = (this.deps.clientFor ?? defaultClient)(provider, key)
    await this.deps.skills.waitForSync()
    await this.deps.skills.reload()
    while (!signal.aborted) {
      const s = this.sessionById(run.sessionId)
      if (!s) break
      if (resolveOrphanToolUses(s.messages)) this.emitState()
      const request = await apiMessages(s.messages, this.mentionContext())
      if (signal.aborted) break
      if (!s.messages.some((m) => m.role === 'user')) {
        this.streamError = { kind: 'upstream', message: 'The agent request has no user message.' }
        break
      }
      const assistant: AgentMessage = { id: newMessageId(), role: 'assistant', blocks: [], mentions: [] }
      s.messages.push(assistant)
      this.emitState()
      const system = systemPrompt(this.deps.skills.index())
      let stopReason: string
      try {
        const final = await presentAgentStream(
          client.stream({ model, effort, maxTokens: modelInfo(model).maxOutputTokens, system, tools: IN_APP_TOOLS, messages: request }, signal),
          model,
          (snap) => this.applySnapshot(run.sessionId, assistant.id, snap.blocks, snap.revision),
          { intervalMs: this.deps.streamIntervalMs },
        )
        stopReason = final.stopReason
      } catch (e) {
        dropEmptyAssistantTurn(s.messages, assistant.id)
        if (signal.aborted || isAbortError(e)) break
        this.streamError = { kind: 'upstream', message: e instanceof Error ? e.message : String(e) }
        break
      }
      dropEmptyAssistantTurn(s.messages, assistant.id)
      this.emitState()
      if (stopReason === 'refusal') {
        this.streamError = { kind: 'refusal', model }
        break
      }
      if (stopReason !== 'tool_use') break
      const ran = await this.runPendingToolUses(run, s, assistant.id)
      if (signal.aborted || !ran) break
    }
  }

  private applySnapshot(sessionId: string, messageId: string, blocks: AgentContentBlock[], revision: number): void {
    const s = this.sessionById(sessionId)
    const i = s ? s.messages.findIndex((m) => m.id === messageId && m.role === 'assistant') : -1
    if (!s || i < 0) return
    s.messages[i] = { ...s.messages[i], blocks }
    if (sessionId !== this.currentId) s.updatedAt = isoNow()
    else if (!this.disposed) this.deps.onStream({ sessionId, messageId, blocks, revision })
  }

  // ---------- Tool step (§A3.4) ----------

  /** Runs the assistant message's unanswered tool uses in order; returns false when there was nothing to run. */
  private async runPendingToolUses(run: Run, s: ChatSession, assistantId: string): Promise<boolean> {
    const index = s.messages.findIndex((m) => m.id === assistantId && m.role === 'assistant')
    if (index < 0) return false
    const uses = s.messages[index].blocks.flatMap((b) => (b.kind === 'toolUse' ? [b] : []))
    const resolved = resolvedToolUseIds(s.messages, index)
    const pending = uses.filter((u) => !resolved.has(u.id))
    if (!pending.length) return false
    const results: AgentContentBlock[] = []
    for (const use of pending) {
      if (run.abort.signal.aborted) {
        results.push(cancelledResult(use.id))
        continue
      }
      // Each mutating call is its own undo step, named by the tool, on the user's undo stack (§A3.8).
      const result = await this.executor.execute(use.name, parseArgs(use.input))
      const content: ToolResultBlock[] = result.content.map((b) => (b.type === 'text' ? { kind: 'text', text: b.text } : { kind: 'image', base64: b.data, mediaType: b.mimeType }))
      results.push({ kind: 'toolResult', toolUseId: use.id, content, isError: result.isError === true })
    }
    // After a Stop the user may already have sent again (the orphan pass then answered these with "Cancelled").
    const at = s.messages.findIndex((m) => m.id === assistantId)
    const later = at < 0 ? [] : s.messages.slice(at + 1).filter((m) => m.role !== 'system')
    if (at >= 0 && later.length === 0) {
      s.messages.push(userMessage(results))
      this.save()
      this.emitState()
    }
    return true
  }
}
