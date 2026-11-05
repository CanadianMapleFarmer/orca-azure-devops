import type { ApprovalSummary, RunKey, RunState, RunSummary, StageChip } from '../../src/shared/pipelines'
import { isActive, orderRuns } from '../../src/shared/runs'
import { checkSuiteEnvironment, getApprovals, listPendingApprovals, runIdOf, toApprovalSummary, type RawApproval } from '../ado/approvals'
import { buildsByIds, getBuild, listBuilds, toRunSummary, type RawBuild } from '../ado/builds'
import type { NamedItem } from '../ado/core'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { isMalformed, malformed } from '../ado/shape'
import { approvalPlaceOf, getTimeline, stageChips, type RawTimeline } from '../ado/timeline'
import { MALFORMED } from '../messages'

const MINUTE = 60_000
const IN_FLIGHT = 4
const MINE_TOP = 50
const RUNNING_TOP = 25
const MINE_WINDOW_MS = 7 * 24 * 60 * MINUTE
const MAX_ACTIVE_CHIPS = 8
const MAX_FINISHED_CHIPS = 8
const MAX_CACHED_CHIPS = 100
const APPROVALS_OFF_MS = 10 * MINUTE

export interface RunsLoad {
  runs: RunSummary[]
  off: { approvals: boolean; skippedApprovals: boolean; environments: boolean }
}

export interface RunSource {
  full(me: string, projects: NamedItem[], watched: RunKey[], signal?: AbortSignal): Promise<RunsLoad>
  background(me: string, projects: NamedItem[], watched: RunKey[], signal?: AbortSignal): Promise<RunsLoad>
  watched(me: string, keys: RunKey[], signal?: AbortSignal): Promise<RunSummary[]>
  approval(me: string, key: { projectId: string; approvalId: string }, signal?: AbortSignal): Promise<{ run: RunSummary; approval: ApprovalSummary } | null>
}

interface Pending {
  projectId: string
  raw: RawApproval
}

type Gap = 'permanent' | 'transient'

export interface ApprovalPlace {
  stage: string | null
  environment: string | null
  gap: Gap | null
}

interface Lists {
  builds: RawBuild[]
  pending: Pending[]
  skipped: boolean
}

type Kind = 'full' | 'background'

