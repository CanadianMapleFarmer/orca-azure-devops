import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import { createScheduler, realClock, type Job } from './scheduler'

const T0 = 1_000_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1
const MAX_FIRINGS_PER_TICK = 1000
const HOUR = 3_600_000

function fakeClock() {
  let now = T0
  let nextHandle = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  const badDelays: number[] = []
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))

  function earliest(limit: number) {
    return [...timers.entries()]
      .filter(([, timer]) => timer.due <= limit)
      .sort(([ha, a], [hb, b]) => a.due - b.due || ha - hb)[0]
  }

  function assertHonouredDelays(): void {
    if (badDelays.length > 0) {
      throw new Error(`the scheduler asked for timeouts the runtime would not honour: ${badDelays.join(', ')}`)
    }
  }

  async function tick(ms: number): Promise<void> {
    const target = now + ms
    let fired = 0
    for (;;) {
      const next = earliest(target)
      if (!next) break
      fired += 1
      if (fired > MAX_FIRINGS_PER_TICK) {
        throw new Error(`more than ${MAX_FIRINGS_PER_TICK} timers fired in one tick: the scheduler is spinning`)
      }
      const [handle, timer] = next
      timers.delete(handle)
      now = Math.max(now, timer.due)
      timer.fn()
      await flush()
      assertHonouredDelays()
    }
    now = target
    await flush()
    assertHonouredDelays()
  }

  async function fireNext(): Promise<void> {
    const next = earliest(Infinity)
    if (!next) throw new Error('no timer is pending')
    timers.delete(next[0])
    next[1].fn()
    await flush()
    assertHonouredDelays()
  }

  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const honoured = ms === 0 || (Number.isFinite(ms) && ms >= 1000 && ms <= MAX_TIMEOUT_MS)
      if (!honoured) badDelays.push(ms)
      const handle = nextHandle++
      timers.set(handle, { due: now + (honoured ? ms : 1), fn })
      return handle
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    tick,
    fireNext
  }
}

type FakeClock = ReturnType<typeof fakeClock>

function isError(error: unknown): boolean {
  return error instanceof Error
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function abortableRun(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function trackedJob(
  clock: FakeClock,
  behave: (signal: AbortSignal, runNumber: number) => Promise<void> = async () => {},
  shape: Partial<Pick<Job, 'key' | 'visibleMs' | 'backgroundMs'>> = {}
) {
  const starts: number[] = []
  const signals: AbortSignal[] = []
  const job: Job = {
    key: 'mine',
    visibleMs: 1000,
    backgroundMs: 10_000,
    ...shape,
    run(signal) {
      starts.push(clock.now() - T0)
      signals.push(signal)
      return behave(signal, starts.length)
    }
  }
  return { job, starts, signals }
}

function rateLimitedOnFirstRun(retryAfterMs: number | undefined) {
  return async (_signal: AbortSignal, runNumber: number) => {
    if (runNumber === 1) throw new AdoError('rate_limited', 429, 'throttled', retryAfterMs)
  }
}

function alwaysRateLimited(retryAfterMs: number | undefined) {
  return async () => {
    throw new AdoError('rate_limited', 429, 'throttled', retryAfterMs)
  }
}

test('the first run waits for the next macrotask', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  assert.deepEqual(starts, [])
  assert.equal(clock.pending(), 1)
  await clock.tick(0)
  assert.deepEqual(starts, [0])
})

test('runs immediately then every backgroundMs', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(9999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 10_000])
  await clock.tick(10_000)
  assert.deepEqual(starts, [0, 10_000, 20_000])
})

test('the next run is timed from the end of the previous one', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, () => new Promise<void>(resolve => clock.setTimeout(resolve, 3000)))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(12_999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 13_000])
})

test('visible jobs use visibleMs and run at once when they become visible and are stale', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  await clock.tick(0)

  scheduler.setVisible('mine', true)
  await clock.tick(0)
  assert.deepEqual(starts, [0])
  await clock.tick(999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1000])

  scheduler.setVisible('mine', false)
  await clock.tick(5000)
  assert.deepEqual(starts, [0, 1000])

  scheduler.setVisible('mine', true)
  await clock.tick(0)
  assert.deepEqual(starts, [0, 1000, 6000])
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 1000, 6000, 7000])
})

test('hiding a visible job returns it to backgroundMs', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 1000])
  scheduler.setVisible('mine', false)
  await clock.tick(9999)
  assert.deepEqual(starts, [0, 1000])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1000, 11_000])
})

test('setVisible during a run does not start a second run', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const release = deferred()
  const { job, starts } = trackedJob(clock, () => release.promise)
  scheduler.upsert(job)
  await clock.tick(0)
  scheduler.setVisible('mine', true)
  await clock.tick(5000)
  assert.deepEqual(starts, [0])
  release.resolve()
  await clock.tick(0)
  await clock.tick(999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 6000])
})

