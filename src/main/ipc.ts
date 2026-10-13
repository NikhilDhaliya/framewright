import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import { clipTypeForExtension, PROJECT } from '../core/model'
import { OPS, projectOps, type OpName } from '../core/ops'
import type { AppSettings, ExportFormat, ExportOptions, NativeEditAction, UiState } from '../shared/api'
import { registerFeedbackIpc } from './feedback'
import { ffmpegPath } from './media/ffmpeg'
import { readClipboardMedia } from './media/clipboard'
import { extensionType, fileIndex, matchOffline, offlineReport, relinkPatch, relinkTypeMismatch } from './media/relink'
import { exists, sourceForPath } from './project/packageIO'
import { listRecentProjects, removeProject } from './project/registry'
import type { ProjectSession } from './project/session'
import type { ExportService, MediaService } from './services'
import type { SettingsStore } from './settings'
import type { Workspace } from './workspace'
import { tm } from './i18n'

export interface IpcDeps {
  workspace: Workspace
  settings: SettingsStore
  media: MediaService
  exporter: ExportService
  mcpStatus(): { url: string; running: boolean }
}

const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mxf', 'mts', 'm2ts', 'mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'tif', 'tiff', 'bmp', 'json', 'srt', 'vtt']
  .filter((ext) => clipTypeForExtension(ext) !== null)

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  mp4: 'mp4', mov: 'mov', webm: 'webm', gif: 'gif', m4a: 'm4a', wav: 'wav', png: 'png', fcpxml: 'fcpxml', xml: 'xml', palmier: PROJECT.fileExtension,
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const NATIVE_EDITS = new Set<NativeEditAction>(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])

