/** Per-frame effect parameter resolution (spec 04 §8.1) over the core effect registry. Pure. */
import { lerpNumber, sampleTrack } from '@core/keyframes'
import type { Effect } from '@core/model'
import { EFFECT_REGISTRY, type EffectDescriptor } from '@core/ops/effects'

export const EFFECTS_BY_ID: ReadonlyMap<string, EffectDescriptor> = new Map(EFFECT_REGISTRY.map((d) => [d.type, d]))

export interface ResolvedParams {
  values: Record<string, number>
  strings: Record<string, string>
  /** Clip offset `f − startFrame` (grain seed). */
  frame: number
  /** 1 for media, `H/1080` for text (only Gaussian blur uses it). */
  spatialScale: number
  /** Working px per source px: < 1 only for reduced-resolution preview media (§12); scales every px size. */
  pixelScale: number
}

/** Numeric params sampled at clip offset `o` and clamped to their ranges; missing keys read the default. */
export function resolveParams(desc: EffectDescriptor, e: Effect, o: number, spatialScale = 1, pixelScale = 1): ResolvedParams {
  const values: Record<string, number> = {}
  for (const spec of desc.params) {
    const prm = e.params[spec.key]
    const raw = sampleTrack(prm?.track, o, prm?.value ?? spec.default, lerpNumber)
    values[spec.key] = Number.isFinite(raw) ? Math.min(spec.max, Math.max(spec.min, raw)) : spec.default
  }
  const strings: Record<string, string> = {}
  for (const [k, v] of Object.entries(e.params)) if (typeof v.string === 'string') strings[k] = v.string
  return { values, strings, frame: o, spatialScale, pixelScale }
}
