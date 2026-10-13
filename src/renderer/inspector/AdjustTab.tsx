import { useState, type ReactNode } from 'react'
import { blurRadiusAt } from '@core/clip'
import type { Clip } from '@core/model'
import { commitOp } from '../state/ops'
import { Checkbox, MiddleTruncate } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { Slider } from '../ui/Slider'
import { ColorWheels } from './ColorWheels'
import { CurveEditor } from './CurveEditor'
import { editFor, effectHandlers, effectOf, paramOf, specOf } from './effectEdits'
import { HueCurveEditor } from './HueCurveEditor'
import { common, patchHandlers, useInspectorFrame } from './model'
import { ChromaEyedropper, useChromaSampler } from '../extras/ChromaSampler'
import { t, tk } from '../i18n'

interface SliderSpec {
  label: string
  type: string
  key: string
  unit?: string
  gradient?: string
}

interface Subgroup {
  title: string
  expanded: boolean
  rows: SliderSpec[]
}

const TEMP_GRADIENT = 'var(--pp-slider-temp-gradient)'
const TINT_GRADIENT = 'var(--pp-slider-tint-gradient)'

const BASIC: Subgroup[] = [
  {
    title: tk('Tone'),
    expanded: true,
    rows: [
      { label: tk('Exposure'), type: 'color.exposure', key: 'ev' },
      { label: tk('Contrast'), type: 'color.contrast', key: 'amount' },
      { label: tk('Highlights'), type: 'color.highlightsShadows', key: 'highlights' },
      { label: tk('Shadows'), type: 'color.highlightsShadows', key: 'shadows' },
      { label: tk('Blacks'), type: 'color.blacksWhites', key: 'blacks' },
      { label: tk('Whites'), type: 'color.blacksWhites', key: 'whites' },
    ],
  },
  {
    title: tk('White Balance'),
    expanded: true,
    rows: [
      { label: tk('Temperature'), type: 'color.temperature', key: 'temperature', unit: 'K', gradient: TEMP_GRADIENT },
      { label: tk('Tint'), type: 'color.temperature', key: 'tint', gradient: TINT_GRADIENT },
    ],
  },
  {
    title: tk('Presence'),
    expanded: true,
    rows: [
      { label: tk('Vibrance'), type: 'color.vibrance', key: 'amount' },
      { label: tk('Saturation'), type: 'color.saturation', key: 'amount' },
    ],
  },
]

const EFFECTS: Subgroup[] = [
  {
    title: tk('Detail'),
    expanded: false,
    rows: [
      { label: tk('Sharpen'), type: 'blur.sharpen', key: 'amount' },
      { label: tk('Noise Reduction'), type: 'blur.noiseReduction', key: 'amount' },
      { label: tk('Clarity'), type: 'detail.clarity', key: 'clarity' },
      { label: tk('Dehaze'), type: 'detail.clarity', key: 'dehaze' },
    ],
  },
  { title: tk('Blur'), expanded: false, rows: [] },
  {
    title: tk('Motion Blur'),
    expanded: false,
    rows: [
      { label: tk('Amount'), type: 'blur.motion', key: 'radius', unit: 'px' },
      { label: tk('Angle'), type: 'blur.motion', key: 'angle', unit: '°' },
    ],
  },
  {
    title: tk('Vignette'),
    expanded: false,
    rows: [
      { label: tk('Amount'), type: 'stylize.vignette', key: 'amount' },
      { label: tk('Midpoint'), type: 'stylize.vignette', key: 'midpoint' },
      { label: tk('Roundness'), type: 'stylize.vignette', key: 'roundness' },
      { label: tk('Feather'), type: 'stylize.vignette', key: 'feather' },
    ],
  },
  {
    title: tk('Film Grain'),
    expanded: false,
    rows: [
      { label: tk('Amount'), type: 'stylize.grain', key: 'amount' },
      { label: tk('Size'), type: 'stylize.grain', key: 'size' },
    ],
  },
  {
    title: tk('Glow'),
    expanded: false,
    rows: [
      { label: tk('Intensity'), type: 'stylize.glow', key: 'intensity' },
      { label: tk('Radius'), type: 'stylize.glow', key: 'radius', unit: 'px' },
      { label: tk('Threshold'), type: 'stylize.glow', key: 'threshold' },
      { label: tk('Warmth'), type: 'stylize.glow', key: 'warmth' },
    ],
  },
  {
    title: tk('Chroma Key'),
    expanded: false,
    rows: [
      { label: tk('Range'), type: 'key.chroma', key: 'tolerance' },
      { label: tk('Spill'), type: 'key.chroma', key: 'spill' },
    ],
  },
]

