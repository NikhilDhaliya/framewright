import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Layout } from '../theme/sizes'
import { useEditor, type PanelId } from '../state/editor'
import { useLayoutPreset } from '../state/settings'
import { InspectorPanel } from '../inspector/InspectorPanel'
import { MediaPanel } from '../media/MediaPanel'
import { PreviewPanel } from '../preview/PreviewPanel'
import { TimelinePane } from '../timeline/TimelinePane'
import { AgentPanel } from '../agent/AgentPanel'
import { PanelHost } from './PanelHost'
import { AGENT_PANEL_INITIAL, AGENT_PANEL_MIN, presetMinWidth, setEditorBodyWidth, useEffectivePanels } from './panelFit'
import { Split } from './Split'
import { TitleBar } from './TitleBar'
import { useEditorKeys } from './keyboard'

const PANEL_CONTENT: Record<PanelId, () => ReactNode> = {
  mediaPanel: () => <MediaPanel />,
  previewPanel: () => <PreviewPanel />,
  inspectorPanel: () => <InspectorPanel />,
  timelinePanel: () => <TimelinePane />,
}

function usePaneVisibility() {
  const panels = useEffectivePanels()
  const maximized = useEditor((s) => s.maximized)
  return (ids: PanelId[]) => {
    if (maximized) return !ids.includes(maximized)
    if (ids.length === 1 && ids[0] === 'mediaPanel') return !panels.media
    if (ids.length === 1 && ids[0] === 'inspectorPanel') return !panels.inspector
    return false
  }
}

const pane = (id: PanelId) => <PanelHost id={id}>{PANEL_CONTENT[id]()}</PanelHost>

function PresetLayout() {
  const preset = useLayoutPreset()
  const hidden = usePaneVisibility()
  const media = { id: 'media', min: Layout.mediaPanelMin, hidden: hidden(['mediaPanel']), content: pane('mediaPanel') }
  const inspector = { id: 'inspector', min: Layout.inspectorMin, initial: () => Layout.inspectorDefault, hidden: hidden(['inspectorPanel']), content: pane('inspectorPanel') }
  const preview = { id: 'preview', min: Layout.previewMinWidth, hidden: hidden(['previewPanel']), content: pane('previewPanel') }
  const timeline = { id: 'timeline', min: Layout.timelineMinHeight, hidden: hidden(['timelinePanel']), content: pane('timelinePanel') }

  if (preset === 'media') {
    const right = (
      <Split
        dir="column"
        storageKey="split.media.right"
        panes={[
          { id: 'top', min: Layout.previewMinHeight, flex: true, hidden: hidden(['previewPanel', 'inspectorPanel']), content: <Split dir="row" storageKey="split.media.top" panes={[{ ...preview, flex: true }, inspector]} /> },
          { ...timeline, initial: (h) => Math.round(h * 0.45) },
        ]}
      />
    )
    return (
      <Split
        dir="row"
        storageKey="split.media.root"
        panes={[
          { ...media, initial: (w) => Math.round(w * 0.3) },
          { id: 'right', min: Layout.previewMinWidth, flex: true, hidden: hidden(['previewPanel', 'inspectorPanel', 'timelinePanel']), content: right },
        ]}
      />
    )
  }
  if (preset === 'vertical') {
    const left = (
      <Split
        dir="column"
        storageKey="split.vertical.left"
        panes={[
          { id: 'top', min: Layout.previewMinHeight, flex: true, hidden: hidden(['mediaPanel', 'inspectorPanel']) || (media.hidden && inspector.hidden), content: <Split dir="row" storageKey="split.vertical.top" panes={[{ ...media, initial: () => Layout.mediaPanelDefault }, { ...inspector, flex: true }]} /> },
          { ...timeline, initial: (h) => Math.round(h * 0.45) },
        ]}
      />
    )
    return (
      <Split
        dir="row"
        storageKey="split.vertical.root"
        panes={[
          { id: 'left', min: Layout.mediaPanelMin, flex: true, hidden: hidden(['mediaPanel', 'inspectorPanel', 'timelinePanel']), content: left },
          { ...preview, initial: (w) => Math.round(w * 0.5) },
        ]}
      />
    )
  }
  const upper = <Split dir="row" storageKey="split.default.upper" panes={[{ ...media, initial: () => Layout.mediaPanelDefault }, { ...preview, flex: true }, inspector]} />
  return (
    <Split
      dir="column"
      storageKey="split.default.root"
      panes={[
        { id: 'upper', min: Layout.previewMinHeight, flex: true, hidden: hidden(['mediaPanel', 'previewPanel', 'inspectorPanel']), content: upper },
        { ...timeline, initial: (h) => Math.round(h * Layout.timelineDefaultHeightFraction) },
      ]}
    />
  )
}

/** Root split: [agent column (240+, hidden by default) | preset layout] (05 §2.3). The preset keeps its nested minimums. */
function RootLayout() {
  const panels = useEffectivePanels()
  const preset = useLayoutPreset()
  return (
    <Split
      dir="row"
      storageKey="split.root"
      panes={[
        { id: 'agent', min: AGENT_PANEL_MIN, initial: () => AGENT_PANEL_INITIAL, hidden: !panels.agent, content: <AgentPanel /> },
        { id: 'preset', min: presetMinWidth(panels, preset), flex: true, content: <PresetLayout /> },
      ]}
    />
  )
}

export function Editor() {
  useEditorKeys()
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current!
    const ro = new ResizeObserver(() => setEditorBodyWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div className="pp-editor">
      <TitleBar />
      <div className="pp-editor-body" ref={body}>
        <RootLayout />
      </div>
    </div>
  )
}
