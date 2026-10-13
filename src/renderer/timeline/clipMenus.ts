/**
 * Timeline clip / range context-menu sections (05 §6.14): Paste Settings, Decompose Nested Timeline,
 * the Multicam group (Switch Angle/Mic ▸, Layout ▸, Ungroup Multicam), Switch Angle in Range ▸,
 * and Swap Media (arms the media panel's swap mode).
 */
import { endFrame } from '@core/clip'
import type { Clip, MulticamSource, Timeline } from '@core/model'
import type { ClipboardEntry } from '@core/ops/clips'
import type { Doc } from '@core/ops/context'
import type { VideoLayout } from '@core/ops/layout'
import { angleMembers, groupsInRange, isProgramFragment, memberOfClip, micMembers, multicamGroup, programRows, programTrackIndex } from '@core/ops/multicam'
import { decomposeTargets } from '@core/ops/nest'
import type { TextBox } from '@core/ops/project'
import { defaultTextStyle } from '@core/model'
import { expandToLinkGroup } from '@core/timeline'
import { textMeasurer } from '../render/text'
import { editor, selectClips } from '../state/editor'
import { runOp } from '../state/ops'
import { toast } from '../ui/toast'
import { beginMediaSwap } from '../media/swap'
import type { MenuItem } from '../ui/Menu'
import { t, tk } from '../i18n'

// ---------- Paste Settings (03 §4.15) ----------

/** The single clipboard clip of `type`, or null when there are none or several. */
export function copiedClipSettings(clipboard: ClipboardEntry[], type: Clip['mediaType']): Clip | null {
  const of = clipboard.filter((e) => e.clip.mediaType === type)
  return of.length === 1 ? of[0].clip : null
}

export async function pasteSettings(tl: Timeline, source: Clip, targetIds: string[]): Promise<void> {
  const boxes: Record<string, TextBox> = {}
  if (source.mediaType === 'text') {
    const style = source.textStyle ?? defaultTextStyle()
    for (const id of targetIds) {
      const c = tl.tracks.flatMap((tr) => tr.clips).find((x) => x.id === id)
      boxes[id] = textMeasurer.measure(c?.textContent ?? ' ', style, tl.width, tl.height)
    }
  }
  await runOp('pasteClipSettings', { source, targetIds, boxes })
}

/** "Paste Settings": only when exactly one copied clip matches the clicked type and a compatible target is selected. */
export function pasteSettingsMenuItem(tl: Timeline, clip: Clip, selected: string[]): MenuItem | null {
  const source = copiedClipSettings(editor().clipboard, clip.mediaType)
  if (!source) return null
  const sel = new Set(selected)
  const targets = tl.tracks.flatMap((tr) => tr.clips.filter((c) => sel.has(c.id) && c.mediaType === source.mediaType && c.id !== source.id).map((c) => c.id))
  if (!targets.length) return null
  return { label: t('Paste Settings'), onSelect: () => void pasteSettings(tl, source, targets) }
}

// ---------- Decompose Nested Timeline (03 §8) ----------

export async function decomposeNested(clipId: string): Promise<void> {
  const out = await runOp('decomposeNest', { clipId })
  if (!out) return
  selectClips([])
  if (out.settingsDiscarded) toast(t('Nest settings discarded. Undo to restore.'))
}

/** Shown when the clicked clip is a carrier with a live child and the selection is exactly its link group. */
export function decomposeMenuItem(doc: Doc, tl: Timeline, clip: Clip, selected: string[]): MenuItem | null {
  if (!decomposeTargets(tl, doc, clip.id)) return null
  const group = expandToLinkGroup(tl, [clip.id])
  if (selected.length !== group.size || !selected.every((id) => group.has(id))) return null
  return { label: t('Decompose Nested Timeline'), onSelect: () => void decomposeNested(clip.id) }
}

// ---------- Swap Media (05 §6.14 Media group, 03 §10.6) ----------

/** "Swap Media": not for text, nested or multicam clips; only when the selection is exactly the clip's link group. */
export function clipSwapMenuItem(_doc: Doc, tl: Timeline, clip: Clip, selected: string[]): MenuItem | null {
  if (clip.mediaType === 'text' || clip.sourceClipType === 'sequence' || clip.multicamGroupId) return null
  const group = expandToLinkGroup(tl, [clip.id])
  if (selected.length !== group.size || !selected.every((id) => group.has(id))) return null
  return { label: t('Swap Media'), onSelect: () => beginMediaSwap(clip.id) }
}

// ---------- Multicam (05 §6.14 group 6, 03 §12.3 UI) ----------

