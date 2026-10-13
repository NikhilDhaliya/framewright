import { useDialogs } from '../state/dialogs'
import { ExportDialog } from './ExportDialog'
import { FeedbackDialog } from './FeedbackDialog'
import { McpDialog } from './McpDialog'
import { SettingsDialog } from './SettingsDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { AboutDialog, CustomAspectDialog, MismatchDialog, NewProjectDialog } from './SmallDialogs'
import './dialogs.css'

export function DialogHost() {
  const dialog = useDialogs((s) => s.dialog)
  if (!dialog) return null
  switch (dialog.kind) {
    case 'export':
      return <ExportDialog />
    case 'settings':
      return <SettingsDialog key={dialog.pane ?? 'general'} pane={dialog.pane} />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'mcp':
      return <McpDialog />
    case 'feedback':
      return <FeedbackDialog screenshot={dialog.screenshot} />
    case 'about':
      return <AboutDialog />
    case 'newProject':
      return <NewProjectDialog />
    case 'customAspect':
      return <CustomAspectDialog />
    case 'mismatch':
      return <MismatchDialog suggestion={dialog.suggestion} resolve={dialog.resolve} />
  }
}
