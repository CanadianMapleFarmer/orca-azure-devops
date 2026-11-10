import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { expectList, shaped } from './shape'

export interface RawWorkItem {
  id: number
  rev: number
  fields: Record<string, unknown>
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[]
  url: string
}

export interface PrRef { projectId: string; repoId: string; prId: number }

export const WIQL_TOP = 500
const BATCH_SIZE = 200
export const PR_ARTIFACT_PREFIX = 'vstfs:///Git/PullRequestId/'
export const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward'
export const TASK_FIELDS: readonly string[] = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo', 'System.Parent']
const CHILD_URL = /\/workItems\/(\d+)$/

export function wiqlMine(_cfg: BoardConfig, allDoneStates: string[]): string {
  return select([
    '[System.TeamProject] = @project',
    '[System.AssignedTo] = @Me',
    notIn('[System.State]', allDoneStates)
  ])
}

export function wiqlBoard(cfg: BoardConfig, everyone: boolean): string {
  const doneStates = Object.values(cfg.doneStates).flat()
  const doneClause = notIn('[System.State]', doneStates)
  return select([
    '[System.TeamProject] = @project',
    `[System.WorkItemType] IN (${list(cfg.requirementTypes)})`,
    areaClause(cfg.areaPaths),
    everyone ? undefined : '[System.AssignedTo] = @Me',
    doneClause && `(${doneClause} OR [System.ChangedDate] >= @Today - 14)`
  ])
}

export async function queryIds(http: AdoHttp, org: string, projectId: string, teamId: string, wiql: string): Promise<number[]> {
  const { data } = await http.json<{ workItems: { id: number }[] }>({
    org,
    project: projectId,
    path: `/${encodeURIComponent(teamId)}/_apis/wit/wiql`,
    method: 'POST',
    query: { $top: WIQL_TOP },
    body: { query: wiql }
  })
  return shape(() => expectList<{ id: number }>(data.workItems).map(item => item.id))
}

export async function queryBoardIds(
  http: AdoHttp,
  org: string,
  projectId: string,
  teamId: string,
  cfg: BoardConfig,
  everyone: boolean
): Promise<number[]> {
  if (cfg.requirementTypes.length === 0) return []
  return queryIds(http, org, projectId, teamId, wiqlBoard(cfg, everyone))
}

export function hydrate(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<RawWorkItem[]> {
  return readBatches(http, org, projectId, ids, batch => ({ ids: batch, $expand: 'relations', errorPolicy: 'omit' }))
}

export function readFields(http: AdoHttp, org: string, projectId: string, ids: number[], fields: readonly string[]): Promise<RawWorkItem[]> {
  return readBatches(http, org, projectId, ids, batch => ({ ids: batch, fields, errorPolicy: 'omit' }))
}

async function readBatches(http: AdoHttp, org: string, projectId: string, ids: number[], body: (batch: number[]) => object): Promise<RawWorkItem[]> {
  const found = new Map<number, RawWorkItem>()
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const { data } = await http.json<{ value: (RawWorkItem | null)[] }>({
      org,
      project: projectId,
      path: '/_apis/wit/workitemsbatch',
      method: 'POST',
      body: body(ids.slice(start, start + BATCH_SIZE))
    })
    for (const item of shape(() => expectList<RawWorkItem | null>(data.value))) {
      if (item) found.set(item.id, item)
    }
  }
  return ids.flatMap(id => found.get(id) ?? [])
}

export function childIdsOf(raw: RawWorkItem): number[] {
  const relations: unknown = raw.relations
  if (!Array.isArray(relations)) return []
  return relations.flatMap(link => (link?.rel === CHILD_LINK ? (childId(link.url) ?? []) : []))
}

function childId(url: unknown): number | null {
  const match = typeof url === 'string' ? CHILD_URL.exec(url) : null
  const id = match ? Number(match[1]) : 0
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function toSummary(raw: RawWorkItem, cfg: BoardConfig, orgUrl: string): Omit<WorkItemSummary, 'prs' | 'parentTitle' | 'targets'> & { prRefs: PrRef[] } {
  const { fields } = raw
  const project = textOr(fields['System.TeamProject'], '') || cfg.projectId
  return {
    org: cfg.org,
    id: raw.id,
    rev: raw.rev,
    type: textOr(fields['System.WorkItemType'], ''),
    title: textOr(fields['System.Title'], ''),
    state: textOr(fields['System.State'], ''),
    column: textOr(fields[cfg.fields.column], null),
    columnDone: fields[cfg.fields.columnDone] === true,
    lane: textOr(fields[cfg.fields.lane], null),
    assignedTo: displayName(fields['System.AssignedTo']),
    parentId: typeof fields['System.Parent'] === 'number' ? fields['System.Parent'] : null,
    changedAt: timestamp(fields['System.ChangedDate']),
    url: workItemUrl(orgUrl, project, raw.id),
    prRefs: (raw.relations ?? []).filter(link => link.rel === 'ArtifactLink').flatMap(link => parsePrRef(link.url) ?? [])
  }
}

export function parsePrRef(artifactUrl: string): PrRef | null {
  if (!artifactUrl.startsWith(PR_ARTIFACT_PREFIX)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(artifactUrl.slice(PR_ARTIFACT_PREFIX.length))
  } catch {
    return null
  }
  const parts = decoded.split('/')
  if (parts.length !== 3) return null
  const [projectId, repoId, id] = parts
  const prId = Number(id)
  if (!projectId || !repoId || !/^\d+$/.test(id) || !Number.isSafeInteger(prId) || prId < 1) return null
  return { projectId, repoId, prId }
}

export function workItemUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`
}

function select(conditions: (string | undefined)[]): string {
  const where = conditions.filter(Boolean).join(' AND ')
  return `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`
}

function notIn(field: string, values: string[]): string | undefined {
  return values.length === 0 ? undefined : `${field} NOT IN (${list(values)})`
}

function areaClause(areas: BoardConfig['areaPaths']): string | undefined {
  if (areas.length === 0) return undefined
  const clauses = areas.map(({ value, includeChildren }) => `[System.AreaPath] ${includeChildren ? 'UNDER' : '='} ${quote(value)}`)
  return `(${clauses.join(' OR ')})`
}

function list(values: string[]): string {
  return [...new Set(values)].map(quote).join(', ')
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function textOr<F>(value: unknown, fallback: F): string | F {
  return typeof value === 'string' ? value : fallback
}

export function displayName(identity: unknown): string | null {
  if (typeof identity !== 'object' || identity === null) return null
  return textOr((identity as { displayName?: unknown }).displayName, null)
}

export function timestamp(value: unknown): number {
  const ms = Date.parse(textOr(value, ''))
  return Number.isNaN(ms) ? 0 : ms
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.workItem)
}
