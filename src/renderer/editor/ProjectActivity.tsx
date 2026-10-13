/**
 * Project Activity button + popover (Mac `ProjectActivityButton` / `ProjectActivityView`, shown in the Generate panel
 * header). Linux: a local list of this project's generations instead of the backend's credit log (06 §B11).
 */
import { useEffect, useMemo, useState } from 'react'
import { useDoc, useProject } from '../state/project'
import { IconButton } from '../ui/buttons'
import { MiddleTruncate } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { Popover, rectOf, type AnchorRect } from '../ui/Popover'
import { activityEntries, relativeTime, type ActivityEntry } from './projectActivityModel'
import './projectActivity.css'
import { activeLocale, t } from '../i18n'

function Row({ entry, now }: { entry: ActivityEntry; now: number }) {
  return (
    <div className={`pp-activity-row ${entry.state}`} data-tip={entry.error}>
      <span className="pp-activity-icon">
        <Icon sf={entry.icon} size={10} />
      </span>
      <MiddleTruncate text={entry.model} className="pp-activity-model" />
      <span style={{ flex: 1, minWidth: 4 }} />
      {entry.status && <span className="pp-activity-status">{entry.status}</span>}
      {entry.createdAt !== null && <span className="pp-activity-time">{relativeTime(entry.createdAt, now, activeLocale())}</span>}
    </div>
  )
}

export function ProjectActivityPopover({ anchor, onClose }: { anchor: AnchorRect; onClose: () => void }) {
  const doc = useDoc()
  const saved = useProject((s) => !!s.snapshot?.path)
  const entries = useMemo(() => activityEntries(doc?.manifest.entries ?? []), [doc?.manifest.entries])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const message = !saved ? t('Save this project to view activity') : entries.length === 0 ? t('No generations yet') : null
  return (
    <Popover anchor={anchor} onClose={onClose} align="center" className="pp-activity">
      <div className="pp-activity-header">{t('Project Activity')}</div>
      <div className="pp-activity-list">
        {message ? <div className="pp-activity-empty">{message}</div> : entries.map((e) => <Row key={e.id} entry={e} now={now} />)}
      </div>
    </Popover>
  )
}

export function ProjectActivityButton() {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  return (
    <>
      <IconButton sf="clock.arrow.circlepath" size={11} frame={26} tone="secondary" tip={t('Project Activity')} active={!!anchor} onClick={(e) => setAnchor(anchor ? null : rectOf(e.currentTarget))} />
      {anchor && <ProjectActivityPopover anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  )
}
