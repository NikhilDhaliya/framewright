/**
 * Captions tab ▸ Style (spec 07 §1.9): the shared text-style rows edited on a local `TextStyle` value (defaults
 * `TextStyle.caption`), plus the caption Position row after Alignment. Decoration groups start collapsed.
 */
import type { FontCase, RGBA, TextAlignment, TextStyle } from '@core/model'
import { CAPTION_DEFAULT_CENTER, captionTextStyle, snappedCoordinate } from '@core/captions/specBuilder'
import { FontPicker } from '../../inspector/FontPicker'
import { ColorField } from '../../ui/ColorField'
import { MenuValue, Row, Segmented, Switch } from '../../ui/controls'
import { Icon, type SFName } from '../../ui/Icon'
import { Group } from '../../ui/panels'
import { ScrubField } from '../../ui/ScrubField'
import { t } from '../../i18n'

const TRAITS: { key: 'isBold' | 'isItalic' | 'isUnderlined' | 'isStruckThrough'; sf: SFName; tip: string }[] = [
  { key: 'isBold', sf: 'bold', tip: t('Bold') },
  { key: 'isItalic', sf: 'italic', tip: t('Italic') },
  { key: 'isUnderlined', sf: 'underline', tip: t('Underline') },
  { key: 'isStruckThrough', sf: 'strikethrough', tip: t('Strikethrough') },
]

const CASES: { value: FontCase; label: string }[] = [
  { value: 'mixed', label: t('Mixed Case') },
  { value: 'uppercase', label: t('Uppercase') },
  { value: 'lowercase', label: t('Lowercase') },
]

interface Props {
  style: TextStyle
  onStyle: (s: TextStyle) => void
  center: { x: number; y: number }
  onCenter: (c: { x: number; y: number }) => void
  canvas: { w: number; h: number }
}

function num(value: number, onChange: (v: number) => void, o: { min: number; max: number; mult?: number; decimals?: number; suffix?: string; label?: string; width?: number }) {
  return <ScrubField value={value} min={o.min} max={o.max} mult={o.mult} decimals={o.decimals} suffix={o.suffix} label={o.label} width={o.width} sens={1} onChange={onChange} onCommit={onChange} />
}

function color(value: RGBA, onChange: (c: RGBA) => void, alpha = true) {
  return <ColorField value={value} alpha={alpha} onChange={onChange} onCommit={onChange} />
}

