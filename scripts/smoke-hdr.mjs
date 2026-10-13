#!/usr/bin/env node
/**
 * HEVC 10-bit HDR (HLG) export smoke check (spec 04 §11.1/§11.4): renders a timeline of SDR bands (white, 50 % grey,
 * black, red) through the real render host + export queue (out/main/smoke.cjs, headless Xvfb + SwiftShader), then
 * checks the file with ffprobe (Main 10, yuv420p10le, hvc1, BT.2020 / HLG / BT.2020nc / limited, .mov, AAC 48 kHz)
 * and that 100 % SDR white lands at ≈ 75 % HLG (10-bit narrow code ≈ 721).
 *
 * Usage: node scripts/smoke-hdr.mjs [--skip-build] [--keep]
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'palmier-smoke-hdr-'))
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
function probe(file) {
  const r = spawnSync(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_frames', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

const W = 320
const H = 180
// Four 80 px bands: white, 50 % grey, black, red.
const bands = path.join(mediaDir, 'bands.png')
ff(['-f', 'lavfi', '-i', `color=c=white:s=80x${H}`, '-f', 'lavfi', '-i', `color=c=0x808080:s=80x${H}`, '-f', 'lavfi', '-i', `color=c=black:s=80x${H}`, '-f', 'lavfi', '-i', `color=c=red:s=80x${H}`, '-filter_complex', '[0][1][2][3]hstack=inputs=4,format=rgb24', '-frames:v', '1', bands])
const tone = path.join(mediaDir, 'tone.wav')
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', tone])

const T = { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, rotationX: 0, rotationY: 0, flipHorizontal: false, flipVertical: false }
const clip = (id, mediaRef, mediaType) => ({
  id, mediaRef, mediaType, sourceClipType: mediaType, startFrame: 0, durationFrames: 30, trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1,
  fadeInFrames: 0, fadeOutFrames: 0, fadeInInterpolation: 'linear', fadeOutInterpolation: 'linear', opacity: 1, transform: T,
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, edgeRounding: 0, edgeSoftness: 0,
})
const track = (id, type, clips) => ({ id, type, muted: false, hidden: false, syncLocked: true, clips, displayHeight: 44 })
const timeline = { id: 'TL-HDR', name: 'HDR', fps: 30, width: W, height: H, settingsConfigured: true, markers: [], tracks: [track('v', 'video', [clip('c-img', 'M-BANDS', 'image')]), track('a', 'audio', [clip('c-tone', 'M-TONE', 'audio')])] }
const pkg = path.join(work, 'Hdr.palmier')
fs.mkdirSync(path.join(pkg, 'media'), { recursive: true })
fs.writeFileSync(path.join(pkg, 'project.json'), JSON.stringify({ timelines: [timeline], activeTimelineId: timeline.id, openTimelineIds: [timeline.id] }))
const entry = (id, name, type, file, duration, extra) => ({ id, name, type, source: { external: { absolutePath: file } }, duration, ...extra })
fs.writeFileSync(
  path.join(pkg, 'media.json'),
  JSON.stringify({ version: 2, folders: [], entries: [entry('M-BANDS', 'bands', 'image', bands, 5, { sourceWidth: W, sourceHeight: H, hasAudio: false }), entry('M-TONE', 'tone', 'audio', tone, 1, { hasAudio: true })] }),
)

const out = path.join(outDir, 'hdr.mov')
const tasksPath = path.join(work, 'tasks.json')
const reportPath = path.join(work, 'report.json')
fs.writeFileSync(tasksPath, JSON.stringify({ project: pkg, report: reportPath, exports: [{ timelineId: timeline.id, format: 'mov', codec: 'hevc-hdr', quality: 'high', outputPath: out }] }))

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
delete env.WAYLAND_DISPLAY // would put Electron on the real display despite Xvfb
const code = await new Promise((resolve) => {
  const child = spawn('xvfb-run', ['-a', electronBin, path.join(root, 'out/main/smoke.cjs'), '--no-sandbox', '--ozone-platform=x11', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], detached: true })
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 300_000)
  child.on('close', (c) => {
    clearTimeout(timer)
    resolve(c)
  })
})
check('electron smoke run exits 0', code === 0, `code ${code}`)
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { exports: [] }
const job = report.exports[0]?.job
check('HDR export job completes', job?.status === 'completed', job ? `${job.status}${job.error ? `: ${job.error}` : ''}` : 'no report')

if (job?.status === 'completed') {
  const info = probe(out)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  check('container is QuickTime', /mov/.test(info.format.format_name), info.format.format_name)
  check('HEVC Main 10, hvc1', v.codec_name === 'hevc' && v.profile === 'Main 10' && v.codec_tag_string === 'hvc1', `${v.codec_name} ${v.profile} ${v.codec_tag_string}`)
  check('yuv420p10le', v.pix_fmt === 'yuv420p10le', v.pix_fmt)
  check('BT.2020 / HLG / BT.2020nc / limited tags', v.color_primaries === 'bt2020' && v.color_transfer === 'arib-std-b67' && v.color_space === 'bt2020nc' && v.color_range === 'tv', `${v.color_primaries}/${v.color_transfer}/${v.color_space}/${v.color_range}`)
  check(`${W}x${H}, 30 frames`, v.width === W && v.height === H && Number(v.nb_read_frames) === 30, `${v.width}x${v.height}, ${v.nb_read_frames} frames`)
  check('AAC stereo 48 kHz audio', a?.codec_name === 'aac' && a.sample_rate === '48000' && a.channels === 2, a ? `${a.codec_name} ${a.sample_rate} ${a.channels}ch` : 'no audio')

  // Y' code values at the centre of each band, frame 15, vs the same recipe applied straight to the source PNG.
  const yPlane = (buf) => (x, y) => buf.readUInt16LE((y * W + x) * 2)
  const got = yPlane(ff(['-i', out, '-vf', 'select=eq(n\\,15)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1']))
  const HLG_VF = 'format=gbrpf32le,zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=arib-std-b67:p=bt2020:m=bt2020nc:r=limited:npl=203,format=yuv420p10le'
  const ref = yPlane(ff(['-i', bands, '-vf', HLG_VF, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p10le', 'pipe:1']))
  const at = (fn, band) => fn(band * 80 + 40, H / 2)
  check('100 % SDR white → HLG ≈ 75 % (10-bit Y ≈ 721)', Math.abs(at(got, 0) - 721) <= 8, `Y=${at(got, 0)}`)
  check('black → 10-bit Y ≈ 64', Math.abs(at(got, 2) - 64) <= 6, `Y=${at(got, 2)}`)
  for (const [i, name] of ['white', 'grey', 'black', 'red'].entries()) check(`${name} band matches the reference HLG conversion`, Math.abs(at(got, i) - at(ref, i)) <= 6, `got ${at(got, i)}, ref ${at(ref, i)}`)
}

if (!args.has('--keep')) fs.rmSync(work, { recursive: true, force: true })
else console.log(`kept ${work}`)
console.log(failures ? `${failures} check(s) FAILED` : 'all checks PASS')
process.exit(failures ? 1 : 0)
