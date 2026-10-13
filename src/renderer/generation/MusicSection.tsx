/** Audio ▸ Music (spec 06 §B8, 05 §4.14; Mac `MusicTab.swift`): video-to-music over a timeline span or text-to-music. */
import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { musicSourceSpan, musicSourceSummary, musicTextDurationRange, musicValidationNote, snapMusicDuration, type MusicMode } from '@core/generation/music'
import { keyReason } from '@core/generation/edit'
import { MUSIC_PHASE_LABELS, type MusicPhase } from '@core/generation/requests'
import { isInFlight } from '@core/generation/status'
import type { AudioModel } from '@core/generation/models'
import { handOff } from '../agent/store'
import { MUSIC_SCORE_PROMPT, musicMoodPrompt } from '../agent/handoffs'
import { useEditor } from '../state/editor'
import { usePlayhead } from '../state/playback'
import { useDoc, timelineOf } from '../state/project'
import { Capsule } from '../ui/buttons'
import { MenuValue, Row } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { useModelSet } from './store'
import { GeneratingOverlay } from './TileStatus'
import { t, tk } from '../i18n'

interface MusicState {
  modelId: string | null
  mode: MusicMode
  prompt: string
  textDuration: number
  /** Phase while exporting/uploading, then the placeholder id until its job ends. */
  phase: MusicPhase | null
  placeholderId: string | null
  note: string | null
}

/** Session-scoped (the Mac keeps `@State` for the panel's lifetime). */
export const useMusic = create<MusicState>(() => ({ modelId: null, mode: 'video', prompt: '', textDuration: 90, phase: null, placeholderId: null, note: null }))
const set = (p: Partial<MusicState>) => useMusic.setState(p)

