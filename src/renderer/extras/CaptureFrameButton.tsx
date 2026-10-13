/** Preview transport "Capture Frame to Media" camera button (spec 05 §5.5, 07 §6.4, `captureCurrentFrameToMedia`). */
import { captureToast, type FrameCaptureSource } from '../../shared/extras'
import { editor } from '../state/editor'
import { Icon } from '../ui/Icon'
import { toast } from '../ui/toast'
import { t } from '../i18n'

let busy = false

/** One capture at a time per editor; the destination is the media panel's current folder. */
export async function captureCurrentFrame(source: FrameCaptureSource): Promise<void> {
  if (busy) return
  busy = true
  try {
    const r = await window.palmier.extras.captureFrame(source, editor().mediaFolderId)
    if (r.ok) {
      const t = captureToast(r.name, r.folderRemoved)
      toast(t.message, t.kind)
    } else if (r.error) toast(r.error, 'error')
  } finally {
    busy = false
  }
}

export function CaptureFrameButton({ source }: { source: () => FrameCaptureSource | null }) {
  return (
    <button
      type="button"
      className="pp-iconbtn hh tone-secondary"
      style={{ width: 24, height: 24 }}
      data-tip={t('Capture Frame to Media')}
      data-tour="screenshotButton"
      aria-label={t('Capture Frame to Media')}
      onClick={() => {
        const s = source()
        if (s) void captureCurrentFrame(s)
      }}
    >
      <Icon sf="camera" size={11} />
    </button>
  )
}
