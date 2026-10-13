import { describe, expect, it } from 'vitest'
import type { MediaManifestEntry, Timeline } from '../../src/core/model'
import { linkedClipIdsSharingMedia, prunePending } from '../../src/renderer/generation/pendingReplacements'

const entry = (id: string, generationStatus?: string) => ({ id, generationStatus }) as unknown as MediaManifestEntry
const clip = (id: string, mediaRef: string, linkGroupId?: string) => ({ id, mediaRef, linkGroupId })
const timeline = { tracks: [{ clips: [clip('v', 'm', 'g'), clip('x', 'other', 'g')] }, { clips: [clip('a', 'm', 'g'), clip('solo', 'm')] }] } as unknown as Timeline

describe('pending replacements (Mac markPendingReplacement / clearPendingReplacement)', () => {
  it('marks linked clips that share the media, not other members of the link group', () => {
    expect(linkedClipIdsSharingMedia(timeline, 'v').sort()).toEqual(['a', 'v'])
    expect(linkedClipIdsSharingMedia(timeline, 'solo')).toEqual(['solo'])
    expect(linkedClipIdsSharingMedia(undefined, 'z')).toEqual(['z'])
  })

  it('keeps a clip while any placeholder is in flight; drops it once settled, failed or deleted', () => {
    const byClip = new Map([
      ['v', ['p1', 'p2']],
      ['a', ['p3']],
      ['b', ['gone']],
    ])
    const live = [entry('p1', 'generating'), entry('p2'), entry('p3', 'failed: boom')]
    const next = prunePending(byClip, live)
    expect([...next.keys()]).toEqual(['v'])
    expect(prunePending(next, [entry('p1', 'downloading')])).toBe(next)
    expect(prunePending(next, [entry('p1')]).size).toBe(0)
  })
})
