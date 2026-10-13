/** Row-major 3×3 matrices for 2D affine / projective maps: (x, y, 1) → (x', y', w'). Pure. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1]
export const scale = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1]

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

export function apply(m: Mat3, x: number, y: number): [number, number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5], m[6] * x + m[7] * y + m[8]]
}

/** Column-major copy for `uniformMatrix3fv`. */
export function toGL(m: Mat3, out = new Float32Array(9)): Float32Array {
  out[0] = m[0]
  out[1] = m[3]
  out[2] = m[6]
  out[3] = m[1]
  out[4] = m[4]
  out[5] = m[7]
  out[6] = m[2]
  out[7] = m[5]
  out[8] = m[8]
  return out
}

/** Column-major GL matrix back to row-major. */
export function fromGL(g: Float32Array): Mat3 {
  return [g[0], g[3], g[6], g[1], g[4], g[7], g[2], g[5], g[8]]
}

/** Rotation by `deg` (clockwise on a y-down canvas) about (cx, cy). */
export function rotateAbout(deg: number, cx: number, cy: number): Mat3 {
  const th = (deg * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1]
}

export interface Pt {
  x: number
  y: number
}

/** Heckbert unit square → quad: (0,0)→p0, (1,0)→p1, (1,1)→p2, (0,1)→p3 (spec 04 §9.10). */
export function squareToQuad(q: [Pt, Pt, Pt, Pt]): Mat3 {
  const [p0, p1, p2, p3] = q
  const sx = p0.x - p1.x + p2.x - p3.x
  const sy = p0.y - p1.y + p2.y - p3.y
  let g = 0
  let h = 0
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const dx1 = p1.x - p2.x
    const dx2 = p3.x - p2.x
    const dy1 = p1.y - p2.y
    const dy2 = p3.y - p2.y
    const det = dx1 * dy2 - dx2 * dy1
    g = (sx * dy2 - dx2 * sy) / det
    h = (dx1 * sy - sx * dy1) / det
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1]
}

/** Projective X/Y tilt plus Z rotation about `P` (TextTiltGeometry, spec 04 §9.10). */
export function tiltProject(pt: Pt, P: Pt, t: { rotationX: number; rotationY: number; rotation: number; width: number; height: number }, W: number, H: number): Pt {
  const rad = (d: number) => (d * Math.PI) / 180
  const sX = Math.sin(rad(t.rotationX))
  const cX = Math.cos(rad(t.rotationX))
  const sY = Math.sin(rad(t.rotationY))
  const cY = Math.cos(rad(t.rotationY))
  const sZ = Math.sin(rad(t.rotation))
  const cZ = Math.cos(rad(t.rotation))
  const E = Math.max(W, H)
  const maxHalfW = Math.max((Math.abs(t.width) * W) / 2, Math.abs(P.x), Math.abs(W - P.x))
  const maxHalfH = Math.max((Math.abs(t.height) * H) / 2, Math.abs(P.y), Math.abs(H - P.y))
  const maxDepth = maxHalfW * Math.abs(sY) + maxHalfH * Math.abs(sX * cY)
  const focal = Math.max(E * 2, maxDepth + E / 4)
  const x = pt.x - P.x
  const y = -(pt.y - P.y)
  const tx = x * cY + y * sX * sY
  const ty = y * cX
  const depth = -x * sY + y * sX * cY
  const k = focal / (focal + depth)
  const X = tx * k
  const Y = -ty * k
  return { x: P.x + X * cZ - Y * sZ, y: P.y + X * sZ + Y * cZ }
}
