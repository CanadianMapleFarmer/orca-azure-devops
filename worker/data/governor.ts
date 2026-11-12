import type { AdoHttp, AdoRequest } from '../ado/http'
import type { Clock } from '../poll/scheduler'
import { currentContext, fly, join, onRaise, runIn, type Flight, type Priority, type RequestContext } from './context'
import type { Pressure, PressureLevel } from './rate-limit'

export const MAX_IN_FLIGHT = 6
export const BACKGROUND_SLOTS: Record<PressureLevel, number> = { normal: 4, near: 3, tight: 2, delayed: 1, blocked: 0 }

export interface GovernorDeps {
  http: AdoHttp
  pressure: Pick<Pressure, 'state'>
  now: () => number
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>
}

type Answer = { data: unknown; headers: Headers }

interface Task {
  readonly context: RequestContext
  readonly arrival: number
  readonly send: () => Promise<Answer>
  readonly resolve: (answer: Answer) => void
  readonly reject: (error: unknown) => void
  where: 'queued' | 'held' | 'running' | 'done'
  detach: () => void
}

interface OrgQueue {
  queued: Task[]
  readonly held: Set<Task>
  readonly running: Set<Task>
  timer: { handle: unknown; at: number } | undefined
}

interface Exchange {
  readonly flight: Flight<Answer>
  readonly controller: AbortController
  waiting: number
}

export interface Governor extends AdoHttp {
  dispose(): void
}

const MERGEABLE_POSTS = ['/_apis/wit/wiql', '/_apis/wit/workitemsbatch']
const RANK: Record<Priority, number> = { user: 0, visible: 1, hidden: 2 }
const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 2 ** 31 - 1

