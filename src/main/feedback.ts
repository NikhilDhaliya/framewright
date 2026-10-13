/** Help ▸ Send Feedback on Linux (spec 07 §7.4): window screenshot, Save Screenshot…, system line for the issue body. */
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { osReleaseName, type FeedbackSystemInfo } from '../shared/firstRun'
import { tm } from './i18n'

const MAX_SIDE = 1920
const PNG_PREFIX = 'data:image/png;base64,'

/** PRETTY_NAME from os-release, else "Linux". */
function distroName(): string {
  for (const f of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return osReleaseName(readFileSync(f, 'utf8'))
    } catch {
      // Try the next location.
    }
  }
  return 'Linux'
}

export function systemInfo(): FeedbackSystemInfo {
  return { appVersion: app.getVersion(), distro: distroName(), kernel: os.release(), electron: process.versions.electron ?? '' }
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

export function registerFeedbackIpc(): void {
  ipcMain.handle('feedback:capture', async (e) => {
    try {
      const img = await e.sender.capturePage()
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
      const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
      return out.toDataURL()
    } catch {
      return null
    }
  })
  ipcMain.handle('feedback:saveScreenshot', async (e, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_PREFIX)) return { ok: false, error: 'No screenshot to save.' }
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title: tm('Save Screenshot'), defaultPath: path.join(app.getPath('downloads'), `Feedback screenshot ${stamp()}.png`), filters: [{ name: tm('PNG Image'), extensions: ['png'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const target = path.extname(r.filePath) ? r.filePath : `${r.filePath}.png`
    try {
      await fs.writeFile(target, Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64'))
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: `Couldn’t save the screenshot: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
  ipcMain.handle('feedback:systemInfo', () => systemInfo())
}
