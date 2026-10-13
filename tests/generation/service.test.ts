import '../mcp/env'
import { TEST_ROOT } from '../mcp/env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasKeyFrom } from '../../src/core/generation/catalog'
import { modelSet } from '../../src/core/generation/models'
import { emptyManifest, newProjectFile, type MediaManifestEntry } from '../../src/core/model'
import { addMediaEntries, renameMedia, deleteMedia } from '../../src/core/ops/project'
import { probeFile } from '../../src/main/media/probe'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { FalAdapter } from '../../src/main/generation/providers/fal'
import { CANCELLED_MESSAGE, GenerationService } from '../../src/main/generation/service'
import { submitImage, submitVideo } from '../../src/main/generation/submissions'
import { installPackageMedia, sourceForPath } from '../../src/main/project/packageIO'
import { ProjectSession } from '../../src/main/project/session'
import type { AppContext } from '../../src/main/services'
import type { AppSettings, UiCommand } from '../../src/shared/api'
import { startFakeFal, type Behavior, type FakeFal } from './fakeFal'

let fake: FakeFal
let behavior: (endpoint: string) => Behavior | undefined = () => undefined
beforeAll(async () => {
  fake = await startFakeFal({ polls: 2, behavior: (e) => behavior(e) })
})
afterAll(() => fake.close())

const settings = { apiKeys: { fal: 'test-key' } } as AppSettings
const toasts: string[] = []
let session: ProjectSession

function makeApp(): AppContext {
  return {
    sessions: { focused: () => session, all: () => [session], openPath: async () => session, create: async () => session },
    media: { probe: probeFile } as unknown as AppContext['media'],
    render: {} as AppContext['render'],
    exporter: {} as AppContext['exporter'],
    settings: () => settings,
    ui: (_s, cmd: UiCommand) => {
      if (cmd.type === 'toast') toasts.push(cmd.message)
    },
  }
}

function makeService(app: AppContext, o: { inlineMaxBytes?: number } = {}): GenerationService {
  return new GenerationService(app, {
    pollDelay: () => 5,
    uploadCacheFile: path.join(TEST_ROOT, `uploads-${randomUUID()}.json`),
    adapter: (p) => (p === 'fal' ? new FalAdapter({ key: settings.apiKeys.fal!, queueBase: `${fake.url}/queue`, restBase: `${fake.url}/rest`, inlineMaxBytes: o.inlineMaxBytes }) : null),
  })
}

const models = () => modelSet(hasKeyFrom(settings.apiKeys))
const entry = (id: string): MediaManifestEntry | undefined => session.doc.manifest.entries.find((e) => e.id === id)
const imageInput = { prompt: 'a red fox in snow', model: 'nano-banana-pro', duration: 0, aspectRatio: '16:9', resolution: '1K' }

