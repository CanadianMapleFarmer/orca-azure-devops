import type { ApprovalSummary, RunKey, RunState, RunSummary, StageChip } from '../../src/shared/pipelines'
import { isActive, orderRuns } from '../../src/shared/runs'
import { checkSuiteEnvironment, getApprovals, listPendingApprovals, runIdOf, toApprovalSummary, type RawApproval } from '../ado/approvals'
import { buildsByIds, getBuild, listBuilds, toRunSummary, type RawBuild } from '../ado/builds'
import type { NamedItem } from '../ado/core'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { isMalformed, malformed } from '../ado/shape'
import { approvalPlaceOf, getTimeline, mergeTimeline, stageChips, type RawTimeline } from '../ado/timeline'
import type { OrgEntities, Stamped } from '../data/entities'
import { createHeat } from '../data/heat'
import { MALFORMED } from '../messages'

const MINUTE = 60_000
const IN_FLIGHT = 4
const MINE_TOP = 50
const RUNNING_TOP = 25
const MINE_WINDOW_MS = 7 * 24 * 60 * MINUTE
const MAX_ACTIVE_CHIPS = 8
const MAX_FINISHED_CHIPS = 8
const APPROVALS_OFF_MS = 10 * MINUTE
const SHARED_TIMELINE_MS = 5_000

export interface RunsLoad {
  runs: RunSummary[]
  off: { approvals: boolean; skippedApprovals: boolean; environments: boolean }
}

