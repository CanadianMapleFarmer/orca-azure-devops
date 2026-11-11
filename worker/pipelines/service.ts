import { MAX_STAGE_CHIPS, type ApprovalSummary, type RunKey, type RunsSnapshot, type RunSummary } from '../../src/shared/pipelines'
import { isActive, orderRuns, runCounts } from '../../src/shared/runs'
import type { OrgStatus } from '../../src/shared/types'
import { linkedAbort, untilAborted } from '../abort'
import { cachedCodeProjects, type CodeProjects } from '../ado/code-projects'
import { AdoError, type AdoHttp } from '../ado/http'
import { byteLength, newestThatFit, POST_BUDGET_BYTES } from '../budget'
import { fly, join, type Flight } from '../data/context'
import {
  APPROVAL_ENVIRONMENTS_UNREAD,
  APPROVALS_NEED_ACCESS,
  APPROVALS_UNREADABLE,
  badRequest,
  failureMessage,
  joinMessages,
  RUN_ALREADY_FINISHED,
  RUN_GONE,
  RUNS_LOAD_FAILED,
  RUNS_NEED_BUILD_READ,
  RUNS_TRIMMED
} from '../messages'
import { isSignedIn, loadFailure, notConnected, signedInStatus, type SignedInStatus } from '../org-status'
import { NOTIFY_CAP_MS, type Scheduler } from '../poll/scheduler'
import { carriedChips, createRunSource, waitingIf, type RunSource, type RunsLoad } from './load'
import type { RunSignals } from './signals'
import type { WatchList } from './watched'

export interface PipelinesServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  scheduler: Scheduler
  watchList: WatchList
  signals: RunSignals
  post: (snapshot: RunsSnapshot) => void
  now: () => number
}

export interface PipelinesService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<RunsSnapshot>
  refresh(org: string): Promise<RunsSnapshot>
  reloadFresh(org: string): Promise<RunsSnapshot>
  watch(input: { org: string; projectId: string; buildId: number; watched: boolean }): Promise<RunsSnapshot>
  visibility(input: { org: string; visible: boolean }): { ok: true }
  cachedRun(org: string, buildId: number): RunSummary | null
  isWatched(org: string, buildId: number): boolean
  approval(org: string, key: { projectId: string; approvalId: string }): Promise<{ run: RunSummary; approval: ApprovalSummary } | null>
  me(org: string): Promise<string>
  dispose(): void
}

type Kind = 'full' | 'background'

interface OrgRuns {
  controller: AbortController
  source: RunSource
  projects: CodeProjects
  base: RunsSnapshot | null
  snapshot: RunsSnapshot | null
  fullAt: number | null
  fullLoads: number
  failure: AdoError | null
  loading: { kind: Kind; flight: Flight<RunsSnapshot> } | null
  watching: Flight<void> | null
  pausedUntil: number
  watched: RunKey[]
}

const RUNS_MS = { visibleMs: 30_000, backgroundMs: 300_000, quietCapMs: NOTIFY_CAP_MS }
const WATCH_MS = { visibleMs: 30_000, backgroundMs: 30_000 }
const FRESH_MS = 30_000
const FORBIDDEN_PAUSE_MS = 10 * 60_000
const MAX_RUNS = 100

