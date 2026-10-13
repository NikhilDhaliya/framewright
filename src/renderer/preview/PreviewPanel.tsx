import './preview.css'
import { useEffect } from 'react'
import { useProject, useTimeline } from '../state/project'
import { closeAllPreviewTabs, closePreviewTab, navigatePreviewHistory, selectPreviewTab, usePreviewTabs } from '../state/previewTabs'
import { IconButton } from '../ui/buttons'
import { openMenuBelow } from '../ui/Menu'
import { DocTab, PanelHeader, TabStrip } from '../ui/panels'
import { startEngine, stopEngine } from './engineHost'
import { SourcePreview } from './SourcePreview'
import { TimelinePreview } from './TimelinePreview'
import { t } from '../i18n'

function PreviewTabs() {
  const tabs = usePreviewTabs((s) => s.tabs)
  const active = usePreviewTabs((s) => s.active)
  const canBack = usePreviewTabs((s) => s.cursor > 0)
  const canForward = usePreviewTabs((s) => s.cursor < s.history.length - 1)
  const timelineName = useTimeline()?.name ?? t('Timeline')
  const entries = useProject((s) => s.snapshot?.doc.manifest.entries)
  return (
    <PanelHeader className="pp-preview-tabs">
      <IconButton sf="chevron.left" size={11} frame={[18, 22]} tone={canBack ? 'secondary' : 'muted'} disabled={!canBack} tip={t('Back')} onClick={() => navigatePreviewHistory(-1)} />
      <IconButton sf="chevron.right" size={11} frame={[18, 22]} tone={canForward ? 'secondary' : 'muted'} disabled={!canForward} tip={t('Forward')} onClick={() => navigatePreviewHistory(1)} />
      <TabStrip style={{ paddingLeft: 6, paddingRight: 6 }}>
        {tabs.map((id) => (
          <DocTab
            key={id}
            label={id === 'timeline' ? timelineName : (entries?.find((e) => `media_${e.id}` === id)?.name ?? t('Media'))}
            active={id === active}
            closeable={id !== 'timeline'}
            onSelect={() => selectPreviewTab(id)}
            onClose={() => closePreviewTab(id)}
          />
        ))}
      </TabStrip>
      <IconButton
        sf="ellipsis"
        size={11}
        frame={22}
        tip={t('More')}
        onClick={(e) => openMenuBelow(e.currentTarget, [{ label: t('Close All Tabs'), disabled: tabs.length <= 1, onSelect: closeAllPreviewTabs }], { alignRight: true })}
      />
    </PanelHeader>
  )
}

export function PreviewPanel() {
  const active = usePreviewTabs((s) => s.active)
  const asset = useProject((s) => (active === 'timeline' ? null : (s.snapshot?.doc.manifest.entries.find((e) => `media_${e.id}` === active) ?? null)))
  useEffect(() => {
    startEngine()
    return stopEngine
  }, [])
  return (
    <div className="pp-preview">
      <PreviewTabs />
      {asset ? <SourcePreview asset={asset} /> : <TimelinePreview />}
    </div>
  )
}
