/** Settings ▸ Skills detail sheet, delete confirmation and "Add to External Agent" (spec 05 §11.7, Mac `SkillDetailSheet.swift`). */
import { useEffect, useRef, useState } from 'react'
import type { ExternalAgent, InstalledSkillView, SkillsSnapshot } from '../../../shared/skills'
import { EXTERNAL_AGENT_LABEL, NEW_SKILL_TEMPLATE, STATUS_LABEL } from '../../../shared/skills'
import { MarkdownText } from '../../agent/Markdown'
import { Capsule, IconButton } from '../../ui/buttons'
import { Spinner } from '../../ui/controls'
import { Icon } from '../../ui/Icon'
import { openMenuBelow } from '../../ui/Menu'
import { Sheet } from '../../ui/Sheet'
import { SheetFooter, dialogKeys } from '../common'
import './settings.css'
import { t } from '../../i18n'

export type DetailTarget = { kind: 'skill'; id: string } | { kind: 'draft' }

const AGENTS: ExternalAgent[] = ['claude', 'codex', 'cursor']
const TOAST_MS = 5000
const SAVE_ERROR = t('Add nonempty name and description fields to the skill frontmatter.')

type Exit = 'close' | 'preview'

/** Splits SKILL.md into its frontmatter fields and body (renderer copy of the main parser, display only). */
export function splitSkill(raw: string): { name: string; description: string; body: string } {
  const lines = raw.split('\n')
  const fields: Record<string, string> = {}
  if (lines[0]?.trim() !== '---') return { name: '', description: '', body: raw }
  let i = 1
  for (; i < lines.length && lines[i].trim() !== '---'; i++) {
    const c = lines[i].indexOf(':')
    if (c < 0) continue
    let v = lines[i].slice(c + 1).trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    fields[lines[i].slice(0, c).trim()] = v
  }
  return { name: fields.name ?? '', description: fields.description ?? '', body: lines.slice(i + 1).join('\n').trim() }
}

/** Replaces (or inserts) one frontmatter field (Mac `SkillFrontmatter.replacingFields`). */
export function replaceSkillField(raw: string, key: string, value: string): string {
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') return raw
  let i = 1
  for (; i < lines.length && lines[i].trim() !== '---'; i++) {
    const c = lines[i].indexOf(':')
    if (c >= 0 && lines[i].slice(0, c).trim() === key) {
      lines[i] = `${key}: ${value}`
      return lines.join('\n')
    }
  }
  if (i >= lines.length) return raw
  lines.splice(i, 0, `${key}: ${value}`)
  return lines.join('\n')
}

interface DetailProps {
  target: DetailTarget
  snapshot: SkillsSnapshot
  onChanged: () => Promise<unknown>
  onClose: () => void
}