async function addPng(name: string, size = 64): Promise<MediaManifestEntry> {
  const png = await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${size}x${size}`, '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1'])
  const dest = await installPackageMedia(session.path, `${name}-${randomUUID().slice(0, 8)}.png`, png)
  const e: MediaManifestEntry = { id: randomUUID().toUpperCase(), name, type: 'image', source: sourceForPath(dest, session.path), duration: 5, hasAudio: false, sourceWidth: size, sourceHeight: size }
  session.transact('Import Media', (d) => addMediaEntries(d, [e]))
  return e
}

beforeEach(async () => {
  behavior = () => undefined
  toasts.length = 0
  session = await ProjectSession.create(path.join(TEST_ROOT, `gen-${randomUUID().slice(0, 8)}.palmier`), { file: newProjectFile(), manifest: emptyManifest() })
})
afterEach(async () => {
  if (!session.closed) await session.close()
})

describe('generation service with the fake fal server', () => {
  it('creates a placeholder, submits, persists the job handle and installs the result into media/', async () => {
    const svc = makeService(makeApp())
    const [id] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    const placeholder = entry(id)!
    expect(placeholder).toMatchObject({ name: 'a red fox in snow', type: 'image', duration: 5, generationStatus: 'preparing', source: { project: { relativePath: `media/gen-${id.slice(0, 8)}.jpg` } } })
    expect(session.snapshot().undoLabel).toBe('Generate Image')
    await svc.idle(session)
    const done = entry(id)!
    expect(done.generationStatus).toBeUndefined()
    // The result is a PNG, so the placeholder's .jpg becomes .png (§B4.5 step 2).
    expect(done.source).toEqual({ project: { relativePath: `media/gen-${id.slice(0, 8)}.png` } })
    expect(done).toMatchObject({ type: 'image', sourceWidth: 320, sourceHeight: 180 })
    expect((await fs.stat(path.join(session.path, 'media', `gen-${id.slice(0, 8)}.png`))).size).toBeGreaterThan(0)
    const sub = fake.submissions.at(-1)!
    expect(sub).toMatchObject({ endpoint: 'fal-ai/nano-banana-pro', body: { prompt: 'a red fox in snow', aspect_ratio: '16:9', resolution: '1K', num_images: 1, output_format: 'png' } })
    expect(done.generationInput).toMatchObject({ model: 'nano-banana-pro', outputIndex: 0, byokJob: { provider: 'fal', endpoint: 'fal-ai/nano-banana-pro', requestId: sub.id }, resultURLs: [`${fake.url}/files/${sub.id}-0.png`] })
    expect(typeof done.generationInput!.createdAt).toBe('number')
    expect(toasts).toEqual(['a red fox in snow is ready.'])
    // Persisted for a reopen: the saved media.json carries the finished state.
    await session.save()
    const saved = JSON.parse(await fs.readFile(path.join(session.path, 'media.json'), 'utf8'))
    expect(saved.entries[0].generationStatus).toBeUndefined()
    expect(saved.entries[0].generationInput.byokJob.requestId).toBe(sub.id)
  })

  it('maps one output per placeholder for multi-image requests', async () => {
    const svc = makeService(makeApp())
    const ids = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 3, undoLabel: 'Generate Image' })
    expect(ids).toHaveLength(3)
    await svc.idle(session)
    expect(ids.map((id) => entry(id)!.generationStatus)).toEqual([undefined, undefined, undefined])
    expect(fake.submissions.at(-1)!.body.num_images).toBe(3)
    expect(toasts).toEqual(['3 images are ready in Framewright.'])
  })

  it('uploads references (cached for reuse) and records their URLs in generationInput', async () => {
    const svc = makeService(makeApp(), { inlineMaxBytes: 16 })
    const refA = await addPng('Ref A')
    const before = fake.uploads.length
    const [first] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [refA], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(fake.uploads.length).toBe(before + 1)
    const sub = fake.submissions.at(-1)!
    expect(sub.endpoint).toBe('fal-ai/nano-banana-pro/edit')
    const url = (sub.body.image_urls as string[])[0]
    expect(url).toMatch(/\/cdn\//)
    expect(entry(first)!.generationInput).toMatchObject({ imageURLAssetIds: [refA.id], imageURLs: [url] })
    submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [refA], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(fake.uploads.length).toBe(before + 1)
    expect((fake.submissions.at(-1)!.body.image_urls as string[])[0]).toBe(url)
  })

  it('surfaces provider errors as failed: <message>', async () => {
    const svc = makeService(makeApp())
    behavior = () => ({ error: 'Content policy violation' })
    const [a] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(entry(a)!.generationStatus).toBe('failed: Content policy violation')
    behavior = () => ({ resultStatus: 422, resultBody: { detail: [{ loc: ['body', 'prompt'], msg: 'Prompt is too long', type: 'value_error' }] } })
    const [b] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(entry(b)!.generationStatus).toBe('failed: Prompt is too long')
    behavior = () => ({ submitStatus: 403, submitBody: { detail: 'User is locked. Reason: Exhausted balance.' } })
    const [c] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(entry(c)!.generationStatus).toBe('failed: User is locked. Reason: Exhausted balance.')
    expect(entry(c)!.generationInput!.byokJob).toBeUndefined()
    const missing: MediaManifestEntry = { id: 'GONE', name: 'Gone', type: 'image', source: { external: { absolutePath: '/nonexistent/x.png' } }, duration: 5 }
    const [d] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [missing], numImages: 1, undoLabel: 'Generate Image' })
    await svc.idle(session)
    expect(entry(d)!.generationStatus).toMatch(/^failed: Upload failed: /)
  })

  it('cancels a running job at the provider', async () => {
    const svc = makeService(makeApp())
    behavior = () => ({ hold: true })
    const [id] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await waitFor(() => entry(id)!.generationStatus === 'generating')
    expect(await svc.cancel(session, id)).toBe(true)
    expect(fake.cancels).toContain(fake.submissions.at(-1)!.id)
    expect(entry(id)!.generationStatus).toBe(`failed: ${CANCELLED_MESSAGE}`)
  })

  it('resumes a persisted job after the project is closed and reopened', async () => {
    const app = makeApp()
    const svc = makeService(app)
    behavior = () => ({ hold: true })
    const [id] = submitVideo(svc, {
      session,
      model: models().findVideo('minimax-h3')!,
      genInput: { prompt: 'waves at night', model: 'minimax-h3', duration: 5, aspectRatio: '16:9', resolution: '768P' },
      inputs: { frames: [], imageRefs: [], videoRefs: [], audioRefs: [] },
      placeholderDuration: 5,
      generateAudio: true,
      undoLabel: 'Generate Video',
    })
    await waitFor(() => entry(id)!.generationStatus === 'generating')
    const requestId = fake.submissions.at(-1)!.id
    const dir = session.path
    await session.close()
    svc.sweepClosed()
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'media.json'), 'utf8')).entries[0]
    expect(onDisk.generationStatus).toBe('generating')
    expect(onDisk.generationInput.byokJob).toMatchObject({ provider: 'fal', requestId, statusUrl: `${fake.url}/queue/minimax/h3/requests/${requestId}/status` })
    // The app restarts: a fresh service picks the job up from media.json.
    fake.release(requestId)
    session = await ProjectSession.open(dir)
    const restarted = makeService(app)
    restarted.attach(session)
    await waitFor(() => entry(id)?.generationStatus === undefined && 'project' in entry(id)!.source)
    await restarted.idle(session)
    expect(entry(id)).toMatchObject({ type: 'video', duration: 2, sourceWidth: 320, sourceHeight: 180, hasAudio: true })
    expect(fake.cancels).not.toContain(requestId)
  })

  it('re-applies the finished state when an undo restores a stale placeholder, and finishes deleted-then-restored ones', async () => {
    const svc = makeService(makeApp())
    const other = await addPng('Other')
    behavior = () => ({ hold: true })
    const [id] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await waitFor(() => entry(id)!.generationStatus === 'generating')
    session.transact('Rename Media', (d) => renameMedia(d, other.id, 'Renamed'))
    fake.release()
    await svc.idle(session)
    expect(entry(id)!.generationStatus).toBeUndefined()
    session.undo()
    expect(entry(other.id)!.name).toBe('Other')
    expect(entry(id)!.generationStatus).toBeUndefined()
    const src = entry(id)!.source
    expect('project' in src && src.project.relativePath.endsWith('.png')).toBe(true)

    const [gone] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await waitFor(() => entry(gone)!.generationStatus === 'generating')
    session.transact('Delete Media', (d) => deleteMedia(d, [gone]))
    fake.release()
    await svc.idle(session)
    expect(entry(gone)).toBeUndefined()
    await expect(fs.stat(path.join(session.path, 'media', `gen-${gone.slice(0, 8)}.png`))).rejects.toThrow()
    session.undo()
    await waitFor(() => entry(gone)?.generationStatus === undefined)
    await svc.idle(session)
    expect(entry(gone)!.source).toEqual({ project: { relativePath: `media/gen-${gone.slice(0, 8)}.png` } })
  })

  it('cancels jobs whose placeholders are gone when the project closes', async () => {
    const svc = makeService(makeApp())
    behavior = () => ({ hold: true })
    const [id] = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: imageInput, references: [], numImages: 1, undoLabel: 'Generate Image' })
    await waitFor(() => entry(id)!.generationStatus === 'generating')
    session.undo()
    expect(entry(id)).toBeUndefined()
    const requestId = fake.submissions.at(-1)!.id
    await session.close()
    svc.sweepClosed()
    await waitFor(() => fake.cancels.includes(requestId))
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
