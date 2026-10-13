import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { AppSettings, MenuCommand } from '../shared/api'
import { tm } from './i18n'

type Panels = AppSettings['panels']

export interface MenuState {
  settings: AppSettings
  hasProject: boolean
  /** Panels the focused editor actually lays out (saved flags minus panels collapsed for space); null = the flags. */
  effectivePanels?: Panels | null
}

const effective = new Map<number, Panels>()

/** The renderer reports its laid-out panels (`app:effectivePanels`) so View-menu checkmarks match what is on screen. */
export function registerMenuIpc(refresh: () => void): void {
  ipcMain.on('app:effectivePanels', (e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (typeof r.media !== 'boolean' || typeof r.inspector !== 'boolean' || typeof r.agent !== 'boolean') return
    const id = e.sender.id
    const prev = effective.get(id)
    if (prev && prev.media === r.media && prev.inspector === r.inspector && prev.agent === r.agent) return
    if (!prev) e.sender.once('destroyed', () => effective.delete(id))
    effective.set(id, { media: r.media, inspector: r.inspector, agent: r.agent })
    refresh()
  })
}

export const effectivePanelsFor = (wc: WebContents | null | undefined): Panels | null => (wc ? (effective.get(wc.id) ?? null) : null)

type Send = (command: MenuCommand) => void

/** Linux menu per spec 05 §9.2. Single-key shortcuts are shown but handled by the renderer so text fields keep them. */
export function buildMenu(state: MenuState, send: Send): Menu {
  const { settings, hasProject } = state
  const panels = state.effectivePanels ?? settings.panels
  const item = (label: string, command: MenuCommand, accelerator?: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(command),
    ...extra,
  })
  const shown = (label: string, command: MenuCommand, accelerator: string, extra: Partial<MenuItemConstructorOptions> = {}) =>
    item(label, command, accelerator, { registerAccelerator: false, ...extra })
  const editor = { enabled: hasProject }
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  const template: MenuItemConstructorOptions[] = [
    {
      label: `&${tm('File')}`,
      submenu: [
        item(tm('New'), 'new-project', 'CmdOrCtrl+N'),
        item(tm('New Folder'), 'new-folder', 'CmdOrCtrl+Shift+N', editor),
        item(tm('Open…'), 'open-project', 'CmdOrCtrl+O'),
        sep,
        item(tm('Save'), 'save', 'CmdOrCtrl+S', editor),
        item(tm('Save As…'), 'save-as', 'CmdOrCtrl+Shift+S', editor),
        sep,
        item(tm('Import Media…'), 'import-media', 'CmdOrCtrl+I', editor),
        sep,
        item(tm('Export…'), 'export', 'CmdOrCtrl+E', editor),
        sep,
        { label: tm('Close Window'), accelerator: 'CmdOrCtrl+W', click: () => BrowserWindow.getFocusedWindow()?.close() },
        { label: tm('Quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: `&${tm('Edit')}`,
      submenu: [
        item(tm('Undo'), 'undo', 'CmdOrCtrl+Z'),
        item(tm('Redo'), 'redo', 'CmdOrCtrl+Shift+Z'),
        item(tm('Redo'), 'redo', 'CmdOrCtrl+Y', { visible: false, acceleratorWorksWhenHidden: true }),
        sep,
        item(tm('Cut'), 'cut', 'CmdOrCtrl+X'),
        item(tm('Copy'), 'copy', 'CmdOrCtrl+C'),
        item(tm('Paste'), 'paste', 'CmdOrCtrl+V'),
        item(tm('Select All'), 'select-all', 'CmdOrCtrl+A'),
        sep,
        shown(tm('Select Forward on Track'), 'select-forward-track', 'A', editor),
        shown(tm('Select Forward on All Tracks'), 'select-forward-all', 'Shift+A', editor),
        sep,
        item(tm('Split at Playhead'), 'split', 'CmdOrCtrl+K', editor),
        shown(tm('Trim Start to Playhead'), 'trim-start', 'Q', editor),
        shown(tm('Trim End to Playhead'), 'trim-end', 'W', editor),
        sep,
        shown(tm('Delete'), 'delete', 'Backspace', editor),
        shown(tm('Ripple Delete'), 'ripple-delete', 'Shift+Backspace', editor),
        item(tm('Ripple Timeline Markers'), 'toggle-ripple-markers', undefined, { type: 'checkbox', checked: settings.rippleTimelineMarkers }),
        sep,
        item(tm('Preferences…'), 'settings', 'CmdOrCtrl+,'),
      ],
    },
    {
      label: `&${tm('View')}`,
      submenu: [
        item(tm('Media Panel'), 'toggle-media-panel', 'CmdOrCtrl+0', { type: 'checkbox', checked: panels.media, enabled: hasProject }),
        item(tm('Inspector Panel'), 'toggle-inspector', 'CmdOrCtrl+Alt+0', { type: 'checkbox', checked: panels.inspector, enabled: hasProject }),
        item(tm('Agent Panel'), 'toggle-agent-panel', 'CmdOrCtrl+Alt+A', { type: 'checkbox', checked: panels.agent, enabled: hasProject }),
        sep,
        shown(tm('Maximize Focused Panel'), 'maximize-panel', '`', editor),
        sep,
        {
          label: tm('Layout'),
          enabled: hasProject,
          submenu: [
            item(tm('Default'), 'layout-default', 'CmdOrCtrl+1', { type: 'radio', checked: settings.layoutPreset === 'default' }),
            item(tm('Media'), 'layout-media', 'CmdOrCtrl+2', { type: 'radio', checked: settings.layoutPreset === 'media' }),
            item(tm('Vertical'), 'layout-vertical', 'CmdOrCtrl+3', { type: 'radio', checked: settings.layoutPreset === 'vertical' }),
          ],
        },
        sep,
        item(tm('Zoom In Timeline'), 'zoom-in', undefined, editor),
        item(tm('Zoom Out Timeline'), 'zoom-out', undefined, editor),
        item(tm('Zoom Timeline to Fit'), 'zoom-fit', undefined, editor),
        sep,
        { label: tm('Toggle Full Screen'), accelerator: 'F11', click: () => toggleFullScreen() },
        { label: tm('Toggle Full Screen'), accelerator: 'CmdOrCtrl+F', visible: false, acceleratorWorksWhenHidden: true, click: () => toggleFullScreen() },
        ...(process.env.PALMIER_DEV ? [sep, { role: 'toggleDevTools' } as MenuItemConstructorOptions, { role: 'reload' } as MenuItemConstructorOptions] : []),
      ],
    },
    {
      label: `&${tm('Help')}`,
      submenu: [
        item(tm('Tutorial'), 'tutorial', undefined, editor),
        sep,
        item(tm('Keyboard Shortcuts'), 'shortcuts', 'CmdOrCtrl+Shift+/'),
        item(tm('MCP Instructions'), 'mcp-instructions'),
        sep,
        item(tm('Send Feedback…'), 'feedback'),
        sep,
        item(tm('About {app}'), 'about'),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

function toggleFullScreen(): void {
  const win = BrowserWindow.getFocusedWindow()
  if (win) win.setFullScreen(!win.isFullScreen())
}
