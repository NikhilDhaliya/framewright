import { setEditor, useEditor, type ToolMode } from '../state/editor'
import { useProject, useTimeline } from '../state/project'
import { updateSettings, useSettings } from '../state/settings'
import { Divider, IconButton } from '../ui/buttons'
import { Icon, type SFName } from '../ui/Icon'
import { openMenuBelow } from '../ui/Menu'
import { Slider } from '../ui/Slider'
import { Zoom } from '../theme/sizes'
import { addMarker, addText, splitAtPlayhead, trimToPlayhead } from './actions'
import { minZoom, setZoom, useTimelineView, zoomIn, zoomOut } from './view'
import { t, tx } from '../i18n'

const TOOLS: { mode: ToolMode; sf: SFName; tip: string }[] = [
  { mode: 'pointer', sf: 'cursorarrow', tip: t('Pointer (V)') },
  { mode: 'razor', sf: 'scissors', tip: t('Razor (C)') },
  { mode: 'trim', sf: 'arrow.left.and.right', tip: t('Trim (T)') },
]

export function useTabBarExpanded(): boolean {
  const forced = useTimelineView((s) => s.tabBarExpanded)
  const many = useProject((s) => (s.snapshot?.doc.file.timelines.length ?? 0) > 1)
  return forced ?? many
}

function TextGlyph({ text, tip, onClick, className }: { text: string; tip: string; onClick: () => void; className: string }) {
  return (
    <button type="button" className={`pp-iconbtn hh tone-secondary ${className}`} style={{ width: 24, height: 24 }} data-tip={tip} onClick={onClick}>
      {text}
    </button>
  )
}

function ZoomControls() {
  const tl = useTimeline()
  const zoom = useTimelineView((s) => s.zoom)
  const width = useTimelineView((s) => s.viewportWidth)
  const min = minZoom(tl, width)
  return (
    <div className="pp-tl-zoom">
      <IconButton sf="minus.magnifyingglass" size={11} tone={zoom <= min ? 'muted' : 'tertiary'} disabled={zoom <= min} tip={t('Zoom Out')} onClick={zoomOut} />
      <Slider value={Math.log(zoom)} min={Math.log(min)} max={Math.log(Zoom.max)} defaultValue={Math.log(Zoom.defaultPpf)} width={100} onChange={(v) => setZoom(Math.exp(v))} onCommit={(v) => setZoom(Math.exp(v))} />
      <IconButton sf="plus.magnifyingglass" size={11} tone={zoom >= Zoom.max ? 'muted' : 'tertiary'} disabled={zoom >= Zoom.max} tip={t('Zoom In')} tipAlign="trailing" onClick={zoomIn} />
    </div>
  )
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool)
  const undoLabel = useProject((s) => s.snapshot?.undoLabel ?? null)
  const redoLabel = useProject((s) => s.snapshot?.redoLabel ?? null)
  const expanded = useTabBarExpanded()
  const ripple = useSettings((s) => s.settings?.rippleTimelineMarkers ?? true)
  return (
    <div className="pp-tl-toolbar">
      <IconButton
        sf={expanded ? 'film.stack.fill' : 'film.stack'}
        size={13}
        tone={expanded ? 'primary' : 'tertiary'}
        active={expanded}
        tip={expanded ? t('Hide Timeline Tabs') : t('Show Timeline Tabs')}
        tipAlign="leading"
        onClick={() => useTimelineView.setState({ tabBarExpanded: !expanded })}
      />
      <Divider />
      <IconButton sf="arrow.uturn.backward" size={13} disabled={!undoLabel} tip={undoLabel ? t('Undo {0} (Ctrl+Z)', tx(undoLabel)) : t('Undo (Ctrl+Z)')} onClick={() => void window.palmier.project.undo()} />
      <IconButton sf="arrow.uturn.forward" size={13} disabled={!redoLabel} tip={redoLabel ? t('Redo {0} (Ctrl+Shift+Z)', tx(redoLabel)) : t('Redo (Ctrl+Shift+Z)')} onClick={() => void window.palmier.project.redo()} />
      <Divider />
      {TOOLS.map((x) => (
        <IconButton key={x.mode} sf={x.sf} size={13} tone={tool === x.mode ? 'primary' : 'tertiary'} active={tool === x.mode} tip={x.tip} onClick={() => setEditor({ tool: x.mode })} />
      ))}
      <Divider />
      <IconButton sf="square.split.2x1" size={13} tip={t('Split at Playhead (Ctrl+K)')} onClick={() => void splitAtPlayhead()} />
      <TextGlyph text="[" className="pp-tl-bracket" tip={t('Trim Start to Playhead (Q)')} onClick={() => void trimToPlayhead('left')} />
      <TextGlyph text="]" className="pp-tl-bracket" tip={t('Trim End to Playhead (W)')} onClick={() => void trimToPlayhead('right')} />
      <Divider />
      <TextGlyph text="T" className="pp-tl-textglyph" tip={t('Add Text')} onClick={() => void addText()} />
      <div className="pp-tl-marker-btn hh">
        <button type="button" className="pp-tl-marker-flag" data-tip={t('Add Marker (M)')} onClick={() => void addMarker()}>
          <svg width="10" height="12" viewBox="0 0 10 12">
            <path d="M 0 0 H 10 V 7 L 5 12 L 0 7 Z" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="pp-tl-marker-chevron"
          onClick={(e) => openMenuBelow(e.currentTarget, [{ label: t('Ripple Timeline Markers'), checked: ripple, onSelect: () => void updateSettings({ rippleTimelineMarkers: !ripple }) }])}
        >
          <Icon sf="chevron.down" size={8} strokeWidth={2.5} />
        </button>
      </div>
      <span style={{ flex: 1 }} />
      <ZoomControls />
    </div>
  )
}
