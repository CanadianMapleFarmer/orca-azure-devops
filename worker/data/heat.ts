export const HOT_FOR_MS = 24 * 60 * 60_000
export const COLD_EVERY_MS = 5 * 60_000

export interface Heat<List extends string> {
  due(list: List, projectId: string): boolean
  saw(list: List, projectId: string, found: boolean): void
}

/** Cold projects fall due `longestTickMs` before `COLD_EVERY_MS`, so a tick that far off still reads them in time. */
export function createHeat<List extends string>(now: () => number, longestTickMs: number): Heat<List> {
  const readAt = new Map<string, number>()
  const foundAt = new Map<string, number>()
  const coldDueMs = COLD_EVERY_MS - longestTickMs

  return {
    due(list, projectId) {
      const read = readAt.get(`${list}/${projectId}`)
      return read === undefined || now() - (foundAt.get(projectId) ?? -Infinity) < HOT_FOR_MS || now() - read >= coldDueMs
    },

    saw(list, projectId, found) {
      readAt.set(`${list}/${projectId}`, now())
      if (found) foundAt.set(projectId, now())
    }
  }
}
