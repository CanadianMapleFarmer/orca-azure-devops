import { connect } from 'node:net'
import { mock } from 'node:test'
import { mountWorker, type MountWorkerOptions, type TestWorker, type WorkerModule } from 'orca/testing'
import type { Timeout } from './auth/entra'
import type { Listen, Redirect } from './auth/loopback'
import type { SecretsPort } from './auth/pat'
import type { StorePort } from './connections'
import { createPressure, paceOf, type Pressure } from './data/rate-limit'
import { createScheduler, type Scheduler } from './poll/scheduler'

export async function drain(turns = 100): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

export function connectError(host: string, port: number): Promise<string | null> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(null)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
  })
}

export async function withMockTimers(run: (advance: (ms: number) => Promise<void>) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const advance = async (ms: number) => {
    for (let step = 0; step <= ms; step += 10_000) {
      mock.timers.tick(step === 0 ? 0 : 10_000)
      await drain()
    }
  }
  try {
    await run(advance)
  } finally {
    mock.timers.reset()
  }
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1
const MAX_FIRINGS_PER_TICK = 1000

export function fakeClock(start = 0) {
  let now = start
  let nextHandle = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  const badDelays: number[] = []

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
    for (let fired = 1; ; fired += 1) {
      const next = earliest(target)
      if (!next) break
      if (fired > MAX_FIRINGS_PER_TICK) {
        throw new Error(`more than ${MAX_FIRINGS_PER_TICK} timers fired in one tick: the scheduler is spinning`)
      }
      const [handle, timer] = next
      timers.delete(handle)
      now = Math.max(now, timer.due)
      timer.fn()
      await drain()
      assertHonouredDelays()
    }
    now = target
    await drain()
    assertHonouredDelays()
  }

  async function fireNext(): Promise<void> {
    const next = earliest(Infinity)
    if (!next) throw new Error('no timer is pending')
    timers.delete(next[0])
    next[1].fn()
    await drain()
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

export type FakeClock = ReturnType<typeof fakeClock>

export function paced(clock: FakeClock): { pressure: Pressure; scheduler: Scheduler } {
  const pressure = createPressure(clock.now)
  return { pressure, scheduler: createScheduler(clock, paceOf(pressure)) }
}

export function memoryStore(initial: Record<string, unknown> = {}): { data: Record<string, unknown>; store: StorePort } {
  const data: Record<string, unknown> = { ...initial }
  const store: StorePort = {
    get: async <T,>(key: string) => (key in data ? (structuredClone(data[key]) as T) : null),
    set: async (key, value) => {
      data[key] = structuredClone(value)
    }
  }
  return { data, store }
}

export function memorySecrets(initial: Record<string, string> = {}): { data: Map<string, string>; reads: string[]; secrets: SecretsPort } {
  const data = new Map(Object.entries(initial))
  const reads: string[] = []
  const secrets: SecretsPort = {
    async get(key) {
      reads.push(key)
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    }
  }
  return { data, reads, secrets }
}

export function fakeListen(redirectUri: string, bindError?: Error) {
  const calls: { state: string; signal: AbortSignal }[] = []
  const pending: { resolve: (redirect: Redirect) => void; reject: (reason: unknown) => void }[] = []
  const listen: Listen = async ({ state, signal }) => {
    calls.push({ state, signal })
    if (bindError) throw bindError
    const result = new Promise<Redirect>((resolve, reject) => {
      pending.push({ resolve, reject })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return { redirectUri, result }
  }
  return {
    listen,
    calls,
    deliver: (redirect: Redirect) => pending.at(-1)?.resolve(redirect),
    fail: (reason: unknown) => pending.at(-1)?.reject(reason)
  }
}

export function fakeTimeouts() {
  const armed: { ms: number; controller: AbortController }[] = []
  const timeout: Timeout = ms => {
    const controller = new AbortController()
    armed.push({ ms, controller })
    return controller.signal
  }
  const fire = (ms: number) => {
    for (const entry of armed) {
      if (entry.ms === ms) entry.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }
  }
  return { timeout, armed, fire }
}

export async function withWorker(module: WorkerModule, options: MountWorkerOptions, run: (w: TestWorker) => Promise<void>): Promise<void> {
  const w = await mountWorker(module, options)
  try {
    await run(w)
  } finally {
    await w.deactivate()
  }
}
