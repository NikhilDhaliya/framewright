import { useState } from 'react'
import { useDoc } from '../state/project'
import { runOp } from '../state/ops'
import { IconButton } from '../ui/buttons'
import { InlineRename } from '../ui/controls'
import { openMenu, openMenuBelow } from '../ui/Menu'
import { DocTab, PanelHeader, TabStrip } from '../ui/panels'
import { activateTimeline } from './tabs'
import { t } from '../i18n'

async function closeOthers(keep: string, open: string[]): Promise<void> {
  await runOp('activateTimeline', { id: keep }, { quiet: true })
  for (const id of open) if (id !== keep) await runOp('closeTimelineTab', { id }, { quiet: true })
}

async function showAll(ids: string[], active: string): Promise<void> {
  for (const id of ids) await runOp('activateTimeline', { id }, { quiet: true })
  await runOp('activateTimeline', { id: active }, { quiet: true })
}

export function TimelineTabBar() {
  const doc = useDoc()
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!doc) return null
  const timelines = doc.file.timelines
  const active = doc.file.activeTimelineId ?? timelines[0]?.id
  const open = (doc.file.openTimelineIds ?? []).filter((id) => timelines.some((t) => t.id === id))
  if (active && !open.includes(active)) open.push(active)
  const many = open.length > 1

  const menuFor = (id: string): Parameters<typeof openMenu>[0] => [
    { label: t('Rename'), onSelect: () => setRenaming(id) },
    { label: t('Duplicate'), onSelect: () => void runOp('duplicateTimeline', { id }) },
    { kind: 'divider' },
    { label: t('Close Tab'), disabled: !many, onSelect: () => void runOp('closeTimelineTab', { id }, { quiet: true }) },
    { label: t('Close Other Tabs'), disabled: !many, onSelect: () => void closeOthers(id, open) },
    { kind: 'divider' },
    { label: t('Delete Timeline'), destructive: true, disabled: timelines.length <= 1, onSelect: () => void runOp('deleteTimeline', { id }) },
  ]

  return (
    <PanelHeader className="pp-tl-tabbar">
      <TabStrip style={{ paddingRight: 6 }}>
        {open.map((id) => {
          const t = timelines.find((x) => x.id === id)!
          return (
            <DocTab
              key={id}
              label={t.name}
              active={id === active}
              closeable={many && renaming !== id}
              onSelect={() => activateTimeline(id)}
              onClose={() => void runOp('closeTimelineTab', { id }, { quiet: true })}
              onDoubleClick={() => setRenaming(id)}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(menuFor(id), e.clientX, e.clientY)
              }}
            >
              {renaming === id ? (
                <InlineRename
                  value={t.name}
                  className="pp-tl-tab-rename"
                  onCommit={(name) => {
                    setRenaming(null)
                    void runOp('renameTimeline', { id, name })
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : undefined}
            </DocTab>
          )
        })}
      </TabStrip>
      <IconButton sf="plus" size={11} frame={[18, 22]} tip={t('New timeline')} onClick={() => void runOp('createTimeline', {})} />
      <IconButton
        sf="ellipsis"
        size={13}
        tip={t('More')}
        onClick={(e) =>
          openMenuBelow(e.currentTarget, [
            { label: t('Show All Tabs'), disabled: open.length >= timelines.length, onSelect: () => void showAll(timelines.map((t) => t.id), active!) },
            { label: t('Close All Tabs'), disabled: !many, onSelect: () => void closeOthers(active!, open) },
          ], { alignRight: true })
        }
      />
    </PanelHeader>
  )
}
