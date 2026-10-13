/**
 * Pure parts of the asset inspector's "Generation Input" group (Mac `InspectorView.inputSection`,
 * `inputMetadataSummary`, `GenerationReferencesStrip.slots`).
 */
import { aspectRatioDisplayLabel } from '@core/generation/labels'
import { AudioModel, UpscaleModel, VideoModel, type AnyModel } from '@core/generation/models'
import { stringList } from '@core/generation/status'
import type { GenerationInput, MediaManifestEntry } from '@core/model'
import { t } from '../i18n'

/** `inputMetadataSummary`: model · Draft · aspect · resolution · duration. */
export function inputMetadataSummary(gen: GenerationInput, model: AnyModel | undefined): string {
  const values = [model?.displayName ?? gen.model]
  if (gen.draft === true) values.push(t('Draft'))
  if (gen.aspectRatio) values.push(aspectRatioDisplayLabel(gen.aspectRatio))
  if (typeof gen.resolution === 'string' && gen.resolution) values.push(gen.resolution)
  if (gen.duration > 0) values.push(`${gen.duration}s`)
  return values.join(' · ')
}

function primaryLabels(model: AnyModel | undefined): string[] {
  if (model instanceof VideoModel) {
    if (model.requiresSourceVideo) return model.supportsReferences ? [t('Source'), t('Reference')] : [t('Source')]
    if (model.supportsFirstFrame) return model.supportsLastFrame ? [t('First Frame'), t('Last Frame')] : [t('First Frame')]
    return []
  }
  return model instanceof UpscaleModel ? [t('Source')] : []
}

/** `GenerationReferencesStrip.slots`: labelled reference assets that still exist in the library. */
export function referenceSlots(gen: GenerationInput, model: AnyModel | undefined, assets: readonly MediaManifestEntry[]): { label: string; asset: MediaManifestEntry }[] {
  const byId = new Map(assets.map((a) => [a.id, a]))
  const videoBase = model instanceof AudioModel && model.inputs.includes('video') ? t('Source Video') : t('Video Ref')
  const groups: [string[], string, string[]][] = [
    [stringList(gen.imageURLAssetIds), t('Reference'), primaryLabels(model)],
    [stringList(gen.referenceImageAssetIds), t('Image Ref'), []],
    [stringList(gen.referenceVideoAssetIds), videoBase, []],
    [stringList(gen.referenceAudioAssetIds), t('Audio Ref'), []],
  ]
  return groups.flatMap(([ids, base, primary]) =>
    ids.flatMap((id, i) => {
      const asset = byId.get(id)
      if (!asset) return []
      return [{ label: i < primary.length ? primary[i] : ids.length > 1 ? `${base} ${i + 1}` : base, asset }]
    }),
  )
}
