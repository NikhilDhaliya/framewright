/** Settings ▸ Skills (spec 05 §11.7, Mac `Settings/Skill/*`): installed + community skills, new, open, install/update, delete. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CommunitySkillView, InstalledSkillView, SkillStatus, SkillsSnapshot } from '../../../shared/skills'
import { STATUS_LABEL } from '../../../shared/skills'
import { Capsule, IconButton } from '../../ui/buttons'
import { Spinner } from '../../ui/controls'
import { Icon, type SFName } from '../../ui/Icon'
import { openMenuBelow } from '../../ui/Menu'
import { ExternalLink } from '../SettingsDialog'
import { SkillDeleteSheet, SkillDetailSheet, type DetailTarget } from './SkillDetailSheet'
import './settings.css'
import { t } from '../../i18n'

type Tab = 'installed' | 'community'
type Row = { id: string; name: string; description: string; status: SkillStatus | 'available'; installed?: InstalledSkillView }

/** Case-insensitive match on name and description (Mac `SkillsPane.matches`). */
export function matchesSkill(row: { name: string; description: string }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

function EmptyState({ icon, title, message, button, onClick }: { icon: SFName; title: string; message?: string; button: string; onClick: () => void }) {
  return (
    <div className="pp-skills-empty">
      <Icon sf={icon} size={22} />
      <div className="pp-skills-empty-title">{title}</div>
      {message && <div className="pp-skills-empty-msg">{message}</div>}
      <Capsule size="regular" onClick={onClick}>
        {button}
      </Capsule>
    </div>
  )
}

export function SkillsPane() {
  const [snap, setSnap] = useState<SkillsSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [detail, setDetail] = useState<DetailTarget | null>(null)
  const [deleting, setDeleting] = useState<InstalledSkillView | null>(null)

  const reload = useCallback(async () => {
    const s = await window.palmier.skills.list()
    setSnap(s)
    return s
  }, [])
  // Mac `onAppear { syncSkills() }`: show what's on disk, then refresh the catalog (auto-installs/updates per the sync rules).
  useEffect(() => {
    let alive = true
    setRefreshing(true)
    void reload()
      .then(() => window.palmier.skills.refresh())
      .then((s) => alive && setSnap(s))
      .finally(() => alive && setRefreshing(false))
    return () => {
      alive = false
    }
  }, [reload])

  const refreshCatalog = async () => {
    setRefreshing(true)
    try {
      setSnap(await window.palmier.skills.refresh())
    } finally {
      setRefreshing(false)
    }
  }
  /** Install: on success switch to Installed and open the skill (Mac). Update: reinstall in place. */
  const install = async (row: Row, open: boolean) => {
    setBusy(row.id)
    const ok = await window.palmier.skills.install(row.id)
    setBusy(null)
    await reload()
    if (ok && open) {
      setTab('installed')
      setQuery('')
      setDetail({ kind: 'skill', id: row.id })
    }
  }
  const newSkill = () => {
    setTab('installed')
    setQuery('')
    setDetail({ kind: 'draft' })
  }

  const installed = snap?.installed ?? []
  const community = snap?.community ?? []
  const rows: Row[] = useMemo(() => {
    const byId = new Map(installed.map((s) => [s.id, s]))
    const list: Row[] = tab === 'installed' ? installed.map((s) => ({ ...s, installed: s })) : community.map((c: CommunitySkillView) => ({ ...c, installed: byId.get(c.id) }))
    return list.filter((r) => matchesSkill(r, query)).sort(byName)
  }, [tab, installed, community, query])

  const menu = (el: Element) =>
    openMenuBelow(el, [
      { label: t('Open Skills Folder'), icon: 'folder', onSelect: () => window.palmier.skills.openFolder() },
      { kind: 'divider' },
      { label: t('Refresh Community Skills'), icon: 'arrow.clockwise', onSelect: () => void refreshCatalog() },
    ], { alignRight: true })

  let empty: ReactNode = null
  if (snap && !rows.length) {
    if (query.trim()) empty = <EmptyState icon="magnifyingglass" title={t('No Matching Skills')} message={t('Try another search.')} button={t('Clear Search')} onClick={() => setQuery('')} />
    else if (tab === 'installed') empty = <EmptyState icon="book.closed" title={t('No Installed Skills')} message={t('Create a skill or browse the Community collection.')} button={t('New Skill')} onClick={newSkill} />
    else if (snap.catalogError) empty = <EmptyState icon="exclamationmark.triangle" title={t('Community Skills Unavailable')} message={snap.catalogError} button={t('Try Again')} onClick={() => void refreshCatalog()} />
    else empty = <EmptyState icon="books.vertical" title={t('No Community Skills')} message={t('Refresh to check for available skills.')} button={t('Refresh')} onClick={() => void refreshCatalog()} />
  }
  const loading = !snap || (tab === 'community' && !community.length && (snap.syncing || refreshing))

  return (
    <div className="pp-skills">
      <p className="pp-set-intro">
        {t('Install skills to give the in-app agent specialized workflows.')} <ExternalLink url="https://github.com/palmier-io/palmier-skills">{t('Browse Community Skills')}</ExternalLink>
      </p>
      <div className="pp-skills-controls">
        <button type="button" className="pp-skills-pill" data-active={tab === 'installed' || undefined} onClick={() => setTab('installed')}>
          {t('Installed')} <span className="pp-skills-count">{installed.length}</span>
        </button>
        <button type="button" className="pp-skills-pill" data-active={tab === 'community' || undefined} onClick={() => setTab('community')}>
          {t('Community')} <span className="pp-skills-count">{community.length}</span>
        </button>
        <span style={{ flex: 1 }} />
        <label className="pp-skills-search">
          <Icon sf="magnifyingglass" size={11} />
          <input value={query} placeholder={t('Search skills')} spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))} />
          {query && (
            <button type="button" className="pp-skills-search-clear" onClick={() => setQuery('')}>
              <Icon sf="xmark.circle.fill" size={11} />
            </button>
          )}
        </label>
        <IconButton sf="plus" size={12} frame={26} tip={t('New skill')} onClick={newSkill} />
        <IconButton sf="ellipsis" size={12} frame={26} tip={t('More')} onClick={(e) => menu(e.currentTarget)} />
      </div>
      <div className="pp-skills-list">
        {loading ? (
          <div className="pp-skills-loading">
            <Spinner size={12} />
            {t('Loading community skills…')}
          </div>
        ) : (
          empty ??
          rows.map((r) => (
            <div key={r.id} className="pp-skills-row hh" data-skill={r.id} onClick={(e) => r.installed && !(e.target as HTMLElement).closest('button') && setDetail({ kind: 'skill', id: r.id })}>
              <span className="pp-skills-icon">
                <Icon sf="book.closed" size={13} />
              </span>
              <div className="pp-skills-text">
                <span className="pp-skills-name ellipsis">{r.name}</span>
                <span className="pp-skills-desc ellipsis">{r.description}</span>
              </div>
              <span className={`pp-skills-status s-${r.status}`}>{busy === r.id ? <Spinner size={11} /> : t(STATUS_LABEL[r.status])}</span>
              <div className="pp-skills-actions">
                {r.status === 'available' ? (
                  <Capsule size="regular" variant="prominent" disabled={busy !== null} onClick={() => void install(r, true)}>
                    {t('Install')}
                  </Capsule>
                ) : r.status === 'update' ? (
                  <Capsule size="regular" className="pp-raised" disabled={busy !== null} onClick={() => void install(r, false)}>
                    {t('Update')}
                  </Capsule>
                ) : (
                  <Capsule size="regular" className="pp-raised" onClick={() => setDetail({ kind: 'skill', id: r.id })}>
                    {t('Open')}
                  </Capsule>
                )}
                {r.installed ? <IconButton sf="trash" size={12} frame={26} tone="tertiary" tip={t('Delete Skill')} onClick={() => setDeleting(r.installed!)} /> : <span style={{ width: 26 }} />}
              </div>
            </div>
          ))
        )}
      </div>
      {detail && snap && (
        <SkillDetailSheet key={detail.kind === 'skill' ? detail.id : 'draft'} target={detail} snapshot={snap} onChanged={reload} onClose={() => setDetail(null)} />
      )}
      {deleting && (
        <SkillDeleteSheet
          skill={deleting}
          onDone={async (deleted) => {
            setDeleting(null)
            if (!deleted) return
            await reload()
          }}
        />
      )}
    </div>
  )
}
