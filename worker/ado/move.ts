import type { BoardConfig, MoveTarget, WorkItemSummary } from '../../src/shared/work'
import { badRequest, INCOMPLETE_CONFIG, MOVE_BY_COLUMN, UNKNOWN_COLUMN, UNKNOWN_LANE, UNMAPPED_TYPE } from '../messages'
import type { AdoHttp } from './http'
import { patchWorkItem, type PatchOp } from './patch'

export type { MoveTarget }

const STATE_PATH = '/fields/System.State'

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
  return patchWorkItem(http, org, projectId, item.id, patch)
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
  if (!column) throw badRequest(UNKNOWN_COLUMN)
  if (item.column === column.name) return []
  const state = column.stateMappings[item.type]
  return [
    ...(state === item.state ? [] : [replace(STATE_PATH, state)]),
    replace(fieldPath(cfg.fields.column), column.name),
    ...(column.isSplit || item.columnDone ? [replace(fieldPath(cfg.fields.columnDone), false)] : [])
  ]
}

function laneChanges(item: WorkItemSummary, cfg: BoardConfig, name: string): PatchOp[] {
  if (!cfg.lanes.some(lane => lane.name === name)) throw badRequest(UNKNOWN_LANE)
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
