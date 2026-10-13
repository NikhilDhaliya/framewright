/** Hand-written Lottie fixtures (spec 07 §4): solid layers so rendered pixels are predictable. */
import { strToU8, zipSync } from 'fflate'

const solid = (ind: number, color: string, ip: number, op: number, w = 100, h = 100) => ({
  ddd: 0,
  ind,
  ty: 1,
  nm: `solid ${ind}`,
  sr: 1,
  ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
  ao: 0,
  sw: w,
  sh: h,
  sc: color,
  ip,
  op,
  st: 0,
  bm: 0,
})

/** 200×100 at 30 fps, frames 0–29: the left half is red (0–9), green (10–19), then blue (20–29); the right half is transparent. */
export function rgbAnimation(extra: Record<string, unknown> = {}) {
  return {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op: 30,
    w: 200,
    h: 100,
    nm: 'rgb',
    ddd: 0,
    assets: [],
    layers: [solid(1, '#ff0000', 0, 10), solid(2, '#00ff00', 10, 20), solid(3, '#0000ff', 20, 30)],
    ...extra,
  }
}

/** A dotLottie (v1 layout) holding `anim` as its first animation, plus `images/<name>` files. */
export function dotLottie(anim: object, images: Record<string, Uint8Array> = {}, layout: 'v1' | 'v2' = 'v1'): Uint8Array {
  const [a, i] = layout === 'v1' ? ['animations', 'images'] : ['a', 'i']
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ version: layout === 'v1' ? '1' : '2', generator: 'test', animations: [{ id: 'main' }] })),
    [`${a}/zzz-other.json`]: strToU8(JSON.stringify({ ...rgbAnimation(), w: 10, h: 10 })),
    [`${a}/main.json`]: strToU8(JSON.stringify(anim)),
  }
  for (const [name, bytes] of Object.entries(images)) files[`${i}/${name}`] = bytes
  return zipSync(files)
}
