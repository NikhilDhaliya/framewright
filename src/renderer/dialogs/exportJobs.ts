/**
 * Renderer mirror of the export queue (Mac `ExportQueue.shared`): one store fed by `export:list`, progress and
 * removal events, read per project like `ExportQueue.jobs(for:)`. Used by the Export dialog's queue pane and the
 * title bar's Export button.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { ExportJob } from '../../shared/api'
import { useProject } from '../state/project'
import { t } from '../i18n'

interface JobsStore {
  jobs: ExportJob[]
}

const useJobsStore = create<JobsStore>(() => ({ jobs: [] }))
let subscribed = false

/** Upserts a job, keeping enqueue order (startedAt) like the Mac's `jobs` array. */
export function upsertJob(jobs: ExportJob[], job: ExportJob): ExportJob[] {
  const i = jobs.findIndex((j) => j.id === job.id)
  if (i >= 0) {
    const next = [...jobs]
    next[i] = job
    return next
  }
  return [...jobs, job].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function subscribe(): void {
  if (subscribed || !window.palmier?.export) return
  subscribed = true
  const api = window.palmier.export
  api.onProgress((job) => useJobsStore.setState((s) => ({ jobs: upsertJob(s.jobs, job) })))
  api.onRemoved((ids) => {
    const drop = new Set(ids)
    useJobsStore.setState((s) => ({ jobs: s.jobs.filter((j) => !drop.has(j.id)) }))
  })
  void api.list().then((list) => useJobsStore.setState((s) => ({ jobs: list.reduce(upsertJob, s.jobs) })))
}

/** Jobs started from this window's project, oldest first. */
export function useProjectExportJobs(): ExportJob[] {
  useEffect(subscribe, [])
  const jobs = useJobsStore((s) => s.jobs)
  const projectPath = useProject((s) => s.snapshot?.path)
  return useMemo(() => jobs.filter((j) => !j.projectPath || j.projectPath === projectPath), [jobs, projectPath])
}

export const isFinishedJob = (j: ExportJob): boolean => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled'

/** Title bar counts (TitleBarTrailingView): running vs waiting jobs. */
export function exportCounts(jobs: ExportJob[]): { active: number; waiting: number } {
  let active = 0
  let waiting = 0
  for (const j of jobs) {
    if (j.status === 'running') active++
    else if (j.status === 'queued') waiting++
  }
  return { active, waiting }
}

/** The Export button's accessible label (`Export, {n} active, {m} waiting` while jobs exist). */
export function exportButtonLabel({ active, waiting }: { active: number; waiting: number }): string {
  return active === 0 && waiting === 0 ? t('Export') : t('Export, {0} active, {1} waiting', active, waiting)
}

/** Mac `ExportQueue.hasActivity`: any job of any project is waiting or running (the sheet says "Add to Queue"). */
export function useExportQueueHasActivity(): boolean {
  useEffect(subscribe, [])
  return useJobsStore((s) => s.jobs.some((j) => j.status === 'queued' || j.status === 'running'))
}
