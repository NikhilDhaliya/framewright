/**
 * Captions tab (spec 07 §1.9; Mac `MediaPanel/CaptionsTab/CaptionTab.swift`). Two modes: `captions` (Media panel ▸
 * Captions) and `transcript` (the Index ▸ Transcript empty state: Source group only, button "Transcribe").
 */
import { useEffect, useMemo, useState } from 'react'
import type { TextAnimationPreset } from '@core/model'
import { languageDisplayName, sortedLanguages } from '@core/captions/languages'
import { validGapSeconds } from '@core/captions/specBuilder'
import { trackDisplayLabel } from '@core/timeline'
import type { SpeechStatus } from '../../../shared/api'
import { CAPTION_TASKS, captionPrompt } from '../../agent/handoffs'
import { handOff } from '../../agent/store'
import { editor, useEditor } from '../../state/editor'
import { getBaseDoc, timelineOf, useDoc, useTimeline } from '../../state/project'
import { Capsule } from '../../ui/buttons'
import { ColorField } from '../../ui/ColorField'
import { MenuValue, Row, Switch } from '../../ui/controls'
import { Icon } from '../../ui/Icon'
import { openMenuBelow, type MenuItem } from '../../ui/Menu'
import { Group, GroupScope } from '../../ui/panels'
import { ScrubField } from '../../ui/ScrubField'
import { setMediaView } from '../model'
import { publishTranscript, showGeneratedCaptions } from '../index/store'
import { CaptionError, errorText, generateCaptions, resolvedTargets, timelineTranscript, trackTargets, type CaptionRequest } from './pipeline'
import { CaptionStyleControls } from './StyleControls'
import { captionForm, DEFAULT_HIGHLIGHT, overlayLabel, setCaptionForm, useCaptionForm, useCaptionJob, useCaptionsVisible } from './store'
import './captions.css'
import { activeLocale, plural, t } from '../../i18n'

const PER_LINE: { id: TextAnimationPreset; name: string }[] = [
  { id: 'none', name: t('Off') },
  { id: 'popIn', name: t('Pop In') },
  { id: 'slideUp', name: t('Slide Up') },
  { id: 'typewriter', name: t('Typewriter') },
]
const PER_WORD: { id: TextAnimationPreset; name: string }[] = [
  { id: 'wordReveal', name: t('Word Reveal') },
  { id: 'wordSlide', name: t('Word Slide') },
  { id: 'highlightPop', name: t('Highlight') },
  { id: 'highlightBlock', name: t('Highlight Block') },
]

const TRANSLATE: { code: string; name: string }[] = [
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh-Hans', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
]

const uiLocale = () => activeLocale()

function Poster({ preset }: { preset: TextAnimationPreset }) {
  return (
    <span className={`pp-insp-poster p-${preset}`}>
      {['Aa', 'Bb', 'Cc'].map((w, i) => (
        <span key={w} className={i === 1 ? 'focus' : i === 2 ? 'later' : undefined}>
          {preset === 'typewriter' && i === 2 ? 'C' : w}
        </span>
      ))}
    </span>
  )
}

