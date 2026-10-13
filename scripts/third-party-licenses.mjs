// Writes THIRD_PARTY_LICENSES.txt: the license of every third-party component in the packaged app.
// npm packages = the production dependency tree (packed by electron-builder) plus the packages imported from src/
// (bundled into out/ by esbuild/vite), each with its own license files. Other components and their texts are below
// and in licenses/. Usage: node scripts/third-party-licenses.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const rule = '='.repeat(100)
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').trimEnd()

// --- npm packages

/** Node resolution: <from>/node_modules/<name>, then each parent directory. */
function resolvePackage(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    if (dir === root || dir === path.dirname(dir)) return null
  }
}

const found = new Map() // package dir → package.json
function addTree(name, from) {
  const dir = resolvePackage(name, from)
  if (!dir || found.has(dir)) return
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  found.set(dir, json)
  for (const dep of Object.keys({ ...json.dependencies, ...json.optionalDependencies })) addTree(dep, dir)
}

for (const dep of Object.keys(pkg.dependencies ?? {})) addTree(dep, root)

const importRe = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
const walkSrc = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walkSrc(p) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : []
  })
for (const file of walkSrc(path.join(root, 'src'))) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(importRe)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (name === 'electron') continue // the npm package is only a downloader; Electron itself is listed below
    addTree(name, root) // path aliases (@core/…) don't resolve and are skipped
  }
}

const licenseName = (json) => {
  if (typeof json.license === 'string') return json.license
  if (json.license?.type) return json.license.type
  if (Array.isArray(json.licenses)) return json.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}
const repoUrl = (json) => {
  const r = typeof json.repository === 'string' ? json.repository : json.repository?.url
  return (r ?? json.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
}
const licenseFiles = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice|thirdpartynotices)/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()

// Packages whose npm tarball has no license file: texts from the upstream repository at the same version.
const upstreamTexts = {
  'onnxruntime-common': ['onnxruntime-LICENSE.txt'],
  'onnxruntime-node': ['onnxruntime-LICENSE.txt', 'onnxruntime-ThirdPartyNotices.txt'],
  'sherpa-onnx-node': ['sherpa-onnx-LICENSE.txt'],
  // Also bundles libonnxruntime.so.
  'sherpa-onnx-linux-x64': ['sherpa-onnx-LICENSE.txt', 'onnxruntime-LICENSE.txt', 'onnxruntime-ThirdPartyNotices.txt'],
}

/** The "License" section of the README, for older packages that put the text there instead of a file. */
function readmeLicense(dir) {
  const readme = fs.readdirSync(dir).find((f) => /^readme(\.md)?$/i.test(f))
  if (!readme) return null
  const m = fs.readFileSync(path.join(dir, readme), 'utf8').match(/^#*\s*Licen[cs]e\s*\n(?:-+\n)?([\s\S]*?)(?=^#+ |^\S[^\n]*\n-{3,}\n|$(?![\s\S]))/im)
  return m && m[1].trim().length > 200 ? m[1].trim() : null
}

function licenseText(dir, json) {
  const files = licenseFiles(dir)
  if (files.length) return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trimEnd()).join('\n\n')
  if (upstreamTexts[json.name]) return upstreamTexts[json.name].map((f) => read('licenses', f)).join('\n\n')
  return readmeLicense(dir) ?? `(This package ships no license file. License: ${licenseName(json)}.)`
}

const packages = [...found.entries()]
  .map(([dir, json]) => ({ dir, json }))
  .filter(({ json }) => json.name !== pkg.name)
  .sort((a, b) => a.json.name.localeCompare(b.json.name) || a.json.version.localeCompare(b.json.version))

const seen = new Set()
const npmSections = []
for (const { dir, json } of packages) {
  const id = `${json.name}@${json.version}`
  if (seen.has(id)) continue
  seen.add(id)
  npmSections.push([rule, `${id}  (${licenseName(json)})`, repoUrl(json), rule, '', licenseText(dir, json), ''].join('\n'))
}

// --- other bundled components (versions and sources are pinned in scripts/fetch-assets.mjs)