const typesOf = (groups: Subgroup[]) => [...new Set(groups.flatMap((g) => g.rows.map((r) => r.type)))]
const BASIC_TYPES = typesOf(BASIC)
const EFFECT_TYPES = [...typesOf(EFFECTS), 'blur.gaussian', 'stylize.invert']

function SliderRow({ clips, spec }: { clips: Clip[]; spec: SliderSpec }) {
  const ids = clips.map((c) => c.id)
  const p = specOf(spec.type, spec.key)
  const span = p.max - p.min
  const first = paramOf(clips[0], spec.type, spec.key)
  const value = common(clips, (c) => paramOf(c, spec.type, spec.key))
  const h = effectHandlers(ids, `Adjust ${spec.label}`, (v) => [editFor(ids, spec.type, spec.key, v)])
  return (
    <div className="pp-insp-slider-row">
      <span className="pp-insp-slider-label ellipsis">{t(spec.label)}</span>
      <Slider value={first} min={p.min} max={p.max} defaultValue={p.default} gradient={spec.gradient} onChange={h.onChange} onCommit={h.onCommit} />
      <ScrubField value={value} min={p.min} max={p.max} decimals={span <= 20 ? 2 : 0} suffix={spec.unit ? ` ${spec.unit}` : ''} sens={Math.max(0.01, span / 200)} {...h} />
    </div>
  )
}

const subgroupState = new Map<string, boolean>()

function SubgroupView({ title, expanded: initial, accessory, children }: { title: string; expanded: boolean; accessory?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => subgroupState.get(title) ?? initial)
  return (
    <div className="pp-insp-subgroup">
      <div
        className="pp-insp-subgroup-header"
        onClick={() => {
          subgroupState.set(title, !open)
          setOpen(!open)
        }}
      >
        <span className="pp-insp-subgroup-chevron">
          <Icon sf={open ? 'chevron.down' : 'chevron.right'} size={9} strokeWidth={2.25} />
        </span>
        <span className="pp-insp-subgroup-title">{t(title)}</span>
        <span style={{ flex: 1 }} />
        {accessory}
      </div>
      {open && <div className="pp-insp-subgroup-rows">{children}</div>}
    </div>
  )
}

/** Section chrome: reset (when the section has effects) and the enable checkbox; disabled content dims. */
function Section({ title, clips, types, defaultExpanded, children }: { title: string; clips: Clip[]; types: string[]; defaultExpanded: boolean; children: ReactNode }) {
  const ids = clips.map((c) => c.id)
  const present = types.filter((t) => effectOf(clips[0], t))
  // While the chroma key sampler live-disables the key, the section still reads as enabled (`AdjustSectionState`).
  const samplingKey = useChromaSampler((st) => types.includes('key.chroma') && clips.some((c) => c.id === st.clipId))
  const enabled = (present.length > 0 && present.every((t) => effectOf(clips[0], t)!.enabled)) || (present.length > 0 && samplingKey)
  const disabled = present.length > 0 && !enabled
  const accessory = (
    <span className="pp-insp-section-acc">
      {present.length > 0 && (
        <button
          type="button"
          className="pp-iconbtn hh tone-tertiary"
          style={{ width: 22, height: 22 }}
          data-tip={t('Reset {0}', t(title))}
          onClick={() => void commitOp('editEffects', { ids, edits: present.map((type) => ({ type, remove: true })), label: `Reset ${title}` }, { quiet: true })}
        >
          <Icon sf="arrow.counterclockwise" size={11} />
        </button>
      )}
      <Checkbox
        checked={enabled}
        disabled={!present.length}
        tip={present.length ? t('Enable: {0}', t(title)) : t('No adjustments yet')}
        onChange={(on) => void commitOp('editEffects', { ids, edits: present.map((type) => ({ type, enabled: on })), label: on ? `Enable ${title}` : `Disable ${title}` }, { quiet: true })}
      />
    </span>
  )
  return (
    <Group title={t(title)} stateId={title} defaultExpanded={defaultExpanded} accessory={accessory} contentStyle={{ gap: 10, padding: '10px 14px', opacity: disabled ? 0.35 : 1 }}>
      {children}
    </Group>
  )
}

