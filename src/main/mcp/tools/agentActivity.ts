/**
 * Agent activity highlights (Mac `ToolExecutor+AgentActivity.swift`): which clips/range a tool reads, and which
 * clips/tracks an edit added or changed. The editor draws them as glows (spec 05 §6.5, §6.4 track headers).
 */
import type { Clip, Timeline } from '../../../core/model'
import { findClip, totalFrames } from '../../../core/timeline'
import { structurallyEqual } from '../../../core/util'
import type { AgentChangeHighlight, AgentReadHighlight } from '../../../shared/api'
import { lenient, type Obj } from './args'
import { frameWindow, OPEN_END } from './timelineView'

const str = (args: Obj, k: string): string | null => (typeof args[k] === 'string' && args[k] ? (args[k] as string) : null)

function clampedRange(start: number, end: number, t: Timeline): [number, number] | null {
  const lower = Math.max(0, start)
  const upper = Math.min(totalFrames(t), end)
  return lower < upper ? [lower, upper] : null
}

function windowRange(args: Obj, t: Timeline): [number, number] | null {
  let w: { start: number; end: number } | null
  try {
    w = frameWindow(args)
  } catch {
    return null
  }
  if (!w) return null
  return clampedRange(w.start, w.end === OPEN_END ? totalFrames(t) : w.end, t)
}

/** `timelineReadActivity`: the read highlight for a tool call, or null. */
export function readActivity(tool: string, args: Obj, t: Timeline): AgentReadHighlight | null {
  const clipIds: string[] = []
  let range: [number, number] | null = null
  switch (tool) {
    case 'inspect_media':
    case 'inspect_color': {
      const id = str(args, 'clipId')
      if (id) clipIds.push(id)
      break
    }
    case 'get_transcript':
    case 'get_multicam': {
      const id = str(args, 'clipId')
      if (id) clipIds.push(id)
      range = windowRange(args, t)
      break
    }
    case 'inspect_timeline': {
      const start = Math.max(0, lenient.int(args, 'startFrame') ?? 0)
      const rawEnd = lenient.int(args, 'endFrame')
      const end = rawEnd !== undefined && rawEnd > start ? rawEnd : start + 1
      range = clampedRange(start, end, t)
      break
    }
    case 'get_timeline':
      range = windowRange(args, t)
      break
    case 'capture_frame': {
      const f = lenient.int(args, 'timelineFrame')
      if (f !== undefined && f >= 0) range = clampedRange(f, f + 1, t)
      break
    }
    default:
      return null
  }
  const present = clipIds.filter((id) => !!findClip(t, id))
  return present.length || range ? { clipIds: present, range } : null
}

function located(t: Timeline): Map<string, { trackId: string; clip: Clip }> {
  const m = new Map<string, { trackId: string; clip: Clip }>()
  for (const tr of t.tracks) for (const c of tr.clips) m.set(c.id, { trackId: tr.id, clip: c })
  return m
}

/** `publishAgentChanges`: clips added / mutated and tracks changed between two versions of one timeline. */
export function changeActivity(before: Timeline, after: Timeline): AgentChangeHighlight | null {
  const b = located(before)
  const a = located(after)
  const added = [...a.keys()].filter((id) => !b.has(id))
  const mutated = [...b].filter(([id, prev]) => {
    const cur = a.get(id)
    return cur && (cur.trackId !== prev.trackId || (cur.clip !== prev.clip && !structurallyEqual(cur.clip, prev.clip)))
  }).map(([id]) => id)
  const bt = new Map(before.tracks.map((tr) => [tr.id, tr]))
  const at = new Map(after.tracks.map((tr) => [tr.id, tr]))
  const surviving = new Set([...bt.keys()].filter((id) => at.has(id)))
  const tracks = new Set(
    [...surviving].filter((id) => {
      const p = bt.get(id)!
      const c = at.get(id)!
      return p.name !== c.name || !!p.muted !== !!c.muted || !!p.hidden !== !!c.hidden || !!p.syncLocked !== !!c.syncLocked
    }),
  )
  // Ignore index shifts caused only by insertion or removal.
  const bo = before.tracks.map((tr) => tr.id).filter((id) => surviving.has(id))
  const ao = after.tracks.map((tr) => tr.id).filter((id) => surviving.has(id))
  bo.forEach((id, i) => {
    if (ao[i] !== id) tracks.add(ao[i])
  })
  if (!added.length && !mutated.length && !tracks.size) return null
  return { addedClipIds: added, mutatedClipIds: mutated, mutatedTrackIds: [...tracks] }
}
