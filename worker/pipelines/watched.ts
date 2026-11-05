import type { RunKey } from '../../src/shared/pipelines'
import type { StorePort } from '../connections'
import { badRequest, TOO_MANY_WATCHED } from '../messages'

export const MAX_WATCHED = 20

export interface WatchList {
  list(org: string): Promise<RunKey[]>
  set(org: string, key: RunKey, watched: boolean): Promise<RunKey[]>
  drop(org: string, keys: RunKey[]): Promise<void>
}

export function createWatchList(store: StorePort): WatchList {
  const turns = new Map<string, Promise<unknown>>()

  async function read(org: string): Promise<RunKey[]> {
    const stored = await store.get<unknown>(storageKey(org))
    return Array.isArray(stored) ? stored.filter(isRunKey).map(({ projectId, buildId }) => ({ projectId, buildId })) : []
  }

  function inTurn<T>(org: string, change: (keys: RunKey[]) => { keys: RunKey[]; result: T }): Promise<T> {
    const turn = (turns.get(org) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const before = await read(org)
      const { keys, result } = change(before)
      if (keys.length !== before.length) await store.set(storageKey(org), keys)
      return result
    })
    turns.set(org, turn)
    return turn
  }

  return {
    list: org => inTurn(org, keys => ({ keys, result: keys })),
    set(org, key, watched) {
      return inTurn(org, keys => {
        const present = keys.some(entry => entry.buildId === key.buildId)
        if (watched && !present && keys.length >= MAX_WATCHED) throw badRequest(TOO_MANY_WATCHED)
        const next = watched
          ? present ? keys : [...keys, { projectId: key.projectId, buildId: key.buildId }]
          : keys.filter(entry => entry.buildId !== key.buildId)
        return { keys: next, result: next }
      })
    },
    drop(org, dropped) {
      const ids = new Set(dropped.map(key => key.buildId))
      return inTurn(org, keys => ({ keys: keys.filter(key => !ids.has(key.buildId)), result: undefined }))
    }
  }
}

function storageKey(org: string): string {
  return `pipelines:watched:${org}`
}

function isRunKey(value: unknown): value is RunKey {
  if (typeof value !== 'object' || value === null) return false
  const { projectId, buildId } = value as Partial<RunKey>
  return typeof projectId === 'string' && projectId !== '' && typeof buildId === 'number' && Number.isSafeInteger(buildId) && buildId > 0
}
