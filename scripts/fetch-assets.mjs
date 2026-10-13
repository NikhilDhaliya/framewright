// Downloads the prebuilt binaries and models that ship inside the app but are not kept in git (pinned upstream
// URLs, verified by sha256). Runs on `npm install`; set FRAMEWRIGHT_SKIP_ASSETS=1 to skip.
// Usage: node scripts/fetch-assets.mjs [--ffmpeg-source [outDir]]
//   --ffmpeg-source  also writes the FFmpeg source tarball matching the bundled ffmpeg/ffprobe build to outDir
//                    (default dist/). Upload it with every release: the binaries are GPLv3.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ffmpeg comes from ffmpeg-static (npm); ffprobe is the same John Van Sickle 7.0.2 build from that release.
const FFMPEG_STATIC_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
const FFMPEG_BINARY_SHA256 = 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99'

const assets = [
  {
    file: 'resources/bin/ffprobe',
    url: `${FFMPEG_STATIC_RELEASE}/ffprobe-linux-x64.gz`,
    gzip: true,
    sha256: '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d',
    mode: 0o755,
  },
  {
    file: 'resources/bin/deep-filter',
    url: 'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl',
    sha256: '70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da',
    mode: 0o755,
  },
  {
    file: 'resources/models/DeepFilterNet3_onnx.tar.gz',
    url: 'https://github.com/Rikorose/DeepFilterNet/raw/v0.5.6/models/DeepFilterNet3_onnx.tar.gz',
    sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616',
  },
  {
    file: 'resources/models/silero_vad.onnx',
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx',
    sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
  },
]

const ffmpegSource = {
  file: 'ffmpeg-7.0.2.tar.xz',
  url: 'https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz',
  sha256: '8646515b638a3ad303e23af6a3587734447cb8fc0a0c064ecdb8e95c4fd8b389',
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function fetchAsset({ file, url, sha256: want, gzip = false, mode }, dest = path.join(root, file)) {
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === want) return
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  let buf = Buffer.from(await res.arrayBuffer())
  if (gzip) buf = zlib.gunzipSync(buf)
  const got = sha256(buf)
  if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf, { mode })
  console.log(`assets: ${path.relative(root, dest)} (${buf.length} bytes)`)
}

if (process.env.FRAMEWRIGHT_SKIP_ASSETS) process.exit(0)

for (const a of assets) await fetchAsset(a)

const sourceFlag = process.argv.indexOf('--ffmpeg-source')
if (sourceFlag !== -1) {
  // The source tarball only matches the binary it was written for; fail if ffmpeg-static was bumped.
  const bundled = sha256(fs.readFileSync(path.join(root, 'node_modules/ffmpeg-static/ffmpeg')))
  if (bundled !== FFMPEG_BINARY_SHA256) {
    throw new Error('node_modules/ffmpeg-static/ffmpeg is not the pinned 7.0.2 build; update ffprobe, the FFmpeg source and NOTICE together')
  }
  const outDir = path.resolve(process.argv[sourceFlag + 1] ?? path.join(root, 'dist'))
  await fetchAsset(ffmpegSource, path.join(outDir, ffmpegSource.file))
}
