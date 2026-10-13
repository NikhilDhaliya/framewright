/** Draft mention rules (spec 06 §A11.6, §A12). Pure: used by the composer and the "Add to chat" hand-offs. */
import type { Clip, ClipType, MediaManifestEntry, Timeline } from '@core/model'
import { formatTimecode } from '@core/time'
import { trackDisplayLabel } from '@core/timeline'
import type { Doc } from '@core/ops/context'
import { mentionDisplayName, type AgentMention } from '../../shared/agent'

export interface Draft {
  text: string
  mentions: AgentMention[]
}

const uuid = () => crypto.randomUUID().toUpperCase()

/** Mentions whose `@displayName` no longer occurs in the draft are dropped. */
export const pruneMentions = (d: Draft): AgentMention[] => d.mentions.filter((m) => d.text.includes('@' + m.displayName))

const appendToken = (text: string, name: string): string => `${text}${text !== '' && !/[ \n]$/.test(text) ? ' ' : ''}@${name} `

/** Asset mention (§A12.1): media tile "Add to chat", composer drop/paste. */
export function attachAsset(d: Draft, asset: Pick<MediaManifestEntry, 'id' | 'name' | 'type'>): Draft {
  const mentions = pruneMentions(d)
  if (mentions.some((m) => m.mediaRef === asset.id && m.clipId === undefined && m.timelineRange === undefined)) return { text: d.text, mentions }
  let name = mentionDisplayName(asset.name)
  if (mentions.some((m) => m.displayName === name && m.mediaRef !== asset.id)) name += '#' + asset.id.slice(0, 6)
  return { text: appendToken(d.text, name), mentions: [...mentions, { id: uuid(), displayName: name, mediaRef: asset.id, type: asset.type }] }
}

/** clipDisplayLabel: text content (newlines → spaces) or "Text"; nested timeline name; else media name. */
export function clipLabel(doc: Doc, clip: Clip): string {
  if (clip.mediaType === 'text') {
    const t = (clip.textContent ?? '').replace(/\r\n|\r|\n/g, ' ')
    return t.trim() ? t : 'Text'
  }
  if (clip.sourceClipType === 'sequence' || clip.mediaType === 'sequence') {
    const tl = doc.file.timelines.find((t) => t.id === clip.mediaRef)
    if (tl) return tl.name
  }
  return doc.manifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? ''
}

const trimDashes = (s: string) => s.replace(/^-+|-+$/g, '')

/** Clip mentions (§A12.2) for the right-clicked set, in track order then clip order. */
export function attachClips(d: Draft, doc: Doc, timeline: Timeline, clipIds: string[]): Draft {
  let mentions = pruneMentions(d)
  let text = d.text
  const wanted = new Set(clipIds)
  timeline.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (!wanted.has(clip.id) || mentions.some((m) => m.clipId === clip.id)) continue
      const short = trimDashes([...mentionDisplayName(clipLabel(doc, clip))].slice(0, 24).join(''))
      let name = mentionDisplayName(`${short}-${trackDisplayLabel(timeline, trackIndex)}-${formatTimecode(clip.startFrame, timeline.fps)}`)
      if (!name) name = `Clip-${clip.id.slice(0, 6)}`
      if (mentions.some((m) => m.displayName === name && m.clipId !== clip.id)) name += '#' + clip.id.slice(0, 6)
      text = appendToken(text, name)
      mentions = [...mentions, { id: uuid(), displayName: name, mediaRef: clip.mediaRef, type: clip.mediaType, clipId: clip.id }]
    }
  })
  return { text, mentions }
}

/** Range mention (§A12.3) from the timeline in/out range. */
export function attachRange(d: Draft, range: { start: number; end: number }, fps: number): Draft {
  const mentions = pruneMentions(d)
  const s = Math.min(range.start, range.end)
  const e = Math.max(range.start, range.end)
  const startTimecode = formatTimecode(s, fps)
  const endTimecode = formatTimecode(e, fps)
  const timelineRange = {
    startFrame: s,
    endFrame: e,
    durationFrames: Math.max(0, e - s),
    fps,
    startTimecode,
    endTimecode,
    durationTimecode: formatTimecode(Math.max(0, e - s), fps),
    rangeSemantics: 'startInclusiveEndExclusive',
  }
  if (mentions.some((m) => m.timelineRange && m.timelineRange.startFrame === s && m.timelineRange.endFrame === e && m.timelineRange.fps === fps)) return { text: d.text, mentions }
  let name = mentionDisplayName(`Range-${startTimecode}-${endTimecode}`) || `Range-${s}-${e}`
  if (mentions.some((m) => m.displayName === name)) name += `#${s}-${e}`
  return { text: appendToken(d.text, name), mentions: [...mentions, { id: uuid(), displayName: name, timelineRange }] }
}

/** The @query being typed: text after the last `@` (start or after whitespace), with no whitespace in it. */
export function atQuery(text: string): string | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(text[at - 1])) return null
  const q = text.slice(at + 1)
  return /\s/.test(q) ? null : q
}

/** Picking from the @ popover: everything from the last `@` becomes `@<name> `. */
export function pickMention(d: Draft, asset: Pick<MediaManifestEntry, 'id' | 'name' | 'type'>): Draft {
  const at = d.text.lastIndexOf('@')
  const base = at >= 0 ? d.text.slice(0, at) : d.text
  const mentions = d.mentions
  let name = mentionDisplayName(asset.name)
  if (mentions.some((m) => m.displayName === name && m.mediaRef !== asset.id)) name += '#' + asset.id.slice(0, 6)
  const exists = mentions.some((m) => m.displayName === name && m.mediaRef === asset.id && !m.clipId && !m.timelineRange)
  return { text: `${base}@${name} `, mentions: exists ? mentions : [...mentions, { id: uuid(), displayName: name, mediaRef: asset.id, type: asset.type }] }
}

export type PickerTab = 'all' | 'video' | 'image' | 'audio'

/** Library assets of the tab's type whose display name contains the query; first 50 in library order. */
export function mentionCandidates(entries: MediaManifestEntry[], tab: PickerTab, query: string): MediaManifestEntry[] {
  const q = query.toLowerCase()
  const out: MediaManifestEntry[] = []
  for (const e of entries) {
    if (tab !== 'all' && e.type !== (tab as ClipType)) continue
    if (!mentionDisplayName(e.name).toLowerCase().includes(q)) continue
    out.push(e)
    if (out.length === 50) break
  }
  return out
}
