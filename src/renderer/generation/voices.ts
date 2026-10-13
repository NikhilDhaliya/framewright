/** Voice list for the Generate panel: the catalog's, or the provider's for runtime-voice models (ElevenLabs). */
import { useEffect, useState } from 'react'
import { setRuntimeVoices, type AnyModel, type AudioModel } from '@core/generation/models'

const cache = new Map<string, string[]>()

export function useModelVoices(m: AnyModel | null): string[] | null {
  const am = m?.kind === 'audio' ? (m as AudioModel) : null
  const runtime = !!am?.runtimeVoices && am.route?.provider === 'elevenlabs'
  const id = am?.id ?? ''
  const [fetched, setFetched] = useState<string[] | null>(() => cache.get(id) ?? null)
  useEffect(() => {
    if (!runtime) return
    let alive = true
    setFetched(cache.get(id) ?? null)
    void window.palmier.generation.voices(id).then((names) => {
      cache.set(id, names)
      setRuntimeVoices(id, names)
      if (alive) setFetched(names)
    })
    return () => {
      alive = false
    }
  }, [id, runtime])
  if (!am) return null
  if (am.runtimeVoices) return runtime && fetched?.length ? fetched : null
  return am.voices
}