export function MusicSection() {
  const models = useModelSet()
  const doc = useDoc()
  const range = useEditor((s) => s.range)
  const playhead = usePlayhead((s) => s.frame)
  const st = useMusic()
  const list = useMemo(() => models.audio.filter((m) => m.category === 'music' && m.inputs.includes('video')), [models])
  const model: AudioModel | null = list.find((m) => m.id === st.modelId) ?? list[0] ?? null
  const textCapable = !!model && model.inputs.includes('text')
  const mode: MusicMode = textCapable ? st.mode : 'video'
  const tl = timelineOf(doc)
  const fps = Math.max(1, tl?.fps ?? 30)
  const span = tl ? musicSourceSpan(tl, range) : null
  const spanSeconds = span ? span.frameCount / fps : 0
  const textRange = musicTextDurationRange(model)
  const note = st.note ?? keyReason(model ?? undefined) ?? musicValidationNote(model, mode, st.prompt, mode === 'text' ? st.textDuration : spanSeconds, !!span)

  // The overlay stays until the placeholder's job finishes or fails (§B8 step 4).
  const placeholder = st.placeholderId ? doc?.manifest.entries.find((e) => e.id === st.placeholderId) : undefined
  // The placeholder reaches the renderer with the next snapshot; until then (and while in flight) stay busy.
  const seen = useRef<string | null>(null)
  if (placeholder) seen.current = placeholder.id
  const pendingSnapshot = !!st.placeholderId && !placeholder && seen.current !== st.placeholderId
  const busy = st.phase !== null && (st.phase !== 'generating' || !st.placeholderId || pendingSnapshot || (!!placeholder && isInFlight(placeholder.generationStatus)))
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) set({ phase: null, placeholderId: null })
    wasBusy.current = busy
  }, [busy])
  useEffect(() => window.palmier.generation.onMusicPhase((phase) => useMusic.getState().phase !== null && set({ phase })), [])

  const selectModel = (m: AudioModel | null) => {
    const target = m ?? list[0] ?? null
    set({ modelId: m?.id ?? null, textDuration: target ? snapMusicDuration(target, st.textDuration) : st.textDuration })
  }

  const generate = async () => {
    if (!model || !tl || note || busy) return
    const textFrames = Math.max(1, Math.trunc(st.textDuration * fps))
    const placeAt = range && range.start !== range.end ? Math.min(range.start, range.end) : playhead
    const req =
      mode === 'text'
        ? { mode, model: model.id, prompt: st.prompt, timelineId: tl.id, startFrame: placeAt, frameCount: textFrames, spanSeconds: st.textDuration }
        : { mode, model: model.id, prompt: st.prompt, timelineId: tl.id, startFrame: span!.startFrame, frameCount: span!.frameCount, spanSeconds }
    set({ note: null, phase: mode === 'text' ? 'generating' : 'exporting', placeholderId: null })
    try {
      const out = await window.palmier.generation.music(req)
      if (!out.ok) return set({ note: out.error, phase: null })
      set({ phase: 'generating', placeholderId: out.placeholderIds[0] ?? null })
    } catch (e) {
      set({ note: e instanceof Error ? e.message : String(e), phase: null })
    }
  }

  const agentItems = (): MenuItem[] => [
    { label: t('Generate music for the timeline'), icon: 'music.note', onSelect: () => handOff(MUSIC_SCORE_PROMPT) },
    { label: t('Mood'), icon: 'slider.horizontal.3', submenu: [tk('Cinematic'), tk('Upbeat'), tk('Ambient'), tk('Tense'), tk('Lo-fi')].map((mood) => ({ label: t(mood), onSelect: () => handOff(musicMoodPrompt(mood)) })) },
  ]

  return (
    <div className="pp-music">
      <Group title={t('Music')}>
        {textCapable && (
          <Row label={t('Input')} reset={() => set({ mode: 'video' })}>
            <MenuValue
              text={mode === 'video' ? t('Video to Music') : t('Text to Music')}
              width="100%"
              items={() => [
                { label: t('Video to Music'), onSelect: () => set({ mode: 'video' }) },
                { label: t('Text to Music'), onSelect: () => set({ mode: 'text' }) },
              ]}
            />
          </Row>
        )}
        {mode === 'text' ? (
          <Row label={t('Duration')} tip={t("Length of the generated music. It's placed at the playhead, or at the marked range start.")} reset={() => set({ textDuration: model?.durationRange?.defaultValue ?? 90 })}>
            <ScrubField
              value={st.textDuration}
              min={textRange.min}
              max={textRange.max}
              decimals={0}
              suffix=" s"
              adjust={Math.round}
              onChange={(v) => set({ textDuration: Math.round(v) })}
              onCommit={(v) => set({ textDuration: Math.round(v) })}
            />
          </Row>
        ) : (
          <Row label={t('Video')} tip={t('Uses the whole timeline by default. Mark a range on the timeline to score only that span.')}>
            <span className="pp-music-value ellipsis">{span ? musicSourceSummary(span, fps, !!range && range.start !== range.end) : t('No video')}</span>
          </Row>
        )}
        <Row label={t('Model')} reset={() => selectModel(null)}>
          <MenuValue text={model?.displayName ?? t('None')} width="100%" items={() => list.map((m) => ({ label: m.displayName, checked: m.id === model?.id, onSelect: () => selectModel(m) }))} />
        </Row>
        <Row label={t('Prompt')}>
          <textarea className="pp-music-prompt" rows={2} placeholder={model ? t(model.promptLabel) : ''} value={st.prompt} onChange={(e) => set({ prompt: e.target.value, note: null })} />
        </Row>
        <div className="pp-music-actions">
          {note && <div className="pp-music-note">{note}</div>}
          <div className="pp-music-buttons">
            <span style={{ flex: 1 }} />
            <Capsule variant="prominent" disabled={!model || !!note || busy || !tl} onClick={() => void generate()}>
              {t('Generate')}
            </Capsule>
            <button type="button" className="pp-capsule secondary small" data-tip={t('Let Agent generate music for you. Choose a starter, or ask Agent in the chat.')} onClick={(e) => openMenuBelow(e.currentTarget, agentItems(), { alignRight: true, minWidth: 200 })}>
              {t('Agent Mode')} <Icon sf="chevron.down" size={10} />
            </button>
          </div>
        </div>
      </Group>
      {busy && (
        <div className="pp-music-overlay">
          <GeneratingOverlay label={MUSIC_PHASE_LABELS[st.phase ?? 'generating']} size="preview" />
        </div>
      )}
    </div>
  )
}
