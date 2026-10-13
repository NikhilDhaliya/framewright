/** Adapter per BYOK provider from the stored keys (spec 06 §B12.0). Env base-URL overrides point at fake servers in tests. */
import type { AppSettings } from '../../../shared/api'
import { ElevenLabsAdapter, elevenLabsBaseFromEnv } from './elevenlabs'
import { FalAdapter, falBasesFromEnv } from './fal'
import { GoogleAdapter, googleBaseFromEnv } from './google'
import type { ProviderAdapter } from './types'

export interface AdapterFactoryOptions {
  fetch?: typeof fetch
  /** fal base URLs; `undefined` = from PALMIER_FAL_BASE_URL, `null` = production. */
  falBases?: { queueBase: string; restBase: string } | null
  env?: NodeJS.ProcessEnv
}

export function createAdapter(provider: string, apiKeys: AppSettings['apiKeys'] | undefined, o: AdapterFactoryOptions = {}): ProviderAdapter | null {
  const env = o.env ?? process.env
  switch (provider) {
    case 'fal': {
      const key = apiKeys?.fal
      if (!key) return null
      const bases = o.falBases !== undefined ? o.falBases : falBasesFromEnv(env)
      return new FalAdapter({ key, ...(bases ?? {}), fetch: o.fetch })
    }
    case 'google': {
      const key = apiKeys?.google
      return key ? new GoogleAdapter({ key, base: googleBaseFromEnv(env) ?? undefined, fetch: o.fetch }) : null
    }
    case 'elevenlabs': {
      const key = apiKeys?.elevenlabs
      return key ? new ElevenLabsAdapter({ key, base: elevenLabsBaseFromEnv(env) ?? undefined, fetch: o.fetch }) : null
    }
    default:
      return null
  }
}
