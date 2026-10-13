/**
 * Generate panel (05 §4.13 visuals, spec 06 §B7 behaviour): type tabs, model picker, inputs by mode, prompt with
 * `@` reference tags, settings popover + summary, submit. Docked under the media grid; state lives in store.ts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { aspectRatioDisplayLabel, capitalize, resolutionDisplayLabel } from '@core/generation/labels'
import { DRAFT_RESOLUTION, type AnyModel, type AudioModel, type ImageModel, type ModelSet, type UpscaleModel, type VideoModel } from '@core/generation/models'
import type { UpscaleSelectSetting } from '@core/generation/catalog'
import type { ClipType, MediaManifestEntry } from '@core/model'
import { useDoc } from '../state/project'
import { openDialog } from '../state/dialogs'
import { useSettings } from '../state/settings'
import { activeDrag, decodeDragItems } from '../media/drag'
import { loadThumbnail } from '../media/thumbnails'
import { IconButton } from '../ui/buttons'
import { Checkbox, MenuValue, Segmented, Switch } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { Popover, rectOf, type AnchorRect } from '../ui/Popover'
import { ScrubField } from '../ui/ScrubField'
import {
  audioUsesSource,
  hasAnySettings,
  modelGroups,
  promptPlaceholder,
  promptTags,
  referenceCounter,
  selectedModel,
  settingsSummary,
  usesSourceVideoInput,
  videoModes,
  visibleTypes,
  VIDEO_MODE_LABELS,
  type GenType,
  type PanelState,
} from './panelLogic'
import {
  canSubmitNow,
  clearSlot,
  closeGenerationPanel,
  dropOnSlot,
  dropReferences,
  normalizeSelection,
  patchPanel,
  removeReference,
  setGenModel,
  setGenType,
  setPromptExtra,
  setVideoMode,
  submitGeneration,
  toggleGenerationPanel,
  useGeneration,
  useModelSet,
  type SlotKey,
} from './store'
import { ProjectActivityButton } from '../editor/ProjectActivity'
import { useModelVoices } from './voices'
import './generation.css'
import { languageDisplayName, t } from '../i18n'

const TYPE_TABS: Record<GenType, { label: string; icon: SFName; color: string }> = {
  image: { label: t('Image'), icon: 'photo', color: 'var(--pp-clip-image)' },
  video: { label: t('Video'), icon: 'video', color: 'var(--pp-clip-video)' },
  audio: { label: t('Audio'), icon: 'waveform', color: 'var(--pp-clip-audio)' },
  upscale: { label: t('Upscale'), icon: 'arrow.up.right', color: 'var(--pp-clip-video)' },
}

const TYPE_ICON: Partial<Record<ClipType, SFName>> = { video: 'video', image: 'photo', audio: 'waveform' }

const openModelSettings = () => openDialog({ kind: 'settings', pane: 'keys' })

// ---------- Small pieces ----------

const LOGO_HUES: Record<string, number> = {}
function hueFor(key: string): number {
  if (LOGO_HUES[key] === undefined) {
    let h = 0
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360
    LOGO_HUES[key] = h
  }
  return LOGO_HUES[key]
}

/** Generic provider mark: a tinted monogram (no bundled third-party logos, 05 §11.5). */
export function ProviderMark({ model, size = 14 }: { model: AnyModel | null; size?: number }) {
  const key = model?.providerIconKey ?? model?.providerName ?? model?.id ?? '?'
  const letter = (model?.providerName ?? model?.displayName ?? '?').charAt(0).toUpperCase()
  return (
    <span className="pp-gen-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.62), background: `hsl(${hueFor(key)} 45% 38%)` }} aria-hidden>
      {letter}
    </span>
  )
}

function useThumb(id: string | null, type: ClipType | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!id || (type !== 'image' && type !== 'video')) return
    let alive = true
    void loadThumbnail(id).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [id, type])
  return url
}

/** Library asset ids carried by an internal media-panel drag (`palmier-asset://<id>` lines). */
function droppedAssetIds(e: React.DragEvent): string[] {
  return decodeDragItems(e.dataTransfer.getData('text/plain')).flatMap((it) => (it.kind === 'asset' ? [it.id] : []))
}
const isAssetDrag = () => !!activeDrag.items?.some((it) => it.kind === 'asset')

