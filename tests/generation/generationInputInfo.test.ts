import { describe, expect, it } from 'vitest'
import { modelSet } from '../../src/core/generation/models'
import type { GenerationInput, MediaManifestEntry } from '../../src/core/model'
import { inputMetadataSummary, referenceSlots } from '../../src/renderer/generation/generationInputInfo'

const set = modelSet(() => true)
const asset = (id: string) => ({ id, name: id, type: 'image' }) as unknown as MediaManifestEntry
const input = (p: Partial<GenerationInput>): GenerationInput => ({ prompt: '', model: 'kling-v3', duration: 0, aspectRatio: '', ...p }) as GenerationInput

describe('Generation Input group (Mac InspectorView.inputSection)', () => {
  it('summarises model, draft, aspect, resolution and duration', () => {
    const gen = input({ model: 'kling-v3', draft: true, aspectRatio: '16:9', resolution: '1080p', duration: 5 })
    expect(inputMetadataSummary(gen, set.find(gen.model))).toBe('Kling V3 · Draft · 16:9 · 1080p · 5s')
    expect(inputMetadataSummary(input({ model: 'unknown-model' }), undefined)).toBe('unknown-model')
  })

  it('labels reference slots like GenerationReferencesStrip and skips deleted assets', () => {
    const lib = [asset('f'), asset('l'), asset('r1'), asset('r2')]
    const gen = input({ model: 'kling-v3', imageURLAssetIds: ['f', 'l'], referenceImageAssetIds: ['r1', 'gone', 'r2'] })
    expect(referenceSlots(gen, set.find(gen.model), lib).map((s) => [s.label, s.asset.id])).toEqual([
      ['First Frame', 'f'],
      ['Last Frame', 'l'],
      ['Image Ref 1', 'r1'],
      ['Image Ref 3', 'r2'],
    ])
    const up = input({ model: 'topaz-image-upscaler', imageURLAssetIds: ['f'] })
    expect(referenceSlots(up, set.find(up.model), lib)[0].label).toBe('Source')
  })
})
