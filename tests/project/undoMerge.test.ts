import { TEST_ROOT } from '../extras/env'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyManifest, newClip, newProjectFile, newTrack, type MediaManifestEntry } from '../../src/core/model'
import { addMediaEntries, createFolder, deleteMedia, renameMedia, updateMediaEntry } from '../../src/core/ops/project'
import { ProjectSession } from '../../src/main/project/session'
import { mergeById } from '../../src/main/project/undoMerge'

const asset = (id: string, name = id): MediaManifestEntry => ({ id, name, type: 'image', source: { external: { absolutePath: `/tmp/${id}.png` } }, duration: 5, hasAudio: false })

let session: ProjectSession
let n = 0

beforeEach(async () => {
  const file = newProjectFile()
  const t = file.timelines[0]
  t.tracks = [newTrack('video')]
  t.tracks[0].clips.push(newClip({ id: 'C1', mediaRef: 'A', startFrame: 0, durationFrames: 30 }))
  const manifest = emptyManifest()
  manifest.entries.push(asset('A'))
  session = await ProjectSession.create(path.join(TEST_ROOT, `Undo${n++}.palmier`), { file, manifest })
})
afterEach(async () => {
  await session.close()
})

const ids = () => session.doc.manifest.entries.map((e) => e.id)
const clipStart = () => session.doc.file.timelines[0].tracks[0].clips[0].startFrame
const quiet = (fn: Parameters<ProjectSession['transact']>[1]) => expect(session.transact('Update Media', fn, false).ok).toBe(true)

describe('undo keeps non-undoable media-library writes (Mac: importMediaAsset registers no undo)', () => {
  it('an asset added outside undo survives undo and redo of an earlier timeline edit', () => {
    session.transact('Move Clip', (d) => {
      d.file.timelines[0].tracks[0].clips[0].startFrame = 10
    })
    quiet((d) => addMediaEntries(d, [asset('X')]))
    expect(session.undo()).toBe('Move Clip')
    expect(clipStart()).toBe(0)
    expect(ids()).toEqual(['A', 'X'])
    expect(session.redo()).toBe('Move Clip')
    expect(clipStart()).toBe(10)
    expect(ids()).toEqual(['A', 'X'])
  })

  it('an asset added outside undo survives undo of an earlier undoable import', () => {
    session.transact('Import Media', (d) => addMediaEntries(d, [asset('B')]))
    quiet((d) => addMediaEntries(d, [asset('X')]))
    session.undo()
    expect(ids()).toEqual(['A', 'X'])
    session.redo()
    expect([...ids()].sort()).toEqual(['A', 'B', 'X'])
  })

  it('non-undoable metadata (generation status) is not rolled back by an unrelated undo', () => {
    session.transact('Generate', (d) => addMediaEntries(d, [{ ...asset('G'), generationStatus: 'preparing' }]))
    session.transact('Move Clip', (d) => {
      d.file.timelines[0].tracks[0].clips[0].startFrame = 5
    })
    quiet((d) => updateMediaEntry(d, 'G', { generationStatus: undefined, duration: 8 }))
    session.undo()
    const g = session.doc.manifest.entries.find((e) => e.id === 'G')!
    expect(g.generationStatus).toBeUndefined()
    expect(g.duration).toBe(8)
  })

  it('undoing the step that added an asset still removes it, and redo brings it back', () => {
    session.transact('Generate', (d) => addMediaEntries(d, [{ ...asset('G'), generationStatus: 'preparing' }]))
    quiet((d) => updateMediaEntry(d, 'G', { generationStatus: 'generating' }))
    session.undo()
    expect(ids()).toEqual(['A'])
    session.redo()
    expect(ids()).toEqual(['A', 'G'])
  })

  it('a rename undoes only the name; later non-undoable fields stay', () => {
    session.transact('Rename', (d) => renameMedia(d, 'A', 'Renamed'))
    quiet((d) => updateMediaEntry(d, 'A', { duration: 9 }))
    session.undo()
    const a = session.doc.manifest.entries[0]
    expect(a).toMatchObject({ name: 'A', duration: 9 })
  })

  it('undo of a delete restores the asset and its clips; extras added later keep their place', () => {
    quiet((d) => addMediaEntries(d, [asset('X')]))
    session.transact('Delete Media', (d) => deleteMedia(d, ['A']))
    quiet((d) => addMediaEntries(d, [asset('Y')]))
    session.undo()
    expect(ids()).toEqual(['A', 'X', 'Y'])
    expect(session.doc.file.timelines[0].tracks[0].clips).toHaveLength(1)
  })

  it('an extras asset filed into a folder whose creation is undone falls back to the root', () => {
    let fid = ''
    session.transact('New Folder', (d) => {
      fid = createFolder(d, 'Stuff').id
    })
    quiet((d) => addMediaEntries(d, [{ ...asset('X'), folderId: fid }]))
    session.undo()
    expect(session.doc.manifest.folders).toHaveLength(0)
    expect(session.doc.manifest.entries.find((e) => e.id === 'X')?.folderId).toBeUndefined()
  })

  it('a later edit stays undoable to the exact recorded state', () => {
    quiet((d) => addMediaEntries(d, [asset('X')]))
    session.transact('Rename', (d) => renameMedia(d, 'X', 'Named'))
    session.undo()
    expect(session.doc.manifest.entries.find((e) => e.id === 'X')?.name).toBe('X')
  })
})

describe('mergeById', () => {
  it('returns the live list unchanged when the step did not touch it', () => {
    const l = [{ id: 'a' }]
    expect(mergeById(l, l, l)).toBe(l)
  })
  it('places items added outside the step after their live predecessor', () => {
    const from = [{ id: 'a' }, { id: 'b' }]
    const target = [{ id: 'a' }]
    const cur = [{ id: 'a' }, { id: 'x' }, { id: 'b' }, { id: 'y' }]
    expect(mergeById(cur, from, target).map((x) => x.id)).toEqual(['a', 'x', 'y'])
  })
})
