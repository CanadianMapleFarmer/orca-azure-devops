import {
  LOG_FIRST_LINE,
  MAX_LOG_LINES,
  type ApprovalSummary,
  type Issue,
  type LogChunk,
  type RunKey,
  type RunView,
  type StageChip,
  type StageView
} from '../../src/shared/pipelines'
import { cancellableStatus, finishedStatus, isBuildId } from '../../src/shared/runs'
import type { OrgStatus } from '../../src/shared/types'
import { linkedAbort, untilAborted } from '../abort'
import { getApprovals, toApprovalSummary, type RawApproval } from '../ado/approvals'
import { getLogLines, listLogs } from '../ado/build-logs'
import { getBuild, toRunSummary, type RawBuild } from '../ado/builds'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { isMalformed } from '../ado/shape'
import { failuresOf, getTimeline, mergeTimeline, runStages, type RawTimeline } from '../ado/timeline'
import { byteLength, itemBytes } from '../budget'
import {
  APPROVAL_ENVIRONMENTS_UNREAD,
  APPROVALS_NEED_ACCESS,
  APPROVALS_UNREADABLE,
  BAD_RUN,
  badRequest,
  failureMessage,
  joinMessages,
  RUN_CUT,
  RUN_GONE,
  RUN_TRIMMED,
  RUNS_LOAD_FAILED
} from '../messages'
import { isSignedIn, loadFailure, notConnected, type SignedInStatus } from '../org-status'
import type { Scheduler } from '../poll/scheduler'
import { placeApproval, placeIsUnsettled, placeKey, waitingIf, type ApprovalPlace } from './load'
import type { Pressure } from './pressure'

export interface RunViewsDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  scheduler: Scheduler
  pressure: Pressure
  watched: (org: string, buildId: number) => boolean
  changed: (change: { org: string; buildId: number }) => void
  now: () => number
}

export interface RunViews {
  onOrgs(orgs: OrgStatus[]): void
  view(input: { org: string; projectId: string; buildId: number }): Promise<RunView>
  log(input: { org: string; projectId: string; buildId: number; logId: number; first?: number }): Promise<LogChunk>
  setVisible(input: { org: string; visible: boolean; run?: RunKey }): { ok: true }
  refreshNow(org: string, buildId: number): void
  dispose(): void
}

interface RunTarget extends RunKey {
  org: string
}

interface OrgScope {
  controller: AbortController
  http: AdoHttp
}

interface Reads {
  build: RawBuild
  timeline: RawTimeline
  logLines: ReadonlyMap<number, number>
  approvals: ApprovalSummary[]
  notes: string | undefined
}

interface Held extends RunTarget {
  key: string
  reads: Reads | null
  places: Map<string, ApprovalPlace>
  view: RunView | null
  at: number
  generation: number
  loading: { generation: number; promise: Promise<Loaded> } | null
}

interface Loaded {
  view: RunView | null
  changed: boolean
  failure: unknown
}

const ACTIVE_MS = { visibleMs: 5_000, backgroundMs: 5_000 }
const SLOWED_MS = { visibleMs: 30_000, backgroundMs: 30_000 }
const FINISHED_MS = { visibleMs: 60_000, backgroundMs: 60_000 }
const FRESH_MS = 5_000
const MAX_CACHED_VIEWS = 10
const IN_FLIGHT = 4
const ANSWER_BUDGET_BYTES = 900 * 1024
const TRIMMED_ISSUES = 3
const ISSUE_LIMITS = [Infinity, TRIMMED_ISSUES, 0]
const MAX_RECORDS = 2_000
const PENDING = 'pending'
const IN_PROGRESS = 'inProgress'

