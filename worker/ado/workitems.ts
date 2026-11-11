import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import type { ItemRecord } from '../data/records'
import { MALFORMED } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { expectList, expectText, shaped } from './shape'

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
export const KEPT_FIELDS: ReadonlySet<string> = new Set([
  'System.Id',
  'System.TeamProject',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AssignedTo',
  'System.Parent',
  'System.ChangedDate',
  'System.AreaPath'
])
const REV_FIELDS: readonly string[] = ['System.Id']
const KANBAN_FIELD = /^WEF_[0-9A-Fa-f]+_Kanban\./
const CHILD_URL = /\/workItems\/(\d+)$/
const IN_PROJECT = '[System.TeamProject] = @project'

export interface IdsAt { ids: number[]; asOf: string }

export function mineClause(allDoneStates: string[]): string {
  return clauses(['[System.AssignedTo] = @Me', notIn('[System.State]', allDoneStates)])
}

export function boardClause(cfg: BoardConfig, everyone: boolean): string {
  const doneClause = notIn('[System.State]', Object.values(cfg.doneStates).flat())
  return clauses([
    `[System.WorkItemType] IN (${list(cfg.requirementTypes)})`,
    areaClause(cfg.areaPaths),
    everyone ? undefined : '[System.AssignedTo] = @Me',
    doneClause && `(${doneClause} OR [System.ChangedDate] >= @Today - 14)`
  ])
}

export function membershipWiql(clause: string): string {
  return select([IN_PROJECT, clause])
}

export function wiqlMine(_cfg: BoardConfig, allDoneStates: string[]): string {
  return membershipWiql(mineClause(allDoneStates))
}

export function wiqlBoard(cfg: BoardConfig, everyone: boolean): string {
  return membershipWiql(boardClause(cfg, everyone))
}

export function deltaWiql(clause: string, since: string, known: readonly number[]): string {
  const outside = known.length === 0 ? '' : ` OR [System.Id] IN (${known.join(', ')})`
  return select([`[System.ChangedDate] >= ${since}`, `((${IN_PROJECT} AND (${clause}))${outside})`])
}

export function stillInWiql(clause: string, ids: readonly number[]): string {
  return `SELECT [System.Id] FROM WorkItems WHERE ${IN_PROJECT} AND (${clause}) AND [System.Id] IN (${ids.join(', ')})`
}

export async function queryIdsAt(http: AdoHttp, org: string, projectId: string, teamId: string, wiql: string, timePrecision: boolean): Promise<IdsAt> {
  const { data } = await http.json<{ workItems: { id: number }[]; asOf: unknown }>({
    org,
    project: projectId,
    path: `/${encodeURIComponent(teamId)}/_apis/wit/wiql`,
    method: 'POST',
    query: { $top: WIQL_TOP, timePrecision: timePrecision || undefined },
    body: { query: wiql }
  })
  return shape(() => ({ ids: expectList<{ id: number }>(data.workItems).map(item => item.id), asOf: serverTime(data.asOf) }))
}

export async function readRevs(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<Map<number, number>> {
  const found = await readFields(http, org, projectId, ids, REV_FIELDS)
  return new Map(found.map(raw => [raw.id, raw.rev]))
}

export function isDatePrecisionError(error: unknown): boolean {
  return error instanceof AdoError && error.code === 'bad_request' && /date precision/i.test(error.message)
}

export function toRecord(raw: RawWorkItem, withRelations: boolean): ItemRecord {
  const fields = Object.fromEntries(Object.entries(raw.fields).filter(([name]) => KEPT_FIELDS.has(name) || KANBAN_FIELD.test(name)))
  const relations: unknown = raw.relations
  const links = withRelations && Array.isArray(relations) ? relations.flatMap(link => (isKeptLink(link) ? [{ rel: link.rel, url: link.url }] : [])) : undefined
  return { id: raw.id, rev: raw.rev, url: raw.url, fields, ...(links ? { relations: links } : {}), withRelations }
}

function isKeptLink(link: unknown): link is { rel: string; url: string } {
  if (typeof link !== 'object' || link === null) return false
  const { rel, url } = link as { rel?: unknown; url?: unknown }
  return typeof url === 'string' && (rel === CHILD_LINK || (rel === 'ArtifactLink' && url.startsWith(PR_ARTIFACT_PREFIX)))
}

function serverTime(value: unknown): string {
  const text = expectText(value)
  if (Number.isNaN(Date.parse(text))) throw new TypeError('expected a date')
  return text
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

function select(conditions: string[]): string {
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses(conditions)} ORDER BY [System.ChangedDate] DESC`
}

function clauses(conditions: (string | undefined)[]): string {
  return conditions.filter(Boolean).join(' AND ')
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