const ffmpegBuild = read('licenses', 'FFmpeg-build-README.txt')
const bundled = [
  {
    title: 'FFmpeg 7.0.2 (ffmpeg and ffprobe, static build)  (GPL-3.0-or-later)',
    about: [
      'Static Linux build by John Van Sickle (https://johnvansickle.com/ffmpeg/), distributed through',
      'ffmpeg-static (https://github.com/eugeneware/ffmpeg-static, release b6.1.1).',
      'Corresponding source: ffmpeg-7.0.2.tar.xz is attached to every Framewright release, and is also at',
      'https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz. The libraries linked into the build and their versions',
      'are listed in the build README below. The license is the GNU GPL version 3, the same text as LICENSE.',
    ],
    text: ffmpegBuild,
  },
  {
    title: 'DeepFilterNet 0.5.6: deep-filter CLI and DeepFilterNet3 model  (MIT OR Apache-2.0)',
    about: ['https://github.com/Rikorose/DeepFilterNet'],
    text: [read('licenses', 'DeepFilterNet-LICENSE-MIT.txt'), read('licenses', 'DeepFilterNet-LICENSE-APACHE.txt')].join('\n\n'),
  },
  {
    title: 'Silero VAD 5.1.2 model  (MIT)',
    about: ['https://github.com/snakers4/silero-vad'],
    text: read('licenses', 'silero-vad-LICENSE.txt'),
  },
  {
    title: 'Beat This! small0 model, converted to ONNX (models/beat_this/export_onnx.py)  (MIT)',
    about: ['https://github.com/CPJKU/beat_this'],
    text: read('licenses', 'beat_this-LICENSE.txt'),
  },
  {
    title: 'Electron and Chromium',
    about: ['https://github.com/electron/electron. Their license texts ship next to the executable:', 'LICENSE.electron.txt and LICENSES.chromium.html.'],
    text: '',
  },
]

const fontDirs = fs.readdirSync(path.join(root, 'resources/fonts')).sort()
for (const font of fontDirs) {
  const dir = path.join(root, 'resources/fonts', font)
  const files = licenseFiles(dir).concat(fs.readdirSync(dir).filter((f) => f === 'OFL.txt'))
  const unique = [...new Set(files)]
  if (!unique.length) throw new Error(`resources/fonts/${font}: no license file`)
  bundled.push({
    title: `Font: ${font}  (SIL Open Font License 1.1)`,
    about: font === 'Inter' || font === 'GeistMono' ? ['Also used by the user interface (src/renderer/assets/fonts).'] : [],
    text: unique.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trimEnd()).join('\n\n'),
  })
}

const bundledSections = bundled.map(({ title, about, text }) => [rule, title, ...about, rule, '', text, ''].join('\n'))

// --- downloaded on first use (not shipped in the app; listed for reference)

const downloaded = [
  'whisper.cpp b5454 whisper-cli (MIT): https://github.com/ggml-org/whisper.cpp',
  'Whisper ggml models (MIT): https://huggingface.co/ggerganov/whisper.cpp',
  'SigLIP 2 base-patch16-256 ONNX (Apache-2.0): https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX',
  'WeSpeaker ResNet34-LM, VoxCeleb (CC-BY-4.0, by the WeSpeaker team): https://github.com/wenet-e2e/wespeaker',
  'pyannote segmentation-3.0 ONNX (MIT): https://github.com/pyannote/pyannote-audio',
]

const out = [
  `Third-party software in ${pkg.productName} ${pkg.version}`,
  '',
  `${pkg.productName} is licensed under the GNU General Public License version 3 (see LICENSE and NOTICE).`,
  'It includes the components below, each under its own license.',
  '',
  'Downloaded on first use (not included in the app, fetched from the upstream project):',
  ...downloaded.map((d) => `  - ${d}`),
  '',
  ...bundledSections,
  ...npmSections,
].join('\n')

fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), out.trimEnd() + '\n')
console.log(`licenses: wrote THIRD_PARTY_LICENSES.txt (${seen.size} npm packages, ${bundled.length} other components)`)
