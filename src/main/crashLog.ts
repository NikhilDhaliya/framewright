/**
 * Local crash log (spec 01 §2.2, 07 §8.1; Mac `Utilities/Log.swift` writes ~/Library/Logs/PalmierPro/crash.log).
 * Linux: `$XDG_STATE_HOME/framewright/crash.log`. Uncaught main-process exceptions, unhandled rejections and
 * renderer/child-process crashes are appended as text; native crashes leave minidumps from a local-only
 * `crashReporter` in `<state>/Crashpad`. Nothing is uploaded.
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, crashReporter } from 'electron'
import { APP_NAME } from '../shared/brand'

/** The log is trimmed to its newest half once it grows past this size. */
export const CRASH_LOG_MAX_BYTES = 1024 * 1024

export interface CrashLogOptions {
  dir: string
  appVersion?: string
  now?: () => Date
}

const describe = (e: unknown): string => {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export class CrashLog {
  readonly file: string
  constructor(private readonly opts: CrashLogOptions) {
    this.file = path.join(opts.dir, 'crash.log')
  }

  /** Formats one entry: `[ISO time] <kind> (Framewright <version>, pid <pid>)` followed by the detail. */
  format(kind: string, detail: unknown): string {
    const time = (this.opts.now?.() ?? new Date()).toISOString()
    const version = this.opts.appVersion ? ` ${this.opts.appVersion}` : ''
    return `[${time}] ${kind} (${APP_NAME}${version}, pid ${process.pid})\n${describe(detail).trimEnd()}\n\n`
  }

  /** Synchronous append so the entry survives an immediate exit; never throws. */
  write(kind: string, detail: unknown): void {
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true })
      this.trim()
      fs.appendFileSync(this.file, this.format(kind, detail), { mode: 0o600 })
    } catch {
      // A crash logger must not crash.
    }
  }

  private trim(): void {
    let size = 0
    try {
      size = fs.statSync(this.file).size
    } catch {
      return
    }
    if (size <= CRASH_LOG_MAX_BYTES) return
    const text = fs.readFileSync(this.file, 'utf8')
    let keep = text.slice(text.length - CRASH_LOG_MAX_BYTES / 2)
    const entry = keep.indexOf('\n[')
    if (entry >= 0) keep = keep.slice(entry + 1)
    fs.writeFileSync(this.file, keep, { mode: 0o600 })
  }
}

/**
 * Installs the handlers. Call before `app.whenReady()` so `crashReporter` covers every process.
 * Uncaught exceptions are logged and the app keeps running (Electron's default would show a modal error box).
 */
export function installCrashLog(dir: string): CrashLog {
  const log = new CrashLog({ dir, appVersion: app.getVersion() })
  try {
    app.setPath('crashDumps', path.join(dir, 'Crashpad'))
    crashReporter.start({ uploadToServer: false, submitURL: '', compress: false })
  } catch (e) {
    console.error(`[crash] crashReporter unavailable: ${describe(e)}`)
  }
  process.on('uncaughtException', (e) => {
    console.error('[crash] uncaught exception', e)
    log.write('Uncaught exception', e)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[crash] unhandled rejection', reason)
    log.write('Unhandled promise rejection', reason)
  })
  app.on('render-process-gone', (_e, wc, details) => {
    if (details.reason === 'clean-exit') return
    log.write('Renderer process gone', `reason: ${details.reason}, exitCode: ${details.exitCode}, url: ${wc.getURL()}`)
  })
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    log.write('Child process gone', `type: ${details.type}${details.name ? ` (${details.name})` : ''}, reason: ${details.reason}, exitCode: ${details.exitCode}`)
  })
  return log
}
