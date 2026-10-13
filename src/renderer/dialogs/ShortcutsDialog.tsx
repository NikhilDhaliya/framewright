import { closeDialog } from '../state/dialogs'
import { Capsule } from '../ui/buttons'
import { Sheet } from '../ui/Sheet'
import { SheetFooter, dialogKeys } from './common'
import { t } from '../i18n'

type Group = { title: string; rows: [string, string][] }

const LEFT: Group[] = [
  {
    title: t('Playback'),
    rows: [
      ['Space', t('Play / Pause')],
      ['←', t('Step Backward')],
      ['→', t('Step Forward')],
      ['Shift + ←', t('Skip Backward')],
      ['Shift + →', t('Skip Forward')],
    ],
  },
  {
    title: t('Tools'),
    rows: [
      ['V', t('Selection Tool')],
      ['C', t('Razor Tool')],
      ['T', t('Trim (Slip) Tool')],
    ],
  },
  {
    title: t('Editing'),
    rows: [
      ['A', t('Select Forward on Track')],
      ['Shift + A', t('Select Forward on All Tracks')],
      ['Ctrl + K', t('Split at Playhead')],
      ['[ or Q', t('Trim Start to Playhead')],
      ['] or W', t('Trim End to Playhead')],
      ['Backspace', t('Delete')],
      ['Shift + Backspace', t('Ripple Delete')],
      ['M', t('Add Marker')],
      ['Shift + Drag Edge', t('Ripple Trim')],
      ['Ctrl + Drag Media', t('Ripple Insert')],
      ['Alt + Drag', t('Duplicate Clip (also Ctrl + Shift + Drag)')],
      ['Alt + Click', t('Act on One Clip, Ignoring Links (also Ctrl + Shift + Click)')],
      ['Ctrl + Click Audio', t('Add Volume Keyframe')],
      ['Alt + Drag Marker', t('Change Marker Duration (also Ctrl + Shift + Drag)')],
    ],
  },
  {
    title: t('Timeline'),
    rows: [
      ['Shift + Drag Ruler', t('Select Range')],
      ['Drag Range Edge', t('Adjust Range')],
      ['I', t('Mark Range Start')],
      ['O', t('Mark Range End')],
      ['Alt + Scroll', t('Zoom to Cursor')],
      ['Ctrl + Scroll', t('Zoom to Cursor (Pinch)')],
      ['Shift + Scroll', t('Scroll Horizontally')],
      ['Tab / Shift + Tab', t('Next / Previous Timeline')],
    ],
  },
]

const RIGHT: Group[] = [
  {
    title: t('File'),
    rows: [
      ['Ctrl + N', t('New')],
      ['Ctrl + Shift + N', t('New Folder')],
      ['Ctrl + O', t('Open')],
      ['Ctrl + S', t('Save')],
      ['Ctrl + Shift + S', t('Save As')],
      ['Ctrl + I', t('Import Media')],
      ['Ctrl + E', t('Export')],
    ],
  },
  {
    title: t('Edit'),
    rows: [
      ['Ctrl + Z', t('Undo')],
      ['Ctrl + Shift + Z', t('Redo')],
      ['Ctrl + X', t('Cut')],
      ['Ctrl + C', t('Copy')],
      ['Ctrl + V', t('Paste')],
      ['Ctrl + A', t('Select All')],
    ],
  },
  {
    title: t('View'),
    rows: [
      ['F11', t('Full Screen')],
      ['`', t('Maximize Focused Panel')],
      ['Ctrl + Scroll', t('Zoom Preview to Cursor')],
      ['Esc', t('Deselect & Reset Tool')],
      ['Ctrl + 0', t('Toggle Media Panel')],
      ['Ctrl + Alt + 0', t('Toggle Inspector Panel')],
      ['Ctrl + 1 / 2 / 3', t('Default / Media / Vertical Layout')],
    ],
  },
  {
    title: t('Preview'),
    rows: [
      ['Tab / Shift + Tab', t('Next / Previous Preview Tab')],
      ['Enter or Esc', t('Finish Crop Editing')],
    ],
  },
  {
    title: t('Media'),
    rows: [
      ['Arrow Keys', t('Move Selection')],
      ['Alt + ↑', t('Go to Parent Folder')],
      ['Enter', t('Open Folder')],
      ['Ctrl + K', t('Search Media')],
    ],
  },
  {
    title: t('App'),
    rows: [
      ['Ctrl + ,', t('Settings')],
      ['Ctrl + Shift + /', t('Keyboard Shortcuts')],
      ['Ctrl + Q', t('Quit')],
    ],
  },
]

function Column({ groups }: { groups: Group[] }) {
  return (
    <div className="pp-keys-col">
      {groups.map((g) => (
        <div key={g.title} className="pp-keys-group">
          <div className="pp-keys-title">{g.title}</div>
          {g.rows.map(([k, d]) => (
            <div key={k + d} className="pp-keys-row">
              <span className="pp-keys-key mono">{k}</span>
              <span className="pp-keys-desc">{d}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function ShortcutsDialog() {
  return (
    <Sheet width={760} onClose={closeDialog}>
      <div className="pp-dlg pp-keys" {...dialogKeys(closeDialog)}>
        <div className="pp-dlg-header">
          <span className="pp-dlg-title-lg">{t('Keyboard Shortcuts')}</span>
        </div>
        <div className="pp-keys-scroll">
          <Column groups={LEFT} />
          <Column groups={RIGHT} />
        </div>
        <SheetFooter>
          <Capsule size="regular" variant="prominent" onClick={closeDialog}>
            {t('Done')}
          </Capsule>
        </SheetFooter>
      </div>
    </Sheet>
  )
}
