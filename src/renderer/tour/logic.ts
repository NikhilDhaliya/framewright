/** Tutorial tour steps and callout placement (spec 07 §7.3, Mac `TourController.makeSteps` / `calloutPosition`). Pure: no DOM. */
import type { Clip, Track } from '@core/model'
import { t } from '../i18n'

export type TourPanel = 'media' | 'preview' | 'timeline' | 'inspector' | 'agent'
export type TourElement = 'importButton' | 'generateButton' | 'generation' | 'smartSearch' | 'screenshotButton' | 'aiEditPanel' | 'skillsButton'
export type TourPrepare = 'selectAIEditClip' | 'revealInspectorOverview' | 'revealAIEditTab'

export type TourStep =
  | { kind: 'intro'; id: 'intro'; title: string; instruction: string }
  | { kind: 'outro'; id: 'outro'; title: string; instruction: string }
  | { kind: 'panel'; id: string; panel: TourPanel; title: string; instruction: string; prepare?: TourPrepare }
  | { kind: 'element'; id: string; element: TourElement; title: string; instruction: string; prepare?: TourPrepare }

export interface TourContext {
  /** A generation provider key is set, so the Generate button exists (Linux: skip steps 4–5 otherwise). */
  canGenerate: boolean
  /** The media toolbar offers "Smart search" (model not installed, indexing enabled, ≥1 video/image asset). */
  smartSearchOffered: boolean
  /** An AI-edit clip exists and AI Edit is available (generation key set). */
  hasAIEditClip: boolean
}

/** Verbatim Mac strings with the Linux copy changes from 07 §7.3. */
export function makeSteps(ctx: TourContext): TourStep[] {
  const steps: TourStep[] = [
    { kind: 'intro', id: 'intro', title: t('Tutorial'), instruction: t("Let's take a quick tour of the workspace and what you can do.") },
    { kind: 'panel', id: 'media', panel: 'media', title: t('Media panel'), instruction: t('This is where all your footage and assets live.') },
    { kind: 'element', id: 'import', element: 'importButton', title: t('Import footage'), instruction: t('Import your footage here, or drag and drop, or copy-paste, into the media panel.') },
  ]
  if (ctx.canGenerate) {
    steps.push(
      { kind: 'element', id: 'generate', element: 'generateButton', title: t('Generate'), instruction: t('Click Generate to open the generation panel.') },
      {
        kind: 'element',
        id: 'generation',
        element: 'generation',
        title: t('Generation panel'),
        instruction: t('Generate video, image, or audio with different models and settings. Drag assets from the media panel above into the reference frame.'),
      },
    )
  }
  if (ctx.smartSearchOffered) {
    steps.push({
      kind: 'element',
      id: 'smartSearch',
      element: 'smartSearch',
      title: t('Smart search'),
      instruction: t('Download a local model to index your media, so you or your agent can search any clips by describing them. The model runs on-device and nothing leaves your computer.'),
    })
  }
  steps.push(
    { kind: 'panel', id: 'preview', panel: 'preview', title: t('Preview'), instruction: t('This is your preview panel to play a selected media or the whole timeline.') },
    {
      kind: 'element',
      id: 'screenshot',
      element: 'screenshotButton',
      title: t('Screenshot a frame'),
      instruction: t('Take a screenshot of the preview and use it as a reference for generation. Particularly useful for creating AI transitions.'),
    },
    ctx.hasAIEditClip
      ? { kind: 'panel', id: 'timeline', panel: 'timeline', title: t('Timeline'), instruction: t("Your timeline: the top half is video, the bottom half is audio. Click a clip to inspect it — we've selected one for you."), prepare: 'selectAIEditClip' }
      : { kind: 'panel', id: 'timeline', panel: 'timeline', title: t('Timeline'), instruction: t('Your timeline: the top half is video, the bottom half is audio. This is where you edit.') },
    {
      kind: 'panel',
      id: 'inspector',
      panel: 'inspector',
      title: t('Inspector'),
      instruction: t('Your inspector for the selected clip — transform, adjust, audio, and more.'),
      ...(ctx.hasAIEditClip ? { prepare: 'revealInspectorOverview' as const } : null),
    },
  )
  if (ctx.hasAIEditClip) {
    steps.push({
      kind: 'element',
      id: 'aiEdit',
      element: 'aiEditPanel',
      title: t('AI Edit'),
      instruction: t('Open the AI Edit tab to upscale, prompt-edit, create video from a frame, or generate music, SFX, cleanup, and dubbing from the clip.'),
      prepare: 'revealAIEditTab',
    })
  }
  steps.push(
    {
      kind: 'panel',
      id: 'agent',
      panel: 'agent',
      title: t('AI agent'),
      instruction: t('Chat with your agent! It can generate content, edit clips, organize your assets, and much more. Start by adding your Anthropic or OpenAI API key in Settings.'),
    },
    { kind: 'element', id: 'skills', element: 'skillsButton', title: t('Skills'), instruction: t('Open Skills to browse community playbooks, create your own, or add them to other agents.') },
    { kind: 'outro', id: 'outro', title: t("You're all set"), instruction: t('Start creating, or explore these to get the most out of {app}.') },
  )
  return steps
}

