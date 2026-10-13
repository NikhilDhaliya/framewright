import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface SheetProps {
  onClose?: () => void
  width?: number
  className?: string
  style?: CSSProperties
  children: ReactNode
}

/** In-window modal sheet over a dimmed backdrop; Esc dismisses when `onClose` is given. */
export function Sheet({ onClose, width, className, style, children }: SheetProps) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const backdropRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !closeRef.current || document.querySelector('.pp-menu-backdrop, .pp-popover')) return
      // Only the topmost sheet closes (a sheet opened from another sheet, e.g. Settings ▸ Skills detail).
      const sheets = document.querySelectorAll('.pp-sheet-backdrop')
      if (backdropRef.current && sheets[sheets.length - 1] !== backdropRef.current) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return createPortal(
    <div ref={backdropRef} className="pp-sheet-backdrop" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className={`pp-sheet${className ? ` ${className}` : ''}`} style={{ width, ...style }} role="dialog">
        {children}
      </div>
    </div>,
    document.body,
  )
}
