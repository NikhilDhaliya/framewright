import { useState } from 'react'
import { mediaUrl, type RecentProject } from '../../shared/api'
import { Icon } from '../ui/Icon'
import { activeLocale, t } from '../i18n'

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]
const rtf = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'always', style: 'long' })

export function relativeDate(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') return rtf.format(Math.trunc(seconds / size), unit)
  }
  return ''
}

interface ProjectCardProps {
  project: RecentProject
  selectMode: boolean
  selected: boolean
  onActivate: () => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

export function ProjectCard({ project, selectMode, selected, onActivate, onDelete, onContextMenu }: ProjectCardProps) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const missing = !project.accessible
  const thumb = project.thumbnailPath && !thumbFailed ? mediaUrl(project.thumbnailPath) : null
  return (
    <div className="pp-home-cell">
      <div
        className={`pp-home-card${selected ? ' selected' : ''}${missing ? ' missing' : ''}`}
        role="button"
        tabIndex={-1}
        onClick={onActivate}
        onContextMenu={onContextMenu}
      >
        <div className="pp-home-plate">
          {thumb ? (
            <img src={thumb} alt="" draggable={false} onError={() => setThumbFailed(true)} />
          ) : (
            <Icon sf="film" size={28} strokeWidth={1.1} className="pp-home-plate-fallback" />
          )}
        </div>
        {missing && (
          <div className="pp-home-missing">
            <Icon sf="questionmark.folder" size={22} strokeWidth={1.4} />
            <span>{t('File missing')}</span>
          </div>
        )}
        <div className="pp-home-card-shade" />
        <div className="pp-home-card-text">
          <span className="pp-home-card-name ellipsis">{project.name}</span>
          <span className="pp-home-card-date ellipsis">{relativeDate(project.createdAt)}</span>
        </div>
        {selectMode ? (
          <span className={`pp-home-card-check${selected ? ' on' : ''}`}>
            <Icon sf={selected ? 'checkmark.circle.fill' : 'circle'} size={18} strokeWidth={selected ? 2 : 1.6} />
          </span>
        ) : (
          <button
            type="button"
            className="pp-home-card-trash"
            data-tip={t('Delete Project')}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Icon sf="trash.fill" size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

export function NewProjectCard({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="pp-home-cell">
      <div className="pp-home-card new" role="button" tabIndex={-1} onClick={onCreate}>
        <div className="pp-home-plate raised">
          <Icon sf="plus" size={28} strokeWidth={1.1} className="pp-home-plate-fallback" />
        </div>
        <div className="pp-home-card-text">
          <span className="pp-home-card-name new ellipsis">{t('Untitled')}</span>
        </div>
      </div>
    </div>
  )
}
