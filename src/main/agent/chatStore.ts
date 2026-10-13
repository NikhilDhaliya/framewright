/** chat/<UUID>.json inside the .palmier package (spec 01 §1.6, §5.15; ChatSessionStore.swift). */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECT, type ClipType } from '../../core/model'
import { isAgentModelId, type AgentContentBlock, type AgentMention, type AgentMessage, type ToolResultBlock } from '../../shared/agent'

export interface ChatSession {
  id: string
  title: string
  /** ISO-8601 without fractional seconds. */
  updatedAt: string
  messages: AgentMessage[]
  isOpen: boolean
}

/** `2026-10-13T09:41:00Z`: the Mac's `.iso8601` strategy rejects fractional seconds. */
export const isoNow = (d = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

const CLIP_TYPES = new Set<ClipType>(['video', 'audio', 'image', 'text', 'lottie', 'sequence', 'subtitle'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class Undecodable extends Error {}

const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Undecodable()
  return v as Record<string, unknown>
}
const str = (v: unknown): string => {
  if (typeof v !== 'string') throw new Undecodable()
  return v
}
const optStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : str(v))
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Undecodable()
  return v
}
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Undecodable()
  return v
}
const arr = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Undecodable()
  return v
}
const uuid = (v: unknown): string => {
  const s = str(v)
  if (!UUID_RE.test(s)) throw new Undecodable()
  return s.toUpperCase()
}

function decodeResultBlock(raw: unknown): ToolResultBlock {
  const o = obj(raw)
  if (o.kind === 'text') return { kind: 'text', text: str(o.text) }
  if (o.kind === 'image') return { kind: 'image', base64: str(o.base64), mediaType: str(o.mediaType) }
  throw new Undecodable()
}

export function decodeBlock(raw: unknown): AgentContentBlock {
  const o = obj(raw)
  switch (o.kind) {
    case 'thinking':
      return { kind: 'thinking', text: str(o.text), signature: str(o.signature) }
    case 'redactedThinking':
      return { kind: 'redactedThinking', data: str(o.data) }
    case 'openAIReasoning': {
      if (!isAgentModelId(o.model)) throw new Undecodable()
      const b: AgentContentBlock = { kind: 'openAIReasoning', summary: str(o.summary), encryptedContent: str(o.encryptedContent), model: o.model }
      const itemID = optStr(o.itemID)
      if (itemID !== undefined) b.itemID = itemID
      return b
    }
    case 'text':
      return { kind: 'text', text: str(o.text) }
    case 'toolUse':
      return { kind: 'toolUse', id: str(o.id), name: str(o.name), input: str(o.input) }
    case 'toolResult':
      return { kind: 'toolResult', toolUseId: str(o.toolUseId), content: arr(o.content).map(decodeResultBlock), isError: bool(o.isError) }
    default:
      throw new Undecodable()
  }
}

function decodeMention(raw: unknown): AgentMention {
  const o = obj(raw)
  const m: AgentMention = { id: uuid(o.id), displayName: str(o.displayName) }
  const mediaRef = optStr(o.mediaRef)
  if (mediaRef !== undefined) m.mediaRef = mediaRef
  if (o.type !== undefined && o.type !== null) {
    if (!CLIP_TYPES.has(o.type as ClipType)) throw new Undecodable()
    m.type = o.type as ClipType
  }
  const clipId = optStr(o.clipId)
  if (clipId !== undefined) m.clipId = clipId
  if (o.timelineRange !== undefined && o.timelineRange !== null) {
    const r = obj(o.timelineRange)
    m.timelineRange = {
      startFrame: int(r.startFrame),
      endFrame: int(r.endFrame),
      durationFrames: int(r.durationFrames),
      fps: int(r.fps),
      startTimecode: str(r.startTimecode),
      endTimecode: str(r.endTimecode),
      durationTimecode: str(r.durationTimecode),
      rangeSemantics: str(r.rangeSemantics),
    }
  }
  return m
}

function decodeMessage(raw: unknown): AgentMessage {
  const o = obj(raw)
  if (o.role !== 'user' && o.role !== 'assistant' && o.role !== 'system') throw new Undecodable()
  const m: AgentMessage = { id: uuid(o.id), role: o.role, blocks: arr(o.blocks).map(decodeBlock), mentions: arr(o.mentions).map(decodeMention) }
  const hint = optStr(o.contextHint)
  if (hint !== undefined) m.contextHint = hint
  return m
}

/** Decodes one session file; null when the Mac would fail to decode it. */
export function decodeSession(text: string): ChatSession | null {
  try {
    const o = obj(JSON.parse(text))
    const updated = str(o.updatedAt)
    const ms = Date.parse(updated)
    if (!Number.isFinite(ms)) return null
    return {
      id: uuid(o.id),
      title: str(o.title),
      updatedAt: isoNow(new Date(ms)),
      messages: arr(o.messages).map(decodeMessage),
      isOpen: o.isOpen === undefined ? true : bool(o.isOpen),
    }
  } catch {
    return null
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const o = value as Record<string, unknown>
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k])
    return out
  }
  return value
}

/** Pretty-printed with sorted keys (the Mac's encoder settings). */
export function encodeSession(s: ChatSession): string {
  return JSON.stringify(sortKeys({ id: s.id.toUpperCase(), isOpen: s.isOpen, messages: s.messages, title: s.title, updatedAt: s.updatedAt }), null, 2)
}

export async function loadChatSessions(packageDir: string): Promise<ChatSession[]> {
  const dir = path.join(packageDir, PROJECT.chatDirectoryName)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: ChatSession[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
    const s = text === null ? null : decodeSession(text)
    if (s) out.push(s)
  }
  return out
}

/** Rewrites chat/: every session with ≥ 1 message as <UPPER-UUID>.json; other .json files are removed. */
export async function saveChatSessions(packageDir: string, sessions: ChatSession[]): Promise<void> {
  const dir = path.join(packageDir, PROJECT.chatDirectoryName)
  await fs.mkdir(dir, { recursive: true })
  const keep = new Set<string>()
  for (const s of sessions) {
    if (!s.messages.length) continue
    const name = `${s.id.toUpperCase()}.json`
    keep.add(name)
    const target = path.join(dir, name)
    const tmp = path.join(dir, `.${name}.tmp-${randomUUID()}`)
    await fs.writeFile(tmp, encodeSession(s))
    await fs.rename(tmp, target)
  }
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name.toLowerCase().endsWith('.json') && !keep.has(name)) await fs.rm(path.join(dir, name), { force: true })
  }
}