export function mergeKey(req: AdoRequest): string | null {
  const method = req.method ?? 'GET'
  const mergeable = method === 'GET' || (method === 'POST' && MERGEABLE_POSTS.some(path => req.path.endsWith(path)))
  if (!mergeable) return null
  const query = Object.entries(req.query ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const body = req.body === undefined ? null : JSON.stringify(req.body)
  return JSON.stringify([req.org, req.host ?? null, req.project ?? null, method, req.path, query, req.apiVersion ?? null, body])
}

export function createGovernor(deps: GovernorDeps): Governor {
  const orgs = new Map<string, OrgQueue>()
  const exchanges = new Map<string, Exchange>()
  let arrivals = 0

  const stopHearingRaises = onRaise(lane => {
    for (const [org, queue] of orgs) {
      for (const task of queue.held) if (task.context.lane === lane) unhold(queue, task)
      if (queue.queued.length > 0) pump(org, queue)
    }
  })

  function queueOf(org: string): OrgQueue {
    let queue = orgs.get(org)
    if (!queue) {
      queue = { queued: [], held: new Set(), running: new Set(), timer: undefined }
      orgs.set(org, queue)
    }
    return queue
  }

  function enqueue(org: string, send: () => Promise<Answer>, signal: AbortSignal | undefined): Promise<Answer> {
    const queue = queueOf(org)
    return new Promise<Answer>((resolve, reject) => {
      const task: Task = { context: currentContext(), arrival: arrivals++, send, resolve, reject, where: 'queued', detach: () => {} }
      if (signal) {
        const onAbort = () => drop(queue, task, signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        task.detach = () => signal.removeEventListener('abort', onAbort)
      }
      queue.queued.push(task)
      pump(org, queue)
    })
  }

  function pump(org: string, queue: OrgQueue): void {
    const state = deps.pressure.state(org)
    if (state.level === 'blocked') hold(org, queue, state.resumeAt)
    while (queue.running.size < MAX_IN_FLIGHT) {
      const next = firstOf(queue.queued)
      if (!next) return
      if (isBackground(next) && backgroundRunning(queue) >= BACKGROUND_SLOTS[state.level]) return
      queue.queued = queue.queued.filter(task => task !== next)
      start(org, queue, next)
    }
  }

  function start(org: string, queue: OrgQueue, task: Task): void {
    task.where = 'running'
    task.detach()
    queue.running.add(task)
    void runIn(task.context, async () => task.send())
      .then(task.resolve, task.reject)
      .finally(() => {
        task.where = 'done'
        queue.running.delete(task)
        pump(org, queue)
      })
  }

  function hold(org: string, queue: OrgQueue, resumeAt: number): void {
    for (const task of queue.queued.filter(isBackground)) {
      task.where = 'held'
      queue.held.add(task)
    }
    queue.queued = queue.queued.filter(task => task.where === 'queued')
    if (queue.held.size > 0) arm(org, queue, resumeAt)
  }

  function unhold(queue: OrgQueue, task: Task): void {
    queue.held.delete(task)
    task.where = 'queued'
    queue.queued.push(task)
    if (queue.held.size === 0) disarm(queue)
  }

  function arm(org: string, queue: OrgQueue, at: number): void {
    if (queue.timer?.at === at) return
    disarm(queue)
    const wait = Math.min(Math.max(at - deps.now(), MIN_WAIT_MS), MAX_WAIT_MS)
    const handle = deps.clock.setTimeout(() => {
      queue.timer = undefined
      for (const task of [...queue.held]) unhold(queue, task)
      pump(org, queue)
    }, wait)
    queue.timer = { handle, at }
  }

  function disarm(queue: OrgQueue): void {
    if (!queue.timer) return
    deps.clock.clearTimeout(queue.timer.handle)
    queue.timer = undefined
  }

  function drop(queue: OrgQueue, task: Task, reason: unknown): void {
    if (task.where === 'queued') queue.queued = queue.queued.filter(other => other !== task)
    else if (task.where === 'held') {
      queue.held.delete(task)
      if (queue.held.size === 0) disarm(queue)
    } else return
    task.where = 'done'
    task.detach()
    task.reject(reason)
  }

  function share(key: string, req: AdoRequest): Promise<Answer> {
    const exchange = exchanges.get(key) ?? open(key, req)
    exchange.waiting += 1
    const answer = join(exchange.flight)
    const signal = req.signal
    if (!signal) return answer
    return new Promise<Answer>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason)
        leave(key, exchange, signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  function open(key: string, req: AdoRequest): Exchange {
    const controller = new AbortController()
    const flight = fly(() => enqueue(req.org, () => deps.http.json<unknown>({ ...req, signal: controller.signal }), controller.signal))
    const exchange: Exchange = { flight, controller, waiting: 0 }
    exchanges.set(key, exchange)
    const close = () => {
      if (exchanges.get(key) === exchange) exchanges.delete(key)
    }
    void flight.promise.then(close, close)
    return exchange
  }

  function leave(key: string, exchange: Exchange, reason: unknown): void {
    exchange.waiting -= 1
    if (exchange.waiting > 0) return
    if (exchanges.get(key) === exchange) exchanges.delete(key)
    exchange.controller.abort(reason)
  }

  return {
    json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }> {
      if (req.signal?.aborted) return Promise.reject(req.signal.reason)
      const key = mergeKey(req)
      const answer = key === null ? enqueue(req.org, () => deps.http.json<unknown>(req), req.signal) : share(key, req)
      return answer as Promise<{ data: T; headers: Headers }>
    },
    dispose: stopHearingRaises
  }
}

function isBackground(task: Task): boolean {
  return task.context.lane.priority !== 'user'
}

function backgroundRunning(queue: OrgQueue): number {
  let count = 0
  for (const task of queue.running) if (isBackground(task)) count += 1
  return count
}

function firstOf(tasks: readonly Task[]): Task | undefined {
  let best: Task | undefined
  for (const task of tasks) {
    if (!best) best = task
    else {
      const order = RANK[task.context.lane.priority] - RANK[best.context.lane.priority] || task.arrival - best.arrival
      if (order < 0) best = task
    }
  }
  return best
}
