import type { PrKey } from '../../src/shared/prs'
import type { RawThread } from '../ado/pr-review'
import { timestamp } from '../ado/workitems'
import { prKey } from '../data/records'

export const THREADS_FIRST_MS = 2 * 60_000
export const THREADS_MAX_MS = 10 * 60_000

export interface ThreadCadence {
  due<T extends PrKey>(watched: readonly T[]): T[]
  read(pr: PrKey, signature: string): void
  forget(): void
}

interface LastRead {
  at: number
  every: number
  signature: string
}

export function createThreadCadence(now: () => number): ThreadCadence {
  const reads = new Map<string, LastRead>()

  return {
    due(watched) {
      const keys = new Set(watched.map(prKey))
      for (const key of reads.keys()) if (!keys.has(key)) reads.delete(key)
      return watched.filter(pr => {
        const last = reads.get(prKey(pr))
        return last === undefined || now() - last.at >= last.every
      })
    },

    read(pr, signature) {
      const key = prKey(pr)
      const last = reads.get(key)
      const every = last?.signature === signature ? Math.min(last.every * 2, THREADS_MAX_MS) : THREADS_FIRST_MS
      reads.set(key, { at: now(), every, signature })
    },

    forget() {
      reads.clear()
    }
  }
}

export function threadSignature(threads: readonly RawThread[]): string {
  const comments = threads.flatMap(thread => (Array.isArray(thread?.comments) ? thread.comments : []))
  const latest = comments.reduce((max, comment) => Math.max(max, timestamp(comment?.lastUpdatedDate), timestamp(comment?.publishedDate)), 0)
  return `${threads.length}:${latest}`
}
