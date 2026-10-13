import { useState } from 'react'
import { cropAt, rawOpacityAt, rotationAt, sizeAt, topLeftAt } from '@core/clip'
import { BLEND_MODES, defaultCrop, fitTransform, isIdentityCrop, type BlendMode, type Clip, type Crop } from '@core/model'
import { sourcePixelSize } from '@core/ops/agent'
import { cropFittingAspect, type PixelSize } from '@core/ops/layout'
import { setEditor, useEditor, type CropAspectLock } from '../state/editor'
import { CROP_RATIO_PRESETS, lockForRatio, lockLabel, sameLock } from '../preview/cropMath'
import { getDoc } from '../state/project'
import { MenuValue, Row } from '../ui/controls'
import { Icon } from '../ui/Icon'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { Group } from '../ui/panels'
import { ScrubField } from '../ui/ScrubField'
import { beep } from '../ui/toast'
import { IconToggle, KfSlot, PlaybackGroup } from './fields'
import { commitMutation, commitPatch, common, patchHandlers, useCanvasSize, useInspectorFrame } from './model'
import { t } from '../i18n'

export const BLEND_NAMES: Record<BlendMode, string> = {
  normal: t('Normal'), darken: t('Darken'), multiply: t('Multiply'), colorBurn: t('Color Burn'), lighten: t('Lighten'), screen: t('Screen'), colorDodge: t('Color Dodge'),
  overlay: t('Overlay'), softLight: t('Soft Light'), hardLight: t('Hard Light'), difference: t('Difference'), exclusion: t('Exclusion'), hue: t('Hue'),
  saturation: t('Saturation'), color: t('Color'), luminosity: t('Luminosity'),
}

const ROTATION_SNAP = 4
const snapRotation = (deg: number) => {
  const nearest = Math.round(deg / 90) * 90
  return Math.abs(deg - nearest) <= ROTATION_SNAP ? nearest : deg
}

const sourceSize = (c: Clip): PixelSize | null => {
  const doc = getDoc()
  return doc ? sourcePixelSize(doc, c) : null
}

const visibleAspect = (src: PixelSize, crop: Crop) => (src.width * (1 - crop.left - crop.right)) / Math.max(1e-6, src.height * (1 - crop.top - crop.bottom))

