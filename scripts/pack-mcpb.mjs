// Zips resources/mcpb/ into dist/framewright-<version>.mcpb, the Claude Desktop extension bundle
// (manifest.json at the archive root, like the Mac's palmier-pro.mcpb). Usage: node scripts/pack-mcpb.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'resources/mcpb')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'dist'))
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'))

const files = {}
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile() && !e.name.startsWith('.')) files[path.relative(src, p).split(path.sep).join('/')] = [fs.readFileSync(p), { mtime: new Date('2026-01-01T00:00:00Z') }]
  }
}
walk(src)
for (const required of ['manifest.json', manifest.icon, manifest.server.entry_point]) {
  if (!files[required]) throw new Error(`mcpb: missing ${required}`)
}
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, `${manifest.name}-${manifest.version}.mcpb`)
fs.writeFileSync(out, zipSync(files, { level: 9 }))
console.log(`mcpb: wrote ${path.relative(root, out)} (${Object.keys(files).length} files, ${fs.statSync(out).size} bytes)`)
