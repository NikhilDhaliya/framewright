import { useMemo, useState } from 'react'
import { DEFAULT_FCPXML_TARGET, DEFAULT_FCPXML_VERSION, FCPXML_TARGET_NAMES, FCPXML_VERSIONS, FCPXML_VERSION_NOTES, type FCPXMLTarget, type FCPXMLVersion } from '@core/interchange/types'
import { QUALITY_PRESETS, qualityResolution } from '@core/ops/project'
import { formatTimecode } from '@core/time'
import { totalFrames } from '@core/timeline'
import type { ExportFormat, ExportJob, ExportOptions } from '../../shared/api'
import { closeDialog } from '../state/dialogs'
import { useEditor } from '../state/editor'
import { useDoc, useProject, timelineOf } from '../state/project'
import { Capsule, IconButton } from '../ui/buttons'
import { Checkbox, MenuValue, MiddleTruncate, Segmented } from '../ui/controls'
import { Icon, type SFName } from '../ui/Icon'
import type { MenuItem } from '../ui/Menu'
import { Sheet } from '../ui/Sheet'
import { FormRow, SheetFooter, dialogKeys } from './common'
import { isFinishedJob, useExportQueueHasActivity, useProjectExportJobs } from './exportJobs'
import './exportQueue.css'
import { activeLocale, t } from '../i18n'

type Destination = 'video' | 'audio' | 'timeline' | 'project'
type Quality = NonNullable<ExportOptions['quality']>
type ResolutionChoice = 'match' | (typeof QUALITY_PRESETS)[number]['label']

const FORMATS: Record<Destination, { value: ExportFormat; label: string; container: string }[]> = {
  video: [
    { value: 'mp4', label: 'MP4', container: 'MPEG-4' },
    { value: 'mov', label: t('QuickTime (MOV)'), container: 'QuickTime' },
    { value: 'webm', label: 'WebM', container: 'WebM' },
    { value: 'gif', label: t('Animated GIF'), container: 'GIF' },
  ],
  audio: [
    { value: 'm4a', label: 'M4A (AAC)', container: 'MPEG-4 Audio' },
    { value: 'wav', label: 'WAV (PCM)', container: 'WAVE' },
  ],
  timeline: [
    { value: 'fcpxml', label: t('FCPXML (DaVinci Resolve, Final Cut Pro)'), container: 'FCPXML' },
    { value: 'xml', label: t('XMEML (Premiere Pro, Resolve)'), container: 'XML' },
  ],
  project: [{ value: 'palmier', label: t('{app} Project'), container: t('{app} package') }],
}

const CODECS: Partial<Record<ExportFormat, { value: string; label: string }[]>> = {
  mp4: [
    { value: 'h264', label: 'H.264' },
    { value: 'hevc', label: 'H.265 (HEVC)' },
  ],
  mov: [
    { value: 'prores', label: 'Apple ProRes 422' },
    { value: 'h264', label: 'H.264' },
    { value: 'hevc', label: 'H.265 (HEVC)' },
    { value: 'hevc-hdr', label: t('HEVC 10-bit HDR') },
  ],
  webm: [{ value: 'vp9', label: 'VP9' }],
}

/** Bytes per second per output megapixel (spec 04 §11.1 estimate). */
const BPS_PER_MP: Record<string, number> = { h264: 0.63e6, hevc: 0.32e6, prores: 9.0e6, 'hevc-hdr': 0.45e6 }

const QUALITIES: { value: Quality; label: string }[] = [
  { value: 'low', label: t('Low') },
  { value: 'medium', label: t('Medium') },
  { value: 'high', label: t('High') },
  { value: 'max', label: t('Maximum') },
]

const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]

