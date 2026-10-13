import { useState } from 'react'
import { setEditor, useEditor } from '../state/editor'
import { useManifest } from '../state/project'
import { Capsule, IconButton } from '../ui/buttons'
import { Icon } from '../ui/Icon'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { SearchField } from '../ui/panels'
import { MediaSearchIndexStatus } from './search/IndexStatus'
import { importMedia, newFolder } from './actions'
import { acceptsFolderDrop, dropIntoFolder } from './interactions'
import { folderPath, setMediaView, useMediaView, type FilterType, type SortOrder, type ViewMode } from './model'
import { organizeWithAgentItem } from '../agent/handoffs'
import { GenerateToolbarButton } from '../generation/GeneratePanel'
import { openMatteSheet } from '../extras/MatteSheet'
import { t, plural } from '../i18n'

const VIEW_MODES: { mode: ViewMode; label: string; icon: 'folder' | 'square.grid.2x2' | 'rectangle.split.1x2' }[] = [
  { mode: 'folders', label: t('Folders'), icon: 'folder' },
  { mode: 'flat', label: t('Flat'), icon: 'square.grid.2x2' },
  { mode: 'grouped', label: t('Grouped'), icon: 'rectangle.split.1x2' },
]
const SIZES = [
  { size: 80, label: t('Small') },
  { size: 110, label: t('Medium') },
  { size: 150, label: t('Large') },
  { size: 200, label: t('Extra Large') },
]
const SORTS: { sort: SortOrder; label: string }[] = [
  { sort: 'name', label: t('Name') },
  { sort: 'dateAdded', label: t('Date Added') },
  { sort: 'duration', label: t('Duration') },
  { sort: 'type', label: t('Type') },
]
const FILTERS: { type: FilterType; label: string }[] = [
  { type: 'video', label: t('Video') },
  { type: 'audio', label: t('Audio') },
  { type: 'image', label: t('Image') },
  { type: 'subtitle', label: t('Subtitle') },
]

function viewMenu(mode: ViewMode, size: number): MenuItem[] {
  return [
    { kind: 'header', label: t('View') },
    ...VIEW_MODES.map((v): MenuItem => ({ label: v.label, icon: v.mode === mode ? 'checkmark' : v.icon, onSelect: () => setMediaView({ viewMode: v.mode }) })),
    { kind: 'divider' },
    { kind: 'header', label: t('Thumbnail Size') },
    ...SIZES.map((s): MenuItem => ({ label: s.label, checked: s.size === size, onSelect: () => setMediaView({ thumbSize: s.size }) })),
  ]
}

function filterMenu(filters: FilterType[]): MenuItem[] {
  return [
    ...FILTERS.map((f): MenuItem => ({
      label: f.label,
      checked: filters.includes(f.type),
      onSelect: () => setMediaView({ filters: filters.includes(f.type) ? filters.filter((x) => x !== f.type) : [...filters, f.type] }),
    })),
    { kind: 'divider' },
    { label: t('Clear Filters'), disabled: !filters.length, onSelect: () => setMediaView({ filters: [] }) },
  ]
}

function Crumb({ folderId, label, leaf }: { folderId: string | null; label: string; leaf: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      className={`pp-media-crumb hh${leaf ? ' leaf' : ''}${hover ? ' drop-hover' : ''}`}
      onClick={() => setEditor({ mediaFolderId: folderId, mediaSelection: [] })}
      onDragOver={(e) => {
        if (!acceptsFolderDrop(e, folderId)) return
        e.preventDefault()
        e.stopPropagation()
        setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        setHover(false)
        void dropIntoFolder(e, folderId)
      }}
    >
      {label}
    </button>
  )
}

function Breadcrumbs() {
  const folderId = useEditor((s) => s.mediaFolderId)
  const folders = useManifest()?.folders
  const path = folders ? folderPath(folders, folderId) : []
  return (
    <div className="pp-media-crumbs no-scrollbar">
      <Crumb folderId={null} label={t('Library')} leaf={path.length === 0} />
      {path.map((f, i) => (
        <span key={f.id} className="pp-media-crumb-seg">
          <Icon sf="chevron.right" size={9} className="tone-muted" />
          <Crumb folderId={f.id} label={f.name} leaf={i === path.length - 1} />
        </span>
      ))}
    </div>
  )
}

export function MediaToolbar({ count }: { count: number }) {
  const viewMode = useMediaView((s) => s.viewMode)
  const thumbSize = useMediaView((s) => s.thumbSize)
  const sort = useMediaView((s) => s.sort)
  const filters = useMediaView((s) => s.filters)
  const query = useMediaView((s) => s.query)
  const expanded = useMediaView((s) => s.searchExpanded)
  return (
    <div className="pp-media-toolbar">
      <div className="pp-media-actions">
        {!expanded && (
          <>
            <Capsule tip={t('Import')} data-tour="importButton" onClick={() => void importMedia()}>
              {t('Import')}
            </Capsule>
            <GenerateToolbarButton />
            <IconButton
              sf="ellipsis"
              size={11}
              frame={[22, 20]}
              tone="tertiary"
              tip={t('More')}
              onClick={(e) => openMenuBelow(e.currentTarget, [{ label: t('New Folder'), icon: 'folder.badge.plus', onSelect: () => void newFolder() }, { label: t('Create Matte'), icon: 'square.fill', onSelect: openMatteSheet }, ...organizeWithAgentItem()])}
            />
            <span className="pp-media-spacer" />
            <MediaSearchIndexStatus />
          </>
        )}
        <SearchField
          value={query}
          onChange={(v) => setMediaView({ query: v })}
          expanded={expanded}
          onExpandedChange={(v) => setMediaView({ searchExpanded: v, ...(v ? null : { query: '' }) })}
          tip={t('Search (Ctrl+K)')}
        />
        {expanded && <MediaSearchIndexStatus />}
        <IconButton sf="rectangle.grid.2x2" size={10} frame={18} tone="tertiary" tip={t('View')} onClick={(e) => openMenuBelow(e.currentTarget, viewMenu(viewMode, thumbSize), { alignRight: true })} />
        <IconButton
          sf="arrow.up.arrow.down"
          size={10}
          frame={18}
          tone="tertiary"
          tip={t('Sort')}
          onClick={(e) => openMenuBelow(e.currentTarget, SORTS.map((s): MenuItem => ({ label: s.label, checked: s.sort === sort, onSelect: () => setMediaView({ sort: s.sort }) })), { alignRight: true })}
        />
        <IconButton
          sf="line.3.horizontal.decrease"
          size={10}
          frame={18}
          tone={filters.length ? 'accent' : 'tertiary'}
          tip={t('Filter')}
          onClick={(e) => openMenuBelow(e.currentTarget, filterMenu(filters), { alignRight: true })}
        />
      </div>
      <div className="pp-media-context">
        {viewMode === 'folders' ? <Breadcrumbs /> : <span className="pp-media-mode-label">{viewMode === 'flat' ? t('Flat') : t('Grouped')}</span>}
        <span className="pp-media-count tnum">{plural(count, '1 item', '{0} items')}</span>
      </div>
    </div>
  )
}
