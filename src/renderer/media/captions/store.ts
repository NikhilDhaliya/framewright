/** Captions tab form state and the caption preview configuration — session only, never persisted (spec 07 §0.5). */
import { create } from 'zustand'
import type { RGBA, TextAnimationPreset, TextStyle } from '@core/model'
import { CAPTION_DEFAULT_CENTER, CAPTION_DEFAULT_GAP_SECONDS, captionTextStyle } from '@core/captions/specBuilder'
import type { TranscriptionProgress } from '../../../shared/api'
import { t } from '../../i18n'

export const DEFAULT_HIGHLIGHT: RGBA = { r: 1, g: 0.85, b: 0, a: 1 }
export const PREVIEW_TEXT = t('Captions will look like this')

export interface CaptionForm {
  /** `editor.captionPreviewEnabled`: default true, turned off after a successful generation. */
  previewEnabled: boolean
  /** Track chosen in the Source menu; null = Auto / remembered selection. */
  trackId: string | null
  /** Caption targets of the remembered clip selection. */
  selectedTargets: string[]
  /** Linux default: Local (the Mac defaults to Cloud). */
  provider: 'local' | 'cloud'
  /** whisper language code, null = Auto. */
  locale: string | null
  maxWords: number | null
  maxCharacters: number | null
  gapSeconds: number
  censor: boolean
  style: TextStyle
  center: { x: number; y: number }
  preset: TextAnimationPreset
  highlight: RGBA
}

export const initialCaptionForm = (): CaptionForm => ({
  previewEnabled: true,
  trackId: null,
  selectedTargets: [],
  provider: 'local',
  locale: null,
  maxWords: null,
  maxCharacters: null,
  gapSeconds: CAPTION_DEFAULT_GAP_SECONDS,
  censor: false,
  style: captionTextStyle(),
  center: { ...CAPTION_DEFAULT_CENTER },
  preset: 'none',
  highlight: DEFAULT_HIGHLIGHT,
})

export const useCaptionForm = create<CaptionForm>(initialCaptionForm)
export const captionForm = () => useCaptionForm.getState()
export const setCaptionForm = (patch: Partial<CaptionForm>) => useCaptionForm.setState(patch)

/** Job state shared by both Captions tab instances (Captions and the Index empty state). */
export interface CaptionJob {
  generating: boolean
  progress: TranscriptionProgress | null
  note: string | null
  cancel: (() => void) | null
}

export const useCaptionJob = create<CaptionJob>(() => ({ generating: false, progress: null, note: null, cancel: null }))

/** Whether the Captions tab is currently showing (drives the preview overlay). */
export const useCaptionsVisible = create<{ visible: boolean }>(() => ({ visible: false }))

/** Overlay label: "Downloading speech model NN%" (Linux addition) then t('Transcribing…'). */
export function overlayLabel(p: TranscriptionProgress | null): string {
  if (p?.phase === 'downloading') return t('Downloading speech model {0}%', Math.round(p.fraction * 100))
  return t('Transcribing…')
}