test('a rate-limited job waits retryAfterMs before running again', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(30_000))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(29_999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 30_000])
  await clock.tick(10_000)
  assert.deepEqual(starts, [0, 30_000, 40_000])
})

test('a rate-limited job without retryAfterMs waits 60 seconds', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(undefined))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(59_999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 60_000])
})

test('a rate limit shorter than the cadence never speeds the job up', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(2000))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(9999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 10_000])
})

test('a rate-limited job does not run when it becomes visible', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(30_000))
  scheduler.upsert(job)
  await clock.tick(0)
  scheduler.setVisible('mine', true)
  await clock.tick(29_999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 30_000])
})

test('a successful run clears an earlier rate-limit pause', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(60_000))
  scheduler.upsert(job)
  await clock.tick(0)
  await scheduler.runNow('mine')
  assert.deepEqual(starts, [0, 0])
  await clock.tick(10_000)
  assert.deepEqual(starts, [0, 0, 10_000])
})

const PAUSES: { label: string; retryAfterMs: number; pausedMs: number }[] = [
  { label: '2 ** 40', retryAfterMs: 2 ** 40, pausedMs: 15 * 60_000 },
  { label: 'Infinity', retryAfterMs: Infinity, pausedMs: 15 * 60_000 },
  { label: 'NaN', retryAfterMs: NaN, pausedMs: 60_000 }
]

for (const { label, retryAfterMs, pausedMs } of PAUSES) {
  test(`retryAfterMs of ${label} pauses for ${pausedMs} ms and the job does not spin`, async () => {
    const clock = fakeClock()
    const scheduler = createScheduler(clock)
    const { job, starts } = trackedJob(clock, alwaysRateLimited(retryAfterMs))
    scheduler.upsert(job)
    await clock.tick(0)
    await clock.tick(pausedMs - 1)
    assert.deepEqual(starts, [0])
    await clock.tick(1)
    assert.deepEqual(starts, [0, pausedMs])
    await clock.tick(HOUR)
    assert.equal(starts.length, 1 + Math.floor((HOUR + pausedMs) / pausedMs))
    assert.ok(starts.every((start, index) => start === index * pausedMs))
  })
}

test('a timer that fires early reschedules instead of running the job', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.fireNext()
  assert.deepEqual(starts, [0])
  assert.equal(clock.pending(), 1)
  await clock.tick(9999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 10_000])
})

test('a wait shorter than one second is lifted to one second', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(600)
  scheduler.setVisible('mine', true)
  await clock.tick(999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1600])
})

test('a wait longer than a timer can hold is split and the job still runs on time', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const backgroundMs = 2 ** 33 + 5000
  const { job, starts } = trackedJob(clock, async () => {}, { backgroundMs })
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(backgroundMs - 1)
  assert.deepEqual(starts, [0])
  assert.equal(clock.pending(), 1)
  await clock.tick(1)
  assert.deepEqual(starts, [0, backgroundMs])
})

const INVALID_INTERVALS: { label: string; shape: Partial<Pick<Job, 'visibleMs' | 'backgroundMs'>> }[] = [
  { label: 'visibleMs below 1000', shape: { visibleMs: 999 } },
  { label: 'backgroundMs below 1000', shape: { backgroundMs: 999 } },
  { label: 'a zero visibleMs', shape: { visibleMs: 0 } },
  { label: 'a negative backgroundMs', shape: { backgroundMs: -5000 } },
  { label: 'a NaN visibleMs', shape: { visibleMs: NaN } },
  { label: 'an infinite backgroundMs', shape: { backgroundMs: Infinity } }
]

for (const { label, shape } of INVALID_INTERVALS) {
  test(`upsert refuses ${label}`, async () => {
    const clock = fakeClock()
    const scheduler = createScheduler(clock)
    assert.throws(() => scheduler.upsert(trackedJob(clock, async () => {}, { key: 'new', ...shape }).job), isError)
    assert.equal(clock.pending(), 0)

    const valid = trackedJob(clock)
    scheduler.upsert(valid.job)
    await clock.tick(0)
    assert.throws(() => scheduler.upsert(trackedJob(clock, async () => {}, shape).job), isError)
    await clock.tick(10_000)
    assert.deepEqual(valid.starts, [0, 10_000])
  })
}

const FAILURES: Record<string, () => Promise<void>> = {
  'a plain error': () => Promise.reject(new Error('Azure DevOps said something private')),
  'a synchronous throw': () => {
    throw new Error('thrown before any promise')
  },
  'a non-rate-limit AdoError that carries retryAfterMs': () =>
    Promise.reject(new AdoError('server', 500, 'down', 90_000))
}