export const LAYOUT_MENU: (VideoLayout | null)[] = [
  'full',
  null,
  'side_by_side',
  'top_bottom',
  null,
  'pip_bottom_right',
  'pip_bottom_left',
  'pip_top_right',
  'pip_top_left',
  null,
  'grid_2x2',
  'grid_3x3',
  'grid_4x4',
  null,
  'main_sidebar',
  'three_up',
  'three_stack',
]

export const LAYOUT_TITLES: Record<VideoLayout, string> = {
  full: tk('Full Frame'),
  side_by_side: tk('Side by Side'),
  top_bottom: tk('Top / Bottom'),
  pip_bottom_right: tk('PiP Bottom Right'),
  pip_bottom_left: tk('PiP Bottom Left'),
  pip_top_right: tk('PiP Top Right'),
  pip_top_left: tk('PiP Top Left'),
  grid_2x2: tk('Grid 2×2'),
  grid_3x3: tk('Grid 3×3'),
  grid_4x4: tk('Grid 4×4'),
  main_sidebar: tk('Main + Sidebar'),
  three_up: tk('Three-Up'),
  three_stack: tk('Three-Stack'),
}

async function switchRange(groupId: string, start: number, end: number, angles: string[], layout: VideoLayout = 'full'): Promise<void> {
  await runOp('switchAngle', { groupId, start, end, angles, layout })
}

/** The angle on the program track at the start of `clip` (the clicked clip's own angle when it is the program). */
function programAngle(doc: Doc, tl: Timeline, g: MulticamSource, clip: Clip): string | undefined {
  if (isProgramFragment(doc, clip.id)) return memberOfClip(g, clip)?.angleLabel
  const pi = programTrackIndex(tl, g, clip.startFrame, clip.startFrame + 1)
  const frag = pi >= 0 ? tl.tracks[pi].clips.find((c) => c.multicamGroupId === g.id && c.startFrame <= clip.startFrame && endFrame(c) > clip.startFrame) : undefined
  return (frag && memberOfClip(g, frag)?.angleLabel) ?? memberOfClip(g, clip)?.angleLabel
}

export function multicamMenuItems(doc: Doc, tl: Timeline, clip: Clip): MenuItem[] {
  const g = clip.multicamGroupId ? multicamGroup(doc, clip.multicamGroupId) : undefined
  if (!g) return []
  const items: MenuItem[] = []
  const current = memberOfClip(g, clip)
  const audio = clip.mediaType === 'audio'
  const pool = audio ? micMembers(doc, g) : angleMembers(g)
  const program = !audio && isProgramFragment(doc, clip.id)
  if (pool.length) {
    items.push({
      label: audio ? t('Switch Mic') : t('Switch Angle'),
      submenu: pool.map((m) => ({
        label: m.angleLabel,
        checked: m.mediaRef === current?.mediaRef,
        onSelect: () => {
          if (m.mediaRef === current?.mediaRef) return
          if (program) void switchRange(g.id, clip.startFrame, endFrame(clip), [m.angleLabel])
          else void runOp('switchClipMember', { clipId: clip.id, angle: m.angleLabel, mic: audio })
        },
      })),
    })
  }
  const angles = angleMembers(g)
  if (!audio && angles.length >= 2) {
    const first = programAngle(doc, tl, g, clip) ?? angles[0].angleLabel
    const order = [first, ...angles.map((m) => m.angleLabel).filter((l) => l.toLowerCase() !== first.toLowerCase())]
    items.push({
      label: t('Layout'),
      submenu: LAYOUT_MENU.map((l): MenuItem => (l === null ? { kind: 'divider' } : { label: t(LAYOUT_TITLES[l]), onSelect: () => void switchRange(g.id, clip.startFrame, endFrame(clip), order, l) })),
    })
  }
  items.push({ label: t('Ungroup Multicam'), onSelect: () => void runOp('ungroupMulticam', { groupId: g.id }) })
  return items
}

/** Range menu "Switch Angle in Range ▸" (only when exactly one multicam group overlaps the range). */
export function switchAngleInRangeItem(doc: Doc, range: { start: number; end: number }): MenuItem | null {
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  const ids = groupsInRange(doc, start, end)
  if (ids.length !== 1) return null
  const g = multicamGroup(doc, ids[0])!
  const angles = angleMembers(g)
  if (!angles.length) return null
  const rows = programRows(doc, g.id, { start, end })
  const only = rows.length === 1 && rows[0][1] === start && rows[0][2] === end ? rows[0][0] : null
  return {
    label: t('Switch Angle in Range'),
    submenu: angles.map((m) => ({ label: m.angleLabel, checked: only !== null && only.toLowerCase() === m.angleLabel.toLowerCase(), onSelect: () => void switchRange(g.id, start, end, [m.angleLabel]) })),
  }
}
