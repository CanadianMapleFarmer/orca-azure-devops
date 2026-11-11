import type { StageChip } from '../../src/shared/pipelines'
import type { WikiRef } from '../../src/shared/wiki'
import type { BoardConfig } from '../../src/shared/work'
import type { TypeState } from '../ado/board-config'
import type { RawBuild } from '../ado/builds'
import type { NamedItem } from '../ado/core'
import type { RawTimeline } from '../ado/timeline'
import { fly, join, type Flight } from './context'
import { MAX_ENTRIES } from './freshness'
import type { CheckRecord, ItemRecord, PrRecord } from './records'

export interface Stamped<T> { value: T; at: number }
export interface TableSpec<T> { maxEntries: number; replaces?: (incoming: T, stored: T) => boolean }

export interface Table<T> {
  get(key: string): Stamped<T> | undefined
  fresh(key: string, maxAgeMs: number): T | undefined
  put(key: string, value: T, at?: number): T
  read(key: string, maxAgeMs: number, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  drop(key: string): void
  entries(): [string, Stamped<T>][]
}

export interface OrgEntities {
  workItems: Table<ItemRecord>
  prs: Table<PrRecord>
  prChecks: Table<CheckRecord>
  prWorkItems: Table<number[]>
  builds: Table<RawBuild>
  timelines: Table<RawTimeline>
  runChips: Table<StageChip[] | null>
  boardConfigs: Table<BoardConfig>
  typeStates: Table<TypeState[]>
  projects: Table<NamedItem[]>
  wikis: Table<WikiRef[]>
}

export type TableName = keyof OrgEntities

export interface Entities {
  of(org: string): OrgEntities
  forget(org: string): void
  watch(table: TableName, listener: (org: string, keys: string[]) => void): () => void
}

type Listener = (org: string, keys: string[]) => void

interface Load<T> {
  readonly flight: Flight<T>
  readonly controller: AbortController
  readonly settled: Promise<T>
  signals: number
  unbounded: boolean
}

export function createTable<T>(now: () => number, spec: TableSpec<T>): Table<T> {
  return tableOf(now, spec, () => {})
}

export function createEntities(now: () => number): Entities {
  const orgs = new Map<string, OrgEntities>()
  const listeners = new Map<TableName, Set<Listener>>()
  let pending = new Map<TableName, Map<string, Set<string>>>()

  function changed(table: TableName, org: string, key: string): void {
    if (!listeners.get(table)?.size) return
    if (pending.size === 0) queueMicrotask(flush)
    const byOrg = pending.get(table) ?? new Map<string, Set<string>>()
    pending.set(table, byOrg)
    const keys = byOrg.get(org) ?? new Set<string>()
    byOrg.set(org, keys)
    keys.add(key)
  }

  function flush(): void {
    const batch = pending
    pending = new Map()
    for (const [table, byOrg] of batch) {
      for (const [org, keys] of byOrg) {
        for (const listener of [...(listeners.get(table) ?? [])]) listener(org, [...keys])
      }
    }
  }

  function build(org: string): OrgEntities {
    const table = <T>(name: TableName, replaces?: (incoming: T, stored: T) => boolean): Table<T> =>
      tableOf<T>(now, { maxEntries: MAX_ENTRIES[name], replaces }, key => {
        if (orgs.get(org) === tables) changed(name, org, key)
      })
    const tables: OrgEntities = {
      workItems: table('workItems', newerRev),
      prs: table('prs'),
      prChecks: table('prChecks'),
      prWorkItems: table('prWorkItems'),
      builds: table('builds'),
      timelines: table<RawTimeline>('timelines', (incoming, stored) => incoming.changeId >= stored.changeId),
      runChips: table('runChips'),
      boardConfigs: table('boardConfigs'),
      typeStates: table('typeStates'),
      projects: table('projects'),
      wikis: table('wikis')
    }
    return tables
  }

  return {
    of(org) {
      const existing = orgs.get(org)
      if (existing) return existing
      const made = build(org)
      orgs.set(org, made)
      return made
    },
    forget(org) {
      orgs.delete(org)
    },
    watch(table, listener) {
      const own: Listener = (org, keys) => listener(org, keys)
      const set = listeners.get(table) ?? new Set<Listener>()
      listeners.set(table, set)
      set.add(own)
      return () => void set.delete(own)
    }
  }
}

function tableOf<T>(now: () => number, spec: TableSpec<T>, changed: (key: string) => void): Table<T> {
  const entries = new Map<string, Stamped<T>>()
  const loads = new Map<string, Load<T>>()

  function use(key: string): Stamped<T> | undefined {
    const entry = entries.get(key)
    if (!entry) return undefined
    entries.delete(key)
    entries.set(key, entry)
    return entry
  }

  function freshEntry(key: string, maxAgeMs: number): Stamped<T> | undefined {
    const entry = entries.get(key)
    return entry && now() - entry.at < maxAgeMs ? use(key) : undefined
  }

  function put(key: string, value: T, at = now()): T {
    const stored = entries.get(key)
    if (stored && spec.replaces && !spec.replaces(value, stored.value)) return stored.value
    entries.delete(key)
    entries.set(key, { value, at })
    for (const oldest of entries.keys()) {
      if (entries.size <= spec.maxEntries) break
      entries.delete(oldest)
    }
    changed(key)
    return value
  }

  function start(key: string, load: (signal: AbortSignal) => Promise<T>): Load<T> {
    const controller = new AbortController()
    const flight = fly(() => load(controller.signal))
    const settled = flight.promise.then(
      value => {
        finish(key, current)
        return controller.signal.aborted ? value : put(key, value)
      },
      (error: unknown) => {
        finish(key, current)
        throw error
      }
    )
    const current: Load<T> = { flight, controller, settled, signals: 0, unbounded: false }
    loads.set(key, current)
    return current
  }

  function finish(key: string, load: Load<T>): void {
    if (loads.get(key) === load) loads.delete(key)
  }

  function wait(key: string, current: Load<T>, signal: AbortSignal | undefined): Promise<T> {
    void join(current.flight)
    if (!signal) {
      current.unbounded = true
      return current.settled
    }
    current.signals += 1
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason)
        leave(key, current, signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void current.settled.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  function leave(key: string, current: Load<T>, reason: unknown): void {
    current.signals -= 1
    if (current.signals > 0 || current.unbounded) return
    finish(key, current)
    current.controller.abort(reason)
  }

  return {
    get: use,
    fresh: (key, maxAgeMs) => freshEntry(key, maxAgeMs)?.value,
    put,
    read(key, maxAgeMs, load, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      const hit = freshEntry(key, maxAgeMs)
      if (hit) return Promise.resolve(hit.value)
      return wait(key, loads.get(key) ?? start(key, load), signal)
    },
    drop(key) {
      if (entries.delete(key)) changed(key)
    },
    entries: () => [...entries.entries()]
  }
}

function newerRev(incoming: ItemRecord, stored: ItemRecord): boolean {
  return incoming.rev > stored.rev || (incoming.rev === stored.rev && (incoming.withRelations || !stored.withRelations))
}
