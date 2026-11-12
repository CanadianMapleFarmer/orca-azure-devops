import type { StorePort } from '../connections'

export const MAX_REMEMBERED_BOARDS = 50

export interface BoardFilters {
  everyone(org: string, teamId: string, boardId: string): Promise<boolean>
  remember(org: string, teamId: string, boardId: string, everyone: boolean): Promise<void>
}

function filtersKey(org: string): string {
  return `boardFilters:${org}`
}

function boardOf(teamId: string, boardId: string): string {
  return `${teamId}/${boardId}`
}

export function createBoardFilters(store: StorePort): BoardFilters {
  let writes: Promise<void> = Promise.resolve()

  async function read(org: string): Promise<Map<string, boolean>> {
    const stored = await store.get<unknown>(filtersKey(org))
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return new Map()
    return new Map(Object.entries(stored).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  }

  return {
    async everyone(org, teamId, boardId) {
      return (await read(org)).get(boardOf(teamId, boardId)) ?? true
    },

    remember(org, teamId, boardId, everyone) {
      const write = writes.then(async () => {
        const filters = await read(org)
        const board = boardOf(teamId, boardId)
        if (filters.get(board) === everyone) return
        filters.delete(board)
        filters.set(board, everyone)
        await store.set(filtersKey(org), Object.fromEntries([...filters].slice(-MAX_REMEMBERED_BOARDS)))
      })
      writes = write.catch(() => {})
      return write
    }
  }
}
