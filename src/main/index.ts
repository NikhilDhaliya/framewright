import './envAliases'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, Menu, net } from 'electron'
import { PROJECT } from '../core/model'
import type { AppSettings, ExportJob } from '../shared/api'
import { AgentHub } from './agent/hub'
import { registerAgentIpc } from './agent/ipc'
import { registerIpc } from './ipc'
import { LocalMediaService } from './media/mediaService'
import { installMediaProtocol, registerMediaSchemePrivileges } from './mediaProtocol'
import { buildMenu, effectivePanelsFor, registerMenuIpc } from './menu'
import { installCrashLog } from './crashLog'
import { cancelRestart, initI18n, registerI18nIpc } from './i18n'
import { configureNotifications, onExportProgress } from './notifications'
import { createMl } from './ml'
import { registerMlIpc } from './ml/ipc'
import { createAudio, registerAudioIpc } from './ml/audio/ipc'
import { registerGenerationIpc, syncGenerationSessions } from './generation/ipc'
import { registerExtrasIpc } from './extras/ipc'
import { createSearch } from './ml/search'
import { registerSearchIpc } from './ml/search/ipc'
import { appDirs, migrateLegacyDirs } from './paths'
import { configureRenderSwitches } from './render/renderService'
import type { AppContext } from './services'
import { SettingsStore } from './settings'
import { createWiring, type McpHandle } from './wiring'
import { Workspace } from './workspace'
import { APP_NAME } from '../shared/brand'

app.setName(APP_NAME)
const migratedDirs = migrateLegacyDirs({ skills: !process.env.PALMIER_SKILLS_DIR })
app.setPath('userData', appDirs.config)
installCrashLog(appDirs.state)
if (migratedDirs.length) console.log(`[${APP_NAME}] moved pre-rebrand folders: ${migratedDirs.join('; ')}`)
registerMediaSchemePrivileges()
configureRenderSwitches()

const MCP_HOST = '127.0.0.1'

