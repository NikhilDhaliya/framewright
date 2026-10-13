import { IconButton } from '../ui/buttons'
import { Icon } from '../ui/Icon'
import { useProject } from '../state/project'
import { togglePanelFitting, useEffectivePanels } from './panelFit'
import { openDialog } from '../state/dialogs'
import { exportButtonLabel, exportCounts, useProjectExportJobs } from '../dialogs/exportJobs'
import '../dialogs/exportQueue.css'
import { t } from '../i18n'

export function TitleBar() {
  const name = useProject((s) => s.snapshot?.name ?? '')
  const dirty = useProject((s) => s.snapshot?.dirty ?? false)
  const panels = useEffectivePanels()
  const counts = exportCounts(useProjectExportJobs())
  return (
    <div className="pp-titlebar drag-region">
      <div className="pp-titlebar-leading no-drag">
        <IconButton sf={panels.agent ? 'bubble.left.fill' : 'bubble.left'} size={13} frame={26} tone={panels.agent ? 'primary' : 'muted'} tip={t('Agent Panel')} aria-pressed={panels.agent} onClick={() => togglePanelFitting('agent')} />
        <IconButton sf="sidebar.left" size={13} frame={26} tone={panels.media ? 'primary' : 'muted'} tip={t('Media Panel')} aria-pressed={panels.media} onClick={() => togglePanelFitting('media')} />
        <IconButton sf="sidebar.right" size={13} frame={26} tone={panels.inspector ? 'primary' : 'muted'} tip={t('Inspector Panel')} aria-pressed={panels.inspector} onClick={() => togglePanelFitting('inspector')} />
      </div>
      <div className="pp-titlebar-title">
        <span className="ellipsis">{name}</span>
        {dirty && <span className="pp-dirty-dot" aria-label={t('Unsaved changes')} />}
      </div>
      <div className="pp-titlebar-trailing no-drag">
        <button type="button" className="pp-titlebar-capsule" data-tip={t('Export (Ctrl+E)')} aria-label={exportButtonLabel(counts)} onClick={() => openDialog({ kind: 'export' })}>
          {counts.active > 0 ? <span className="pp-export-activity-dot" aria-hidden /> : <Icon sf="square.and.arrow.up" size={11} />}
          {t('Export')}
        </button>
        <IconButton sf="key" size={13} frame={26} tone="secondary" tip={t('API Keys')} onClick={() => openDialog({ kind: 'settings', pane: 'keys' })} />
      </div>
    </div>
  )
}
