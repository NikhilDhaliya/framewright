import { create } from 'zustand'
import type { AppSettings } from '../../shared/api'

export const useSettings = create<{ settings: AppSettings | null }>(() => ({ settings: null }))

const DEFAULT_PANELS: AppSettings['panels'] = { media: true, inspector: true, agent: false }

export const usePanels = () => useSettings((s) => s.settings?.panels ?? DEFAULT_PANELS)
export const useLayoutPreset = () => useSettings((s) => s.settings?.layoutPreset ?? 'default')

function applyTheme(theme: AppSettings['theme'] | undefined): void {
  const dark = theme === 'light' ? false : theme === 'dark' || theme === undefined ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

const CLIP_COLOR_VARS: Record<string, string> = {
  video: '--pp-clip-video',
  audio: '--pp-clip-audio',
  image: '--pp-clip-image',
  text: '--pp-clip-text',
  animation: '--pp-clip-animation',
  sequence: '--pp-clip-sequence',
}

/** Settings ▸ Appearance ▸ Timeline colors override the clip palette everywhere it is used (timeline, track headers, media tiles). */
function applyClipColors(colors: AppSettings['timelineColors']): void {
  const style = document.documentElement.style
  for (const [kind, name] of Object.entries(CLIP_COLOR_VARS)) {
    const v = colors?.[kind]
    if (v) style.setProperty(name, v)
    else style.removeProperty(name)
  }
}

function receive(settings: AppSettings): void {
  applyClipColors(settings.timelineColors)
  useSettings.setState({ settings })
  applyTheme(settings.theme)
}

export async function loadSettings(): Promise<void> {
  applyTheme(undefined)
  window.palmier.settings.onChange(receive)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useSettings.getState().settings?.theme))
  receive(await window.palmier.settings.get())
}

/** Optimistic local update, persisted by main (which also refreshes menu checkmarks). */
export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  const cur = useSettings.getState().settings
  if (cur) receive({ ...cur, ...patch })
  receive(await window.palmier.settings.set(patch))
}

export function togglePanel(panel: keyof AppSettings['panels']): void {
  const panels = useSettings.getState().settings?.panels ?? DEFAULT_PANELS
  void updateSettings({ panels: { ...panels, [panel]: !panels[panel] } })
}

export const rippleMarkersEnabled = (): boolean => useSettings.getState().settings?.rippleTimelineMarkers ?? true
