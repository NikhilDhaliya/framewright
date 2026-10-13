#!/usr/bin/env node
/**
 * End-to-end smoke test of the render host and export pipeline:
 * generates test media, writes a .palmier project, builds, runs Electron headless (xvfb-run + SwiftShader)
 * with out/main/smoke.cjs, then checks captures and exports with ffprobe and pixel probes.
 *
 * Usage: node scripts/smoke-render.mjs [--skip-build] [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ffmpegBin = require('ffmpeg-static')
const ffprobeBin = path.join(root, 'resources/bin/ffprobe')
const electronBin = require('electron')
const args = new Set(process.argv.slice(2))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'palmier-smoke-'))
const mediaDir = path.join(work, 'media-src')
const outDir = path.join(work, 'out')
for (const d of [mediaDir, outDir, ...['data', 'config', 'cache', 'docs'].map((x) => path.join(work, 'xdg', x))]) fs.mkdirSync(d, { recursive: true })

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

function ff(argv) {
  const r = spawnSync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { encoding: 'buffer', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(' ')}\n${r.stderr}`)
  return r.stdout
}

function probe(file, extra = []) {
  const r = spawnSync(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', ...extra, file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

/** RGB24 pixels of one decoded frame (images, or frame `index` of a video). */
function rgbFrame(file, w, h, index = 0) {
  const sel = index > 0 ? ['-vf', `select=eq(n\\,${index})`] : []
  const buf = ff(['-i', file, ...sel, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  if (buf.length < w * h * 3) throw new Error(`short frame from ${file}`)
  return { w, h, px: (x, y) => [buf[(y * w + x) * 3], buf[(y * w + x) * 3 + 1], buf[(y * w + x) * 3 + 2]], buf }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

// ---------- 1. Test media ----------
const video = path.join(mediaDir, 'bars.mp4')
ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', video])
// Frame n is a flat grey of level 3n: decoded values reveal exactly which source frame was used.
const counter = path.join(mediaDir, 'counter.mp4')
ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=30:d=3,format=rgb24,geq=r=3*N:g=3*N:b=3*N', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-g', '12', '-bf', '2', counter])
const image = path.join(mediaDir, 'red.png')
ff(['-f', 'lavfi', '-i', 'color=c=red:s=400x300:d=1', '-frames:v', '1', image])
const tone = path.join(mediaDir, 'tone.wav')
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '1', tone])
// Denoise (spec 07 §3.6): a 300 Hz tone buried in white noise; the bundled deep-filter bake should strip the hiss.
const noisy = path.join(mediaDir, 'noisy.wav')
ff(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=2', '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=white:a=0.08:r=48000:s=7', '-filter_complex', '[0][1]amix=inputs=2:normalize=0', '-ac', '1', noisy])
// Lottie (spec 07 §4): 200×100 @ 30 fps, frames 0–29; the left half is red (0–9), green (10–19), blue (20–29), the right half transparent.
const solid = (ind, sc, ip, op) => ({ ddd: 0, ind, ty: 1, nm: `s${ind}`, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0, sw: 100, sh: 100, sc, ip, op, st: 0, bm: 0 })
const rgbLottie = { v: '5.7.4', fr: 30, ip: 0, op: 30, w: 200, h: 100, nm: 'rgb', ddd: 0, assets: [], layers: [solid(1, '#ff0000', 0, 10), solid(2, '#00ff00', 10, 20), solid(3, '#0000ff', 20, 30)] }
const lottieJson = path.join(mediaDir, 'rgb.json')
fs.writeFileSync(lottieJson, JSON.stringify(rgbLottie))
const { zipSync, strToU8 } = require('fflate')
const dotLottie = path.join(mediaDir, 'rgb.lottie')
fs.writeFileSync(dotLottie, zipSync({ 'manifest.json': strToU8(JSON.stringify({ version: '1', animations: [{ id: 'main' }] })), 'animations/main.json': strToU8(JSON.stringify(rgbLottie)) }))

// ---------- 2. Project ----------
const T = (o = {}) => ({ centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, rotationX: 0, rotationY: 0, flipHorizontal: false, flipVertical: false, ...o })
const clip = (o) => ({
  id: o.id, mediaRef: o.mediaRef ?? '', mediaType: o.mediaType ?? 'video', sourceClipType: o.sourceClipType ?? o.mediaType ?? 'video',
  startFrame: o.startFrame ?? 0, durationFrames: o.durationFrames, trimStartFrame: o.trimStartFrame ?? 0, trimEndFrame: 0, speed: o.speed ?? 1,
  volume: o.volume ?? 1, fadeInFrames: o.fadeInFrames ?? 0, fadeOutFrames: 0, fadeInInterpolation: 'linear', fadeOutInterpolation: 'linear',
  opacity: 1, transform: T(o.transform), crop: { left: 0, top: 0, right: 0, bottom: 0 }, edgeRounding: 0, edgeSoftness: 0,
  ...o.extra,
})
const track = (id, type, clips) => ({ id, type, muted: false, hidden: false, syncLocked: true, clips, displayHeight: 44 })

const timelineA = {
  id: 'TL-A', name: 'Main', fps: 30, width: 640, height: 360, settingsConfigured: true, markers: [],
  tracks: [
    track('t-text', 'video', [clip({ id: 'c-text', mediaType: 'text', durationFrames: 60, transform: { centerY: 0.2, width: 0.6, height: 0.3 }, extra: { textContent: 'SMOKE', textStyle: { fontName: 'Inter', fontSize: 96, color: { r: 1, g: 1, b: 1, a: 1 }, isBold: true } } })]),
    track('t-image', 'video', [clip({ id: 'c-image', mediaRef: 'M-IMG', mediaType: 'image', durationFrames: 90, transform: { centerX: 0.75, width: 0.5, height: 0.5 }, extra: { opacityTrack: { keyframes: [{ frame: 0, value: 0, interpolationOut: 'linear' }, { frame: 30, value: 1, interpolationOut: 'linear' }] } } })]),
    track('t-video', 'video', [clip({ id: 'c-video', mediaRef: 'M-VID', durationFrames: 90, extra: { effects: [{ id: 'fx-sat', type: 'color.saturation', enabled: true, params: { amount: { value: 0 } } }] } })]),
    track('t-a1', 'audio', [clip({ id: 'c-vaudio', mediaRef: 'M-VID', mediaType: 'audio', sourceClipType: 'video', durationFrames: 90, volume: 0.5 })]),
    track('t-a2', 'audio', [clip({ id: 'c-tone', mediaRef: 'M-TONE', mediaType: 'audio', sourceClipType: 'audio', startFrame: 15, durationFrames: 60, fadeInFrames: 15 })]),
  ],
}
const timelineB = {
  id: 'TL-B', name: 'Counter', fps: 30, width: 160, height: 120, settingsConfigured: true, markers: [],
  tracks: [track('t-count', 'video', [clip({ id: 'c-count', mediaRef: 'M-CNT', durationFrames: 60, trimStartFrame: 10 })])],
}
const timelineC = {
  id: 'TL-C', name: 'Nest', fps: 30, width: 160, height: 120, settingsConfigured: true, markers: [],
  tracks: [
    track('t-nest', 'video', [clip({ id: 'c-nest', mediaRef: 'TL-B', mediaType: 'sequence', sourceClipType: 'sequence', durationFrames: 30, trimStartFrame: 5 })]),
    track('t-slow', 'video', [clip({ id: 'c-slow', mediaRef: 'M-CNT', startFrame: 30, durationFrames: 30, speed: 0.5 })]),
  ],
}
const timelineD = {
  id: 'TL-D', name: 'Lottie', fps: 30, width: 200, height: 100, settingsConfigured: true, markers: [],
  tracks: [track('t-lottie', 'video', [clip({ id: 'c-lottie', mediaRef: 'M-LOT', mediaType: 'lottie', durationFrames: 40 })])],
}
const timelineE = {
  id: 'TL-E', name: 'DotLottie', fps: 30, width: 200, height: 100, settingsConfigured: true, markers: [],
  tracks: [track('t-dotlottie', 'video', [clip({ id: 'c-dotlottie', mediaRef: 'M-DLOT', mediaType: 'lottie', durationFrames: 20, trimStartFrame: 10 })])],
}
const denoiseTl = (id, amount, enabled = true) => ({
  id, name: id, fps: 30, width: 160, height: 120, settingsConfigured: true, markers: [],
  tracks: [track(`t-${id}`, 'audio', [clip({ id: `c-${id}`, mediaRef: 'M-NOISY', mediaType: 'audio', sourceClipType: 'audio', durationFrames: 60, extra: { effects: [{ id: `fx-${id}`, type: 'audio.denoise', enabled, params: { amount: { value: amount } } }] } })])],
})
const timelinesDenoise = [denoiseTl('TL-DN-OFF', 1, false), denoiseTl('TL-DN-FULL', 1), denoiseTl('TL-DN-HALF', 0.5)]
const pkg = path.join(work, 'Smoke.palmier')
fs.mkdirSync(path.join(pkg, 'media'), { recursive: true })
fs.writeFileSync(path.join(pkg, 'project.json'), JSON.stringify({ timelines: [timelineA, timelineB, timelineC, timelineD, timelineE, ...timelinesDenoise], activeTimelineId: 'TL-A', openTimelineIds: ['TL-A'] }))
const entry = (id, name, type, file, duration, w, h, hasAudio) => ({ id, name, type, source: { external: { absolutePath: file } }, duration, ...(w ? { sourceWidth: w, sourceHeight: h } : {}), hasAudio })
fs.writeFileSync(
  path.join(pkg, 'media.json'),
  JSON.stringify({
    version: 2,
    folders: [],
    entries: [
      entry('M-VID', 'bars', 'video', video, 4, 320, 240, true),
      entry('M-CNT', 'counter', 'video', counter, 3, 160, 120, false),
      entry('M-IMG', 'red', 'image', image, 5, 400, 300, false),
      entry('M-TONE', 'tone', 'audio', tone, 3, 0, 0, true),
      entry('M-NOISY', 'noisy', 'audio', noisy, 2, 0, 0, true),
      { ...entry('M-LOT', 'rgb', 'lottie', lottieJson, 1, 200, 100, false), sourceFPS: 30 },
      { ...entry('M-DLOT', 'rgb-dot', 'lottie', dotLottie, 1, 200, 100, false), sourceFPS: 30 },
    ],
  }),
)

// ---------- 3. Tasks ----------
const o = (name) => path.join(outDir, name)
const tasks = {
  project: pkg,
  report: o('report.json'),
  captures: [
    { timelineId: 'TL-A', frame: 45, out: o('a45.png') },
    { timelineId: 'TL-A', frame: 15, out: o('a15.png') },
    { timelineId: 'TL-A', frame: 30, out: o('a30.png') },
    { timelineId: 'TL-B', frame: 0, out: o('b0.png') },
    { timelineId: 'TL-B', frame: 37, out: o('b37.png') },
    { timelineId: 'TL-C', frame: 3, out: o('c3.png') },
    { timelineId: 'TL-C', frame: 41, out: o('c41.png') },
    { timelineId: 'TL-A', frame: 45, width: 320, format: 'jpeg', out: o('a45-small.jpg') },
    { timelineId: 'TL-A', frame: 30, width: 320, out: o('a30-320.png') },
    ...[0, 15, 29, 35].map((frame) => ({ timelineId: 'TL-D', frame, out: o(`d${frame}.png`) })),
    ...[0, 12].map((frame) => ({ timelineId: 'TL-E', frame, out: o(`e${frame}.png`) })),
  ],
  lottieFrames: [
    { file: lottieJson, frames: [0, 15, 29], maxSide: 512, background: '#808080', outPrefix: o('lf-json-') },
    { file: dotLottie, frames: [0, 15, 29], maxSide: 512, background: '#808080', outPrefix: o('lf-dot-') },
  ],
  measure: [{ content: 'Hello world', style: { fontName: 'Inter', fontSize: 96, fontScale: 1, widthScale: 1, heightScale: 1, tracking: 0, lineSpacing: 0, fontCase: 'mixed', isBold: false, isItalic: false, isUnderlined: false, isStruckThrough: false, isOverlined: false, color: { r: 1, g: 1, b: 1, a: 1 }, alignment: 'center', blur: 0, shadow: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0.6 }, offsetX: 0, offsetY: -2, blur: 6 }, background: { enabled: false, color: { r: 0, g: 0, b: 0, a: 0.6 }, paddingX: 0, paddingY: 0, cornerRadius: 0, offsetX: 0, offsetY: 0, outlineColor: { r: 0, g: 0, b: 0, a: 1 }, outlineWidth: 0 }, border: { enabled: false, color: { r: 0, g: 0, b: 0, a: 1 }, width: 4 } }, canvasWidth: 1920, canvasHeight: 1080 }],
  exports: [
    { timelineId: 'TL-A', format: 'mp4', outputPath: o('a.mp4'), range: { start: 0, end: 45 } },
    { timelineId: 'TL-A', format: 'mp4', codec: 'hevc', quality: 'medium', outputPath: o('a-hevc.mp4'), range: { start: 0, end: 30 } },
    { timelineId: 'TL-A', format: 'webm', outputPath: o('a.webm'), range: { start: 0, end: 45 }, width: 320 },
    { timelineId: 'TL-A', format: 'wav', outputPath: o('a.wav'), range: { start: 0, end: 45 } },
    { timelineId: 'TL-A', format: 'm4a', outputPath: o('a.m4a'), range: { start: 0, end: 45 } },
    { timelineId: 'TL-B', format: 'mov', outputPath: o('b.mov'), quality: 'medium' },
    { timelineId: 'TL-B', format: 'mp4', outputPath: o('b-fps15.mp4'), fps: 15, quality: 'max', range: { start: 0, end: 30 } },
    { timelineId: 'TL-B', format: 'mp4', outputPath: o('b-fps60.mp4'), fps: 60, quality: 'max', range: { start: 4, end: 14 } },
    { timelineId: 'TL-A', format: 'mp4', outputPath: o('a-low.mp4'), quality: 'low', range: { start: 0, end: 45 }, includeAudio: false },
    { timelineId: 'TL-A', format: 'mp4', outputPath: o('a-max.mp4'), quality: 'max', range: { start: 0, end: 45 }, includeAudio: false },
    { timelineId: 'TL-A', format: 'mp4', outputPath: o('a-square.mp4'), width: 333, height: 300, range: { start: 40, end: 50 } },
    { timelineId: 'TL-A', format: 'gif', outputPath: o('a.gif'), range: { start: 0, end: 10 }, width: 160 },
    { timelineId: 'TL-A', format: 'png', outputPath: o('still.png'), range: { start: 45, end: 46 } },
    { timelineId: 'TL-A', format: 'png', outputPath: o('still-320.png'), range: { start: 45, end: 46 }, width: 320 },
    { timelineId: 'TL-D', format: 'mp4', outputPath: o('d.mp4'), quality: 'max', includeAudio: false },
    { timelineId: 'TL-A', format: 'palmier', outputPath: o('Copy.palmier') },
    { timelineId: 'TL-A', format: 'fcpxml', outputPath: o('a.fcpxml') },
    // Export bakes the wet file first (ExportService.swift), then mixes amount·wet + (1 − amount)·dry.
    { timelineId: 'TL-DN-OFF', format: 'wav', outputPath: o('dn-off.wav') },
    { timelineId: 'TL-DN-FULL', format: 'wav', outputPath: o('dn-full.wav') },
    { timelineId: 'TL-DN-HALF', format: 'wav', outputPath: o('dn-half.wav') },
    { timelineId: 'TL-A', format: 'webm', outputPath: o('cancel.webm'), width: 1280, cancelAfterMs: 1500 },
    { timelineId: 'TL-A', format: 'mp4', outputPath: o('cancel-early.mp4'), cancelAfterMs: 0 },
  ],
}
const tasksPath = path.join(work, 'tasks.json')
fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2))

