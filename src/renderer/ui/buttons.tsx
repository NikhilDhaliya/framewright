import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { Icon, type SFName } from './Icon'

export type Tone = 'primary' | 'secondary' | 'tertiary' | 'muted' | 'accent'

type NativeButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

interface IconButtonProps extends NativeButton {
  sf?: SFName
  size?: number
  /** Square frame side, or [width, height]. */
  frame?: number | [number, number]
  tone?: Tone
  active?: boolean
  tip?: string
  tipAlign?: 'leading' | 'trailing'
  radius?: number
  children?: ReactNode
}

/** Icon button with the HoverHighlight fill (transparent → faint on hover, soft/muted when active). */
export function IconButton({ sf, size = 11, frame = 24, tone = 'secondary', active, tip, tipAlign, radius, className, style, children, ...rest }: IconButtonProps) {
  const [w, h] = typeof frame === 'number' ? [frame, frame] : frame
  const s: CSSProperties = { width: w, height: h, ...(radius !== undefined ? { borderRadius: radius } : null), ...style }
  return (
    <button
      type="button"
      className={`pp-iconbtn hh tone-${tone}${className ? ` ${className}` : ''}`}
      data-active={active || undefined}
      data-tip={tip}
      data-tip-align={tipAlign}
      aria-label={tip}
      aria-pressed={active}
      style={s}
      {...rest}
    >
      {sf ? <Icon sf={sf} size={size} /> : children}
    </button>
  )
}

interface CapsuleProps extends NativeButton {
  variant?: 'secondary' | 'prominent' | 'destructive'
  size?: 'small' | 'regular'
  tip?: string
  children: ReactNode
}

export function Capsule({ variant = 'secondary', size = 'small', tip, className, children, ...rest }: CapsuleProps) {
  return (
    <button type="button" className={`pp-capsule ${variant} ${size}${className ? ` ${className}` : ''}`} data-tip={tip} {...rest}>
      {children}
    </button>
  )
}

export function PrimaryButton({ className, children, ...rest }: NativeButton & { children: ReactNode }) {
  return (
    <button type="button" className={`pp-primary-btn${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </button>
  )
}

export function Divider({ vertical = true }: { vertical?: boolean }) {
  return <span className={vertical ? 'pp-vdivider' : 'pp-hdivider'} />
}
