import { getDoc } from '../state/project'
import { runOp } from '../state/ops'

export function openTimelineIds(): string[] {
  const doc = getDoc()
  if (!doc) return []
  const open = (doc.file.openTimelineIds ?? []).filter((id) => doc.file.timelines.some((t) => t.id === id))
  const active = doc.file.activeTimelineId
  return active && !open.includes(active) ? [...open, active] : open
}

export function activateTimeline(id: string): void {
  if (getDoc()?.file.activeTimelineId !== id) void runOp('activateTimeline', { id }, { quiet: true })
}

export function cycleTimelineTab(delta: -1 | 1): void {
  const open = openTimelineIds()
  if (open.length < 2) return
  const i = open.indexOf(getDoc()!.file.activeTimelineId ?? '')
  activateTimeline(open[(i + delta + open.length) % open.length])
}