export function createRunSource(http: AdoHttp, org: string, now: () => number): RunSource {
  const finishedChips = new Map<string, StageChip[] | null>()
  let places = new Map<string, ApprovalPlace>()
  let lastFull = new Map<number, RunSummary>()
  let approvalsOffUntil = -Infinity

  const approvalsOff = () => now() < approvalsOffUntil

  async function pendingIn(scoped: AdoHttp, me: string, projectId: string): Promise<Lists> {
    if (approvalsOff()) return withPending([])
    try {
      const listed = await listPendingApprovals(scoped, org, projectId)
      const pending = listed.filter(raw => readable(raw, projectId, me)).map(raw => ({ projectId, raw }))
      return withPending(pending, pending.length < listed.length)
    } catch (error) {
      if (isMalformed(error)) return withPending([], true)
      if (!(error instanceof AdoError) || error.code !== 'forbidden') throw error
      approvalsOffUntil = now() + APPROVALS_OFF_MS
      return withPending([])
    }
  }

  async function lists(scoped: AdoHttp, me: string, projects: NamedItem[], kind: Kind): Promise<Lists> {
    const reads: (() => Promise<Lists>)[] = projects.flatMap(project => [
      async () => withBuilds(await listBuilds(scoped, org, project.id, { requestedFor: me, minTime: now() - MINE_WINDOW_MS, top: MINE_TOP })),
      ...(kind === 'full' ? [async () => withBuilds(await listBuilds(scoped, org, project.id, { statusFilter: 'inProgress', top: RUNNING_TOP }))] : []),
      () => pendingIn(scoped, me, project.id)
    ])
    const loaded = await mapLimit(reads, IN_FLIGHT, read => read())
    return {
      builds: loaded.flatMap(entry => entry.builds),
      pending: loaded.flatMap(entry => entry.pending),
      skipped: loaded.some(entry => entry.skipped)
    }
  }

  async function withUnlisted(scoped: AdoHttp, me: string, builds: RawBuild[], wanted: RunKey[]): Promise<Map<number, RunSummary>> {
    const runs = new Map<number, RunSummary>()
    for (const raw of builds) if (!runs.has(raw.id)) runs.set(raw.id, toRunSummary(raw, org, me))
    const missing = new Map<string, Set<number>>()
    for (const { projectId, buildId } of wanted) {
      if (!runs.has(buildId)) missing.set(projectId, (missing.get(projectId) ?? new Set()).add(buildId))
    }
    const batches = await mapLimit([...missing], IN_FLIGHT, ([projectId, ids]) => buildsByIds(scoped, org, projectId, [...ids]))
    for (const raw of batches.flat()) if (!runs.has(raw.id)) runs.set(raw.id, toRunSummary(raw, org, me))
    return runs
  }

  async function timelinesOf(scoped: AdoHttp, runs: RunSummary[]): Promise<Map<number, RawTimeline | null>> {
    const read = await mapLimit(runs, IN_FLIGHT, run => getTimeline(scoped, org, run.projectId, run.buildId))
    return new Map(runs.map((run, index) => [run.buildId, read[index]]))
  }

  function placeIsOpen(approvalId: string): boolean {
    return placeIsUnsettled(places.get(placeKey(approvalId)))
  }

  async function placeAll(scoped: AdoHttp, pending: Pending[], runs: ReadonlyMap<number, RunSummary>, timelines: Map<number, RawTimeline | null>): Promise<void> {
    const unplaced = pending.filter(({ raw }) => runs.has(runIdOf(raw)) && placeIsOpen(raw.id))
    const unread = new Map<number, RunSummary>()
    for (const { raw } of unplaced) {
      const run = runs.get(runIdOf(raw))
      if (run && !timelines.has(run.buildId)) unread.set(run.buildId, run)
    }
    for (const [buildId, timeline] of await timelinesOf(scoped, [...unread.values()])) timelines.set(buildId, timeline)
    await mapLimit(unplaced, IN_FLIGHT, async ({ projectId, raw }) => {
      places.set(placeKey(raw.id), await placeApproval(scoped, org, projectId, raw.id, timelines.get(runIdOf(raw)) ?? null))
    })
  }

  function chipTargets(runs: RunSummary[]): { active: RunSummary[]; finished: RunSummary[] } {
    const ordered = orderRuns(runs)
    return {
      active: ordered.filter(isActive).slice(0, MAX_ACTIVE_CHIPS),
      finished: ordered.filter(run => !isActive(run) && run.finishedAt !== null && !finishedChips.has(chipKey(run))).slice(0, MAX_FINISHED_CHIPS)
    }
  }

  function rememberChips(run: RunSummary, chips: StageChip[] | null): void {
    finishedChips.delete(chipKey(run))
    finishedChips.set(chipKey(run), chips)
    for (const key of finishedChips.keys()) {
      if (finishedChips.size <= MAX_CACHED_CHIPS) break
      finishedChips.delete(key)
    }
  }

  function cachedChips(run: RunSummary): StageChip[] | null | undefined {
    const key = chipKey(run)
    if (!finishedChips.has(key)) return undefined
    const chips = finishedChips.get(key) ?? null
    finishedChips.delete(key)
    finishedChips.set(key, chips)
    return chips
  }

  function fullChips(run: RunSummary, timelines: ReadonlyMap<number, RawTimeline | null>, active: ReadonlySet<number>): StageChip[] | null {
    if (active.has(run.buildId)) return chipsFrom(timelines.get(run.buildId))
    const cached = isActive(run) ? undefined : cachedChips(run)
    return cached === undefined ? carriedChips(lastFull.get(run.buildId), run) : cached
  }

  function assemble(me: string, runs: Map<number, RunSummary>, pending: Pending[], watched: RunKey[], chipsOf: (run: RunSummary) => StageChip[] | null): RunSummary[] {
    const approvals = new Map<number, ApprovalSummary[]>()
    for (const { projectId, raw } of pending) {
      const buildId = runIdOf(raw)
      if (!runs.has(buildId)) continue
      const { stage, environment } = places.get(placeKey(raw.id)) ?? { stage: null, environment: null }
      approvals.set(buildId, [...(approvals.get(buildId) ?? []), toApprovalSummary(raw, { projectId, me, stage, environment })])
    }
    const watchedIds = new Set(watched.map(key => key.buildId))
    return orderRuns(
      [...runs.values()].map(run => {
        const waitingOn = approvals.get(run.buildId) ?? []
        const next = { ...run, approvals: waitingOn, state: waitingIf(run.state, waitingOn), watched: watchedIds.has(run.buildId) }
        return { ...next, stages: chipsOf(next) }
      })
    )
  }

  async function load(kind: Kind, me: string, projects: NamedItem[], watched: RunKey[], signal?: AbortSignal): Promise<RunsLoad> {
    const scoped = withSignal(http, signal)
    const { builds, pending, skipped } = await lists(scoped, me, projects, kind)
    const wanted = [...pending.map(({ projectId, raw }) => ({ projectId, buildId: runIdOf(raw) })), ...watched]
    const runs = await withUnlisted(scoped, me, builds, wanted)
    const targets = kind === 'full' ? chipTargets([...runs.values()]) : { active: [], finished: [] }
    const timelines = await timelinesOf(scoped, [...targets.active, ...targets.finished])
    for (const run of targets.finished) rememberChips(run, chipsFrom(timelines.get(run.buildId)))
    await placeAll(scoped, pending, runs, timelines)
    const current = new Set(pending.map(({ raw }) => placeKey(raw.id)))
    places = new Map([...places].filter(([key]) => current.has(key)))

    const active = new Set(targets.active.map(run => run.buildId))
    const result = assemble(me, runs, pending, watched, run =>
      kind === 'full' ? fullChips(run, timelines, active) : carriedChips(lastFull.get(run.buildId), run)
    )
    if (kind === 'full') lastFull = new Map(result.map(run => [run.buildId, run]))
    const unnamed = pending.some(({ raw }) => places.get(placeKey(raw.id))?.gap != null)
    return { runs: result, off: { approvals: approvalsOff(), skippedApprovals: skipped, environments: unnamed } }
  }

  return {
    full: (me, projects, watched, signal) => load('full', me, projects, watched, signal),
    background: (me, projects, watched, signal) => load('background', me, projects, watched, signal),

    async watched(me, keys, signal) {
      const scoped = withSignal(http, signal)
      const runs = await withUnlisted(scoped, me, [], keys)
      return [...runs.values()].map(run => ({ ...run, watched: true }))
    },

    async approval(me, key, signal) {
      const scoped = withSignal(http, signal)
      const wanted = key.approvalId.toLowerCase()
      const found = (await getApprovals(scoped, org, key.projectId, [key.approvalId])).map(checked)
      const raw = found.find(entry => entry.id.toLowerCase() === wanted && entry.status === 'pending')
      if (!raw) return null
      const build = await getBuild(scoped, org, key.projectId, runIdOf(raw)).catch((error: unknown) => {
        if (error instanceof AdoError && error.code === 'not_found') return null
        throw error
      })
      if (!build) return null
      const run = toRunSummary(build, org, me)
      const known = places.get(placeKey(raw.id))
      const timeline = known ? null : await getTimeline(scoped, org, key.projectId, run.buildId)
      const place = known ?? (await placeApproval(scoped, org, key.projectId, raw.id, timeline))
      places.set(placeKey(raw.id), place)
      const approval = toApprovalSummary(raw, { projectId: key.projectId, me, stage: place.stage, environment: place.environment })
      const approvals = [approval]
      return { run: { ...run, approvals, state: waitingIf(run.state, approvals), stages: chipsFrom(timeline) }, approval }
    }
  }
}

