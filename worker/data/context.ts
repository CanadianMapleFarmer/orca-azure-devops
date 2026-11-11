import { AsyncLocalStorage } from 'node:async_hooks'
import type { OrcaWorkerApi } from 'orca/worker'

export type Feature = 'work' | 'board' | 'prs' | 'reviews' | 'pipelines' | 'run' | 'wiki' | 'share' | 'connect' | 'other'
export type Priority = 'user' | 'visible' | 'hidden'
export interface Lane { readonly priority: Priority }
export interface RequestContext { readonly feature: Feature; readonly lane: Lane }
export interface Flight<T> { readonly promise: Promise<T>; readonly lane: Lane }

class MutableLane implements Lane {
  #priority: Priority

  constructor(priority: Priority) {
    this.#priority = priority
  }

  get priority(): Priority {
    return this.#priority
  }

  raise(): boolean {
    if (this.#priority === 'user') return false
    this.#priority = 'user'
    return true
  }
}

const storage = new AsyncLocalStorage<RequestContext>()
const outside: RequestContext = { feature: 'other', lane: new MutableLane('user') }
const raiseListeners = new Set<(lane: Lane) => void>()

const REQUEST_EXACT = new Map<string, Feature>([
  ['work.board', 'board'],
  ['work.boards', 'board'],
  ['work.openBoard', 'board'],
  ['runs.view', 'run'],
  ['runs.log', 'run'],
  ['runs.openFile', 'run']
])
const REQUEST_PREFIXES: [string, Feature][] = [
  ['work.', 'work'],
  ['prs.', 'prs'],
  ['reviews.', 'reviews'],
  ['runs.', 'pipelines'],
  ['wiki.', 'wiki'],
  ['share.', 'share'],
  ['orgs.', 'connect'],
  ['ado.', 'connect']
]
const SURFACES: readonly Feature[] = ['work', 'board', 'prs', 'pipelines', 'run']
const JOB_PREFIXES: [string, Feature][] = [
  ['mine:', 'work'],
  ['board:', 'board'],
  ['prs:', 'prs'],
  ['runs:', 'pipelines'],
  ['watch:', 'pipelines'],
  ['runview:', 'run']
]

export function inLane<T>(feature: Feature, priority: Priority, run: () => T): T {
  return storage.run({ feature, lane: new MutableLane(priority) }, run)
}

export function runIn<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run)
}

export function currentContext(): RequestContext {
  return storage.getStore() ?? outside
}

export function raise(lane: Lane): void {
  if (!(lane instanceof MutableLane) || !lane.raise()) return
  for (const listener of [...raiseListeners]) listener(lane)
}

export function onRaise(listener: (lane: Lane) => void): () => void {
  const own = (lane: Lane) => listener(lane)
  raiseListeners.add(own)
  return () => void raiseListeners.delete(own)
}

export function fly<T>(run: () => Promise<T>): Flight<T> {
  const { feature, lane } = currentContext()
  const own = new MutableLane(lane.priority)
  return { promise: storage.run({ feature, lane: own }, async () => run()), lane: own }
}

export function join<T>(flight: Flight<T>): Promise<T> {
  if (currentContext().lane.priority === 'user') raise(flight.lane)
  return flight.promise
}

export function featureOfRequest(name: string, input: unknown): Feature {
  if (name === 'ui.visibility') return surfaceOf(input)
  return REQUEST_EXACT.get(name) ?? REQUEST_PREFIXES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? 'other'
}

export function featureOfJob(key: string): Feature {
  return JOB_PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? 'other'
}

export function withUserContext(orca: OrcaWorkerApi): OrcaWorkerApi {
  const handle = (name: string, handler: (input: unknown, context: unknown) => unknown) =>
    orca.panels.handle(name as never, ((input: unknown, context: unknown) =>
      inLane(featureOfRequest(name, input), 'user', () => handler(input, context))) as never)
  return Object.create(orca, { panels: { value: Object.create(orca.panels, { handle: { value: handle } }) } }) as OrcaWorkerApi
}

function surfaceOf(input: unknown): Feature {
  const surface = typeof input === 'object' && input !== null ? (input as { surface?: unknown }).surface : undefined
  return SURFACES.find(feature => feature === surface) ?? 'other'
}
