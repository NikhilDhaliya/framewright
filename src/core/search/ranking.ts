/** Visual query ranking (spec 07 §2.5, Mac `Search/Query/VisualSearch.swift`). */
import type { AssetIndex } from './store'

export interface VisualHit {
  assetId: string
  time: number
  shotStart: number
  shotEnd: number
  score: number
}

/** `SearchIndexConfig.visualMatchCosineFloor`. */
export const VISUAL_MATCH_COSINE_FLOOR = 0.05
export const DEFAULT_RELATIVE_CUTOFF = 0.85
export const DEFAULT_VISUAL_LIMIT = 20

const fround = Math.fround

/**
 * Top hits across assets, best-per-shot. Scores are float32 dot products (vectors are L2-normalized, so cosine).
 * Hits sort by score descending; `minScore` drops weak matches; an empty list when the top score ≤ 0; then the first
 * `limit` are kept and only those ≥ top · relativeCutoff survive.
 */
export function visualSearch(
  query: ArrayLike<number>,
  indexes: { assetId: string; index: AssetIndex }[],
  opts: { limit?: number; relativeCutoff?: number; minScore?: number | null } = {},
): VisualHit[] {
  const limit = opts.limit ?? DEFAULT_VISUAL_LIMIT
  const relativeCutoff = opts.relativeCutoff ?? DEFAULT_RELATIVE_CUTOFF
  let hits: VisualHit[] = []
  for (const { assetId, index } of indexes) {
    const dim = index.header.dim
    if (dim !== query.length || index.header.count <= 0) continue
    // Best frame per shotStart (Swift dictionary keyed by Double; insertion order is irrelevant after the sort).
    const best = new Map<number, { row: number; score: number }>()
    for (let i = 0; i < index.header.count; i++) {
      let s = 0
      const base = i * dim
      for (let d = 0; d < dim; d++) s += index.vectors[base + d] * query[d]
      const score = fround(s)
      const shot = index.rows[i].shotStart
      const existing = best.get(shot)
      if (existing && existing.score >= score) continue
      best.set(shot, { row: i, score })
    }
    for (const { row, score } of best.values()) {
      const r = index.rows[row]
      hits.push({ assetId, time: r.time, shotStart: r.shotStart, shotEnd: r.shotEnd, score })
    }
  }
  // Stable sort keeps asset order for ties (Swift's sort is not guaranteed stable; ties are rare with real scores).
  hits.sort((a, b) => b.score - a.score)
  if (opts.minScore != null) {
    const min = opts.minScore
    hits = hits.filter((h) => h.score >= min)
  }
  const top = hits[0]?.score
  if (top === undefined || !(top > 0)) return []
  const floor = fround(top * relativeCutoff)
  return hits.slice(0, limit).filter((h) => h.score >= floor)
}
