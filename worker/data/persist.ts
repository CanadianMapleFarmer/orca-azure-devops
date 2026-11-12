import type { OrgStatus } from '../../src/shared/types'
import { byteLength } from '../budget'
import type { Clock } from '../poll/scheduler'
import { isRecord } from './values'

const CACHE_PREFIX = 'adoCache:'
const CACHE_VERSION = 'v1'
export const VALUE_BUDGET_BYTES = 160 * 1024
export const TOTAL_BUDGET_BYTES = 1536 * 1024
export const WRITE_EVERY_MS = 60_000
export const REFRESH_EVERY_MS = 15 * 60_000
const MAX_SAVED_BOARDS = 4

export interface CachePort {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}
export interface Saved<T> { account: string; savedAt: number; value: T }
export interface Persisted {
  load<T>(org: string, name: string, account: string): Promise<Saved<T> | null>
  /** `content` is `value` without its time stamps; a change to stamps alone is written at most every 15 minutes, and on flush. */
  save(org: string, name: string, account: string, value: unknown, content?: unknown): void
  forget(org: string): Promise<void>
  sweep(): Promise<void>
  flush(): Promise<void>
}
export interface PersistedDeps {
  port: CachePort
  orgs: () => Promise<OrgStatus[]>
  now: () => number
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  log: (message: string) => void
}

interface Use { bytes: number; usedAt: number }
interface Pending { org: string; account: string; value: unknown; body: string }

const VERSIONED = `${CACHE_PREFIX}${CACHE_VERSION}:`
const INDEX_KEY = `${VERSIONED}index`
const BOARD_NAME = 'board:'
const MIN_DELAY_MS = 1000
const TICK_STAMP = 'updatedAt'

export function cacheKey(org: string, name: string): string {
  return `${VERSIONED}${org}:${name}`
}

