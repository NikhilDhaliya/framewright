import type { ReactNode } from 'react'
import { isMenuOpen } from '../ui/Menu'

/** Enter triggers the default action (outside multi-line fields); Esc is handled by the Sheet. */
export function dialogKeys(onEnter: (() => void) | null) {
  return {
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' || !onEnter || isMenuOpen() || e.nativeEvent.isComposing) return
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      onEnter()
    },
  }
}

export function SheetFooter({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return (
    <div className="pp-dlg-footer">
      {leading}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  )
}

export function FormRow({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="pp-dlg-formrow" data-tip={hint}>
      <span className="pp-dlg-formrow-label">{label}</span>
      <div className="pp-dlg-formrow-control">{children}</div>
    </div>
  )
}

/** Copies text and reports success so callers can flash a checkmark. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
