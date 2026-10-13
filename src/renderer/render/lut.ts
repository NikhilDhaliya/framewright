/** `.cube` 3D LUT parsing with the Swift acceptance rules (spec 04 §8.13) and a per-path GL texture cache. */

export interface CubeLut {
  n: number
  /** RGBA float32, entry i = r + g·n + b·n² (red fastest). */
  data: Float32Array
}

/** Swift `Float(String)` accepted forms. */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(nan|inf|infinity)$/i
const INT = /^[+-]?\d+$/

export function parseCube(text: string): CubeLut | null {
  let n = 0
  let dmin = [0, 0, 0]
  let dmax = [1, 1, 1]
  const vals: number[] = []
  for (const raw of text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)) {
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, '')
    if (!line || line.startsWith('#')) continue
    // Splits on SPACE only: tabs are not separators [QUIRK Q9].
    const parts = line.split(' ').filter((s) => s.length > 0)
    const kw = parts[0].toUpperCase()
    if (kw === 'TITLE') continue
    if (kw === 'LUT_1D_SIZE') return null
    if (kw === 'LUT_3D_SIZE') {
      const last = parts[parts.length - 1]
      n = INT.test(last) ? parseInt(last, 10) : 0
      continue
    }
    if (kw === 'DOMAIN_MIN' || kw === 'DOMAIN_MAX') {
      const v = parts.slice(1).filter((s) => FLOAT.test(s)).map(Number)
      if (kw === 'DOMAIN_MIN') dmin = v
      else dmax = v
      continue
    }
    if (parts.length < 3) continue
    const rgb = parts.slice(0, 3)
    if (!rgb.every((s) => FLOAT.test(s))) return null
    for (const s of rgb) vals.push(Number(s))
  }
  if (!(n > 1 && n <= 128) || vals.length !== n * n * n * 3 || dmin.length !== 3 || dmax.length !== 3) return null
  const data = new Float32Array(n * n * n * 4)
  for (let i = 0; i < n * n * n; i++) {
    for (let c = 0; c < 3; c++) {
      const span = Math.max(0.0001, dmax[c] - dmin[c])
      // Domain applied to OUTPUT values [QUIRK Q9].
      const v = (vals[i * 3 + c] - dmin[c]) / span
      data[i * 4 + c] = Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v))
    }
    data[i * 4 + 3] = 1
  }
  return { n, data }
}

export interface LutTexture {
  texture: WebGLTexture
  n: number
}

/** Loads LUTs asynchronously; missing or invalid files resolve to null (the effect is a no-op). */
export class LutCache {
  private readonly parsed = new Map<string, CubeLut | null>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly textures = new Map<string, LutTexture>()

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly readText: (path: string) => Promise<string>,
    private readonly onLoaded: () => void,
  ) {}

  /** Texture for `path`, or null while loading / when invalid. Starts loading on first use. */
  get(path: string): LutTexture | null {
    const tex = this.textures.get(path)
    if (tex) {
      this.textures.delete(path)
      this.textures.set(path, tex)
      return tex
    }
    if (!this.parsed.has(path)) {
      void this.load(path).then(this.onLoaded)
      return null
    }
    const lut = this.parsed.get(path)
    if (!lut) return null
    const t = this.upload(lut)
    this.textures.set(path, t)
    while (this.textures.size > 16) {
      const [oldPath, old] = this.textures.entries().next().value as [string, LutTexture]
      this.gl.deleteTexture(old.texture)
      this.textures.delete(oldPath)
    }
    return t
  }

  load(path: string): Promise<void> {
    if (this.parsed.has(path)) return Promise.resolve()
    let p = this.pending.get(path)
    if (!p) {
      p = this.readText(path)
        .then((text) => parseCube(text))
        .catch(() => null)
        .then((lut) => {
          this.parsed.set(path, lut)
          this.pending.delete(path)
        })
      this.pending.set(path, p)
    }
    return p
  }

  private upload(lut: CubeLut): LutTexture {
    const gl = this.gl
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, texture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, lut.n, lut.n, lut.n, 0, gl.RGBA, gl.FLOAT, lut.data)
    gl.bindTexture(gl.TEXTURE_3D, null)
    return { texture, n: lut.n }
  }

  dispose(): void {
    for (const t of this.textures.values()) this.gl.deleteTexture(t.texture)
    this.textures.clear()
  }
}
