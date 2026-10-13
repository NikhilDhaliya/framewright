/** Inspector ▸ AI Edit (05 §7.5.6, spec 06 §B9.3): scope toggles and action tiles over the shared AI Edit rules. */
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowUpRight, Globe, Music, Ratio, RefreshCw, RotateCw, Scissors, Smile, Sparkles, SquarePlus, AudioWaveform, Video, WandSparkles, ChevronDown } from 'lucide-react'
import { audioTileState, AUDIO_TRANSFORMS, isEnhanceableDraft, lipSyncModel, tileState, VIDEO_TO_AUDIO, type AudioTransformKind, type EditAction, type VideoToAudioKind } from '@core/generation/edit'
import type { ModelSet } from '@core/generation/models'
import type { Clip, MediaManifestEntry } from '@core/model'
import { isVisualType } from '@core/model'
import { findClip } from '@core/timeline'
import { useDoc, timelineOf } from '../state/project'
import { openMenuBelow } from '../ui/Menu'
import { Switch } from '../ui/controls'
import { Group } from '../ui/panels'
import { audioTransform, createVideo, runAction, trimmedSeconds, videoAudio, type ClipContext, type FlowOptions } from './aiEdit'
import { useModelSet } from './store'
import { t, tk, tx } from '../i18n'

interface TileDef {
  action: EditAction
  icon: LucideIcon
  title: string
  description: string
}

const VISUAL_TILES: Record<string, TileDef> = {
  upscale: { action: 'upscale', icon: Sparkles, title: tk('Upscale'), description: tk('Enhance resolution or frame rate with AI') },
  edit: { action: 'edit', icon: WandSparkles, title: tk('Edit'), description: tk('Transform with a prompt or motion reference') },
  rerun: { action: 'rerun', icon: RotateCw, title: tk('Rerun'), description: tk('Regenerate with the same parameters') },
  lipSync: { action: 'lipSync', icon: Smile, title: tk('Lip Sync'), description: tk('Match mouth movement to replacement audio') },
  reframe: { action: 'reframe', icon: Ratio, title: tk('Reframe'), description: tk('Change aspect ratio and extend the frame with AI') },
  createVideo: { action: 'createVideo', icon: Video, title: tk('Create Video'), description: tk('Use as first frame or reference') },
  enhanceDraft: { action: 'enhanceDraft', icon: ArrowUpRight, title: tk('FLUX Enhance'), description: tk('Re-render the same motion at full quality in 1080p') },
}

function Tile({ icon: I, title, description, enabled, reason, menu, onClick }: { icon: LucideIcon; title: string; description: string; enabled: boolean; reason: string | null; menu?: boolean; onClick: (el: HTMLElement) => void }) {
  return (
    <button type="button" className={`pp-aiedit-tile hh${enabled ? '' : ' disabled'}`} aria-disabled={!enabled} data-tip={reason ? tx(reason) : t(description)} onClick={(e) => enabled && onClick(e.currentTarget)}>
      <I size={12} strokeWidth={2.2} className="pp-aiedit-tile-icon" />
      <span className="pp-aiedit-tile-title ellipsis">{t(title)}</span>
      <span style={{ flex: 1 }} />
      {menu && <ChevronDown size={9} strokeWidth={2.6} className="pp-aiedit-tile-chevron" />}
    </button>
  )
}

function ToggleRow({ icon: I, label, tip, on, onChange }: { icon: LucideIcon; label: string; tip: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="pp-aiedit-toggle" data-tip={tip}>
      <I size={11} className={on ? 'tone-accent' : 'tone-tertiary'} style={{ width: 16 }} />
      <span className="pp-aiedit-toggle-label">{label}</span>
      <span style={{ flex: 1 }} />
      <Switch on={on} onChange={onChange} />
    </div>
  )
}

