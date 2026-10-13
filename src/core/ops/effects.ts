import { swiftRound } from '../keyframes'
import { newId, type Clip, type Effect } from '../model'
import { effectInsertIndex } from '../timeline'

export interface EffectParamSpec {
  key: string
  min: number
  max: number
  default: number
}

export interface EffectDescriptor {
  type: string
  params: EffectParamSpec[]
}

const p = (key: string, min: number, max: number, def: number): EffectParamSpec => ({ key, min, max, default: def })
const d = (type: string, ...params: EffectParamSpec[]): EffectDescriptor => ({ type, params })

/** Visual effect registry in canonical render order (audio.denoise is not a visual effect). */
export const EFFECT_REGISTRY: EffectDescriptor[] = [
  d('color.exposure', p('ev', -3, 3, 0)),
  d('color.contrast', p('amount', 0.5, 1.5, 1)),
  d('color.highlightsShadows', p('highlights', -1, 1, 0), p('shadows', -1, 1, 0)),
  d('color.blacksWhites', p('blacks', -1, 1, 0), p('whites', -1, 1, 0)),
  d('color.temperature', p('temperature', 2000, 11000, 6500), p('tint', -100, 100, 0)),
  d('color.vibrance', p('amount', -1, 1, 0)),
  d('color.saturation', p('amount', 0, 2, 1)),
  d(
    'color.wheels',
    p('lift_x', -1, 1, 0),
    p('lift_y', -1, 1, 0),
    p('lift_m', -0.5, 0.5, 0),
    p('gamma_x', -1, 1, 0),
    p('gamma_y', -1, 1, 0),
    p('gamma_m', 0.5, 2, 1),
    p('gain_x', -1, 1, 0),
    p('gain_y', -1, 1, 0),
    p('gain_m', 0.5, 1.5, 1),
  ),
  d('color.curves'),
  d('color.hueCurves'),
  d('color.lut', p('intensity', 0, 1, 1)),
  d('detail.clarity', p('clarity', -1, 1, 0), p('dehaze', -1, 1, 0)),
  d('key.chroma', p('keyHue', 0, 1, 0.333), p('tolerance', 0, 1, 0), p('softness', 0, 1, 0.1), p('spill', 0, 1, 0.5)),
  d('blur.gaussian', p('radius', 0, 100, 8)),
  d('blur.sharpen', p('amount', 0, 2, 0.4)),
  d('blur.noiseReduction', p('amount', 0, 1, 0)),
  d('blur.motion', p('radius', 0, 100, 0), p('angle', -180, 180, 0)),
  d('stylize.invert'),
  d('stylize.grain', p('amount', 0, 1, 0), p('size', 0.5, 4, 1.5)),
  d('stylize.vignette', p('amount', -1, 1, 0), p('midpoint', 0, 1, 0.5), p('roundness', -1, 1, 0), p('feather', 0, 1, 0.5)),
  d('stylize.glow', p('intensity', 0, 1, 0), p('radius', 0, 100, 20), p('threshold', 0, 1, 0.6), p('warmth', 0, 1, 0)),
]

export const effectDescriptor = (type: string): EffectDescriptor | undefined => EFFECT_REGISTRY.find((e) => e.type === type)

export function makeEffect(desc: EffectDescriptor): Effect {
  return { id: newId(), type: desc.type, enabled: true, params: Object.fromEntries(desc.params.map((s) => [s.key, { value: s.default }])) }
}

const round3 = (v: number) => swiftRound(v * 1000) / 1000

export interface EffectEntry {
  type: string
  params?: Record<string, number>
  enabled?: boolean
}

/** Agent/inspector merge: removes listed types, then adds or updates entries at their canonical index. */
export function applyEffectEntries(c: Clip, entries: EffectEntry[], removeTypes: string[]): void {
  let stack: Effect[] = (c.effects ?? []).filter((e) => !removeTypes.includes(e.type))
  for (const entry of entries) {
    const desc = effectDescriptor(entry.type)
    if (!desc) continue
    const existing = stack.find((e) => e.type === entry.type)
    const effect: Effect = existing ? { ...existing, params: { ...existing.params } } : makeEffect(desc)
    if (entry.enabled !== undefined) effect.enabled = entry.enabled
    for (const spec of desc.params) {
      const v = entry.params?.[spec.key]
      if (v !== undefined) effect.params[spec.key] = { value: round3(Math.min(spec.max, Math.max(spec.min, v))) }
    }
    stack = stack.filter((e) => e.type !== entry.type)
    stack.splice(effectInsertIndex(stack, entry.type), 0, effect)
  }
  if (stack.length) c.effects = stack
  else delete c.effects
}
