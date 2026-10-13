import { useEffect, useRef, useState } from 'react'
import { rotationAt, textScaleAt, topLeftAt, rawOpacityAt } from '@core/clip'
import { isActive } from '@core/keyframes'
import { defaultTextStyle, type Clip, type FontCase, type RGBA, type TextAlignment, type TextFillMode, type TextStyle } from '@core/model'
import { setTextFillMode } from '@core/ops/agent'
import { fitTextBox } from '@core/ops/project'
import { textMeasurer } from '../render/text'
import { clearPreview } from '../state/ops'
import { ColorField } from '../ui/ColorField'
import { MenuValue, Row, Segmented, Switch } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { KfSlot } from './fields'
import { FontPicker } from './FontPicker'
import { authoritativeClip, commitMutation, commitPatch, common, patchHandlers, previewMutation, previewPatch, useCanvasSize, useInspectorFrame, type PatchFor } from './model'
import { t, tk } from '../i18n'

export const styleOf = (c: Clip): TextStyle => c.textStyle ?? defaultTextStyle()

type Canvas = { w: number; h: number }

/** Partial style write; layout-affecting changes refit the text box to its content. */
function stylePatch(canvas: Canvas, part: (s: TextStyle) => Partial<TextStyle>, refit: boolean): PatchFor {
  return (c) => {
    const cur = styleOf(c)
    const p = part(cur)
    if (!refit) return { textStyle: p }
    return { textStyle: p, textBox: textMeasurer.measure(c.textContent ?? '', { ...cur, ...p }, canvas.w, canvas.h) }
  }
}

function TextContentField({ clips, canvas }: { clips: Clip[]; canvas: Canvas }) {
  const single = clips.length === 1 ? clips[0] : null
  const [focused, setFocused] = useState(false)
  const [text, setText] = useState(single?.textContent ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!focused) setText(single?.textContent ?? '')
  }, [single?.textContent, focused])
  const ids = single ? [single.id] : []
  const patchFor = (content: string): PatchFor => (c) => ({ textContent: content, textBox: textMeasurer.measure(content, styleOf(c), canvas.w, canvas.h) })
  return (
    <textarea
      ref={ref}
      className={`pp-value-field pp-insp-textarea${single ? '' : ' disabled'}`}
      data-active={focused || undefined}
      disabled={!single}
      value={single ? text : ''}
      placeholder={single ? '' : t('Multiple text clips')}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        setText(e.target.value)
        previewPatch(ids, 0, patchFor(e.target.value))
      }}
      onBlur={() => {
        setFocused(false)
        if (single && text !== authoritativeClip(single.id)?.textContent) void commitPatch(ids, 0, patchFor(text), 'Change Text')
        else clearPreview()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') ref.current?.blur()
      }}
    />
  )
}

const TRAITS: { key: 'isBold' | 'isItalic' | 'isUnderlined' | 'isStruckThrough' | 'isOverlined'; sf: SFName; tip: string; layout: boolean }[] = [
  { key: 'isBold', sf: 'bold', tip: tk('Bold'), layout: true },
  { key: 'isItalic', sf: 'italic', tip: tk('Italic'), layout: true },
  { key: 'isUnderlined', sf: 'underline', tip: tk('Underline'), layout: false },
  { key: 'isStruckThrough', sf: 'strikethrough', tip: tk('Strikethrough'), layout: false },
  { key: 'isOverlined', sf: 'textformat', tip: tk('Overline'), layout: false },
]

const CASES: { value: FontCase; label: string }[] = [
  { value: 'mixed', label: t('Mixed') },
  { value: 'uppercase', label: t('UPPERCASE') },
  { value: 'lowercase', label: t('lowercase') },
]

const FILLS: { value: TextFillMode; label: string }[] = [
  { value: 'color', label: t('Color') },
  { value: 'footage', label: t('Footage') },
  { value: 'inverted', label: t('Inverted') },
]

function colorHandlers(ids: string[], label: string, patch: (c: RGBA) => PatchFor) {
  return {
    onChange: (c: RGBA) => previewPatch(ids, 0, patch(c)),
    onCommit: (c: RGBA) => void commitPatch(ids, 0, patch(c), label),
  }
}

function DecorationGroup({ title, enabled, onToggle, onReset, children }: { title: string; enabled: boolean | null; onToggle: (on: boolean) => void; onReset: () => void; children: React.ReactNode }) {
  return (
    <Group title={title} defaultExpanded={false} accessory={<Switch on={enabled === true} onChange={onToggle} />} onReset={onReset} disabled={enabled !== true}>
      {children}
    </Group>
  )
}

