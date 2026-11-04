import { AdoError } from '../ado/http'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Job {
  key: string
  visibleMs: number
  backgroundMs: number
  run(signal: AbortSignal): Promise<void>
}

export interface Scheduler {
  upsert(job: Job): void
  remove(key: string): void
  setVisible(key: string, visible: boolean): void
  runNow(key: string): Promise<void>
  dispose(): void
}

const DEFAULT_RATE_LIMIT_PAUSE_MS = 60_000

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

interface Entry {
  job: Job
  visible: boolean
  timer: { handle: unknown } | undefined
  inFlight: Promise<void> | undefined
  abort: AbortController | undefined
  lastRunAt: number | undefined
  pausedUntil: number
}

export function createScheduler(clock: Clock): Scheduler {
  const entries = new Map<string, Entry>()
  let disposed = false

  function clearTimer(entry: Entry): void {
    if (!entry.timer) return
    clock.clearTimeout(entry.timer.handle)
    entry.timer = undefined
  }

  function delayFor(entry: Entry): number {
    const now = clock.now()
    const interval = entry.visible ? entry.job.visibleMs : entry.job.backgroundMs
    const cadenceDue = entry.lastRunAt === undefined ? now : entry.lastRunAt + interval
    return Math.max(0, Math.max(cadenceDue, entry.pausedUntil) - now)
  }

  function schedule(entry: Entry): void {
    if (entry.inFlight) return
    clearTimer(entry)
    const handle = clock.setTimeout(() => {
      entry.timer = undefined
      void start(entry)
    }, delayFor(entry))
    entry.timer = { handle }
  }

  async function attempt(job: Job, signal: AbortSignal): Promise<number> {
    try {
      await job.run(signal)
      return 0
    } catch (error) {
      if (!(error instanceof AdoError) || error.code !== 'rate_limited') return 0
      return clock.now() + (error.retryAfterMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS)
    }
  }

  function start(entry: Entry): Promise<void> {
    if (entry.inFlight) return entry.inFlight
    clearTimer(entry)
    const abort = new AbortController()
    entry.abort = abort
    const inFlight = attempt(entry.job, abort.signal).then(pausedUntil => {
      entry.inFlight = undefined
      entry.abort = undefined
      if (abort.signal.aborted) return
      entry.pausedUntil = pausedUntil
      entry.lastRunAt = clock.now()
      schedule(entry)
    })
    entry.inFlight = inFlight
    return inFlight
  }

  function stop(entry: Entry): void {
    clearTimer(entry)
    entry.abort?.abort()
  }

  return {
    upsert(job) {
      if (disposed) return
      const existing = entries.get(job.key)
      if (existing) {
        existing.job = job
        schedule(existing)
        return
      }
      const entry: Entry = {
        job,
        visible: false,
        timer: undefined,
        inFlight: undefined,
        abort: undefined,
        lastRunAt: undefined,
        pausedUntil: 0
      }
      entries.set(job.key, entry)
      schedule(entry)
    },

    remove(key) {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      stop(entry)
    },

    setVisible(key, visible) {
      const entry = entries.get(key)
      if (!entry || entry.visible === visible) return
      entry.visible = visible
      schedule(entry)
    },

    runNow(key) {
      const entry = entries.get(key)
      return entry ? start(entry) : Promise.resolve()
    },

    dispose() {
      disposed = true
      for (const entry of entries.values()) stop(entry)
      entries.clear()
    }
  }
}