export async function placeApproval(
  http: AdoHttp,
  org: string,
  projectId: string,
  approvalId: string,
  timeline: RawTimeline | null
): Promise<ApprovalPlace> {
  const place = timeline ? approvalPlaceOf(timeline, approvalId) : null
  const stage = place?.stage ?? null
  if (!place?.checkSuiteId) return { stage, environment: null, gap: null }
  try {
    return { stage, environment: await checkSuiteEnvironment(http, org, projectId, place.checkSuiteId), gap: null }
  } catch (error) {
    if (!(error instanceof AdoError)) throw error
    return { stage, environment: null, gap: permanent(error) ? 'permanent' : 'transient' }
  }
}

export function placeIsUnsettled(place: ApprovalPlace | undefined): boolean {
  return place === undefined || place.gap === 'transient'
}

export function carriedChips(previous: RunSummary | undefined, next: RunSummary): StageChip[] | null {
  return previous && previous.state === next.state && previous.finishedAt === next.finishedAt ? previous.stages : null
}

export function waitingIf(state: RunState, approvals: readonly ApprovalSummary[]): RunState {
  return approvals.length > 0 && (state === 'queued' || state === 'running') ? 'waiting' : state
}

function withBuilds(builds: RawBuild[]): Lists {
  return { builds, pending: [], skipped: false }
}

function withPending(pending: Pending[], skipped = false): Lists {
  return { builds: [], pending, skipped }
}

function readable(raw: RawApproval, projectId: string, me: string): boolean {
  try {
    toApprovalSummary(raw, { projectId, me, stage: null, environment: null })
    return true
  } catch {
    return false
  }
}

function permanent(error: AdoError): boolean {
  return error.code === 'not_found' || error.code === 'forbidden' || isMalformed(error)
}

function checked(raw: RawApproval): RawApproval {
  runIdOf(raw)
  return typeof raw.id === 'string' ? raw : malformed(MALFORMED.approval)
}

function chipsFrom(timeline: RawTimeline | null | undefined): StageChip[] | null {
  return timeline ? stageChips(timeline) : null
}

function chipKey(run: RunSummary): string {
  return `${run.buildId}:${run.finishedAt}`
}

function placeKey(approvalId: string): string {
  return approvalId.toLowerCase()
}
