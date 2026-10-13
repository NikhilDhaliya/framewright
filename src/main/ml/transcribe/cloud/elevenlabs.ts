/** ElevenLabs Scribe v2 (spec 07 §1.6, default cloud provider): word times + diarization + language detection. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizedResult, type TranscriptionWord } from '../../../../core/captions/transcript'
import { CloudTranscriptionError, groupWordsIntoSegments, providerError, type CloudSpeechProvider } from './types'

interface ScribeWord {
  text?: string
  start?: number
  end?: number
  type?: 'word' | 'spacing' | 'audio_event'
  speaker_id?: string
}

export const elevenlabs: CloudSpeechProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  async transcribe(req) {
    const form = new FormData()
    form.set('model_id', 'scribe_v2')
    form.set('diarize', 'true')
    form.set('timestamps_granularity', 'word')
    form.set('tag_audio_events', 'false')
    if (req.language) form.set('language_code', req.language)
    form.set('file', new Blob([await fs.readFile(req.wavPath)], { type: 'audio/wav' }), path.basename(req.wavPath))
    const res = await req.fetch(`${req.baseUrl ?? 'https://api.elevenlabs.io'}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': req.apiKey }, body: form, signal: req.signal })
    if (!res.ok) throw await providerError('ElevenLabs', res)
    const j = (await res.json().catch(() => null)) as { text?: string; language_code?: string; words?: ScribeWord[] } | null
    if (!j || !Array.isArray(j.words)) throw new CloudTranscriptionError('ElevenLabs: unexpected response')
    const words: TranscriptionWord[] = []
    for (const w of j.words) {
      if (w.type !== undefined && w.type !== 'word') continue
      const text = (w.text ?? '').trim()
      if (!text) continue
      const word: TranscriptionWord = { text }
      if (typeof w.start === 'number' && typeof w.end === 'number') {
        word.start = w.start
        word.end = w.end
      }
      if (w.speaker_id !== undefined && w.speaker_id !== null) word.speaker = String(w.speaker_id)
      words.push(word)
    }
    const segments = groupWordsIntoSegments(words)
    return normalizedResult({ text: (j.text ?? segments.map((s) => s.text).join(' ')).trim(), language: j.language_code || undefined, words, segments })
  },
}
