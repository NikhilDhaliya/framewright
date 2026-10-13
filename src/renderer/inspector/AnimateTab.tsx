import type { Clip, RGBA, TextAnimation, TextAnimationPreset } from '@core/model'
import { useTimeline } from '../state/project'
import { ColorField } from '../ui/ColorField'
import { Row } from '../ui/controls'
import { Group } from '../ui/panels'
import { commitPatch, common, previewPatch, type PatchFor } from './model'
import { t } from '../i18n'

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
const PER_WORD_IDS = new Set(PER_WORD.map((p) => p.id))
const DEFAULT_HIGHLIGHT: RGBA = { r: 1, g: 0.85, b: 0, a: 1 }
const DEFAULT_PER_WORD_FRAMES = 6

function Poster({ preset }: { preset: TextAnimationPreset }) {
  const words = ['Aa', 'Bb', 'Cc']
  return (
    <span className={`pp-insp-poster p-${preset}`}>
      {words.map((w, i) => (
        <span key={w} className={i === 1 ? 'focus' : i === 2 ? 'later' : undefined}>
          {preset === 'typewriter' && i === 2 ? 'C' : w}
        </span>
      ))}
    </span>
  )
}

function Gallery({ title, presets, current, onPick }: { title: string; presets: typeof PER_LINE; current: TextAnimationPreset | null; onPick: (p: TextAnimationPreset) => void }) {
  return (
    <div className="pp-insp-gallery-section">
      <span className="pp-insp-gallery-title">{title}</span>
      <div className="pp-insp-gallery">
        {presets.map((p) => (
          <button key={p.id} type="button" className={`pp-insp-preset${current === p.id ? ' on' : ''}`} onClick={() => onPick(p.id)}>
            <span className="pp-insp-preset-cell">
              <Poster preset={p.id} />
            </span>
            <span className="pp-insp-preset-name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function AnimateTab({ clips }: { clips: Clip[] }) {
  const tl = useTimeline()
  const groups = new Set(clips.map((c) => c.captionGroupId).filter(Boolean))
  const ids = [...new Set([...clips.map((c) => c.id), ...(tl?.tracks.flatMap((tr) => tr.clips.filter((c) => c.captionGroupId && groups.has(c.captionGroupId)).map((c) => c.id)) ?? [])])]
  const preset = common(clips, (c) => c.textAnimation?.preset ?? 'none')
  const highlight = common(clips, (c) => c.textAnimation?.highlight ?? DEFAULT_HIGHLIGHT, (a, b) => JSON.stringify(a) === JSON.stringify(b))
  const pick = (p: TextAnimationPreset) => {
    const patch: PatchFor = (c) => {
      if (p === 'none') return { textAnimation: null }
      const next: TextAnimation = { preset: p, perWordFrames: c.textAnimation?.perWordFrames ?? DEFAULT_PER_WORD_FRAMES }
      if (c.textAnimation?.highlight) next.highlight = c.textAnimation.highlight
      return { textAnimation: next }
    }
    void commitPatch(ids, 0, patch, 'Change Animation')
  }
  const highlightPatch = (col: RGBA): PatchFor => (c) => ({ textAnimation: { preset: c.textAnimation?.preset ?? 'none', perWordFrames: c.textAnimation?.perWordFrames ?? DEFAULT_PER_WORD_FRAMES, highlight: col } })
  return (
    <Group title={t('Animation')} contentStyle={{ gap: 14 }}>
      <Gallery title={t('Per line')} presets={PER_LINE} current={preset} onPick={pick} />
      <Gallery title={t('Per word')} presets={PER_WORD} current={preset} onPick={pick} />
      {preset !== null && PER_WORD_IDS.has(preset) && (
        <Row label={t('Highlight')} reset={() => void commitPatch(ids, 0, highlightPatch(DEFAULT_HIGHLIGHT), 'Change Highlight')}>
          <ColorField value={highlight} alpha onChange={(col) => previewPatch(ids, 0, highlightPatch(col))} onCommit={(col) => void commitPatch(ids, 0, highlightPatch(col), 'Change Highlight')} />
        </Row>
      )}
    </Group>
  )
}
