import { describe, expect, it } from 'vitest'
import { parseCube } from '../src/renderer/render/lut'

const identity2 = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1']

describe('.cube parsing (§8.13)', () => {
  it('parses a 2³ LUT with comments and TITLE, red fastest', () => {
    const lut = parseCube(['# comment', 'TITLE "x"', 'LUT_3D_SIZE 2', '', ...identity2].join('\n'))!
    expect(lut.n).toBe(2)
    expect(Array.from(lut.data.slice(0, 8))).toEqual([0, 0, 0, 1, 1, 0, 0, 1])
    expect(Array.from(lut.data.slice(28, 32))).toEqual([1, 1, 1, 1])
  })

  it('applies DOMAIN_MIN/MAX to the output values and clamps (Q9)', () => {
    const lut = parseCube(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 2 2', ...identity2.map((l) => l.replace(/1/g, '1.5'))].join('\r\n'))!
    expect(lut.data[4]).toBeCloseTo(0.75)
    const neg = parseCube(['LUT_3D_SIZE 2', ...identity2.map((l, i) => (i === 0 ? '-0.5 2 0.5' : l))].join('\n'))!
    expect(Array.from(neg.data.slice(0, 3))).toEqual([0, 1, 0.5])
  })

  it('rejects 1D LUTs, wrong counts, bad sizes and unknown three-token keywords', () => {
    expect(parseCube(['LUT_1D_SIZE 2', '0 0 0', '1 1 1'].join('\n'))).toBeNull()
    expect(parseCube(['LUT_3D_SIZE 2', ...identity2.slice(1)].join('\n'))).toBeNull()
    expect(parseCube(['LUT_3D_SIZE 1', '0 0 0'].join('\n'))).toBeNull()
    expect(parseCube(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0 1', ...identity2].join('\n'))).toBeNull()
    expect(parseCube(['LUT_3D_SIZE 2', 'DOMAIN_MAX 1 1', ...identity2].join('\n'))).toBeNull()
  })

  it('does not treat tabs as separators (Q9)', () => {
    expect(parseCube(['LUT_3D_SIZE 2', ...identity2.map((l) => l.replace(/ /g, '\t'))].join('\n'))).toBeNull()
    expect(parseCube(['\tLUT_3D_SIZE 2', ...identity2.map((l) => `  ${l}\t`)].join('\n'))).not.toBeNull()
  })

  it('accepts Swift float spellings and ignores short lines', () => {
    const lines = identity2.map((l, i) => (i === 7 ? '1.0e0 +1. .1E1' : l))
    expect(parseCube(['LUT_3D_SIZE +2', 'TWO TOKENS', ...lines].join('\n'))).not.toBeNull()
  })
})
