import type { RawPullRequest } from '../ado/pullrequests'
import { fakeAdo, fixture, json, ORG, ORG_URL, type AdoCall, type FakeAdo } from '../boards/fake-ado'

export const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
export const PLATFORM = '2b3c4d5e-7777-4f8a-9b0c-1d2e3f4a5b6c'

const WORK_ITEMS: Record<number, number[]> = { 4104: [1205], 4105: [1210], 4090: [1198], 4091: [1199] }
const FIXTURE_WORK_ITEMS = new Set([4101, 4102, 4103])

const PR_LIST = /^\/[^/]+\/([^/]+)\/_apis\/git\/pullrequests$/
const ONE_PR = /^\/[^/]+\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullrequests\/(\d+)$/i
const PR_WORK_ITEMS = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/workitems$/
const PR_REVIEWERS = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/reviewers$/

export const isRepositories = (call: AdoCall) => call.method === 'GET' && call.path === `/${ORG}/_apis/git/repositories`
export const isPrList = (call: AdoCall) => call.method === 'GET' && PR_LIST.test(call.path)
export const isMineActive = (call: AdoCall) => isMine(call) && call.query.get('searchCriteria.status') === 'active'
export const isMineCompleted = (call: AdoCall) => isMine(call) && call.query.get('searchCriteria.status') === 'completed'
export const isReviewList = (call: AdoCall) => isPrList(call) && call.query.has('searchCriteria.reviewerId')
export const isOnePr = (call: AdoCall) => call.method === 'GET' && ONE_PR.test(call.path) && known(Number(ONE_PR.exec(call.path)?.[1])) !== undefined
export const isPrWorkItems = (call: AdoCall) => call.method === 'GET' && PR_WORK_ITEMS.test(call.path)
export const isEvaluations = (call: AdoCall) => call.method === 'GET' && call.path.endsWith('/_apis/policy/evaluations')

export function projectOf(call: AdoCall): string | undefined {
  return PR_LIST.exec(call.path)?.[1]
}

export function fakePrs(): FakeAdo {
  const ado = fakeAdo()
  ado.on(isRepositories, () => json(200, fixture('repositories')))
  ado.on(isPrList, call => json(200, { value: listed(call).filter(pr => pr.repository.project.id === projectOf(call)) }))
  ado.on(isOnePr, call => json(200, known(Number(ONE_PR.exec(call.path)?.[1]))))
  ado.on(isPrWorkItems, call => json(200, workItemsOf(Number(PR_WORK_ITEMS.exec(call.path)?.[1]))))
  ado.on(call => call.method === 'GET' && PR_REVIEWERS.test(call.path), () => json(200, fixture('pull-request-reviewers')))
  return ado
}

function isMine(call: AdoCall): boolean {
  return isPrList(call) && call.query.has('searchCriteria.creatorId')
}

function listed(call: AdoCall): RawPullRequest[] {
  if (isReviewList(call)) return pullRequests('pull-requests-review')
  return pullRequests(isMineCompleted(call) ? 'pull-requests-completed' : 'pull-requests-mine')
}

function known(prId: number): RawPullRequest | undefined {
  return ['pull-requests-mine', 'pull-requests-completed', 'pull-requests-review'].flatMap(pullRequests).find(pr => pr.pullRequestId === prId)
}

function pullRequests(name: string): RawPullRequest[] {
  return fixture<{ value: RawPullRequest[] }>(name).value
}

function workItemsOf(prId: number): unknown {
  if (FIXTURE_WORK_ITEMS.has(prId)) return fixture('pull-request-workitems')
  const ids = WORK_ITEMS[prId] ?? []
  return { count: ids.length, value: ids.map(id => ({ id: String(id), url: `${ORG_URL}/_apis/wit/workItems/${id}` })) }
}
