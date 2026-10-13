import { describe, expect, it } from 'vitest'
import type { Effect } from '@core/model'
import { evalCurve, evalHue, gradeCurveTables, hueCurveTable, parseGradeCurve, parseHueCurves, temperatureMatrix, wheelCoefficients, wheelsNeutral } from '../src/renderer/render/effects/color'
import { EFFECTS_BY_ID, resolveParams } from '../src/renderer/render/effects/registry'
import { changesPixels } from '../src/renderer/render/effects/run'

const effect = (type: string, params: Effect['params']): Effect => ({ id: 'e', type, enabled: true, params })

describe('effect params (§8.1)', () => {
  it('covers all 21 visual effects', () => {
    expect(EFFECTS_BY_ID.size).toBe(21)
  })

  it('reads static values, defaults for missing keys, and clamps to the range', () => {
    const r = resolveParams(EFFECTS_BY_ID.get('stylize.glow')!, effect('stylize.glow', { intensity: { value: 7 }, threshold: { value: -1 } }), 0)
    expect(r.values).toEqual({ intensity: 1, radius: 20, threshold: 0, warmth: 0 })
  })

  it('samples keyframe tracks at the clip offset with their interpolation', () => {
    const track = {
      keyframes: [
        { frame: 0, value: -1, interpolationOut: 'linear' as const },
        { frame: 10, value: 1, interpolationOut: 'smooth' as const },
        { frame: 20, value: -1, interpolationOut: 'hold' as const },
        { frame: 30, value: 9, interpolationOut: 'linear' as const },
      ],
    }
    const e = effect('color.exposure', { ev: { value: 0, track } })
    const at = (o: number) => resolveParams(EFFECTS_BY_ID.get('color.exposure')!, e, o).values.ev
    expect(at(5)).toBeCloseTo(0)
    expect(at(13)).toBeCloseTo(1 - 2 * (0.09 * (3 - 0.6)))
    expect(at(25)).toBe(-1)
    expect(at(40)).toBe(3)
  })

  it('passes string params and the grain frame / spatial scale through', () => {
    const r = resolveParams(EFFECTS_BY_ID.get('color.lut')!, effect('color.lut', { path: { string: '/x.cube' } }), 12, 0.5)
    expect(r).toMatchObject({ strings: { path: '/x.cube' }, values: { intensity: 1 }, frame: 12, spatialScale: 0.5 })
  })
})

describe('colour helpers (§8.6, §8.10–§8.12)', () => {
  it('temperature 6500 K / tint 0 is the identity', () => {
    const m = temperatureMatrix(6500, 0)
    Array.from(m).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 6))
  })

  it('a source assumed warmer than 6500 K is cooled (blue gain > red gain)', () => {
    const m = temperatureMatrix(9000, 0)
    expect(m[8]).toBeLessThan(m[0])
    const w = temperatureMatrix(3000, 0)
    expect(w[0]).toBeLessThan(w[8])
  })

  it('wheel coefficients: neutral detection and luma-neutral chroma offsets', () => {
    const neutral = { lift_x: 0, lift_y: 0, lift_m: 0, gamma_x: 0, gamma_y: 0, gamma_m: 1, gain_x: 0, gain_y: 0, gain_m: 1 }
    expect(wheelsNeutral(neutral)).toBe(true)
    const c = wheelCoefficients({ ...neutral, lift_x: 1, gain_m: 1.2 })
    expect(c.lift.reduce((a, b) => a + b, 0)).toBeCloseTo(0)
    expect(c.lift[0]).toBeCloseTo((2 / 3) * 0.2)
    expect(c.gain).toEqual([1.2, 1.2, 1.2])
    expect(c.invGamma).toEqual([1, 1, 1])
  })

  it('curves: piecewise-linear, flat outside, tables built at i/255', () => {
    expect(evalCurve([{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.9 }], 0.4)).toBeCloseTo(0.5)
    expect(evalCurve([{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.9 }], 0.9)).toBe(0.9)
    const t = gradeCurveTables(parseGradeCurve(JSON.stringify({ master: [], red: [{ x: 0, y: 1 }, { x: 1, y: 0 }], green: [], blue: [] }))!)
    expect(t.channels[0]).toBe(1)
    expect(t.channels[255 * 4]).toBe(0)
    expect(t.master[128 * 4]).toBeCloseTo(128 / 255)
    expect(parseGradeCurve('{"master":[]}')).toBeNull()
  })

  it('hue curves: cyclic evaluation and a neutral table for empty curves', () => {
    expect(evalHue([{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.6 }], 0)).toBeCloseTo(0.4)
    const t = hueCurveTable(parseHueCurves(JSON.stringify({ hueVsHue: [], hueVsSat: [], hueVsLum: [] }))!)
    expect(Array.from(t.slice(0, 4))).toEqual([0, 0, 0, 1])
  })
})

describe('direct placement (no crop copy)', () => {
  it('only enabled, known effects or edge rounding change the working image', () => {
    expect(changesPixels(undefined, 0, 0)).toBe(false)
    expect(changesPixels([], 0, 0)).toBe(false)
    expect(changesPixels([{ ...effect('color.saturation', {}), enabled: false }], 0, 0)).toBe(false)
    expect(changesPixels([effect('not.an.effect', {})], 0, 0)).toBe(false)
    expect(changesPixels([effect('color.saturation', {})], 0, 0)).toBe(true)
    expect(changesPixels(undefined, 0.2, 0)).toBe(true)
    expect(changesPixels(undefined, 0, 0.1)).toBe(true)
    expect(changesPixels(undefined, NaN, -1)).toBe(false)
  })
})
