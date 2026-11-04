import type { BoardColumn, BoardConfig } from '../../src/shared/work'
import { AdoError, type AdoHttp } from './http'

export interface BoardArgs {
  org: string
  projectId: string
  teamId: string
  boardId?: string
}

interface BacklogConfiguration {
  requirementBacklog: { name: string }
}

interface RawColumn {
  id: string
  name: string
  isSplit?: boolean
  columnType: BoardColumn['columnType']
  stateMappings?: Record<string, string>
}

interface RawBoard {
  id: string
  name: string
  columns: RawColumn[]
  rows: { id: string; name: string | null }[]
  fields: {
    columnField: { referenceName: string }
    rowField: { referenceName: string }
    doneField: { referenceName: string }
  }
}

interface TeamFieldValues {
  values: { value: string; includeChildren: boolean }[]
}

interface TypeState {
  name: string
  category: string
}

const DONE_CATEGORIES = new Set(['Completed', 'Removed'])
const DEFAULT_TTL_MS = 60 * 60 * 1000
const MALFORMED_MESSAGE = 'Azure DevOps returned an unexpected board configuration.'

export function boardConfigKey({ org, projectId, teamId, boardId }: BoardArgs): string {
  return `${org}/${projectId}/${teamId}/${boardId ?? 'default'}`
}

export async function listTeamBoards(
  http: AdoHttp,
  args: { org: string; projectId: string; teamId: string }
): Promise<{ id: string; name: string }[]> {
  const data = await teamGet<{ value: { id: string; name: string }[] }>(http, args, 'boards')
  return shape(() => data.value.map(({ id, name }) => ({ id: text(id), name: text(name) })))
}

export async function loadBoardConfig(http: AdoHttp, args: BoardArgs): Promise<BoardConfig> {
  const [board, areas] = await Promise.all([
    args.boardId ? fetchBoard(http, args, args.boardId) : fetchRequirementBoard(http, args),
    teamGet<TeamFieldValues>(http, args, 'teamsettings/teamfieldvalues')
  ])
  const requirementTypes = shape(() => requirementTypeNames(board))
  const doneLists = await Promise.all(requirementTypes.map(type => fetchDoneStates(http, args, type)))
  return shape(() => ({
    org: args.org,
    projectId: args.projectId,
    teamId: args.teamId,
    boardId: text(board.id),
    boardName: text(board.name),
    requirementTypes,
    columns: board.columns.map(toColumn),
    lanes: board.rows.map(row => ({ id: text(row.id), name: text(row.name ?? '') })),
    fields: {
      column: text(board.fields.columnField.referenceName),
      columnDone: text(board.fields.doneField.referenceName),
      lane: text(board.fields.rowField.referenceName)
    },
    areaPaths: areas.values.map(({ value, includeChildren }) => ({ value: text(value), includeChildren: includeChildren === true })),
    doneStates: Object.fromEntries(requirementTypes.map((type, index) => [type, doneLists[index]]))
  }))
}

async function fetchRequirementBoard(http: AdoHttp, args: BoardArgs): Promise<RawBoard> {
  const [backlog, boards] = await Promise.all([
    teamGet<BacklogConfiguration>(http, args, 'backlogconfiguration'),
    listTeamBoards(http, args)
  ])
  const name = shape(() => text(backlog.requirementBacklog.name))
  const lowerName = name.toLowerCase()
  const match = boards.find(board => board.name === name) ?? boards.find(board => board.name.toLowerCase() === lowerName)
  if (!match) throw new AdoError('not_found', 404, `The team has no board named "${name}".`)
  return fetchBoard(http, args, match.id)
}

function fetchBoard(http: AdoHttp, args: BoardArgs, boardId: string): Promise<RawBoard> {
  return teamGet<RawBoard>(http, args, `boards/${encodeURIComponent(boardId)}`)
}

async function teamGet<T>(http: AdoHttp, args: BoardArgs, resource: string): Promise<T> {
  const { data } = await http.json<T>({
    org: args.org,
    project: args.projectId,
    path: `/${encodeURIComponent(args.teamId)}/_apis/work/${resource}`
  })
  return data
}

async function fetchDoneStates(http: AdoHttp, args: BoardArgs, type: string): Promise<string[]> {
  const { data } = await http.json<{ value: TypeState[] }>({
    org: args.org,
    project: args.projectId,
    path: `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`
  })
  return shape(() => data.value.filter(state => DONE_CATEGORIES.has(state.category)).map(state => text(state.name)))
}

function requirementTypeNames(board: RawBoard): string[] {
  return [...new Set(board.columns.flatMap(column => Object.keys(column.stateMappings ?? {})))]
}

function toColumn(column: RawColumn): BoardColumn {
  return {
    id: text(column.id),
    name: text(column.name),
    isSplit: column.isSplit === true,
    columnType: column.columnType,
    stateMappings: column.stateMappings ?? {}
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected text')
  return value
}

function shape<T>(build: () => T): T {
  try {
    return build()
  } catch {
    throw new AdoError('server', 200, MALFORMED_MESSAGE)
  }
}

export interface BoardConfigCache {
  get(key: string): BoardConfig | undefined
  set(key: string, cfg: BoardConfig): void
  clear(): void
}

export function createBoardConfigCache(now: () => number, ttlMs = DEFAULT_TTL_MS): BoardConfigCache {
  const entries = new Map<string, { config: BoardConfig; storedAt: number }>()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key)
        return undefined
      }
      return entry.config
    },
    set(key, cfg) {
      entries.set(key, { config: cfg, storedAt: now() })
    },
    clear() {
      entries.clear()
    }
  }
}