function useDropTarget(onIds: (ids: string[]) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!isAssetDrag()) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false)
        const ids = droppedAssetIds(e)
        if (!ids.length) return
        e.preventDefault()
        e.stopPropagation()
        onIds(ids)
      },
    },
  }
}

function AssetCard({ entry, tag, onRemove }: { entry: MediaManifestEntry; tag?: string; onRemove: () => void }) {
  const thumb = useThumb(entry.id, entry.type)
  return (
    <div className="pp-gen-card" data-tip={entry.name}>
      {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon sf={TYPE_ICON[entry.type] ?? 'doc'} size={14} className="pp-gen-card-icon" />}
      {tag && <span className="pp-gen-tag">@{tag}</span>}
      <button type="button" className="pp-gen-remove" aria-label={t('Remove')} data-tip={t('Remove')} onClick={onRemove}>
        <Icon sf="xmark.circle.fill" size={12} />
      </button>
    </div>
  )
}

function DropZone({ icon, onIds, wide }: { icon: SFName; onIds: (ids: string[]) => void; wide?: boolean }) {
  const { over, handlers } = useDropTarget(onIds)
  return (
    <div className={`pp-gen-dropzone${over ? ' over' : ''}${wide ? ' wide' : ''}`} {...handlers}>
      <Icon sf={icon} size={12} />
    </div>
  )
}

function Slot({ label, slot, id, accepts, icon, set }: { label: string; slot: SlotKey; id: string | null; accepts: ClipType[]; icon: SFName; set: ModelSet }) {
  const doc = useDoc()
  const entry = id ? doc?.manifest.entries.find((e) => e.id === id) : undefined
  return (
    <div className="pp-gen-slot">
      <span className="pp-gen-slot-label">{label}</span>
      {entry ? <AssetCard entry={entry} onRemove={() => clearSlot(slot)} /> : <DropZone icon={icon} onIds={(ids) => dropOnSlot(set, slot, ids[0], accepts)} />}
    </div>
  )
}

// ---------- References area (§B7.5) ----------

function poolFull(m: AnyModel, s: PanelState): boolean {
  const n = { image: s.imageRefs.length, video: s.videoRefs.length, audio: s.audioRefs.length }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const total = n.image + n.video + n.audio
    if (vm.maxTotalReferences != null && total >= vm.maxTotalReferences) return true
    const caps: [number, number][] = [
      [n.image, vm.maxReferenceImages],
      [n.video, vm.maxReferenceVideos],
      [n.audio, vm.maxReferenceAudios],
    ]
    return caps.filter(([, cap]) => cap > 0).every(([c, cap]) => c >= cap)
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    let active: [number, number][] = [
      [n.image, am.maxReferenceImages],
      [n.audio, am.maxReferenceAudios],
    ]
    if (am.referenceImagesAndAudiosExclusive && (n.image || n.audio)) active = n.image ? [active[0]] : [active[1]]
    return active.filter(([, cap]) => cap > 0).every(([c, cap]) => c >= cap)
  }
  return false
}

function ReferencePool({ m, s, set, title, counter, dropIcon }: { m: AnyModel; s: PanelState; set: ModelSet; title: string; counter?: string; dropIcon: SFName }) {
  const doc = useDoc()
  const byId = (id: string) => doc?.manifest.entries.find((e) => e.id === id)
  const noun = m.kind === 'video' ? (m as VideoModel).referenceTagNoun : 'Image'
  const cards: { id: string; tag?: string }[] = [
    ...s.imageRefs.map((id, i) => ({ id, tag: m.kind === 'video' ? `${noun}${i + 1}` : undefined })),
    ...s.videoRefs.map((id, i) => ({ id, tag: `Video${i + 1}` })),
    ...s.audioRefs.map((id, i) => ({ id, tag: m.kind === 'image' ? undefined : `Audio${i + 1}` })),
  ]
  return (
    <div className="pp-gen-pool">
      <div className="pp-gen-pool-header">
        <span className="pp-gen-slot-label">{title}</span>
        {counter && <span className="pp-gen-pool-counter tnum">{counter}</span>}
      </div>
      <div className="pp-gen-pool-grid">
        {cards.map((c) => {
          const e = byId(c.id)
          return e ? <AssetCard key={c.id} entry={e} tag={c.tag} onRemove={() => removeReference(c.id)} /> : null
        })}
        {!poolFull(m, s) && <DropZone icon={dropIcon} onIds={(ids) => dropReferences(set, ids)} />}
      </div>
    </div>
  )
}

