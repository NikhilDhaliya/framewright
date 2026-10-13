/**
 * Runtime voice lists (spec 06 §B12.4.3: ElevenLabs voices come from `GET /v2/voices`, never hard-coded ids).
 * Fetched only when the model's active route is ElevenLabs; the names are also recorded in the core model set so
 * main-side callers (MCP `list_models`, validation) see them.
 */
import { hasKeyFrom } from '../../core/generation/catalog'
import { modelSet, setRuntimeVoices } from '../../core/generation/models'
import type { AppContext } from '../services'
import { createAdapter } from './providers/index'
import { ElevenLabsAdapter } from './providers/elevenlabs'

export async function runtimeVoices(app: AppContext, modelId: string): Promise<string[]> {
  const s = app.settings()
  const m = modelSet(hasKeyFrom(s.apiKeys), s.disabledModelIds ?? []).findAudio(modelId)
  if (!m?.runtimeVoices || m.route?.provider !== 'elevenlabs') return []
  const adapter = createAdapter('elevenlabs', s.apiKeys)
  if (!(adapter instanceof ElevenLabsAdapter)) return []
  try {
    const names = [...new Set((await adapter.listVoices()).map((v) => v.name))]
    setRuntimeVoices(m.id, names)
    return names
  } catch {
    return []
  }
}
