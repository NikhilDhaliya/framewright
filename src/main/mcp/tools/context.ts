import type { Doc } from '../../../core/ops/context'
import type { ProjectSession } from '../../project/session'
import type { AppContext } from '../../services'
import { ToolError, type Obj } from './args'
import { jsonString, roundFloats } from './json'

export type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: Block[]
  isError?: boolean
}

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
export const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
export const okJson = (payload: unknown): ToolResult => ok(jsonString(roundFloats(payload)))
export const okRawJson = (payload: unknown): ToolResult => ok(jsonString(payload))
export const image = (data: Buffer, mimeType: string): Block => ({ type: 'image', data: data.toString('base64'), mimeType })

/** Per MCP session state that outlives individual calls. */
export interface FeedbackState {
  recentTools: string[]
  lastError?: string
  sentKeys: Set<string>
}

export interface ToolEnv {
  app: AppContext
  session: ProjectSession
  feedback: FeedbackState
}

export type ToolHandler = (env: ToolEnv, args: Obj) => ToolResult | Promise<ToolResult>

/** Runs `fn` on a draft as one undo step; a refusal, thrown error, or net no-op leaves the project and undo history untouched. */
export function mutate<R>(env: ToolEnv, label: string, fn: (draft: Doc) => R): R {
  const outcome = env.session.transact(label, fn)
  if (!outcome.ok) throw new ToolError(outcome.error)
  return outcome.result
}

/** Applies a non-undoable document change (metadata of async media work) and persists it. */
export function updateQuietly(session: ProjectSession, fn: (draft: Doc) => void): boolean {
  const outcome = session.transact('Update Media', fn, false)
  if (outcome.ok && outcome.changed) void session.save().catch(() => undefined)
  return outcome.ok
}
