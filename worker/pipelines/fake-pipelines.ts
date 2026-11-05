import type { RawApproval } from '../ado/approvals'
import type { RawBuild } from '../ado/builds'
import type { RawTimeline } from '../ado/timeline'
import { fakeAdo, fixture, json, PROJECT, type AdoCall, type FakeAdo } from '../boards/fake-ado'
import { isRepositories, ME } from '../prs/fake-prs'

export { ME }

export const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
export const APPROVAL_4520 = '8d4e5f6a-7002-4d5e-8f6a-7b8c9d0e1f22'
export const APPROVAL_4531 = '9e5f6a7b-7003-4e6f-9a7b-8c9d0e1f2a33'
export const CHECK_SUITE_4520 = '7c3d4e5f-7001-4c4d-9e5f-6a7b8c9d0e11'

const BUILD_LIST = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds$/
const ONE_BUILD = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds\/(\d+)$/
const TIMELINE = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds\/(\d+)\/timeline$/
const LOGS = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds\/(\d+)\/logs$/
const LOG_LINES = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds\/(\d+)\/logs\/(\d+)$/
const STAGE = /^\/[^/]+\/([^/]+)\/_apis\/build\/builds\/(\d+)\/stages\/([^/]+)$/
const APPROVALS = /^\/[^/]+\/([^/]+)\/_apis\/pipelines\/approvals$/
const CHECK_SUITE = /^\/[^/]+\/([^/]+)\/_apis\/pipelines\/checks\/runs\/([^/]+)$/

const isBuildList = (call: AdoCall) => call.method === 'GET' && BUILD_LIST.test(call.path)
export const isMineRuns = (call: AdoCall) => isBuildList(call) && call.query.has('requestedFor')
export const isRunningRuns = (call: AdoCall) => isBuildList(call) && call.query.get('statusFilter') === 'inProgress'
export const isBuildsByIds = (call: AdoCall) => isBuildList(call) && call.query.has('buildIds')
export const isOneBuild = (call: AdoCall) => call.method === 'GET' && ONE_BUILD.test(call.path)
export const isTimeline = (call: AdoCall) => call.method === 'GET' && TIMELINE.test(call.path)
export const isLogs = (call: AdoCall) => call.method === 'GET' && LOGS.test(call.path)
export const isLogLines = (call: AdoCall) => call.method === 'GET' && LOG_LINES.test(call.path)
export const isApprovals = (call: AdoCall) => call.method === 'GET' && APPROVALS.test(call.path)
export const isApprovalPatch = (call: AdoCall) => call.method === 'PATCH' && APPROVALS.test(call.path)
export const isStagePatch = (call: AdoCall) => call.method === 'PATCH' && STAGE.test(call.path)
export const isBuildPatch = (call: AdoCall) => call.method === 'PATCH' && ONE_BUILD.test(call.path)
export const isCheckSuite = (call: AdoCall) => call.method === 'GET' && CHECK_SUITE.test(call.path)

export function runsProjectOf(call: AdoCall): string | undefined {
  return [BUILD_LIST, ONE_BUILD, TIMELINE, LOGS, LOG_LINES, STAGE, APPROVALS, CHECK_SUITE].map(pattern => pattern.exec(call.path)?.[1]).find(Boolean)
}

export function buildIdOf(call: AdoCall): number {
  return Number([ONE_BUILD, TIMELINE, LOGS, LOG_LINES, STAGE].map(pattern => pattern.exec(call.path)?.[2]).find(Boolean))
}

export interface FakeRuns {
  builds: Map<number, RawBuild>
  timelines: Map<number, RawTimeline>
  approvals: Map<string, RawApproval>
}

export type FakePipelines = FakeAdo & { runs: FakeRuns }

