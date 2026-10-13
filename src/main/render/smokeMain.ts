/**
 * Headless Electron entry for scripts/smoke-render.mjs: opens a project, runs the captures, text
 * measurements and exports listed in $PALMIER_SMOKE_TASKS and writes a JSON report.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TextStyle } from '../../core/model'
import type { ExportJob, ExportOptions } from '../../shared/api'
import { createExportService } from '../export/exportService'
import { Semaphore } from '../ml/jobs'
import { DenoiseService } from '../ml/audio/denoise'
import { appDirs } from '../paths'
import { ProjectSession } from '../project/session'
import { createRenderService } from './renderService'

interface SmokeTasks {
  project: string
  report: string
  captures?: { timelineId: string; frame: number; width?: number; format?: 'png' | 'jpeg'; out: string }[]
  measure?: { content: string; style: TextStyle; canvasWidth: number; canvasHeight: number }[]
  exports?: (ExportOptions & { cancelAfterMs?: number })[]
  /** Lottie frames rendered standalone (thumbnails / inspect_media path): one PNG per frame, `<outPrefix><frame>.png`. */
  lottieFrames?: { file: string; frames: number[]; maxSide: number; background?: string; outPrefix: string }[]
}

interface ExportRecord {
  job: ExportJob
  /** Every progress event: [status, progress, framesRendered]. */
  events: [string, number, number][]
  /** Dot-prefixed (staging) names seen in the output directory while the job ran. */
  staging: string[]
  /** Processes still referencing the output directory once the job settled. */
  lingering: string[]
  ms: number
}

const processesMentioning = (needle: string): Promise<string[]> =>
  new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 1 << 24 }, (err, out) => resolve(err ? [] : out.split('\n').filter((l) => l.includes(needle) && !l.includes(' ps -eo'))))
  })

if (process.env.PALMIER_SMOKE_SWIFTSHADER) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

async function main(): Promise<void> {
  const tasksPath = process.env.PALMIER_SMOKE_TASKS
  if (!tasksPath) throw new Error('PALMIER_SMOKE_TASKS is not set')
  const tasks = JSON.parse(await fs.readFile(tasksPath, 'utf8')) as SmokeTasks
  await app.whenReady()
  const session = await ProjectSession.open(tasks.project)
  const render = createRenderService()
  const exporter = createExportService(render, { denoise: new DenoiseService(appDirs.cache, new Semaphore(1)) })
  const report: { captures: unknown[]; measure: unknown; exports: ExportRecord[]; lottieFrames: unknown[] } = { captures: [], measure: null, exports: [], lottieFrames: [] }
  const events = new Map<string, [string, number, number][]>()
  exporter.on('progress', (j) => events.get(j.id)?.push([j.status, j.progress, j.framesRendered]))
  try {
    for (const c of tasks.captures ?? []) {
      const t0 = Date.now()
      try {
        const bytes = await render.captureFrame(session, c)
        await fs.writeFile(c.out, bytes)
        report.captures.push({ out: c.out, ok: true, ms: Date.now() - t0 })
      } catch (e) {
        report.captures.push({ out: c.out, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    for (const l of tasks.lottieFrames ?? []) {
      try {
        const pngs = await render.lottieFrames(l.file, l)
        const outs = await Promise.all(pngs.map(async (png, i) => {
          const out = `${l.outPrefix}${l.frames[i]}.png`
          await fs.writeFile(out, png)
          return out
        }))
        report.lottieFrames.push({ file: l.file, ok: true, outs })
      } catch (e) {
        report.lottieFrames.push({ file: l.file, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (tasks.measure?.length) report.measure = await render.measureText(tasks.measure).catch((e: unknown) => ({ error: String(e) }))
    for (const o of tasks.exports ?? []) {
      const { cancelAfterMs, ...options } = o
      const t0 = Date.now()
      const job = exporter.start(session, options)
      const log: [string, number, number][] = [[job.status, job.progress, job.framesRendered]]
      events.set(job.id, log)
      const dir = path.dirname(job.outputPath)
      const staging = new Set<string>()
      const watch = setInterval(() => {
        void fs.readdir(dir).then((names) => names.filter((n) => n.startsWith('.')).forEach((n) => staging.add(n)), () => undefined)
      }, 50)
      if (cancelAfterMs !== undefined) setTimeout(() => exporter.cancel(job.id), cancelAfterMs)
      const done = await exporter.wait(job.id)
      clearInterval(watch)
      report.exports.push({ job: done, events: log, staging: [...staging], lingering: await processesMentioning(dir), ms: Date.now() - t0 })
    }
  } finally {
    await fs.writeFile(tasks.report, JSON.stringify(report, null, 2))
    exporter.dispose()
    await render.dispose()
    await session.close()
  }
}

main().then(
  () => app.exit(0),
  (e) => {
    console.error(e)
    app.exit(1)
  },
)
