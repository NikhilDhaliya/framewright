import { TEST_ROOT } from '../extras/env'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyManifest, newProjectFile, type MediaManifestEntry } from '../../src/core/model'
import { readPackage, writePackage } from '../../src/main/project/packageIO'
import { ProjectSession } from '../../src/main/project/session'
import { settlePlaceholder } from '../../src/main/project/restorePlaceholders'

const entry = (id: string, extra: Partial<MediaManifestEntry> = {}): MediaManifestEntry => ({
  id,
  name: id,
  type: 'video',
  source: { project: { relativePath: `media/${id}.mp4` } },
  duration: 1,
  hasAudio: false,
  ...extra,
})

describe('settlePlaceholder (Mac finishRestoredMediaScan)', () => {
  it('clears a leftover status when the file made it to disk', () => {
    expect(settlePlaceholder(entry('a', { generationStatus: 'rendering' }), true)).toEqual({ generationStatus: undefined })
    expect(settlePlaceholder(entry('a', { generationStatus: 'failed: x' }), true)).toEqual({ generationStatus: undefined })
  })
  it('marks an extras placeholder that was still rendering as failed when its file is missing', () => {
    expect(settlePlaceholder(entry('a', { generationStatus: 'rendering' }), false)).toEqual({ generationStatus: 'failed: Interrupted' })
    expect(settlePlaceholder(entry('a', { generationStatus: 'failed: boom' }), false)).toBeNull()
  })
  it('handles interrupted URL imports like the Mac', () => {
    const imp = { importInput: { sourceURL: 'https://x/y.mp4' }, generationStatus: 'downloading' }
    expect(settlePlaceholder(entry('a', imp), false)).toEqual({ generationStatus: 'failed: Import interrupted' })
    expect(settlePlaceholder(entry('a', imp), true)).toEqual({ importInput: undefined, generationStatus: undefined })
    expect(settlePlaceholder(entry('a', { ...imp, generationStatus: 'failed: 404' }), true)).toBeNull()
  })
  it('leaves generated assets to the generation service and plain assets alone', () => {
    expect(settlePlaceholder(entry('a', { generationStatus: 'generating', generationInput: { prompt: 'p', model: 'm', duration: 1, aspectRatio: '16:9' } }), false)).toBeNull()
    expect(settlePlaceholder(entry('a'), false)).toBeNull()
  })
})

describe('ProjectSession.open settles stale placeholders', () => {
  it('fails a missing render, clears a finished one, persists the result', async () => {
    const dir = path.join(TEST_ROOT, 'Crash.palmier')
    const manifest = emptyManifest()
    manifest.entries.push(entry('MISSING', { generationStatus: 'rendering' }), entry('DONE', { generationStatus: 'rendering' }), entry('PLAIN'))
    await writePackage(dir, { file: newProjectFile(), manifest, preservedManifest: null })
    await fs.mkdir(path.join(dir, 'media'), { recursive: true })
    await fs.writeFile(path.join(dir, 'media', 'DONE.mp4'), 'x')
    const s = await ProjectSession.open(dir)
    const byId = (id: string) => s.doc.manifest.entries.find((e) => e.id === id)!
    expect(byId('MISSING').generationStatus).toBe('failed: Interrupted')
    expect(byId('DONE').generationStatus).toBeUndefined()
    expect(byId('PLAIN').generationStatus).toBeUndefined()
    expect(s.snapshot().undoLabel).toBeNull()
    await s.close()
    const reread = await readPackage(dir)
    expect(reread.manifest.entries.find((e) => e.id === 'MISSING')?.generationStatus).toBe('failed: Interrupted')
  })
})
