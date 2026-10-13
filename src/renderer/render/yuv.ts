/**
 * Y'CbCr planes of decoded preview frames (VideoFrame.copyTo) and their conversion to RGB: the stream's
 * matrix and range only, no transfer or primaries conversion (spec 04 §7.2). Pure.
 */

export type YuvFormat = 'I420' | 'I420A' | 'I422' | 'I444' | 'NV12'
export const YUV_FORMATS: ReadonlySet<string> = new Set<YuvFormat>(['I420', 'I420A', 'I422', 'I444', 'NV12'])

export interface PlaneLayout {
  offset: number
  stride: number
}

export interface YuvPlanes {
  format: YuvFormat
  /** Visible size in luma samples. */
  width: number
  height: number
  data: Uint8Array
  layout: PlaneLayout[]
  /** VideoColorSpace.matrix / fullRange; null when the stream is untagged. */
  matrix: string | null
  fullRange: boolean | null
}

export interface PlaneSpec {
  width: number
  height: number
  /** Bytes per sample: 1 (R8) or 2 (interleaved CbCr, RG8). */
  channels: 1 | 2
}

/** Plane sizes in upload order: Y, then Cb/Cr (or interleaved CbCr), then alpha. */
export function planeSpecs(format: YuvFormat, w: number, h: number): PlaneSpec[] {
  const cw = format === 'I444' ? w : Math.ceil(w / 2)
  const ch = format === 'I444' || format === 'I422' ? h : Math.ceil(h / 2)
  const y: PlaneSpec = { width: w, height: h, channels: 1 }
  if (format === 'NV12') return [y, { width: cw, height: ch, channels: 2 }]
  const c: PlaneSpec = { width: cw, height: ch, channels: 1 }
  return format === 'I420A' ? [y, c, c, y] : [y, c, c]
}

const KR_KB: Record<'709' | '601' | '2020' | '240', [number, number]> = {
  '709': [0.2126, 0.0722],
  '601': [0.299, 0.114],
  '2020': [0.2627, 0.0593],
  '240': [0.212, 0.087],
}

/** Same rule as the render host's FFmpeg filter: tagged matrix, else BT.709 for HD and BT.601 for SD. */
function matrixKey(matrix: string | null, height: number): keyof typeof KR_KB {
  switch (matrix) {
    case 'bt709':
      return '709'
    case 'bt470bg':
    case 'smpte170m':
      return '601'
    case 'bt2020-ncl':
      return '2020'
    case 'smpte240m':
      return '240'
    default:
      return height >= 720 ? '709' : '601'
  }
}

export interface YuvConversion {
  /** Column-major 3×3: rgb = m · (ycbcr − offset), all code values in 0…1. */
  m: Float32Array
  offset: [number, number, number]
}

export function yuvConversion(matrix: string | null, fullRange: boolean | null, height: number): YuvConversion {
  const [kr, kb] = KR_KB[matrixKey(matrix, height)]
  const kg = 1 - kr - kb
  const full = fullRange === true
  const ys = full ? 1 : 255 / 219
  const cs = full ? 1 : 255 / 224
  const crR = 2 * (1 - kr) * cs
  const cbB = 2 * (1 - kb) * cs
  const cbG = ((-2 * kb * (1 - kb)) / kg) * cs
  const crG = ((-2 * kr * (1 - kr)) / kg) * cs
  return {
    m: new Float32Array([ys, ys, ys, 0, cbG, cbB, crR, crG, 0]),
    offset: [full ? 0 : 16 / 255, 128 / 255, 128 / 255],
  }
}