export function createRunViews(deps: RunViewsDeps): RunViews {
  const { scheduler, now } = deps
  const scopes = new Map<string, OrgScope>()
  const views = new Map<string, Held>()
  const shown = new Map<string, RunTarget>()
  const connected = new Set<string>()
  let disposed = false

  async function statusOf(org: string): Promise<SignedInStatus> {
    const orgs = await deps.orgs().catch(error => {
      throw loadFailure(error, RUNS_LOAD_FAILED)
    })
    const status = orgs.find(item => item.org === org)
    if (disposed || !status || !isSignedIn(status)) throw notConnected()
    return status
  }

  function scopeOf(org: string): OrgScope {
    const existing = scopes.get(org)
    if (existing) return existing
    const scope = { controller: new AbortController(), http: deps.pressure.wrap(deps.http, org) }
    scopes.set(org, scope)
    return scope
  }

  function forget(org: string): void {
    scopes.get(org)?.controller.abort()
    scopes.delete(org)
    for (const held of [...views.values()]) if (held.org === org) views.delete(held.key)
  }

  function hold(target: RunTarget): Held {
    const key = viewKey(target.org, target.buildId)
    const existing = views.get(key)
    views.delete(key)
    const held: Held =
      existing && existing.projectId === target.projectId
        ? existing
        : { ...target, key, reads: null, places: new Map(), view: null, at: -Infinity, generation: 0, loading: null }
    views.set(key, held)
    evict()
    return held
  }

  function evict(): void {
    for (const key of views.keys()) {
      if (views.size <= MAX_CACHED_VIEWS) return
      if (!shown.has(key)) views.delete(key)
    }
  }

  function fresh(held: Held): held is Held & { view: RunView } {
    return held.view !== null && now() - held.at < FRESH_MS
  }

  function intervalsOf(target: RunTarget) {
    const build = views.get(viewKey(target.org, target.buildId))?.reads?.build
    if (build && finishedStatus(build.status)) return FINISHED_MS
    return deps.pressure.slowed(target.org) ? SLOWED_MS : ACTIVE_MS
  }

  function sync(key: string): void {
    const target = shown.get(key)
    if (!target || !connected.has(target.org)) {
      scheduler.remove(key)
      return
    }
    scheduler.upsert({ key, ...intervalsOf(target), run: signal => poll(target, signal) })
  }

  async function poll(target: RunTarget, signal: AbortSignal): Promise<void> {
    try {
      const failure = await untilAborted(reload(target), signal)
      if (failure) throw failure
    } finally {
      if (!signal.aborted) sync(viewKey(target.org, target.buildId))
    }
  }

  async function reload(target: RunTarget): Promise<unknown> {
    const held = hold(target)
    if (fresh(held)) return null
    try {
      const loaded = await load(held)
      if (loaded.changed && connected.has(held.org)) deps.changed({ org: held.org, buildId: held.buildId })
      return loaded.failure
    } catch (error) {
      return error
    }
  }

  function load(held: Held): Promise<Loaded> {
    const current = held.loading
    if (current && current.generation === held.generation) return current.promise
    const loading = { generation: held.generation, promise: run() }
    held.loading = loading
    return loading.promise

    async function run(): Promise<Loaded> {
      await current?.promise.catch(() => {})
      try {
        return await settle(held, loading.generation)
      } finally {
        if (held.loading === loading) held.loading = null
      }
    }
  }

  async function settle(held: Held, generation: number): Promise<Loaded> {
    const hadView = held.view !== null
    try {
      const loaded = await attempt(held)
      if (!loaded) {
        drop(held)
        return { view: null, changed: hadView, failure: new AdoError('not_found', 404, RUN_GONE) }
      }
      if (held.generation !== generation || views.get(held.key) !== held) return { view: loaded.view, changed: false, failure: null }
      held.reads = loaded.reads
      return { view: loaded.view, changed: keep(held, loaded.view), failure: null }
    } catch (error) {
      if (!held.view || views.get(held.key) !== held) throw error
      const stale: RunView = { ...held.view, stale: true, message: failureMessage(error, RUNS_LOAD_FAILED) }
      return { view: stale, changed: keep(held, stale), failure: error }
    }
  }

  function keep(held: Held, view: RunView): boolean {
    const before = held.view && comparable(held.view)
    held.view = view
    held.at = now()
    return comparable(view) !== before
  }

  function drop(held: Held): void {
    if (views.get(held.key) === held) views.delete(held.key)
    if (shown.get(held.key)?.projectId !== held.projectId) return
    shown.delete(held.key)
    scheduler.remove(held.key)
  }

  async function attempt(held: Held): Promise<{ reads: Reads; view: RunView } | null> {
    const scope = scopeOf(held.org)
    const link = linkedAbort(scope.controller.signal)
    try {
      if (link.signal.aborted) throw notConnected()
      const me = (await statusOf(held.org)).account.adoId
      const reads = await read(withSignal(scope.http, link.signal), held, held.reads, me)
      link.signal.throwIfAborted()
      return reads && { reads, view: viewOf(held, reads, me) }
    } catch (error) {
      if (link.signal.aborted) throw notConnected()
      throw loadFailure(error, RUNS_LOAD_FAILED)
    } finally {
      link.release()
    }
  }

  async function read(http: AdoHttp, held: Held, previous: Reads | null, me: string): Promise<Reads | null> {
    const { org, projectId, buildId } = held
    const build = await getBuild(http, org, projectId, buildId).catch((error: unknown) => {
      if (error instanceof AdoError && error.code === 'not_found') return null
      throw error
    })
    if (!build) return null
    if (previous && finishedStatus(previous.build.status) && sameFinish(previous.build, build)) return { ...previous, build }
    const base = previous && !finishedStatus(previous.build.status) ? previous : null
    const timeline = mergeTimeline(base?.timeline ?? null, await getTimeline(http, org, projectId, buildId, base?.timeline.changeId))
    const logLines = base && !inProgress(base.timeline) && !inProgress(timeline) ? base.logLines : await listLogs(http, org, projectId, buildId)
    const waiting = runStages(timeline, logLines, !finishedStatus(build.status)).flatMap(stage => (stage.approvalId ? [stage.approvalId] : []))
    return { build, timeline, logLines, ...(await approvalsOf(http, held, timeline, waiting, me)) }
  }

  async function approvalsOf(
    http: AdoHttp,
    held: Held,
    timeline: RawTimeline,
    ids: string[],
    me: string
  ): Promise<Pick<Reads, 'approvals' | 'notes'>> {
    const wanted = new Set(ids.map(placeKey))
    for (const key of [...held.places.keys()]) if (!wanted.has(key)) held.places.delete(key)
    if (ids.length === 0) return { approvals: [], notes: undefined }
    let listed: RawApproval[]
    try {
      listed = await getApprovals(http, held.org, held.projectId, ids)
    } catch (error) {
      if (isMalformed(error)) return { approvals: [], notes: APPROVALS_UNREADABLE }
      if (error instanceof AdoError && error.code === 'forbidden') return { approvals: [], notes: APPROVALS_NEED_ACCESS }
      throw error
    }
    const pending = listed.filter(raw => typeof raw.id === 'string' && wanted.has(placeKey(raw.id)) && raw.status === PENDING)
    const unplaced = pending.filter(raw => placeIsUnsettled(held.places.get(placeKey(raw.id))))
    await mapLimit(unplaced, IN_FLIGHT, async raw => {
      held.places.set(placeKey(raw.id), await placeApproval(http, held.org, held.projectId, raw.id, timeline))
    })
    const approvals: ApprovalSummary[] = []
    let skipped = false
    for (const raw of pending) {
      const place = held.places.get(placeKey(raw.id))
      try {
        approvals.push(toApprovalSummary(raw, { projectId: held.projectId, me, stage: place?.stage ?? null, environment: place?.environment ?? null }))
      } catch (error) {
        if (!isMalformed(error)) throw error
        skipped = true
      }
    }
    const unnamed = pending.some(raw => held.places.get(placeKey(raw.id))?.gap != null)
    return { approvals, notes: joinMessages(skipped ? APPROVALS_UNREADABLE : undefined, unnamed ? APPROVAL_ENVIRONMENTS_UNREAD : undefined) }
  }

  function viewOf(held: Held, reads: Reads, me: string): RunView {
    const stages = runStages(reads.timeline, reads.logLines, !finishedStatus(reads.build.status))
    const summary = toRunSummary(reads.build, held.org, me)
    const view: RunView = {
      org: held.org,
      run: {
        ...summary,
        approvals: reads.approvals,
        state: waitingIf(summary.state, reads.approvals),
        stages: chipsOf(stages),
        watched: deps.watched(held.org, held.buildId)
      },
      stages,
      failures: failuresOf(stages),
      canCancel: cancellableStatus(reads.build.status),
      updatedAt: now(),
      stale: false
    }
    return bounded(reads.notes ? { ...view, message: reads.notes } : view)
  }

  return {
    onOrgs(orgs) {
      if (disposed) return
      const signedIn = new Set(orgs.filter(isSignedIn).map(status => status.org))
      for (const org of new Set([...scopes.keys(), ...connected, ...[...views.values()].map(held => held.org)])) {
        if (!signedIn.has(org)) forget(org)
      }
      connected.clear()
      for (const org of signedIn) connected.add(org)
      for (const key of shown.keys()) sync(key)
    },

    async view(input) {
      if (!isBuildId(input.buildId)) throw badRequest(BAD_RUN)
      await statusOf(input.org)
      const held = hold({ org: input.org, projectId: input.projectId, buildId: input.buildId })
      if (fresh(held)) return held.view
      const loaded = await load(held)
      if (!loaded.view) throw loaded.failure
      return loaded.view
    },

    async log({ org, projectId, buildId, logId, first }) {
      if (
        !isBuildId(buildId) ||
        !Number.isSafeInteger(logId) ||
        logId < 0 ||
        (first !== undefined && !(Number.isSafeInteger(first) && first >= LOG_FIRST_LINE))
      ) {
        throw badRequest(BAD_RUN)
      }
      const scope = scopeOf(org)
      const link = linkedAbort(scope.controller.signal)
      try {
        if (link.signal.aborted) throw notConnected()
        await statusOf(org)
        const http = withSignal(scope.http, link.signal)
        const held = views.get(viewKey(org, buildId))
        const counted = held?.projectId === projectId ? held.reads?.logLines.get(logId) : undefined
        const total = counted ?? (await listLogs(http, org, projectId, buildId)).get(logId) ?? 0
        const tail = first === undefined
        const from = tail ? Math.max(LOG_FIRST_LINE, total - MAX_LOG_LINES + 1) : first
        const to = Math.min(from + MAX_LOG_LINES - 1, total)
        const lines = to < from ? [] : await getLogLines(http, org, projectId, buildId, logId, from, to)
        link.signal.throwIfAborted()
        return capChunk({ logId, first: from, lines, total }, tail)
      } catch (error) {
        if (link.signal.aborted) throw notConnected()
        throw loadFailure(error, RUNS_LOAD_FAILED)
      } finally {
        link.release()
      }
    },

    setVisible({ org, visible, run }) {
      if (run && !isBuildId(run.buildId)) throw badRequest(BAD_RUN)
      const keys = run ? [viewKey(org, run.buildId)] : visible ? [] : [...shown].filter(([, target]) => target.org === org).map(([key]) => key)
      for (const key of keys) {
        if (visible && run) shown.set(key, { org, projectId: run.projectId, buildId: run.buildId })
        else shown.delete(key)
        sync(key)
      }
      evict()
      return { ok: true }
    },

    refreshNow(org, buildId) {
      const key = viewKey(org, buildId)
      const held = views.get(key)
      if (!held) return
      held.generation += 1
      held.reads = null
      held.at = -Infinity
      const target = shown.get(key)
      if (target && connected.has(org)) void reload(target).then(() => sync(key))
    },

    dispose() {
      disposed = true
      for (const key of shown.keys()) scheduler.remove(key)
      for (const org of new Set([...scopes.keys(), ...connected, ...[...views.values()].map(held => held.org)])) forget(org)
      connected.clear()
      shown.clear()
    }
  }
}

