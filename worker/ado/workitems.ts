import type { BoardConfig, WorkItemSummary } from '../../src/shared/work'
import { AdoError, type AdoHttp } from './http'

export interface RawWorkItem {
  id: number
  rev: number
  fields: Record<string, unknown>
  relations?: { rel: string; url: string; attributes?: Record<string, unknown> }[]
  url: string
}

export interface PrRef { projectId: string; repoId: string; prId: number }

const WIQL_TOP = 500
const BATCH_SIZE = 200
const PR_ARTIFACT_PREFIX = 'vstfs:///Git/PullRequestId/'
const MALFORMED_MESSAGE = 'Azure DevOps returned an unexpected work item response.'

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
  return shape(() => array(data.workItems).map(item => item.id))
}

export async function hydrate(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<RawWorkItem[]> {
  const found = new Map<number, RawWorkItem>()
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const { data } = await http.json<{ value: RawWorkItem[] }>({
      org,
      project: projectId,
      path: '/_apis/wit/workitemsbatch',
      method: 'POST',
      body: { ids: ids.slice(start, start + BATCH_SIZE), $expand: 'relations' }
    })
    for (const item of shape(() => array(data.value))) found.set(item.id, item)
  }
  return ids.flatMap(id => found.get(id) ?? [])
}

export function toSummary(raw: RawWorkItem, cfg: BoardConfig, orgUrl: string): Omit<WorkItemSummary, 'prs' | 'parentTitle' | 'targets'> & { prRefs: PrRef[] } {
  const { fields } = raw
  const project = text(fields['System.TeamProject']) || cfg.projectId
  return {
    org: cfg.org,
    id: raw.id,
    rev: raw.rev,
    type: text(fields['System.WorkItemType']),
    title: text(fields['System.Title']),
    state: text(fields['System.State']),
    column: optionalText(fields[cfg.fields.column]),
    columnDone: fields[cfg.fields.columnDone] === true,
    lane: optionalText(fields[cfg.fields.lane]),
    assignedTo: displayName(fields['System.AssignedTo']),
    parentId: typeof fields['System.Parent'] === 'number' ? fields['System.Parent'] : null,
    changedAt: timestamp(fields['System.ChangedDate']),
    url: `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${raw.id}`,
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function displayName(identity: unknown): string | null {
  if (typeof identity !== 'object' || identity === null) return null
  return optionalText((identity as { displayName?: unknown }).displayName)
}

function timestamp(value: unknown): number {
  const ms = Date.parse(text(value))
  return Number.isNaN(ms) ? 0 : ms
}

function array<T>(value: T[]): T[] {
  if (!Array.isArray(value)) throw new TypeError('expected a list')
  return value
}

function shape<T>(build: () => T): T {
  try {
    return build()
  } catch {
    throw new AdoError('server', 200, MALFORMED_MESSAGE)
  }
}
