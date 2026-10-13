/**
 * Preview audio (spec 04 §10): one media element per audible clip → MediaElementAudioSourceNode → Gain
 * (envelope automation from the same breakpoints as export) → master gain → analysers → output.
 * The AudioContext clock drives playback; while paused, scrubs play short grains (ScrubAudioEngine).
 */
import { mediaUrl } from '../../shared/api'
import { envelopeAt, pieceEnvelope, type AudioPiece, type GainEnvelope } from './audioPlan'
import type { PlaybackUrls } from './previewSources'

const LOOKAHEAD_SEC = 1.5
const START_LEAD_SEC = 0.02
const DRIFT_SEC = 0.15
/** ScrubAudioEngine: 2400-sample grains with 144-sample edge fades at 48 kHz. */
const GRAIN_SEC = 0.05
const GRAIN_FADE_SEC = 0.003
/** A running grain is extended instead of re-seeked when the next one starts this close ahead of it. */
const GRAIN_CONTINUE_SEC = 0.12
/** Chromium's HTMLMediaElement playbackRate limits. */
const MIN_ELEMENT_RATE = 0.0625
const MAX_ELEMENT_RATE = 16

interface Voice {
  piece: AudioPiece
  env: GainEnvelope
  el: HTMLAudioElement
  node: MediaElementAudioSourceNode
  gain: GainNode
  url: string
  /** Timeline-frame anchor the automation was scheduled for (NaN = not scheduled). */
  scheduledAt: number
  started: boolean
  grainTimer: ReturnType<typeof setTimeout> | null
}

const elementRate = (r: number) => (r >= MIN_ELEMENT_RATE && r <= MAX_ELEMENT_RATE ? r : null)

export class PreviewAudio {
  readonly ctx: AudioContext
  private readonly master: GainNode
  private readonly analysers: AnalyserNode[]
  private readonly meterBuf: Float32Array<ArrayBuffer>
  private readonly voices = new Map<string, Voice>()
  private pieces: AudioPiece[] = []
  private fps = 30
  private rate = 1
  private anchor: { ctxTime: number; frame: number } | null = null
  private grainSerial = 0
  private grainUntil = 0

