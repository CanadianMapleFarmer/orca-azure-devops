import { assert, test } from 'orca/testing'
import type { ReviewKey, ReviewResult, VoteChoice } from '../../src/shared/reviews'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import { fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { ME } from '../prs/fake-prs'
import { fakeReviews, isChanges, isIterations, isThreadGet, type FakeReviews } from './fake-reviews'
import { createReviewActions } from './actions'
import { createReviews } from './service'

const KEY: ReviewKey = { org: ORG, projectId: PROJECT, repoId: REPO, prId: 4110 }
const PR = `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4110`
const SOURCE = '4110a2000000000000000000000000000000a002'
const NEWER = '4110a3000000000000000000000000000000a003'
const REDIRECT = '/src/auth/redirect.ts'
const REDIRECT_TEST = '/src/auth/redirect.test.ts'
const LEGACY = '/src/auth/legacy-return.ts'
const LOCK = '/assets/lock.png'
const CHANGED_OBJECT = 'b10b0002000000000000000000000000000000b2'
const NOT_CONNECTED = 'Connect this organization first.'
const CLOSED = 'This pull request is no longer active.'
const DRAFT = 'Votes are off while a pull request is a draft.'
const THREAD_GONE = 'That comment thread no longer exists.'
const NOT_IN_PR = "That file isn't changed in this pull request any more."
const EMPTY = 'Write a comment first.'
const TOO_LONG = 'Keep the comment under 10,000 characters.'
const BAD_LINE = 'Enter the line as a whole number from 1 up.'
const BINARY = 'Binary files take comments on the whole file only.'
const UNCHECKED = 'This file is too large to check the line. Comment on the whole file, or comment in Azure DevOps.'
const NO_LINES = 'This file has no lines; comment on the whole file instead.'
const DENIED = 'TF401027: You need the Git "PullRequestContribute" permission.'

const isVotePut = (call: AdoCall) => call.method === 'PUT' && call.path.startsWith(`${PR}/reviewers/`)
const isReplyPost = (call: AdoCall) => call.method === 'POST' && /\/threads\/\d+\/comments$/.test(call.path)
const isThreadPost = (call: AdoCall) => call.method === 'POST' && call.path === `${PR}/threads`
const isThreadPatch = (call: AdoCall) => call.method === 'PATCH' && /\/threads\/\d+$/.test(call.path)
const writesIn = (calls: readonly AdoCall[]) => calls.filter(call => call.method !== 'GET')

function status(): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

function harness(after: (org: string) => unknown = () => {}) {
  const ado = fakeReviews()
  const orgs = [status()]
  const connected = async (org: string) => {
    if (org !== ORG) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return 'Bearer test-credential'
  }
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: connected, sleep: async () => {} })
  const reviews = createReviews({ http, orgs: async () => structuredClone(orgs), now: () => 0 })
  reviews.onOrgs(structuredClone(orgs))
  const refreshed: string[] = []
  const actions = createReviewActions({
    http,
    reviews,
    me: async org => {
      await connected(org)
      return ME
    },
    after: org => {
      refreshed.push(org)
      return after(org) as void
    }
  })
  ado.on(isVotePut, call => json(200, { id: ME, displayName: 'Alex Contoso', ...call.body }))
  ado.on(isThreadPost, call => json(200, { id: 201, status: 'active', comments: call.body.comments }))
  ado.on(isReplyPost, call => json(200, { id: 9, ...call.body }))
  ado.on(isThreadPatch, call => json(200, { id: Number(call.path.split('/').pop()), ...call.body }))
  return { ado, reviews, actions, refreshed }
}

function myVote(ado: FakeReviews, vote: number, isRequired = true): void {
  ado.review.pr!.reviewers = [{ id: ME, displayName: 'Alex Contoso', vote, isRequired }]
}

function thread(ado: FakeReviews, id: number) {
  const found = ado.review.threads.find(item => item.id === id)
  assert.ok(found, `thread ${id} is in the fixture`)
  return found
}

function withChangedRedirectTest(ado: FakeReviews, content: string): void {
  ado.review.files[`${SOURCE}:${REDIRECT_TEST}`] = { objectId: CHANGED_OBJECT, content, isBinary: false }
  const changes = fixture<{ changeEntries: Record<string, any>[] }>('pr-changes-4110')
  changes.changeEntries[1].item.objectId = CHANGED_OBJECT
  ado.on(isChanges, () => json(200, changes))
}

function refused(message: string): ReviewResult {
  return { ok: false, message }
}

function posted(message: string): ReviewResult {
  return { ok: true, message }
}

async function until(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !reached(); turn++) await new Promise(resolve => setImmediate(resolve))
}