// ---------- 4. Build + run ----------
if (!args.has('--skip-build')) {
  console.log('building…')
  const b = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' })
  if (b.status !== 0) process.exit(1)
}
console.log(`running electron (work dir ${work})…`)
const env = {
  ...process.env,
  PALMIER_SMOKE_TASKS: tasksPath,
  PALMIER_SMOKE_SWIFTSHADER: '1',
  XDG_DATA_HOME: path.join(work, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(work, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(work, 'xdg', 'cache'),
  XDG_DOCUMENTS_DIR: path.join(work, 'xdg', 'docs'),
}
delete env.PALMIER_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE
// WAYLAND_DISPLAY would make Electron open on the user's real display despite Xvfb.
delete env.WAYLAND_DISPLAY
const t0 = Date.now()
const code = await new Promise((resolve) => {
  const child = spawn('xvfb-run', ['-a', electronBin, path.join(root, 'out/main/smoke.cjs'), '--no-sandbox', '--ozone-platform=x11', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  // Kill the whole process group (xvfb-run, Xvfb, Electron and its helpers) on timeout.
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 600_000)
  child.on('close', (c) => {
    clearTimeout(timer)
    resolve(c)
  })
})
check('electron smoke run exits 0', code === 0, `code ${code}, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (!fs.existsSync(tasks.report)) {
  console.log('no report written')
  process.exit(1)
}
const report = JSON.parse(fs.readFileSync(tasks.report, 'utf8'))

// ---------- 5. Verify captures ----------
for (const c of report.captures) check(`capture ${path.basename(c.out)}`, c.ok, c.ok ? `${c.ms} ms` : c.error)

const okCapture = (name) => report.captures.find((c) => c.out === o(name))?.ok
if (okCapture('a45.png')) {
  const s = probe(o('a45.png')).streams[0]
  check('a45.png is 640x360', s.width === 640 && s.height === 360, `${s.width}x${s.height}`)
  const f = rgbFrame(o('a45.png'), 640, 360)
  const [r, g, b] = f.px(560, 260)
  check('image layer opaque red at frame 45', r > 245 && g < 10 && b < 10, `${r},${g},${b}`)
  let grey = 0
  let n = 0
  for (let y = 200; y < 350; y += 10) for (let x = 10; x < 300; x += 10) {
    const [pr, pg, pb] = f.px(x, y)
    n++
    if (Math.max(pr, pg, pb) - Math.min(pr, pg, pb) <= 6) grey++
  }
  check('saturation 0 effect makes the video grey', grey / n > 0.95, `${grey}/${n} neutral`)
  const top = f.px(10, 10)
  check('nothing but video outside the image at top-left', Math.max(...top) - Math.min(...top) <= 6, `${top}`)
}
if (okCapture('a15.png')) {
  const f = rgbFrame(o('a15.png'), 640, 360)
  const [r, g, b] = f.px(560, 260)
  // Opacity keyframes 0→1 over 30 frames: 0.5 at frame 15 over the grey video.
  check('opacity keyframe 0.5 at frame 15', near(r - (g + b) / 2, 127.5, 10), `${r},${g},${b}`)
}
if (okCapture('a30.png')) {
  const f = rgbFrame(o('a30.png'), 640, 360)
  let white = 0
  for (let y = 30; y < 115; y++) for (let x = 140; x < 500; x++) {
    const [pr, pg, pb] = f.px(x, y)
    if (pr > 245 && pg > 245 && pb > 245) white++
  }
  check('text layer drawn (white glyph pixels near the top)', white > 300, `${white} px`)
}
const level = (name, w, h) => {
  const f = rgbFrame(o(name), w, h)
  return f.px(Math.floor(w / 2), Math.floor(h / 2))[1]
}
if (okCapture('b0.png')) check('frame-accurate trim: TL-B frame 0 shows source frame 10', near(level('b0.png', 160, 120), 30, 2), `level ${level('b0.png', 160, 120)}`)
if (okCapture('b37.png')) check('frame-accurate seek: TL-B frame 37 shows source frame 47', near(level('b37.png', 160, 120), 141, 2), `level ${level('b37.png', 160, 120)}`)
if (okCapture('c3.png')) check('nested timeline: TL-C frame 3 shows TL-B frame 8 (source 18)', near(level('c3.png', 160, 120), 54, 2), `level ${level('c3.png', 160, 120)}`)
if (okCapture('c41.png')) check('speed 0.5: TL-C frame 41 shows source frame 5', near(level('c41.png', 160, 120), 15, 2), `level ${level('c41.png', 160, 120)}`)
if (okCapture('a45-small.jpg')) {
  const s = probe(o('a45-small.jpg')).streams[0]
  check('jpeg capture honours width', s.width === 320 && s.height === 180 && s.codec_name === 'mjpeg', `${s.codec_name} ${s.width}x${s.height}`)
}
// Lottie: left half shows the animation colour, right half is transparent (black canvas).
const LOTTIE_RGB = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255] }
const colourAt = (f, x, y, want, tol = 30) => {
  const px = f.px(x, y)
  return { ok: px.every((v, i) => near(v, want[i], tol)), px: px.join(',') }
}
for (const [name, want, what] of [['d0.png', 'red', 'Lottie frame 0'], ['d15.png', 'green', 'Lottie frame 15 (mid)'], ['d29.png', 'blue', 'Lottie frame 29 (last)'], ['d35.png', 'blue', 'Lottie last frame held past op'], ['e0.png', 'green', 'dotLottie with trim 10 → frame 10'], ['e12.png', 'blue', 'dotLottie timeline 12 → frame 22']]) {
  if (!okCapture(name)) continue
  const f = rgbFrame(o(name), 200, 100)
  const l = colourAt(f, 50, 50, LOTTIE_RGB[want])
  const r = colourAt(f, 150, 50, [0, 0, 0])
  check(`${what}: ${want} left, transparent right`, l.ok && r.ok, `left ${l.px} right ${r.px}`)
}
for (const lf of report.lottieFrames ?? []) {
  check(`lottieFrames ${path.basename(lf.file)}`, lf.ok && lf.outs.length === 3, lf.error ?? lf.outs?.length)
  if (!lf.ok) continue
  for (const [out, want] of lf.outs.map((p, i) => [p, ['red', 'green', 'blue'][i]])) {
    const s = probe(out).streams[0]
    // Mac `fit(_:longestSide:)` only scales down: a 200×100 animation stays 200×100.
    const ok = s.width === 200 && s.height === 100
    check(`  ${path.basename(out)} fit-within 512 (no upscale) → 200x100`, ok, `${s.width}x${s.height}`)
    if (!ok) continue
    const f = rgbFrame(out, 200, 100)
    const l = colourAt(f, 50, 50, LOTTIE_RGB[want])
    const r = colourAt(f, 150, 50, [128, 128, 128], 4)
    check(`  ${path.basename(out)}: ${want} over #808080`, l.ok && r.ok, `left ${l.px} right ${r.px}`)
  }
}
const m = report.measure
check('measureText returns a plausible box', Array.isArray(m) && m[0].width > 0.15 && m[0].width < 0.5 && m[0].height > 0.08 && m[0].height < 0.2, JSON.stringify(m))

// ---------- 6. Verify exports ----------
const rec = (file) => report.exports.find((r) => r.job.outputPath === o(file))
const job = (file) => rec(file)?.job
const done = (file) => job(file)?.status === 'completed'
const expectStatus = { 'cancel.webm': 'cancelled', 'cancel-early.mp4': 'cancelled', 'a.fcpxml': 'completed' }
for (const r of report.exports) {
  const name = path.basename(r.job.outputPath)
  const want = expectStatus[name] ?? 'completed'
  check(`export ${name} → ${r.job.status}`, r.job.status === want, `${(r.ms / 1000).toFixed(1)} s${r.job.error ? `, ${r.job.error}` : ''}`)
  check(`  ${name}: no process left referencing the output dir`, r.lingering.length === 0, r.lingering.join(' | '))
  const ev = r.events
  const mono = ev.every((e, i) => i === 0 || (e[1] >= ev[i - 1][1] - 1e-9 && e[2] >= ev[i - 1][2]))
  const last = ev[ev.length - 1]
  check(`  ${name}: progress events queued → … → ${want}, monotonic`, ev[0][0] === 'queued' && last[0] === want && mono && (want !== 'completed' || last[1] === 1), `${ev.length} events, last ${JSON.stringify(last)}`)
}
check('fcpxml export writes an fcpxml document', /<fcpxml\b/.test(fs.existsSync(o('a.fcpxml')) ? fs.readFileSync(o('a.fcpxml'), 'utf8') : ''))
check('mp4 export staged in a hidden .partial file', rec('a.mp4')?.staging.some((n) => /^\.a-[0-9A-F-]{36}\.partial\.mp4$/.test(n)), rec('a.mp4')?.staging.join(', '))
check('video progress reports frames', rec('a.mp4')?.events.some((e) => e[0] === 'running' && e[2] > 0 && e[2] < 45))

const vstream = (p) => p.streams.find((s) => s.codec_type === 'video')
const astream = (p) => p.streams.find((s) => s.codec_type === 'audio')
const meanDiff = (a, b) => {
  let d = 0
  for (let i = 0; i < a.buf.length; i++) d += Math.abs(a.buf[i] - b.buf[i])
  return d / a.buf.length
}
const pcmRms = (file, from, to) => {
  const pcm = ff(['-i', file, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'])
  const s = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
  let acc = 0
  const a = Math.round(from * 48000)
  const b = Math.min(s.length, Math.round(to * 48000))
  for (let i = a; i < b; i++) acc += s[i] * s[i]
  return { rms: Math.sqrt(acc / Math.max(1, b - a)), samples: s.length }
}
if (done('a.mp4')) {
  const p = probe(o('a.mp4'), ['-count_frames'])
  const v = vstream(p)
  const a = astream(p)
  check('mp4 video h264 640x360 yuv420p bt709/tv', v?.codec_name === 'h264' && v.width === 640 && v.height === 360 && v.pix_fmt === 'yuv420p' && v.color_space === 'bt709' && v.color_transfer === 'bt709' && v.color_primaries === 'bt709' && v.color_range === 'tv', `${v?.codec_name} ${v?.width}x${v?.height} ${v?.pix_fmt} ${v?.color_space}/${v?.color_transfer}/${v?.color_primaries} ${v?.color_range}`)
  check('mp4 has exactly 45 frames at 30 fps', Number(v?.nb_read_frames) === 45 && v?.r_frame_rate === '30/1', `${v?.nb_read_frames} @ ${v?.r_frame_rate}`)
  check('mp4 audio aac 48 kHz stereo, 1.5 s', a?.codec_name === 'aac' && a.sample_rate === '48000' && a.channels === 2 && near(Number(a.duration), 1.5, 0.05), `${a?.codec_name} ${a?.sample_rate} ${a?.channels}ch ${a?.duration}s`)
  const mp4Bytes = fs.readFileSync(o('a.mp4'))
  check('mp4 moov atom before mdat (faststart)', mp4Bytes.indexOf('moov') >= 0 && mp4Bytes.indexOf('moov') < mp4Bytes.indexOf('mdat'))
  if (okCapture('a30.png')) check('exported mp4 frame 30 matches the frame capture', meanDiff(rgbFrame(o('a.mp4'), 640, 360, 30), rgbFrame(o('a30.png'), 640, 360)) < 3, `mean |Δ| ${meanDiff(rgbFrame(o('a.mp4'), 640, 360, 30), rgbFrame(o('a30.png'), 640, 360)).toFixed(2)}`)
  if (done('a.wav')) {
    const m = pcmRms(o('a.mp4'), 0.1, 1.4).rms
    const w = pcmRms(o('a.wav'), 0.1, 1.4).rms
    check('mp4 audio level matches the wav mix', near(m, w, w * 0.05), `rms ${m.toFixed(4)} vs ${w.toFixed(4)}`)
  }
}
if (done('a-hevc.mp4')) {
  const p = probe(o('a-hevc.mp4'), ['-count_frames'])
  const v = vstream(p)
  check('hevc mp4: hevc, hvc1 tag, 30 frames, bt709, aac', v?.codec_name === 'hevc' && v.codec_tag_string === 'hvc1' && Number(v.nb_read_frames) === 30 && v.color_space === 'bt709' && astream(p)?.codec_name === 'aac', `${v?.codec_name} ${v?.codec_tag_string} ${v?.nb_read_frames} ${v?.color_space} ${astream(p)?.codec_name}`)
  if (okCapture('a15.png')) check('hevc frame 15 matches the frame capture', meanDiff(rgbFrame(o('a-hevc.mp4'), 640, 360, 15), rgbFrame(o('a15.png'), 640, 360)) < 3, `mean |Δ| ${meanDiff(rgbFrame(o('a-hevc.mp4'), 640, 360, 15), rgbFrame(o('a15.png'), 640, 360)).toFixed(2)}`)
}
if (done('a.webm')) {
  const p = probe(o('a.webm'), ['-count_frames'])
  const v = vstream(p)
  const a = astream(p)
  check('webm: vp9 320x180 (width scaling), 45 frames, opus 48 kHz stereo', v?.codec_name === 'vp9' && v.width === 320 && v.height === 180 && Number(v.nb_read_frames) === 45 && a?.codec_name === 'opus' && a.channels === 2, `${v?.codec_name} ${v?.width}x${v?.height} ${v?.nb_read_frames} ${a?.codec_name} ${a?.channels}ch`)
  if (okCapture('a30-320.png')) check('webm frame 30 matches a 320-wide capture', meanDiff(rgbFrame(o('a.webm'), 320, 180, 30), rgbFrame(o('a30-320.png'), 320, 180)) < 4, `mean |Δ| ${meanDiff(rgbFrame(o('a.webm'), 320, 180, 30), rgbFrame(o('a30-320.png'), 320, 180)).toFixed(2)}`)
}
if (done('a.wav')) {
  const s = probe(o('a.wav')).streams[0]
  check('wav is pcm_s16le 48 kHz stereo with exactly 1.5 s', s.codec_name === 'pcm_s16le' && s.sample_rate === '48000' && s.channels === 2 && Number(s.duration_ts) === 72000, `${s.codec_name} ${s.sample_rate} ${s.channels}ch ${s.duration_ts} samples`)
  const early = pcmRms(o('a.wav'), 0, 0.5).rms
  const late = pcmRms(o('a.wav'), 1, 1.5).rms
  // Bars audio at volume 0.5 (1 kHz sine, amplitude ≈ 0.125 → rms ≈ 0.044 mono-mixed) plus the 440 Hz tone fading in from 0.5 s.
  check('audio mix is audible', early > 0.02, `rms ${early.toFixed(3)}`)
  check('tone fade-in raises the level after 0.5 s', late > early * 1.2, `rms ${early.toFixed(3)} → ${late.toFixed(3)}`)
}
if (done('a.m4a')) {
  const p = probe(o('a.m4a'))
  const a = astream(p)
  check('m4a: aac 48 kHz stereo ≈ 1.5 s, no video', a?.codec_name === 'aac' && a.sample_rate === '48000' && a.channels === 2 && near(Number(a.duration), 1.5, 0.05) && !vstream(p), `${a?.codec_name} ${a?.sample_rate} ${a?.channels}ch ${a?.duration}s`)
  if (done('a.wav')) {
    const m = pcmRms(o('a.m4a'), 0.1, 1.4).rms
    const w = pcmRms(o('a.wav'), 0.1, 1.4).rms
    check('m4a level matches the wav mix', near(m, w, w * 0.05), `rms ${m.toFixed(4)} vs ${w.toFixed(4)}`)
  }
}
if (done('b.mov')) {
  const p = probe(o('b.mov'), ['-count_frames'])
  const v = vstream(p)
  check('mov ProRes 422 (apl0) yuv422p10le 160x120, 60 frames, no audio', v?.codec_name === 'prores' && v.codec_tag_string === 'apcn' && v.pix_fmt === 'yuv422p10le' && v.width === 160 && Number(v.nb_read_frames) === 60 && !astream(p), `${v?.codec_name} ${v?.codec_tag_string} ${v?.pix_fmt} ${v?.nb_read_frames}`)
  check('mov frame 37 shows source frame 47', near(rgbFrame(o('b.mov'), 160, 120, 37).px(80, 60)[1], 141, 2), `level ${rgbFrame(o('b.mov'), 160, 120, 37).px(80, 60)[1]}`)
}
if (done('b-fps15.mp4')) {
  const v = vstream(probe(o('b-fps15.mp4'), ['-count_frames']))
  check('fps 15: 15 frames over 1 s', Number(v?.nb_read_frames) === 15 && v?.r_frame_rate === '15/1', `${v?.nb_read_frames} @ ${v?.r_frame_rate}`)
  const lv = rgbFrame(o('b-fps15.mp4'), 160, 120, 5).px(80, 60)[1]
  check('fps 15: output frame 5 shows timeline frame 10 (source 20)', near(lv, 60, 3), `level ${lv}`)
}
if (done('b-fps60.mp4')) {
  const v = vstream(probe(o('b-fps60.mp4'), ['-count_frames']))
  check('fps 60: 20 frames for 10 timeline frames', Number(v?.nb_read_frames) === 20 && v?.r_frame_rate === '60/1', `${v?.nb_read_frames} @ ${v?.r_frame_rate}`)
  const lv = rgbFrame(o('b-fps60.mp4'), 160, 120, 7).px(80, 60)[1]
  check('fps 60: output frame 7 shows timeline frame 7 (start 4 + 3, source 17)', near(lv, 51, 3), `level ${lv}`)
}
if (done('a-low.mp4') && done('a-max.mp4')) {
  const lo = fs.statSync(o('a-low.mp4')).size
  const hi = fs.statSync(o('a-max.mp4')).size
  check('quality low → smaller file than max', lo < hi * 0.6, `${lo} vs ${hi} bytes`)
  check('includeAudio:false → no audio stream', !astream(probe(o('a-low.mp4'))))
}
if (done('a-square.mp4')) {
  const v = vstream(probe(o('a-square.mp4'), ['-count_frames']))
  check('explicit width/height (333x300 → even 332x300), 10 frames', v?.width === 332 && v.height === 300 && Number(v.nb_read_frames) === 10, `${v?.width}x${v?.height} ${v?.nb_read_frames}`)
  const f = rgbFrame(o('a-square.mp4'), 332, 300, 5)
  const [r, g, b] = f.px(Math.round(332 * 0.875), Math.round(300 * 0.72))
  check('scaled export keeps the layout (red image at right)', r > 200 && g < 40 && b < 40, `${r},${g},${b}`)
}
if (done('a.gif')) {
  const p = probe(o('a.gif'), ['-count_frames'])
  const v = p.streams[0]
  check('gif 160x90 with 10 frames', v.codec_name === 'gif' && v.width === 160 && v.height === 90 && Number(v.nb_read_frames) === 10, `${v.width}x${v.height} ${v.nb_read_frames}`)
}
if (done('still.png')) {
  const v = probe(o('still.png')).streams[0]
  check('png still export 640x360', v.codec_name === 'png' && v.width === 640 && v.height === 360, `${v.codec_name} ${v.width}x${v.height}`)
  if (okCapture('a45.png')) check('png still equals the frame capture', meanDiff(rgbFrame(o('still.png'), 640, 360), rgbFrame(o('a45.png'), 640, 360)) === 0)
}
if (done('still-320.png')) {
  const v = probe(o('still-320.png')).streams[0]
  check('png still honours width', v.width === 320 && v.height === 180, `${v.width}x${v.height}`)
}
if (done('Copy.palmier')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(o('Copy.palmier'), 'media.json'), 'utf8'))
  const rel = manifest.entries.map((e) => e.source.project?.relativePath)
  check('palmier package copies media and rewrites sources', rel.every((r) => r && fs.existsSync(path.join(o('Copy.palmier'), r))), rel.join(', '))
  check('palmier package has project.json', fs.existsSync(path.join(o('Copy.palmier'), 'project.json')))
  check('palmier copies are byte-identical', fs.readFileSync(path.join(o('Copy.palmier'), rel[0])).equals(fs.readFileSync(video)))
}
if (done('d.mp4')) {
  const v = vstream(probe(o('d.mp4'), ['-count_frames']))
  check('Lottie mp4: 40 frames 200x100', Number(v?.nb_read_frames) === 40 && v.width === 200 && v.height === 100, `${v?.nb_read_frames} ${v?.width}x${v?.height}`)
  for (const [i, want] of [[0, 'red'], [9, 'red'], [10, 'green'], [19, 'green'], [20, 'blue'], [39, 'blue']]) {
    const c = colourAt(rgbFrame(o('d.mp4'), 200, 100, i), 50, 50, LOTTIE_RGB[want], 40)
    check(`Lottie mp4 frame ${i} is ${want}`, c.ok, c.px)
  }
}
if (done('dn-off.wav') && done('dn-full.wav') && done('dn-half.wav')) {
  // Hiss = energy above 3 kHz (the tone is at 300 Hz).
  const hiss = (f) => {
    const pcm = ff(['-i', o(f), '-af', 'highpass=f=3000,highpass=f=3000', '-f', 'f32le', '-ac', '1', 'pipe:1'])
    const x = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    let acc = 0
    for (let i = 4800; i < x.length - 4800; i++) acc += x[i] * x[i]
    return Math.sqrt(acc / Math.max(1, x.length - 9600))
  }
  const [off, full, half] = ['dn-off.wav', 'dn-full.wav', 'dn-half.wav'].map(hiss)
  const wetFiles = fs.readdirSync(path.join(work, 'xdg', 'cache', 'framewright', 'EnhancedAudio')).filter((n) => n.startsWith('M-NOISY_') && n.endsWith('_wet.wav'))
  check('denoise: export baked the wet file into the cache', wetFiles.length === 1, wetFiles.join(', '))
  check('denoise off: export keeps the hiss', off > 0.02, `hiss rms ${off.toFixed(4)}`)
  check('denoise amount 1: hiss strongly reduced', full < off * 0.25, `hiss rms ${off.toFixed(4)} → ${full.toFixed(4)}`)
  check('denoise amount 0.5: hiss ≈ half of the dry level (linear blend)', half > full && near(half, (off + full) / 2, off * 0.1), `hiss rms ${half.toFixed(4)}, expected ≈ ${((off + full) / 2).toFixed(4)}`)
  if (wetFiles.length === 1) {
    const ws = astream(probe(path.join(work, 'xdg', 'cache', 'framewright', 'EnhancedAudio', wetFiles[0])))
    check('denoise: wet file is 48 kHz s16 with exactly the source length (sample-aligned)', ws?.codec_name === 'pcm_s16le' && ws.sample_rate === '48000' && Number(ws.duration_ts) === 96000, `${ws?.codec_name} ${ws?.sample_rate} ${ws?.duration_ts} samples`)
  }
}
const leftovers = fs.readdirSync(outDir).filter((f) => f.startsWith('.'))
check('no staging files left behind', leftovers.length === 0, leftovers.join(', '))
check('cancelled exports left no output', !fs.existsSync(o('cancel.webm')) && !fs.existsSync(o('cancel-early.mp4')))

console.log(failures ? `\n${failures} check(s) failed — artifacts in ${work}` : '\nall smoke checks passed')
if (!failures && !args.has('--keep')) fs.rmSync(work, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
