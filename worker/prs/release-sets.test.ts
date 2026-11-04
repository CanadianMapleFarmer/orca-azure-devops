import { assert, test } from 'orca/testing'
import type { PrReviewer, PrSummary } from '../../src/shared/prs'
import { COMPLETED_WINDOW_MS, releaseSets, toReviewOf } from './release-sets'

const ORG = 'contoso'
const WEB_APP = '5f3a9c1e-1111-4a2b-8c3d-4e5f6a7b8c9d'
const API = '6a4b0d2f-2222-4b3c-9d4e-5f6a7b8c9d0e'
const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
const NOW = Date.parse('2026-11-05T12:00:00Z')
const HOUR = 60 * 60_000
const FEATURE = 'feature/PROJ-55283-login'

let sequence = 0

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  const prId = overrides.prId ?? 1000 + ++sequence
  return {
    org: ORG,
    projectId: 'proj-1',
    projectName: 'Fabrikam Web',
    repoId: WEB_APP,
    repoName: 'web-app',
    prId,
    title: `Change ${prId}`,
    url: `https://dev.azure.com/${ORG}/Fabrikam%20Web/_git/web-app/pullrequest/${prId}`,
    source: FEATURE,
    target: 'develop',
    status: 'active',
    isDraft: false,
    mergeStatus: 'ok',
    createdBy: { id: ME, name: 'Alex Morgan' },
    createdAt: NOW - HOUR,
    closedAt: null,
    reviewers: [],
    autoComplete: false,
    workItemIds: [],
    checks: null,
    ...overrides
  }
}

function reviewer(overrides: Partial<PrReviewer> = {}): PrReviewer {
  return { id: ME, name: 'Alex Morgan', uniqueName: 'alex@contoso.example', vote: 0, isRequired: false, isGroup: false, hasDeclined: false, ...overrides }
}

function completed(ageMs: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return pr({ status: 'completed', closedAt: NOW - ageMs, ...overrides })
}

const idsOf = (prs: PrSummary[]) => prs.map(item => item.prId)

test('PRs from one source branch form one set, one row per target, ordered by id', () => {
  const qa = pr({ prId: 302, target: 'qa' })
  const main = pr({ prId: 303, target: 'main' })
  const develop = pr({ prId: 301, target: 'develop' })
  const other = pr({ prId: 400, source: 'feature/other', title: 'Other change' })
  const input = [qa, other, main, develop]

  const sets = releaseSets(input, NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)), [[400], [301, 302, 303]])
  assert.deepEqual(sets[1].prs.map(item => item.target), ['develop', 'qa', 'main'])
  assert.deepEqual(idsOf(input), [302, 400, 303, 301])
})

test('the same source branch name in two repos stays two sets', () => {
  const sets = releaseSets([pr({ prId: 11, repoId: WEB_APP }), pr({ prId: 12, repoId: API, repoName: 'api' })], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)).sort(), [[11], [12]])
})

test('a shared linked work item joins PRs across repos and branches', () => {
  const web = pr({ prId: 21, source: 'feature/web-login', workItemIds: [55283, 55290] })
  const api = pr({ prId: 22, repoId: API, repoName: 'api', source: 'feature/api-login', target: 'qa', workItemIds: [55283] })
  const chained = pr({ prId: 23, repoId: API, repoName: 'api', source: 'hotfix/api-token', target: 'main', workItemIds: [55290, 60001] })
  const unrelated = pr({ prId: 24, source: 'feature/unrelated', workItemIds: [70000] })

  const sets = releaseSets([unrelated, chained, api, web], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)), [[24], [21, 22, 23]])
  assert.deepEqual(sets[1].workItemIds, [55283, 55290, 60001])
})

test('completed PRs join their set only within 14 days, and a set with no active PR is dropped', () => {
  const active = pr({ prId: 31, target: 'develop' })
  const recent = completed(COMPLETED_WINDOW_MS - HOUR, { prId: 32, target: 'qa' })
  const edge = completed(COMPLETED_WINDOW_MS, { prId: 33, target: 'main' })
  const stale = completed(COMPLETED_WINDOW_MS + 1, { prId: 34, target: 'release' })
  const finishedOnly = completed(HOUR, { prId: 35, source: 'feature/shipped' })

  const sets = releaseSets([stale, edge, finishedOnly, recent, active], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)), [[31, 32, 33]])
})

test('a completed PR outside the window does not bridge two sets', () => {
  const first = pr({ prId: 41, source: 'feature/one', workItemIds: [1] })
  const second = pr({ prId: 43, source: 'feature/two', workItemIds: [2] })
  const bridge = completed(COMPLETED_WINDOW_MS + HOUR, { prId: 42, source: 'feature/three', workItemIds: [1, 2] })

  const sets = releaseSets([first, bridge, second], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)).sort(), [[41], [43]])
})

test('a completed PR without a closed date is ignored', () => {
  const sets = releaseSets([pr({ prId: 51 }), pr({ prId: 52, status: 'completed', closedAt: null, target: 'qa' })], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)), [[51]])
})

