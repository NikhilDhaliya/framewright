/** Speech audio extraction (spec 07 §1.2): first audio stream → 16 kHz mono s16le WAV in the temp dir, at most 2 at once. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TranscriptionError } from '../../../core/captions/transcript'
import { ffmpegPath, ffprobePath, run } from '../../media/ffmpeg'
import { Semaphore } from '../jobs'

const extractionGate = new Semaphore(2)

/** True when ffprobe sees an audio stream. */
export async function hasAudioStream(file: string, signal?: AbortSignal): Promise<boolean> {
  const out = await run(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { signal })
  return out.toString().trim().length > 0
}

export interface ExtractOptions {
  range?: [number, number]
  signal?: AbortSignal
}

/** Writes `framewright-stt-<uuid>.wav`; the caller deletes it. No audio stream / no samples map to the Mac's errors. */
export async function extractSpeechWav(src: string, opts: ExtractOptions = {}): Promise<string> {
  const name = path.basename(src)
  return extractionGate.run(async () => {
    try {
      await fs.access(src)
    } catch {
      throw new TranscriptionError('audioExtractionFailed', `${name} is offline`)
    }
    const audio = await hasAudioStream(src, opts.signal).catch((e: unknown) => {
      if (opts.signal?.aborted) throw e
      throw new TranscriptionError('audioExtractionFailed', e instanceof Error ? e.message : String(e))
    })
    if (!audio) throw new TranscriptionError('audioExtractionFailed', `No audio track in ${name}`)
    const out = path.join(os.tmpdir(), `framewright-stt-${randomUUID()}.wav`)
    const range = opts.range
    const args = ['-nostdin', '-v', 'error', '-y']
    if (range) args.push('-ss', range[0].toFixed(3))
    args.push('-i', src)
    if (range) args.push('-t', Math.max(0.001, range[1] - range[0]).toFixed(3))
    args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', out)
    try {
      await run(ffmpegPath, args, { signal: opts.signal })
      const size = (await fs.stat(out)).size
      if (size <= 44) throw new TranscriptionError('audioExtractionFailed', `No audio samples in ${name}`)
      return out
    } catch (e) {
      await fs.rm(out, { force: true })
      if (e instanceof TranscriptionError || opts.signal?.aborted) throw e
      throw new TranscriptionError('audioExtractionFailed', e instanceof Error ? e.message.split('\n').pop()! : String(e))
    }
  }, opts.signal)
}

export interface Pcm16 {
  sampleRate: number
  samples: Int16Array
}

/** Reads a canonical PCM16 mono WAV (as written above). */
export async function readWav16(file: string): Promise<Pcm16> {
  const buf = await fs.readFile(file)
  let off = 12
  let rate = 16000
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12)
    if (id === 'data') {
      const end = Math.min(buf.length, off + 8 + size)
      const bytes = buf.subarray(off + 8, end - ((end - off - 8) % 2))
      return { sampleRate: rate, samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) }
    }
    off += 8 + size + (size % 2)
  }
  return { sampleRate: rate, samples: new Int16Array() }
}

export async function writeWav16(file: string, pcm: Pcm16): Promise<void> {
  const data = Buffer.from(pcm.samples.buffer, pcm.samples.byteOffset, pcm.samples.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(pcm.sampleRate, 24)
  h.writeUInt32LE(pcm.sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  await fs.writeFile(file, Buffer.concat([h, data]))
}
