import { mock } from 'node:test'
import { mockHost, mountWorker, type TestWorker } from 'orca/testing'
import type { RawApproval } from '../ado/approvals'
import type { RawBuild } from '../ado/builds'
import type { RawPullRequest } from '../ado/pullrequests'
import { basicAuth } from '../auth/pat'
import { BOARDS, fixture, json, type AdoCall, type FakeAdo } from '../boards/fake-ado'
import * as worker from '../main'
import { fakePipelines, type FakePipelines } from '../pipelines/fake-pipelines'
import { fakePrs, isOnePr, isPrList, isPrWorkItems, isReviewList, isThreads, ME, PLATFORM, projectOf } from '../prs/fake-prs'
import { drain } from '../test-support'

export const T0 = Date.parse('2026-11-05T10:00:00Z')
const PAT = 'pat-sim-1'
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'

export interface Sim {
  w: TestWorker
  host: ReturnType<typeof mockHost>
  runs: FakePipelines
  prs: FakeAdo
  reviews: RawPullRequest[]
  now(): number
  tick(ms: number): Promise<void>
  until(done: () => boolean, limitMs: number): Promise<number>
}

export async function simulate(settings: Record<string, unknown>, run: (sim: Sim) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 })
  const runs = fakePipelines()
  const prs = fakePrs()
  const reviews = structuredClone(fixture<{ value: RawPullRequest[] }>('pull-requests-review').value)
  prs.on(isReviewList, call => json(200, { value: reviews.filter(pr => pr.repository.project.id === projectOf(call)) }))
  const aMinuteEarlier = (text: string | undefined) => (text === undefined ? undefined : new Date(Date.parse(text) - 60_000).toISOString())
  for (const raw of runs.runs.builds.values()) {
    Object.assign(raw, { queueTime: aMinuteEarlier(raw.queueTime), startTime: aMinuteEarlier(raw.startTime), finishTime: aMinuteEarlier(raw.finishTime) })
  }
  for (const raw of runs.runs.approvals.values()) raw.createdOn = aMinuteEarlier(raw.createdOn)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = toCall(input, init)
    if (call.host === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
    if (call.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
    if (call.path === '/contoso/_apis/connectionData') {
      return json(200, { authenticatedUser: { id: ME, providerDisplayName: 'Ada', properties: { Account: { $value: 'ada@contoso.com' } } } })
    }
    return (isPrsCall(call) ? prs : runs).fetch(input, init)
  }) as typeof fetch
  const host = mockHost({
    capabilities: ['storage:own', 'secrets:own', 'settings:own', 'notifications:show', 'workspace:read', 'workspace:write'],
    storage: {
      orgs: [
        {
          org: 'contoso',
          url: 'https://dev.azure.com/contoso',
          tenantId: TENANT,
          method: 'pat',
          pinned: { adoId: ME, uniqueName: 'ada@contoso.com', displayName: 'Ada', tenantId: TENANT, objectId: null },
          boards: BOARDS,
          codeProjects: 'all'
        }
      ]
    },
    secrets: { 'pat:contoso': PAT },
    settings: settings as never,
    results: { 'notifications.show': { delivered: true } }
  })
  const tick = async (ms: number) => {
    for (let done = 0; done < ms; done += 1_000) {
      mock.timers.tick(Math.min(1_000, ms - done))
      await drain(30)
    }
  }
  const until = async (done: () => boolean, limitMs: number) => {
    const start = Date.now()
    while (!done()) {
      if (Date.now() - start > limitMs) return Infinity
      await tick(1_000)
    }
    return Date.now() - start
  }
  try {
    const w = await mountWorker(worker, { host })
    try {
      await drain()
      await run({ w, host, runs, prs, reviews, now: () => Date.now() - T0, tick, until })
    } finally {
      await w.deactivate()
    }
  } finally {
    globalThis.fetch = realFetch
    mock.timers.reset()
  }
}

export function buildInPlatform(build: Partial<RawBuild> & { id: number }): RawBuild {
  const base = structuredClone(fixture<{ value: RawBuild[] }>('builds-mine').value[1])
  return { ...base, ...build, project: { ...base.project, id: PLATFORM, name: 'Fabrikam Platform' } } as RawBuild
}

export function approvalFor(buildId: number, id: string): RawApproval {
  const base = structuredClone(fixture<{ value: RawApproval[] }>('approvals-pending').value[1])
  return { ...base, id, pipeline: { ...base.pipeline, owner: { ...base.pipeline?.owner, id: buildId } }, createdOn: new Date().toISOString() } as RawApproval
}

export function prInPlatform(base: RawPullRequest, prId: number): RawPullRequest {
  return { ...structuredClone(base), pullRequestId: prId, repository: { ...base.repository, project: { ...base.repository.project, id: PLATFORM } } }
}

function isPrsCall(call: AdoCall): boolean {
  const listsMineOrReviews = isPrList(call) && (call.query.has('searchCriteria.creatorId') || call.query.has('searchCriteria.reviewerId'))
  return listsMineOrReviews || isThreads(call) || isPrWorkItems(call) || isOnePr(call)
}

function toCall(input: RequestInfo | URL, init?: RequestInit): AdoCall {
  const url = new URL(String(input))
  return {
    method: init?.method ?? 'GET',
    host: url.host,
    path: decodeURIComponent(url.pathname),
    headers: new Headers(init?.headers),
    query: url.searchParams,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    signal: init?.signal ?? undefined
  }
}