function viewKey(org: string, buildId: number): string {
  return `runview:${org}:${buildId}`
}

function sameFinish(before: RawBuild, after: RawBuild): boolean {
  return before.status === after.status && before.finishTime === after.finishTime
}

function inProgress(timeline: RawTimeline): boolean {
  return timeline.records.some(record => record.state === IN_PROGRESS)
}

function comparable(view: RunView): string {
  return JSON.stringify({ ...view, updatedAt: 0 })
}

function chipsOf(stages: readonly StageView[]): StageChip[] {
  return stages.map(({ id, name, state }) => ({ id, name, state }))
}

function recordsIn(view: RunView): number {
  const jobs = view.stages.flatMap(stage => stage.jobs)
  return view.stages.length + jobs.length + jobs.reduce((total, job) => total + job.steps.length, 0)
}

function issuesIn(view: RunView): number {
  const jobs = view.stages.flatMap(stage => stage.jobs)
  return [...jobs, ...jobs.flatMap(job => job.steps)].reduce((total, record) => total + record.issues.length, 0)
}

function fits(view: RunView): boolean {
  return byteLength(view) <= ANSWER_BUDGET_BYTES
}

function bounded(view: RunView): RunView {
  const records = recordsIn(view)
  if (records <= MAX_RECORDS && fits(view)) return view
  const capped = keepRecords(view, MAX_RECORDS)
  let result = capped
  for (const limit of ISSUE_LIMITS) {
    result = withIssues(capped, limit)
    if (fits(result)) break
  }
  if (!fits(result)) result = keepFitting(result)
  const issuesLeftOut = issuesIn(result) < issuesIn(capped)
  const stepsLeftOut = recordsIn(result) < records
  return { ...result, message: joinMessages(view.message, issuesLeftOut ? RUN_TRIMMED : undefined, stepsLeftOut ? RUN_CUT : undefined) }
}

