/** Ported from the Mac's CaptionTargetTests (CaptionGenerationTests.swift) plus Index ▸ Transcript documents (spec 07 §1.11). */
import { describe, expect, it } from 'vitest'
import { captionTargetsForIds, captionTargetsForTracks, captionUsesVideoAudio, dominantSpeechTrack, locateTargets, transcriptionTargetsForClips, type TargetContext } from '../../src/core/captions/targets'
import { captionFallbacks, clipWordRows, makeTimelineTranscriptDocument, rowsMatching, TranscriptTimelineIndex, type TimelineTranscriptRow } from '../../src/core/captions/timelineTranscript'
import type { MulticamSource } from '../../src/core/model'
import { asset, audioTrack, clip, result, timeline, videoTrack } from './fixtures'

const ids = (cs: { id: string }[]) => cs.map((c) => c.id)

describe('caption targets', () => {
  it('linked and track targets choose the audio side', () => {
    const video = clip({ id: 'video', mediaRef: 'media-1', mediaType: 'video', start: 0, duration: 100 })
    const audio = clip({ id: 'audio', mediaRef: 'media-1', mediaType: 'audio', start: 0, duration: 100 })
    video.linkGroupId = audio.linkGroupId = 'linked-1'
    const voice = clip({ id: 'voice', mediaRef: 'voice-media', mediaType: 'audio', start: 120, duration: 100 })
    const music = clip({ id: 'music', mediaRef: 'music-media', mediaType: 'audio', start: 240, duration: 100 })
    const ctx: TargetContext = {
      timeline: timeline([
        videoTrack({ id: 'video-track', clips: [video] }),
        audioTrack({ id: 'audio-track', clips: [audio] }),
        audioTrack({ id: 'voice-track', clips: [voice] }),
        audioTrack({ id: 'music-track', clips: [music] }),
      ]),
      assets: [],
      multicamGroups: [],
    }
    expect(ids(captionTargetsForIds(ctx, []))).toEqual(['audio', 'voice', 'music'])
    expect(ids(captionTargetsForIds(ctx, ['video']))).toEqual(['video'])
    expect(ids(captionTargetsForTracks(ctx, ['voice-track']))).toEqual(['voice'])
    expect(ids(captionTargetsForTracks(ctx, ['video-track', 'audio-track']))).toEqual(['audio'])
    expect(captionTargetsForTracks(ctx, ['video-track'])).toEqual([])
    expect(ids(captionTargetsForTracks(ctx, ['audio-track']))).toEqual(['audio'])
    expect(ids(transcriptionTargetsForClips(ctx, ['video']))).toEqual([])
  })

  it('explicit selections can choose a non-master multicam mic', () => {
    const master = clip({ id: 'master', mediaRef: 'lapel', mediaType: 'audio', start: 0, duration: 100 })
    const room = clip({ id: 'room', mediaRef: 'room', mediaType: 'audio', start: 0, duration: 100 })
    master.multicamGroupId = room.multicamGroupId = 'group'
    const sync = { offsetSeconds: 0, confidence: 1, locked: false }
    const group: MulticamSource = {
      id: 'group',
      name: 'Interview',
      members: [
        { id: 'master-member', mediaRef: 'lapel', kind: 'mic', angleLabel: 'lapel', sync },
        { id: 'room-member', mediaRef: 'room', kind: 'mic', angleLabel: 'room', sync },
      ],
      masterMemberId: 'master-member',
    }
    const ctx: TargetContext = { timeline: timeline([audioTrack({ id: 'master-track', clips: [master] }), audioTrack({ id: 'room-track', clips: [room] })]), assets: [], multicamGroups: [group] }
    expect(ids(captionTargetsForIds(ctx, []))).toEqual(['master'])
    expect(ids(captionTargetsForIds(ctx, ['room']))).toEqual(['room'])
    expect(ids(captionTargetsForIds(ctx, ['master', 'room']))).toEqual(['master', 'room'])
    expect(ids(transcriptionTargetsForClips(ctx, ['room']))).toEqual(['room'])
    expect(ids(captionTargetsForTracks(ctx, ['room-track']))).toEqual(['room'])
  })

  it('media metadata filters caption sources', () => {
    const silent = clip({ id: 'silent', mediaRef: 'silent-media', mediaType: 'video', start: 0, duration: 100 })
    const linkedAudio = clip({ id: 'audio', mediaRef: 'video-media', mediaType: 'audio', start: 120, duration: 100 })
    const image = clip({ id: 'still', mediaRef: 'img', mediaType: 'image', start: 0, duration: 100 })
    const ctx: TargetContext = {
      timeline: timeline([videoTrack({ clips: [silent, image] }), audioTrack({ clips: [linkedAudio] })]),
      assets: [asset('silent-media', { hasAudio: false }), asset('video-media')],
      multicamGroups: [],
    }
    expect(ids(captionTargetsForIds(ctx, []))).toEqual(['audio'])
    expect(captionUsesVideoAudio(ctx, linkedAudio)).toBe(true)
    expect(captionUsesVideoAudio(ctx, clip({ mediaRef: 'unknown', mediaType: 'audio' }))).toBe(false)
    expect(captionUsesVideoAudio(ctx, clip({ mediaRef: 'unknown', mediaType: 'video' }))).toBe(true)
  })

  it('the dominant speech track has the most spoken words', () => {
    const a = clip({ id: 'a', mediaRef: 'ma', mediaType: 'audio', start: 0, duration: 90 })
    const b = clip({ id: 'b', mediaRef: 'mb', mediaType: 'audio', start: 0, duration: 90 })
    const t = timeline([audioTrack({ id: 'ta', clips: [a] }), audioTrack({ id: 'tb', clips: [b] })])
    const targets = locateTargets(t, [a, b])
    expect(targets.map((x) => [x.trackId, x.trackIndex])).toEqual([
      ['ta', 0],
      ['tb', 1],
    ])
    const results = new Map([
      ['ma', result([['one', 0, 0.5]])],
      [
        'mb',
        result([
          ['one', 0, 0.5],
          ['two', 0.5, 1],
        ]),
      ],
    ])
    expect(dominantSpeechTrack(targets, results, 30)).toBe('tb')
    expect(dominantSpeechTrack(targets, new Map([['ma', result([])]]), 30)).toBeNull()
  })
})

