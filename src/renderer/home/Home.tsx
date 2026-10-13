import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RecentProject } from '../../shared/api'
import { openDialog } from '../state/dialogs'
import { Capsule } from '../ui/buttons'
import { AppLogo } from '../ui/AppIcon'
import { Icon, type SFName } from '../ui/Icon'
import { openMenu, tidy } from '../ui/Menu'
import { SearchField } from '../ui/panels'
import { toast } from '../ui/toast'
import { FirstRunOverlays } from '../onboarding/FirstRun'
import { DeleteProjectsSheet } from './DeleteProjectsSheet'
import { NewProjectCard, ProjectCard } from './ProjectCard'
import './home.css'
import { t } from '../i18n'

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

function SidebarRow({ icon, label, onClick }: { icon: SFName; label: string; onClick: () => void }) {
  return (
    <button type="button" className="pp-home-row hh" onClick={onClick}>
      <span className="pp-home-row-icon">
        <Icon sf={icon} size={13} />
      </span>
      <span className="ellipsis">{label}</span>
    </button>
  )
}

async function openProject(path?: string): Promise<void> {
  const r = await window.palmier.home.openProject(path)
  if (!r.ok && r.error) toast(r.error, 'error')
}

function useRecents(): [RecentProject[] | null, () => void] {
  const [recents, setRecents] = useState<RecentProject[] | null>(null)
  const refresh = useCallback(() => {
    void window.palmier.home.listRecent().then((list) => setRecents([...list].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))))
  }, [])
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return [recents, refresh]
}

export function Home() {
  const [recents, refresh] = useRecents()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<RecentProject[] | null>(null)

  const visible = useMemo(() => {
    const q = fold(query.trim())
    return (recents ?? []).filter((p) => !q || fold(p.name).includes(q))
  }, [recents, query])

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const cardMenu = (e: React.MouseEvent, p: RecentProject) => {
    e.preventDefault()
    openMenu(
      tidy([
        p.accessible && { label: t('Open'), onSelect: () => void openProject(p.path) },
        p.accessible && { label: t('Show in Folder'), onSelect: () => window.palmier.app.showItemInFolder(p.path) },
        p.accessible && { kind: 'divider' },
        { label: t('Remove from Recents'), onSelect: () => void window.palmier.home.removeRecent(p.path).then(refresh) },
        { label: t('Delete Project'), destructive: true, onSelect: () => setPendingDelete([p]) },
      ]),
      e.clientX,
      e.clientY,
    )
  }

  const hasProjects = (recents?.length ?? 0) > 0
  let grid: ReactNode
  if (recents === null) grid = null
  else if (!hasProjects) grid = <NewProjectCard onCreate={() => openDialog({ kind: 'newProject' })} />
  else if (!visible.length) grid = <div className="pp-home-empty">{t('No projects found')}</div>
  else
    grid = visible.map((p) => (
      <ProjectCard
        key={p.path}
        project={p}
        selectMode={selectMode}
        selected={selected.has(p.path)}
        onActivate={() => (selectMode ? toggle(p.path) : p.accessible ? void openProject(p.path) : undefined)}
        onDelete={() => setPendingDelete([p])}
        onContextMenu={(e) => cardMenu(e, p)}
      />
    ))

  return (
    <div className="pp-home">
      <div className="pp-home-drag drag-region" />
      <aside className="pp-home-sidebar">
        <AppLogo className="pp-home-logo" height={30} />
        <div className="pp-home-rows">
          <SidebarRow icon="plus" label={t('New Project')} onClick={() => openDialog({ kind: 'newProject' })} />
          <SidebarRow icon="folder" label={t('Open Project')} onClick={() => void openProject()} />
        </div>
        <div style={{ flex: 1 }} />
        <div className="pp-home-rows bottom">
          <SidebarRow icon="gearshape" label={t('Settings')} onClick={() => openDialog({ kind: 'settings' })} />
        </div>
      </aside>
      <main className="pp-home-content">
        <h1 className="pp-home-title">{t('Welcome to {app}')}</h1>
        <div className="pp-home-toolbar">
          <span className="pp-home-section">{t('My Projects')}</span>
          <span style={{ flex: 1 }} />
          {hasProjects && (
            <SearchField value={query} onChange={setQuery} expanded={searching} onExpandedChange={setSearching} placeholder={t('Search projects')} tip={t('Search projects')} width={260} size="regular" />
          )}
          {hasProjects &&
            (selectMode ? (
              <>
                <Capsule variant="destructive" disabled={!selected.size} onClick={() => setPendingDelete((recents ?? []).filter((p) => selected.has(p.path)))}>
                  {t('Delete {0}', selected.size)}
                </Capsule>
                <Capsule onClick={exitSelect}>{t('Done')}</Capsule>
              </>
            ) : (
              <Capsule onClick={() => setSelectMode(true)}>{t('Select')}</Capsule>
            ))}
        </div>
        <div className="pp-home-scroll">
          <div className="pp-home-grid">{grid}</div>
        </div>
      </main>
      <FirstRunOverlays />
      {pendingDelete && (
        <DeleteProjectsSheet
          projects={pendingDelete}
          onDone={(deleted) => {
            setPendingDelete(null)
            if (deleted) {
              exitSelect()
              refresh()
            }
          }}
        />
      )}
    </div>
  )
}
