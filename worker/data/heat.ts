import type { NamedItem } from '../ado/core'

export const HOT_FOR_MS = 24 * 60 * 60_000
export const COLD_EVERY_MS = 5 * 60_000

export interface Heat {
  pick(projects: NamedItem[], all: boolean): NamedItem[]
  saw(projectId: string, found: boolean): void
}

interface Seen {
  readAt: number
  foundAt: number
}

export function createHeat(now: () => number): Heat {
  const seen = new Map<string, Seen>()

  function due(projectId: string): boolean {
    const last = seen.get(projectId)
    return !last || now() - last.foundAt < HOT_FOR_MS || now() - last.readAt >= COLD_EVERY_MS
  }

  return {
    pick(projects, all) {
      return all ? projects : projects.filter(project => due(project.id))
    },

    saw(projectId, found) {
      const at = now()
      seen.set(projectId, { readAt: at, foundAt: found ? at : (seen.get(projectId)?.foundAt ?? -Infinity) })
    }
  }
}
