import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchNode } from './build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBinary = createRequire(import.meta.url)('electron')

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
await server.listen()
const url = server.resolvedUrls.local[0]

let child = null
let restarting = false
function launch() {
  child = spawn(electronBinary, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PALMIER_RENDERER_URL: url },
  })
  child.on('exit', () => {
    if (!restarting) process.exit(0)
  })
}
function restart() {
  if (!child) return launch()
  restarting = true
  child.once('exit', () => {
    restarting = false
    launch()
  })
  child.kill()
}

let ready = false
await watchNode(() => ready && restart())
ready = true
launch()
