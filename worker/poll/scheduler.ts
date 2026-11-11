import { featureOfJob, fly, inLane, join, type Flight } from '../data/context'
import type { Pace } from '../data/rate-limit'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const NOTIFY_CAP_MS = 5 * 60_000

export interface Job {
  key: string
  org?: string
  visibleMs: number
  backgroundMs: number | null
  quietMax?: number
  quietCapMs?: number
  run(signal: AbortSignal): Promise<void | 'unchanged'>
}

export interface Scheduler {
  upsert(job: Job): void
  remove(key: string): void
  setVisible(key: string, visible: boolean): void
  runNow(key: string): Promise<void>
  dispose(): void
}

type Outcome = 'unchanged' | 'changed'

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
  flight: Flight<void> | undefined
  abort: AbortController | undefined
  lastRunAt: number | undefined
  streak: number
}

function assertValidIntervals(job: Job): void {
  const intervals = job.backgroundMs === null ? [job.visibleMs] : [job.visibleMs, job.backgroundMs]
  for (const ms of intervals) {
    if (!Number.isFinite(ms) || ms < MIN_DELAY_MS) {
      throw new Error(`Polling job "${job.key}" needs finite intervals of at least ${MIN_DELAY_MS} ms.`)
    }
  }
}

async function attempt(job: Job, signal: AbortSignal): Promise<Outcome> {
  try {
    return (await job.run(signal)) === 'unchanged' ? 'unchanged' : 'changed'
  } catch {
    return 'changed'
  }
}

export function createScheduler(clock: Clock, pace?: Pace): Scheduler {
  const entries = new Map<string, Entry>()
  let disposed = false

  function clearTimer(entry: Entry): void {
    if (!entry.timer) return
    clock.clearTimeout(entry.timer.handle)
    entry.timer = undefined
  }

  function factorOf(job: Job): number {
    return pace && job.org !== undefined ? pace.factor(job.org) : 1
  }

  function resumeAtOf(job: Job): number {
    return pace && job.org !== undefined ? pace.resumeAt(job.org) : 0
  }

  function calmAtOf(job: Job): number {
    return pace && job.org !== undefined ? pace.calmAt(job.org) : 0
  }

  function baseOf(entry: Entry): number | null {
    return entry.visible ? entry.job.visibleMs : entry.job.backgroundMs
  }

  function quietIntervalOf(entry: Entry, base: number): number {
    const { quietMax = 1, quietCapMs = Infinity } = entry.job
    const quiet = Math.min(2 ** entry.streak, quietMax)
    return Math.min(base * quiet, Math.max(base, quietCapMs))
  }

  function dueAt(entry: Entry, base: number): number {
    const cadenceDue = entry.lastRunAt === undefined ? -Infinity : entry.lastRunAt + quietIntervalOf(entry, base) * factorOf(entry.job)
    return Math.max(cadenceDue, resumeAtOf(entry.job))
  }

  function wakeAt(entry: Entry, base: number): number {
    const due = dueAt(entry, base)
    if (entry.lastRunAt === undefined) return due
    const calm = Math.max(entry.lastRunAt + quietIntervalOf(entry, base), calmAtOf(entry.job))
    return calm > clock.now() ? Math.min(due, calm) : due
  }

  function timeoutFor(entry: Entry, base: number): number {
    const wait = wakeAt(entry, base) - clock.now()
    if (wait <= 0) return 0
    return Math.min(Math.max(wait, MIN_DELAY_MS), MAX_DELAY_MS)
  }

  function schedule(entry: Entry): void {
    if (entry.flight) return
    clearTimer(entry)
    const base = baseOf(entry)
    if (base === null) return
    const handle = clock.setTimeout(() => fire(entry), timeoutFor(entry, base))
    entry.timer = { handle }
  }

  function fire(entry: Entry): void {
    entry.timer = undefined
    const base = baseOf(entry)
    if (base === null) return
    if (dueAt(entry, base) > clock.now()) schedule(entry)
    else inLane(featureOfJob(entry.job.key), entry.visible ? 'visible' : 'hidden', () => launch(entry))
  }

  function launch(entry: Entry): Flight<void> {
    clearTimer(entry)
    const abort = new AbortController()
    entry.abort = abort
    const flight = fly(() => attempt(entry.job, abort.signal).then(outcome => settle(entry, abort, outcome)))
    entry.flight = flight
    return flight
  }

  function settle(entry: Entry, abort: AbortController, outcome: Outcome): void {
    entry.flight = undefined
    entry.abort = undefined
    if (abort.signal.aborted) return
    entry.streak = outcome === 'unchanged' ? entry.streak + 1 : 0
    entry.lastRunAt = clock.now()
    schedule(entry)
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
        flight: undefined,
        abort: undefined,
        lastRunAt: undefined,
        streak: 0
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
      if (visible) entry.streak = 0
      schedule(entry)
    },

    runNow(key) {
      const entry = entries.get(key)
      if (!entry) return Promise.resolve()
      entry.streak = 0
      return entry.flight ? join(entry.flight) : launch(entry).promise
    },

    dispose() {
      disposed = true
      for (const entry of entries.values()) stop(entry)
      entries.clear()
    }
  }
}
