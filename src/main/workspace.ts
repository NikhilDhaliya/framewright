import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, dialog, nativeTheme, type WebContents } from 'electron'
import { emptyManifest, newProjectFile, PROJECT } from '../core/model'
import type { AppSettings, ProjectState, UiCommand } from '../shared/api'
import { APP_NAME, APP_SLUG } from '../shared/brand'
import { exists, normalizePackagePath } from './project/packageIO'
import { ProjectSession } from './project/session'
import { generateProjectThumbnail } from './project/thumbnail'
import type { SessionRegistry } from './services'
import { tm } from './i18n'

const IPC_STATE = 'project:state'
const IPC_COMMAND = 'app:command'
const HOME_MIN = { width: 760, height: 480 }
const EDITOR_MIN = { width: 1032, height: 600 }

interface Slot {
  win: BrowserWindow
  session: ProjectSession | null
  detach: (() => void) | null
}

export interface WorkspaceOptions {
  preload: string
  icon: string
  load(win: BrowserWindow): Promise<void>
  settings(): AppSettings
}

export class ProjectNameError extends Error {}

/** Validates a project name the way the Mac does (no separators, not . or ..). */
export function validateProjectName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new ProjectNameError('Enter a project name.')
  if (/[/\\]/.test(name) || name === '.' || name === '..') throw new ProjectNameError('Project names can’t contain “/” or “\\”.')
  return name
}

/** Editor windows and the project each one shows. Home and editor share a window; a second project opens a new window. */
export class Workspace extends EventEmitter implements SessionRegistry {
  private readonly slots = new Set<Slot>()
  private lastFocused: Slot | null = null
  private quitting = false

  constructor(private readonly opts: WorkspaceOptions) {
    super()
  }

  windows(): BrowserWindow[] {
    return [...this.slots].map((s) => s.win)
  }

  focused(): ProjectSession | null {
    const win = BrowserWindow.getFocusedWindow()
    const current = win ? this.slotForWindow(win) : null
    if (current?.session) return current.session
    if (this.lastFocused?.session && this.slots.has(this.lastFocused)) return this.lastFocused.session
    return [...this.slots].find((s) => s.session)?.session ?? null
  }

  all(): ProjectSession[] {
    return [...this.slots].flatMap((s) => (s.session ? [s.session] : []))
  }

  sessionFor(sender: WebContents): ProjectSession | null {
    return this.slotForContents(sender)?.session ?? null
  }

  windowFor(session: ProjectSession): BrowserWindow | null {
    return [...this.slots].find((s) => s.session === session)?.win ?? null
  }

  send(session: ProjectSession, cmd: UiCommand): void {
    const win = this.windowFor(session)
    if (win && !win.isDestroyed()) win.webContents.send(IPC_COMMAND, cmd)
  }

  sendToFocused(cmd: UiCommand): void {
    const win = BrowserWindow.getFocusedWindow() ?? this.lastFocused?.win
    if (win && !win.isDestroyed()) win.webContents.send(IPC_COMMAND, cmd)
  }

  broadcast(channel: string, payload: unknown): void {
    for (const s of this.slots) if (!s.win.isDestroyed()) s.win.webContents.send(channel, payload)
  }

  stateFor(sender: WebContents): ProjectState | null {
    return this.sessionFor(sender)?.snapshot() ?? null
  }

  async openWindow(session: ProjectSession | null = null): Promise<BrowserWindow> {
    const theme = titleBarColors(this.opts.settings().theme)
    const min = session ? EDITOR_MIN : HOME_MIN
    const win = new BrowserWindow({
      width: session ? 1600 : 1200,
      height: session ? 1000 : 800,
      minWidth: min.width,
      minHeight: min.height,
      show: false,
      title: session?.name ?? APP_NAME,
      icon: this.opts.icon,
      backgroundColor: theme.color,
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...theme, height: 28 },
      webPreferences: { preload: this.opts.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    })
    const slot: Slot = { win, session: null, detach: null }
    this.slots.add(slot)
    win.on('focus', () => {
      this.lastFocused = slot
      this.emit('focus-change')
    })
    win.on('close', (e) => this.onWindowClose(slot, e))
    win.on('closed', () => {
      slot.detach?.()
      this.slots.delete(slot)
      if (this.lastFocused === slot) this.lastFocused = null
      this.emit('focus-change')
    })
    win.once('ready-to-show', () => {
      if (session) win.maximize()
      win.show()
    })
    if (session) this.bind(slot, session)
    await this.opts.load(win)
    return win
  }

  /** Opens `p` in `from` when that window shows Home, else focuses an existing window or opens a new one. */
  async openPath(p: string, from?: WebContents): Promise<ProjectSession> {
    const dir = normalizePackagePath(p)
    const open = [...this.slots].find((s) => s.session && path.resolve(s.session.path) === dir)
    if (open?.session) {
      focusWindow(open.win)
      return open.session
    }
    if (!(await exists(path.join(dir, PROJECT.timelineFilename)))) throw new Error(`“${path.basename(dir)}” isn’t a ${APP_NAME} project.`)
    const session = await ProjectSession.open(dir)
    await this.present(session, from)
    return session
  }

  async create(rawName: string, from?: WebContents): Promise<ProjectSession> {
    const name = validateProjectName(rawName)
    const root = this.opts.settings().projectsDirectory
    const dir = path.join(root, `${name}.${PROJECT.fileExtension}`)
    if (await exists(dir)) throw new ProjectNameError(`A project named “${name}” already exists.`)
    await fs.mkdir(root, { recursive: true })
    const session = await ProjectSession.create(dir, { file: newProjectFile(), manifest: emptyManifest() })
    await this.present(session, from)
    return session
  }

