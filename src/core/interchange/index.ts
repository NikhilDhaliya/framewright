import type { Clip, Timeline } from '../model'
import { reachableTimelineIds } from '../timeline'

export * from './fcpxml'
export * from './fileUrl'
export * from './fonts'
export * from './printf'
export * from './timecode'
export * from './types'
export * from './xmeml'
export * from './xml'

/** The root plus every reachable nested timeline (any depth), root first, then breadth-first. */
export function interchangeTimelines(timeline: Timeline, timelines: readonly Timeline[]): Timeline[] {
  const all = [...timelines, timeline]
  const byId = new Map(all.map((t) => [t.id, t]))
  return [timeline, ...[...reachableTimelineIds(all, timeline.id)].map((id) => byId.get(id)!)]
}

/** Clips of the root and every reachable nested timeline that reference media (not nest carriers); their sources' timecodes feed both exporters. */
export function interchangeMediaClips(timeline: Timeline, timelines: readonly Timeline[]): Clip[] {
  return interchangeTimelines(timeline, timelines).flatMap((t) => t.tracks.flatMap((tr) => tr.clips.filter((c) => c.sourceClipType !== 'sequence')))
}
