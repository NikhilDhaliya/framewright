import type { ReactNode } from 'react'
import { focusPanel, useEditor, type PanelId } from '../state/editor'

/** Panel chrome: surface background plus the animated focus ring; mouse-down focuses the panel. */
export function PanelHost({ id, children }: { id: PanelId; children: ReactNode }) {
  const focused = useEditor((s) => s.focusedPanel === id)
  return (
    <div className="pp-panel" data-panel={id} onPointerDownCapture={() => focusPanel(id)}>
      {children}
      <div className={`pp-panel-ring${focused ? ' on' : ''}`} />
    </div>
  )
}