describe('timeline transcript documents', () => {
  it('builds one row per sentence piece mapped to timeline frames', () => {
    const c = clip({ id: 'c1', mediaRef: 'm', mediaType: 'audio', start: 30, duration: 300 })
    const t = timeline([audioTrack({ id: 'tr', clips: [c] })])
    const r = result(
      [
        ['Hello', 0, 0.5],
        ['there.', 0.5, 1],
        ['How', 2, 2.3],
        ['are', 2.3, 2.6],
        ['you?', 2.6, 3],
      ],
      [
        ['Hello there.', 0, 1],
        ['How are you?', 2, 3],
      ],
    )
    const doc = makeTimelineTranscriptDocument(locateTargets(t, [c]), new Map([['m', r]]), 30)
    expect(doc.rows).toEqual([
      { id: 'c1:0:30', clipId: 'c1', text: 'Hello there.', startFrame: 30, endFrame: 60 },
      { id: 'c1:1:90', clipId: 'c1', text: 'How are you?', startFrame: 90, endFrame: 120 },
    ])
    expect(rowsMatching(doc.rows, '  HOW ')).toHaveLength(1)
    expect(rowsMatching(doc.rows, '')).toHaveLength(2)
  })

  it('caption fallbacks list one document per caption group per track, visible tracks first', () => {
    const cap = (id: string, g: string, start: number, text: string) => Object.assign(clip({ id, mediaRef: '', mediaType: 'text', start, duration: 10 }), { captionGroupId: g, textContent: text })
    const hidden = videoTrack({ id: 'hidden', clips: [cap('h1', 'g2', 0, 'hidden')] })
    hidden.hidden = true
    const t = timeline([hidden, videoTrack({ id: 'v', clips: [cap('b', 'g1', 20, 'second'), cap('a', 'g1', 0, 'first')] })])
    t.tracks[1].clips.sort((x, y) => x.startFrame - y.startFrame)
    const docs = captionFallbacks(t)
    expect(docs.map((d) => [d.sourceTrackId, d.sourceCaptionGroupId, d.rows.map((r) => r.text)])).toEqual([
      ['v', 'g1', ['first', 'second']],
      ['hidden', 'g2', ['hidden']],
    ])
  })

  it('finds the current row with a prefix-max fallback', () => {
    const rows: TimelineTranscriptRow[] = [
      { id: 'a', clipId: 'x', text: 'a', startFrame: 0, endFrame: 100 },
      { id: 'b', clipId: 'x', text: 'b', startFrame: 10, endFrame: 20 },
      { id: 'c', clipId: 'x', text: 'c', startFrame: 120, endFrame: 130 },
    ]
    const index = new TranscriptTimelineIndex(rows)
    expect(index.currentRow(-1)).toBeNull()
    expect(index.currentRow(15)?.id).toBe('b')
    expect(index.currentRow(50)?.id).toBe('a')
    expect(index.currentRow(110)).toBeNull()
    expect(index.currentRow(125)?.id).toBe('c')
    expect(new TranscriptTimelineIndex([]).currentRow(0)).toBeNull()
  })

  it('maps words to project frames by midpoint through trim and speed', () => {
    const c = clip({ id: 'c', mediaRef: 'm', start: 100, duration: 30, trimStart: 30, speed: 2 })
    const r = result([
      ['before', 0, 0.9],
      ['in', 1.0, 1.5],
      ['edge', 2.6, 3.2],
      ['after', 3.4, 4],
    ])
    expect(clipWordRows(r, c, 30)).toEqual([
      { start: 100, end: 108, text: 'in' },
      { start: 124, end: 130, text: 'edge' },
    ])
  })
})
