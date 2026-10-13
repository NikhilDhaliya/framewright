/** Master audio meter channel state (spec 07 §3.8; Mac `Audio/AudioMeter.swift`). Pure. */
export const METER = { floorDb: -60, levelDecayDbPerSec: 24, peakDecayDbPerSec: 18, peakHoldSec: 1.5 } as const

export const ampToDb = (a: number): number => (a > 0 ? Math.max(METER.floorDb, 20 * Math.log10(a)) : METER.floorDb)

/** `AudioMeterChannelState`: decaying level, held/decaying peak, sticky clip flag. Times in seconds. */
export class MeterChannel {
  levelDb: number = METER.floorDb
  levelTime = 0
  peakDb: number = METER.floorDb
  peakHoldUntil = 0
  clipped = false

  display(t: number): { level: number; peak: number } {
    return {
      level: Math.max(METER.floorDb, this.levelDb - Math.max(0, t - this.levelTime) * METER.levelDecayDbPerSec),
      peak: Math.max(METER.floorDb, this.peakDb - Math.max(0, t - this.peakHoldUntil) * METER.peakDecayDbPerSec),
    }
  }

  ingest(peakAmp: number, t: number): void {
    const cur = this.display(t)
    const inc = ampToDb(peakAmp)
    this.levelDb = Math.max(inc, cur.level)
    this.levelTime = t
    if (inc >= cur.peak) {
      this.peakDb = inc
      this.peakHoldUntil = t + METER.peakHoldSec
    } else if (t > this.peakHoldUntil) {
      this.peakDb = cur.peak
      this.peakHoldUntil = t
    }
    this.clipped ||= peakAmp >= 1
  }
}