export function createPersisted(deps: PersistedDeps): Persisted {
  const { port, now, clock } = deps
  const pending = new Map<string, Pending>()
  const held = new Map<string, Pending>()
  const timers = new Map<string, unknown>()
  const written = new Map<string, string>()
  const refreshAt = new Map<string, number>()
  const lastWrite = new Map<string, number>()
  let index: Promise<Map<string, Use>> | null = null
  let queue = Promise.resolve()

  function serial(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch(error => deps.log(`Saved data: ${error instanceof Error ? error.message : String(error)}`))
    return queue
  }

  function usage(): Promise<Map<string, Use>> {
    index ??= readIndex().catch(error => {
      index = null
      throw error
    })
    return index
  }

  async function readIndex(): Promise<Map<string, Use>> {
    const [listed, keys] = await Promise.all([port.get(INDEX_KEY), port.keys()])
    const known = isRecord(listed) ? listed : {}
    const used = new Map<string, Use>()
    for (const key of keys.filter(isEntryKey).sort()) {
      const entry = known[key]
      used.set(key, isUse(entry) ? entry : { bytes: byteLength(await port.get(key)), usedAt: 0 })
    }
    return used
  }

  function delayFor(key: string): number {
    const wait = (lastWrite.get(key) ?? -Infinity) + WRITE_EVERY_MS - now()
    return wait <= 0 ? 0 : Math.max(wait, MIN_DELAY_MS)
  }

  function schedule(key: string): void {
    if (timers.has(key)) return
    timers.set(
      key,
      clock.setTimeout(() => {
        timers.delete(key)
        lastWrite.set(key, now())
        void serial(() => (key === INDEX_KEY ? writeIndex() : write(key)))
      }, delayFor(key))
    )
  }

  function current(key: string, body: string): boolean {
    return written.get(key) === body && now() < (refreshAt.get(key) ?? Infinity)
  }

  function cancel(key: string): void {
    if (timers.has(key)) clock.clearTimeout(timers.get(key))
    timers.delete(key)
  }

  async function write(key: string): Promise<void> {
    const next = pending.get(key)
    if (!next) return
    pending.delete(key)
    const status = (await deps.orgs()).find(entry => entry.org === next.org)
    if (status?.state !== 'connected' || status.account?.adoId !== next.account) return
    const bytes = byteLength(next.value)
    if (bytes > VALUE_BUDGET_BYTES) {
      written.set(key, next.body)
      refreshAt.delete(key)
      deps.log(`Saved data: ${key} is ${bytes} bytes, over the ${VALUE_BUDGET_BYTES}-byte budget; not saved.`)
      return
    }
    const saved: Saved<unknown> = { account: next.account, savedAt: now(), value: next.value }
    const used = await usage()
    const before = used.get(key)
    const usedAt = before && written.get(key) === next.body ? before.usedAt : now()
    used.set(key, { bytes: byteLength(saved), usedAt })
    try {
      await port.set(key, saved)
    } catch (error) {
      if (before) used.set(key, before)
      else used.delete(key)
      throw error
    }
    written.set(key, next.body)
    refreshAt.set(key, saved.savedAt + REFRESH_EVERY_MS)
    await evict(used, doomedBy(used, key))
    schedule(INDEX_KEY)
  }

  async function evict(used: Map<string, Use>, doomed: Set<string>): Promise<void> {
    for (const key of doomed) {
      await port.delete(key)
      used.delete(key)
      held.delete(key)
      written.delete(key)
      refreshAt.delete(key)
    }
  }

  async function writeIndex(): Promise<void> {
    if (!index) return
    const value = Object.fromEntries([...(await usage())].sort(([a], [b]) => a.localeCompare(b)))
    const body = JSON.stringify(value)
    if (written.get(INDEX_KEY) === body) return
    await port.set(INDEX_KEY, value)
    written.set(INDEX_KEY, body)
  }

  return {
    async load<T>(org: string, name: string, account: string): Promise<Saved<T> | null> {
      const key = cacheKey(org, name)
      try {
        const saved = await port.get(key)
        if (!isSaved(saved) || saved.account !== account) return null
        const use = (await usage()).get(key)
        if (use) {
          use.usedAt = now()
          schedule(INDEX_KEY)
        }
        return saved as Saved<T>
      } catch (error) {
        deps.log(`Saved data: ${key} could not be read: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    },

    save(org, name, account, value, content = value) {
      const key = cacheKey(org, name)
      const next = { org, account, value, body: contentOf(account, content) }
      if (!pending.has(key) && current(key, next.body)) {
        held.set(key, next)
        return
      }
      held.delete(key)
      pending.set(key, next)
      schedule(key)
    },

    forget(org) {
      const prefix = cacheKey(org, '')
      for (const key of [...pending.keys(), ...held.keys()]) {
        if (!key.startsWith(prefix)) continue
        pending.delete(key)
        held.delete(key)
        cancel(key)
      }
      return serial(async () => {
        const used = await usage()
        for (const key of (await port.keys()).filter(key => key.startsWith(prefix))) await port.delete(key)
        for (const key of [...used.keys(), ...written.keys(), ...lastWrite.keys()]) {
          if (!key.startsWith(prefix)) continue
          used.delete(key)
          written.delete(key)
          refreshAt.delete(key)
          lastWrite.delete(key)
        }
        schedule(INDEX_KEY)
      })
    },

    sweep() {
      return serial(async () => {
        for (const key of await port.keys()) if (key.startsWith(CACHE_PREFIX) && !key.startsWith(VERSIONED)) await port.delete(key)
      })
    },

    async flush() {
      for (const [key, next] of held) if (!pending.has(key)) pending.set(key, next)
      held.clear()
      for (const key of [...timers.keys()]) cancel(key)
      for (const key of [...pending.keys()]) void serial(() => write(key))
      await serial(async () => {
        cancel(INDEX_KEY)
        await writeIndex()
      })
    }
  }
}

function contentOf(account: string, value: unknown): string {
  return JSON.stringify([account, value], (key, held: unknown) => (key === TICK_STAMP ? undefined : held))
}

function isEntryKey(key: string): boolean {
  return key.startsWith(VERSIONED) && key !== INDEX_KEY
}

function doomedBy(used: Map<string, Use>, kept: string): Set<string> {
  const doomed = new Set(extraBoards(used, kept))
  let total = byteLength(Object.fromEntries(used)) + [...used].filter(([key]) => !doomed.has(key)).reduce((sum, [, use]) => sum + use.bytes, 0)
  const oldestFirst = [...used].filter(([key]) => key !== kept && !doomed.has(key)).sort(([, a], [, b]) => a.usedAt - b.usedAt)
  for (const [key, use] of oldestFirst) {
    if (total <= TOTAL_BUDGET_BYTES) break
    doomed.add(key)
    total -= use.bytes
  }
  return doomed
}

function extraBoards(used: Map<string, Use>, kept: string): string[] {
  const boards = cacheKey(orgOf(kept), BOARD_NAME)
  if (!kept.startsWith(boards)) return []
  return [...used]
    .filter(([key]) => key.startsWith(boards))
    .sort(([keyA, a], [keyB, b]) => (keyA === kept ? -1 : keyB === kept ? 1 : b.usedAt - a.usedAt))
    .slice(MAX_SAVED_BOARDS)
    .map(([key]) => key)
}

function orgOf(key: string): string {
  return key.slice(VERSIONED.length).split(':')[0]
}

function isUse(value: unknown): value is Use {
  return isRecord(value) && Number.isFinite(value.bytes) && Number.isFinite(value.usedAt)
}

function isSaved(value: unknown): value is Saved<unknown> {
  return isRecord(value) && typeof value.account === 'string' && Number.isFinite(value.savedAt) && value.value !== undefined && value.value !== null
}
