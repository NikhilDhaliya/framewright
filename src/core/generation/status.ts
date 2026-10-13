/** Generation status strings and predicates (spec 06 §B5.1, 01 §5.14), plus typed reads of `generationInput`. */
import type { GenerationInput, MediaManifestEntry } from '../model'
import { isByokJobHandle, type ByokJobHandle } from './params'

export type GenerationPhase = 'preparing' | 'generating' | 'downloading' | 'rendering'
export type GenerationStatus = { kind: 'none' } | { kind: GenerationPhase } | { kind: 'failed'; message: string }

const PHASES: GenerationPhase[] = ['preparing', 'generating', 'downloading', 'rendering']
export const FAILED_PREFIX = 'failed: '

export function parseStatus(s: string | undefined): GenerationStatus {
  if (!s || s === 'none') return { kind: 'none' }
  if (s.startsWith(FAILED_PREFIX)) return { kind: 'failed', message: s.slice(FAILED_PREFIX.length) }
  if (s === 'failed') return { kind: 'failed', message: '' }
  return PHASES.includes(s as GenerationPhase) ? { kind: s as GenerationPhase } : { kind: 'none' }
}

export const failedStatus = (message: string): string => `${FAILED_PREFIX}${message}`
export const isInFlight = (s: string | undefined): boolean => PHASES.includes(s as GenerationPhase)

export const STATUS_LABELS: Record<GenerationPhase, string> = {
  preparing: 'Preparing…',
  generating: 'Generating…',
  downloading: 'Downloading…',
  rendering: 'Rendering…',
}

/** Shown for assets whose job only the Mac can finish (§B5.2); never persisted. */
export const FOREIGN_JOB_MESSAGE = 'Started on macOS. Open this project in Palmier Pro on macOS to finish it.'

export function byokJobOf(input: GenerationInput | undefined): ByokJobHandle | null {
  const h = input?.byokJob
  return isByokJobHandle(h) ? h : null
}

export const resultURLsOf = (input: GenerationInput | undefined): string[] =>
  Array.isArray(input?.resultURLs) ? (input!.resultURLs as unknown[]).filter((u): u is string => typeof u === 'string') : []

/** An asset carrying only a Mac `backendJobId` (§B5.2). */
export function isForeignJob(e: MediaManifestEntry): boolean {
  const input = e.generationInput
  return !!input && typeof input.backendJobId === 'string' && input.backendJobId !== '' && !byokJobOf(input)
}

/** What a tile/preview should show for an asset: in-flight phase, failure, or nothing. */
export function displayStatus(e: MediaManifestEntry): GenerationStatus {
  const s = parseStatus(e.generationStatus)
  if (s.kind !== 'none' && s.kind !== 'failed' && isForeignJob(e)) return { kind: 'failed', message: FOREIGN_JOB_MESSAGE }
  return s
}

export const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
