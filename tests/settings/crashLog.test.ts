import { TEST_ROOT } from './env'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CRASH_LOG_MAX_BYTES, CrashLog } from '../../src/main/crashLog'
import { appDirs } from '../../src/main/paths'

describe('crash log', () => {
  it('lives in $XDG_STATE_HOME/framewright', () => {
    expect(appDirs.state).toBe(path.join(TEST_ROOT, 'xdg_state_home', 'framewright'))
  })

  it('appends timestamped entries with the stack', () => {
    const dir = path.join(TEST_ROOT, 'crash1')
    const log = new CrashLog({ dir, appVersion: '0.7.6', now: () => new Date('2026-10-14T10:00:00Z') })
    log.write('Uncaught exception', new Error('boom'))
    log.write('Unhandled promise rejection', 'plain reason')
    const text = fs.readFileSync(path.join(dir, 'crash.log'), 'utf8')
    expect(text).toContain(`[2026-10-14T10:00:00.000Z] Uncaught exception (Framewright 0.7.6, pid ${process.pid})\nError: boom\n    at `)
    expect(text).toContain('Unhandled promise rejection (Framewright 0.7.6')
    expect(text.endsWith('plain reason\n\n')).toBe(true)
  })

  it('trims to the newest entries once past the size cap', () => {
    const dir = path.join(TEST_ROOT, 'crash2')
    const log = new CrashLog({ dir })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(log.file, log.format('Old', 'x'.repeat(CRASH_LOG_MAX_BYTES)))
    log.write('New', 'latest')
    const text = fs.readFileSync(log.file, 'utf8')
    expect(text.length).toBeLessThan(CRASH_LOG_MAX_BYTES)
    expect(text).toContain('] New (Framewright')
    expect(text.startsWith('[') || text.startsWith('x')).toBe(true)
  })

  it('never throws when the folder cannot be created', () => {
    const file = path.join(TEST_ROOT, 'not-a-dir')
    fs.writeFileSync(file, '')
    expect(() => new CrashLog({ dir: path.join(file, 'sub') }).write('X', 'y')).not.toThrow()
  })
})