export function fakePipelines(): FakePipelines {
  const ado = fakeAdo()
  const runs: FakeRuns = { builds: new Map(), timelines: new Map(), approvals: new Map() }
  for (const raw of [...builds('builds-running'), ...builds('builds-mine')]) runs.builds.set(raw.id, raw)
  runs.timelines.set(4520, fixture<RawTimeline>('timeline-4520'))
  runs.timelines.set(4531, fixture<RawTimeline>('timeline-4520'))
  runs.timelines.set(4512, fixture<RawTimeline>('timeline-4512'))
  for (const raw of fixture<{ value: RawApproval[] }>('approvals-pending').value) runs.approvals.set(raw.id, raw)

  const inProject = (call: AdoCall) => (build: RawBuild) => build.project.id === runsProjectOf(call)
  const found = (call: AdoCall) => {
    const build = runs.builds.get(buildIdOf(call))
    return build && inProject(call)(build) ? build : undefined
  }
  const missing = (call: AdoCall) => json(404, { message: `The requested build ${buildIdOf(call)} could not be found.` })
  const approvalProject = (raw: RawApproval) => runs.builds.get(raw.pipeline?.owner?.id ?? 0)?.project.id ?? PROJECT

  ado.on(isRepositories, () => json(200, fixture('repositories')))
  ado.on(isBuildList, call => json(200, { value: structuredClone(listed(call, [...runs.builds.values()].filter(inProject(call)))) }))
  ado.on(isOneBuild, call => {
    const build = found(call)
    return build ? json(200, structuredClone(build)) : missing(call)
  })
  ado.on(isBuildPatch, call => {
    const build = found(call)
    if (!build) return missing(call)
    Object.assign(build, call.body)
    return json(200, structuredClone(build))
  })
  ado.on(isStagePatch, call => (found(call) ? json(200, {}) : missing(call)))
  ado.on(isTimeline, call => {
    const build = found(call)
    if (!build) return missing(call)
    return json(200, structuredClone(runs.timelines.get(build.id) ?? { changeId: 0, records: [] }))
  })
  ado.on(isLogs, call => {
    const build = found(call)
    if (!build) return missing(call)
    return json(200, build.id === 4512 ? fixture('logs-4512') : { count: 0, value: [] })
  })
  ado.on(isLogLines, call => {
    const logId = Number(LOG_LINES.exec(call.path)?.[3])
    return found(call)?.id === 4512 && logId === 9 ? json(200, fixture('log-4512-9')) : json(404, { message: `The log ${logId} could not be found.` })
  })
  ado.on(isApprovals, call => {
    const ids = call.query.get('approvalIds')?.toLowerCase().split(',')
    const value = [...runs.approvals.values()].filter(
      raw => approvalProject(raw) === runsProjectOf(call) && (ids ? ids.includes(raw.id.toLowerCase()) : raw.status === 'pending')
    )
    return json(200, { count: value.length, value: structuredClone(value) })
  })
  ado.on(isApprovalPatch, call => {
    const value: RawApproval[] = []
    for (const { approvalId, status, comment } of call.body as { approvalId: string; status: string; comment: string }[]) {
      const raw = runs.approvals.get(approvalId)
      if (!raw) return json(404, { message: `Approval ${approvalId} could not be found.` })
      const step = raw.steps?.find(entry => entry.status === 'pending')
      if (step) Object.assign(step, { status, comment, actualApprover: { id: ME, displayName: 'Alex Contoso', uniqueName: 'alex@contoso.example' } })
      const approved = (raw.steps ?? []).filter(entry => entry.status === 'approved').length
      raw.status = status === 'rejected' ? 'rejected' : approved >= (raw.minRequiredApprovers ?? 1) ? 'approved' : 'pending'
      value.push(raw)
    }
    return json(200, { count: value.length, value: structuredClone(value) })
  })
  ado.on(isCheckSuite, call =>
    CHECK_SUITE.exec(call.path)?.[2] === CHECK_SUITE_4520 ? json(200, fixture('check-suite-4520')) : json(404, { message: 'The check suite could not be found.' })
  )
  return Object.assign(ado, { runs })
}

function builds(name: string): RawBuild[] {
  return fixture<{ value: RawBuild[] }>(name).value
}

function listed(call: AdoCall, all: RawBuild[]): RawBuild[] {
  const ids = call.query.get('buildIds')?.split(',').map(Number)
  const requestedFor = call.query.get('requestedFor')?.toLowerCase()
  const minTime = call.query.get('minTime')
  const top = Number(call.query.get('$top') ?? Infinity)
  return all
    .filter(build => !ids || ids.includes(build.id))
    .filter(build => !requestedFor || build.requestedFor?.id.toLowerCase() === requestedFor)
    .filter(build => call.query.get('statusFilter') !== 'inProgress' || build.status === 'inProgress')
    .filter(build => !minTime || Date.parse(build.queueTime ?? '') >= Date.parse(minTime))
    .sort((a, b) => Date.parse(b.queueTime ?? '') - Date.parse(a.queueTime ?? ''))
    .slice(0, top)
}