test('writes read fresh and report what Azure DevOps did', async () => {
  const { ado, reviews, actions, refreshed } = harness()
  await reviews.open(KEY)

  ado.review.pr!.status = 'completed'
  assert.deepEqual(await actions.vote({ ...KEY, vote: 'approve' }), refused(CLOSED))
  assert.deepEqual(writesIn(ado.calls), [])
  assert.deepEqual(refreshed, [])
  ado.review.pr!.status = 'active'

  thread(ado, 101).isDeleted = true
  assert.deepEqual(await actions.reply({ ...KEY, threadId: 101, text: 'Thanks' }), refused(THREAD_GONE))
  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 101, status: 'fixed' }), refused(THREAD_GONE))
  assert.deepEqual(await actions.reply({ ...KEY, threadId: 999, text: 'Thanks' }), refused(THREAD_GONE))
  assert.deepEqual(writesIn(ado.calls), [])

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Off by one?', path: REDIRECT, line: 120 }), refused('Pick a line from 1 to 64.'))
  assert.deepEqual(writesIn(ado.calls), [])

  const iterations = fixture<{ value: Record<string, any>[] }>('pr-iterations-4110')
  iterations.value.push({ ...iterations.value[1], id: 3, sourceRefCommit: { commitId: NEWER } })
  ado.on(isIterations, () => json(200, iterations))
  const changes = fixture<{ changeEntries: { item: { path: string } }[] }>('pr-changes-4110')
  changes.changeEntries = changes.changeEntries.filter(entry => entry.item.path !== REDIRECT)
  ado.on(isChanges, call => (call.path.includes('/iterations/3/') ? json(200, changes) : json(200, fixture('pr-changes-4110'))))
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Still here?', path: REDIRECT }), refused(NOT_IN_PR))
  assert.deepEqual(writesIn(ado.calls), [])

  const large = harness()
  withChangedRedirectTest(large.ado, 'it("works")\n'.repeat(200_000))
  assert.deepEqual(await large.actions.comment({ ...KEY, text: 'Line 5?', path: REDIRECT_TEST, line: 5 }), refused(UNCHECKED))
  assert.deepEqual(writesIn(large.ado.calls), [])
  const whole = await large.actions.comment({ ...KEY, text: 'Too big to review here', path: REDIRECT_TEST })
  assert.deepEqual(whole, posted(`Comment posted on ${REDIRECT_TEST}.`))
  assert.equal(large.ado.count(isThreadPost), 1)

  const denied = harness()
  denied.ado.on(isVotePut, () => json(403, { message: DENIED }))
  assert.deepEqual(await denied.actions.vote({ ...KEY, vote: 'approve' }), refused(DENIED))
  assert.equal(denied.ado.count(isVotePut), 1)
  assert.deepEqual(denied.refreshed, [ORG])
})

test('each vote sends its value and says what was recorded', async () => {
  const cases: [VoteChoice, number, string][] = [
    ['approve', 10, 'Approved.'],
    ['suggestions', 5, 'Approved with suggestions.'],
    ['waitForAuthor', -5, 'Marked as waiting for the author.'],
    ['reject', -10, 'Rejected.']
  ]
  for (const [choice, value, message] of cases) {
    const { ado, actions } = harness()
    assert.deepEqual(await actions.vote({ ...KEY, vote: choice }), posted(message))
    const [put] = ado.calls.filter(isVotePut)
    assert.equal(put.path, `${PR}/reviewers/${ME}`)
    assert.deepEqual(put.body, { vote: value, isRequired: true })
    assert.equal(ado.count(isVotePut), 1)
  }

  const { ado, actions } = harness()
  ado.review.pr!.reviewers = []
  await actions.vote({ ...KEY, vote: 'suggestions' })
  assert.deepEqual(ado.calls.find(isVotePut)?.body, { vote: 5, isRequired: false })

  const differing = harness()
  differing.ado.on(isVotePut, call => json(200, { id: ME, ...call.body, vote: 5 }))
  assert.deepEqual(await differing.actions.vote({ ...KEY, vote: 'approve' }), {
    ok: true,
    warn: true,
    message: 'Azure DevOps recorded your vote as Approved with suggestions.'
  })
  differing.ado.on(isVotePut, () => json(200, { id: ME, isRequired: true }))
  assert.deepEqual(await differing.actions.vote({ ...KEY, vote: 'reject' }), {
    ok: true,
    warn: true,
    message: 'Azure DevOps recorded your vote as No vote.'
  })
})

