/**
 * "Seek the source preview to the hit" (05 §4.10, Mac `selectMediaPanelItem(atSourceFrame:)`): a pending request the
 * source preview of that asset consumes once its media is ready.
 */
import { create } from 'zustand'

export interface SourceSeekRequest {
  assetId: string
  seconds: number
  nonce: number
}

export const useSourceSeek = create<{ request: SourceSeekRequest | null }>(() => ({ request: null }))

let nonce = 0

export function requestSourceSeek(assetId: string, seconds: number): void {
  useSourceSeek.setState({ request: { assetId, seconds: Math.max(0, seconds), nonce: ++nonce } })
}

/** Takes the pending request for `assetId` (null if none). */
export function takeSourceSeek(assetId: string): SourceSeekRequest | null {
  const r = useSourceSeek.getState().request
  if (!r || r.assetId !== assetId) return null
  useSourceSeek.setState({ request: null })
  return r
}