  constructor(private readonly urls: PlaybackUrls) {
    this.ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 })
    this.master = this.ctx.createGain()
    // Mono sources play on both channels at unity (speakers up-mix), as on macOS.
    this.master.channelCount = 2
    this.master.channelCountMode = 'explicit'
    this.master.channelInterpretation = 'speakers'
    const split = this.ctx.createChannelSplitter(2)
    this.master.connect(this.ctx.destination)
    this.master.connect(split)
    this.analysers = [0, 1].map((i) => {
      const a = this.ctx.createAnalyser()
      a.fftSize = 1024
      split.connect(a, i)
      return a
    })
    this.meterBuf = new Float32Array(1024)
  }

  setVolume(v: number): void {
    this.master.gain.value = Number.isFinite(v) ? Math.max(0, v) : 1
  }

  /** Whether sound is flowing (playback or a scrub grain); the analysers hold stale data otherwise. */
  get audible(): boolean {
    return this.anchor !== null || this.ctx.currentTime < this.grainUntil
  }

  meter(): number[] {
    if (!this.audible || !this.running) return [0, 0]
    return this.analysers.map((a) => {
      a.getFloatTimeDomainData(this.meterBuf)
      let peak = 0
      for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]))
      return Math.min(1, peak)
    })
  }

  /** Replaces the audible clip set; voices for removed clips are dropped, changed ones rescheduled. */
  setPieces(pieces: AudioPiece[], fps: number): void {
    this.fps = fps
    this.pieces = pieces
    const keep = new Set(pieces.map((p) => p.key))
    for (const [key, v] of this.voices) {
      if (!keep.has(key)) this.dropVoice(key, v)
    }
    for (const p of pieces) {
      const v = this.voices.get(p.key)
      if (v && (v.piece.clip !== p.clip || v.piece.denoise?.gain !== p.denoise?.gain)) {
        v.piece = p
        v.env = pieceEnvelope(p)
        v.scheduledAt = NaN
        v.started = false
        v.el.pause()
      }
    }
  }

  private dropVoice(key: string, v: Voice): void {
    if (v.grainTimer) clearTimeout(v.grainTimer)
    v.el.pause()
    v.gain.disconnect()
    v.node.disconnect()
    v.el.removeAttribute('src')
    v.el.load()
    this.voices.delete(key)
  }

  /** Current timeline frame (fractional) while playing, from the audio clock. */
  frameNow(): number | null {
    if (!this.anchor) return null
    return this.anchor.frame + (this.ctx.currentTime - this.anchor.ctxTime) * this.fps * this.rate
  }

  get running(): boolean {
    return this.ctx.state === 'running'
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined)
  }

  /** Preview rate; a running playback re-anchors at `frame` so automation follows the new speed. */
  setRate(rate: number, frame: number): void {
    this.rate = rate
    if (this.anchor) this.start(frame)
  }

  start(frame: number): void {
    this.cancelGrains()
    this.anchor = { ctxTime: this.ctx.currentTime + START_LEAD_SEC, frame }
    for (const v of this.voices.values()) {
      v.scheduledAt = NaN
      v.started = false
    }
    this.update()
  }

  stop(): void {
    this.anchor = null
    this.cancelGrains()
    for (const v of this.voices.values()) this.silence(v)
  }

  private silence(v: Voice): void {
    v.el.pause()
    v.gain.gain.cancelScheduledValues(0)
    v.gain.gain.value = 0
    v.scheduledAt = NaN
    v.started = false
  }

  private cancelGrains(): void {
    this.grainSerial++
    this.grainUntil = 0
    for (const v of this.voices.values()) {
      if (v.grainTimer) clearTimeout(v.grainTimer)
      v.grainTimer = null
    }
  }

  private voice(p: AudioPiece, url: string): Voice {
    let v = this.voices.get(p.key)
    if (v && v.url === url) return v
    if (v) this.dropVoice(p.key, v)
    const el = new Audio()
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.src = url
    const node = this.ctx.createMediaElementSource(el)
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    node.connect(gain).connect(this.master)
    v = { piece: p, env: pieceEnvelope(p), el, node, gain, url, scheduledAt: NaN, started: false, grainTimer: null }
    this.voices.set(p.key, v)
    return v
  }

  /** Denoise wet twins play the baked wet file; everything else the asset's playback file. */
  private pieceUrl(p: AudioPiece): string | null | undefined {
    return p.denoise?.role === 'wet' ? mediaUrl(p.path) : this.urls.get(p.clip.mediaRef)
  }

  /** Last timeline frame (exclusive) with source audio: speed-1 clips stop at the end of their source (§3.1). */
  private audibleEnd(p: AudioPiece): number {
    const c = p.clip
    const e = c.startFrame + c.durationFrames
    return p.timing.speedOne ? Math.min(e, c.startFrame + p.timing.srcDurSec * this.fps) : e
  }

  private clipRate(p: AudioPiece): number {
    return p.timing.speedOne ? 1 : p.timing.rate
  }

  /** Starts / stops / re-syncs voices around the playhead; call on every playback tick. */
  update(): void {
    const now = this.frameNow()
    if (now === null) return
    const fps = this.fps
    const horizon = now + LOOKAHEAD_SEC * fps * this.rate
    for (const p of this.pieces) {
      const c = p.clip
      const s = c.startFrame
      const e = c.startFrame + c.durationFrames
      if (e <= now || s > horizon) {
        const v = this.voices.get(p.key)
        if (v && v.started && e <= now) {
          v.el.pause()
          v.started = false
        }
        continue
      }
      const url = this.pieceUrl(p)
      if (!url) continue
      const v = this.voice(p, url)
      const clipRate = this.clipRate(p)
      // Rates Chromium cannot play stay silent (it mutes them anyway).
      const rate = elementRate(clipRate * this.rate)
      if (rate === null || now >= this.audibleEnd(p)) {
        if (!v.el.paused) v.el.pause()
        continue
      }
      if (v.el.playbackRate !== rate) v.el.playbackRate = rate
      const srcAt = (frame: number) => p.timing.trimSec + ((frame - s) / fps) * clipRate
      if (Number.isNaN(v.scheduledAt)) this.schedule(v, Math.max(now, s))
      if (now >= s) {
        const want = srcAt(now)
        if (!v.started) {
          v.el.currentTime = want
          void v.el.play().catch(() => undefined)
          v.started = true
        } else if (Math.abs(v.el.currentTime - want) > DRIFT_SEC * rate) {
          v.el.currentTime = want
        }
      } else if (!v.started && Math.abs(v.el.currentTime - p.timing.trimSec) > 0.01) {
        v.el.currentTime = p.timing.trimSec
      }
    }
  }

  /** Gain automation from timeline frame `from` to the clip end (§10.3 ramps). */
  private schedule(v: Voice, from: number): void {
    if (!this.anchor) return
    const { ctxTime, frame } = this.anchor
    const c = v.piece.clip
    const toCtx = (f: number) => ctxTime + (f - frame) / (this.fps * this.rate)
    const g = v.gain.gain
    const o0 = from - c.startFrame
    const t0 = Math.max(this.ctx.currentTime, toCtx(from))
    g.cancelScheduledValues(0)
    g.setValueAtTime(envelopeAt(v.env, o0), t0)
    v.env.offsets.forEach((o, i) => {
      if (o > o0) g.linearRampToValueAtTime(v.env.gains[i], Math.max(t0, toCtx(c.startFrame + o)))
    })
    g.setValueAtTime(0, Math.max(t0, toCtx(c.startFrame + c.durationFrames)))
    v.scheduledAt = from
  }

  /**
   * Scrub audio while paused: a 50 ms grain of every audible clip around timeline frame `frame`, at the
   * envelope gain, with 3 ms edge fades (ScrubAudioEngine). [APPROX] grains come from the clip media
   * elements, so they always play forward and start after the element's seek latency.
   */
  grain(frame: number): void {
    if (this.anchor || !Number.isFinite(frame)) return
    const serial = ++this.grainSerial
    void this.resume().then(() => {
      if (serial !== this.grainSerial || this.anchor) return
      const fps = this.fps
      for (const p of this.pieces) {
        const c = p.clip
        const existing = this.voices.get(p.key)
        if (frame < c.startFrame || frame >= this.audibleEnd(p)) {
          if (existing && !existing.el.paused) this.silence(existing)
          continue
        }
        const url = this.pieceUrl(p)
        if (!url) continue
        const v = this.voice(p, url)
        const clipRate = this.clipRate(p)
        const rate = elementRate(clipRate)
        if (rate === null) continue
        const level = envelopeAt(v.env, frame - c.startFrame)
        const centre = p.timing.trimSec + ((frame - c.startFrame) / fps) * clipRate
        const start = Math.max(0, centre - (GRAIN_SEC / 2) * clipRate)
        if (v.el.playbackRate !== rate) v.el.playbackRate = rate
        const lead = start - v.el.currentTime
        const continuing = !v.el.paused && lead >= -GRAIN_SEC * clipRate && lead <= GRAIN_CONTINUE_SEC * clipRate
        if (!continuing) {
          const g = v.gain.gain
          const t = this.ctx.currentTime
          g.cancelScheduledValues(0)
          g.setValueAtTime(g.value, t)
          g.linearRampToValueAtTime(0, t + GRAIN_FADE_SEC)
          v.el.currentTime = start
        }
        const open = () => {
          if (serial !== this.grainSerial || this.anchor) return
          const t0 = this.ctx.currentTime
          const g = v.gain.gain
          g.cancelScheduledValues(0)
          g.setValueAtTime(continuing ? g.value : 0, t0)
          g.linearRampToValueAtTime(level, t0 + GRAIN_FADE_SEC)
          g.setValueAtTime(level, t0 + GRAIN_SEC - GRAIN_FADE_SEC)
          g.linearRampToValueAtTime(0, t0 + GRAIN_SEC)
          this.grainUntil = Math.max(this.grainUntil, t0 + GRAIN_SEC)
          if (v.grainTimer) clearTimeout(v.grainTimer)
          v.grainTimer = setTimeout(() => {
            v.grainTimer = null
            if (!this.anchor && this.ctx.currentTime >= this.grainUntil) v.el.pause()
          }, GRAIN_SEC * 1000 + 40)
        }
        if (continuing) open()
        else v.el.play().then(open, () => undefined)
      }
    })
  }

  dispose(): void {
    for (const [k, v] of this.voices) this.dropVoice(k, v)
    void this.ctx.close().catch(() => undefined)
  }
}
