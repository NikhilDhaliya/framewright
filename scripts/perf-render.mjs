// Real-app render performance on a 1080p30 single-video-track timeline (12 s testsrc2 + tone), headless via
// scripts/headless/launch.sh (private Xvfb, temp XDG dirs). Build first (npm run build).
//   node scripts/perf-render.mjs export [frames=300] [cdpPort=9451]   → H.264 export fps through window.palmier.export
//   node scripts/perf-render.mjs playback [seconds=10] [cdpPort=9452] → preview presents/s and new video frames/s
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ffmpegBin = createRequire(import.meta.url)('ffmpeg-static')
const [mode = 'export', amountArg, portArg] = process.argv.slice(2)
if (mode !== 'export' && mode !== 'playback') throw new Error('mode must be export or playback')
const amount = Number(amountArg ?? (mode === 'export' ? 300 : 10))
const port = String(portArg ?? (mode === 'export' ? 9451 : 9452))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'palmier-perf-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const media = path.join(work, 'src1080.mp4')
spawnSync(ffmpegBin, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-shortest', media], { stdio: 'inherit' })
const pkg = path.join(work, 'Perf.palmier')
fs.mkdirSync(path.join(pkg, 'media'), { recursive: true })
const T = { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, rotationX: 0, rotationY: 0, flipHorizontal: false, flipVertical: false }
const clip = (id, mediaType) => ({ id, mediaRef: 'M-VID', mediaType, sourceClipType: 'video', startFrame: 0, durationFrames: 360, trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1, fadeInFrames: 0, fadeOutFrames: 0, fadeInInterpolation: 'linear', fadeOutInterpolation: 'linear', opacity: 1, transform: T, crop: { left: 0, top: 0, right: 0, bottom: 0 }, edgeRounding: 0, edgeSoftness: 0 })
const track = (id, type, clips) => ({ id, type, muted: false, hidden: false, syncLocked: true, clips, displayHeight: 44 })
const tl = { id: 'TL', name: 'Main', fps: 30, width: 1920, height: 1080, settingsConfigured: true, markers: [], tracks: [track('v1', 'video', [clip('c-v', 'video')]), track('a1', 'audio', [clip('c-a', 'audio')])] }
fs.writeFileSync(path.join(pkg, 'project.json'), JSON.stringify({ timelines: [tl], activeTimelineId: 'TL', openTimelineIds: ['TL'] }))
fs.writeFileSync(path.join(pkg, 'media.json'), JSON.stringify({ version: 2, folders: [], entries: [{ id: 'M-VID', name: 'src', type: 'video', source: { external: { absolutePath: media } }, duration: 12, sourceWidth: 1920, sourceHeight: 1080, hasAudio: true }] }))

async function cdp(method, params) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  if (!target) throw new Error('editor page not found')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)))
  const result = await new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id === 1) resolve(d.result)
    }
    ws.send(JSON.stringify({ id: 1, method, params }))
  })
  ws.close()
  return result
}
const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value

async function measureExport() {
  const out = path.join(work, 'out.mp4')
  const r = await evaluate(`(async () => {
    const t0 = performance.now()
    const { job, error } = await window.palmier.export.start({ timelineId: 'TL', format: 'mp4', outputPath: ${JSON.stringify(out)}, range: { start: 0, end: ${amount} } })
    if (!job) return { status: 'failed', error }
    for (;;) {
      await new Promise((r) => setTimeout(r, 100))
      const j = (await window.palmier.export.list()).find((x) => x.id === job.id)
      if (['completed', 'failed', 'cancelled'].includes(j.status)) return { status: j.status, error: j.error, ms: performance.now() - t0 }
    }
  })()`)
  if (r?.status !== 'completed') throw new Error(`export ${r?.status}: ${r?.error}`)
  console.log(`export: ${amount} frames 1080p30 H.264 in ${(r.ms / 1000).toFixed(1)} s → ${(amount / (r.ms / 1000)).toFixed(1)} fps (${fs.statSync(out).size} bytes)`)
}

// Counts draws into the engine canvas (presents) and full-size luma uploads (new decoded video frames).
const COUNTERS = `(() => {
  const P = WebGL2RenderingContext.prototype
  const st = (window.__perf = { presents: 0, frames: 0, t0: 0, toScreen: true })
  const engine = (gl) => gl.canvas.classList && gl.canvas.classList.contains('pp-engine-canvas')
  const bind = P.bindFramebuffer
  P.bindFramebuffer = function (t, fb) { st.toScreen = fb === null; return bind.call(this, t, fb) }
  const draw = P.drawArrays
  P.drawArrays = function (...a) { if (st.toScreen && engine(this)) st.presents++; return draw.apply(this, a) }
  const isFrame = (gl, a) => engine(gl) && ((a.length >= 9 && a[6] === gl.RED && a[4] >= 1280) || a[a.length - 1] instanceof HTMLVideoElement)
  const sub = P.texSubImage2D
  P.texSubImage2D = function (...a) { if (isFrame(this, a)) st.frames++; return sub.apply(this, a) }
})()`
async function measurePlayback() {
  await evaluate(COUNTERS)
  const space = (type) => cdp('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ' } : {}) })
  await space('keyDown')
  await space('keyUp')
  await wait(1500)
  await evaluate(`(() => { const s = window.__perf; s.presents = 0; s.frames = 0; s.t0 = performance.now() })()`)
  await wait(amount * 1000)
  const r = await evaluate(`(() => { const s = window.__perf; return { dt: (performance.now() - s.t0) / 1000, presents: s.presents, frames: s.frames } })()`)
  await space('keyDown')
  await space('keyUp')
  console.log(`playback: ${(r.presents / r.dt).toFixed(1)} presents/s, ${(r.frames / r.dt).toFixed(1)} new video frames/s over ${r.dt.toFixed(1)} s`)
}

const app = spawn(path.join(root, 'scripts/headless/launch.sh'), ['perf', port, pkg], { env: { ...process.env, PALMIER_HEADLESS_DIR: work }, stdio: 'ignore', detached: true })
app.unref()
try {
  for (let i = 0; ; i++) {
    try {
      if ((await evaluate(`!!(window.palmier && document.querySelector('canvas.pp-engine-canvas'))`)) === true) break
    } catch {}
    if (i > 120) throw new Error(`the app did not start (log: ${path.join(work, 'perf/app.log')})`)
    await wait(500)
  }
  await wait(3000)
  await (mode === 'export' ? measureExport() : measurePlayback())
} finally {
  execFileSync(path.join(root, 'scripts/headless/stop.sh'), [port])
  await wait(1000)
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 })
}