for (const [name, fail] of Object.entries(FAILURES)) {
  test(`${name} keeps the normal cadence and never escapes`, async () => {
    const clock = fakeClock()
    const scheduler = createScheduler(clock)
    const { job, starts } = trackedJob(clock, fail)
    scheduler.upsert(job)
    await clock.tick(0)
    await clock.tick(9999)
    assert.deepEqual(starts, [0])
    await clock.tick(1)
    assert.deepEqual(starts, [0, 10_000])
    await scheduler.runNow('mine')
    assert.deepEqual(starts, [0, 10_000, 10_000])
  })
}

test('runNow joins an in-flight run instead of starting a second', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const release = deferred()
  const { job, starts } = trackedJob(clock, () => release.promise)
  scheduler.upsert(job)
  await clock.tick(0)
  const first = scheduler.runNow('mine')
  const second = scheduler.runNow('mine')
  assert.deepEqual(starts, [0])
  release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(starts, [0])
  await scheduler.runNow('mine')
  assert.deepEqual(starts, [0, 0])
})

test('runNow before the first run replaces the pending first run', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  await scheduler.runNow('mine')
  assert.deepEqual(starts, [0])
  await clock.tick(0)
  assert.deepEqual(starts, [0])
  await clock.tick(10_000)
  assert.deepEqual(starts, [0, 10_000])
})

test('runNow on an unknown key resolves without running anything', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  await scheduler.runNow('missing')
  assert.equal(clock.pending(), 0)
})

test('upserting an existing key swaps the job without a second concurrent run', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const release = deferred()
  const first = trackedJob(clock, () => release.promise, { backgroundMs: 10_000 })
  const second = trackedJob(clock, async () => {}, { backgroundMs: 3000 })
  scheduler.upsert(first.job)
  await clock.tick(0)
  scheduler.upsert(second.job)
  await clock.tick(20_000)
  assert.deepEqual(first.starts, [0])
  assert.deepEqual(second.starts, [])
  release.resolve()
  await clock.tick(0)
  await clock.tick(2999)
  assert.deepEqual(second.starts, [])
  await clock.tick(1)
  assert.deepEqual(second.starts, [23_000])
  assert.deepEqual(first.starts, [0])
})

test('upserting an idle job moves it to the new cadence without running at once', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const first = trackedJob(clock, async () => {}, { backgroundMs: 10_000 })
  const second = trackedJob(clock, async () => {}, { backgroundMs: 3000 })
  scheduler.upsert(first.job)
  await clock.tick(0)
  scheduler.upsert(second.job)
  await clock.tick(0)
  assert.deepEqual(second.starts, [])
  await clock.tick(2999)
  assert.deepEqual(second.starts, [])
  await clock.tick(1)
  assert.deepEqual(second.starts, [3000])
  assert.deepEqual(first.starts, [0])
})

test('remove stops future runs and aborts the in-flight one', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const stuck = trackedJob(clock, abortableRun, { key: 'stuck' })
  const idle = trackedJob(clock, async () => {}, { key: 'idle' })
  const other = trackedJob(clock, async () => {}, { key: 'other' })
  for (const { job } of [stuck, idle, other]) scheduler.upsert(job)
  await clock.tick(0)

  scheduler.remove('stuck')
  scheduler.remove('idle')
  assert.equal(stuck.signals[0].aborted, true)
  assert.equal(other.signals[0].aborted, false)

  await clock.tick(30_000)
  await scheduler.runNow('stuck')
  assert.deepEqual(stuck.starts, [0])
  assert.deepEqual(idle.starts, [0])
  assert.deepEqual(other.starts, [0, 10_000, 20_000, 30_000])
  assert.equal(clock.pending(), 1)
})

test('dispose aborts in-flight runs, clears every timer and ignores later upserts', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const stuck = trackedJob(clock, abortableRun, { key: 'stuck' })
  const idle = trackedJob(clock, async () => {}, { key: 'idle' })
  scheduler.upsert(stuck.job)
  scheduler.upsert(idle.job)
  await clock.tick(0)
  assert.equal(clock.pending(), 1)

  scheduler.dispose()
  assert.equal(stuck.signals[0].aborted, true)
  await clock.tick(0)
  assert.equal(clock.pending(), 0)
  await clock.tick(100_000)
  assert.deepEqual(stuck.starts, [0])
  assert.deepEqual(idle.starts, [0])

  const late = trackedJob(clock, async () => {}, { key: 'late' })
  scheduler.upsert(late.job)
  await clock.tick(10_000)
  assert.deepEqual(late.starts, [])
  assert.equal(clock.pending(), 0)
})

test('realClock wraps the global timers', async () => {
  const fired: string[] = []
  const cleared = realClock.setTimeout(() => fired.push('cleared'), 0)
  realClock.setTimeout(() => fired.push('kept'), 0)
  realClock.clearTimeout(cleared)
  await new Promise<void>(resolve => realClock.setTimeout(resolve, 0))
  assert.deepEqual(fired, ['kept'])
  assert.ok(Math.abs(realClock.now() - Date.now()) < 1000)
})
