/** Cloud provider registry. Deepgram (spec 07 §1.6 adapter 2) has no API-key slot yet; the interface is ready for it. */
import type { AppSettings } from '../../../../shared/api'
import { elevenlabs } from './elevenlabs'
import { openai } from './openai'
import type { CloudProviderId, CloudSpeechProvider } from './types'

export const CLOUD_PROVIDERS: Partial<Record<CloudProviderId, CloudSpeechProvider>> = { elevenlabs, openai }

/** Recommended order: ElevenLabs Scribe, then OpenAI. */
const ORDER: CloudProviderId[] = ['elevenlabs', 'openai']

export interface ResolvedCloud {
  provider: CloudSpeechProvider
  apiKey: string
}

/** The configured provider when its key exists, else the first provider with a key; null = Cloud unavailable. */
export function resolveCloudProvider(settings: Pick<AppSettings, 'apiKeys'> & { transcription?: { cloudProvider?: string } }): ResolvedCloud | null {
  const keys = settings.apiKeys as Record<string, string | undefined>
  const preferred = settings.transcription?.cloudProvider as CloudProviderId | undefined
  const ids = preferred ? [preferred, ...ORDER.filter((x) => x !== preferred)] : ORDER
  for (const id of ids) {
    const provider = CLOUD_PROVIDERS[id]
    const key = keys[id]
    if (provider && key) return { provider, apiKey: key }
  }
  return null
}

export const CLOUD_UNAVAILABLE_MESSAGE = 'Add a speech-to-text API key in Settings to use Cloud.'