export function SkillDetailSheet({ target, snapshot, onChanged, onClose }: DetailProps) {
  const [skillId, setSkillId] = useState<string | null>(target.kind === 'skill' ? target.id : null)
  const isDraft = skillId === null
  const skill = skillId ? snapshot.installed.find((s) => s.id === skillId) : undefined
  const [editing, setEditing] = useState(isDraft)
  const [draft, setDraft] = useState(isDraft ? NEW_SKILL_TEMPLATE : '')
  const [original, setOriginal] = useState(isDraft ? NEW_SKILL_TEMPLATE : '')
  const [viewRaw, setViewRaw] = useState<string | null>(null)
  const [titleEditing, setTitleEditing] = useState(isDraft)
  const [titleDraft, setTitleDraft] = useState(isDraft ? splitSkill(NEW_SKILL_TEMPLATE).name : '')
  const [saving, setSaving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [saveError, setSaveError] = useState<{ exit: Exit | null } | null>(null)
  const [deleting, setDeleting] = useState<InstalledSkillView | null>(null)
  const [added, setAdded] = useState<{ agent: ExternalAgent; path: string; displayPath: string } | null>(null)
  const toastTimer = useRef(0)
  const titleRef = useRef<HTMLInputElement>(null)

  // View mode renders the file on disk; refetch whenever the store changes it (rename, update, save).
  useEffect(() => {
    if (!skillId) return
    let alive = true
    void window.palmier.skills.read(skillId).then((text) => alive && setViewRaw(text))
    return () => {
      alive = false
    }
  }, [skillId, skill?.name, skill?.description, skill?.status, original])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  useEffect(() => {
    if (titleEditing) requestAnimationFrame(() => titleRef.current?.focus())
  }, [titleEditing])

  const dirty = editing && draft !== original
  const draftName = splitSkill(draft).name.trim() || t('New skill')
  const title = editing || isDraft ? draftName : (skill?.name ?? draftName)
  const state = skill?.status

  /** Mac `commitTitle`: in edit mode (or a draft) the name goes into the text; otherwise the skill is renamed. */
  const commitTitle = async (): Promise<string> => {
    if (!titleEditing) return draft
    setTitleEditing(false)
    const name = titleDraft.trim()
    if (!name) return draft
    if (isDraft || editing) {
      const next = replaceSkillField(draft, 'name', name)
      setDraft(next)
      return next
    }
    if (skill && name !== skill.name && skillId) {
      await window.palmier.skills.rename(skillId, name)
      await onChanged()
    }
    return draft
  }
  const beginTitle = (value: string) => {
    setTitleDraft(value)
    setTitleEditing(true)
  }
  const cancelTitle = () => {
    setTitleEditing(false)
    setTitleDraft(skill?.name ?? draftName)
  }

  /** Saves a dirty edit; on failure shows the Mac alert (with Discard Changes when leaving). */
  const commitDraft = async (text: string, exit: Exit | null): Promise<boolean> => {
    if (!skillId || text === original) return true
    const r = await window.palmier.skills.save(skillId, text)
    if (!r.ok) {
      setSaveError({ exit })
      return false
    }
    setOriginal(text)
    await onChanged()
    return true
  }
  const finish = async (exit: Exit) => {
    if (!skill) return onClose()
    const text = await commitTitle()
    if (!(await commitDraft(text, exit))) return
    if (exit === 'close') onClose()
    else setEditing(false)
  }
  const close = () => {
    if (saving) return
    if (isDraft) return onClose()
    void finish('close')
  }
  const beginEditing = async () => {
    if (editing || !skillId) return
    await commitTitle()
    const raw = (await window.palmier.skills.read(skillId)) ?? ''
    setDraft(raw)
    setOriginal(raw)
    setEditing(true)
  }
  const saveDraft = async () => {
    if (saving) return
    setSaving(true)
    const text = await commitTitle()
    const r = await window.palmier.skills.create(text)
    setSaving(false)
    if (!r.ok) return setSaveError({ exit: null })
    setOriginal(text)
    setSkillId(r.id)
    await onChanged()
  }
  const saveChanges = async () => {
    const text = await commitTitle()
    await commitDraft(text, null)
  }
  const update = async () => {
    if (editing || !skillId) return
    setUpdating(true)
    await window.palmier.skills.install(skillId)
    setUpdating(false)
    await onChanged()
  }
  const addTo = async (agent: ExternalAgent) => {
    if (!skillId) return
    const r = await window.palmier.skills.addToExternal(skillId, agent)
    if (!r.ok) return
    setAdded({ agent, path: r.path, displayPath: r.displayPath })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setAdded(null), TOAST_MS)
  }
  const discardChanges = () => {
    const exit = saveError?.exit
    setSaveError(null)
    if (!exit) return
    setDraft(original)
    if (exit === 'close') onClose()
    else setEditing(false)
  }
  // Ctrl+S anywhere in the sheet (Mac `.keyboardShortcut("s")` on Save / Save Changes).
  const saveKey = useRef<() => void>(() => undefined)
  saveKey.current = () => {
    if (isDraft) void saveDraft()
    else if (dirty) void saveChanges()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's' || saveErrorRef.current) return
      e.preventDefault()
      e.stopPropagation()
      saveKey.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const saveErrorRef = useRef(saveError)
  saveErrorRef.current = saveError

  const view = splitSkill(viewRaw ?? '')
  return (
    <Sheet width={720} onClose={titleEditing ? cancelTitle : close} className="pp-skill-sheet">
      {!isDraft && !skill ? (
        <div className="pp-skill-detail">
          <div className="pp-skill-head">
            <span style={{ flex: 1 }} />
            <IconButton sf="xmark" size={12} frame={26} tone="tertiary" tip={t('Close')} onClick={onClose} />
          </div>
          <div className="pp-skills-empty">{t('Skill unavailable.')}</div>
        </div>
      ) : (
        <div className="pp-skill-detail">
          <div className="pp-skill-head">
            {titleEditing ? (
              <input
                ref={titleRef}
                className="pp-skill-rename"
                value={titleDraft}
                placeholder={t('Skill name')}
                spellCheck={false}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitTitle()
                }}
                onBlur={() => void commitTitle()}
              />
            ) : (
              <button type="button" className="pp-skill-title ellipsis" data-tip={t('Rename Skill')} onClick={() => beginTitle(title)}>
                {title}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <IconButton sf="xmark" size={12} frame={26} tone="tertiary" tip={t('Close')} disabled={saving} onClick={close} />
          </div>
          <div className="pp-skill-toolbar">
            {skill && <span className={`pp-skill-status s-${state}`}>{t(STATUS_LABEL[state ?? 'local'])}</span>}
            <span style={{ flex: 1 }} />
            {isDraft ? (
              saving ? (
                <Spinner size={12} />
              ) : (
                <Capsule size="regular" variant="prominent" tip={t('Ctrl+S')} onClick={() => void saveDraft()}>
                  {t('Save')}
                </Capsule>
              )
            ) : (
              <>
                {state === 'update' && !editing && (updating ? <Spinner size={12} /> : <Capsule size="regular" className="pp-raised" onClick={() => void update()}>{t('Update')}</Capsule>)}
                <Capsule
                  size="regular"
                  className="pp-raised"
                  disabled={editing}
                  tip={t('Add this skill to an external agent')}
                  onClick={(e) =>
                    openMenuBelow(
                      e.currentTarget,
                      AGENTS.map((a) => ({ label: t('Add to {0}', EXTERNAL_AGENT_LABEL[a]), onSelect: () => void addTo(a) })),
                      { minWidth: 168 },
                    )
                  }
                >
                  {t('Add to External Agent')} <Icon sf="chevron.down" size={9} />
                </Capsule>
                {dirty && (
                  <Capsule size="regular" variant="prominent" tip={t('Ctrl+S')} onClick={() => void saveChanges()}>
                    {t('Save Changes')}
                  </Capsule>
                )}
                <Capsule size="regular" className="pp-raised" onClick={() => void (editing ? finish('preview') : beginEditing())}>
                  {editing ? t('Preview') : t('Edit')}
                </Capsule>
                <IconButton
                  sf="ellipsis"
                  size={12}
                  frame={26}
                  tip={t('More skill actions')}
                  onClick={(e) =>
                    openMenuBelow(
                      e.currentTarget,
                      [
                        { label: t('Rename Skill'), icon: 'pencil', onSelect: () => skill && beginTitle(editing ? draftName : skill.name) },
                        { label: t('Show in Folder'), icon: 'folder', onSelect: () => skillId && window.palmier.skills.showInFolder(skillId) },
                        { kind: 'divider' },
                        { label: t('Delete Skill'), icon: 'trash', destructive: true, onSelect: () => skill && setDeleting(skill) },
                      ],
                      { alignRight: true },
                    )
                  }
                />
              </>
            )}
          </div>
          <div className="pp-skill-body">
            {editing ? (
              <textarea className="pp-skill-editor mono" value={draft} spellCheck={false} disabled={saving} aria-label={t('Skill instructions')} onChange={(e) => setDraft(e.target.value)} />
            ) : (
              <div className="pp-skill-view">
                <div className="pp-skill-view-label">{t('Description')}</div>
                <div className="pp-skill-view-desc">{skill?.description ?? view.description}</div>
                <div className="pp-skill-view-divider" />
                <div className="pp-skill-view-label">{t('Instructions')}</div>
                <div className="pp-skill-md">
                  <MarkdownText text={view.body} />
                </div>
              </div>
            )}
          </div>
          {added && (
            <div className="pp-skill-toast" role="status">
              <Icon sf="checkmark.circle.fill" size={12} className="pp-skill-toast-icon" />
              <div className="pp-skill-toast-text">
                <div className="pp-skill-toast-title">{t('Added to {0}', EXTERNAL_AGENT_LABEL[added.agent])}</div>
                <div className="pp-skill-toast-path ellipsis">{added.displayPath}</div>
              </div>
              <Capsule
                size="small"
                onClick={() => {
                  window.palmier.app.showItemInFolder(added.path)
                  setAdded(null)
                }}
              >
                {t('Open')}
              </Capsule>
            </div>
          )}
        </div>
      )}
      {saveError && (
        <Sheet width={380} onClose={() => setSaveError(null)}>
          <div className="pp-dlg-alert" {...dialogKeys(() => setSaveError(null))}>
            <div className="pp-dlg-alert-title">{t('Unable to save skill')}</div>
            <div className="pp-dlg-alert-text">{SAVE_ERROR}</div>
            <SheetFooter>
              {saveError.exit && (
                <Capsule size="regular" variant="destructive" onClick={discardChanges}>
                  {t('Discard Changes')}
                </Capsule>
              )}
              <Capsule size="regular" variant="prominent" onClick={() => setSaveError(null)}>
                {t('Keep Editing')}
              </Capsule>
            </SheetFooter>
          </div>
        </Sheet>
      )}
      {deleting && (
        <SkillDeleteSheet
          skill={deleting}
          onDone={async (deleted) => {
            setDeleting(null)
            if (!deleted) return
            await onChanged()
            onClose()
          }}
        />
      )}
    </Sheet>
  )
}

export function SkillDeleteSheet({ skill, onDone }: { skill: InstalledSkillView; onDone: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    onDone(await window.palmier.skills.delete(skill.id))
  }
  return (
    <Sheet width={380} onClose={() => onDone(false)}>
      <div className="pp-dlg-alert" {...dialogKeys(() => onDone(false))}>
        <div className="pp-dlg-alert-title">{t('Delete “{0}”?', skill.name)}</div>
        <div className="pp-dlg-alert-text">{t('This permanently removes {0}.', skill.displayDir)}</div>
        <SheetFooter>
          <Capsule size="regular" onClick={() => onDone(false)}>
            {t('Keep Skill')}
          </Capsule>
          <Capsule size="regular" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {t('Delete “{0}”', skill.name)}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
