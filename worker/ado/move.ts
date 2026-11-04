import type { BoardConfig, MoveTarget, WorkItemSummary } from '../../src/shared/work'
import { AdoError, type AdoHttp } from './http'
import { shaped } from './shape'

export type { MoveTarget }

export interface PatchOp {
  op: 'test' | 'replace'
  path: string
  value: unknown
}

const STATE_PATH = '/fields/System.State'
const CONFLICT_MESSAGE = "Someone else changed this item. It's been refreshed; try again."
const COLUMN_MISSING = "That column isn't on this board."
const LANE_MISSING = "That lane isn't on this board."
const UNMAPPED_TYPE = "This item type isn't on the board. Move it by state instead."
const MOVE_BY_COLUMN = 'Move this item by column.'
const INCOMPLETE_CONFIG = "This board's configuration is incomplete. Try refreshing."
const MALFORMED_MESSAGE = 'Azure DevOps returned an unexpected work item response.'

export function targetsFor(item: WorkItemSummary, cfg: BoardConfig): { columns: string[]; lanes: string[]; states: string[] } {
  if (!isMapped(item, cfg)) return { columns: [], lanes: [], states: [] }
  return {
    columns: cfg.columns.filter(column => mapsType(column, item)).map(column => column.name),
    lanes: cfg.lanes.map(lane => lane.name),
    states: []
  }
}

export function stateTargets(allStates: string[], current: string): string[] {
  return allStates.filter(state => state !== current)
}

export function buildMovePatch(item: WorkItemSummary, cfg: BoardConfig, to: MoveTarget): PatchOp[] {
  const changes = isMapped(item, cfg) ? boardChanges(item, cfg, to) : stateChanges(item, to)
  return changes.length === 0 ? [] : [{ op: 'test', path: '/rev', value: item.rev }, ...changes]
}

export async function moveItem(
  http: AdoHttp,
  org: string,
  projectId: string,
  item: WorkItemSummary,
  cfg: BoardConfig,
  to: MoveTarget
): Promise<number> {
  const patch = buildMovePatch(item, cfg, to)
  if (patch.length === 0) return item.rev
  const data = await sendPatch(http, org, projectId, item.id, patch)
  return shaped(() => readRev(data), MALFORMED_MESSAGE)
}

async function sendPatch(http: AdoHttp, org: string, projectId: string, id: number, patch: PatchOp[]): Promise<{ rev?: unknown } | undefined> {
  try {
    const { data } = await http.json<{ rev?: unknown } | undefined>({
      org,
      project: projectId,
      path: `/_apis/wit/workitems/${id}`,
      method: 'PATCH',
      body: patch,
      contentType: 'application/json-patch+json'
    })
    return data
  } catch (error) {
    throw isStaleEdit(error) ? new AdoError('conflict', 409, CONFLICT_MESSAGE) : error
  }
}

function isStaleEdit(error: unknown): boolean {
  return error instanceof AdoError && (error.code === 'precondition_failed' || error.code === 'conflict')
}

function readRev(data: { rev?: unknown } | undefined): number {
  const rev = data?.rev
  if (typeof rev !== 'number') throw new TypeError('expected a revision')
  return rev
}

function boardChanges(item: WorkItemSummary, cfg: BoardConfig, to: MoveTarget): PatchOp[] {
  if (to.state !== undefined) throw badRequest(MOVE_BY_COLUMN)
  return [
    ...(to.column === undefined ? [] : columnChanges(item, cfg, to.column)),
    ...(to.lane === undefined ? [] : laneChanges(item, cfg, to.lane))
  ]
}

function stateChanges(item: WorkItemSummary, to: MoveTarget): PatchOp[] {
  if (to.column !== undefined || to.lane !== undefined) throw badRequest(UNMAPPED_TYPE)
  return to.state === undefined || to.state === item.state ? [] : [replace(STATE_PATH, to.state)]
}

function columnChanges(item: WorkItemSummary, cfg: BoardConfig, name: string): PatchOp[] {
  const column = cfg.columns.find(candidate => candidate.name === name && mapsType(candidate, item))
  if (!column) throw badRequest(COLUMN_MISSING)
  if (item.column === column.name) return []
  const state = column.stateMappings[item.type]
  return [
    ...(state === item.state ? [] : [replace(STATE_PATH, state)]),
    replace(fieldPath(cfg.fields.column), column.name),
    ...(column.isSplit || item.columnDone ? [replace(fieldPath(cfg.fields.columnDone), false)] : [])
  ]
}

function laneChanges(item: WorkItemSummary, cfg: BoardConfig, name: string): PatchOp[] {
  if (!cfg.lanes.some(lane => lane.name === name)) throw badRequest(LANE_MISSING)
  return name === (item.lane ?? '') ? [] : [replace(fieldPath(cfg.fields.lane), name)]
}

function isMapped(item: WorkItemSummary, cfg: BoardConfig): boolean {
  return cfg.columns.some(column => mapsType(column, item))
}

function mapsType(column: BoardConfig['columns'][number], item: WorkItemSummary): boolean {
  return Object.hasOwn(column.stateMappings, item.type)
}

function fieldPath(referenceName: string): string {
  if (!referenceName) throw badRequest(INCOMPLETE_CONFIG)
  return `/fields/${referenceName}`
}

function replace(path: string, value: unknown): PatchOp {
  return { op: 'replace', path, value }
}

function badRequest(message: string): AdoError {
  return new AdoError('bad_request', 400, message)
}