function projectArgs(argv: string[]): string[] {
  const env = process.env.PALMIER_OPEN_PROJECT
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.')
  return [...(env ? [env] : []), ...args]
    .map((a) => path.resolve(a))
    .filter((p) => p.endsWith(`.${PROJECT.fileExtension}`) || existsSync(path.join(p, PROJECT.timelineFilename)))
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.PALMIER_RENDERER_URL
  if (devUrl) await win.loadURL(devUrl)
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()
  installMediaProtocol()

  const settings = new SettingsStore()
  await settings.load()
  initI18n(settings.get().appLanguage, [...app.getPreferredSystemLanguages(), app.getLocale()])
  registerI18nIpc()
  const media = new LocalMediaService()
  const ml = createMl({ settings: () => settings.get(), systemLanguages: () => [...app.getPreferredSystemLanguages(), app.getLocale()], fetch: (url, init) => net.fetch(url, init) })
  const audio = createAudio(ml.models)
  const wiring = createWiring({ denoise: audio.denoise })
  const search = createSearch({
    models: ml.models,
    transcription: ml.transcription,
    enabled: () => settings.get().searchIndexEnabled !== false,
    persistEnabled: async (v) => void (await settings.set({ searchIndexEnabled: v })),
    isExportActive: () => wiring.exporter.list().some((j) => j.status === 'running' || j.status === 'queued'),
  })
  // Lottie library thumbnails are rendered by the render host (spec 07 §4.2).
  media.lottieRasterizer = async (file, req) => (await wiring.render.lottieFrames?.(file, req)) ?? []
  const workspace = new Workspace({
    preload: path.join(__dirname, '../preload/index.cjs'),
    icon: path.join(__dirname, '../../resources/icon.png'),
    load: loadRenderer, settings: () => settings.get() })
  const ctx: AppContext = {
    sessions: workspace,
    media,
    render: wiring.render,
    exporter: wiring.exporter,
    settings: () => settings.get(),
    ui: (session, cmd) => {
      workspace.send(session, cmd)
      agent.onUiCommand(session, cmd)
    },
    transcription: ml.transcription,
    search,
    audio: audio.audio,
    denoise: audio.denoise,
    speakers: audio.sessionSpeakers,
  }
  const agent = new AgentHub({
    app: ctx,
    push: (session, channel, payload) => {
      const win = workspace.windowFor(session)
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    },
    prefsFile: path.join(appDirs.config, 'agent.json'),
    skillsCacheFile: path.join(appDirs.cache, 'skills-catalog.json'),
  })
  await agent.prefs.load()
  void agent.skills.startSync()

  let mcp: { handle: McpHandle; port: number } | null = null
  let mcpPending: Promise<void> = Promise.resolve()
  const syncMcp = () => {
    mcpPending = mcpPending.then(async () => {
      const s = settings.get()
      const wanted = s.mcpEnabled ? s.mcpPort : null
      if (mcp?.port === wanted) return
      await mcp?.handle.close().catch(() => undefined)
      mcp = null
      if (wanted === null) return
      try {
        mcp = { handle: await wiring.startMcp(ctx, { port: wanted, host: MCP_HOST }), port: wanted }
      } catch (e) {
        console.error(`[mcp] ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    return mcpPending
  }

  registerIpc({
    workspace,
    settings,
    media,
    exporter: wiring.exporter,
    mcpStatus: () => ({ url: `http://${MCP_HOST}:${mcp?.port ?? settings.get().mcpPort}/mcp`, running: !!mcp }),
  })
  registerAgentIpc(agent, (wc) => workspace.sessionFor(wc))
  registerMlIpc({ ml, sessionFor: (wc) => workspace.sessionFor(wc), broadcast: (channel, payload) => workspace.broadcast(channel, payload), settings: () => settings.get() })
  registerSearchIpc({ search, transcription: ml.transcription, sessionFor: (wc) => workspace.sessionFor(wc), windowFor: (s) => workspace.windowFor(s), sessions: () => workspace.all() })
  workspace.on('focus-change', () => search.syncSessions(workspace.all()))
  registerAudioIpc({ ...audio, sessionFor: (wc) => workspace.sessionFor(wc), sessions: () => workspace.all(), broadcast: (channel, payload) => workspace.broadcast(channel, payload) })

  const refreshMenu = () => {
    const win = BrowserWindow.getFocusedWindow()
    const hasProject = !!(win && workspace.sessionFor(win.webContents))
    const effectivePanels = hasProject ? effectivePanelsFor(win?.webContents) : null
    Menu.setApplicationMenu(buildMenu({ settings: settings.get(), hasProject, effectivePanels }, (command) => workspace.sendToFocused({ type: 'menu', command })))
  }
  registerMenuIpc(() => refreshMenu())
  registerGenerationIpc({ app: ctx, sessionFor: (wc) => workspace.sessionFor(wc) })
  registerExtrasIpc({ app: ctx, sessionFor: (wc) => workspace.sessionFor(wc) })
  workspace.on('focus-change', refreshMenu)
  // Opening/closing a project fires focus-change: resume its generation jobs, cancel orphans of closed ones (spec 06 §B5).
  workspace.on('focus-change', () => syncGenerationSessions(ctx))
  settings.on('change', (s: AppSettings) => {
    workspace.broadcast('settings:change', settings.masked())
    workspace.applyTheme(s.theme)
    refreshMenu()
    void syncMcp()
    agent.onSettingsChanged()
  })
  wiring.exporter.on('progress', (job: ExportJob) => workspace.broadcast('export:progress', job))
  configureNotifications({
    enabled: () => settings.get().notificationsEnabled !== false,
    focus: (session) => {
      const win = workspace.windowFor(session)
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    revealAsset: (session, assetId) => workspace.send(session, { type: 'revealAsset', assetId }),
  })
  wiring.exporter.on('progress', (job: ExportJob) => onExportProgress(job))

  const openProjects = async (paths: string[]) => {
    for (const p of paths) {
      try {
        await workspace.openPath(p)
      } catch (e) {
        console.error(`[open] ${p}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  app.on('second-instance', (_e, argv) => {
    const paths = projectArgs(argv)
    if (paths.length) return void openProjects(paths)
    const win = workspace.windows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else void workspace.openWindow()
  })
  app.on('activate', () => {
    if (!workspace.windows().length) void workspace.openWindow()
  })
  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', () => void agent.saveAll())
  let quitReady = false
  app.on('before-quit', (e) => {
    if (quitReady) return
    e.preventDefault()
    void workspace.closeAll().then((ok) => {
      if (!ok) return cancelRestart()
      quitReady = true
      app.quit()
    })
  })
  app.on('will-quit', () => {
    void ml.shutdown()
    void search.shutdown()
    audio.denoise.cancelAll()
    audio.speakers.dispose()
    wiring.exporter.dispose()
    void wiring.render.dispose()
    void mcp?.handle.close()
  })

  workspace.applyTheme(settings.get().theme)
  refreshMenu()
  void syncMcp()
  const initial = projectArgs(process.argv)
  if (initial.length) {
    await openProjects(initial)
    if (!workspace.windows().length) await workspace.openWindow()
  } else await workspace.openWindow()
}

void main().catch((e) => {
  console.error(e)
  app.exit(1)
})
