import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import { currentContext, inLane, type Lane } from '../data/context'
import type { Pace } from '../data/rate-limit'
import { fakeClock, paced, type FakeClock } from '../test-support'
import { createScheduler, NOTIFY_CAP_MS, realClock, type Job } from './scheduler'

const T0 = 1_000_000
const HOUR = 3_600_000

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
  behave: (signal: AbortSignal, runNumber: number) => Promise<void | 'unchanged'> = async () => {},
  shape: Partial<Omit<Job, 'run'>> = {}
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

function settablePace(initial: { factor?: number; resumeAt?: number } = {}) {
  const state = { factor: 1, resumeAt: 0, ...initial }
  const asked: string[] = []
  const pace: Pace = {
    factor: org => {
      asked.push(org)
      return state.factor
    },
    resumeAt: org => {
      asked.push(org)
      return state.resumeAt
    }
  }
  return { pace, state, asked }
}

const unchanged = async () => 'unchanged' as const

test('the first run waits for the next macrotask', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  assert.deepEqual(starts, [])
  assert.equal(clock.pending(), 1)
  await clock.tick(0)
  assert.deepEqual(starts, [0])
})

test('runs immediately then every backgroundMs', async () => {
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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

test('a rate-limited run no longer pauses its job by itself', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, rateLimitedOnFirstRun(60_000))
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(1000)
  assert.deepEqual(starts, [0, 1000])
})

test("an org job waits out its org's resumeAt", async () => {
  const clock = fakeClock(T0)
  const { pace } = settablePace({ resumeAt: T0 + 90_000 })
  const scheduler = createScheduler(clock, pace)
  const { job, starts } = trackedJob(clock, async () => {}, { key: 'prs:contoso', org: 'contoso' })
  scheduler.upsert(job)
  scheduler.setVisible('prs:contoso', true)
  await clock.tick(89_999)
  assert.deepEqual(starts, [])
  await clock.tick(1)
  assert.deepEqual(starts, [90_000])
})

test("an org job's interval is multiplied by its org's pace factor", async () => {
  const clock = fakeClock(T0)
  const { pace, asked } = settablePace({ factor: 4 })
  const scheduler = createScheduler(clock, pace)
  const { job, starts } = trackedJob(clock, async () => {}, { key: 'runs:contoso', org: 'contoso', visibleMs: 1000 })
  scheduler.upsert(job)
  scheduler.setVisible('runs:contoso', true)
  await clock.tick(0)
  await clock.tick(8000)
  assert.deepEqual(starts, [0, 4000, 8000])
  assert.ok(asked.length > 0 && asked.every(org => org === 'contoso'))
})

test('jobs without an org ignore the pace', async () => {
  const clock = fakeClock(T0)
  const { pace, asked } = settablePace({ factor: 4, resumeAt: T0 + 90_000 })
  const scheduler = createScheduler(clock, pace)
  const { job, starts } = trackedJob(clock)
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(2000)
  assert.deepEqual(starts, [0, 1000, 2000])
  assert.deepEqual(asked, [])
})

test('an org job blocked past its cadence runs once the block lifts, at the pace then in force', async () => {
  const clock = fakeClock(T0)
  const { pressure, scheduler } = paced(clock)
  const throttledOnSecondRun = async (_signal: AbortSignal, runNumber: number) => {
    if (runNumber === 2) pressure.observe({ org: 'contoso', path: '/_apis/git/pullrequests' }, 429, new Headers({ 'Retry-After': '600' }))
  }
  const { job, starts } = trackedJob(clock, throttledOnSecondRun, { key: 'prs:contoso', org: 'contoso', backgroundMs: 300_000, quietCapMs: NOTIFY_CAP_MS })
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(300_000)
  assert.deepEqual(starts, [0, 300_000])
  await clock.tick(599_999)
  assert.deepEqual(starts, [0, 300_000])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 300_000, 900_000])
  await clock.tick(300_000)
  assert.deepEqual(starts, [0, 300_000, 900_000, 1_200_000])
})

test('each unchanged run doubles the interval up to quietMax, and a changed run resets it', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const outcomes = ['unchanged', 'unchanged', 'unchanged', undefined] as const
  const { job, starts } = trackedJob(clock, async (_signal, runNumber) => outcomes[runNumber - 1], { quietMax: 4 })
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(11_000)
  assert.deepEqual(starts, [0, 2000, 6000, 10_000, 11_000])
})

