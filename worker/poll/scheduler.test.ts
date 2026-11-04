import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import { createScheduler, realClock, type Job } from './scheduler'

const T0 = 1_000_000

function fakeClock() {
  let now = T0
  let nextHandle = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))

  async function tick(ms: number): Promise<void> {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([ha, a], [hb, b]) => a.due - b.due || ha - hb)[0]
      if (!due) break
      const [handle, timer] = due
      timers.delete(handle)
      now = Math.max(now, timer.due)
      timer.fn()
      await flush()
    }
    now = target
    await flush()
  }

  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const handle = nextHandle++
      timers.set(handle, { due: now + ms, fn })
      return handle
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number)
    },
    pending: () => timers.size,
    tick
  }
}

type FakeClock = ReturnType<typeof fakeClock>

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
    visibleMs: 100,
    backgroundMs: 1000,
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
  await clock.tick(999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1000])
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 1000, 2000])
})

test('the next run is timed from the end of the previous one', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, () => new Promise<void>(resolve => clock.setTimeout(resolve, 300)))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(1299)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1300])
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
  await clock.tick(99)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 100])

  scheduler.setVisible('mine', false)
  await clock.tick(500)
  assert.deepEqual(starts, [0, 100])

  scheduler.setVisible('mine', true)
  await clock.tick(0)
  assert.deepEqual(starts, [0, 100, 600])
  await clock.tick(100)
  assert.deepEqual(starts, [0, 100, 600, 700])
})

test('hiding a visible job returns it to backgroundMs', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(100)
  assert.deepEqual(starts, [0, 100])
  scheduler.setVisible('mine', false)
  await clock.tick(999)
  assert.deepEqual(starts, [0, 100])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 100, 1100])
})

test('setVisible during a run does not start a second run', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const release = deferred()
  const { job, starts } = trackedJob(clock, () => release.promise)
  scheduler.upsert(job)
  await clock.tick(0)
  scheduler.setVisible('mine', true)
  await clock.tick(500)
  assert.deepEqual(starts, [0])
  release.resolve()
  await clock.tick(0)
  await clock.tick(99)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 600])
})

test('a rate-limited job waits retryAfterMs before running again', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(5000))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(4999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 5000])
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 5000, 6000])
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
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(200))
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 1000])
})

test('a rate-limited job does not run when it becomes visible', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(5000))
  scheduler.upsert(job)
  await clock.tick(0)
  scheduler.setVisible('mine', true)
  await clock.tick(4999)
  assert.deepEqual(starts, [0])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 5000])
})

test('a successful run clears an earlier rate-limit pause', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(60_000))
  scheduler.upsert(job)
  await clock.tick(0)
  await scheduler.runNow('mine')
  assert.deepEqual(starts, [0, 0])
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 0, 1000])
})

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
    await clock.tick(999)
    assert.deepEqual(starts, [0])
    await clock.tick(1)
    assert.deepEqual(starts, [0, 1000])
    await scheduler.runNow('mine')
    assert.deepEqual(starts, [0, 1000, 1000])
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
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 1000])
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
  const first = trackedJob(clock, () => release.promise, { backgroundMs: 1000 })
  const second = trackedJob(clock, async () => {}, { backgroundMs: 300 })
  scheduler.upsert(first.job)
  await clock.tick(0)
  scheduler.upsert(second.job)
  await clock.tick(2000)
  assert.deepEqual(first.starts, [0])
  assert.deepEqual(second.starts, [])
  release.resolve()
  await clock.tick(0)
  await clock.tick(299)
  assert.deepEqual(second.starts, [])
  await clock.tick(1)
  assert.deepEqual(second.starts, [2300])
  assert.deepEqual(first.starts, [0])
})

test('upserting an idle job moves it to the new cadence without running at once', async () => {
  const clock = fakeClock()
  const scheduler = createScheduler(clock)
  const first = trackedJob(clock, async () => {}, { backgroundMs: 1000 })
  const second = trackedJob(clock, async () => {}, { backgroundMs: 200 })
  scheduler.upsert(first.job)
  await clock.tick(0)
  scheduler.upsert(second.job)
  await clock.tick(0)
  assert.deepEqual(second.starts, [])
  await clock.tick(199)
  assert.deepEqual(second.starts, [])
  await clock.tick(1)
  assert.deepEqual(second.starts, [200])
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

  await clock.tick(3000)
  await scheduler.runNow('stuck')
  assert.deepEqual(stuck.starts, [0])
  assert.deepEqual(idle.starts, [0])
  assert.deepEqual(other.starts, [0, 1000, 2000, 3000])
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
  await clock.tick(1000)
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