/** `CaptionPresetGallery`: Per line / Per word sections. */
function PresetGallery({ value, onPick }: { value: TextAnimationPreset; onPick: (p: TextAnimationPreset) => void }) {
  return (
    <>
      {[
        [t('Per line'), PER_LINE],
        [t('Per word'), PER_WORD],
      ].map(([title, presets]) => (
        <div key={title as string} className="pp-insp-gallery-section">
          <span className="pp-insp-gallery-title">{title as string}</span>
          <div className="pp-insp-gallery">
            {(presets as typeof PER_LINE).map((p) => (
              <button key={p.id} type="button" className={`pp-insp-preset${value === p.id ? ' on' : ''}`} onClick={() => onPick(p.id)}>
                <span className="pp-insp-preset-cell">
                  <Poster preset={p.id} />
                </span>
                <span className="pp-insp-preset-name">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

/** `rememberSelectedClipTargets`: skipped while a marquee runs, or when the selection is empty with the Media panel focused. */
function useRememberedSelection() {
  const selected = useEditor((s) => s.selectedClipIds)
  const marquee = useEditor((s) => s.marqueeCount)
  const doc = useDoc()
  useEffect(() => {
    if (marquee !== null || !doc || !timelineOf(doc)) return
    const targets = selected.length ? resolvedTargets(doc, { autoDetect: false, sourceClipIds: selected }).map((t) => t.clip.id) : []
    if (!targets.length && editor().focusedPanel === 'mediaPanel') return
    if (JSON.stringify(targets) !== JSON.stringify(captionForm().selectedTargets)) setCaptionForm({ selectedTargets: targets })
  }, [selected, marquee, doc])
}

function useSpeechStatus(): SpeechStatus | null {
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void window.palmier.ml.speechStatus().then((s) => live && setStatus(s))
    load()
    const off = window.palmier.settings.onChange(load)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

const CLOUD_UNAVAILABLE = t('Add a speech-to-text API key in Settings to use Cloud.')

/** Own collapse-state scope: "Style"/"Settings"/"Animation" must not share state with the inspector's groups. */
export function CaptionsTab({ mode = 'captions' }: { mode?: 'captions' | 'transcript' }) {
  return (
    <GroupScope id={`captions-${mode}`}>
      <CaptionsTabBody mode={mode} />
    </GroupScope>
  )
}

function CaptionsTabBody({ mode = 'captions' }: { mode?: 'captions' | 'transcript' }) {
  const transcriptOnly = mode === 'transcript'
  const form = useCaptionForm()
  const job = useCaptionJob()
  const doc = useDoc()
  const tl = useTimeline()
  const status = useSpeechStatus()
  useRememberedSelection()
  useEffect(() => {
    if (transcriptOnly) return
    useCaptionsVisible.setState({ visible: true })
    return () => useCaptionsVisible.setState({ visible: false })
  }, [transcriptOnly])

  const languages = useMemo(() => sortedLanguages(uiLocale()), [])
  const cloudAvailable = status?.cloudAvailable ?? false
  const provider = form.provider === 'cloud' && cloudAvailable ? 'cloud' : 'local'
  const cloudMessage = form.provider === 'cloud' && !cloudAvailable ? CLOUD_UNAVAILABLE : null

  // Source (CaptionTab.swift:60-73, 319-353).
  const autoTargets = doc && tl ? resolvedTargets(doc, { autoDetect: true, sourceClipIds: [] }) : []
  const trackChoices = doc && tl ? tl.tracks.map((tr, i) => ({ id: tr.id, index: i, count: trackTargets(doc, tr.id).length })).filter((x) => x.count > 0) : []
  const selectedTrack = form.trackId && tl ? tl.tracks.findIndex((tr) => tr.id === form.trackId) : -1
  const isAuto = form.trackId === null && form.selectedTargets.length === 0
  const sourceIds = form.trackId ? (doc ? trackTargets(doc, form.trackId).map((c) => c.id) : []) : form.selectedTargets
  const effectiveCount = isAuto ? autoTargets.length : sourceIds.length
  const autoSummary = form.selectedTargets.length ? t('Selected Clips · {0}', form.selectedTargets.length) : autoTargets.length ? t('Auto') : t('No audio')
  const sourceSummary = form.trackId === null ? autoSummary : selectedTrack < 0 || !tl ? t('No track') : `${trackDisplayLabel(tl, selectedTrack)} · ${sourceIds.length}`
  const sourceItems = (): MenuItem[] => [
    { label: autoSummary, checked: form.trackId === null, onSelect: () => setCaptionForm({ trackId: null }) },
    { kind: 'divider' },
    ...(trackChoices.length
      ? trackChoices.map(
          (x): MenuItem => ({ label: `${trackDisplayLabel(tl!, x.index)} · ${plural(x.count, '1 clip', '{0} clips')}`, checked: form.trackId === x.id, onSelect: () => setCaptionForm({ trackId: x.id }) }),
        )
      : [{ label: t('No Tracks'), disabled: true } as MenuItem]),
  ]

  const canGenerate = effectiveCount > 0 && !job.generating && !cloudMessage

  const generate = async () => {
    useCaptionJob.setState({ note: null })
    if (form.trackId !== null && !sourceIds.length) {
      useCaptionJob.setState({ note: t('No audio selected.') })
      return
    }
    const req: CaptionRequest = {
      sourceClipIds: sourceIds,
      autoDetect: isAuto,
      style: form.style,
      center: form.center,
      textCase: 'auto',
      censorProfanity: provider === 'local' && form.censor,
      locale: form.locale ?? undefined,
      maxWords: form.maxWords ?? undefined,
      maxCharacters: form.maxCharacters ?? undefined,
      maximumGapSeconds: validGapSeconds(form.gapSeconds) ?? 0.5,
      provider,
      // `TextAnimation(preset:, highlight:)`: perWordFrames 6 (TextAnimation.swift:59), highlight always carried.
      animation: { preset: form.preset, perWordFrames: 6, highlight: form.highlight },
    }
    const onProgress = (progress: Parameters<typeof overlayLabel>[0]) => useCaptionJob.setState({ progress })
    useCaptionJob.setState({ generating: true, progress: null })
    try {
      if (transcriptOnly) {
        const timelineId = timelineOf(getBaseDoc())?.id ?? ''
        const transcript = await timelineTranscript(req, onProgress)
        if (!transcript.rows.length) useCaptionJob.setState({ note: t('No speech detected.') })
        else publishTranscript(transcript, timelineId)
      } else {
        const handle = generateCaptions(req, onProgress)
        useCaptionJob.setState({ cancel: handle.cancel })
        const { ids } = await handle.promise
        if (!ids.length) useCaptionJob.setState({ note: t('No speech detected.') })
        else {
          setCaptionForm({ previewEnabled: false })
          showGeneratedCaptions()
          setMediaView({ section: 'index', searchExpanded: false, query: '' })
        }
      }
    } catch (e) {
      if (!(e instanceof CaptionError && e.message === 'Cancelled')) useCaptionJob.setState({ note: errorText(e) })
    } finally {
      useCaptionJob.setState({ generating: false, progress: null, cancel: null })
    }
  }

  const agentItems = (): MenuItem[] => [
    { label: t('Remove filler words'), icon: 'text.badge.minus', onSelect: () => handOff(captionPrompt(CAPTION_TASKS.removeFillers)) },
    { label: t('Fix names & jargon'), icon: 'checkmark.bubble', onSelect: () => handOff(captionPrompt(CAPTION_TASKS.fixNames)) },
    { label: t('Add emoji'), icon: 'face.smiling', onSelect: () => handOff(captionPrompt(CAPTION_TASKS.addEmoji)) },
    {
      label: t('Translate'),
      icon: 'globe',
      submenu: TRANSLATE.map((l) => ({ label: languageDisplayName(l.code, uiLocale()), onSelect: () => handOff(captionPrompt(CAPTION_TASKS.translate(l.name))) })),
    },
  ]

  const radio = (value: 'local' | 'cloud', label: string, tip: string) => {
    const disabled = value === 'cloud' && !cloudAvailable
    const on = provider === value
    return (
      <button type="button" className={`pp-cap-radio${on ? ' on' : ''}`} disabled={disabled} data-tip={disabled ? CLOUD_UNAVAILABLE : tip} onClick={() => setCaptionForm({ provider: value })}>
        <span className="pp-cap-radio-dot" />
        <span>{label}</span>
      </button>
    )
  }

  const footer = (
    <div className={`pp-cap-footer${transcriptOnly ? ' inline' : ''}`}>
      <span className="pp-cap-note">{job.note ?? cloudMessage ?? ''}</span>
      <Capsule variant="prominent" disabled={!canGenerate} tip={cloudMessage ?? undefined} onClick={() => void generate()}>
        {transcriptOnly ? t('Transcribe') : t('Generate')}
      </Capsule>
      {!transcriptOnly && (
        <button type="button" className="pp-iconbtn hh pp-cap-agent" data-tip={t('Let Agent create captions for you. Choose a predefined task, or ask Agent in the chat.')} onClick={(e) => openMenuBelow(e.currentTarget, agentItems(), { alignRight: true, minWidth: 200 })}>
          <Icon sf="sparkles" size={11} />
          <Icon sf="chevron.down" size={8} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )

  return (
    <div className={`pp-captions${transcriptOnly ? ' transcript-only' : ''}`}>
      <div className="pp-cap-scroll">
        <Group
          title={t('Source')}
          accessory={
            transcriptOnly ? undefined : (
              <span className="pp-cap-preview-toggle" data-tip={t('Preview')}>
                <span>{t('Preview')}</span>
                <Switch on={form.previewEnabled} onChange={(previewEnabled) => setCaptionForm({ previewEnabled })} />
              </span>
            )
          }
        >
          <Row label={t('Source')} tip={t('Uses selected clips when available, otherwise all captionable audio. Choose a track to limit captions.')} reset={() => setCaptionForm({ trackId: null, selectedTargets: [] })}>
            <MenuValue text={sourceSummary} width="100%" items={sourceItems} />
          </Row>
          <Row label={t('Mode')} tip={t('Local runs on this computer with Whisper. Cloud uses your speech-to-text provider.')} reset={() => setCaptionForm({ provider: 'local' })}>
            <span className="pp-cap-radios">
              {radio('local', t('Local'), t('Local runs on this computer with Whisper.'))}
              {radio('cloud', t('Cloud'), t('Cloud uses your speech-to-text provider. It auto-detects languages and can identify speakers.'))}
            </span>
          </Row>
        </Group>
        {transcriptOnly ? (
          footer
        ) : (
          <>
            <Group title={t('Settings')}>
              <Row label={t('Language')} reset={() => setCaptionForm({ locale: null })}>
                <MenuValue
                  text={form.locale ? languageDisplayName(form.locale, uiLocale()) : t('Auto')}
                  width="100%"
                  minWidth={180}
                  items={() => [{ label: t('Auto'), checked: form.locale === null, onSelect: () => setCaptionForm({ locale: null }) }, { kind: 'divider' }, ...languages.map((l): MenuItem => ({ label: l.name, checked: form.locale === l.code, onSelect: () => setCaptionForm({ locale: l.code }) }))]}
                />
              </Row>
              <Row label={t('Max words')} tip={t('Cap the words shown per caption. None fits each line to the box.')} reset={() => setCaptionForm({ maxWords: null })}>
                <ScrubField
                  value={form.maxWords ?? 0}
                  min={0}
                  max={50}
                  sens={0.25}
                  adjust={Math.round}
                  format={(v) => (v < 1 ? t('None') : String(Math.round(v)))}
                  onChange={(v) => setCaptionForm({ maxWords: Math.round(v) >= 1 ? Math.round(v) : null })}
                  onCommit={(v) => setCaptionForm({ maxWords: Math.round(v) >= 1 ? Math.round(v) : null })}
                />
              </Row>
              <Row label={t('Max characters')} tip={t('Cap characters per caption, including spaces and punctuation. A single word may exceed the limit.')} reset={() => setCaptionForm({ maxCharacters: null })}>
                <ScrubField
                  value={form.maxCharacters ?? 0}
                  min={0}
                  max={200}
                  sens={0.5}
                  adjust={Math.round}
                  format={(v) => (v < 1 ? t('None') : String(Math.round(v)))}
                  onChange={(v) => setCaptionForm({ maxCharacters: Math.round(v) >= 1 ? Math.round(v) : null })}
                  onCommit={(v) => setCaptionForm({ maxCharacters: Math.round(v) >= 1 ? Math.round(v) : null })}
                />
              </Row>
              <Row label={t('Close gaps')} tip={t('Extends captions across short gaps and holds the final caption.')} reset={() => setCaptionForm({ gapSeconds: 0.5 })}>
                <ScrubField
                  value={form.gapSeconds}
                  min={0}
                  max={2}
                  mult={1000}
                  suffix=" ms"
                  sens={10}
                  adjust={(v) => Math.round(v / 0.05) * 0.05}
                  onChange={(gapSeconds) => setCaptionForm({ gapSeconds })}
                  onCommit={(gapSeconds) => setCaptionForm({ gapSeconds })}
                />
              </Row>
              <Row label={t('Censor profanity')} reset={() => setCaptionForm({ censor: false })}>
                <span style={{ opacity: provider === 'cloud' ? 0.15 : 1 }}>
                  <Switch on={form.censor} disabled={provider === 'cloud'} onChange={(censor) => setCaptionForm({ censor })} />
                </span>
              </Row>
            </Group>
            <CaptionStyleControls style={form.style} onStyle={(style) => setCaptionForm({ style })} center={form.center} onCenter={(center) => setCaptionForm({ center })} canvas={{ w: tl?.width ?? 1920, h: tl?.height ?? 1080 }} />
            <Group title={t('Animation')} defaultExpanded={false} contentStyle={{ gap: 14 }}>
              <PresetGallery value={form.preset} onPick={(preset) => setCaptionForm({ preset })} />
              {PER_WORD.some((p) => p.id === form.preset) && (
                <Row label={t('Highlight')} tip={t('Color for the active word.')} reset={() => setCaptionForm({ highlight: DEFAULT_HIGHLIGHT })}>
                  <ColorField value={form.highlight} alpha onChange={(highlight) => setCaptionForm({ highlight })} onCommit={(highlight) => setCaptionForm({ highlight })} />
                </Row>
              )}
            </Group>
          </>
        )}
      </div>
      {!transcriptOnly && footer}
      {job.generating && (
        <div className="pp-cap-overlay">
          <span className="pp-spinner" style={{ width: 18, height: 18 }} />
          <span>{overlayLabel(job.progress)}</span>
        </div>
      )}
    </div>
  )
}
