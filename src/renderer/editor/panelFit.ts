/**
 * Keeps every panel minimum intact when the agent column shares the window (05 §2.3). The Mac's nested
 * NSSplitView minimums propagate up (the preset root can't get narrower than media + preview + inspector);
 * here the side panels that don't fit collapse instead of squeezing the preview below 400 px.
 * Plain resizes never touch the saved visibility flags; showing a panel from the title bar or menu makes
 * room by turning other side panels off ("last action wins").
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import type { AppSettings } from '../../shared/api'
import { updateSettings, useLayoutPreset, usePanels, useSettings } from '../state/settings'
import { Layout } from '../theme/sizes'

type Panels = AppSettings['panels']
type Preset = AppSettings['layoutPreset']
type PanelKey = keyof Panels

export const AGENT_PANEL_MIN = 240
export const AGENT_PANEL_INITIAL = 340
const COLLAPSE_ORDER: PanelKey[] = ['inspector', 'media', 'agent']

const useBodyWidth = create<{ width: number }>(() => ({ width: 0 }))
export const setEditorBodyWidth = (width: number) => {
  if (useBodyWidth.getState().width !== width) useBodyWidth.setState({ width })
}

/** Narrowest preset root that shows these panels with every minimum (1 px dividers included). */
export function presetMinWidth(p: Panels, preset: Preset): number {
  if (preset === 'vertical') {
    // [left: (media | inspector) over the timeline | preview]; the left column never goes below the media minimum.
    const row = (p.media ? Layout.mediaPanelMin : 0) + (p.inspector ? Layout.inspectorMin : 0) + (p.media && p.inspector ? 1 : 0)
    return Math.max(Layout.mediaPanelMin, row) + 1 + Layout.previewMinWidth
  }
  return (p.media ? Layout.mediaPanelMin + 1 : 0) + Layout.previewMinWidth + (p.inspector ? Layout.inspectorMin + 1 : 0)
}

export const requiredWidth = (p: Panels, preset: Preset): number => (p.agent ? AGENT_PANEL_MIN + 1 : 0) + presetMinWidth(p, preset)

/** The panels that fit `width`: shown side panels collapse in order inspector → media → agent, never `keep`. */
export function fitPanels(p: Panels, preset: Preset, width: number, keep?: PanelKey): Panels {
  if (width <= 0 || requiredWidth(p, preset) <= width) return p
  const next = { ...p }
  for (const k of COLLAPSE_ORDER) {
    if (requiredWidth(next, preset) <= width) break
    if (k !== keep && next[k]) next[k] = false
  }
  return next
}

/** Visibility actually laid out (flags minus panels collapsed for space). */
export function useEffectivePanels(): Panels {
  const panels = usePanels()
  const preset = useLayoutPreset()
  const width = useBodyWidth((s) => s.width)
  return useMemo(() => fitPanels(panels, preset, width), [panels, preset, width])
}

/** Keeps main's View-menu checkmarks on the panels actually laid out (not just the saved flags). */
let reported: Panels | null = null
function reportEffectivePanels(): void {
  const settings = useSettings.getState().settings
  if (!settings) return
  const p = fitPanels(settings.panels, settings.layoutPreset, useBodyWidth.getState().width)
  if (reported && reported.media === p.media && reported.inspector === p.inspector && reported.agent === p.agent) return
  reported = p
  window.palmier.app.reportPanels(p)
}
useSettings.subscribe(reportEffectivePanels)
useBodyWidth.subscribe(reportEffectivePanels)

/** Title bar / View menu toggle: hides a shown panel; showing one turns other side panels off when needed. */
export function togglePanelFitting(key: PanelKey): void {
  const settings = useSettings.getState().settings
  if (!settings) return
  const width = useBodyWidth.getState().width
  const flags = settings.panels
  if (fitPanels(flags, settings.layoutPreset, width)[key]) {
    void updateSettings({ panels: { ...flags, [key]: false } })
    return
  }
  const next = fitPanels({ ...flags, [key]: true }, settings.layoutPreset, width, key)
  if (next.media !== flags.media || next.inspector !== flags.inspector || next.agent !== flags.agent) void updateSettings({ panels: next })
}

/** Shows `key` (making room) unless it is already visible. */
export function showPanelFitting(key: PanelKey): void {
  const settings = useSettings.getState().settings
  if (!settings) return
  if (!fitPanels(settings.panels, settings.layoutPreset, useBodyWidth.getState().width)[key]) togglePanelFitting(key)
}
