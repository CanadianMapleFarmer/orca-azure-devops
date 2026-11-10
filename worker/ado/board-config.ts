import type { BoardColumn, BoardConfig } from '../../src/shared/work'
import { MALFORMED, noBoardNamed } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { expectText, shaped } from './shape'

export interface BoardArgs {
  org: string
  projectId: string
  teamId: string
  boardId?: string
}

interface BacklogLevel {
  workItemTypes?: { name?: unknown }[]
}

interface BacklogConfiguration {
  requirementBacklog: { name: string }
  taskBacklog?: BacklogLevel
  bugWorkItems?: BacklogLevel
  bugsBehavior?: string
}

interface FoundBoard {
  board: RawBoard
  taskTypes?: string[]
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

export interface TypeState {
  name: string
  category: string
}

export const DONE_CATEGORIES = new Set(['Completed', 'Removed'])
const DEFAULT_TTL_MS = 60 * 60 * 1000

export function boardConfigKey({ org, projectId, teamId, boardId }: BoardArgs): string {
  return `${org}/${projectId}/${teamId}/${boardId ?? 'default'}`
}

export async function listTeamBoards(
  http: AdoHttp,
  args: { org: string; projectId: string; teamId: string }
): Promise<{ id: string; name: string }[]> {
  const data = await teamGet<{ value: { id: string; name: string }[] }>(http, args, 'boards')
  return shape(() => data.value.map(({ id, name }) => ({ id: expectText(id), name: expectText(name) })))
}

export async function loadBoardConfig(http: AdoHttp, args: BoardArgs): Promise<BoardConfig> {
  const [{ board, taskTypes }, areas] = await Promise.all([
    args.boardId ? fetchBoard(http, args, args.boardId).then((named): FoundBoard => ({ board: named })) : fetchRequirementBoard(http, args),
    teamGet<TeamFieldValues>(http, args, 'teamsettings/teamfieldvalues')
  ])
  const requirementTypes = shape(() => requirementTypeNames(board))
  const doneLists = await Promise.all(requirementTypes.map(type => fetchDoneStates(http, args, type)))
  return shape(() => ({
    org: args.org,
    projectId: args.projectId,
    teamId: args.teamId,
    boardId: expectText(board.id),
    boardName: expectText(board.name),
    requirementTypes,
    columns: board.columns.map(toColumn),
    lanes: board.rows.map(row => ({ id: expectText(row.id), name: expectText(row.name ?? '') })),
    fields: {
      column: expectText(board.fields.columnField.referenceName),
      columnDone: expectText(board.fields.doneField.referenceName),
      lane: expectText(board.fields.rowField.referenceName)
    },
    areaPaths: areas.values.map(({ value, includeChildren }) => ({ value: expectText(value), includeChildren: includeChildren === true })),
    doneStates: Object.fromEntries(requirementTypes.map((type, index) => [type, doneLists[index]])),
    ...(taskTypes ? { taskTypes } : {})
  }))
}

async function fetchRequirementBoard(http: AdoHttp, args: BoardArgs): Promise<FoundBoard> {
  const [backlog, boards] = await Promise.all([
    teamGet<BacklogConfiguration>(http, args, 'backlogconfiguration'),
    listTeamBoards(http, args)
  ])
  const name = shape(() => expectText(backlog.requirementBacklog.name))
  const lowerName = name.toLowerCase()
  const match = boards.find(board => board.name === name) ?? boards.find(board => board.name.toLowerCase() === lowerName)
  if (!match) throw new AdoError('not_found', 404, noBoardNamed(name))
  return { board: await fetchBoard(http, args, match.id), taskTypes: taskTypeNames(backlog) }
}

function taskTypeNames(backlog: BacklogConfiguration): string[] {
  const levels = backlog.bugsBehavior === 'asTasks' ? [backlog.taskBacklog, backlog.bugWorkItems] : [backlog.taskBacklog]
  return [...new Set(levels.flatMap(typeNames))]
}

function typeNames(level: BacklogLevel | undefined): string[] {
  const types: unknown = level?.workItemTypes
  return Array.isArray(types) ? types.flatMap(type => (typeof type?.name === 'string' ? [type.name] : [])) : []
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

export async function loadTypeStates(http: AdoHttp, args: { org: string; projectId: string }, type: string): Promise<TypeState[]> {
  const { data } = await http.json<{ value: TypeState[] }>({
    org: args.org,
    project: args.projectId,
    path: `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`
  })
  return shape(() => data.value.map(state => ({ name: expectText(state.name), category: expectText(state.category) })))
}

async function fetchDoneStates(http: AdoHttp, args: BoardArgs, type: string): Promise<string[]> {
  const states = await loadTypeStates(http, args, type)
  return states.filter(state => DONE_CATEGORIES.has(state.category)).map(state => state.name)
}

function requirementTypeNames(board: RawBoard): string[] {
  return [...new Set(board.columns.flatMap(column => Object.keys(column.stateMappings ?? {})))]
}

function toColumn(column: RawColumn): BoardColumn {
  return {
    id: expectText(column.id),
    name: expectText(column.name),
    isSplit: column.isSplit === true,
    columnType: column.columnType,
    stateMappings: column.stateMappings ?? {}
  }
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.boardConfig)
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
