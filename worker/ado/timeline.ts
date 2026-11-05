import { fileRefOf } from '../../src/shared/file-ref'
import {
  MAX_LINE_CHARS,
  type Failure,
  type FileRef,
  type Issue,
  type JobView,
  type StageChip,
  type StageView,
  type StepState,
  type StepView
} from '../../src/shared/pipelines'
import { ALL_JOBS_STAGE, MALFORMED } from '../messages'
import { optionalTimestamp } from './builds'
import { cutText } from './cut-text'
import type { AdoHttp } from './http'
import { expectList, expectText, shaped } from './shape'

export interface RawIssue {
  type?: string
  message?: string
  data?: Record<string, string>
}

export interface RawRecord {
  id: string
  parentId?: string | null
  type: string
  name: string
  identifier?: string | null
  order?: number
  state?: string
  result?: string | null
  startTime?: string | null
  finishTime?: string | null
  log?: { id: number } | null
  errorCount?: number
  warningCount?: number
  issues?: RawIssue[] | null
  attempt?: number
  changeId?: number
}

export interface RawTimeline {
  changeId: number
  records: RawRecord[]
}

type ChildIndex = ReadonlyMap<string, RawRecord[]>
type ReportableIssue = RawIssue & { type: 'error' | 'warning'; message: string }

const STAGE = 'Stage'
const JOB = 'Job'
const TASK = 'Task'
const CHECKPOINT = 'Checkpoint'
const APPROVAL = 'Checkpoint.Approval'
const RUN_STAGE_ID = '__run'
const PATH_SEPARATOR = ' › '
const MAX_ISSUES = 10
const MAX_MESSAGE_CHARS = 2000
const DIGITS = /^\d{1,9}$/
const NO_LOGS: ReadonlyMap<number, number> = new Map()

export async function getTimeline(
  http: AdoHttp,
  org: string,
  projectId: string,
  buildId: number,
  changeId?: number,
  signal?: AbortSignal
): Promise<RawTimeline | null> {
  const { data } = await http.json<RawTimeline | undefined>({
    org,
    project: projectId,
    path: `/_apis/build/builds/${buildId}/timeline`,
    query: { changeId },
    signal
  })
  return data === undefined ? null : shaped(() => expectTimeline(data), MALFORMED.timeline)
}

export function mergeTimeline(previous: RawTimeline | null, next: RawTimeline | null): RawTimeline {
  if (next === null) return previous ?? { changeId: 0, records: [] }
  if (previous !== null && next.changeId < previous.changeId) return previous
  const merged = new Map<string, RawRecord>()
  for (const record of previous?.records ?? []) merged.set(record.id, record)
  for (const record of next.records) merged.set(record.id, record)
  return { changeId: next.changeId, records: [...merged.values()].sort(compareRecords) }
}

export function stepStateOf(record: RawRecord, descendants: readonly RawRecord[] = []): StepState {
  if (record.type === STAGE && record.state !== 'completed' && pendingApproval(descendants)) return 'waiting'
  switch (record.state) {
    case 'inProgress':
      return 'running'
    case 'completed':
      return resultState(record.result)
    default:
      return 'pending'
  }
}

export function stageChips(timeline: RawTimeline): StageChip[] {
  return runStages(timeline, NO_LOGS, false).map(({ id, name, state }) => ({ id, name, state }))
}

export function runStages(timeline: RawTimeline, logLines: ReadonlyMap<number, number>, runActive: boolean): StageView[] {
  const index = childIndex(timeline.records)
  const stages = timeline.records.filter(record => record.type === STAGE).sort(compareRecords)
  if (stages.length > 0) return stages.map(stage => stageView(stage, index, logLines, runActive))
  return syntheticStage(rootsOf(timeline.records), index, logLines)
}

export function failuresOf(stages: readonly StageView[]): Failure[] {
  return stages.flatMap(stage => stage.jobs.flatMap(job => jobFailures(stage, job)))
}

export function approvalPlaceOf(
  timeline: RawTimeline,
  approvalId: string
): { stageId: string; stage: string; checkSuiteId: string | null } | null {
  const wanted = approvalId.toLowerCase()
  const approval = timeline.records.find(record => record.type === APPROVAL && record.id.toLowerCase() === wanted)
  if (!approval) return null
  const byId = new Map(timeline.records.map(record => [record.id, record] as const))
  const stage = stageAbove(approval, byId)
  if (!stage) return null
  const parent = typeof approval.parentId === 'string' ? byId.get(approval.parentId) : undefined
  return { stageId: stage.id, stage: stage.name, checkSuiteId: parent?.type === CHECKPOINT ? parent.id : null }
}

