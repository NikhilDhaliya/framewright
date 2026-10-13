import { useState } from 'react'
import type { RecentProject } from '../../shared/api'
import { Capsule } from '../ui/buttons'
import { Sheet } from '../ui/Sheet'
import { toast } from '../ui/toast'
import { SheetFooter, dialogKeys } from '../dialogs/common'
import { t } from '../i18n'

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : t('{0} and {1}', names.slice(0, -1).join(', '), names[names.length - 1]))

/** Confirms moving projects to the Trash; reports which (if any) could not be moved. */
export function DeleteProjectsSheet({ projects, onDone }: { projects: RecentProject[]; onDone: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const single = projects.length === 1
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    const failed: { name: string; error: string }[] = []
    for (const p of projects) {
      const r = await window.palmier.home.trashProject(p.path)
      if (!r.ok) failed.push({ name: p.name, error: r.error })
    }
    if (failed.length) {
      const detail = failed.length === 1 && failed[0].error ? ` ${failed[0].error}` : ''
      toast(`${t('Couldn’t move {0} to the Trash.', listNames(failed.map((f) => `“${f.name}”`)))}${detail}`, 'error')
    }
    onDone(failed.length < projects.length)
  }
  const keys = dialogKeys(() => void confirm())
  return (
    <Sheet width={360} onClose={() => onDone(false)}>
      <div className="pp-dlg-alert" {...keys}>
        <div className="pp-dlg-alert-title">{single ? t('Delete Project?') : t('Delete Selected Projects?')}</div>
        <div className="pp-dlg-alert-text">{single ? t('The project will be moved to the Trash.') : t('The selected projects will be moved to the Trash.')}</div>
        <SheetFooter>
          <Capsule size="regular" onClick={() => onDone(false)}>
            {t('Cancel')}
          </Capsule>
          <Capsule size="regular" variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {t('Delete')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