test('a vote already cast makes no call', async () => {
  const { ado, actions, refreshed } = harness()
  myVote(ado, 10)
  assert.deepEqual(await actions.vote({ ...KEY, vote: 'approve' }), posted('You already voted: Approved.'))
  assert.equal(ado.calls.length, 1)
  assert.deepEqual(writesIn(ado.calls), [])
  assert.deepEqual(refreshed, [])

  myVote(ado, -5)
  assert.deepEqual(await actions.vote({ ...KEY, vote: 'waitForAuthor' }), posted('You already voted: Waiting for author.'))
  assert.deepEqual(writesIn(ado.calls), [])

  assert.deepEqual(await actions.vote({ ...KEY, vote: 'approve' }), posted('Approved.'))
  assert.equal(ado.count(isVotePut), 1)
})

test('votes are off on a draft and on an abandoned pull request', async () => {
  const { ado, actions } = harness()
  ado.review.pr!.isDraft = true
  assert.deepEqual(await actions.vote({ ...KEY, vote: 'approve' }), refused(DRAFT))
  ado.review.pr!.isDraft = false
  ado.review.pr!.status = 'abandoned'
  assert.deepEqual(await actions.vote({ ...KEY, vote: 'reject' }), refused(CLOSED))
  assert.deepEqual(writesIn(ado.calls), [])
})

test('a vote refreshes the PR list afterwards, unawaited', async () => {
  let settled = false
  const { actions, refreshed } = harness(() => new Promise<void>(() => {}))
  const voting = actions.vote({ ...KEY, vote: 'approve' }).then(result => {
    settled = true
    return result
  })
  await until(() => settled)
  assert.ok(settled, 'the vote waited for the refresh')
  assert.deepEqual(await voting, posted('Approved.'))
  assert.deepEqual(refreshed, [ORG])
})

test('replies, resolving and comments leave the PR list alone', async () => {
  const { actions, refreshed } = harness()
  await actions.reply({ ...KEY, threadId: 101, text: 'Thanks' })
  await actions.setStatus({ ...KEY, threadId: 101, status: 'fixed' })
  await actions.comment({ ...KEY, text: 'Nice' })
  assert.deepEqual(refreshed, [])
})

test("reply posts under the thread's first comment", async () => {
  const { ado, actions } = harness()
  assert.deepEqual(await actions.reply({ ...KEY, threadId: 101, text: '  Thanks, decoding first now.  ' }), posted('Reply posted.'))
  const [post] = ado.calls.filter(isReplyPost)
  assert.equal(post.path, `${PR}/threads/101/comments`)
  assert.deepEqual(post.body, { content: 'Thanks, decoding first now.', parentCommentId: 1, commentType: 'text' })
  assert.equal(ado.count(isThreadGet), 1)

  const base = thread(ado, 101)
  ado.review.threads.push({ ...structuredClone(base), id: 150, comments: base.comments!.map((comment, index) => ({ ...comment, id: 7 + index })) })
  await actions.reply({ ...KEY, threadId: 150, text: 'Second' })
  assert.equal(ado.calls.filter(isReplyPost)[1].body.parentCommentId, 7)
  assert.equal(ado.count(isReplyPost), 2)
})

test('resolve and reactivate patch the status and skip a thread already there', async () => {
  const { ado, actions } = harness()
  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 101, status: 'fixed' }), posted('Resolved.'))
  const [resolve] = ado.calls.filter(isThreadPatch)
  assert.equal(resolve.path, `${PR}/threads/101`)
  assert.deepEqual(resolve.body, { status: 'fixed' })

  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 102, status: 'active' }), posted('Reactivated.'))
  assert.deepEqual(ado.calls.filter(isThreadPatch)[1].body, { status: 'active' })
  assert.equal(ado.calls.filter(isThreadPatch)[1].path, `${PR}/threads/102`)

  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 102, status: 'fixed' }), posted('This thread is already resolved.'))
  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 101, status: 'active' }), posted('This thread is already active.'))
  assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 103, status: 'active' }), posted('This thread is already active.'))
  assert.equal(ado.count(isThreadPatch), 2)

  for (const status of ['wontFix', 'closed', 'byDesign']) {
    thread(ado, 101).status = status
    assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 101, status: 'fixed' }), posted('This thread is already resolved.'))
    assert.deepEqual(await actions.setStatus({ ...KEY, threadId: 101, status: 'active' }), posted('Reactivated.'))
  }
  assert.equal(ado.count(isThreadPatch), 5)
})

