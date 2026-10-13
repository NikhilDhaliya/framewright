import { create } from 'zustand'

export type SettingsPane = 'general' | 'appearance' | 'keys' | 'mcp' | 'skills' | 'storage'

export interface SettingsSuggestion {
  fps: number
  width: number
  height: number
}

export type Dialog =
  | { kind: 'export' }
  | { kind: 'settings'; pane?: SettingsPane }
  | { kind: 'shortcuts' }
  | { kind: 'mcp' }
  | { kind: 'about' }
  | { kind: 'feedback'; screenshot: string | null }
  | { kind: 'newProject' }
  | { kind: 'customAspect' }
  | { kind: 'mismatch'; suggestion: SettingsSuggestion; resolve: (change: boolean | null) => void }

export const useDialogs = create<{ dialog: Dialog | null }>(() => ({ dialog: null }))

export const openDialog = (dialog: Dialog) => useDialogs.setState({ dialog })
export const closeDialog = () => useDialogs.setState({ dialog: null })

/** Asks whether to adopt the clip's settings; resolves true (change), false (keep) or null (cancelled). */
export function askSettingsMismatch(suggestion: SettingsSuggestion): Promise<boolean | null> {
  return new Promise((resolve) =>
    openDialog({
      kind: 'mismatch',
      suggestion,
      resolve: (change) => {
        closeDialog()
        resolve(change)
      },
    }),
  )
}