function withIssues(view: RunView, limit: number): RunView {
  const fewer = (issues: Issue[]) => issues.slice(0, limit)
  const stages = view.stages.map(stage => ({
    ...stage,
    jobs: stage.jobs.map(job => ({ ...job, issues: fewer(job.issues), steps: job.steps.map(step => ({ ...step, issues: fewer(step.issues) })) }))
  }))
  return { ...view, stages, failures: failuresOf(stages) }
}

function keepFitting(view: RunView): RunView {
  let low = 0
  let high = recordsIn(view)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(keepRecords(view, middle))) low = middle
    else high = middle - 1
  }
  return keepRecords(view, low)
}

function keepRecords(view: RunView, count: number): RunView {
  if (count >= recordsIn(view)) return view
  let room = count
  const stages: StageView[] = []
  for (const stage of view.stages) {
    if (room === 0) break
    room -= 1
    const jobs: StageView['jobs'] = []
    for (const job of stage.jobs) {
      if (room === 0) break
      room -= 1
      const steps = job.steps.slice(0, room)
      room -= steps.length
      jobs.push({ ...job, steps })
    }
    stages.push({ ...stage, jobs })
  }
  return { ...view, run: { ...view.run, stages: chipsOf(stages) }, stages, failures: failuresOf(stages) }
}

function capChunk(chunk: LogChunk, tail: boolean): LogChunk {
  let room = ANSWER_BUDGET_BYTES - byteLength({ ...chunk, first: Number.MAX_SAFE_INTEGER, lines: [] })
  let count = 0
  for (const line of tail ? [...chunk.lines].reverse() : chunk.lines) {
    room -= itemBytes(line)
    if (count === MAX_LOG_LINES || room < 0) break
    count += 1
  }
  if (count === chunk.lines.length) return chunk
  if (!tail) return { ...chunk, lines: chunk.lines.slice(0, count) }
  return { ...chunk, first: chunk.first + chunk.lines.length - count, lines: chunk.lines.slice(chunk.lines.length - count) }
}
