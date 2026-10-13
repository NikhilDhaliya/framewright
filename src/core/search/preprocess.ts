/**
 * SigLIP 2 input preparation (spec 07 §2.2, §2.7): image → squash-resized 256×256 RGB over opaque black → NCHW
 * float32 `v/127.5 − 1`; text ids → truncated/right-padded to 64 with pad id 0 (no attention mask).
 */

export const SIGLIP_IMAGE_SIZE = 256
export const SIGLIP_CONTEXT_LENGTH = 64
export const SIGLIP_PAD_ID = 0

/**
 * Bilinear squash resize (no aspect crop, half-pixel centers like the HF/PIL bilinear path when downscaling ≤ 2×;
 * area-averaged for larger reductions) of an RGBA image composited over black, to `size`×`size` RGB bytes.
 */
export function squashResizeRgb(rgba: Uint8Array, width: number, height: number, size = SIGLIP_IMAGE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 3)
  if (width <= 0 || height <= 0) return out
  const sx = width / size
  const sy = height / size
  // Filter support grows with the reduction factor (PIL's "bilinear" = triangle filter scaled by the factor).
  const supX = Math.max(1, sx)
  const supY = Math.max(1, sy)
  const weightsFor = (center: number, support: number, limit: number) => {
    const lo = Math.max(0, Math.floor(center - support))
    const hi = Math.min(limit - 1, Math.ceil(center + support))
    const idx: number[] = []
    const w: number[] = []
    let sum = 0
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(i + 0.5 - center) / support
      const k = d < 1 ? 1 - d : 0
      if (k > 0) {
        idx.push(i)
        w.push(k)
        sum += k
      }
    }
    if (!idx.length) {
      idx.push(Math.min(limit - 1, Math.max(0, Math.floor(center))))
      w.push(1)
      sum = 1
    }
    return { idx, w: w.map((x) => x / sum) }
  }
  const cols = Array.from({ length: size }, (_, x) => weightsFor((x + 0.5) * sx, supX, width))
  const rowsW = Array.from({ length: size }, (_, y) => weightsFor((y + 0.5) * sy, supY, height))
  for (let y = 0; y < size; y++) {
    const ry = rowsW[y]
    for (let x = 0; x < size; x++) {
      const cx = cols[x]
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < ry.idx.length; j++) {
        const rowBase = ry.idx[j] * width
        const wy = ry.w[j]
        for (let i = 0; i < cx.idx.length; i++) {
          const p = (rowBase + cx.idx[i]) * 4
          const w = wy * cx.w[i] * (rgba[p + 3] / 255)
          r += rgba[p] * w
          g += rgba[p + 1] * w
          b += rgba[p + 2] * w
        }
      }
      const o = (y * size + x) * 3
      out[o] = Math.min(255, Math.max(0, Math.round(r)))
      out[o + 1] = Math.min(255, Math.max(0, Math.round(g)))
      out[o + 2] = Math.min(255, Math.max(0, Math.round(b)))
    }
  }
  return out
}

/** RGB bytes (HWC) → NCHW float32 with `v/127.5 − 1`. */
export function toPixelValues(rgb: Uint8Array, size = SIGLIP_IMAGE_SIZE): Float32Array {
  const plane = size * size
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3] / 127.5 - 1
    out[plane + i] = rgb[i * 3 + 1] / 127.5 - 1
    out[2 * plane + i] = rgb[i * 3 + 2] / 127.5 - 1
  }
  return out
}

/** Full image path: RGBA (any size) → NCHW pixel values for the vision tower. */
export function imageToPixelValues(rgba: Uint8Array, width: number, height: number, size = SIGLIP_IMAGE_SIZE): Float32Array {
  return toPixelValues(squashResizeRgb(rgba, width, height, size), size)
}

/** `TextTokenizer.tokenize`: keep the first 64 ids (EOS may be cut), right-pad with 0. */
export function padTokenIds(ids: readonly number[], contextLength = SIGLIP_CONTEXT_LENGTH): number[] {
  const out = ids.slice(0, contextLength)
  while (out.length < contextLength) out.push(SIGLIP_PAD_ID)
  return out
}

/** In-place L2 normalization (the Mac graph normalizes inside the model; the ONNX export does not). */
export function l2Normalize(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