export function createPipelinesService(deps: PipelinesServiceDeps): PipelinesService {
  const { scheduler, now } = deps
  const entries = new Map<string, OrgRuns>()
  const jobs = new Set<string>()
  const visible = new Set<string>()
  let disposed = false

  function statusOf(org: string): Promise<SignedInStatus> {
    return signedInStatus(deps.orgs, org, RUNS_LOAD_FAILED, () => disposed)
  }

  function entryOf(org: string): OrgRuns {
    const existing = entries.get(org)
    if (existing) return existing
    const entry: OrgRuns = {
      controller: new AbortController(),
      source: createRunSource(deps.http, org, now),
      projects: cachedCodeProjects(deps.http, org, now),
      base: null,
      snapshot: null,
      fullAt: null,
      fullLoads: 0,
      failure: null,
      loading: null,
      watching: null,
      pausedUntil: -Infinity,
      watched: []
    }
    entries.set(org, entry)
    return entry
  }

  function forget(org: string): void {
    entries.get(org)?.controller.abort()
    entries.delete(org)
  }

  function runsKey(org: string): string {
    return `runs:${org}`
  }

  function watchKey(org: string): string {
    return `watch:${org}`
  }

  function upsertRuns(org: string): void {
    scheduler.upsert({ key: runsKey(org), org, ...RUNS_MS, run: signal => poll(org, signal) })
  }

  function syncWatchJob(org: string): void {
    if (jobs.has(org) && (entries.get(org)?.watched.length ?? 0) > 0) {
      scheduler.upsert({ key: watchKey(org), org, ...WATCH_MS, run: signal => pollWatched(org, signal) })
    } else {
      scheduler.remove(watchKey(org))
    }
  }

  function fresh(entry: OrgRuns | undefined): entry is OrgRuns & { snapshot: RunsSnapshot } {
    return entry !== undefined && entry.snapshot !== null && entry.fullAt !== null && now() - entry.fullAt < FRESH_MS
  }

  function lastFull(org: string): RunsSnapshot | null {
    const entry = entries.get(org)
    return entry && entry.fullAt !== null ? entry.snapshot : null
  }

  function publish(entry: OrgRuns, base: RunsSnapshot): RunsSnapshot {
    const snapshot = capRunsSnapshot(base)
    entry.base = base
    entry.snapshot = snapshot
    if (entry.fullAt !== null) deps.post(snapshot)
    return snapshot
  }

  function compose(org: string, me: string, runs: RunSummary[], message?: string): RunsSnapshot {
    const snapshot: RunsSnapshot = { org, me, runs, counts: runCounts(runs, now()), updatedAt: now(), stale: false }
    return message ? { ...snapshot, message } : snapshot
  }

  function flagged(entry: OrgRuns, runs: RunSummary[]): RunSummary[] {
    const ids = new Set(entry.watched.map(key => key.buildId))
    return runs.map(run => (run.watched === ids.has(run.buildId) ? run : { ...run, watched: ids.has(run.buildId) }))
  }

  async function settle(org: string, entry: OrgRuns, runs: RunSummary[], watched: RunKey[], read: RunSummary[], signal: AbortSignal): Promise<RunSummary[]> {
    deps.signals.update(org, runs)
    const seen = new Map(read.map(run => [run.buildId, run]))
    const over = watched.filter(key => {
      const run = seen.get(key.buildId)
      return !run || !isActive(run)
    })
    if (over.length > 0) await deps.watchList.drop(org, over)
    entry.watched = await deps.watchList.list(org)
    signal.throwIfAborted()
    syncWatchJob(org)
    const listed = flagged(entry, runs)
    if (listed.some((run, index) => run !== runs[index])) deps.signals.update(org, listed)
    return listed
  }

  function fail(entry: OrgRuns, error: unknown): AdoError {
    const forbidden = error instanceof AdoError && error.code === 'forbidden'
    if (forbidden) entry.pausedUntil = now() + FORBIDDEN_PAUSE_MS
    entry.failure = forbidden ? new AdoError('forbidden', 403, RUNS_NEED_BUILD_READ) : loadFailure(error, RUNS_LOAD_FAILED)
    if (entry.base) publish(entry, { ...entry.base, stale: true, message: forbidden ? RUNS_NEED_BUILD_READ : failureMessage(error, RUNS_LOAD_FAILED) })
    return entry.failure
  }

  function load(org: string, kind: Kind): Promise<RunsSnapshot> {
    const entry = entryOf(org)
    const current = entry.loading
    if (current && (current.kind === 'full' || kind === 'background')) return join(current.flight)
    const loading = { kind, flight: fly(run) }
    entry.loading = loading
    return join(loading.flight)

    async function run(): Promise<RunsSnapshot> {
      if (current) await join(current.flight).catch(() => {})
      try {
        return await attempt(org, entry, kind)
      } finally {
        if (entry.loading === loading) entry.loading = null
      }
    }
  }

  async function attempt(org: string, entry: OrgRuns, kind: Kind): Promise<RunsSnapshot> {
    const link = linkedAbort(entry.controller.signal)
    try {
      return await attemptWith(org, entry, kind, link.signal)
    } finally {
      link.release()
    }
  }

  async function attemptWith(org: string, entry: OrgRuns, kind: Kind, signal: AbortSignal): Promise<RunsSnapshot> {
    if (signal.aborted) throw notConnected()
    if (now() < entry.pausedUntil) {
      const last = lastFull(org)
      if (last) return last
      throw entry.failure ?? loadFailure(null, RUNS_LOAD_FAILED)
    }
    try {
      const status = await statusOf(org)
      const me = status.account.adoId
      const projects = await entry.projects(status.codeProjects, signal)
      const watched = await deps.watchList.list(org)
      entry.watched = watched
      const loaded = kind === 'full' ? await entry.source.full(me, projects, watched, signal) : await entry.source.background(me, projects, watched, signal)
      signal.throwIfAborted()
      if (kind === 'full') entry.fullAt = now()
      entry.failure = null
      const runs = await settle(org, entry, loaded.runs, watched, loaded.runs, signal)
      return publish(entry, compose(org, me, runs, offMessage(loaded)))
    } catch (error) {
      if (signal.aborted) throw notConnected()
      throw fail(entry, error)
    } finally {
      if (kind === 'full') entry.fullLoads += 1
    }
  }

  function watchLoad(org: string): Promise<void> {
    const entry = entries.get(org)
    if (!entry) return Promise.resolve()
    if (entry.watching) return join(entry.watching)
    const watching = fly(() =>
      watchOnce(org, entry).finally(() => {
        if (entry.watching === watching) entry.watching = null
      })
    )
    entry.watching = watching
    return join(watching)
  }

  async function watchOnce(org: string, entry: OrgRuns): Promise<void> {
    const link = linkedAbort(entry.controller.signal)
    const { signal } = link
    try {
      const base = entry.base
      if (!base || now() < entry.pausedUntil) return
      const status = await statusOf(org)
      const keys = await deps.watchList.list(org)
      entry.watched = keys
      if (keys.length === 0) return
      const me = status.account.adoId
      const read = await entry.source.watched(me, keys, signal)
      signal.throwIfAborted()
      const latest = entry.base ?? base
      const runs = await settle(org, entry, mergeWatched(latest.runs, read), keys, read, signal)
      const merged = compose(org, me, runs, latest.message)
      publish(entry, latest.stale ? { ...merged, stale: true } : merged)
    } catch (error) {
      if (signal.aborted) throw notConnected()
      throw fail(entry, error)
    } finally {
      link.release()
    }
  }

  async function loadInFull(org: string): Promise<void> {
    const entry = entryOf(org)
    const loads = entry.fullLoads
    await scheduler.runNow(runsKey(org))
    if (entry.fullLoads === loads && !entry.controller.signal.aborted) await load(org, 'full').catch(() => {})
  }

  async function poll(org: string, signal: AbortSignal): Promise<void> {
    try {
      await untilAborted(load(org, visible.has(org) ? 'full' : 'background'), signal)
    } finally {
      if (!signal.aborted && jobs.has(org)) upsertRuns(org)
    }
  }

  async function pollWatched(org: string, signal: AbortSignal): Promise<void> {
    try {
      await untilAborted(watchLoad(org), signal)
    } finally {
      if (!signal.aborted) syncWatchJob(org)
    }
  }

  async function readRun(entry: OrgRuns, me: string, key: RunKey): Promise<RunSummary> {
    const link = linkedAbort(entry.controller.signal)
    try {
      const [run] = await entry.source.watched(me, [key], link.signal)
      if (!run) throw new AdoError('not_found', 404, RUN_GONE)
      return run
    } catch (error) {
      if (link.signal.aborted) throw notConnected()
      throw error
    } finally {
      link.release()
    }
  }

  function cachedRun(org: string, buildId: number): RunSummary | null {
    return entries.get(org)?.base?.runs.find(run => run.buildId === buildId) ?? null
  }

  function isWatched(org: string, buildId: number): boolean {
    return entries.get(org)?.watched.some(key => key.buildId === buildId) ?? false
  }

  async function snapshot(org: string): Promise<RunsSnapshot> {
    await statusOf(org)
    const entry = entries.get(org)
    if (fresh(entry)) return entry.snapshot
    try {
      return await load(org, 'full')
    } catch (error) {
      const last = lastFull(org)
      if (last) return last
      throw error
    }
  }

  return {
    onOrgs(orgs) {
      if (disposed) return
      const signedIn = new Set(orgs.filter(isSignedIn).map(status => status.org))
      for (const org of new Set([...entries.keys(), ...jobs])) {
        if (signedIn.has(org)) continue
        forget(org)
        if (jobs.delete(org)) {
          scheduler.remove(runsKey(org))
          scheduler.remove(watchKey(org))
        }
        deps.signals.update(org, null)
      }
      for (const org of signedIn) {
        if (jobs.has(org)) continue
        jobs.add(org)
        upsertRuns(org)
        scheduler.setVisible(runsKey(org), visible.has(org))
      }
    },

    snapshot,

    async refresh(org) {
      await statusOf(org)
      await loadInFull(org)
      const last = lastFull(org)
      if (last) return last
      const entry = entries.get(org)
      throw entry ? (entry.failure ?? loadFailure(null, RUNS_LOAD_FAILED)) : notConnected()
    },

    async reloadFresh(org) {
      await statusOf(org)
      const loading = entryOf(org).loading
      if (loading) await join(loading.flight).catch(() => {})
      return load(org, 'full')
    },

    async watch({ org, projectId, buildId, watched }) {
      const status = await statusOf(org)
      const entry = entryOf(org)
      const run = watched ? (cachedRun(org, buildId) ?? (await readRun(entry, status.account.adoId, { projectId, buildId }))) : null
      if (run && !isActive(run)) throw badRequest(RUN_ALREADY_FINISHED)
      const list = await deps.watchList.set(org, { projectId: run?.projectId ?? projectId, buildId }, watched)
      if (entry.controller.signal.aborted) throw notConnected()
      entry.watched = list
      syncWatchJob(org)
      const base = entry.base
      if (!base) return snapshot(org)
      const listed = run && !base.runs.some(item => item.buildId === buildId) ? orderRuns([...base.runs, run]) : base.runs
      const runs = flagged(entry, listed)
      return publish(entry, { ...base, runs, counts: runCounts(runs, now()) })
    },

    visibility({ org, visible: shown }) {
      const becameVisible = shown && !visible.has(org)
      if (shown) visible.add(org)
      else visible.delete(org)
      scheduler.setVisible(runsKey(org), shown)
      if (becameVisible && jobs.has(org) && !fresh(entries.get(org))) void loadInFull(org)
      return { ok: true }
    },

    cachedRun,
    isWatched,

    async approval(org, key) {
      const status = await statusOf(org)
      const entry = entryOf(org)
      const wanted = key.approvalId.toLowerCase()
      for (const run of entry.base?.runs ?? []) {
        const approval = run.approvals.find(item => item.projectId === key.projectId && item.approvalId.toLowerCase() === wanted)
        if (approval) return { run, approval }
      }
      const link = linkedAbort(entry.controller.signal)
      try {
        const pair = await entry.source.approval(status.account.adoId, key, link.signal)
        return pair && { ...pair, run: { ...pair.run, watched: isWatched(org, pair.run.buildId) } }
      } catch (error) {
        if (link.signal.aborted) throw notConnected()
        throw error
      } finally {
        link.release()
      }
    },

    async me(org) {
      return (await statusOf(org)).account.adoId
    },

    dispose() {
      disposed = true
      for (const org of jobs) {
        scheduler.remove(runsKey(org))
        scheduler.remove(watchKey(org))
      }
      jobs.clear()
      for (const org of [...entries.keys()]) forget(org)
    }
  }
}

