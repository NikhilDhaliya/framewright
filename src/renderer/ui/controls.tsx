import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type SFName } from './Icon'
import { openMenuBelow, type MenuItem } from './Menu'
import { t } from '../i18n'

export function Switch({ on, onChange, disabled, tip }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; tip?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`pp-switch${on ? ' on' : ''}`}
      disabled={disabled}
      data-tip={tip}
      onClick={() => onChange(!on)}
    >
      <span className="pp-switch-knob" />
    </button>
  )
}

export function Checkbox({ checked, onChange, disabled, tip, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; tip?: string; label?: string }) {
  return (
    <label className={`pp-checkbox-row${disabled ? ' disabled' : ''}`} data-tip={tip}>
      <button type="button" role="checkbox" aria-checked={checked} className={`pp-checkbox${checked ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
        {checked && <Icon sf="checkmark" size={8} strokeWidth={3} />}
      </button>
      {label && <span>{label}</span>}
    </label>
  )
}

export interface SegmentOption<T> {
  value: T
  label?: string
  icon?: SFName
  tip?: string
}

export function Segmented<T extends string | number>({ options, value, onChange, full, className }: { options: SegmentOption<T>[]; value: T | null; onChange: (v: T) => void; full?: boolean; className?: string }) {
  return (
    <div className={`pp-segmented${full ? ' full' : ''}${className ? ` ${className}` : ''}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={`pp-segment${o.value === value ? ' on' : ''}`} data-tip={o.tip} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon sf={o.icon} size={11} /> : o.label}
        </button>
      ))}
    </div>
  )
}

/** "juicym…936_3"-style truncation that keeps the end of the name visible. */
export function MiddleTruncate({ text, tail = 6, className, style }: { text: string; tail?: number; className?: string; style?: CSSProperties }) {
  const cut = text.length > tail * 2 ? text.length - tail : text.length
  return (
    <span className={`pp-mtrunc${className ? ` ${className}` : ''}`} style={style} dir="auto">
      <span className="pp-mtrunc-head">{text.slice(0, cut)}</span>
      {cut < text.length && <span className="pp-mtrunc-tail">{text.slice(cut)}</span>}
    </span>
  )
}

/** Pop-up value box (EditorMenuValue): value text + chevron in a value-field frame. */
export function MenuValue({ text, items, width, disabled, tip, minWidth }: { text: string; items: () => MenuItem[]; width?: number | string; disabled?: boolean; tip?: string; minWidth?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      className="pp-value-field pp-menu-value"
      data-active={open || undefined}
      disabled={disabled}
      style={{ width }}
      data-tip={tip}
      onClick={(e) => {
        setOpen(true)
        openMenuBelow(e.currentTarget, items(), { minWidth: minWidth ?? e.currentTarget.offsetWidth, onClose: () => setOpen(false) })
      }}
    >
      <MiddleTruncate text={text} />
      <Icon sf="chevron.down" size={9} strokeWidth={2.5} className="tone-tertiary" />
    </button>
  )
}

interface InlineRenameProps {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
  className?: string
  placeholder?: string
  maxLength?: number
  allowEmpty?: boolean
  style?: CSSProperties
}

/** Autofocused rename field: Enter/blur commits, Esc cancels; unchanged or empty input cancels. */
export function InlineRename({ value, onCommit, onCancel, className, placeholder, maxLength, allowEmpty, style }: InlineRenameProps) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const [text, setText] = useState(value)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const t = text.trim()
    if (commit && t !== value.trim() && (t || allowEmpty)) onCommit(t)
    else onCancel()
  }
  return (
    <input
      ref={ref}
      className={`pp-inline-rename${className ? ` ${className}` : ''}`}
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      spellCheck={false}
      style={style}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="pp-spinner" style={{ width: size, height: size }} />
}

export function Row({ label, children, reset, tip, gutter }: { label: string; children: ReactNode; reset?: () => void; tip?: string; gutter?: boolean }) {
  return (
    <div className="pp-row" data-tip={tip}>
      <span className="pp-row-label ellipsis">{label}</span>
      <div className="pp-row-control">
        {children}
        {gutter && <span className="pp-kf-gutter" />}
      </div>
      {reset && (
        <button type="button" className="pp-iconbtn hh tone-tertiary pp-reset" style={{ width: 22, height: 22 }} data-tip={t('Reset: {0}', label)} onClick={reset}>
          <Icon sf="arrow.counterclockwise" size={11} />
        </button>
      )}
    </div>
  )
}
