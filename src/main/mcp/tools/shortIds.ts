/** UUIDs are shown as their shortest unique prefix (at least 8 characters); prefixes are expanded on input. */
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { ToolError, isObj } from './args'

const PREFIX_FLOOR = 8
const UUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g

const SCALAR_KEYS = new Set([
  'clipId', 'sourceClipId', 'referenceClipId', 'targetClipId', 'mediaRef', 'startFrameMediaRef', 'endFrameMediaRef',
  'sourceVideoMediaRef', 'videoSourceMediaRef', 'sourceMediaRef', 'subtitleMediaRef', 'captionGroupId', 'timelineId',
  'trackId', 'item', 'from', 'reference', 'groupId', 'memberId', 'markerId',
])
const ARRAY_KEYS = new Set([
  'clipIds', 'targetClipIds', 'items', 'ids', 'deletes', 'referenceMediaRefs', 'referenceImageMediaRefs',
  'referenceVideoMediaRefs', 'referenceAudioMediaRefs',
])

/** Every id the agent can see: timelines, the active timeline's tracks/clips/groups/markers, assets, multicam. */
export function idUniverse(doc: Doc): Set<string> {
  const ids = new Set<string>()
  for (const t of doc.file.timelines) ids.add(t.id)
  const t = activeTimeline(doc)
  for (const tr of t.tracks) {
    ids.add(tr.id)
    for (const c of tr.clips) {
      ids.add(c.id)
      if (c.captionGroupId) ids.add(c.captionGroupId)
      if (c.linkGroupId) ids.add(c.linkGroupId)
    }
  }
  for (const m of t.markers) ids.add(m.id)
  for (const e of doc.manifest.entries) ids.add(e.id)
  for (const g of doc.file.multicamGroups ?? []) {
    ids.add(g.id)
    for (const m of g.members) ids.add(m.id)
  }
  return ids
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

export function shortIdMap(ids: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(ids)].sort()
  const out = new Map<string, string>()
  sorted.forEach((id, i) => {
    let shared = 0
    if (i > 0) shared = Math.max(shared, commonPrefix(id, sorted[i - 1]))
    if (i < sorted.length - 1) shared = Math.max(shared, commonPrefix(id, sorted[i + 1]))
    out.set(id, id.slice(0, Math.min(id.length, Math.max(PREFIX_FLOOR, shared + 1))))
  })
  return out
}

export function shortenText(text: string, map: Map<string, string>): string {
  return text.replace(UUID, (m) => map.get(m) ?? m)
}

function expandOne(ref: string, universe: Set<string>): string {
  if (universe.has(ref) || ref.length < PREFIX_FLOOR) return ref
  const matches = [...universe].filter((id) => id.startsWith(ref))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new ToolError(`Ambiguous id '${ref}' matches ${matches.length} items; re-read with get_timeline or get_media for current ids.`)
  return ref
}

/** Expands id-prefix arguments to full ids; unknown values pass through so the tool reports them. */
export function expandIds(value: unknown, universe: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => expandIds(v, universe))
  if (!isObj(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SCALAR_KEYS.has(k) && typeof v === 'string') out[k] = expandOne(v, universe)
    else if (ARRAY_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? expandOne(x, universe) : x))
    else out[k] = expandIds(v, universe)
  }
  return out
}
