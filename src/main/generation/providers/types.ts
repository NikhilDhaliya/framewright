/** BYOK provider adapter contract (spec 06 §B12.0). */
import type { ByokRoute, CatalogEntry } from '../../../core/generation/catalog'
import type { ByokJobHandle, GenerationParams } from '../../../core/generation/params'

export interface LocalInput {
  path: string
  mime: string
  size: number
}

/** A downloadable result URL, or bytes the provider returned inline. */
export type Output = { url: string; headers?: Record<string, string> } | { bytes: Buffer; mime: string }

export type PollResult = { state: 'queued' | 'running' } | { state: 'succeeded'; outputs: Output[] } | { state: 'failed'; message: string }

export interface ProviderAdapter {
  /** Makes a local file usable as a request input: a URL or a data: URI. */
  prepareInput(file: LocalInput, signal?: AbortSignal): Promise<string>
  /** Starts the job; returns a resumable handle, or the outputs for synchronous APIs. */
  submit(entry: CatalogEntry, route: ByokRoute, params: GenerationParams, signal?: AbortSignal): Promise<{ handle: ByokJobHandle } | { outputs: Output[] }>
  poll(handle: ByokJobHandle, signal?: AbortSignal): Promise<PollResult>
  cancel?(handle: ByokJobHandle): Promise<void>
}

export class ProviderError extends Error {
  /** HTTP status of the provider response, when the error came from one. */
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}