test('abandoned PRs never appear', () => {
  const active = pr({ prId: 61, workItemIds: [9] })
  const sameSource = pr({ prId: 62, status: 'abandoned', target: 'qa' })
  const sameWorkItem = pr({ prId: 63, status: 'abandoned', source: 'feature/dropped', workItemIds: [9] })
  const abandonedOnly = pr({ prId: 64, status: 'abandoned', source: 'feature/gone' })

  const sets = releaseSets([sameWorkItem, abandonedOnly, sameSource, active], NOW)

  assert.deepEqual(sets.map(set => idsOf(set.prs)), [[61]])
  assert.deepEqual(sets[0].workItemIds, [9])
})

test('the set key stays the same when a later PR joins', () => {
  const develop = pr({ prId: 71, target: 'develop' })
  const qa = pr({ prId: 72, target: 'qa' })
  const main = pr({ prId: 73, target: 'main' })

  const before = releaseSets([develop, qa], NOW)
  const after = releaseSets([main, qa, develop], NOW)

  assert.equal(before[0].key, `${ORG}:71`)
  assert.equal(after[0].key, before[0].key)
  assert.equal(after[0].prs.length, 3)
})

test("title is the lowest PR's title and sources lists distinct branches", () => {
  const second = pr({ prId: 82, title: 'Second title', source: FEATURE, target: 'qa' })
  const third = pr({ prId: 83, repoId: API, repoName: 'api', title: 'Third title', source: 'release/login', target: 'main', workItemIds: [5] })
  const first = pr({ prId: 81, title: '[PROJ-55283] First title', source: FEATURE, workItemIds: [5] })

  const [set] = releaseSets([third, second, first], NOW)

  assert.equal(set.title, '[PROJ-55283] First title')
  assert.deepEqual(set.sources, [FEATURE, 'release/login'])
})

test('sets are ordered newest first', () => {
  const oldest = pr({ prId: 91, source: 'feature/a', createdAt: NOW - 5 * HOUR })
  const middle = pr({ prId: 92, source: 'feature/b', createdAt: NOW - 3 * HOUR })
  const middleLater = pr({ prId: 93, source: 'feature/b', target: 'qa', createdAt: NOW - 4 * HOUR })
  const newest = pr({ prId: 94, source: 'feature/c', createdAt: NOW - HOUR })
  const joinsOldest = pr({ prId: 95, source: 'feature/a', target: 'main', createdAt: NOW - 2 * HOUR })

  const sets = releaseSets([middle, oldest, newest, middleLater, joinsOldest], NOW)

  assert.deepEqual(sets.map(set => set.key), [`${ORG}:94`, `${ORG}:91`, `${ORG}:92`])
})

test('sets created at the same moment are ordered by their key, highest id first', () => {
  const sets = releaseSets([pr({ prId: 101, source: 'a' }), pr({ prId: 103, source: 'c' }), pr({ prId: 102, source: 'b' })], NOW)

  assert.deepEqual(sets.map(set => set.key), [`${ORG}:103`, `${ORG}:102`, `${ORG}:101`])
})

test('no PRs give no sets', () => {
  assert.deepEqual(releaseSets([], NOW), [])
})

test('toReviewOf skips drafts, my own PRs, PRs I voted on and PRs I declined', () => {
  const waiting = pr({ prId: 201, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer()], createdAt: NOW - 3 * HOUR })
  const newer = pr({ prId: 202, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer({ id: GRACE }), reviewer()], createdAt: NOW - HOUR })
  const draft = pr({ prId: 203, isDraft: true, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer()] })
  const mine = pr({ prId: 204, reviewers: [reviewer()] })
  const approved = pr({ prId: 205, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer({ vote: 10 })] })
  const waitingForAuthor = pr({ prId: 206, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer({ vote: -5 })] })
  const declined = pr({ prId: 207, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer({ hasDeclined: true })] })
  const notAReviewer = pr({ prId: 208, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer({ id: GRACE })] })
  const finished = pr({ prId: 209, status: 'completed', closedAt: NOW, createdBy: { id: GRACE, name: 'Grace Hopper' }, reviewers: [reviewer()] })
  const input = [waiting, draft, mine, approved, newer, waitingForAuthor, declined, notAReviewer, finished]

  assert.deepEqual(idsOf(toReviewOf(input, ME)), [202, 201])
  assert.deepEqual(idsOf(input), [201, 203, 204, 205, 202, 206, 207, 208, 209])
})

test('toReviewOf ignores the case of identity ids', () => {
  const upper = pr({ prId: 211, createdBy: { id: GRACE.toUpperCase(), name: 'Grace Hopper' }, reviewers: [reviewer({ id: ME.toUpperCase() })] })
  const own = pr({ prId: 212, createdBy: { id: ME.toUpperCase(), name: 'Alex Morgan' }, reviewers: [reviewer()] })

  assert.deepEqual(idsOf(toReviewOf([upper, own], ME)), [211])
})