export interface RunSource {
  full(me: string, projects: NamedItem[], watched: RunKey[], all: boolean, signal?: AbortSignal): Promise<RunsLoad>
  background(me: string, projects: NamedItem[], watched: RunKey[], all: boolean, signal?: AbortSignal): Promise<RunsLoad>
  watched(me: string, keys: RunKey[], signal?: AbortSignal): Promise<RunSummary[]>
  unread(keys: RunKey[], withinMs: number): RunKey[]
  approval(me: string, key: { projectId: string; approvalId: string }, signal?: AbortSignal): Promise<{ run: RunSummary; approval: ApprovalSummary } | null>
  seed(runs: RunSummary[]): void
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

interface Approvals {
  pending: Pending[]
  skipped: boolean
}

type List = 'mine' | 'running' | 'approvals'

interface Kept {
  mine?: RawBuild[]
  running?: RawBuild[]
  approvals?: Approvals
}

type Kind = 'full' | 'background'

export function createRunSource(http: AdoHttp, org: string, now: () => number, tables: Pick<OrgEntities, 'runChips' | 'builds' | 'timelines'>): RunSource {
  const { runChips, builds, timelines } = tables
  const heat = createHeat(now)
  const kept = new Map<string, Kept>()
  let places = new Map<string, ApprovalPlace>()
  let lastFull = new Map<number, RunSummary>()
  let approvalsOffUntil = -Infinity

  const approvalsOff = () => now() < approvalsOffUntil

  async function pendingIn(scoped: AdoHttp, me: string, projectId: string): Promise<Approvals> {
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

  function keptOf(me: string, projectId: string): Kept {
    const key = `${me}/${projectId}`
    const entry = kept.get(key) ?? {}
    kept.set(key, entry)
    return entry
  }

  function keepBuilds(raws: RawBuild[]): RawBuild[] {
    for (const raw of raws) builds.put(String(raw.id), raw)
    return raws
  }

  async function readInto(scoped: AdoHttp, me: string, entry: Kept, projectId: string, list: List): Promise<void> {
    if (list === 'mine') entry.mine = keepBuilds(await listBuilds(scoped, org, projectId, { requestedFor: me, minTime: now() - MINE_WINDOW_MS, top: MINE_TOP }))
    else if (list === 'running') entry.running = keepBuilds(await listBuilds(scoped, org, projectId, { statusFilter: 'inProgress', top: RUNNING_TOP }))
    else entry.approvals = await pendingIn(scoped, me, projectId)
  }

  async function lists(scoped: AdoHttp, me: string, projects: NamedItem[], kind: Kind, all: boolean): Promise<Lists> {
    const wanted: List[] = kind === 'full' ? ['mine', 'running', 'approvals'] : ['mine', 'approvals']
    const current = new Set(projects.map(project => `${me}/${project.id}`))
    for (const key of kept.keys()) if (!current.has(key)) kept.delete(key)
    const due = new Set(heat.pick(projects, all).map(project => project.id))
    const read = projects.filter(project => due.has(project.id) || wanted.some(list => !keptOf(me, project.id)[list]))
    const reads = read.flatMap(project => wanted.map(list => ({ entry: keptOf(me, project.id), projectId: project.id, list })))
    await mapLimit(reads, IN_FLIGHT, ({ entry, projectId, list }) => readInto(scoped, me, entry, projectId, list))
    for (const project of read) heat.saw(project.id, found(keptOf(me, project.id)))
    const held = projects.map(project => keptOf(me, project.id))
    return {
      builds: held.flatMap(entry => [...(entry.mine ?? []), ...(kind === 'full' ? (entry.running ?? []) : [])]),
      pending: held.flatMap(entry => entry.approvals?.pending ?? []),
      skipped: held.some(entry => entry.approvals?.skipped === true)
    }
  }

  async function withUnlisted(scoped: AdoHttp, me: string, builds: RawBuild[], wanted: RunKey[]): Promise<Map<number, RunSummary>> {
    const runs = new Map<number, RunSummary>()
    for (const raw of builds) if (!runs.has(raw.id)) runs.set(raw.id, toRunSummary(raw, org, me))
    const missing = new Map<string, Set<number>>()
    for (const { projectId, buildId } of wanted) {
      if (!runs.has(buildId)) missing.set(projectId, (missing.get(projectId) ?? new Set()).add(buildId))
    }
    const batches = await mapLimit([...missing], IN_FLIGHT, async ([projectId, ids]) => keepBuilds(await buildsByIds(scoped, org, projectId, [...ids])))
    for (const raw of batches.flat()) if (!runs.has(raw.id)) runs.set(raw.id, toRunSummary(raw, org, me))
    return runs
  }

  async function timelineOf(scoped: AdoHttp, run: RunSummary): Promise<RawTimeline | null> {
    const key = String(run.buildId)
    const stored = timelines.get(key)
    if (stored && (now() - stored.at < SHARED_TIMELINE_MS || finalFor(run, stored))) return stored.value
    const answer = await getTimeline(scoped, org, run.projectId, run.buildId, stored?.value.changeId)
    return answer || stored ? timelines.put(key, mergeTimeline(stored?.value ?? null, answer)) : null
  }

  async function timelinesOf(scoped: AdoHttp, runs: RunSummary[]): Promise<Map<number, RawTimeline | null>> {
    const read = await mapLimit(runs, IN_FLIGHT, run => timelineOf(scoped, run))
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
      finished: ordered.filter(run => !isActive(run) && run.finishedAt !== null && !runChips.get(chipKey(run))).slice(0, MAX_FINISHED_CHIPS)
    }
  }

  function cachedChips(run: RunSummary): StageChip[] | null | undefined {
    return runChips.get(chipKey(run))?.value
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

  async function load(kind: Kind, me: string, projects: NamedItem[], watched: RunKey[], all: boolean, signal?: AbortSignal): Promise<RunsLoad> {
    const scoped = withSignal(http, signal)
    const { builds, pending, skipped } = await lists(scoped, me, projects, kind, all)
    const wanted = [...pending.map(({ projectId, raw }) => ({ projectId, buildId: runIdOf(raw) })), ...watched]
    const runs = await withUnlisted(scoped, me, builds, wanted)
    const targets = kind === 'full' ? chipTargets([...runs.values()]) : { active: [], finished: [] }
    const timelines = await timelinesOf(scoped, [...targets.active, ...targets.finished])
    for (const run of targets.finished) runChips.put(chipKey(run), chipsFrom(timelines.get(run.buildId)))
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
    full: (me, projects, watched, all, signal) => load('full', me, projects, watched, all, signal),
    background: (me, projects, watched, all, signal) => load('background', me, projects, watched, all, signal),

    async watched(me, keys, signal) {
      const scoped = withSignal(http, signal)
      const runs = await withUnlisted(scoped, me, [], keys)
      return [...runs.values()].map(run => ({ ...run, watched: true }))
    },

    unread(keys, withinMs) {
      return keys.filter(key => builds.fresh(String(key.buildId), withinMs) === undefined)
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
      const timeline = known ? null : await timelineOf(scoped, run)
      const place = known ?? (await placeApproval(scoped, org, key.projectId, raw.id, timeline))
      places.set(placeKey(raw.id), place)
      const approval = toApprovalSummary(raw, { projectId: key.projectId, me, stage: place.stage, environment: place.environment })
      const approvals = [approval]
      return { run: { ...run, approvals, state: waitingIf(run.state, approvals), stages: chipsFrom(timeline) }, approval }
    },

    seed(runs) {
      for (const run of runs) {
        if (isActive(run) || run.finishedAt === null || !Array.isArray(run.stages) || runChips.get(chipKey(run))) continue
        runChips.put(chipKey(run), run.stages)
      }
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

function withPending(pending: Pending[], skipped = false): Approvals {
  return { pending, skipped }
}

export function settled(timeline: RawTimeline): boolean {
  return !timeline.records.some(record => record.state === 'pending' || record.state === 'inProgress')
}

function finalFor(run: RunSummary, stored: Stamped<RawTimeline>): boolean {
  return !isActive(run) && run.finishedAt !== null && stored.at >= run.finishedAt && settled(stored.value)
}

function found(entry: Kept): boolean {
  return [entry.mine, entry.running, entry.approvals?.pending].some(list => (list?.length ?? 0) > 0)
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

export function placeKey(approvalId: string): string {
  return approvalId.toLowerCase()
}
