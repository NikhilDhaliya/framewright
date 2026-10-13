import { create } from 'zustand'
import { Icon } from './Icon'
import { tx } from '../i18n'

export type ToastKind = 'info' | 'success' | 'warning' | 'error' | 'progress'

interface Toast {
  id: number
  message: string
  kind: ToastKind
}

const AUTO_DISMISS_MS = 4000
const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }))
let nextId = 1

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** Shows a toast; progress toasts stay until dismissed with the returned id. English messages from main/core are translated here (`tx`). */
export function toast(text: string, kind: ToastKind = 'info'): number {
  const message = tx(text)
  const id = nextId++
  useToasts.setState((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message), { id, message, kind }].slice(-3) }))
  if (kind !== 'progress') window.setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
  return id
}

let audio: AudioContext | null = null

/** Short system-style alert beep for refused edits. */
export function beep(): void {
  audio ??= new AudioContext()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.frequency.value = 880
  gain.gain.setValueAtTime(0.06, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12)
  osc.connect(gain).connect(audio.destination)
  osc.start()
  osc.stop(audio.currentTime + 0.12)
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  switch (kind) {
    case 'progress':
      return <span className="pp-spinner" />
    case 'success':
      return <Icon sf="checkmark.circle.fill" size={12} style={{ color: 'var(--pp-status-success)' }} />
    case 'warning':
      return <Icon sf="exclamationmark.triangle.fill" size={12} style={{ color: 'var(--pp-timecode)' }} />
    case 'error':
      return <Icon sf="exclamationmark.triangle.fill" size={12} style={{ color: 'var(--pp-status-error)' }} />
    case 'info':
      return null
  }
}

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts)
  return (
    <div className="pp-toasts">
      {toasts.map((t) => (
        <div key={t.id} className="pp-toast" onClick={() => dismissToast(t.id)}>
          <ToastIcon kind={t.kind} />
          <span className="pp-toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  )
}
