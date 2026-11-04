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
const MAX_RATE_LIMIT_PAUSE_MS = 15 * 60_000
const MIN_DELAY_MS = 1000
const MAX_DELAY_MS = 2 ** 31 - 1

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

function rateLimitPauseMs(retryAfterMs: number | undefined): number {
  if (retryAfterMs === undefined || Number.isNaN(retryAfterMs)) return DEFAULT_RATE_LIMIT_PAUSE_MS
  return Math.min(Math.max(retryAfterMs, 0), MAX_RATE_LIMIT_PAUSE_MS)
}

function assertValidIntervals(job: Job): void {
  for (const ms of [job.visibleMs, job.backgroundMs]) {
    if (!Number.isFinite(ms) || ms < MIN_DELAY_MS) {
      throw new Error(`Polling job "${job.key}" needs finite intervals of at least ${MIN_DELAY_MS} ms.`)
    }
  }
}

export function createScheduler(clock: Clock): Scheduler {
  const entries = new Map<string, Entry>()
  let disposed = false

  function clearTimer(entry: Entry): void {
    if (!entry.timer) return
    clock.clearTimeout(entry.timer.handle)
    entry.timer = undefined
  }

  function intervalOf(entry: Entry): number {
    return entry.visible ? entry.job.visibleMs : entry.job.backgroundMs
  }

  function remainingMs(entry: Entry): number {
    const now = clock.now()
    const cadenceDue = entry.lastRunAt === undefined ? now : entry.lastRunAt + intervalOf(entry)
    return Math.max(cadenceDue, entry.pausedUntil) - now
  }

  function timeoutFor(entry: Entry): number {
    const remaining = remainingMs(entry)
    if (remaining <= 0) return 0
    const wait = Number.isFinite(remaining) ? remaining : intervalOf(entry)
    return Math.min(Math.max(wait, MIN_DELAY_MS), MAX_DELAY_MS)
  }

  function schedule(entry: Entry): void {
    if (entry.inFlight) return
    clearTimer(entry)
    const handle = clock.setTimeout(() => fire(entry), timeoutFor(entry))
    entry.timer = { handle }
  }

  function fire(entry: Entry): void {
    entry.timer = undefined
    if (remainingMs(entry) > 0) schedule(entry)
    else void start(entry)
  }

  async function attempt(job: Job, signal: AbortSignal): Promise<number> {
    try {
      await job.run(signal)
      return 0
    } catch (error) {
      if (!(error instanceof AdoError) || error.code !== 'rate_limited') return 0
      return clock.now() + rateLimitPauseMs(error.retryAfterMs)
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
      assertValidIntervals(job)
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
