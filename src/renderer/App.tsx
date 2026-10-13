import { useEffect } from 'react'
import { DialogHost } from './dialogs/DialogHost'
import { Editor } from './editor/Editor'
import { handleUiCommand } from './editor/commands'
import { Home } from './home/Home'
import { syncWithSnapshot } from './state/sync'
import { useProject } from './state/project'
import { MenuHost } from './ui/Menu'
import { ToastHost } from './ui/toast'
import { TourHost } from './tour/TourOverlay'

export function App() {
  const projectPath = useProject((s) => s.snapshot?.path ?? null)
  useEffect(() => {
    const offState = window.palmier.project.onState((s) => syncWithSnapshot(s))
    const offCmd = window.palmier.app.onCommand(handleUiCommand)
    void window.palmier.project.get().then((s) => {
      if (s && !useProject.getState().snapshot) syncWithSnapshot(s)
    })
    return () => {
      offState()
      offCmd()
    }
  }, [])
  return (
    <>
      {projectPath ? <Editor /> : <Home />}
      <TourHost />
      <DialogHost />
      <MenuHost />
      <ToastHost />
    </>
  )
}