function mergeWatched(current: RunSummary[], read: RunSummary[]): RunSummary[] {
  const byId = new Map(current.map(run => [run.buildId, run]))
  for (const run of read) {
    const previous = byId.get(run.buildId)
    const approvals = previous?.approvals ?? []
    const next = { ...run, approvals, state: waitingIf(run.state, approvals) }
    byId.set(run.buildId, { ...next, stages: carriedChips(previous, next) })
  }
  return orderRuns([...byId.values()])
}

function capRunsSnapshot(snapshot: RunsSnapshot): RunsSnapshot {
  const runs = snapshot.runs.map(run => (run.stages && run.stages.length > MAX_STAGE_CHIPS ? { ...run, stages: run.stages.slice(0, MAX_STAGE_CHIPS) } : run))
  const message = joinMessages(snapshot.message, RUNS_TRIMMED)
  const budget = POST_BUDGET_BYTES - byteLength({ ...snapshot, runs: [], message })
  const kept = newestThatFit(runs, budget, run => (isActive(run) ? Infinity : run.queuedAt), MAX_RUNS)
  if (kept.size === runs.length) return { ...snapshot, runs }
  return { ...snapshot, runs: runs.filter(run => kept.has(run)), message }
}

function offMessage({ off }: RunsLoad): string | undefined {
  return joinMessages(
    off.approvals ? APPROVALS_NEED_ACCESS : undefined,
    off.skippedApprovals ? APPROVALS_UNREADABLE : undefined,
    off.environments ? APPROVAL_ENVIRONMENTS_UNREAD : undefined
  )
}