function fitFor(c: Clip, W: number, H: number) {
  const src = sourceSize(c)
  return fitTransform(src?.width ?? 0, src?.height ?? 0, W, H)
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
const g6 = (v: number) => String(Number(v.toPrecision(6)))

/** Mac `displayedCropAspectRatio`: the locked ratio, else the reduced source size (identity crop) or the visible aspect. */
function displayedRatio(lock: CropAspectLock, src: PixelSize, crop: Crop): [string, string] {
  if (lock.kind === 'fixed') {
    const [w, h] = lock.label.split(':')
    return [w, h]
  }
  if (isIdentityCrop(crop)) {
    const d = gcd(Math.round(src.width), Math.round(src.height)) || 1
    return [String(Math.round(src.width) / d), String(Math.round(src.height) / d)]
  }
  const a = visibleAspect(src, crop)
  return [g6(Math.max(a, 1)), g6(Math.max(1 / a, 1))]
}

function CropAspectFields({ ratio, onCommit }: { ratio: [string, string]; onCommit: (w: number, h: number) => void }) {
  const [w0, h0] = ratio
  const [w, setW] = useState(w0)
  const [h, setH] = useState(h0)
  const apply = () => {
    const nw = Number(w.replace(',', '.'))
    const nh = Number(h.replace(',', '.'))
    if (!(nw > 0 && nh > 0 && Number.isFinite(nw) && Number.isFinite(nh))) {
      beep()
      setW(w0)
      setH(h0)
      return
    }
    onCommit(nw, nh)
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter') apply()
    if (e.key === 'Escape') {
      setW(w0)
      setH(h0)
    }
  }
  return (
    <span className="pp-value-field pp-insp-crop-fields">
      <input className="mono right" value={w} onChange={(e) => setW(e.target.value)} onBlur={apply} onKeyDown={keys} />
      <span className="tone-tertiary">:</span>
      <input className="mono" value={h} onChange={(e) => setH(e.target.value)} onBlur={apply} onKeyDown={keys} />
    </span>
  )
}

function CropRow({ clips, frame }: { clips: Clip[]; frame: number }) {
  const editing = useEditor((s) => s.cropEditing)
  const single = clips.length === 1 ? clips[0] : null
  const crop = single ? cropAt(single, frame) : defaultCrop()
  const src = single ? sourceSize(single) : null
  const ids = clips.map((c) => c.id)
  const lock = useEditor((s) => s.cropAspectLock)
  // Mac `applyCropPreset`: sets the editor-wide lock; Original resets the crop; a ratio commits a centred fitting crop
  // only when the current aspect differs by more than 1e-4. Freeform only unlocks.
  const applyLock = (next: CropAspectLock) => {
    if (!single) return
    setEditor({ cropAspectLock: next })
    if (next.kind === 'original') return void commitPatch(ids, frame, () => ({ crop: defaultCrop() }), 'Change Crop')
    if (next.kind !== 'fixed' || !src) return
    if (Math.abs(visibleAspect(src, crop) - next.ratio) <= 1e-4) return
    void commitPatch(ids, frame, () => ({ crop: cropFittingAspect(src, next.ratio) }), 'Change Crop')
  }
  const items = (): MenuItem[] =>
    [{ kind: 'free' } as CropAspectLock, { kind: 'original' } as CropAspectLock, ...CROP_RATIO_PRESETS.map((p) => lockForRatio(p.w, p.h))].map((l) => ({
      label: lockLabel(l),
      checked: sameLock(l, lock),
      onSelect: () => applyLock(l),
    }))
  const label = lockLabel(lock)
  const ratio = src ? displayedRatio(lock, src, crop) : null
  return (
    <Row
      label={t('Crop')}
      reset={() => {
        setEditor({ cropAspectLock: { kind: 'free' } })
        void commitMutation(ids, (c) => {
        c.crop = defaultCrop()
        delete c.cropTrack
        }, 'Change Crop')
      }}
    >
      <div className={`pp-insp-crop${single ? '' : ' disabled'}`}>
        <IconToggle
          sf="crop"
          on={editing && !!single}
          disabled={!single}
          tip={!single ? t('Crop applies to one clip at a time') : editing ? t('Stop editing crop on canvas') : t('Edit crop on canvas')}
          onClick={() => setEditor({ cropEditing: !editing })}
        />
        {editing && single && ratio ? (
          <>
            <CropAspectFields key={ratio.join(':')} ratio={ratio} onCommit={(w, h) => applyLock(lockForRatio(w, h))} />
            <MenuValueButton items={items} />
          </>
        ) : (
          <MenuValue text={label} items={items} tip={t('Choose a crop aspect')} disabled={!single} />
        )}
      </div>
      <KfSlot clips={clips} property="crop" />
    </Row>
  )
}

/** 22×22 value-field button with a chevron that opens the crop preset menu while editing. */
function MenuValueButton({ items }: { items: () => MenuItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      className="pp-value-field pp-insp-menu-chevron"
      data-active={open || undefined}
      data-tip={t('Choose a crop aspect')}
      onClick={(e) => {
        setOpen(true)
        openMenuBelow(e.currentTarget, items(), { minWidth: 120, alignRight: true, onClose: () => setOpen(false) })
      }}
    >
      <Icon sf="chevron.down" size={9} strokeWidth={2.5} className="tone-tertiary" />
    </button>
  )
}

export function VideoTab({ clips, allClips }: { clips: Clip[]; allClips: Clip[] }) {
  const frame = useInspectorFrame()
  const { w: W, h: H } = useCanvasSize()
  const ids = clips.map((c) => c.id)
  if (!clips.length) return null
  const tl = (c: Clip) => topLeftAt(c, frame)
  const x = common(clips, (c) => tl(c).a)
  const y = common(clips, (c) => tl(c).b)
  const scale = common(clips, (c) => sizeAt(c, frame).a)
  const rotation = common(clips, (c) => rotationAt(c, frame))
  const opacity = common(clips, (c) => rawOpacityAt(c, frame))
  const flipH = common(clips, (c) => c.transform.flipHorizontal)
  const flipV = common(clips, (c) => c.transform.flipVertical)
  const blend = common(clips, (c) => c.blendMode ?? 'normal')
  const softness = common(clips, (c) => c.edgeSoftness)
  const rounding = common(clips, (c) => c.edgeRounding)

  const scalePatch = (s: number) => (c: Clip) => {
    const src = sourceSize(c)
    const cur = sizeAt(c, frame)
    const ratio = src ? 1 / ((src.width / src.height) / (W / H)) : cur.a > 0 ? cur.b / cur.a : 1
    return { size: { width: s, height: s * ratio } }
  }
  const resetMany = (label: string, mutate: (c: Clip) => void) => void commitMutation(ids, mutate, label)

  return (
    <>
      <Group
        title={t('Transform')}
        contentStyle={{ gap: 8 }}
        onReset={() =>
          resetMany('Reset Transform', (c) => {
            c.transform = { ...fitFor(c, W, H) }
            c.opacity = 1
            delete c.opacityTrack
            delete c.positionTrack
            delete c.scaleTrack
            delete c.rotationTrack
            c.fadeInFrames = 0
            c.fadeOutFrames = 0
            c.fadeInInterpolation = 'linear'
            c.fadeOutInterpolation = 'linear'
          })
        }
        resetTip={t('Reset: Transform')}
      >
        <Row
          label={t('Position')}
          reset={() => resetMany('Change Position', (c) => {
            c.transform.centerX = 0.5
            c.transform.centerY = 0.5
            delete c.positionTrack
          })}
        >
          <ScrubField label="X" width={56} value={x} min={-10} max={10} mult={W} sens={1} {...patchHandlers(ids, frame, 'Change Position', (v) => () => ({ topLeft: { x: v } }))} />
          <ScrubField label="Y" width={56} value={y} min={-10} max={10} mult={H} sens={1} {...patchHandlers(ids, frame, 'Change Position', (v) => () => ({ topLeft: { y: v } }))} />
          <KfSlot clips={clips} property="position" />
        </Row>
        <Row
          label={t('Scale')}
          reset={() => resetMany('Change Scale', (c) => {
            const fit = fitFor(c, W, H)
            c.transform.width = fit.width
            c.transform.height = fit.height
            delete c.scaleTrack
          })}
        >
          <ScrubField value={scale} min={0.01} max={1000} mult={100} suffix="%" sens={1} {...patchHandlers(ids, frame, 'Change Scale', scalePatch)} />
          <KfSlot clips={clips} property="scale" />
        </Row>
        <Row
          label={t('Rotation')}
          reset={() => resetMany('Change Rotation', (c) => {
            c.transform.rotation = 0
            delete c.rotationTrack
          })}
        >
          <ScrubField value={rotation} min={-3600} max={3600} suffix="°" sens={1} adjust={snapRotation} {...patchHandlers(ids, frame, 'Change Rotation', (v) => () => ({ rotation: v }))} />
          <KfSlot clips={clips} property="rotation" />
        </Row>
        <Row
          label={t('Opacity')}
          reset={() => resetMany('Change Opacity', (c) => {
            c.opacity = 1
            delete c.opacityTrack
          })}
        >
          <ScrubField value={opacity} min={0} max={1} mult={100} suffix="%" sens={1} {...patchHandlers(ids, frame, 'Change Opacity', (v) => () => ({ opacity: v }))} />
          <KfSlot clips={clips} property="opacity" />
        </Row>
        <CropRow clips={clips} frame={frame} />
        <Row
          label={t('Flip')}
          gutter
          reset={() => resetMany('Change Flip', (c) => {
            c.transform.flipHorizontal = false
            c.transform.flipVertical = false
          })}
        >
          <span className="pp-insp-flip">
            <IconToggle sf="arrow.left.and.right" on={flipH === true} tip={flipH ? t('Remove horizontal flip') : t('Flip horizontally')} onClick={() => void commitPatch(ids, frame, () => ({ flipHorizontal: !flipH }), 'Change Flip')} />
            <IconToggle sf="arrow.up.and.down" on={flipV === true} tip={flipV ? t('Remove vertical flip') : t('Flip vertically')} onClick={() => void commitPatch(ids, frame, () => ({ flipVertical: !flipV }), 'Change Flip')} />
          </span>
        </Row>
        <Row label={t('Blend')} gutter reset={() => resetMany('Change Blend Mode', (c) => void delete c.blendMode)}>
          <MenuValue
            text={blend ? BLEND_NAMES[blend] : '—'}
            minWidth={150}
            items={() => BLEND_MODES.map((m) => ({ label: BLEND_NAMES[m], checked: m === blend, onSelect: () => void commitPatch(ids, frame, () => ({ blendMode: m }), 'Change Blend Mode') }))}
          />
        </Row>
      </Group>
      <Group
        title={t('Image Adjustment')}
        onReset={() => resetMany('Reset Image Adjustment', (c) => {
          c.edgeSoftness = 0
          c.edgeRounding = 0
        })}
        resetTip={t('Reset: Image Adjustment')}
      >
        <Row label={t('Edge Softness')}>
          <ScrubField value={softness} min={0} max={1} mult={100} suffix="%" sens={1} {...patchHandlers(ids, frame, 'Change Edge Softness', (v) => () => ({ edgeSoftness: v }))} />
        </Row>
        <Row label={t('Edge Rounding')}>
          <ScrubField value={rounding} min={0} max={1} mult={100} suffix="%" sens={1} {...patchHandlers(ids, frame, 'Change Edge Rounding', (v) => () => ({ edgeRounding: v }))} />
        </Row>
      </Group>
      <PlaybackGroup clips={allClips.filter((c) => c.mediaType !== 'text')} />
    </>
  )
}