export function registerIpc(d: IpcDeps): void {
  const { workspace, settings, media, exporter } = d

  const sessionOf = (e: IpcMainInvokeEvent | Electron.IpcMainEvent): ProjectSession => {
    const s = workspace.sessionFor(e.sender)
    if (!s) throw new Error('No project is open in this window.')
    return s
  }
  const winOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? undefined
  const openDialog = (e: IpcMainInvokeEvent, o: OpenDialogOptions) => {
    const win = winOf(e)
    return win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o)
  }

  ipcMain.handle('app:info', () => {
    const mcp = d.mcpStatus()
    return { version: app.getVersion(), platform: process.platform, mcpUrl: mcp.url, mcpRunning: mcp.running, ffmpeg: ffmpegPath }
  })
  ipcMain.on('app:showItemInFolder', (_e, p: unknown) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p)
  })
  ipcMain.on('app:openExternal', (_e, url: unknown) => {
    // Plus Help ▸ MCP ▸ "Install in Cursor" (05 §10.4); a missing Cursor handler just fails quietly.
    if (typeof url === 'string' && (/^https?:\/\//i.test(url) || url.startsWith('cursor://anysphere.cursor-deeplink/'))) void shell.openExternal(url).catch(() => undefined)
  })
  ipcMain.on('app:nativeEdit', (e, action: NativeEditAction) => {
    if (NATIVE_EDITS.has(action)) e.sender[action]()
  })
  ipcMain.on('app:closeWindow', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  ipcMain.handle('home:listRecent', () => listRecentProjects())
  ipcMain.handle('home:createProject', async (e, name: string) => {
    try {
      await workspace.create(String(name ?? ''), e.sender)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('home:openTutorial', async (e) => {
    try {
      await workspace.openTutorial(e.sender)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  registerFeedbackIpc()
  ipcMain.handle('home:openProject', async (e, p?: string) => {
    let target = typeof p === 'string' ? p : null
    if (!target) {
      const r = await openDialog(e, { title: tm('Open Project'), defaultPath: settings.get().projectsDirectory, properties: ['openDirectory'], buttonLabel: tm('Open') })
      if (r.canceled || !r.filePaths[0]) return { ok: false, error: '' }
      target = r.filePaths[0]
    }
    try {
      await workspace.openPath(target, e.sender)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('home:removeRecent', (_e, p: string) => removeProject(String(p)))
  ipcMain.handle('home:trashProject', async (_e, p: string) => {
    const target = path.resolve(String(p))
    if (workspace.all().some((s) => path.resolve(s.path) === target)) return { ok: false, error: 'Close the project before deleting it.' }
    try {
      await shell.trashItem(target)
      await removeProject(target)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('project:get', (e) => workspace.stateFor(e.sender))
  ipcMain.handle('project:op', (e, name: OpName, args: unknown) => {
    if (typeof name !== 'string' || !Object.hasOwn(OPS, name)) return { ok: false, error: `Unknown operation “${String(name)}”.`, beep: false }
    return sessionOf(e).apply(name, args as never)
  })
  ipcMain.handle('project:undo', (e) => sessionOf(e).undo())
  ipcMain.handle('project:redo', (e) => sessionOf(e).redo())
  ipcMain.handle('project:save', (e) => sessionOf(e).save())
  ipcMain.handle('project:saveAs', async (e) => {
    const session = sessionOf(e)
    const win = winOf(e)
    const opts = { title: tm('Save As'), defaultPath: path.join(path.dirname(session.path), `${session.name} copy.${PROJECT.fileExtension}`), buttonLabel: tm('Save') }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return
    const dest = r.filePath.endsWith(`.${PROJECT.fileExtension}`) ? r.filePath : `${r.filePath}.${PROJECT.fileExtension}`
    if (await exists(dest)) throw new Error(`“${path.basename(dest)}” already exists. Choose another name.`)
    await session.saveAs(dest)
  })
  ipcMain.handle('project:close', (e) => workspace.closeProject(e.sender))
  ipcMain.on('project:setUi', (e, patch: Partial<UiState>) => {
    const s = workspace.sessionFor(e.sender)
    if (s && patch && typeof patch === 'object') s.setUi(patch)
  })

  ipcMain.handle('media:importFiles', async (e, paths?: string[], folderId?: string) => {
    const session = sessionOf(e)
    let list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : null
    if (!list) {
      const r = await openDialog(e, {
        title: tm('Import Media'),
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: tm('Media'), extensions: MEDIA_EXTENSIONS }, { name: tm('All Files'), extensions: ['*'] }],
      })
      if (r.canceled) return { added: [], rejected: [] }
      list = r.filePaths
    }
    return media.importPaths(session, list, typeof folderId === 'string' ? folderId : undefined)
  })
  ipcMain.handle('media:probe', (_e, p: string) => media.probe(String(p)))
  ipcMain.handle('media:playbackPath', (e, id: string) => media.playbackPath(sessionOf(e), String(id)))
  ipcMain.handle('media:thumbnail', (e, id: string, at?: number) => media.thumbnail(sessionOf(e), String(id), Number.isFinite(at) ? at : undefined))
  ipcMain.handle('media:filmstrip', (e, id: string, count: number, height: number) => media.filmstrip(sessionOf(e), String(id), Number(count) || 1, Number(height) || 48))
  ipcMain.handle('media:waveform', (e, id: string) => media.waveform(sessionOf(e), String(id)))
  ipcMain.handle('media:relink', async (e, id: string, newPath?: string) => {
    const session = sessionOf(e)
    const entry = session.doc.manifest.entries.find((x) => x.id === id)
    if (!entry) return { ok: false, error: 'That media item no longer exists.' }
    let target = typeof newPath === 'string' ? newPath : null
    if (!target) {
      const r = await openDialog(e, { title: tm('Choose the source file for "{0}"', entry.name), properties: ['openFile'] })
      if (r.canceled || !r.filePaths[0]) return { ok: false }
      target = r.filePaths[0]
    }
    if (!(await stat(target).catch(() => null))?.isFile()) return { ok: false, error: `“${path.basename(target)}” isn’t a file.` }
    // EditorViewModel.relinkAsset: refuse a known extension of another type; an unreadable file still relinks (it shows as offline).
    const extType = extensionType(target)
    if (extType && extType !== entry.type) return { ok: false, error: relinkTypeMismatch(target, entry.type, extType) }
    const probe = await media.probe(target).catch(() => null)
    if (probe && probe.type !== entry.type) return { ok: false, error: relinkTypeMismatch(target, entry.type, probe.type) }
    const file = target
    const outcome = session.transact('Relink Media', (doc) => projectOps.updateMediaEntry(doc, String(id), relinkPatch(sourceForPath(file, session.path), probe)))
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
  })
  ipcMain.handle('media:offline', (e) => {
    const session = sessionOf(e)
    return offlineReport(session.doc.manifest.entries, (x) => session.resolveMedia(x), (f) => media.probe(f))
  })
  ipcMain.handle('media:relinkFolder', async (e, folder?: string) => {
    const session = sessionOf(e)
    let dir = typeof folder === 'string' ? folder : null
    if (!dir) {
      const r = await openDialog(e, { title: tm('Choose the folder that holds your media'), properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      dir = r.filePaths[0]
    }
    const entries = session.doc.manifest.entries
    const report = await offlineReport(entries, (x) => session.resolveMedia(x), (f) => media.probe(f))
    const offline = new Set([...report.missing, ...report.unprocessable])
    if (!offline.size) return { relinked: 0, total: 0 }
    const matches = matchOffline(entries, offline, (x) => session.resolveMedia(x), await fileIndex(dir))
    const patches = await Promise.all(
      [...matches].map(async ([id, file]) => [id, relinkPatch(sourceForPath(file, session.path), await media.probe(file).catch(() => null))] as const),
    )
    if (patches.length) {
      const outcome = session.transact('Relink Media', (doc) => {
        for (const [id, patch] of patches) projectOps.updateMediaEntry(doc, id, patch)
      })
      if (!outcome.ok) return { relinked: 0, total: offline.size, error: outcome.error }
    }
    return { relinked: patches.length, total: offline.size }
  })
  ipcMain.handle('media:pasteClipboard', async (e, folderId?: string) => {
    const session = sessionOf(e)
    const folder = typeof folderId === 'string' ? folderId : undefined
    const clip = await readClipboardMedia()
    if (!clip) return { kind: 'empty' }
    if ('files' in clip) return { kind: 'files', ...(await media.importPaths(session, clip.files, folder)) }
    const name = `pasted-${randomUUID().slice(0, 8).toUpperCase()}`
    try {
      const id = await media.importBytes(session, clip.image, `${name}.${clip.ext}`, { prefix: 'pasted', folderId: folder, name })
      return { kind: 'image', added: [id], rejected: [] }
    } catch (err) {
      return { kind: 'image', added: [], rejected: [{ path: `${name}.${clip.ext}`, reason: errorMessage(err) }] }
    }
  })
  ipcMain.handle('media:pickFiles', async (e, kind: 'media' | 'lut') => {
    const filters = kind === 'lut' ? [{ name: 'LUT', extensions: ['cube'] }] : [{ name: tm('Media'), extensions: MEDIA_EXTENSIONS }]
    const r = await openDialog(e, { properties: ['openFile', ...(kind === 'media' ? (['multiSelections'] as const) : [])], filters })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle('export:chooseOutput', async (e, defaultName: string, format: ExportFormat) => {
    const ext = EXPORT_EXTENSIONS[format]
    if (!ext) return null
    const base = String(defaultName || 'Export').replace(/[/\\]/g, ' ')
    const win = winOf(e)
    const opts = { title: tm('Export'), defaultPath: path.join(app.getPath('videos'), `${base}.${ext}`), filters: [{ name: format.toUpperCase(), extensions: [ext] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    return r.filePath.toLowerCase().endsWith(`.${ext}`) ? r.filePath : `${r.filePath}.${ext}`
  })
  ipcMain.handle('export:start', (e, options: ExportOptions) => {
    try {
      return { ok: true, job: exporter.start(sessionOf(e), options) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('export:cancel', (_e, id: string) => exporter.cancel(String(id)))
  ipcMain.handle('export:list', () => exporter.list())
  ipcMain.handle('export:remove', (_e, id: string) => {
    const ids = exporter.remove?.(String(id)) ?? []
    if (ids.length) workspace.broadcast('export:removed', ids)
  })
  ipcMain.handle('export:clearFinished', (e) => {
    const session = workspace.sessionFor(e.sender)
    const ids = session ? (exporter.clearFinished?.(session.path) ?? []) : []
    if (ids.length) workspace.broadcast('export:removed', ids)
  })

  ipcMain.handle('settings:get', () => settings.masked())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => settings.set(patch && typeof patch === 'object' ? patch : {}))
}