  /** Onboarding ▸ Tutorial without a bundled sample: a fresh untitled project in the temp dir, not registered (07 §7.2). */
  async openTutorial(from?: WebContents): Promise<ProjectSession> {
    const dir = path.join(os.tmpdir(), `${APP_SLUG}-tutorial`, `Tutorial.${PROJECT.fileExtension}`)
    const open = [...this.slots].find((s) => s.session && path.resolve(s.session.path) === dir)
    if (open?.session) {
      focusWindow(open.win)
      return open.session
    }
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(dir), { recursive: true })
    const session = await ProjectSession.create(dir, { file: newProjectFile(), manifest: emptyManifest() }, false)
    await this.present(session, from)
    return session
  }

  private async present(session: ProjectSession, from?: WebContents): Promise<void> {
    const target = from ? this.slotForContents(from) : [...this.slots].find((s) => !s.session) ?? null
    if (target && !target.session) {
      this.bind(target, session)
      target.win.setMinimumSize(EDITOR_MIN.width, EDITOR_MIN.height)
      if (!target.win.isMaximized()) target.win.maximize()
      focusWindow(target.win)
      return
    }
    await this.openWindow(session)
  }

  private bind(slot: Slot, session: ProjectSession): void {
    slot.detach?.()
    slot.session = session
    let pending = false
    const push = () => {
      if (pending) return
      pending = true
      setImmediate(() => {
        pending = false
        if (!slot.win.isDestroyed() && slot.session === session && !session.closed) slot.win.webContents.send(IPC_STATE, session.snapshot())
      })
    }
    const onError = (e: unknown) => this.send(session, { type: 'toast', kind: 'error', message: tm('Couldn’t save: {0}', e instanceof Error ? e.message : String(e)) })
    const thumbnailer = new ThumbnailScheduler(session)
    const onChange = () => {
      push()
      thumbnailer.poke()
      slot.win.setTitle(session.name)
    }
    session.on('change', onChange)
    session.on('error', onError)
    slot.detach = () => {
      session.off('change', onChange)
      session.off('error', onError)
      thumbnailer.dispose()
      slot.detach = null
    }
    slot.win.setTitle(session.name)
    thumbnailer.poke()
    push()
    this.emit('focus-change')
  }

  /** Saves and closes the window's project; the window returns to Home (or closes when others remain). */
  async closeProject(sender: WebContents): Promise<void> {
    const slot = this.slotForContents(sender)
    if (!slot?.session) return
    const session = slot.session
    await session.close()
    slot.detach?.()
    slot.session = null
    if (this.slots.size > 1) {
      slot.win.destroy()
      return
    }
    slot.win.setTitle(APP_NAME)
    slot.win.setMinimumSize(HOME_MIN.width, HOME_MIN.height)
    slot.win.webContents.send(IPC_STATE, null)
    this.emit('focus-change')
  }

  private onWindowClose(slot: Slot, e: Electron.Event): void {
    if (this.quitting || !slot.session) return
    e.preventDefault()
    const session = slot.session
    session
      .close()
      .then(() => {
        slot.detach?.()
        slot.session = null
        slot.win.destroy()
      })
      .catch((err) => {
        void dialog.showMessageBox(slot.win, { type: 'error', message: tm('Couldn’t save “{0}”.', session.name), detail: err instanceof Error ? err.message : String(err) })
      })
  }

  /** Saves every open project; false when any save failed (quit is cancelled). */
  async closeAll(): Promise<boolean> {
    const results = await Promise.allSettled(this.all().map((s) => s.close()))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      await dialog.showMessageBox({ type: 'error', message: tm('Couldn’t save every project, so {app} didn’t quit.'), detail: String(failed.reason?.message ?? failed.reason) })
      return false
    }
    this.quitting = true
    for (const s of this.slots) s.detach?.()
    return true
  }

  applyTheme(theme: AppSettings['theme']): void {
    nativeTheme.themeSource = theme
    const colors = titleBarColors(theme)
    for (const s of this.slots) {
      if (s.win.isDestroyed()) continue
      s.win.setBackgroundColor(colors.color)
      s.win.setTitleBarOverlay({ ...colors, height: 28 })
    }
  }

  private slotForWindow(win: BrowserWindow): Slot | null {
    for (const s of this.slots) if (s.win === win) return s
    return null
  }

  private slotForContents(wc: WebContents): Slot | null {
    for (const s of this.slots) if (!s.win.isDestroyed() && s.win.webContents === wc) return s
    return null
  }
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function titleBarColors(theme: AppSettings['theme']): { color: string; symbolColor: string } {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? { color: '#18191C', symbolColor: '#DADADB' } : { color: '#F1F0ED', symbolColor: '#353534' }
}

const THUMBNAIL_RETRY_MS = 5000

/** Generates the Home-screen poster once per session, retrying after edits until a candidate clip exists. */
class ThumbnailScheduler {
  private done = false
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private readonly session: ProjectSession) {}

  poke(): void {
    if (this.done || this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.running = true
      generateProjectThumbnail(this.session)
        .then((jpeg) => {
          if (!jpeg || this.session.closed) return
          this.session.setThumbnail(jpeg)
          this.done = true
          if (!this.session.isDirty) return this.session.save()
        })
        .catch(() => undefined)
        .finally(() => {
          this.running = false
        })
    }, THUMBNAIL_RETRY_MS)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.done = true
  }
}
