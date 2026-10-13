/** Brief B: Swap Media op + swap-mode / offline rules (03 §10.6, 05 §4.5, §5.3). */
import { describe, expect, it } from 'vitest'
import { emptyManifest, newProjectFile } from '../../src/core/model'
import { OPS, opLabel } from '../../src/core/ops'
import type { Doc } from '../../src/core/ops/context'
import { canSwapClip, clipMediaOffline, compatibleAssets, offlineAssetAt, tileOffline } from '../../src/renderer/media/mediaRules'
import { asset, audioTrack, clip, timeline, videoTrack } from '../captions/fixtures'

function setup() {
  const v = clip({ mediaRef: 'A', start: 0, duration: 60, trimStart: 30 })
  const a = clip({ mediaRef: 'A', mediaType: 'audio', start: 0, duration: 60, trimStart: 30 })
  a.sourceClipType = 'video'
  v.linkGroupId = a.linkGroupId = 'g'
  const img = clip({ mediaRef: 'I', mediaType: 'image', start: 60, duration: 30 })
  const t = clip({ mediaRef: '', mediaType: 'text', start: 90, duration: 30 })
  const file = newProjectFile()
  file.timelines = [timeline([videoTrack({ clips: [v, img, t] }), audioTrack({ clips: [a] })], { fps: 30 })]
  file.activeTimelineId = file.timelines[0].id
  const manifest = emptyManifest()
  manifest.entries = [
    asset('A', { duration: 10 }),
    asset('B', { duration: 5 }), // 150 frames ≥ 30 + 60
    asset('Short', { duration: 2 }), // 60 frames < 90
    asset('Mute', { duration: 10, hasAudio: false }),
    asset('Snd', { type: 'audio', duration: 10 }),
    asset('I', { type: 'image', duration: 0 }),
    asset('J', { type: 'image', duration: 0 }),
  ]
  return { doc: { file, manifest } as Doc, v, a, img, t }
}
const clips = (d: Doc) => d.file.timelines[0].tracks.flatMap((tr) => tr.clips)

describe('swapClipMedia op', () => {
  it('swaps the clip and its same-source linked partner, keeping trim start and recomputing trim end', () => {
    const { doc, v, a } = setup()
    const plan = OPS.swapClipMedia.run(doc, { clipId: v.id, assetId: 'B' })
    expect(plan.affectedClipIds.sort()).toEqual([v.id, a.id].sort())
    for (const c of clips(doc).filter((c) => c.id === v.id || c.id === a.id)) {
      expect(c.mediaRef).toBe('B')
      expect(c.trimStartFrame).toBe(30)
      expect(c.trimEndFrame).toBe(150 - 90)
    }
    expect(opLabel('swapClipMedia', { clipId: v.id, assetId: 'B' })).toBe('Replace Clip Source')
  })

  it('refuses incompatible replacements', () => {
    const { doc, v, t } = setup()
    expect(() => OPS.swapClipMedia.run(doc, { clipId: v.id, assetId: 'Short' })).toThrow(/too short/)
    expect(() => OPS.swapClipMedia.run(doc, { clipId: v.id, assetId: 'Mute' })).toThrow(/no audio/)
    expect(() => OPS.swapClipMedia.run(doc, { clipId: v.id, assetId: 'Snd' })).toThrow(/source type/)
    expect(() => OPS.swapClipMedia.run(doc, { clipId: v.id, assetId: 'nope' })).toThrow(/not found/)
    expect(() => OPS.swapClipMedia.run(doc, { clipId: t.id, assetId: 'B' })).toThrow(/does not support/)
  })
})

describe('swap-mode rules', () => {
  it('arms only for swappable clips and lists compatible assets without mutating', () => {
    const { doc, v, img, t } = setup()
    const before = JSON.stringify(doc)
    expect(canSwapClip(doc, v.id)).toBe(true)
    expect(canSwapClip(doc, t.id)).toBe(false)
    expect([...compatibleAssets(doc, v.id)].sort()).toEqual(['A', 'B'])
    expect([...compatibleAssets(doc, img.id)].sort()).toEqual(['I', 'J'])
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe('offline rules', () => {
  it('tile, clip and preview-panel offline states', () => {
    const { doc, v, img, t } = setup()
    const off = new Set(['I'])
    expect(tileOffline(doc.manifest.entries[5], off)).toBe(true)
    expect(tileOffline({ ...doc.manifest.entries[5], generationStatus: 'failed: x' }, off)).toBe(false)
    expect(clipMediaOffline(img, off)).toBe(true)
    expect(clipMediaOffline(v, off)).toBe(false)
    expect(clipMediaOffline(t, new Set([t.mediaRef]))).toBe(false)
    const tl = doc.file.timelines[0]
    const byId = new Map(doc.manifest.entries.map((e) => [e.id, e]))
    expect(offlineAssetAt(tl, 70, byId, off)).toBe('I')
    expect(offlineAssetAt(tl, 10, byId, off)).toBeNull()
    expect(offlineAssetAt(tl, 70, byId, new Set())).toBeNull()
    // a ready clip on a lower track covers the frame (Mac `.covered`)
    const cover = clip({ mediaRef: 'B', start: 60, duration: 30 })
    tl.tracks.splice(1, 0, videoTrack({ clips: [cover] }))
    expect(offlineAssetAt(tl, 70, byId, off)).toBeNull()
    // generating clips leave the frame to the generation overlay
    tl.tracks.splice(1, 1)
    byId.set('I', { ...byId.get('I')!, generationStatus: 'generating' })
    expect(offlineAssetAt(tl, 70, byId, new Set(['I']))).toBeNull()
  })
})
