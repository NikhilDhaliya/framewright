/** manage_tracks: reorder → set → remove, one undo step, with stable trackId selectors. */
import { activeTimeline } from '../../../core/ops/context'
import { removeTracks, renameTrack, reorderTrack, setTrackFlag, type TrackFlag } from '../../../core/ops/tracks'
import { trackDisplayLabel } from '../../../core/timeline'
import { ToolError, exactInt, isObj, validateUnknownKeys, type Obj } from './args'
import { mutate, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { ignoringNoop } from './timeline'

const MAX_NAME = 80

/** `TrackName.normalized`: trims spaces, rejects control/newline characters and names over 80 characters. */
function normalizedName(raw: string, path: string): string | null {
  const value = raw.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '')
  if (/[\p{Cc}\p{Cf}\u0085\u2028\u2029]/u.test(raw) || [...value].length > MAX_NAME) throw new ToolError(`${path}.name must be one line of at most ${MAX_NAME} characters`)
  return value || null
}

const entries = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function manageTracks(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['reorder', 'set', 'remove'], 'manage_tracks')
  const t = activeTimeline(env.session.doc)
  const tracks = t.tracks
  const byIndex = (index: number, path: string) => {
    if (!tracks[index]) throw new ToolError(`${path}: track index ${index} out of range (timeline has ${tracks.length} tracks)`)
    return tracks[index].id
  }
  const selector = (entry: Obj, path: string) => {
    if (typeof entry.trackId === 'string') {
      if (entry.index !== undefined || !tracks.some((tr) => tr.id === entry.trackId)) throw new ToolError(`${path}: pass one current trackId or index`)
      return entry.trackId
    }
    const index = exactInt(entry.index)
    if (entry.trackId !== undefined || index === undefined) throw new ToolError(`${path}: pass one current trackId or index`)
    return byIndex(index, path)
  }
  const reorders = entries(args.reorder).map((raw, i) => {
    const path = `reorder[${i}]`
    if (!isObj(raw)) throw new ToolError(`${path} must be an object`)
    validateUnknownKeys(raw, ['trackId', 'index', 'to'], path)
    const to = exactInt(raw.to)
    if (to === undefined) throw new ToolError(`${path}: 'to' is required and must be an integer`)
    const id = selector(raw, path)
    const from = tracks.findIndex((tr) => tr.id === id)
    if (!tracks[to] || tracks[from].type !== tracks[to].type) throw new ToolError(`${path}: destination index ${to} is outside the track's type zone`)
    return { id, to }
  })
  const updates = entries(args.set).map((raw, i) => {
    const path = `set[${i}]`
    if (!isObj(raw)) throw new ToolError(`${path} must be an object`)
    validateUnknownKeys(raw, ['trackId', 'index', 'muted', 'hidden', 'syncLocked', 'name'], path)
    const flags: Partial<Record<TrackFlag, boolean>> = {}
    for (const f of ['muted', 'hidden', 'syncLocked'] as const) if (typeof raw[f] === 'boolean') flags[f] = raw[f] as boolean
    const includesName = 'name' in raw
    let name: string | null = null
    if (includesName) {
      if (typeof raw.name !== 'string') throw new ToolError(`${path}.name must be a string`)
      name = normalizedName(raw.name, path)
    }
    if (!Object.keys(flags).length && !includesName) throw new ToolError(`${path}: pass at least one of muted, hidden, syncLocked, name`)
    return { id: selector(raw, path), flags, includesName, name, rawName: raw.name as string | undefined }
  })
  const removeIds = entries(args.remove).map((raw, i) => {
    const path = `remove[${i}]`
    if (isObj(raw)) {
      validateUnknownKeys(raw, ['trackId', 'index'], path)
      return selector(raw, path)
    }
    const index = exactInt(raw)
    if (index === undefined) throw new ToolError(`${path} must be an integer index or track selector object`)
    return byIndex(index, path)
  })
  if (!reorders.length && !updates.length && !removeIds.length) throw new ToolError('Nothing to do — pass at least one of reorder, set, remove.')
  const multicamTracks = new Set(tracks.filter((tr) => tr.clips.some((c) => c.multicamGroupId)).map((tr) => tr.id))
  if (removeIds.some((id) => multicamTracks.has(id))) {
    throw new ToolError("A multicam group's track can't be removed — delete the group's clips first (remove_clips) and the empty track prunes itself.")
  }
  if (updates.some((u) => multicamTracks.has(u.id) && u.flags.syncLocked === false)) {
    throw new ToolError("Sync lock stays on for a multicam group's tracks — unlocking would let ripples shift the group's members apart.")
  }
  const removing = new Set(removeIds)
  const removedTracks = tracks.flatMap((tr, i) => (removing.has(tr.id) ? [{ trackId: tr.id, index: i, label: trackDisplayLabel(t, i), type: tr.type }] : []))
  const before = snapshot(env.session.doc)
  const { reordered, renamed } = mutate(env, 'Manage Tracks (Agent)', (d) => {
    const dt = activeTimeline(d)
    const reordered = reorders.flatMap((r) => {
      const from = dt.tracks.findIndex((tr) => tr.id === r.id)
      if (from < 0) return []
      ignoringNoop(() => reorderTrack(d, r.id, r.to))
      const to = dt.tracks.findIndex((tr) => tr.id === r.id)
      return [{ trackId: r.id, from, to, changed: from !== to }]
    })
    const renamed: Obj[] = []
    for (const u of updates) {
      const idx = dt.tracks.findIndex((tr) => tr.id === u.id)
      if (idx < 0) continue
      for (const [flag, value] of Object.entries(u.flags) as [TrackFlag, boolean][]) if (dt.tracks[idx][flag] !== value) setTrackFlag(d, idx, flag, value)
      if (u.includesName) {
        const changed = (dt.tracks[idx].name ?? null) !== u.name
        if (changed) ignoringNoop(() => renameTrack(d, u.id, u.rawName ?? ''))
        renamed.push({ trackId: u.id, name: dt.tracks[idx].name ?? null, changed })
      }
    }
    if (removeIds.length) removeTracks(d, removeIds)
    return { reordered, renamed }
  })
  const after = activeTimeline(env.session.doc)
  const order = after.tracks.map((tr, i) => {
    const e: Obj = { trackId: tr.id, index: i, label: trackDisplayLabel(after, i), type: tr.type }
    if (tr.name) e.name = tr.name
    if (tr.muted) e.muted = true
    if (tr.hidden) e.hidden = true
    if (!tr.syncLocked) e.syncLocked = false
    return e
  })
  const extra: Obj = { tracks: order }
  if (reordered.length) extra.reordered = reordered
  if (renamed.length) extra.renamed = renamed
  if (removedTracks.length) extra.removedTracks = removedTracks
  return mutationResult(env.session.doc, before, { extra })
}