function expectTimeline(value: unknown): RawTimeline {
  const { changeId, records } = value as Partial<RawTimeline>
  if (typeof changeId !== 'number' || !Number.isFinite(changeId)) throw new TypeError('expected a change id')
  const ids = new Set<string>()
  const list = expectList<RawRecord>(records)
  for (const record of list) {
    expectText(record.type)
    expectText(record.name)
    const id = expectText(record.id)
    if (ids.has(id)) throw new TypeError('expected unique record ids')
    ids.add(id)
  }
  expectNoParentLoop(list)
  return { changeId, records: list }
}

function expectNoParentLoop(records: readonly RawRecord[]): void {
  const parentOf = new Map(records.map(record => [record.id, record.parentId] as const))
  const acyclic = new Set<string>()
  for (const record of records) {
    const walked = new Set<string>()
    let id: unknown = record.id
    while (typeof id === 'string' && parentOf.has(id) && !acyclic.has(id)) {
      if (walked.has(id)) throw new TypeError('expected no parent loops')
      walked.add(id)
      id = parentOf.get(id)
    }
    for (const seen of walked) acyclic.add(seen)
  }
}

function compareRecords(a: RawRecord, b: RawRecord): number {
  return (a.order ?? 0) - (b.order ?? 0) || compareText(a.name, b.name) || compareText(a.id, b.id)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function childIndex(records: readonly RawRecord[]): ChildIndex {
  const index = new Map<string, RawRecord[]>()
  for (const record of [...records].sort(compareRecords)) {
    if (typeof record.parentId !== 'string') continue
    const siblings = index.get(record.parentId)
    if (siblings) siblings.push(record)
    else index.set(record.parentId, [record])
  }
  return index
}

function rootsOf(records: readonly RawRecord[]): RawRecord[] {
  const ids = new Set(records.map(record => record.id))
  return records.filter(record => typeof record.parentId !== 'string' || !ids.has(record.parentId)).sort(compareRecords)
}

function descendantsOf(record: RawRecord, index: ChildIndex): RawRecord[] {
  return (index.get(record.id) ?? []).flatMap(child => [child, ...descendantsOf(child, index)])
}

function jobRecordsUnder(siblings: readonly RawRecord[], index: ChildIndex): RawRecord[] {
  return siblings.flatMap(record => {
    if (record.type === JOB) return [record]
    return record.type === TASK ? [] : jobRecordsUnder(index.get(record.id) ?? [], index)
  })
}

function stageAbove(record: RawRecord, byId: ReadonlyMap<string, RawRecord>): RawRecord | null {
  let current: RawRecord | undefined = record
  for (let hops = 0; current && hops <= byId.size; hops += 1) {
    if (current.type === STAGE) return current
    current = typeof current.parentId === 'string' ? byId.get(current.parentId) : undefined
  }
  return null
}

function pendingApproval(descendants: readonly RawRecord[]): RawRecord | undefined {
  return descendants.find(record => record.type === APPROVAL && record.state === 'inProgress')
}

function resultState(result: string | null | undefined): StepState {
  switch (result) {
    case 'succeeded':
      return 'succeeded'
    case 'succeededWithIssues':
      return 'warning'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'abandoned':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    default:
      return 'warning'
  }
}

function stageView(stage: RawRecord, index: ChildIndex, logLines: ReadonlyMap<number, number>, runActive: boolean): StageView {
  const descendants = descendantsOf(stage, index)
  const state = stepStateOf(stage, descendants)
  const identifier = identifierOf(stage)
  return {
    id: stage.id,
    identifier,
    name: stage.name,
    state,
    startedAt: optionalTimestamp(stage.startTime),
    finishedAt: optionalTimestamp(stage.finishTime),
    attempt: attemptOf(stage),
    jobs: jobRecordsUnder(index.get(stage.id) ?? [], index).map(job => jobView(job, index, logLines)),
    canRetry: !runActive && identifier !== null && (state === 'failed' || state === 'canceled'),
    approvalId: state === 'waiting' ? (pendingApproval(descendants)?.id ?? null) : null
  }
}

function syntheticStage(roots: readonly RawRecord[], index: ChildIndex, logLines: ReadonlyMap<number, number>): StageView[] {
  const jobs = jobRecordsUnder(roots, index).map(job => jobView(job, index, logLines))
  if (jobs.length === 0) return []
  const state = rollupState(jobs.map(job => job.state))
  const unfinished = state === 'running' || state === 'pending'
  return [
    {
      id: RUN_STAGE_ID,
      identifier: null,
      name: ALL_JOBS_STAGE,
      state,
      startedAt: extreme(Math.min, jobs.map(job => job.startedAt)),
      finishedAt: unfinished ? null : extreme(Math.max, jobs.map(job => job.finishedAt)),
      attempt: 1,
      jobs,
      canRetry: false,
      approvalId: null
    }
  ]
}

function rollupState(states: readonly StepState[]): StepState {
  if (states.includes('running')) return 'running'
  if (states.includes('failed')) return 'failed'
  if (states.includes('canceled')) return 'canceled'
  if (states.includes('pending')) return states.every(state => state === 'pending') ? 'pending' : 'running'
  if (states.includes('warning')) return 'warning'
  return states.every(state => state === 'skipped') ? 'skipped' : 'succeeded'
}

function extreme(pick: (...values: number[]) => number, times: readonly (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null)
  return known.length > 0 ? pick(...known) : null
}

function jobView(job: RawRecord, index: ChildIndex, logLines: ReadonlyMap<number, number>): JobView {
  return {
    id: job.id,
    name: job.name,
    state: stepStateOf(job),
    startedAt: optionalTimestamp(job.startTime),
    finishedAt: optionalTimestamp(job.finishTime),
    logId: logIdOf(job),
    issues: issuesOf(job.issues),
    steps: (index.get(job.id) ?? []).filter(child => child.type === TASK).map(task => stepView(task, logLines))
  }
}

function stepView(task: RawRecord, logLines: ReadonlyMap<number, number>): StepView {
  const logId = logIdOf(task)
  return {
    id: task.id,
    name: task.name,
    state: stepStateOf(task),
    startedAt: optionalTimestamp(task.startTime),
    finishedAt: optionalTimestamp(task.finishTime),
    logId,
    logLines: logId === null ? null : (logLines.get(logId) ?? null),
    errorCount: countOf(task.errorCount),
    warningCount: countOf(task.warningCount),
    issues: issuesOf(task.issues)
  }
}

function jobFailures(stage: StageView, job: JobView): Failure[] {
  const failedSteps = job.steps.filter(step => step.state === 'failed')
  if (failedSteps.length > 0) {
    return failedSteps.map(step => ({
      stageId: stage.id,
      jobId: job.id,
      stepId: step.id,
      path: [stage.name, job.name, step.name].join(PATH_SEPARATOR),
      issues: step.issues,
      logId: step.logId
    }))
  }
  if (job.state !== 'failed') return []
  return [{ stageId: stage.id, jobId: job.id, stepId: job.id, path: [stage.name, job.name].join(PATH_SEPARATOR), issues: job.issues, logId: job.logId }]
}

function issuesOf(raw: unknown): Issue[] {
  if (!Array.isArray(raw)) return []
  const reportable = raw.filter(isReportable)
  const errors = reportable.filter(issue => issue.type === 'error')
  const warnings = reportable.filter(issue => issue.type === 'warning')
  return [...errors, ...warnings].slice(0, MAX_ISSUES).map(toIssue)
}

function isReportable(issue: unknown): issue is ReportableIssue {
  if (typeof issue !== 'object' || issue === null) return false
  const { type, message } = issue as RawIssue
  return (type === 'error' || type === 'warning') && typeof message === 'string'
}

function toIssue(raw: ReportableIssue): Issue {
  const message = cutText(raw.message, MAX_MESSAGE_CHARS)
  return { type: raw.type, message, file: sourceFileOf(raw.data) ?? fileRefOf(message) }
}

function sourceFileOf(data: unknown): FileRef | null {
  if (typeof data !== 'object' || data === null) return null
  const { sourcepath, linenumber, columnnumber } = data as Record<string, unknown>
  if (typeof sourcepath !== 'string' || sourcepath.trim() === '' || sourcepath.length > MAX_LINE_CHARS) return null
  return { path: sourcepath, line: positionOf(linenumber), column: positionOf(columnnumber) }
}

function positionOf(value: unknown): number | null {
  const position = typeof value === 'string' && DIGITS.test(value) ? Number(value) : 0
  return position > 0 ? position : null
}

function identifierOf(record: RawRecord): string | null {
  return typeof record.identifier === 'string' && record.identifier !== '' ? record.identifier : null
}

function logIdOf(record: RawRecord): number | null {
  const id = record.log?.id
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null
}

function attemptOf(record: RawRecord): number {
  const { attempt } = record
  return typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}
