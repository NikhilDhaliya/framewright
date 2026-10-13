/**
 * Speaker identification maths (spec 07 §3.5; Mac `SpeakerIdentity.swift`, `EditorViewModel+Speakers.swift`): turns,
 * speech confirmation against VAD, fingerprint snippets, greedy cross-file clustering against the project registry,
 * registry entries and per-file speaker masks. Pure.
 */
import type { SpeakerRegistryEntry } from '../model'
import { CELL_SECONDS, type SpeechSegment } from './vad'

export interface SpeakerTurn {
  speaker: string
  start: number
  end: number
}

export const TURN_MERGE_GAP = 1.0
export const CONFIRM_OVERLAP = 0.3
export const MATCH_THRESHOLD = 0.45
export const EMBEDDING_DIM = 256
export const MIN_FINGERPRINT_SAMPLES = 8000

/** `turns(from:)`: merges consecutive same-speaker spans whose gap is < 1 s (input in time order). */
export function mergeTurns(spans: readonly SpeakerTurn[]): SpeakerTurn[] {
  const out: SpeakerTurn[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last.speaker === s.speaker && s.start - last.end < TURN_MERGE_GAP) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

/** `speechConfirmed`: turns overlapping some VAD segment by ≥ 0.3 s. Empty VAD → no turns. */
export function speechConfirmed(turns: readonly SpeakerTurn[], vad: readonly SpeechSegment[]): SpeakerTurn[] {
  if (!vad.length) return []
  return turns.filter((t) => vad.some((v) => overlap(t, v) >= CONFIRM_OVERLAP))
}

/** Fingerprint source pieces per local speaker: its 3 longest turns > 1 s → trimmed snippets ∩ VAD (pieces ≥ 0.3 s). */
export function fingerprintPieces(turns: readonly SpeakerTurn[], vad: readonly SpeechSegment[]): Map<string, [number, number][]> {
  const bySpeaker = new Map<string, SpeakerTurn[]>()
  for (const t of turns) bySpeaker.set(t.speaker, [...(bySpeaker.get(t.speaker) ?? []), t])
  const out = new Map<string, [number, number][]>()
  for (const [speaker, list] of bySpeaker) {
    const longest = list
      .filter((t) => t.end - t.start > 1.0)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, 3)
    const pieces: [number, number][] = []
    for (const t of longest) {
      const s0 = t.start + 0.25
      const s1 = Math.min(t.end, t.start + 6.0) - 0.25
      if (s1 - s0 < 0.5) continue
      if (!vad.length) {
        pieces.push([s0, s1])
        continue
      }
      for (const v of vad) {
        const a = Math.max(s0, v.start)
        const b = Math.min(s1, v.end)
        if (b - a >= 0.3) pieces.push([a, b])
      }
    }
    if (pieces.length) out.set(speaker, pieces)
  }
  return out
}

export function l2normalize(v: ArrayLike<number>): number[] {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  return Array.from(v, (x) => (n > 0 ? x / n : 0))
}

/** Sum of vectors, L2-normalized (the per-speaker fingerprint). */
export function fingerprint(vectors: readonly ArrayLike<number>[]): number[] {
  if (!vectors.length) return []
  const sum = new Array<number>(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i] ?? 0
  return l2normalize(sum)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return -1
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : -1
}

export interface VoiceItem {
  mediaRef: string
  local: string
  vector: number[]
}

export interface Assignment {
  /** mediaRef → local label → global speaker id. */
  byFileLocal: Record<string, Record<string, number>>
  newEntries: { id: number; centroid: number[] }[]
}

/**
 * `assignments`: greedy online clustering against the registry (threshold 0.45, one cluster per speaker per file).
 * Items: files in order, labels ascending within a file. Existing centroids are never updated. Registry entries with
 * a centroid that isn't 256-d are kept for display but ignored for matching.
 */
