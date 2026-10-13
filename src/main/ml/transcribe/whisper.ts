/** whisper.cpp `whisper-cli` runner (spec 07 §1.5): one child per file, progress from stderr, JSON-full output. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TranscriptionError, type TranscriptionResult } from '../../../core/captions/transcript'
import { fromWhisper, parseWhisperProgress } from './whisperParse'

export interface WhisperRun {
  binary: string
  model: string
  wav: string
  /** whisper code (`en`, `de`, …) or `auto`. */
  language: string
  /** BCP-47 tag reported as `language` (the user's choice); undefined = whisper's detected code. */
  reportLanguage?: string
  threads?: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export const whisperThreads = (): number => Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 2))

/** `whisper-cli` inside an installed `whisper-cli` model dir (the release tarball nests it one level down). */
export function findWhisperCli(installDir: string): string | null {
  const env = process.env.PALMIER_WHISPER_CLI
  if (env && existsSync(env)) return env
  const direct = path.join(installDir, 'whisper-bin-ubuntu-x64', 'whisper-cli')
  if (existsSync(direct)) return direct
  const walk = (dir: string, depth: number): string | null => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (name === 'whisper-cli' && statSync(p).isFile()) return p
      if (depth > 0 && statSync(p).isDirectory()) {
        const found = walk(p, depth - 1)
        if (found) return found
      }
    }
    return null
  }
  return existsSync(installDir) ? walk(installDir, 2) : null
}

/** Runs one transcription. SIGTERM then SIGKILL after 2 s on abort; temp JSON removed in all cases. */
export async function runWhisper(r: WhisperRun): Promise<TranscriptionResult> {
  if (r.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const base = path.join(os.tmpdir(), `framewright-whisper-${randomUUID()}`)
  const args = ['-m', r.model, '-f', r.wav, '-l', r.language, '-t', String(r.threads ?? whisperThreads()), '-bs', '5', '-bo', '5', '-ojf', '-of', base, '-pp', '-np']
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(r.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LD_LIBRARY_PATH: [path.dirname(r.binary), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } })
      let tail = ''
      let killTimer: NodeJS.Timeout | null = null
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      // Reject at once: the child may still hold its pipes open while it dies.
      const onAbort = () => {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
        settle(() => reject(new DOMException('Aborted', 'AbortError')))
      }
      r.signal?.addEventListener('abort', onAbort, { once: true })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-8000)
        for (const line of chunk.split(/\r?\n|\r/)) {
          const p = parseWhisperProgress(line)
          if (p !== null) r.onProgress?.(p)
        }
      })
      child.on('error', (e) => {
        r.signal?.removeEventListener('abort', onAbort)
        settle(() => reject(new TranscriptionError('analysisFailed', e.message)))
      })
      child.on('exit', () => {
        if (killTimer) clearTimeout(killTimer)
      })
      child.on('close', (code, sig) => {
        r.signal?.removeEventListener('abort', onAbort)
        if (r.signal?.aborted) return settle(() => reject(new DOMException('Aborted', 'AbortError')))
        if (code === 0) return settle(resolve)
        const last = tail.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && parseWhisperProgress(l) === null).pop()
        settle(() => reject(new TranscriptionError('analysisFailed', last ?? `whisper-cli exited with ${code ?? sig}`)))
      })
    })
    let json: unknown
    try {
      json = JSON.parse(await fs.readFile(`${base}.json`, 'utf8'))
    } catch {
      throw new TranscriptionError('decodeFailed')
    }
    return fromWhisper(json, r.reportLanguage)
  } finally {
    await fs.rm(`${base}.json`, { force: true })
  }
}
