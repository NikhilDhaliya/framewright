/**
 * Agent activity highlights on the timeline (Mac `EditorViewModel+AgentActivity.swift`, spec 05 §6.5 / §6.4):
 * main sends `agentActivity` (tool start/end with the clips/range it reads) and `agentChanges` (what an agent edit
 * added or changed); the timeline draws them as glows that hold, then fade.
 */
import { create } from 'zustand'
import type { AgentChangeHighlight, AgentReadHighlight, UiCommand } from '../../shared/api'

export interface AgentActivity {
  readClipIds: ReadonlySet<string>
  addedClipIds: ReadonlySet<string>
  mutatedClipIds: ReadonlySet<string>
  mutatedTrackIds: ReadonlySet<string>
  /** [start, end) frames. */
  range: [number, number] | null
  /** A read still in progress: stays fully visible until it ends. */
  isActive: boolean
  revision: number
}

/** AppTheme.Anim / AppTheme.AgentActivity (seconds; colours resolved by the drawing code). */
export const AGENT_TIMING = {
  changeHold: 1.0,
  changeDuration: 1.3,
  readHold: 0.7,
  readDuration: 0.95,
} as const

const EMPTY: ReadonlySet<string> = new Set()

export const emptyActivity = (revision = 0): AgentActivity => ({
  readClipIds: EMPTY,
  addedClipIds: EMPTY,
  mutatedClipIds: EMPTY,
  mutatedTrackIds: EMPTY,
  range: null,
  isActive: false,
  revision,
})

export const isRead = (a: AgentActivity): boolean => a.readClipIds.size > 0 || a.range !== null
export const isEmpty = (a: AgentActivity): boolean => !isRead(a) && !a.addedClipIds.size && !a.mutatedClipIds.size && !a.mutatedTrackIds.size

/** Hold + total duration of the current highlight (seconds). */
export const timingOf = (a: AgentActivity): { hold: number; duration: number } =>
  isRead(a) ? { hold: AGENT_TIMING.readHold, duration: AGENT_TIMING.readDuration } : { hold: AGENT_TIMING.changeHold, duration: AGENT_TIMING.changeDuration }

const union = (a: ReadonlySet<string>, b: Iterable<string>): Set<string> => new Set([...a, ...b])

// ---------- Pure transitions (Mac semantics) ----------

/** `showAgentChanges`: null = no change. */
export function withChanges(cur: AgentActivity, c: AgentChangeHighlight): AgentActivity | null {
  if (!c.addedClipIds.length && !c.mutatedClipIds.length && !c.mutatedTrackIds.length) return null
  const base = isRead(cur) ? emptyActivity(cur.revision) : cur
  const added = union(base.addedClipIds, c.addedClipIds)
  const mutated = union(base.mutatedClipIds, c.mutatedClipIds)
  for (const id of added) mutated.delete(id)
  return { ...base, addedClipIds: added, mutatedClipIds: mutated, mutatedTrackIds: union(base.mutatedTrackIds, c.mutatedTrackIds), isActive: false, revision: base.revision + 1 }
}

/** `beginAgentTimelineRead`: null = ignored (no read, or a change highlight is showing). */
export function withReadBegin(cur: AgentActivity, h: AgentReadHighlight | undefined): AgentActivity | null {
  if (!h || (!h.clipIds.length && !h.range)) return null
  if (!isEmpty(cur) && !isRead(cur)) return null
  return { ...emptyActivity(cur.revision + 1), readClipIds: new Set(h.clipIds), range: h.range, isActive: true }
}

/** `endAgentTimelineRead`: 'clear' on failure; null = not the read that is showing. */
export function withReadEnd(cur: AgentActivity, revision: number, ok: boolean): AgentActivity | 'clear' | null {
  if (revision !== cur.revision || !isRead(cur) || !cur.isActive) return null
  if (!ok) return 'clear'
  return { ...cur, isActive: false, revision: cur.revision + 1 }
}

// ---------- Store ----------

export const useAgentActivity = create<AgentActivity>(() => emptyActivity())

let clearTimer: ReturnType<typeof setTimeout> | null = null
/** Revision of the read started by each running tool (read-only tools may overlap). */
const readRevisions = new Map<string, number[]>()

function cancelClear(): void {
  if (clearTimer !== null) clearTimeout(clearTimer)
  clearTimer = null
}

function scheduleClear(seconds: number): void {
  const revision = useAgentActivity.getState().revision
  cancelClear()
  clearTimer = setTimeout(() => {
    clearTimer = null
    if (useAgentActivity.getState().revision === revision) clearAgentActivity()
  }, seconds * 1000)
}

export function clearAgentActivity(): void {
  const cur = useAgentActivity.getState()
  if (isEmpty(cur) && clearTimer === null) return
  cancelClear()
  useAgentActivity.setState(emptyActivity(cur.revision + 1))
}

export function showAgentChanges(c: AgentChangeHighlight): void {
  const next = withChanges(useAgentActivity.getState(), c)
  if (!next) return
  useAgentActivity.setState(next)
  scheduleClear(AGENT_TIMING.changeDuration)
}

export function handleAgentUiCommand(cmd: Extract<UiCommand, { type: 'agentActivity' | 'agentChanges' }>): void {
  if (cmd.type === 'agentChanges') return showAgentChanges(cmd.changes)
  if (cmd.status === 'start') {
    const next = withReadBegin(useAgentActivity.getState(), cmd.read)
    if (!next) return
    cancelClear()
    useAgentActivity.setState(next)
    readRevisions.set(cmd.tool, [...(readRevisions.get(cmd.tool) ?? []), next.revision])
    return
  }
  const list = readRevisions.get(cmd.tool)
  const revision = list?.shift()
  if (list && !list.length) readRevisions.delete(cmd.tool)
  if (revision === undefined) return
  const next = withReadEnd(useAgentActivity.getState(), revision, cmd.ok !== false)
  if (next === 'clear') clearAgentActivity()
  else if (next) {
    useAgentActivity.setState(next)
    scheduleClear(AGENT_TIMING.readDuration)
  }
}

/**
 * Opacity of the highlight `elapsed` seconds after its revision appeared (Mac `AgentActivityLayerSupport`:
 * keyframes 1 → 1 (linear, until hold) → 0 (ease-out)); a running read stays at 1.
 */
export function glowOpacity(a: AgentActivity, elapsed: number): number {
  if (isEmpty(a)) return 0
  if (a.isActive) return 1
  const { hold, duration } = timingOf(a)
  if (elapsed <= hold) return 1
  if (elapsed >= duration) return 0
  const u = (elapsed - hold) / (duration - hold)
  return 1 - (1 - (1 - u) * (1 - u)) // ease-out of 1 → 0
}