test('a line comment carries the path, side, line and iteration context; a general comment carries none', async () => {
  const { ado, actions } = harness()
  const context = (changeTrackingId: number) => ({
    changeTrackingId,
    iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 }
  })
  const body = (content: string, extra: object = {}) => ({
    comments: [{ parentCommentId: 0, content, commentType: 'text' }],
    status: 'active',
    ...extra
  })
  const sent = () => ado.calls.filter(isThreadPost).at(-1)?.body

  assert.deepEqual(await actions.comment({ ...KEY, text: '  Looks good overall.  ' }), posted('Comment posted.'))
  assert.deepEqual(sent(), body('Looks good overall.'))
  assert.equal(ado.calls.at(-1)?.path, `${PR}/threads`)
  assert.equal(ado.calls.filter(call => call.method === 'GET').length, 0)

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Why decode here?', path: REDIRECT, line: 42 }), posted(`Comment posted on ${REDIRECT}, line 42.`))
  assert.deepEqual(
    sent(),
    body('Why decode here?', {
      threadContext: { filePath: REDIRECT, rightFileStart: { line: 42, offset: 1 }, rightFileEnd: { line: 42, offset: 1 } },
      pullRequestThreadContext: context(1)
    })
  )

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Why delete this?', path: LEGACY, line: 7 }), posted(`Comment posted on ${LEGACY}, line 7.`))
  assert.deepEqual(
    sent(),
    body('Why delete this?', {
      threadContext: { filePath: LEGACY, leftFileStart: { line: 7, offset: 1 }, leftFileEnd: { line: 7, offset: 1 } },
      pullRequestThreadContext: context(3)
    })
  )

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Whole file', path: REDIRECT }), posted(`Comment posted on ${REDIRECT}.`))
  assert.deepEqual(sent(), body('Whole file', { threadContext: { filePath: REDIRECT }, pullRequestThreadContext: context(1) }))

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Last line', path: REDIRECT, line: 64 }), posted(`Comment posted on ${REDIRECT}, line 64.`))
  assert.deepEqual(await actions.comment({ ...KEY, text: 'First line', path: REDIRECT, line: 1 }), posted(`Comment posted on ${REDIRECT}, line 1.`))
  assert.equal(ado.count(isThreadPost), 6)
})

test('a binary file and an empty file take whole-file comments only', async () => {
  const { ado, actions } = harness()
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Which icon?', path: LOCK, line: 1 }), refused(BINARY))
  assert.deepEqual(writesIn(ado.calls), [])
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Which icon?', path: LOCK }), posted(`Comment posted on ${LOCK}.`))
  assert.equal((ado.calls.filter(isThreadPost)[0].body.pullRequestThreadContext as { changeTrackingId: number }).changeTrackingId, 6)

  withChangedRedirectTest(ado, '')
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Empty?', path: REDIRECT_TEST, line: 1 }), refused(NO_LINES))
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Empty?', path: REDIRECT_TEST }), posted(`Comment posted on ${REDIRECT_TEST}.`))
  assert.equal(ado.count(isThreadPost), 2)

  assert.deepEqual(await actions.comment({ ...KEY, text: 'Gone', path: LEGACY, line: 11 }), refused('Pick a line from 1 to 10.'))
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Nowhere', path: '/src/missing.ts' }), refused(NOT_IN_PR))
  assert.equal(ado.count(isThreadPost), 2)
})

test('empty, overlong and badly numbered comments are refused before any call', async () => {
  const { ado, actions } = harness()
  assert.deepEqual(await actions.comment({ ...KEY, text: '   \n ' }), refused(EMPTY))
  assert.deepEqual(await actions.reply({ ...KEY, threadId: 101, text: '' }), refused(EMPTY))
  assert.deepEqual(await actions.comment({ ...KEY, text: 'x'.repeat(10_001) }), refused(TOO_LONG))
  assert.deepEqual(await actions.reply({ ...KEY, threadId: 101, text: ` ${'x'.repeat(10_001)} ` }), refused(TOO_LONG))
  for (const line of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await actions.comment({ ...KEY, text: 'Hmm', path: REDIRECT, line }), refused(BAD_LINE), `line ${line}`)
  }
  assert.deepEqual(await actions.comment({ ...KEY, text: 'Hmm', line: 3 }), refused(BAD_LINE))
  assert.equal(ado.calls.length, 0)

  assert.deepEqual(await actions.comment({ ...KEY, text: ` ${'x'.repeat(10_000)} ` }), posted('Comment posted.'))
  assert.equal(ado.count(isThreadPost), 1)
})

test('a signed-out organization answers with the message and writes nothing', async () => {
  const { ado, actions } = harness()
  const other = { ...KEY, org: 'fabrikam' }
  const signedOut = refused(NOT_CONNECTED)
  assert.deepEqual(await actions.vote({ ...other, vote: 'approve' }), signedOut)
  assert.deepEqual(await actions.reply({ ...other, threadId: 101, text: 'Hi' }), signedOut)
  assert.deepEqual(await actions.setStatus({ ...other, threadId: 101, status: 'fixed' }), signedOut)
  assert.deepEqual(await actions.comment({ ...other, text: 'Hi' }), signedOut)
  assert.deepEqual(await actions.comment({ ...other, text: 'Hi', path: REDIRECT, line: 2 }), signedOut)
  assert.equal(ado.calls.length, 0)
})
