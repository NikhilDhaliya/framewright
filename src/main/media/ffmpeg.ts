import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resourcePath } from '../ml/audio/resources'

function unpacked(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

function resolveBinary(envName: string, bundled: () => string | null, systemName: string): string {
  const fromEnv = process.env[envName]
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  try {
    const p = bundled()
    if (p) {
      const fixed = unpacked(p)
      if (existsSync(fixed)) return fixed
    }
  } catch {
    // Fall through to the system binary.
  }
  return systemName
}

export const ffmpegPath = resolveBinary('PALMIER_FFMPEG', () => require('ffmpeg-static') as string, 'ffmpeg')
/** Same FFmpeg build as ffmpeg-static, fetched into resources/bin by scripts/fetch-assets.mjs. */
export const ffprobePath = resolveBinary('PALMIER_FFPROBE', () => resourcePath('bin', 'ffprobe'), 'ffprobe')

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
  }
}

export interface RunOptions {
  signal?: AbortSignal
  input?: Buffer
}

export function run(binary: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const onAbort = () => child.kill('SIGKILL')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
      if (err.length > 64_000) err = err.slice(-32_000)
    })
    child.on('error', (e) => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (options.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new ProcessError(`${binary} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`, code, err))
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export function ffmpeg(args: string[], options?: RunOptions): Promise<Buffer> {
  return run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], options)
}

export function spawnFfmpeg(args: string[]): ChildProcess {
  return spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
}