export function CaptionStyleControls({ style, onStyle, center, onCenter, canvas }: Props) {
  const defaults = captionTextStyle()
  const set = (patch: Partial<TextStyle>) => onStyle({ ...style, ...patch })
  const deco = <K extends 'border' | 'shadow' | 'background'>(key: K, patch: Partial<TextStyle[K]>) => onStyle({ ...style, [key]: { ...style[key], ...patch } })
  return (
    <>
      <Group title={t('Style')} defaultExpanded={false} onReset={() => onStyle(captionTextStyle())} resetTip={t('Reset: Style')}>
        <Row label={t('Font')} reset={() => set({ fontName: defaults.fontName })}>
          <FontPicker value={style.fontName} onPreview={() => undefined} onCommit={(fontName) => set({ fontName })} onCancel={() => undefined} />
        </Row>
        <Row label={t('Style')}>
          <span className="pp-insp-traits">
            {TRAITS.map((tr) => (
              <button key={tr.key} type="button" className={`pp-insp-trait${style[tr.key] ? ' on' : ''}`} data-tip={tr.tip} onClick={() => set({ [tr.key]: !style[tr.key] })}>
                <Icon sf={tr.sf} size={11} strokeWidth={2.25} />
              </button>
            ))}
          </span>
        </Row>
        <Row label={t('Size')} reset={() => set({ fontSize: defaults.fontSize })}>
          {num(style.fontSize, (fontSize) => set({ fontSize }), { min: 12, max: 300, suffix: ' pt' })}
        </Row>
        <Row label={t('Tracking')} reset={() => set({ tracking: 0 })}>
          {num(style.tracking, (tracking) => set({ tracking }), { min: -20, max: 100, decimals: 1, suffix: ' pt' })}
        </Row>
        <Row label={t('Font Case')} reset={() => set({ fontCase: 'mixed' })}>
          <MenuValue text={CASES.find((x) => x.value === style.fontCase)?.label ?? t('Mixed Case')} minWidth={140} items={() => CASES.map((x) => ({ label: x.label, checked: x.value === style.fontCase, onSelect: () => set({ fontCase: x.value }) }))} />
        </Row>
        <Row label={t('Alignment')} reset={() => set({ alignment: 'center' })}>
          <Segmented<TextAlignment>
            className="pp-insp-align"
            value={style.alignment}
            options={[
              { value: 'left', icon: 'text.alignleft', tip: t('Align Left') },
              { value: 'center', icon: 'text.aligncenter', tip: t('Align Center') },
              { value: 'right', icon: 'text.alignright', tip: t('Align Right') },
            ]}
            onChange={(alignment) => set({ alignment })}
          />
        </Row>
        <Row label={t('Position')} reset={() => onCenter({ ...CAPTION_DEFAULT_CENTER })}>
          {num(center.x, (x) => onCenter({ ...center, x: snappedCoordinate(x) }), { min: -10, max: 10, mult: Math.max(1, canvas.w), label: 'X', width: 56 })}
          {num(center.y, (y) => onCenter({ ...center, y: snappedCoordinate(y) }), { min: -10, max: 10, mult: Math.max(1, canvas.h), label: 'Y', width: 56 })}
        </Row>
        <Row label={t('Color')} reset={() => set({ color: defaults.color })}>
          {color(style.color, (c) => set({ color: c }))}
        </Row>
        <Row label={t('Blur')} reset={() => set({ blur: 0 })}>
          {num(style.blur, (blur) => set({ blur }), { min: 0, max: 100, suffix: ' px' })}
        </Row>
      </Group>
      <Group title={t('Outline')} defaultExpanded={false} accessory={<Switch on={style.border.enabled} onChange={(enabled) => deco('border', { enabled })} />} onReset={() => onStyle({ ...style, border: defaults.border })}>
        <Row label={t('Color')}>{color(style.border.color, (c) => deco('border', { color: c }))}</Row>
        <Row label={t('Width')}>{num(style.border.width, (width) => deco('border', { width }), { min: 0, max: 40, decimals: 1, suffix: ' pt' })}</Row>
      </Group>
      <Group title={t('Shadow')} defaultExpanded={false} accessory={<Switch on={style.shadow.enabled} onChange={(enabled) => deco('shadow', { enabled })} />} onReset={() => onStyle({ ...style, shadow: defaults.shadow })}>
        <Row label={t('Color')}>{color(style.shadow.color, (c) => deco('shadow', { color: { ...c, a: style.shadow.color.a } }), false)}</Row>
        <Row label={t('Opacity')}>{num(style.shadow.color.a, (a) => deco('shadow', { color: { ...style.shadow.color, a } }), { min: 0, max: 1, mult: 100, suffix: '%' })}</Row>
        <Row label={t('Offset')}>
          {num(style.shadow.offsetX, (offsetX) => deco('shadow', { offsetX }), { min: -200, max: 200, decimals: 1, label: 'X', width: 56 })}
          {num(style.shadow.offsetY, (offsetY) => deco('shadow', { offsetY }), { min: -200, max: 200, decimals: 1, label: 'Y', width: 56 })}
        </Row>
        <Row label={t('Blur')}>{num(style.shadow.blur, (blur) => deco('shadow', { blur }), { min: 0, max: 100, decimals: 1, suffix: ' pt' })}</Row>
      </Group>
      <Group title={t('Background')} defaultExpanded={false} accessory={<Switch on={style.background.enabled} onChange={(enabled) => deco('background', { enabled })} />} onReset={() => onStyle({ ...style, background: defaults.background })}>
        <Row label={t('Color')}>{color(style.background.color, (c) => deco('background', { color: { ...c, a: style.background.color.a } }), false)}</Row>
        <Row label={t('Opacity')}>{num(style.background.color.a, (a) => deco('background', { color: { ...style.background.color, a } }), { min: 0, max: 1, mult: 100, suffix: '%' })}</Row>
        <Row label={t('Padding')}>
          {num(style.background.paddingX, (paddingX) => deco('background', { paddingX }), { min: 0, max: 300, decimals: 1, label: 'X', width: 56 })}
          {num(style.background.paddingY, (paddingY) => deco('background', { paddingY }), { min: 0, max: 300, decimals: 1, label: 'Y', width: 56 })}
        </Row>
        <Row label={t('Corner Radius')}>{num(style.background.cornerRadius, (cornerRadius) => deco('background', { cornerRadius }), { min: 0, max: 300, decimals: 1, suffix: ' pt' })}</Row>
      </Group>
    </>
  )
}
