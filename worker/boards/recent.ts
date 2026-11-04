import type { WorkItemSummary } from '../../src/shared/work'
import type { RawWorkItem } from '../ado/workitems'

export interface Written { raw: RawWorkItem; like: WorkItemSummary }

export interface RecentWrites {
  record(holders: string[], written: Written): void
  overlay(holder: string, items: WorkItemSummary[], restate: (written: Written) => Promise<WorkItemSummary>): Promise<WorkItemSummary[]>
  drop(holder: string): void
}

export function createRecentWrites(): RecentWrites {
  const byHolder = new Map<string, Map<number, Written>>()

  return {
    record(holders, written) {
      for (const holder of holders) {
        const writes = byHolder.get(holder) ?? new Map<number, Written>()
        writes.set(written.raw.id, written)
        byHolder.set(holder, writes)
      }
    },

    async overlay(holder, items, restate) {
      const writes = byHolder.get(holder)
      if (!writes) return items
      const checked = [...writes]
      const newer = new Set<number>()
      const result = await Promise.all(
        items.map(item => {
          const written = writes.get(item.id)
          if (!written || written.raw.rev <= item.rev) return item
          newer.add(item.id)
          return restate(written)
        })
      )
      for (const [id, written] of checked) if (!newer.has(id) && writes.get(id) === written) writes.delete(id)
      if (writes.size === 0 && byHolder.get(holder) === writes) byHolder.delete(holder)
      return result
    },

    drop(holder) {
      byHolder.delete(holder)
    }
  }
}