export function ContentTab({ clips }: { clips: Clip[] }) {
  const frame = useInspectorFrame()
  const canvas = useCanvasSize()
  const { w: W, h: H } = canvas
  const ids = clips.map((c) => c.id)
  const s = (read: (st: TextStyle) => number) => common(clips, (c) => read(styleOf(c)))
  const sb = (read: (st: TextStyle) => boolean) => common(clips, (c) => read(styleOf(c)))
  const sp = (label: string, part: (v: number) => (st: TextStyle) => Partial<TextStyle>, refit = true) => patchHandlers(ids, 0, label, (v) => stylePatch(canvas, part(v), refit))
  const commitStyle = (label: string, part: (st: TextStyle) => Partial<TextStyle>, refit: boolean) => void commitPatch(ids, 0, stylePatch(canvas, part, refit), label)
  const fill = common(clips, (c) => c.textFillMode ?? 'color')
  const font = common(clips.map((c) => authoritativeClip(c.id) ?? c), (c) => styleOf(c).fontName)
  const size = common(clips, (c) => styleOf(c).fontSize * textScaleAt(c, frame))
  const alignment = common(clips, (c) => styleOf(c).alignment)
  const fontCase = common(clips, (c) => styleOf(c).fontCase)
  const color = common(clips, (c) => styleOf(c).color, (a, b) => JSON.stringify(a) === JSON.stringify(b))
  const sizePatch = (v: number): PatchFor => (c) => {
    const st = styleOf(c)
    if (isActive(c.scaleTrack)) {
      const ratio = v / st.fontSize / (st.fontScale || 1)
      return { size: { width: c.transform.width * ratio, height: c.transform.height * ratio } }
    }
    const next = { ...st, fontSize: v / (st.fontScale || 1) }
    return { textStyle: { fontSize: next.fontSize }, textBox: textMeasurer.measure(c.textContent ?? '', next, W, H) }
  }
  const tiltHandlers = (axis: 'rotationX' | 'rotationY') => ({
    onChange: (v: number) => previewMutation(ids, (c) => void (c.transform[axis] = v)),
    onCommit: (v: number) => void commitMutation(ids, (c) => void (c.transform[axis] = v), 'Change Tilt'),
    onCancel: clearPreview,
  })
  const decoration = <K extends 'border' | 'shadow' | 'background'>(key: K) => ({
    enabled: common(clips, (c) => styleOf(c)[key].enabled),
    toggle: (on: boolean) => commitStyle(`Change ${key === 'border' ? 'Outline' : key === 'shadow' ? 'Shadow' : 'Background'}`, (st) => ({ [key]: { ...st[key], enabled: on } }), true),
    num: (read: (v: TextStyle[K]) => number) => common(clips, (c) => read(styleOf(c)[key])),
    set: (label: string, write: (v: number, cur: TextStyle[K]) => Partial<TextStyle[K]>) => sp(label, (v) => (st) => ({ [key]: { ...st[key], ...write(v, st[key]) } })),
    color: (read: (v: TextStyle[K]) => RGBA) => common(clips, (c) => read(styleOf(c)[key]), (a, b) => JSON.stringify(a) === JSON.stringify(b)),
    colorSet: (label: string, write: (c: RGBA, cur: TextStyle[K]) => Partial<TextStyle[K]>) =>
      colorHandlers(ids, label, (col) => stylePatch(canvas, (st) => ({ [key]: { ...st[key], ...write(col, st[key]) } }), false)),
    reset: (label: string, defaults: TextStyle[K]) => commitStyle(label, () => ({ [key]: defaults }), true),
  })
  const outline = decoration('border')
  const shadow = decoration('shadow')
  const background = decoration('background')
  const defaults = defaultTextStyle()

  return (
    <>
      <Group title={t('Text')}>
        <TextContentField clips={clips} canvas={canvas} />
      </Group>
      <Group title={t('Style')}>
        <Row label={t('Font')}>
          <FontPicker
            value={font}
            onPreview={(name) => previewPatch(ids, 0, stylePatch(canvas, () => ({ fontName: name }), true))}
            onCommit={(name) => commitStyle('Change Font', () => ({ fontName: name }), true)}
            onCancel={clearPreview}
          />
        </Row>
        <Row label={t('Style')}>
          <span className="pp-insp-traits">
            {TRAITS.map((tr) => {
              const v = sb((st) => st[tr.key])
              return (
                <button
                  key={tr.key}
                  type="button"
                  className={`pp-insp-trait${v ? ' on' : ''}${tr.key === 'isOverlined' ? ' overline' : ''}`}
                  data-tip={t(tr.tip)}
                  onClick={() => commitStyle(`Change ${tr.tip}`, () => ({ [tr.key]: v === null ? true : !v }), tr.layout)}
                >
                  <Icon sf={v === null ? 'minus' : tr.sf} size={11} strokeWidth={2.25} />
                </button>
              )
            })}
          </span>
        </Row>
        <Row
          label={t('Size')}
          reset={() =>
            void commitMutation(ids, (c) => {
              delete c.scaleTrack
              const st = styleOf(c)
              const next = { ...st, fontSize: defaults.fontSize / (st.fontScale || 1) }
              c.textStyle = next
              fitTextBox(c, textMeasurer.measure(c.textContent ?? '', next, W, H))
            }, 'Reset Text Size')
          }
        >
          <ScrubField value={size} min={12} max={300} suffix=" pt" sens={1} {...patchHandlers(ids, frame, 'Change Text Size', sizePatch)} />
          <KfSlot clips={clips} property="scale" />
        </Row>
        <Row label={t('Width')}>
          <ScrubField value={s((st) => st.widthScale)} min={0.1} max={10} mult={100} suffix="%" sens={1} {...sp('Change Width', (v) => () => ({ widthScale: v }))} />
        </Row>
        <Row label={t('Height')}>
          <ScrubField value={s((st) => st.heightScale)} min={0.1} max={10} mult={100} suffix="%" sens={1} {...sp('Change Height', (v) => () => ({ heightScale: v }))} />
        </Row>
        <Row label={t('Tracking')}>
          <ScrubField value={s((st) => st.tracking)} min={-20} max={100} decimals={1} suffix=" pt" sens={1} {...sp('Change Tracking', (v) => () => ({ tracking: v }))} />
        </Row>
        <Row label={t('Line Spacing')}>
          <ScrubField value={s((st) => st.lineSpacing)} min={-100} max={300} decimals={1} suffix=" pt" sens={1} {...sp('Change Line Spacing', (v) => () => ({ lineSpacing: v }))} />
        </Row>
        <Row label={t('Font Case')}>
          <MenuValue
            text={CASES.find((x) => x.value === fontCase)?.label ?? '—'}
            minWidth={140}
            items={() => CASES.map((x) => ({ label: x.label, checked: x.value === fontCase, onSelect: () => commitStyle('Change Font Case', () => ({ fontCase: x.value }), true) }))}
          />
        </Row>
        <Row label={t('Alignment')}>
          <Segmented<TextAlignment>
            className="pp-insp-align"
            value={alignment}
            options={[
              { value: 'left', icon: 'text.alignleft', tip: t('Align Left') },
              { value: 'center', icon: 'text.aligncenter', tip: t('Align Center') },
              { value: 'right', icon: 'text.alignright', tip: t('Align Right') },
            ]}
            onChange={(v) => commitStyle('Change Alignment', () => ({ alignment: v }), false)}
          />
        </Row>
        <Row label={t('Position')}>
          <ScrubField label="X" width={56} value={common(clips, (c) => topLeftAt(c, frame).a)} min={-10} max={10} mult={W} sens={1} {...patchHandlers(ids, frame, 'Change Position', (v) => () => ({ topLeft: { x: v } }))} />
          <ScrubField label="Y" width={56} value={common(clips, (c) => topLeftAt(c, frame).b)} min={-10} max={10} mult={H} sens={1} {...patchHandlers(ids, frame, 'Change Position', (v) => () => ({ topLeft: { y: v } }))} />
        </Row>
        <Row label={t('Tilt')}>
          <ScrubField label="X" width={56} value={common(clips, (c) => c.transform.rotationX)} min={-89} max={89} suffix="°" sens={1} {...tiltHandlers('rotationX')} />
          <ScrubField label="Y" width={56} value={common(clips, (c) => c.transform.rotationY)} min={-89} max={89} suffix="°" sens={1} {...tiltHandlers('rotationY')} />
        </Row>
        <Row label={t('Rotation')}>
          <ScrubField value={common(clips, (c) => rotationAt(c, frame))} min={-3600} max={3600} suffix="°" sens={1} {...patchHandlers(ids, frame, 'Change Rotation', (v) => () => ({ rotation: v }))} />
        </Row>
        <Row label={t('Fill')}>
          <MenuValue
            text={FILLS.find((x) => x.value === fill)?.label ?? '—'}
            minWidth={140}
            items={() => FILLS.map((x) => ({ label: x.label, checked: x.value === fill, onSelect: () => void commitMutation(ids, (c) => setTextFillMode(c, x.value), 'Change Fill') }))}
          />
        </Row>
        {fill !== null && fill !== 'inverted' && (
          <Row label={t('Color')}>
            <ColorField value={color} alpha {...colorHandlers(ids, 'Change Color', (col) => stylePatch(canvas, () => ({ color: col }), false))} />
          </Row>
        )}
        <Row label={t('Opacity')}>
          <ScrubField value={common(clips, (c) => rawOpacityAt(c, frame))} min={0} max={1} mult={100} suffix="%" sens={1} {...patchHandlers(ids, frame, 'Change Opacity', (v) => () => ({ opacity: v }))} />
        </Row>
        <Row label={t('Blur')}>
          <ScrubField value={s((st) => st.blur)} min={0} max={100} suffix=" px" sens={1} {...sp('Change Blur', (v) => () => ({ blur: v }), false)} />
        </Row>
      </Group>
      {fill === 'color' && (
        <>
          <DecorationGroup title={t('Outline')} enabled={outline.enabled} onToggle={outline.toggle} onReset={() => outline.reset('Reset Outline', defaults.border)}>
            <Row label={t('Color')}>
              <ColorField value={outline.color((b) => b.color)} alpha {...outline.colorSet('Change Outline', (c) => ({ color: c }))} />
            </Row>
            <Row label={t('Width')}>
              <ScrubField value={outline.num((b) => b.width)} min={0} max={40} decimals={1} suffix=" pt" sens={1} {...outline.set('Change Outline', (v) => ({ width: v }))} />
            </Row>
          </DecorationGroup>
          <DecorationGroup title={t('Shadow')} enabled={shadow.enabled} onToggle={shadow.toggle} onReset={() => shadow.reset('Reset Shadow', defaults.shadow)}>
            <Row label={t('Color')}>
              <ColorField value={shadow.color((x) => x.color)} alpha={false} {...shadow.colorSet('Change Shadow', (c, cur) => ({ color: { ...c, a: cur.color.a } }))} />
            </Row>
            <Row label={t('Opacity')}>
              <ScrubField value={shadow.num((x) => x.color.a)} min={0} max={1} mult={100} suffix="%" sens={1} {...shadow.set('Change Shadow', (v, cur) => ({ color: { ...cur.color, a: v } }))} />
            </Row>
            <Row label={t('Offset')}>
              <ScrubField label="X" width={56} value={shadow.num((x) => x.offsetX)} min={-200} max={200} decimals={1} sens={1} {...shadow.set('Change Shadow', (v) => ({ offsetX: v }))} />
              <ScrubField label="Y" width={56} value={shadow.num((x) => x.offsetY)} min={-200} max={200} decimals={1} sens={1} {...shadow.set('Change Shadow', (v) => ({ offsetY: v }))} />
            </Row>
            <Row label={t('Blur')}>
              <ScrubField value={shadow.num((x) => x.blur)} min={0} max={100} decimals={1} suffix=" pt" sens={1} {...shadow.set('Change Shadow', (v) => ({ blur: v }))} />
            </Row>
          </DecorationGroup>
          <DecorationGroup title={t('Background')} enabled={background.enabled} onToggle={background.toggle} onReset={() => background.reset('Reset Background', defaults.background)}>
            <Row label={t('Color')}>
              <ColorField value={background.color((x) => x.color)} alpha={false} {...background.colorSet('Change Background', (c, cur) => ({ color: { ...c, a: cur.color.a } }))} />
            </Row>
            <Row label={t('Opacity')}>
              <ScrubField value={background.num((x) => x.color.a)} min={0} max={1} mult={100} suffix="%" sens={1} {...background.set('Change Background', (v, cur) => ({ color: { ...cur.color, a: v } }))} />
            </Row>
            <Row label={t('Padding')}>
              <ScrubField label="X" width={56} value={background.num((x) => x.paddingX)} min={0} max={300} decimals={1} sens={1} {...background.set('Change Background', (v) => ({ paddingX: v }))} />
              <ScrubField label="Y" width={56} value={background.num((x) => x.paddingY)} min={0} max={300} decimals={1} sens={1} {...background.set('Change Background', (v) => ({ paddingY: v }))} />
            </Row>
            <Row label={t('Center')}>
              <ScrubField label="X" width={56} value={background.num((x) => x.offsetX)} min={-500} max={500} decimals={1} sens={1} {...background.set('Change Background', (v) => ({ offsetX: v }))} />
              <ScrubField label="Y" width={56} value={background.num((x) => x.offsetY)} min={-500} max={500} decimals={1} sens={1} {...background.set('Change Background', (v) => ({ offsetY: v }))} />
            </Row>
            <Row label={t('Corner Radius')}>
              <ScrubField value={background.num((x) => x.cornerRadius)} min={0} max={300} decimals={1} suffix=" pt" sens={1} {...background.set('Change Background', (v) => ({ cornerRadius: v }))} />
            </Row>
            <Row label={t('Outline Color')}>
              <ColorField value={background.color((x) => x.outlineColor)} alpha {...background.colorSet('Change Background', (c) => ({ outlineColor: c }))} />
            </Row>
            <Row label={t('Outline Width')}>
              <ScrubField value={background.num((x) => x.outlineWidth)} min={0} max={40} decimals={1} suffix=" pt" sens={1} {...background.set('Change Background', (v) => ({ outlineWidth: v }))} />
            </Row>
          </DecorationGroup>
        </>
      )}
    </>
  )
}