const even = (v: number) => Math.max(2, Math.trunc(Math.round(v) / 2) * 2)

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1e3))} KB`
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

const timeFormat = new Intl.DateTimeFormat(activeLocale(), { hour: 'numeric', minute: '2-digit' })

/** Mac `exportStatusLabel` / `exportStatusIcon` (ExportView.swift); Linux has no separate preparing/canceling states. */
const STATUS: Record<ExportJob['status'], { label: string; icon: SFName }> = {
  queued: { label: t('Queued'), icon: 'clock' },
  running: { label: t('Rendering'), icon: 'arrow.up.circle.fill' },
  completed: { label: t('Completed'), icon: 'checkmark.circle.fill' },
  failed: { label: t('Failed'), icon: 'exclamationmark.circle.fill' },
  cancelled: { label: t('Canceled'), icon: 'xmark.circle' },
}

function QueueRow({ job }: { job: ExportJob }) {
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100)
  const status = STATUS[job.status]
  const running = job.status === 'running'
  const action =
    job.status === 'queued' ? (
      <IconButton sf="xmark" size={9} frame={18} tone="tertiary" tip={t('Remove from Queue')} onClick={() => void window.palmier.export.cancel(job.id)} />
    ) : running ? (
      <IconButton sf="stop.fill" size={9} frame={18} tone="tertiary" tip={t('Cancel Export')} onClick={() => void window.palmier.export.cancel(job.id)} />
    ) : job.status === 'completed' ? (
      <IconButton sf="folder" size={10} frame={18} tone="tertiary" tip={t('Show in Folder')} onClick={() => window.palmier.app.showItemInFolder(job.outputPath)} />
    ) : (
      <IconButton sf="xmark" size={9} frame={18} tone="tertiary" tip={t('Dismiss')} onClick={() => void window.palmier.export.remove(job.id)} />
    )
  return (
    <div className="pp-export-row" data-tip={job.error ?? job.outputPath} data-job-status={job.status}>
      <span className="pp-export-row-time tnum">{timeFormat.format(new Date(job.startedAt))}</span>
      <span className={`pp-export-row-icon ${job.status}`} role="img" aria-label={status.label}>
        <Icon sf={status.icon} size={10} />
      </span>
      <div className="pp-export-row-main">
        <MiddleTruncate text={baseName(job.outputPath)} className="pp-export-row-name" />
        {job.status === 'failed' && job.error ? <span className="pp-export-row-error ellipsis">{job.error}</span> : null}
      </div>
      <div className="pp-export-row-progress">
        <div className="pp-dlg-progress" style={{ width: 96, visibility: running ? 'visible' : 'hidden' }}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="pp-export-row-pct tnum">{running ? `${pct}%` : ''}</span>
      </div>
      <span className="pp-export-row-action">{action}</span>
    </div>
  )
}

/** Right-hand log pane of the Export sheet (ExportView `logHeader` + `exportLog`): newest first. */
function ExportQueuePane() {
  const jobs = useProjectExportJobs()
  const pending = jobs.filter((j) => !isFinishedJob(j)).length
  const hasFinished = jobs.some(isFinishedJob)
  return (
    <div className="pp-export-queue">
      <div className="pp-export-queue-header">
        <span className="pp-export-queue-title">{t('Export Queue')}</span>
        {pending > 0 && <span className="pp-export-queue-count tnum">{pending}</span>}
        <span style={{ flex: 1 }} />
        <IconButton sf="trash" size={10} frame={18} tone="tertiary" tip={t('Clear Finished')} disabled={!hasFinished} onClick={() => void window.palmier.export.clearFinished()} />
      </div>
      {jobs.length === 0 ? (
        <div className="pp-export-queue-empty">{t('No exports yet')}</div>
      ) : (
        <div className="pp-export-queue-list">
          {[...jobs].reverse().map((j) => (
            <QueueRow key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ExportDialog() {
  const doc = useDoc()
  const projectName = useProject((s) => s.snapshot?.name ?? 'Export')
  const editorRange = useEditor((s) => s.range)
  const active = timelineOf(doc)
  const [timelineId, setTimelineId] = useState(active?.id ?? '')
  const timeline = doc?.file.timelines.find((t) => t.id === timelineId) ?? active
  const [destination, setDestination] = useState<Destination>('video')
  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [codec, setCodec] = useState('h264')
  const [resolution, setResolution] = useState<ResolutionChoice>('match')
  const [fps, setFps] = useState<number | null>(null)
  const [quality, setQuality] = useState<Quality>('high')
  const [useRange, setUseRange] = useState(false)
  const [includeAudio, setIncludeAudio] = useState(true)
  const [fcpxmlVersion, setFcpxmlVersion] = useState<FCPXMLVersion>(DEFAULT_FCPXML_VERSION)
  const [fcpxmlTarget, setFcpxmlTarget] = useState<FCPXMLTarget>(DEFAULT_FCPXML_TARGET)
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const queueActive = useExportQueueHasActivity()

  const range = editorRange && editorRange.end !== editorRange.start && timeline?.id === active?.id ? { start: Math.min(editorRange.start, editorRange.end), end: Math.max(editorRange.start, editorRange.end) } : null
  const exportFps = fps ?? timeline?.fps ?? 30
  const size = useMemo(() => {
    if (!timeline) return { width: 0, height: 0 }
    if (resolution === 'match') return { width: even(timeline.width), height: even(timeline.height) }
    const preset = QUALITY_PRESETS.find((q) => q.label === resolution)!
    const r = qualityResolution(preset.shortEdge, timeline.width, timeline.height)
    return { width: even(r.width), height: even(r.height) }
  }, [timeline, resolution])

  if (!doc || !timeline) return null

  const formatInfo = FORMATS[destination].find((f) => f.value === format) ?? FORMATS[destination][0]
  const codecs = CODECS[format]
  const isVideo = destination === 'video'
  const isMedia = destination === 'video' || destination === 'audio'
  const frames = useRange && range ? range.end - range.start : totalFrames(timeline)
  const seconds = frames / timeline.fps
  const estimate = isVideo && frames > 0 && BPS_PER_MP[codec] ? BPS_PER_MP[codec] * Math.max(0.1, (size.width * size.height) / 1e6) * seconds : null
  const defaultName = doc.file.timelines.length > 1 ? `${projectName} – ${timeline.name}` : projectName

  const selectDestination = (d: Destination) => {
    setDestination(d)
    const f = FORMATS[d][0].value
    setFormat(f)
    setCodec(CODECS[f]?.[0].value ?? '')
    setOutputPath(null)
    setError(null)
  }
  const selectFormat = (f: ExportFormat) => {
    setFormat(f)
    setCodec(CODECS[f]?.[0].value ?? '')
    setOutputPath(null)
  }

  const choose = async () => {
    const p = await window.palmier.export.chooseOutput(defaultName, format)
    if (p) setOutputPath(p)
    return p
  }

  const start = async () => {
    if (busy) return
    setError(null)
    const target = outputPath ?? (await choose())
    if (!target) return
    setBusy(true)
    const options: ExportOptions = { timelineId: timeline.id, format, outputPath: target }
    if (isMedia) {
      if (useRange && range) options.range = range
      options.includeAudio = destination === 'audio' || (format !== 'gif' && includeAudio)
    }
    if (format === 'fcpxml') {
      options.fcpxmlVersion = fcpxmlVersion
      options.fcpxmlTarget = fcpxmlTarget
    }
    if (isVideo) {
      if (codecs) options.codec = codec
      options.width = size.width
      options.height = size.height
      options.fps = exportFps
      options.quality = quality
    }
    const r = await window.palmier.export.start(options)
    setBusy(false)
    if (!r.ok) setError(r.error)
    else setOutputPath(null)
  }

  const menu = <T,>(choices: { value: T; label: string }[], current: T, pick: (v: T) => void): (() => MenuItem[]) => () => choices.map((c) => ({ label: c.label, checked: c.value === current, onSelect: () => pick(c.value) }))

  const summary = [formatTimecode(frames, timeline.fps), estimate !== null ? `~${formatBytes(estimate)}` : null, isVideo ? `${size.width} × ${size.height}` : null, formatInfo.container].filter(Boolean).join('  ·  ')

  return (
    <Sheet width={1020} className="pp-export-sheet" style={{ height: 600 }} onClose={closeDialog}>
      <div className="pp-dlg" {...dialogKeys(() => void start())}>
        <div className="pp-dlg-header">
          <span className="pp-dlg-title">{t('Export')}</span>
          <span style={{ flex: 1 }} />
          <Segmented
            options={[
              { value: 'video', label: t('Video') },
              { value: 'audio', label: t('Audio') },
              { value: 'timeline', label: t('Timeline') },
              { value: 'project', label: t('Project') },
            ]}
            value={destination}
            onChange={selectDestination}
          />
        </div>
        <div className="pp-dlg-form">
          {doc.file.timelines.length > 1 && (
            <FormRow label={t('Timeline')}>
              <MenuValue text={timeline.name} width={260} items={menu(doc.file.timelines.map((t) => ({ value: t.id, label: t.name })), timeline.id, setTimelineId)} />
            </FormRow>
          )}
          {destination !== 'project' && (
            <FormRow label={t('Format')}>
              <MenuValue text={formatInfo.label} width={260} items={menu(FORMATS[destination], format, selectFormat)} />
            </FormRow>
          )}
          {format === 'fcpxml' && (
            <>
              <FormRow label={t('Version')}>
                <MenuValue
                  text={`FCPXML ${fcpxmlVersion} — ${FCPXML_VERSION_NOTES[fcpxmlVersion]}`}
                  width={260}
                  items={menu(FCPXML_VERSIONS.map((v) => ({ value: v, label: `FCPXML ${v} — ${FCPXML_VERSION_NOTES[v]}` })), fcpxmlVersion, setFcpxmlVersion)}
                />
              </FormRow>
              <FormRow label={t('Target')}>
                <MenuValue
                  text={FCPXML_TARGET_NAMES[fcpxmlTarget]}
                  width={260}
                  items={menu((Object.keys(FCPXML_TARGET_NAMES) as FCPXMLTarget[]).map((t) => ({ value: t, label: FCPXML_TARGET_NAMES[t] })), fcpxmlTarget, setFcpxmlTarget)}
                />
              </FormRow>
            </>
          )}
          {isVideo && codecs && (
            <FormRow label={t('Codec')}>
              <MenuValue text={codecs.find((c) => c.value === codec)?.label ?? ''} width={260} items={menu(codecs, codec, setCodec)} />
            </FormRow>
          )}
          {isVideo && (
            <>
              <FormRow label={t('Resolution')}>
                <MenuValue
                  text={resolution === 'match' ? t('Match Timeline ({0} × {1})', even(timeline.width), even(timeline.height)) : `${resolution} (${size.width} × ${size.height})`}
                  width={260}
                  items={menu<ResolutionChoice>([{ value: 'match', label: t('Match Timeline') }, ...QUALITY_PRESETS.map((q) => ({ value: q.label, label: q.label }))], resolution, setResolution)}
                />
              </FormRow>
              <FormRow label={t('Frame Rate')}>
                <MenuValue
                  text={fps === null ? t('{0} fps (Timeline)', exportFps) : t('{0} fps', exportFps)}
                  width={260}
                  items={() => [
                    { label: t('Timeline ({0} fps)', timeline.fps), checked: fps === null, onSelect: () => setFps(null) },
                    { kind: 'divider' },
                    ...FPS_CHOICES.map((v) => ({ label: t('{0} fps', v), checked: fps === v, onSelect: () => setFps(v) })),
                  ]}
                />
              </FormRow>
              <FormRow label={t('Quality')}>
                <Segmented options={QUALITIES} value={quality} onChange={setQuality} />
              </FormRow>
            </>
          )}
          {isMedia && (
            <FormRow label={t('Range')} hint={range ? undefined : t('Set In and Out points (I / O) on the timeline to export a range.')}>
              <Segmented
                options={[
                  { value: 'all', label: t('Entire Timeline') },
                  { value: 'range', label: range ? t('In–Out ({0})', formatTimecode(range.end - range.start, timeline.fps)) : t('In–Out Range') },
                ]}
                value={useRange && range ? 'range' : 'all'}
                onChange={(v) => setUseRange(v === 'range' && !!range)}
              />
            </FormRow>
          )}
          {isVideo && format !== 'gif' && (
            <FormRow label={t('Audio')}>
              <Checkbox checked={includeAudio} onChange={setIncludeAudio} label={t('Include audio')} />
            </FormRow>
          )}
          {destination === 'project' && <div className="pp-dlg-note">{t('Copies the project and all of its media into a self-contained {app} package.')}</div>}
          {destination === 'timeline' && <div className="pp-dlg-note">{t('Interchange timelines reference your original media files; nothing is rendered.')}</div>}
          <FormRow label={t('Save To')}>
            <div className="pp-dlg-path" data-tip={outputPath ?? undefined}>
              {outputPath ? (
                <>
                  <MiddleTruncate text={baseName(outputPath)} className="pp-dlg-path-name" tail={10} />
                  <span className="pp-dlg-path-dir ellipsis">{dirName(outputPath)}</span>
                </>
              ) : (
                <span className="pp-dlg-path-empty">{t('Choose a destination when you export')}</span>
              )}
            </div>
            <Capsule onClick={() => void choose()}>{t('Choose…')}</Capsule>
          </FormRow>
        </div>
        <div className="pp-dlg-summary tnum" dir="auto">{summary}</div>
        <SheetFooter leading={error ? <span className="pp-dlg-error"><Icon sf="exclamationmark.triangle.fill" size={10} />{error}</span> : undefined}>
          <Capsule size="regular" onClick={closeDialog}>
            {t('Close')}
          </Capsule>
          <Capsule size="regular" variant="prominent" disabled={busy || (isMedia && frames <= 0)} onClick={() => void start()}>
            {queueActive ? t('Add to Queue') : t('Export')}
          </Capsule>
        </SheetFooter>
      </div>
      <ExportQueuePane />
    </Sheet>
  )
}