export function assignSpeakers(registry: readonly SpeakerRegistryEntry[], items: readonly VoiceItem[]): Assignment {
  const clusters = registry.filter((r) => r.centroid.length === EMBEDDING_DIM).map((r) => ({ id: r.id, centroid: r.centroid, refs: new Set<string>(), isNew: false }))
  let nextId = Math.max(0, ...registry.map((r) => r.id)) + 1
  const byFileLocal: Record<string, Record<string, number>> = {}
  for (const item of items) {
    let best = -1
    let bestSim = MATCH_THRESHOLD
    clusters.forEach((c, i) => {
      if (c.refs.has(item.mediaRef)) return
      const sim = cosine(item.vector, c.centroid)
      if (sim >= bestSim) {
        best = i
        bestSim = sim
      }
    })
    if (best < 0) {
      clusters.push({ id: nextId++, centroid: item.vector, refs: new Set(), isNew: true })
      best = clusters.length - 1
    }
    clusters[best].refs.add(item.mediaRef)
    ;(byFileLocal[item.mediaRef] ??= {})[item.local] = clusters[best].id
  }
  return { byFileLocal, newEntries: clusters.filter((c) => c.isNew).map((c) => ({ id: c.id, centroid: c.centroid })) }
}

/** SwiftUI `.blue, .green, .orange, .purple, .pink, .teal, .yellow, .indigo` (dark-mode system colours). */
export const SPEAKER_PALETTE = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#FF375F', '#40C8E0', '#FFD60A', '#5E5CE6']

const hexToRgba = (hex: string): number[] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

export function newRegistryEntry(id: number, centroid: number[]): SpeakerRegistryEntry {
  return { id, name: `Speaker ${id}`, color: hexToRgba(SPEAKER_PALETTE[(id - 1) % SPEAKER_PALETTE.length]), centroid }
}

/** Session speaker mask: one global id per 32 ms cell (−1 = none). */
export function speakerMask(turns: readonly SpeakerTurn[], localToGlobal: Record<string, number>, cellCount: number): Int32Array {
  const mask = new Int32Array(Math.max(0, cellCount)).fill(-1)
  for (const t of turns) {
    const id = localToGlobal[t.speaker]
    if (id === undefined) continue
    const lo = Math.max(0, Math.floor(t.start / CELL_SECONDS))
    const hi = Math.min(mask.length, Math.ceil(t.end / CELL_SECONDS))
    for (let c = lo; c < hi; c++) mask[c] = id
  }
  return mask
}

/** Run-length `[start, end, id]` form for IPC. */
export function speakerRuns(mask: Int32Array): [number, number, number][] {
  const out: [number, number, number][] = []
  let i = 0
  while (i < mask.length) {
    const id = mask[i]
    let j = i + 1
    while (j < mask.length && mask[j] === id) j++
    if (id >= 0) out.push([i, j, id])
    i = j
  }
  return out
}

/** Run-length mask (`speakerRuns` form, ascending, non-overlapping). */
export type SpeakerRuns = readonly (readonly [number, number, number])[]

/** Global speaker id of the 32 ms cell holding source time `t` (s), or −1. */
export function speakerIdAt(runs: SpeakerRuns, t: number): number {
  if (!Number.isFinite(t) || t < 0) return -1
  const cell = Math.floor(t / CELL_SECONDS)
  let lo = 0
  let hi = runs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = runs[mid]
    if (cell < r[0]) hi = mid - 1
    else if (cell >= r[1]) lo = mid + 1
    else return r[2]
  }
  return -1
}

/** Registry name, or `Speaker <id>` (the Mac's `namesById[gid] ?? "Speaker \(gid)"`; empty names fall back too). */
export function speakerName(id: number, registry: readonly SpeakerRegistryEntry[]): string {
  const name = registry.find((r) => r.id === id)?.name
  return name ? name : `Speaker ${id}`
}

/**
 * get_transcript relabelling (02 §3.33 / 07 §3.5 step 10): each word takes the project-wide speaker identified at its
 * source midpoint; words outside any identified turn keep their provider label (none for local whisper).
 */
export function relabelWords<W extends { start?: number; end?: number; speaker?: string }>(words: readonly W[], runs: SpeakerRuns, registry: readonly SpeakerRegistryEntry[]): W[] {
  return words.map((w) => {
    if (w.start === undefined || w.end === undefined) return w
    const id = speakerIdAt(runs, (w.start + w.end) / 2)
    return id >= 0 ? { ...w, speaker: speakerName(id, registry) } : w
  })
}

export function rgbaCss(color: readonly number[], alpha = 1): string {
  const [r, g, b] = color.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255))
  return `rgba(${r},${g},${b},${alpha})`
}