function Inputs({ m, s, set }: { m: AnyModel; s: PanelState; set: ModelSet }) {
  if (m.kind === 'video') {
    const vm = m as VideoModel
    if (usesSourceVideoInput(vm, s)) {
      return (
        <div className="pp-gen-slots">
          <Slot label={t('Source Video')} slot="sourceVideo" id={s.sourceVideo} accepts={['video']} icon="video" set={set} />
          {vm.maxReferenceImages > 0 && <Slot label={t('Reference Image')} slot="refImage" id={s.imageRefs[0] ?? null} accepts={['image']} icon="photo.badge.plus" set={set} />}
          {vm.maxReferenceAudios > 0 && <Slot label={t('Replacement Audio')} slot="refAudio" id={s.audioRefs[0] ?? null} accepts={['audio']} icon="waveform" set={set} />}
        </div>
      )
    }
    const showFrames = vm.supportsFirstFrame && (!vm.framesAndReferencesExclusive || s.videoMode === 'frames')
    const showRefs = vm.supportsReferences && (!vm.framesAndReferencesExclusive || s.videoMode === 'references')
    if (!showFrames && !showRefs) return null
    return (
      <>
        {showFrames && (
          <div className="pp-gen-slots">
            <Slot label={t('First Frame')} slot="frame0" id={s.frames[0]} accepts={['image']} icon="photo.badge.plus" set={set} />
            {vm.supportsLastFrame && <Slot label={t('Last Frame')} slot="frame1" id={s.frames[1]} accepts={['image']} icon="photo.badge.plus" set={set} />}
          </div>
        )}
        {showRefs && <ReferencePool m={m} s={s} set={set} title={t('References')} counter={referenceCounter(vm, s)} dropIcon="plus" />}
      </>
    )
  }
  if (m.kind === 'image') {
    const im = m as ImageModel
    return im.supportsImageReference ? <ReferencePool m={m} s={s} set={set} title={t('References')} dropIcon="photo.badge.plus" /> : null
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    if (am.acceptsSourceMedia && (audioUsesSource(am, s) || !am.supportsReferences)) {
      const accepts = (['audio', 'video'] as ClipType[]).filter((t) => am.acceptsSource(t))
      const label = accepts.length === 2 ? t('Source Media') : accepts[0] === 'video' ? t('Source Video') : t('Source Audio')
      return (
        <div className="pp-gen-slots">
          <Slot label={label} slot="audioSource" id={s.audioSource} accepts={accepts} icon={accepts[0] === 'video' ? 'video' : 'waveform'} set={set} />
        </div>
      )
    }
    if (am.supportsReferences) {
      const cap = Math.max(am.maxReferenceImages, am.maxReferenceAudios)
      return <ReferencePool m={m} s={s} set={set} title={t('References')} counter={`${s.imageRefs.length + s.audioRefs.length}/${cap}`} dropIcon="plus" />
    }
    return null
  }
  const um = m as UpscaleModel
  return (
    <div className="pp-gen-slots">
      <Slot label={t('Source Media')} slot="upscaleSource" id={s.upscaleSource} accepts={um.supportedTypes} icon="arrow.up.right" set={set} />
    </div>
  )
}

// ---------- Prompt with @ tags ----------