/** `AIEditTab(asset:clipId:)`: `clipId` = timeline clip context (active timeline). */
export function AIEditTab({ asset, clipId }: { asset: MediaManifestEntry; clipId?: string | null }) {
  const set = useModelSet()
  const doc = useDoc()
  const [replace, setReplace] = useState(false)
  const [useTrim, setUseTrim] = useState(true)
  const [place, setPlace] = useState(true)
  const tl = timelineOf(doc)
  const clip = clipId && tl ? findClip(tl, clipId)?.clip ?? null : null
  const ctx: ClipContext | null = clip && tl ? { clip, asset, timeline: tl } : null
  const trimAvailable = !!ctx && trimmedSeconds(ctx) !== null
  const durationOverride = ctx && useTrim ? trimmedSeconds(ctx) : null
  const flow: FlowOptions = { replace, useTrim, place }
  const visual = clip ? isVisualType(clip.mediaType) : isVisualType(asset.type)

  const tile = (d: TileDef) => {
    const st = tileState(set, d.action, asset, durationOverride, !!ctx)
    const onClick = (el: HTMLElement) => {
      if (d.action !== 'createVideo') return runAction(d.action, asset, ctx, flow, set)
      openMenuBelow(el, [
        { label: t('Set as first frame'), onSelect: () => createVideo(asset, false, ctx, flow, set) },
        { label: t('Set as reference'), onSelect: () => createVideo(asset, true, ctx, flow, set) },
      ])
    }
    return <Tile key={d.action} icon={d.icon} title={d.title} description={d.description} enabled={st.enabled} reason={st.reason} menu={d.action === 'createVideo'} onClick={onClick} />
  }
  const audioTile = (k: AudioTransformKind) => {
    const st = audioTileState(set, k, asset, durationOverride)
    const c = AUDIO_TRANSFORMS[k]
    return <Tile key={k} icon={k === 'cleanup' ? AudioWaveform : Globe} title={c.title} description={c.description} enabled={st.enabled} reason={st.reason} onClick={() => audioTransform(asset, k, ctx, flow, set)} />
  }
  const v2aTile = (k: VideoToAudioKind) => {
    const c = VIDEO_TO_AUDIO[k]
    const st = tileState(set, c.action, asset, durationOverride, !!ctx)
    return <Tile key={k} icon={k === 'music' ? Music : AudioWaveform} title={c.title} description={c.description} enabled={st.enabled} reason={st.reason} onClick={() => videoAudio(asset, k, ctx, flow, set)} />
  }

  return (
    <div className="pp-aiedit">
      {trimAvailable && (
        <div className="pp-aiedit-trimbar">
          <ToggleRow icon={Scissors} label={t('Use trimmed portion only')} tip={t('Send only the visible clip range to the model, not the full source.')} on={useTrim} onChange={setUseTrim} />
        </div>
      )}
      {visual && (
        <Group title={t('AI Enhance')} contentStyle={{ padding: '2px 8px 10px 8px', gap: 8 }}>
          {ctx && (
            <ToggleRow
              icon={RefreshCw}
              label={t('Replace clip source')}
              tip={t("Swap the clip's media when generation completes. Speed, volume, trim, and transform are preserved.")}
              on={replace}
              onChange={setReplace}
            />
          )}
          <div className="pp-aiedit-grid">{visualTiles(set, asset).map(tile)}</div>
        </Group>
      )}
      {(asset.type === 'video' || asset.type === 'audio') && (
        <Group title={t('AI Audio')} contentStyle={{ padding: '2px 8px 10px 8px', gap: 8 }}>
          {ctx && <ToggleRow icon={SquarePlus} label={t('Place on timeline')} tip={t("Add generated audio to an audio track at this clip's start.")} on={place} onChange={setPlace} />}
          <div className="pp-aiedit-grid">
            {asset.type === 'audio' && tile(VISUAL_TILES.rerun)}
            {audioTile('cleanup')}
            {audioTile('dubbing')}
            {visual && asset.type === 'video' && v2aTile('music')}
            {visual && asset.type === 'video' && v2aTile('sfx')}
          </div>
        </Group>
      )}
    </div>
  )
}

/** Visual tile order (`visualActionGrid`). */
function visualTiles(set: ModelSet, asset: MediaManifestEntry): TileDef[] {
  const out = [VISUAL_TILES.upscale, VISUAL_TILES.edit, VISUAL_TILES.rerun]
  if (asset.type === 'video' && lipSyncModel(set)) out.push(VISUAL_TILES.lipSync)
  if (asset.type === 'video') out.push(VISUAL_TILES.reframe)
  if (asset.type === 'image') out.push(VISUAL_TILES.createVideo)
  if (isEnhanceableDraft(asset)) out.push(VISUAL_TILES.enhanceDraft)
  return out
}

/** Whether the AI Edit tab / section is offered at all (Linux: a generation provider key is set). */
export const aiEditConfigured = (set: ModelSet): boolean => set.canGenerate

/** 05 §7.3: the AI Edit tab's target for a clip selection, or null when the tab isn't offered. */
export function useAIEditTarget(clips: Clip[]): { asset: MediaManifestEntry; clipId: string } | null {
  const set = useModelSet()
  const doc = useDoc()
  if (!aiEditConfigured(set) || !doc) return null
  const visual = clips.filter((c) => c.mediaType !== 'audio')
  const audio = clips.filter((c) => c.mediaType === 'audio')
  let anchor: Clip | undefined
  if (visual.length) {
    if (visual.length !== 1) return null
    anchor = visual[0]
    const group = anchor.linkGroupId
    if (audio.some((a) => !group || a.linkGroupId !== group)) return null
  } else if (audio.length === 1) anchor = audio[0]
  const asset = anchor ? doc.manifest.entries.find((e) => e.id === anchor!.mediaRef) : undefined
  return anchor && asset ? { asset, clipId: anchor.id } : null
}

/** Asset inspector body: the AI Edit content inline (05 §7.2 item 2) when a generation key is set. */
export function AssetAIEdit({ asset, lead }: { asset: MediaManifestEntry; lead?: React.ReactNode }) {
  const set = useModelSet()
  const showEdit = aiEditConfigured(set) && ['video', 'image', 'audio'].includes(asset.type)
  if (!showEdit && !lead) return null
  // Mac `mediaAssetInspectorContent`: Generation Input, then AI Edit, in one scroll view.
  return (
    <div className="pp-insp-scroll" style={{ flex: 3, borderTop: '1px solid var(--pp-border-primary)' }}>
      {lead}
      {showEdit && <AIEditTab asset={asset} />}
    </div>
  )
}
