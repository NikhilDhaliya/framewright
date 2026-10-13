/** `Transcription/WordCutPlanner.swift` — frame ranges that remove selected words plus most of their surrounding pauses. */
import { mergeRanges, type FrameRange } from '../timeline'

export type CutAggressiveness = 'tight' | 'balanced' | 'loose'
export const CUT_AGGRESSIVENESS: CutAggressiveness[] = ['tight', 'balanced', 'loose']
export const KEPT_GAP_MS: Record<CutAggressiveness, number> = { tight: 60, balanced: 150, loose: 320 }

export interface PlannedWord {
  startFrame: number
  endFrame: number
  selected: boolean
}

export function cutRanges(wordsIn: PlannedWord[], clipStart: number, clipEnd: number, keepGapFrames: number): FrameRange[] {
  const words = wordsIn.filter((w) => w.endFrame > w.startFrame)
  if (!(clipEnd > clipStart) || !words.length) return []
  const half = Math.max(0, Math.trunc(keepGapFrames / 2))
  const ranges: FrameRange[] = []
  let k = 0
  while (k < words.length) {
    if (!words[k].selected) {
      k++
      continue
    }
    let l = k
    while (l + 1 < words.length && words[l + 1].selected) l++
    const left = k > 0 ? words[k - 1].endFrame : clipStart
    const right = l + 1 < words.length ? words[l + 1].startFrame : clipEnd
    const runStart = words[k].startFrame
    const runEnd = words[l].endFrame
    const keepBefore = Math.min(Math.max(0, runStart - left), half)
    const keepAfter = Math.min(Math.max(0, right - runEnd), half)
    const start = Math.max(clipStart, Math.min(left + keepBefore, runStart))
    const end = Math.min(clipEnd, Math.max(runEnd, right - keepAfter))
    if (end > start) ranges.push({ start, end })
    k = l + 1
  }
  return mergeRanges(ranges)
}
