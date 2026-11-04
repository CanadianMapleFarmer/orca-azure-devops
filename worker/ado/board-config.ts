import type { BoardColumn, BoardConfig } from '../../src/shared/work'
import { AdoError, type AdoHttp } from './http'

export interface BoardArgs {
  org: string
  projectId: string
  teamId: string
  boardId?: string
}

interface BacklogLevel {
  name: string
  workItemTypes?: { name: string }[]
}

interface BacklogConfiguration {
  requirementBacklog: BacklogLevel
  bugsBehavior: 'asRequirements' | 'asTasks' | 'off'
  bugWorkItems?: BacklogLevel
  workItemTypeMappedStates?: { workItemTypeName: string }[]
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

const BUG_TYPE = 'Bug'
const DONE_CATEGORIES = new Set(['Completed', 'Removed'])
const DEFAULT_TTL_MS = 60 * 60 * 1000

export function boardConfigKey({ org, projectId, teamId, boardId }: BoardArgs): string {
  return `${org}/${projectId}/${teamId}/${boardId ?? 'default'}`
}

export async function listTeamBoards(
  http: AdoHttp,
  args: { org: string; projectId: string; teamId: string }
): Promise<{ id: string; name: string }[]> {
  const { value } = await teamGet<{ value: { id: string; name: string }[] }>(http, args, 'boards')
  return value.map(({ id, name }) => ({ id, name }))
}

export async function loadBoardConfig(http: AdoHttp, args: BoardArgs): Promise<BoardConfig> {
  const backlogRequest = teamGet<BacklogConfiguration>(http, args, 'backlogconfiguration')
  const [backlog, areas, board] = await Promise.all([
    backlogRequest,
    teamGet<TeamFieldValues>(http, args, 'teamsettings/teamfieldvalues'),
    args.boardId ? fetchBoard(http, args, args.boardId) : fetchRequirementBoard(http, args, backlogRequest)
  ])
  const requirementTypes = requirementTypeNames(backlog)
  const states = await Promise.all(requirementTypes.map(type => fetchTypeStates(http, args, type)))
  return {
    org: args.org,
    projectId: args.projectId,
    teamId: args.teamId,
    boardId: board.id,
    boardName: board.name,
    requirementTypes,
    columns: board.columns.map(toColumn),
    lanes: board.rows.map(row => ({ id: row.id, name: row.name ?? '' })),
    fields: {
      column: board.fields.columnField.referenceName,
      columnDone: board.fields.doneField.referenceName,
      lane: board.fields.rowField.referenceName
    },
    areaPaths: areas.values.map(({ value, includeChildren }) => ({ value, includeChildren })),
    doneStates: Object.fromEntries(
      requirementTypes.map((type, index) => [type, states[index].filter(isDone).map(state => state.name)])
    )
  }
}

async function fetchRequirementBoard(
  http: AdoHttp,
  args: BoardArgs,
  backlogRequest: Promise<BacklogConfiguration>
): Promise<RawBoard> {
  const [boards, backlog] = await Promise.all([listTeamBoards(http, args), backlogRequest])
  const name = backlog.requirementBacklog.name
  const match = boards.find(board => board.name === name)
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

async function fetchTypeStates(http: AdoHttp, args: BoardArgs, type: string): Promise<TypeState[]> {
  const { data } = await http.json<{ value: TypeState[] }>({
    org: args.org,
    project: args.projectId,
    path: `/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`
  })
  return data.value
}

function requirementTypeNames(backlog: BacklogConfiguration): string[] {
  const names = (backlog.requirementBacklog.workItemTypes ?? []).map(type => type.name)
  if (backlog.bugsBehavior === 'asRequirements') names.push(...bugTypeNames(backlog))
  return [...new Set(names)]
}

function bugTypeNames(backlog: BacklogConfiguration): string[] {
  const declared = (backlog.bugWorkItems?.workItemTypes ?? []).map(type => type.name)
  if (declared.length > 0) return declared
  const mapped = backlog.workItemTypeMappedStates
  return !mapped || mapped.some(entry => entry.workItemTypeName === BUG_TYPE) ? [BUG_TYPE] : []
}

function toColumn(column: RawColumn): BoardColumn {
  return {
    id: column.id,
    name: column.name,
    isSplit: column.isSplit === true,
    columnType: column.columnType,
    stateMappings: column.stateMappings ?? {}
  }
}

function isDone(state: TypeState): boolean {
  return DONE_CATEGORIES.has(state.category)
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
