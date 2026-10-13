/**
 * ML job plumbing (spec 07 §0.3, §3.9): concurrency gates ("lanes"), job ids with AbortSignals, and shutdown.
 * Lanes: "transcribe" runs one whisper process at a time; FFmpeg extraction uses its own gate of 2.
 */

const abortError = () => new DOMException('Aborted', 'AbortError')

/** Counting semaphore whose waiters can be aborted while queued. */
export class Semaphore {
  private active = 0
  private readonly queue: { start: () => void; cancel: () => void }[] = []

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          this.active++
          resolve()
        },
        cancel: () => reject(abortError()),
      }
      const onAbort = () => {
        const i = this.queue.indexOf(entry)
        if (i >= 0) this.queue.splice(i, 1)
        entry.cancel()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
    })
  }

  private release(): void {
    this.active--
    this.queue.shift()?.start()
  }
}

/** Live jobs by id, so `cancel(jobId)` and quit can reach them. */
export class JobRegistry {
  private readonly jobs = new Map<string, AbortController>()
  private closed = false

  /** Runs `fn` as job `id`; an outer signal (if any) also aborts it. */
  async run<T>(id: string, fn: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error('The app is quitting.')
    const ac = new AbortController()
    const onOuter = () => ac.abort()
    if (outer?.aborted) ac.abort()
    outer?.addEventListener('abort', onOuter, { once: true })
    this.jobs.set(id, ac)
    try {
      return await fn(ac.signal)
    } finally {
      outer?.removeEventListener('abort', onOuter)
      if (this.jobs.get(id) === ac) this.jobs.delete(id)
    }
  }

  cancel(id: string): void {
    this.jobs.get(id)?.abort()
  }

  get size(): number {
    return this.jobs.size
  }

  /** before-quit: stop admitting, cancel everything, wait ≤ `waitMs` for jobs to unwind. */
  async shutdown(waitMs = 3000): Promise<void> {
    this.closed = true
    for (const ac of this.jobs.values()) ac.abort()
    const deadline = Date.now() + waitMs
    while (this.jobs.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  }
}