function BlurRow({ clips }: { clips: Clip[] }) {
  const frame = useInspectorFrame()
  const ids = clips.map((c) => c.id)
  return (
    <div className="pp-insp-slider-row">
      <span className="pp-insp-slider-label">{t('Blur')}</span>
      <span style={{ flex: 1 }} />
      <ScrubField value={common(clips, (c) => blurRadiusAt(c, frame))} min={0} max={100} suffix=" px" sens={1} {...patchHandlers(ids, frame, 'Change Blur', (v) => () => ({ blur: v }))} />
    </div>
  )
}

function LutRows({ clips }: { clips: Clip[] }) {
  const ids = clips.map((c) => c.id)
  const lut = effectOf(clips[0], 'color.lut')
  const path = lut?.params.path?.string
  const name = path ? path.split('/').pop()! : null
  const choose = async () => {
    const [file] = await window.palmier.media.pickFiles('lut')
    if (file) void commitOp('editEffects', { ids, edits: [{ type: 'color.lut', strings: { path: file }, params: { intensity: lut?.params.intensity?.value ?? 1 } }], label: 'Apply LUT' }, { quiet: true })
  }
  const intensity = common(clips, (c) => paramOf(c, 'color.lut', 'intensity'))
  const h = effectHandlers(ids, 'Adjust LUT Intensity', (v) => [{ type: 'color.lut', params: { intensity: v } }])
  return (
    <>
      <div className="pp-insp-slider-row lut">
        <span className="pp-insp-slider-label">{t('File')}</span>
        <button type="button" className="pp-insp-lut-button" data-tip={path ?? t('Choose a .cube LUT file')} onClick={() => void choose()}>
          <Icon sf="square.stack.3d.up" size={10} className="tone-tertiary" />
          {name ? <MiddleTruncate text={name} /> : <span className="tone-tertiary">{t('Choose…')}</span>}
          <span style={{ flex: 1 }} />
        </button>
      </div>
      {path && (
        <div className="pp-insp-slider-row lut">
          <span className="pp-insp-slider-label">{t('Intensity')}</span>
          <Slider value={paramOf(clips[0], 'color.lut', 'intensity')} min={0} max={1} defaultValue={1} onChange={h.onChange} onCommit={h.onCommit} />
          <ScrubField value={intensity} min={0} max={1} mult={100} suffix="%" sens={0.5} {...h} />
        </div>
      )}
    </>
  )
}

export function AdjustTab({ clips }: { clips: Clip[] }) {
  if (!clips.length) return null
  const ids = clips.map((c) => c.id)
  const invert = common(clips, (c) => !!effectOf(c, 'stylize.invert'))
  return (
    <>
      <Section title={tk('Basic Correction')} clips={clips} types={BASIC_TYPES} defaultExpanded>
        {BASIC.map((g) => (
          <SubgroupView key={g.title} title={g.title} expanded={g.expanded}>
            {g.rows.map((r) => (
              <SliderRow key={`${r.type}.${r.key}`} clips={clips} spec={r} />
            ))}
          </SubgroupView>
        ))}
      </Section>
      <Section title={tk('Curves')} clips={clips} types={['color.curves']} defaultExpanded={false}>
        <CurveEditor clips={clips} />
      </Section>
      <Section title={tk('Color Wheels')} clips={clips} types={['color.wheels']} defaultExpanded={false}>
        <ColorWheels clips={clips} />
      </Section>
      <Section title={tk('Hue Curves')} clips={clips} types={['color.hueCurves']} defaultExpanded={false}>
        <HueCurveEditor clips={clips} />
      </Section>
      <Section title={tk('LUTs')} clips={clips} types={['color.lut']} defaultExpanded={false}>
        <LutRows clips={clips} />
      </Section>
      <Section title={tk('Effects')} clips={clips} types={EFFECT_TYPES} defaultExpanded={false}>
        {EFFECTS.map((g) => (
          <SubgroupView key={g.title} title={g.title} expanded={g.expanded} accessory={g.title === 'Chroma Key' && clips.length === 1 ? <ChromaEyedropper clipId={clips[0].id} /> : undefined}>
            {g.title === 'Blur' ? <BlurRow clips={clips} /> : g.rows.map((r) => <SliderRow key={`${r.type}.${r.key}`} clips={clips} spec={r} />)}
          </SubgroupView>
        ))}
        <div className="pp-insp-invert">
          <Checkbox
            checked={invert === true}
            label={t('Invert Colors')}
            onChange={(on) => void commitOp('editEffects', { ids, edits: [on ? { type: 'stylize.invert' } : { type: 'stylize.invert', remove: true }], label: 'Invert Colors' }, { quiet: true })}
          />
        </div>
      </Section>
    </>
  )
}

