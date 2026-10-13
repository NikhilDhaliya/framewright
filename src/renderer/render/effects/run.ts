/** Runs the effect stack on a straight-alpha working image (spec 04 §8). */
import type { Effect } from '@core/model'
import type { GL, Program, RenderTarget } from '../gl'
import type { LutCache } from '../lut'
import { gradeCurveIsIdentity, gradeCurveTables, hueCurvesIsIdentity, hueCurveTable, parseGradeCurve, parseHueCurves, temperatureMatrix, wheelCoefficients, wheelsNeutral } from './color'
import { EFFECTS_BY_ID, resolveParams, type ResolvedParams } from './registry'
import * as S from './shaders'

export interface EffectContext {
  gl: GL
  luts: LutCache
  tables: TableCache
}

/** Curve / hue-curve lookup textures cached per JSON payload (cap 64, like macOS). */
export class TableCache {
  private readonly entries = new Map<string, WebGLTexture[] | null>()

  constructor(private readonly gl: GL) {}

  get(kind: 'curve' | 'hue', json: string): WebGLTexture[] | null {
    const key = `${kind}:${json}`
    if (this.entries.has(key)) {
      const hit = this.entries.get(key)!
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    let value: WebGLTexture[] | null = null
    if (kind === 'curve') {
      const c = parseGradeCurve(json)
      if (c && !gradeCurveIsIdentity(c)) {
        const t = gradeCurveTables(c)
        value = [this.gl.tableTexture(t.channels), this.gl.tableTexture(t.master)]
      }
    } else {
      const c = parseHueCurves(json)
      if (c && !hueCurvesIsIdentity(c)) value = [this.gl.tableTexture(hueCurveTable(c))]
    }
    this.entries.set(key, value)
    while (this.entries.size > 64) {
      const [k, v] = this.entries.entries().next().value as [string, WebGLTexture[] | null]
      for (const t of v ?? []) this.gl.gl.deleteTexture(t)
      this.entries.delete(k)
    }
    return value
  }

  dispose(): void {
    for (const v of this.entries.values()) for (const t of v ?? []) this.gl.gl.deleteTexture(t)
    this.entries.clear()
  }
}

function pass(ctx: EffectContext, key: string, frag: string, src: RenderTarget, setup?: (p: Program) => void): RenderTarget {
  const g = ctx.gl
  const p = g.program(key, frag)
  g.use(p)
  const dst = g.acquire(src.width, src.height)
  g.bindTexture(p, 'uSrc', 0, src.texture)
  g.f2(p, 'uExtent', src.width, src.height)
  setup?.(p)
  g.draw(dst)
  return dst
}

function blur1d(ctx: EffectContext, src: RenderTarget, sigma: number, horizontal: boolean): RenderTarget {
  return pass(ctx, 'gauss1d', S.GAUSSIAN_1D, src, (p) => {
    ctx.gl.f2(p, 'uDir', horizontal ? 1 : 0, horizontal ? 0 : 1)
    ctx.gl.f1(p, 'uSigma', sigma)
    ctx.gl.intUniform(p, 'uRadius', Math.ceil(3 * sigma))
  })
}

/** Separable Gaussian, clamp-to-extent; σ > 8 runs on a box-downsampled copy (§8.3). Returns a new target. */
export function gaussian(ctx: EffectContext, src: RenderTarget, sigma: number): RenderTarget {
  const g = ctx.gl
  if (sigma <= 8) {
    const a = blur1d(ctx, src, sigma, true)
    const b = blur1d(ctx, a, sigma, false)
    g.release(a)
    return b
  }
  const k = 2 ** Math.ceil(Math.log2(sigma / 8))
  const sw = Math.max(1, Math.ceil(src.width / k))
  const sh = Math.max(1, Math.ceil(src.height / k))
  const down = g.program('downsample', S.DOWNSAMPLE)
  g.use(down)
  const small = g.acquire(sw, sh)
  g.bindTexture(down, 'uSrc', 0, src.texture)
  g.f2(down, 'uExtent', src.width, src.height)
  g.intUniform(down, 'uFactor', k)
  g.draw(small)
  const a = blur1d(ctx, small, sigma / k, true)
  g.release(small)
  const b = blur1d(ctx, a, sigma / k, false)
  g.release(a)
  const up = g.program('upsample', S.UPSAMPLE)
  g.use(up)
  const out = g.acquire(src.width, src.height)
  g.bindTexture(up, 'uSmall', 0, b.texture)
  g.f2(up, 'uSmallSize', sw, sh)
  g.f1(up, 'uFactor', k)
  g.draw(out)
  g.release(b)
  return out
}

/** Gaussian blur effect on straight alpha: premultiply → blur → unpremultiply (§8.16). Consumes `src`. */
export function gaussianEffect(ctx: EffectContext, src: RenderTarget, radiusPx: number): RenderTarget {
  if (!(radiusPx > 0)) return src
  const g = ctx.gl
  const pre = pass(ctx, 'premultiply', S.PREMULTIPLY, src)
  g.release(src)
  const blurred = gaussian(ctx, pre, radiusPx)
  g.release(pre)
  const out = pass(ctx, 'unpremultiply', S.UNPREMULTIPLY, blurred)
  g.release(blurred)
  return out
}

const tempCache = new Map<string, Float32Array>()
function tempMatrix(T: number, tint: number): Float32Array {
  const key = `${T}:${tint}`
  let m = tempCache.get(key)
  if (!m) {
    m = temperatureMatrix(T, tint)
    if (tempCache.size > 256) tempCache.clear()
    tempCache.set(key, m)
  }
  return m
}

/** Applies one resolved effect; consumes `src` and returns the result (possibly `src` itself when skipped). */
export function applyEffect(ctx: EffectContext, src: RenderTarget, type: string, r: ResolvedParams, origin: readonly [number, number]): RenderTarget {
  const g = ctx.gl
  const v = r.values
  const simple = (key: string, frag: string, setup: (p: Program) => void) => {
    const out = pass(ctx, key, frag, src, setup)
    g.release(src)
    return out
  }
  switch (type) {
    case 'color.exposure':
      return simple('exposure', S.EXPOSURE, (p) => g.f1(p, 'uEV', v.ev))
    case 'color.contrast':
      return simple('contrast', S.CONTRAST, (p) => g.f1(p, 'uAmount', v.amount))
    case 'color.saturation':
      return simple('saturation', S.SATURATION, (p) => g.f1(p, 'uAmount', v.amount))
    case 'color.temperature':
      return simple('matrix', S.MATRIX, (p) => g.mat3(p, 'uM', tempMatrix(v.temperature, v.tint)))
    case 'color.highlightsShadows':
      if (v.highlights === 0 && v.shadows === 0) return src
      return simple('highlightsShadows', S.HIGHLIGHTS_SHADOWS, (p) => {
        g.f1(p, 'uHighlights', v.highlights)
        g.f1(p, 'uShadows', v.shadows)
      })
    case 'color.blacksWhites':
      if (v.blacks === 0 && v.whites === 0) return src
      return simple('levels', S.LEVELS, (p) => {
        g.f1(p, 'uBlacks', v.blacks)
        g.f1(p, 'uWhites', v.whites)
      })
    case 'color.vibrance':
      return simple('vibrance', S.VIBRANCE, (p) => g.f1(p, 'uAmount', v.amount))
    case 'color.wheels': {
      if (wheelsNeutral(v)) return src
      const c = wheelCoefficients(v)
      return simple('wheels', S.WHEELS, (p) => {
        g.f3(p, 'uLift', c.lift[0], c.lift[1], c.lift[2])
        g.f3(p, 'uGain', c.gain[0], c.gain[1], c.gain[2])
        g.f3(p, 'uInvGamma', c.invGamma[0], c.invGamma[1], c.invGamma[2])
      })
    }
    case 'color.curves': {
      const json = r.strings.curve
      const t = json ? ctx.tables.get('curve', json) : null
      if (!t) return src
      return simple('curves', S.CURVES, (p) => {
        g.bindTexture(p, 'uCh', 1, t[0])
        g.bindTexture(p, 'uMaster', 2, t[1])
      })
    }
    case 'color.hueCurves': {
      const json = r.strings.curves
      const t = json ? ctx.tables.get('hue', json) : null
      if (!t) return src
      return simple('hueCurves', S.HUE_CURVES, (p) => g.bindTexture(p, 'uLut', 1, t[0]))
    }
    case 'color.lut': {
      const path = r.strings.path
      const lut = path ? ctx.luts.get(path) : null
      if (!lut) return src
      return simple('lut3d', S.LUT3D, (p) => {
        g.bindTexture(p, 'uLut', 1, lut.texture, g.gl.TEXTURE_3D)
        g.f1(p, 'uN', lut.n)
        g.f1(p, 'uIntensity', v.intensity)
      })
    }
    case 'detail.clarity': {
      // σ is relative to the extent, so a reduced preview extent scales it already.
      if (v.clarity === 0 && v.dehaze === 0) return src
      const blurred = gaussian(ctx, src, Math.max(src.width, src.height) / 40)
      const out = simple('clarity', S.CLARITY, (p) => {
        g.bindTexture(p, 'uBlur', 1, blurred.texture)
        g.f1(p, 'uClarity', v.clarity)
        g.f1(p, 'uDehaze', v.dehaze)
      })
      g.release(blurred)
      return out
    }
    case 'key.chroma':
      if (v.tolerance <= 0) return src
      return simple('chroma', S.CHROMA_KEY, (p) => {
        g.f1(p, 'uKeyHue', v.keyHue)
        g.f1(p, 'uTolerance', v.tolerance)
        g.f1(p, 'uSoftness', v.softness)
        g.f1(p, 'uSpill', v.spill)
      })
    case 'blur.gaussian':
      return gaussianEffect(ctx, src, v.radius * r.spatialScale * r.pixelScale)
    case 'blur.sharpen': {
      if (v.amount === 0) return src
      const luma = pass(ctx, 'luma', S.LUMA, src)
      // [APPROX] CISharpenLuminance default radius 1.69 used as σ.
      const lumaBlur = gaussian(ctx, luma, 1.69 * r.pixelScale)
      g.release(luma)
      const out = simple('sharpen', S.SHARPEN, (p) => {
        g.bindTexture(p, 'uLumaBlur', 1, lumaBlur.texture)
        g.f1(p, 'uSharpness', v.amount)
      })
      g.release(lumaBlur)
      return out
    }
    case 'blur.noiseReduction':
      // [APPROX] preview at a reduced scale keeps the 5×5 kernel in working px.
      if (v.amount <= 0) return src
      return simple('noiseReduction', S.NOISE_REDUCTION, (p) => {
        g.f1(p, 'uNoise', v.amount * 0.1)
        g.f1(p, 'uSharp', 0.4)
      })
    case 'blur.motion':
      if (v.radius <= 0) return src
      return simple('motionBlur', S.MOTION_BLUR, (p) => {
        g.f1(p, 'uRadius', v.radius * r.pixelScale)
        g.f1(p, 'uAngle', (v.angle * Math.PI) / 180)
      })
    case 'stylize.invert':
      return simple('invert', S.INVERT, () => undefined)
    case 'stylize.grain':
      if (v.amount <= 0) return src
      return simple('grain', S.GRAIN, (p) => {
        g.f1(p, 'uAmount', v.amount)
        g.f1(p, 'uSize', v.size * r.pixelScale)
        g.f1(p, 'uFrame', r.frame)
        g.f2(p, 'uOrigin', origin[0], origin[1])
      })
    case 'stylize.vignette':
      if (v.amount === 0) return src
      return simple('vignette', S.VIGNETTE, (p) => {
        g.f1(p, 'uAmount', v.amount)
        g.f1(p, 'uMidpoint', v.midpoint)
        g.f1(p, 'uRoundness', v.roundness)
        g.f1(p, 'uFeather', v.feather)
      })
    case 'stylize.glow': {
      if (v.intensity <= 0) return src
      const bright = pass(ctx, 'glowBright', S.GLOW_BRIGHT, src, (p) => {
        g.f1(p, 'uThreshold', v.threshold)
        g.f1(p, 'uWarmth', v.warmth)
      })
      const glow = gaussian(ctx, bright, v.radius * r.pixelScale)
      g.release(bright)
      const out = simple('glowComposite', S.GLOW_COMPOSITE, (p) => {
        g.bindTexture(p, 'uGlow', 1, glow.texture)
        g.f1(p, 'uIntensity', v.intensity)
      })
      g.release(glow)
      return out
    }
    default:
      return src
  }
}

/**
 * Enabled effects in array order at clip offset `o` (§8.1). `skipGaussian` is used by text clips,
 * whose blur runs separately from `blurRadiusAt`. Consumes `work`.
 */
export function runEffects(ctx: EffectContext, work: RenderTarget, effects: Effect[] | undefined, o: number, spatialScale: number, origin: readonly [number, number], skipGaussian = false, pixelScale = 1): RenderTarget {
  if (!effects?.length) return work
  let cur = work
  for (const e of effects) {
    if (!e.enabled || (skipGaussian && e.type === 'blur.gaussian')) continue
    const desc = EFFECTS_BY_ID.get(e.type)
    if (!desc) continue
    cur = applyEffect(ctx, cur, e.type, resolveParams(desc, e, o, spatialScale, pixelScale), origin)
  }
  return cur
}

/** Edge rounding on the cropped extent (§5.4). Consumes `work`. */
export function edgeRounding(ctx: EffectContext, work: RenderTarget, rounding: number, softness: number): RenderTarget {
  const r = Math.min(1, Math.max(0, rounding || 0))
  const s = Math.min(1, Math.max(0, softness || 0))
  if (r === 0 && s === 0) return work
  const out = pass(ctx, 'edgeRounding', S.EDGE_ROUNDING, work, (p) => {
    ctx.gl.f1(p, 'uRounding', r)
    ctx.gl.f1(p, 'uSoftness', s)
  })
  ctx.gl.release(work)
  return out
}

/** Whether a clip has any effect the text path must run (§9.10). */
/** Whether `runEffects` / `edgeRounding` would change a working image at all. */
export const changesPixels = (effects: Effect[] | undefined, rounding: number, softness: number): boolean => !!effects?.some((e) => e.enabled && EFFECTS_BY_ID.has(e.type)) || rounding > 0 || softness > 0

export const hasNonBlurEffects = (effects: Effect[] | undefined): boolean => !!effects?.some((e) => e.type !== 'blur.gaussian')