export const isSpotlight = (s: TourStep): boolean => s.kind === 'panel' || s.kind === 'element'

/** "Step <index> of <spotlightCount>": index is the position in the full list, so the intro is 0 and the first spotlight is 1. */
export function stepCounter(steps: TourStep[], index: number): string {
  return t('Step {0} of {1}', index, steps.filter(isSpotlight).length)
}

/** The panel that must be visible for a spotlight step (timeline and preview are always visible). */
export function hostPanel(s: TourStep): TourPanel | null {
  if (s.kind === 'panel') return s.panel
  if (s.kind !== 'element') return null
  switch (s.element) {
    case 'importButton':
    case 'generateButton':
    case 'generation':
    case 'smartSearch':
      return 'media'
    case 'aiEditPanel':
      return 'inspector'
    case 'skillsButton':
      return 'agent'
    case 'screenshotButton':
      return 'preview'
  }
}

/** "AI-edit clip": the first visual non-text clip in track order whose media is in the library. */
export function findAIEditClip(tracks: Track[], inLibrary: (mediaRef: string) => boolean): Clip | null {
  for (const t of tracks) {
    for (const c of t.clips) {
      if (c.mediaType === 'audio' || c.mediaType === 'subtitle' || c.mediaType === 'text') continue
      if (inLibrary(c.mediaRef)) return c
    }
  }
  return null
}

/** The clip plus every clip in its link group. */
export function linkGroupIds(tracks: Track[], clip: Clip): string[] {
  if (!clip.linkGroupId) return [clip.id]
  return tracks.flatMap((t) => t.clips.filter((c) => c.linkGroupId === clip.linkGroupId).map((c) => c.id))
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const CALLOUT_WIDTH = 320
export const CALLOUT_EST_HEIGHT = 220
const MARGIN = 24

/**
 * Callout centre (Mac `calloutPosition`, verbatim): right of the frame if it fits, else left, else above when there's
 * room for the estimated card plus two margins, else below; clamped with the 220 estimate and a 24 margin. No frame → centre.
 */
export function calloutPosition(frame: Rect | null, win: { width: number; height: number }): { x: number; y: number } {
  const w = CALLOUT_WIDTH
  const est = CALLOUT_EST_HEIGHT
  const clampX = (x: number) => Math.min(Math.max(x, w / 2 + MARGIN), win.width - w / 2 - MARGIN)
  const clampY = (y: number) => Math.min(Math.max(y, est / 2 + MARGIN), win.height - est / 2 - MARGIN)
  if (!frame) return { x: win.width / 2, y: win.height / 2 }
  const maxX = frame.x + frame.width
  const maxY = frame.y + frame.height
  const midY = frame.y + frame.height / 2
  const needed = w + MARGIN * 2
  if (win.width - maxX > needed) return { x: maxX + MARGIN + w / 2, y: clampY(midY) }
  if (frame.x > needed) return { x: frame.x - MARGIN - w / 2, y: clampY(midY) }
  const x = clampX(frame.x + frame.width / 2)
  if (frame.y > est + MARGIN * 2) return { x, y: clampY(frame.y - MARGIN - est / 2) }
  return { x, y: clampY(maxY + MARGIN + est / 2) }
}