function PromptBox({ m, s, extra }: { m: AnyModel | null; s: PanelState; extra: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string; anchor: AnchorRect } | null>(null)
  const [hi, setHi] = useState(0)
  const tags = promptTags(m, s)
  const matches = mention ? tags.filter((t) => t.toLowerCase().includes(mention.query.toLowerCase())) : []
  const noPrompt = !!m && ((m.kind === 'video' && !(m as VideoModel).supportsPrompt) || m.kind === 'upscale' || (m.kind === 'audio' && audioUsesSource(m as AudioModel, s) && !(m as AudioModel).inputs.includes('text')))

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const at = /(^|\s)@([A-Za-z0-9]*)$/.exec(before)
    if (!at || !tags.length) return setMention(null)
    const el = ref.current!
    setMention({ start: caret - at[2].length - 1, query: at[2], anchor: rectOf(el) })
    setHi(0)
  }
  const insert = (tag: string) => {
    if (!mention) return
    const el = ref.current!
    const caret = el.selectionStart
    const value = s.prompt.slice(0, mention.start) + `@${tag} ` + s.prompt.slice(caret)
    patchPanel({ prompt: value })
    setMention(null)
    const pos = mention.start + tag.length + 2
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className={`pp-gen-prompt${focused ? ' focused' : ''}`}>
      <textarea
        ref={ref}
        className="pp-gen-prompt-editor"
        style={{ height: 40 + extra }}
        value={s.prompt}
        disabled={noPrompt}
        placeholder={promptPlaceholder(m, s)}
        spellCheck
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          window.setTimeout(() => setMention(null), 150)
        }}
        onChange={(e) => {
          patchPanel({ prompt: e.target.value })
          updateMention(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          if (mention && matches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              insert(matches[Math.min(hi, matches.length - 1)])
              return
            }
          }
          if (mention && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setMention(null)
            return
          }
          e.stopPropagation()
        }}
      />
      {m?.kind === 'audio' && (m as AudioModel).supportsLyrics && (
        <textarea className="pp-gen-prompt-editor lyrics" value={s.lyrics} placeholder={t('Lyrics')} onChange={(e) => patchPanel({ lyrics: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      )}
      {m?.kind === 'audio' && (m as AudioModel).supportsStyleInstructions && (
        <textarea className="pp-gen-prompt-editor style" value={s.styleInstructions} placeholder={t('Style instructions')} onChange={(e) => patchPanel({ styleInstructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      )}
      {mention && (
        <Popover anchor={mention.anchor} onClose={() => setMention(null)} align="start" className="pp-gen-mentions">
          {matches.length ? (
            matches.map((tag, i) => (
              <button
                key={tag}
                type="button"
                className={`pp-gen-mention${i === hi ? ' hi' : ''}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insert(tag)
                }}
              >
                <span className="tag">@{tag}</span>
                <span className="kind">{tag.startsWith('Video') ? t('Video') : tag.startsWith('Audio') ? t('Audio') : t('Image')}</span>
              </button>
            ))
          ) : (
            <div className="pp-gen-mention-empty">{t('No matches')}</div>
          )}
        </Popover>
      )}
    </div>
  )
}

// ---------- Settings popover (§B7.6) ----------

function Choice<T extends string | number>({ label, options, value, onChange, gridMin, tip }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; gridMin?: number; tip?: string }) {
  const segmented = options.length <= 5 && !gridMin
  const cols = options.length === 6 ? 3 : 5
  return (
    <div className="pp-gen-field" data-tip={tip}>
      <span className="pp-gen-field-label">{label}</span>
      {segmented ? (
        <Segmented full options={options.map((o) => ({ value: o.value, label: o.label }))} value={value} onChange={onChange} />
      ) : (
        <div className="pp-gen-choice-grid" style={{ gridTemplateColumns: gridMin ? `repeat(auto-fill, minmax(${gridMin}px, 1fr))` : `repeat(${cols}, 1fr)` }}>
          {options.map((o) => (
            <button key={String(o.value)} type="button" className={`pp-gen-choice${o.value === value ? ' on' : ''}`} onClick={() => onChange(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ToggleField({ label, on, onChange, tip }: { label: string; on: boolean; onChange: (v: boolean) => void; tip?: string }) {
  return (
    <div className="pp-gen-field row" data-tip={tip}>
      <span className="pp-gen-field-label">{label}</span>
      <Switch on={on} onChange={onChange} />
    </div>
  )
}

function UpscaleSelect({ um, setting, s, source }: { um: UpscaleModel; setting: UpscaleSelectSetting; s: PanelState; source: MediaManifestEntry | null }) {
  const options = um.availableOptions(setting, source)
  const value = s.upscaleSettings.selections[setting.id] ?? setting.defaultValue
  const set = (v: string) => patchPanel({ upscaleSettings: { ...s.upscaleSettings, selections: { ...s.upscaleSettings.selections, [setting.id]: v } } })
  if (options.length <= 4) return <Choice label={setting.label} options={options.map((o) => ({ value: o.value, label: o.label }))} value={value} onChange={set} />
  const selected = options.find((o) => o.value === value)
  const items = (): MenuItem[] => {
    const out: MenuItem[] = []
    let group: string | undefined
    for (const o of options) {
      if (o.group && o.group !== group) {
        group = o.group
        out.push({ kind: 'header', label: o.groupDescription ? `${o.group}: ${o.groupDescription}` : o.group })
      }
      out.push({ label: o.description ? `${o.label}: ${o.description}` : o.label, checked: o.value === value, onSelect: () => set(o.value) })
    }
    return out
  }
  return (
    <div className="pp-gen-field">
      <span className="pp-gen-field-label">{setting.label}</span>
      <MenuValue text={selected?.label ?? value} items={items} width="100%" />
      {selected?.description && <span className="pp-gen-field-note">{selected.description}</span>}
    </div>
  )
}

function SettingsFields({ m, s }: { m: AnyModel; s: PanelState }) {
  const doc = useDoc()
  if (m.kind === 'upscale') {
    const um = m as UpscaleModel
    const source = s.upscaleSource ? doc?.manifest.entries.find((e) => e.id === s.upscaleSource) ?? null : null
    const fmt = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2)
    return (
      <>
        {um.selectSettings.map((st) => (
          <UpscaleSelect key={st.id} um={um} setting={st} s={s} source={source} />
        ))}
        {um.numericSettings.map((st) => {
          const v = s.upscaleSettings.numbers[st.id]
          const setNum = (raw: number | undefined) => {
            const numbers = { ...s.upscaleSettings.numbers }
            if (raw === undefined) delete numbers[st.id]
            else numbers[st.id] = Math.min(st.maximum, Math.max(st.minimum, st.minimum + Math.round((raw - st.minimum) / st.step) * st.step))
            patchPanel({ upscaleSettings: { ...s.upscaleSettings, numbers } })
          }
          return (
            <div key={st.id} className="pp-gen-field row">
              <span className="pp-gen-field-label">{st.label}</span>
              <span className="pp-gen-num">
                <ScrubField value={v ?? st.minimum} min={st.minimum} max={st.maximum} decimals={fmt(st.step)} width={64} onChange={(r) => setNum(r)} onCommit={(r) => setNum(r)} />
                {v !== undefined && <IconButton sf="arrow.counterclockwise" size={10} frame={18} tone="tertiary" tip={t('Reset: {0}', st.label)} onClick={() => setNum(undefined)} />}
              </span>
            </div>
          )
        })}
        {um.toggleSettings.map((st) => (
          <ToggleField
            key={st.id}
            label={st.label}
            on={s.upscaleSettings.toggles[st.id] ?? st.defaultValue}
            onChange={(on) => patchPanel({ upscaleSettings: { ...s.upscaleSettings, toggles: { ...s.upscaleSettings.toggles, [st.id]: on } } })}
          />
        ))}
      </>
    )
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    const range = am.durationRange
    return (
      <>
        {am.hasDurationControl && !audioUsesSource(am, s) && (range ? (
          <div className="pp-gen-field row">
            <span className="pp-gen-field-label">{t('Duration')}</span>
            <ScrubField value={s.audioDuration} min={range.minimum} max={range.maximum} decimals={0} suffix=" s" width={64} tip={`${range.minimum}-${range.maximum}`} onChange={(r) => patchPanel({ audioDuration: Math.round(r) })} onCommit={(r) => patchPanel({ audioDuration: Math.round(r) })} />
          </div>
        ) : (
          <Choice label={t('Duration')} options={(am.durations ?? []).map((d) => ({ value: d, label: `${d}s` }))} value={s.audioDuration} onChange={(v) => patchPanel({ audioDuration: v })} />
        ))}
        {am.supportsInstrumental && <ToggleField label={t('Instrumental')} on={s.instrumental} onChange={(v) => patchPanel({ instrumental: v })} />}
        {am.supportsMultilingual && <ToggleField label={t('Multilingual')} on={s.multilingual} onChange={(v) => patchPanel({ multilingual: v })} tip={t('Use for non-English or mixed-language audio.')} />}
      </>
    )
  }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const sourceOnly = usesSourceVideoInput(vm, s) && !vm.usesOutputDuration
    const draft = vm.supportsDraft && s.draft
    return (
      <>
        {!sourceOnly && vm.durations.length > 0 && <Choice label={t('Duration')} options={vm.durations.map((d) => ({ value: d, label: `${d}s` }))} value={s.duration} onChange={(v) => patchPanel({ duration: v })} />}
        {!sourceOnly && vm.aspectRatios.length > 0 && <Choice label={t('Aspect Ratio')} options={vm.aspectRatios.map((a) => ({ value: a, label: a }))} value={s.aspectRatio} onChange={(v) => patchPanel({ aspectRatio: v })} />}
        {!draft && !!vm.resolutions?.length && <Choice label={t('Resolution')} options={vm.resolutions.map((r) => ({ value: r, label: r }))} value={s.resolution} onChange={(v) => patchPanel({ resolution: v })} />}
        {vm.hasAudioToggle && <ToggleField label={t('Generate audio')} on={s.generateAudio} onChange={(v) => patchPanel({ generateAudio: v })} tip={t('Turn off to skip audio generation.')} />}
      </>
    )
  }
  const im = m as ImageModel
  return (
    <>
      {im.aspectRatios.length > 0 && <Choice label={t('Aspect Ratio')} gridMin={78} options={im.aspectRatios.map((a) => ({ value: a, label: aspectRatioDisplayLabel(a) }))} value={s.aspectRatio} onChange={(v) => patchPanel({ aspectRatio: v })} />}
      {!!im.resolutions?.length && <Choice label={t('Resolution')} options={im.resolutions.map((r) => ({ value: r, label: resolutionDisplayLabel(r) }))} value={s.resolution} onChange={(v) => patchPanel({ resolution: v })} />}
      {!!im.qualities?.length && <Choice label={t('Quality')} options={im.qualities.map((q) => ({ value: q, label: capitalize(q) }))} value={s.quality} onChange={(v) => patchPanel({ quality: v })} />}
      {im.maxImages > 1 && <Choice label={t('Count')} options={Array.from({ length: im.maxImages }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} value={s.numImages} onChange={(v) => patchPanel({ numImages: v })} />}
    </>
  )
}

function SettingsButton({ m, s }: { m: AnyModel; s: PanelState }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const doc = useDoc()
  if (!hasAnySettings(m, s)) return null
  const fps = m.kind === 'upscale' && s.upscaleSource ? doc?.manifest.entries.find((e) => e.id === s.upscaleSource)?.sourceFPS : undefined
  const audioToggle = m.kind === 'video' && (m as VideoModel).hasAudioToggle
  const width = m.kind === 'image' ? 270 : m.kind === 'upscale' ? 280 : 220
  return (
    <>
      <button type="button" className="pp-gen-summary hh" data-tip={t('Settings')} onClick={(e) => setAnchor(anchor ? null : rectOf(e.currentTarget))}>
        <span className="ellipsis">{settingsSummary(m, s, fps)}</span>
        {audioToggle && <Icon sf={s.generateAudio ? 'speaker.wave.2.fill' : 'speaker.slash.fill'} size={10} />}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="pp-gen-settings" style={{ width, maxHeight: m.kind === 'upscale' ? 500 : undefined }}>
          <SettingsFields m={m} s={s} />
        </Popover>
      )}
    </>
  )
}

// ---------- Toolbar menus ----------

function modelMenu(set: ModelSet, type: GenType, current: AnyModel | null): MenuItem[] {
  const items: MenuItem[] = []
  for (const g of modelGroups(set, type)) {
    if (g.header) items.push({ kind: 'header', label: g.header })
    for (const m of g.models) items.push({ label: m.displayName, checked: m.id === current?.id, tip: m.description, onSelect: () => setGenModel(set, m.id) })
  }
  items.push({ kind: 'divider' }, { label: t('Add models…'), icon: 'plus', onSelect: openModelSettings })
  return items
}

function ModelPicker({ set, s, m }: { set: ModelSet; s: PanelState; m: AnyModel | null }) {
  return (
    <button type="button" className="pp-gen-model hh" data-tip={t('Model')} onClick={(e) => openMenuBelow(e.currentTarget, modelMenu(set, s.type, m), { minWidth: 200 })}>
      <ProviderMark model={m} />
      <span className="ellipsis">{m?.displayName ?? t('No model')}</span>
      <Icon sf="chevron.down" size={8} strokeWidth={2.5} className="tone-tertiary" />
    </button>
  )
}

function MenuChip({ icon, text, tip, items }: { icon?: SFName; text: string; tip: string; items: () => MenuItem[] }) {
  return (
    <button type="button" className="pp-gen-chip hh" data-tip={tip} onClick={(e) => openMenuBelow(e.currentTarget, items(), { minWidth: 140 })}>
      {icon && <Icon sf={icon} size={10} />}
      <span className="ellipsis">{text}</span>
      <Icon sf="chevron.down" size={7} strokeWidth={2.5} className="tone-tertiary" />
    </button>
  )
}

// ---------- Panel ----------

const MIN_PANEL_SLACK = 60

export function GeneratePanel({ maxHeight }: { maxHeight: number }) {
  const set = useModelSet()
  const s = useGeneration()
  const savedExtra = useSettings((x) => x.settings?.generationPromptExtra ?? 0)
  const [dragExtra, setDragExtra] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const types = useMemo(() => visibleTypes(set), [set])
  const m = selectedModel(set, s)
  const voices = useModelVoices(m)

  // §B7.3: keep the selection valid (keys / disabled models / type visibility); not while a seed is pending.
  useEffect(() => {
    if (s.pendingSeed) return
    if (types.length && !types.includes(s.type)) setGenType(set, types.includes('video') ? 'video' : types[0])
    else normalizeSelection(set)
  }, [set, types, s.type, s.pendingSeed])

  // Clamp the persisted prompt extra so the panel fits its slot.
  const [baseHeight, setBaseHeight] = useState(0)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ta = el.querySelector<HTMLTextAreaElement>('.pp-gen-prompt-editor')
    setBaseHeight(el.offsetHeight - (ta?.offsetHeight ?? 0) + 40)
  }, [s.type, m?.id, s.videoMode, s.imageRefs.length, s.videoRefs.length, s.audioRefs.length, !!s.error])
  const maxExtra = Math.max(0, maxHeight - MIN_PANEL_SLACK - baseHeight)
  const extra = Math.max(0, Math.min(maxExtra, dragExtra ?? savedExtra))

  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const y0 = e.clientY
    const start = extra
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let latest = start
    const move = (ev: PointerEvent) => {
      latest = Math.max(0, Math.min(maxExtra, start + (y0 - ev.clientY)))
      setDragExtra(latest)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setPromptExtra(latest)
      window.setTimeout(() => setDragExtra(null), 0)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  let body: ReactNode
  if (!set.canGenerate || !types.length) {
    body = (
      <div className="pp-gen-empty">
        <Icon sf="key" size={18} className="tone-muted" />
        <span>{t('Add an API key to generate media.')}</span>
        <button type="button" className="pp-capsule secondary small" onClick={openModelSettings}>
          {t('Open Settings')}
        </button>
      </div>
    )
  } else {
    const vm = m?.kind === 'video' ? (m as VideoModel) : null
    const am = m?.kind === 'audio' ? (m as AudioModel) : null
    const modes = vm ? videoModes(vm) : []
    const enabled = canSubmitNow(set)
    body = (
      <>
        {m && (
          <div className="pp-gen-inputs">
            <Inputs m={m} s={s} set={set} />
          </div>
        )}
        <PromptBox m={m} s={s} extra={extra} />
        <div className="pp-gen-toolbar">
          <ModelPicker set={set} s={s} m={m} />
          {vm && modes.length > 1 && (
            <MenuChip
              text={t(VIDEO_MODE_LABELS[usesSourceVideoInput(vm, s) ? 'source' : s.videoMode])}
              tip={t('Input mode')}
              items={() => modes.map((mode): MenuItem => ({ label: t(VIDEO_MODE_LABELS[mode]), checked: (usesSourceVideoInput(vm, s) ? 'source' : s.videoMode) === mode, onSelect: () => setVideoMode(mode) }))}
            />
          )}
          {am && voices && (
            <MenuChip icon="waveform" text={s.voice || am.defaultVoice || t('Voice')} tip={t('Voice')} items={() => voices.map((v): MenuItem => ({ label: v, checked: v === s.voice, onSelect: () => patchPanel({ voice: v }) }))} />
          )}
          {am?.targetLanguages && (
            <MenuChip
              icon="globe"
              text={languageDisplayName(s.targetLanguage)}
              tip={t('Target language')}
              items={() => am.targetLanguages!.map((l): MenuItem => ({ label: languageDisplayName(l), checked: l === s.targetLanguage, onSelect: () => patchPanel({ targetLanguage: l }) }))}
            />
          )}
          {vm?.supportsDraft && (
            <span className="pp-gen-draft">
              <Checkbox checked={s.draft} onChange={(v) => patchPanel({ draft: v })} label={t('Draft')} tip={t('Generate a lower-cost {0} preview that can be enhanced later.', DRAFT_RESOLUTION)} />
            </span>
          )}
          {m && <SettingsButton m={m} s={s} />}
          <span className="pp-gen-spacer" />
          <button
            type="button"
            className="pp-gen-submit"
            disabled={!enabled}
            data-tip={t('Generate')}
            aria-label={t('Generate')}
            onClick={() => void submitGeneration(set)}
          >
            <Icon sf="arrow.up" size={11} strokeWidth={3} />
          </button>
        </div>
      </>
    )
  }

  return (
    <div ref={rootRef} className="pp-gen-panel" data-tour="generation" style={{ maxHeight: Math.max(120, maxHeight - MIN_PANEL_SLACK) }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="pp-gen-resize" onPointerDown={onResizeDown} />
      <div className="pp-gen-header">
        {set.canGenerate && types.length > 0 && (
          <div className="pp-gen-tabs">
            {types.map((t) => {
              const info = TYPE_TABS[t]
              const on = t === s.type
              return (
                <button key={t} type="button" className={`pp-gen-tab${on ? ' on' : ''}`} onClick={() => setGenType(set, t)}>
                  <Icon sf={info.icon} size={12} strokeWidth={on ? 2.4 : 1.8} style={on ? { color: info.color } : undefined} />
                  <span>{info.label}</span>
                </button>
              )
            })}
          </div>
        )}
        <span className="pp-gen-spacer" />
        <ProjectActivityButton />
        <IconButton sf="xmark" size={9} frame={22} tone="tertiary" tip={t('Close')} onClick={closeGenerationPanel} />
      </div>
      {body}
      {s.error && <div className="pp-gen-error">{s.error}</div>}
    </div>
  )
}

/** Mounts the docked panel when open; measures the media tab so the panel never exceeds its slot. */
export function GeneratePanelDock({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const open = useGeneration((x) => x.open)
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || !open) return
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    setH(el.clientHeight)
    return () => ro.disconnect()
  }, [containerRef, open])
  if (!open || !h) return null
  return <GeneratePanel maxHeight={h} />
}

/** Media toolbar Generate button (05 §4.3 #2): shown when any generation provider key is configured. */
export function GenerateToolbarButton() {
  const set = useModelSet()
  const open = useGeneration((x) => x.open)
  if (!set.canGenerate) return null
  return (
    <button type="button" className={`pp-capsule prominent small pp-gen-toolbar-btn${open ? ' active' : ''}`} data-tip={t('Generate')} data-tour="generateButton" onClick={toggleGenerationPanel}>
      {t('Generate')}
    </button>
  )
}