test('quiet back-off never stretches an interval past quietCapMs', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, unchanged, { backgroundMs: 300_000, quietMax: 4, quietCapMs: 300_000 })
  scheduler.upsert(job)
  await clock.tick(0)
  await clock.tick(900_000)
  assert.deepEqual(starts, [0, 300_000, 600_000, 900_000])
})

test('upsert keeps the quiet streak', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, unchanged, { quietMax: 4 })
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(2000)
  assert.deepEqual(starts, [0, 2000])
  scheduler.upsert({ ...job })
  await clock.tick(3999)
  assert.deepEqual(starts, [0, 2000])
  await clock.tick(1)
  assert.deepEqual(starts, [0, 2000, 6000])
})

test('becoming visible and runNow reset the quiet back-off', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, unchanged, { quietMax: 4 })
  scheduler.upsert(job)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(10_000)
  assert.deepEqual(starts, [0, 2000, 6000, 10_000])

  await scheduler.runNow('mine')
  await clock.tick(2000)
  assert.deepEqual(starts.slice(4), [10_000, 12_000], 'runNow took the interval back to 1 s before its own run')

  scheduler.setVisible('mine', false)
  await clock.tick(5000)
  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(2000)
  assert.deepEqual(starts.slice(6), [17_000, 19_000], 'becoming visible did too')
})

test('a job with backgroundMs null idles while hidden and runs on becoming visible when due', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const { job, starts } = trackedJob(clock, async () => {}, { visibleMs: 30_000, backgroundMs: null })
  scheduler.upsert(job)
  await clock.tick(60_000)
  assert.deepEqual(starts, [])
  assert.equal(clock.pending(), 0)

  scheduler.setVisible('mine', true)
  await clock.tick(0)
  await clock.tick(30_000)
  assert.deepEqual(starts, [60_000, 90_000])

  scheduler.setVisible('mine', false)
  await clock.tick(10 * 60_000)
  assert.deepEqual(starts, [60_000, 90_000])
  assert.equal(clock.pending(), 0)

  scheduler.setVisible('mine', true)
  await clock.tick(0)
  assert.deepEqual(starts, [60_000, 90_000, 690_000], 'overdue, so it runs at once')

  scheduler.setVisible('mine', false)
  await clock.tick(10_000)
  scheduler.setVisible('mine', true)
  await clock.tick(19_999)
  assert.deepEqual(starts, [60_000, 90_000, 690_000], 'not yet due')
  await clock.tick(1)
  assert.deepEqual(starts, [60_000, 90_000, 690_000, 720_000])
})

test("timer runs carry a visible or hidden lane for the job's feature", async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const seen: { feature: string; priority: string }[] = []
  const { job } = trackedJob(
    clock,
    async () => {
      const { feature, lane } = currentContext()
      seen.push({ feature, priority: lane.priority })
    },
    { key: 'mine:contoso', org: 'contoso' }
  )
  inLane('prs', 'user', () => scheduler.upsert(job))
  await clock.tick(0)
  scheduler.setVisible('mine:contoso', true)
  await clock.tick(1000)
  assert.deepEqual(seen, [
    { feature: 'work', priority: 'hidden' },
    { feature: 'work', priority: 'visible' }
  ])
})

test('runNow from a user call raises a run already in flight', async () => {
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  const release = deferred()
  const lanes: Lane[] = []
  const { job, starts } = trackedJob(
    clock,
    () => {
      lanes.push(currentContext().lane)
      return release.promise
    },
    { key: 'prs:contoso', org: 'contoso' }
  )
  scheduler.upsert(job)
  await clock.tick(0)
  assert.equal(lanes[0].priority, 'hidden')

  const background = inLane('prs', 'visible', () => scheduler.runNow('prs:contoso'))
  assert.equal(lanes[0].priority, 'hidden', 'a background caller leaves it alone')
  const user = inLane('prs', 'user', () => scheduler.runNow('prs:contoso'))
  assert.equal(lanes[0].priority, 'user')

  release.resolve()
  await Promise.all([background, user])
  assert.deepEqual(starts, [0], 'both joined the run in flight')
})

test('a timer that fires early reschedules instead of running the job', async () => {
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
    const clock = fakeClock(T0)
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
    const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
  const scheduler = createScheduler(clock)
  await scheduler.runNow('missing')
  assert.equal(clock.pending(), 0)
})

test('upserting an existing key swaps the job without a second concurrent run', async () => {
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
  const clock = fakeClock(T0)
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
