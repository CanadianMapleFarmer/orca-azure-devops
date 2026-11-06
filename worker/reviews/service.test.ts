import { assert, test } from 'orca/testing'
import type { ReviewKey } from '../../src/shared/reviews'
import type { OrgStatus } from '../../src/shared/types'
import type { RawThread } from '../ado/pr-review'
import { AdoError, createAdoHttp } from '../ado/http'
import { fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { byteLength } from '../budget'
import { isOnePr, ME } from '../prs/fake-prs'
import { diffText, splitLines } from './diff'
import { fakeReviews, isBlob, isChanges, isItem, isIterations, isThreads } from './fake-reviews'
import { createReviews } from './service'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const KEY: ReviewKey = { org: ORG, projectId: PROJECT, repoId: REPO, prId: 4110 }
const PR_URL = `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/4110`
const SOURCE = '4110a2000000000000000000000000000000a002'
const COMMON = '4110c0000000000000000000000000000000c000'
const REDIRECT = '/src/auth/redirect.ts'
const REDIRECT_TEST = '/src/auth/redirect.test.ts'
const LEGACY = '/src/auth/legacy-return.ts'
const AUTH_DOC = '/docs/auth.md'
const LOGIN_DOC = '/docs/login.md'
const LOCK = '/assets/lock.png'
const MIB = 1024 * 1024
const ANSWER_BYTES = 900 * 1024
const NOT_CONNECTED = 'Connect this organization first.'
const GONE = "That pull request no longer exists, or you can't see it."
const NEEDS_CODE_READ = 'Pull requests need Code (Read) access.'
const TRIMMED = 'Some comments were left out to keep this view small. Open the pull request in Azure DevOps to see them all.'
const NO_BASE =
  "Azure DevOps hasn't worked out this pull request's base yet, so the diff can't be shown. Refresh in a moment, or check the branch out in Orca."
const CAPPED = 'More than 1,000 files changed. Open the pull request in Azure DevOps, or check it out in Orca, to see them all.'
const NOT_IN_PR = "That file isn't changed in this pull request any more."
const BINARY = "Binary file; it isn't shown here."
const TOO_LARGE = 'This file is too large to show here. Check out the branch in Orca to see it.'
const RENAMED = 'Renamed from /docs/login.md.'

function status(overrides: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all',
    ...overrides
  }
}

function harness() {
  const ado = fakeReviews()
  let orgs = [status()]
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const reviews = createReviews({ http, orgs: async () => structuredClone(orgs), now: () => T0 })
  reviews.onOrgs(structuredClone(orgs))
  return {
    ado,
    reviews,
    diff: (path: string, key: ReviewKey = KEY) => reviews.diff({ ...key, path }),
    content: (commit: string, path: string) => ado.review.files[`${commit}:${path}`].content,
    since: (count: number) => ado.calls.slice(count),
    setOrgs(next: OrgStatus[]) {
      orgs = next
      reviews.onOrgs(structuredClone(next))
    }
  }
}

function adoError(code: AdoError['code'], status: number, message: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    assert.deepEqual([error.code, error.status, error.message], [code, status, message])
    return true
  }
}

function itemsRead(calls: readonly AdoCall[]): string[] {
  return calls.filter(isItem).map(call => `${call.query.get('versionDescriptor.version')}:${call.query.get('path')}`)
}

function withoutCommon(): unknown {
  const listed = fixture<{ value: Record<string, unknown>[] }>('pr-iterations-4110')
  for (const iteration of listed.value) delete iteration.commonRefCommit
  return listed
}

function lineCount(text: string): number {
  return splitLines(text).length
}

async function until(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !reached(); turn++) await new Promise(resolve => setImmediate(resolve))
}

test('open reads the PR, iteration, changes and threads in four calls', async () => {
  const { ado, reviews } = harness()
  const heldChanges = ado.hold(isChanges)
  const opening = reviews.open(KEY)
  await until(() => ado.count(isThreads) === 1)
  assert.deepEqual([ado.count(isChanges), ado.count(isThreads)], [1, 1], 'threads were not read while changes was still pending')
  heldChanges.release()
  const review = await opening
  assert.equal(ado.calls.length, 4)
  assert.ok(isOnePr(ado.calls[0]), ado.calls[0].path)
  assert.ok(isIterations(ado.calls[1]), ado.calls[1].path)
  const [changes] = ado.calls.filter(isChanges)
  const [threads] = ado.calls.filter(isThreads)
  assert.deepEqual(ado.calls.slice(2).sort((a, b) => a.path.localeCompare(b.path)), [changes, threads].sort((a, b) => a.path.localeCompare(b.path)))
  assert.ok(changes.path.endsWith('/pullRequests/4110/iterations/2/changes'))
  assert.equal(threads.query.get('$iteration'), '2')

  assert.deepEqual(review.key, KEY)
  assert.deepEqual([review.pr.prId, review.pr.title, review.pr.url, review.pr.source], [4110, 'Harden the login redirect', PR_URL, 'hotfix/1211-login-redirect'])
  assert.equal(
    review.description,
    'Fixes the open redirect reported in #1211.\n\n' +
      `[Image: Redirect flow](${PR_URL})\n\n` +
      '@Alex Contoso, could you check the decoding order?\n\n' +
      '- Decode the target once before checking it.\n- Refuse protocol-relative targets.'
  )
  assert.equal(review.myVote, 0)
  assert.deepEqual(review.files, [
    { path: REDIRECT, originalPath: null, kind: 'edited' },
    { path: REDIRECT_TEST, originalPath: null, kind: 'added' },
    { path: LEGACY, originalPath: null, kind: 'deleted' },
    { path: AUTH_DOC, originalPath: LOGIN_DOC, kind: 'renamed' },
    { path: LOCK, originalPath: null, kind: 'added' }
  ])
  assert.equal(review.moreFiles, false)
  assert.deepEqual(review.threads.map(thread => thread.id), [101, 103, 102])
  assert.equal(review.threads[0].comments[0].content, '@Alex Contoso could you look at the decoding order before I merge?')
  assert.deepEqual([review.threadCount, review.loadedAt, 'message' in review], [3, T0, false])

  ado.review.pr!.description = undefined
  assert.equal((await reviews.open(KEY)).description, '')
})

test('diff reads each side once and reuses it', async () => {
  const { ado, reviews, diff, content, since } = harness()
  await reviews.open(KEY)
  let count = ado.calls.length
  const expected = diffText(content(COMMON, REDIRECT), content(SOURCE, REDIRECT))
  const redirect = await diff(REDIRECT)
  assert.deepEqual(redirect, { path: REDIRECT, text: expected.text, lines: { old: 60, new: 64 } })
  assert.match(redirect.text ?? '', /^@@ -37,10 \+37,14 @@\n/)
  assert.equal(since(count).filter(isBlob).length, 2)
  assert.deepEqual(itemsRead(since(count)).sort(), [`${SOURCE}:${REDIRECT}`, `${COMMON}:${REDIRECT}`])
  assert.equal(since(count).length, 4, 'the kept facts serve the diff')

  count = ado.calls.length
  assert.deepEqual(await diff(REDIRECT), redirect)
  assert.equal(since(count).length, 0, 'a repeat makes no calls')

  const deleted = await diff(LEGACY)
  assert.deepEqual([deleted.lines, deleted.message], [{ old: 10, new: null }, undefined])
  assert.match(deleted.text ?? '', /^@@ -1,10 \+0,0 @@\n-\s*1\s+│ /)
  const added = await diff(REDIRECT_TEST)
  assert.deepEqual(added.lines, { old: null, new: 16 })
  assert.deepEqual(itemsRead(since(count)), [`${COMMON}:${LEGACY}`, `${SOURCE}:${REDIRECT_TEST}`])

  for (const prId of [9001, 9002, 9003, 9004, 9005]) await diff(REDIRECT, { ...KEY, prId })
  count = ado.calls.length
  await diff(REDIRECT, { ...KEY, prId: 9005 })
  assert.equal(since(count).length, 0, 'a recent pull request keeps its facts')
  await diff(REDIRECT)
  assert.deepEqual(
    since(count).map(call => (isIterations(call) ? 'iterations' : isChanges(call) ? 'changes' : call.path)),
    ['iterations', 'changes'],
    'the sixth pull request pushed out the first one, and the text stayed cached'
  )

  const fresh = harness()
  const cold = await fresh.diff(REDIRECT)
  assert.deepEqual(cold, redirect)
  assert.deepEqual(fresh.ado.calls.slice(0, 2).map(call => [isIterations(call), isChanges(call)]), [[true, false], [false, true]])
  assert.equal(fresh.ado.count(isOnePr), 0)
})

test('diff says what it can\'t show for renamed, binary and oversized files', async () => {
  const { ado, reviews, diff, content, since } = harness()
  await reviews.open(KEY)
  let count = ado.calls.length
  assert.deepEqual(await diff(AUTH_DOC), { path: AUTH_DOC, text: null, message: RENAMED, lines: { old: 5, new: 5 } })
  assert.deepEqual(itemsRead(since(count)), [`${SOURCE}:${AUTH_DOC}`])

  const lock = content(SOURCE, LOCK)
  assert.deepEqual(await diff(LOCK), { path: LOCK, text: null, message: BINARY, lines: { old: null, new: lineCount(lock) } })

  await assert.rejects(diff('/src/auth/missing.ts'), adoError('bad_request', 400, NOT_IN_PR))

  const large = harness()
  large.ado.review.files[`${SOURCE}:${REDIRECT}`].content = 'const x = 1\n'.repeat(Math.ceil((2 * MIB + 1) / 12))
  assert.deepEqual(await large.diff(REDIRECT), { path: REDIRECT, text: null, message: TOO_LARGE, lines: { old: 60, new: 'unknown' } })
  assert.deepEqual(itemsRead(large.ado.calls), [`${COMMON}:${REDIRECT}`], 'the oversized side is never read')
  assert.equal(large.ado.count(isBlob), 2)
  count = large.ado.calls.length
  assert.equal((await large.diff(REDIRECT)).message, TOO_LARGE)
  assert.equal(large.since(count).length, 0)

  const exact = harness()
  exact.ado.review.files[`${SOURCE}:${REDIRECT}`].content = 'x'.repeat(2 * MIB - 1) + '\n'
  assert.deepEqual((await exact.diff(REDIRECT)).lines, { old: 60, new: 1 })

  const edited = harness()
  const changes = fixture<{ changeEntries: Record<string, any>[] }>('pr-changes-4110')
  const renamed = changes.changeEntries.find(entry => entry.item.path === AUTH_DOC)!
  renamed.changeType = 'edit, rename'
  renamed.item.objectId = 'b10b0006000000000000000000000000000000a2'
  edited.ado.on(isChanges, () => json(200, changes))
  const login = edited.content(COMMON, LOGIN_DOC)
  edited.ado.review.files[`${SOURCE}:${AUTH_DOC}`] = {
    objectId: 'b10b0006000000000000000000000000000000a2',
    content: `${login}Sessions last eight hours.\n`,
    isBinary: false
  }
  const both = await edited.diff(AUTH_DOC)
  assert.equal(both.message, RENAMED)
  assert.equal(both.text, diffText(login, `${login}Sessions last eight hours.\n`).text)
  assert.deepEqual(both.lines, { old: 5, new: 6 })
  assert.deepEqual(itemsRead(edited.ado.calls).sort(), [`${SOURCE}:${AUTH_DOC}`, `${COMMON}:${LOGIN_DOC}`])
})

test('a missing common commit still opens the review, and diff says why', async () => {
  const { ado, reviews, diff } = harness()
  ado.on(isIterations, () => json(200, withoutCommon()))
  ado.review.pr!.reviewers![0].vote = 5
  const review = await reviews.open(KEY)
  assert.ok(review.description.includes('@Alex Contoso, could you check'))
  assert.deepEqual(review.threads.map(thread => thread.id), [101, 103, 102])
  assert.deepEqual([review.myVote, review.pr.reviewers.map(reviewer => reviewer.vote)], [5, [5, 10]])

  assert.deepEqual(await diff(REDIRECT), { path: REDIRECT, text: null, message: NO_BASE, lines: { old: 'unknown', new: 64 } })
  assert.deepEqual(await diff(LEGACY), { path: LEGACY, text: null, message: NO_BASE, lines: { old: 'unknown', new: null } })
  const added = await diff(REDIRECT_TEST)
  assert.deepEqual([added.message, added.lines], [undefined, { old: null, new: 16 }])
  assert.match(added.text ?? '', /^@@ -0,0 \+1,16 @@\n/)
  assert.deepEqual(await diff(AUTH_DOC), { path: AUTH_DOC, text: null, message: RENAMED, lines: { old: 5, new: 5 } })
  assert.ok(itemsRead(ado.calls).every(read => read.startsWith(`${SOURCE}:`)), 'nothing is read without a base')
})

test('a pull request that disappeared says so', async () => {
  const { ado, reviews, diff } = harness()
  ado.review.pr = null
  await assert.rejects(reviews.open(KEY), adoError('not_found', 404, GONE))
  await assert.rejects(reviews.pullRequest(KEY), adoError('not_found', 404, GONE))
  assert.equal(ado.count(isIterations), 0)

  ado.on(isIterations, () => json(404, { message: 'TF401180: The requested pull request was not found.' }))
  await assert.rejects(diff(REDIRECT), adoError('not_found', 404, GONE))
  await assert.rejects(reviews.fileFacts({ ...KEY, path: REDIRECT }), adoError('not_found', 404, GONE))

  const denied = harness()
  denied.ado.on(isOnePr, () => json(403, { message: 'TF401027: You need the Git "PullRequestContribute" permission.' }))
  await assert.rejects(denied.reviews.open(KEY), adoError('forbidden', 403, NEEDS_CODE_READ))
  await assert.rejects(denied.reviews.pullRequest(KEY), adoError('forbidden', 403, NEEDS_CODE_READ))
  denied.ado.on(isItem, () => json(403, { message: 'TF401027: You need the Git "GenericRead" permission.' }))
  await assert.rejects(denied.diff(REDIRECT), adoError('forbidden', 403, NEEDS_CODE_READ))

  const threads = harness()
  threads.ado.on(isThreads, () => json(403, { message: 'TF401027: You need the Git "GenericRead" permission.' }))
  await assert.rejects(threads.reviews.open(KEY), adoError('forbidden', 403, NEEDS_CODE_READ))
})

test('pullRequest and fileFacts read fresh', async () => {
  const { ado, reviews, content, since } = harness()
  await reviews.open(KEY)
  let count = ado.calls.length
  assert.equal((await reviews.pullRequest(KEY)).pullRequestId, 4110)
  assert.equal(since(count).filter(isOnePr).length, 1)

  count = ado.calls.length
  const facts = await reviews.fileFacts({ ...KEY, path: REDIRECT })
  assert.deepEqual(facts, {
    iterationId: 2,
    file: {
      path: REDIRECT,
      originalPath: null,
      kind: 'edited',
      changeTrackingId: 1,
      objectId: 'b10b0001000000000000000000000000000000a2',
      originalObjectId: 'b10b0001000000000000000000000000000000a1'
    },
    lines: { old: 60, new: 64 },
    binary: false
  })
  assert.deepEqual([since(count).filter(isIterations).length, since(count).filter(isChanges).length], [1, 1])
  assert.equal((await reviews.fileFacts({ ...KEY, path: '/src/auth/missing.ts' })), null)
  const lock = await reviews.fileFacts({ ...KEY, path: LOCK })
  assert.deepEqual([lock?.binary, lock?.lines], [true, { old: null, new: lineCount(content(SOURCE, LOCK)) }])
  const deleted = await reviews.fileFacts({ ...KEY, path: LEGACY })
  assert.deepEqual([deleted?.file.kind, deleted?.lines], ['deleted', { old: 10, new: null }])

  ado.review.files[`${SOURCE}:${REDIRECT_TEST}`].content = 'it("works")\n'.repeat(200_000)
  ado.review.files[`${SOURCE}:${REDIRECT_TEST}`].objectId = 'b10b0002000000000000000000000000000000b2'
  const changes = fixture<{ changeEntries: Record<string, any>[] }>('pr-changes-4110')
  changes.changeEntries[1].item.objectId = 'b10b0002000000000000000000000000000000b2'
  ado.on(isChanges, () => json(200, changes))
  count = ado.calls.length
  const large = await reviews.fileFacts({ ...KEY, path: REDIRECT_TEST })
  assert.deepEqual(large?.lines, { old: null, new: 'unknown' })
  assert.equal(since(count).filter(isItem).length, 0)
})

test('the text cache keeps the newest 100 files and 32 MiB', async () => {
  const { ado, diff, since } = harness()
  const entries = Array.from({ length: 101 }, (_, i) => ({
    changeTrackingId: i + 1,
    item: { objectId: `f${i}`, gitObjectType: 'blob', path: `/src/f${i}.ts` },
    changeType: 'add'
  }))
  ado.on(isChanges, () => json(200, { changeEntries: entries, nextSkip: 0, nextTop: 0 }))
  for (let i = 0; i < 101; i++) ado.review.files[`${SOURCE}:/src/f${i}.ts`] = { objectId: `f${i}`, content: `export const f${i} = ${i}\n`, isBinary: false }
  for (let i = 0; i < 101; i++) await diff(`/src/f${i}.ts`)
  let count = ado.calls.length
  await diff('/src/f1.ts')
  assert.equal(since(count).length, 0)
  await diff('/src/f0.ts')
  assert.deepEqual(itemsRead(since(count)), [`${SOURCE}:/src/f0.ts`])

  const big = harness()
  const two = 'y'.repeat(99) + '\n'
  const bigEntries = Array.from({ length: 17 }, (_, i) => ({
    changeTrackingId: i + 1,
    item: { objectId: `g${i}`, gitObjectType: 'blob', path: `/gen/g${i}.txt` },
    changeType: 'add'
  }))
  big.ado.on(isChanges, () => json(200, { changeEntries: bigEntries, nextSkip: 0, nextTop: 0 }))
  for (let i = 0; i < 17; i++) big.ado.review.files[`${SOURCE}:/gen/g${i}.txt`] = { objectId: `g${i}`, content: two.repeat(20_000), isBinary: false }
  for (let i = 0; i < 17; i++) await big.diff(`/gen/g${i}.txt`)
  count = big.ado.calls.length
  await big.diff('/gen/g1.txt')
  assert.equal(big.since(count).length, 0)
  await big.diff('/gen/g0.txt')
  assert.deepEqual(itemsRead(big.since(count)), [`${SOURCE}:/gen/g0.txt`])
})

test('nothing is answered after the org signs out', async () => {
  const { ado, reviews, diff, since, setOrgs } = harness()
  await reviews.open(KEY)
  await diff(REDIRECT)
  const hung = ado.hang(isThreads)
  const answer = reviews.open(KEY).then(
    () => assert.fail('the review was answered after sign-out'),
    (error: unknown) => error
  )
  await until(() => hung.length > 0)
  assert.equal(hung.length, 1)
  setOrgs([])
  assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await answer))
  assert.equal(hung[0].signal?.aborted, true)

  let count = ado.calls.length
  await assert.rejects(diff(REDIRECT), adoError('unauthorized', 401, NOT_CONNECTED))
  await assert.rejects(reviews.fileFacts({ ...KEY, path: REDIRECT }), adoError('unauthorized', 401, NOT_CONNECTED))
  assert.equal(since(count).length, 0)

  setOrgs([status({ state: 'expired' })])
  await assert.rejects(reviews.pullRequest(KEY), adoError('unauthorized', 401, NOT_CONNECTED))
  setOrgs([status()])
  count = ado.calls.length
  await diff(REDIRECT)
  const after = since(count)
  assert.deepEqual(
    [after.length, after.filter(isIterations).length, after.filter(isChanges).length, after.filter(isBlob).length, after.filter(isItem).length],
    [6, 1, 1, 2, 2],
    'signing out dropped the kept facts and text'
  )
})

test('a read that lands after the org signs out keeps nothing', async () => {
  for (const [match, read] of [
    [isChanges, 'changes'],
    [isItem, 'item']
  ] as const) {
    const { ado, diff, since, setOrgs } = harness()
    const held = ado.hold(match)
    const answer = diff(REDIRECT).then(
      () => assert.fail('the diff was answered after sign-out'),
      (error: unknown) => error
    )
    await until(() => ado.count(match) > 0)
    setOrgs([])
    held.release()
    assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await answer), read)

    setOrgs([status()])
    const count = ado.calls.length
    await diff(REDIRECT)
    assert.deepEqual([since(count).filter(isIterations).length, since(count).filter(isItem).length], [1, 2], `nothing kept from the late ${read} read`)
  }
})

test('a review of 2,000 files and 300 long comments fits the answer budget and says what was left out', async () => {
  const { ado, reviews, diff } = harness()
  const generated = '/dist/bundle.js'
  const entries = Array.from({ length: 999 }, (_, i) => ({
    changeTrackingId: i + 1,
    changeId: i + 1,
    item: { objectId: `a${i}`, originalObjectId: `b${i}`, gitObjectType: 'blob', path: `/src/modules/feature-${String(i).padStart(4, '0')}/index.ts` },
    changeType: 'edit'
  }))
  entries.splice(500, 0, {
    changeTrackingId: 1_000,
    changeId: 1_000,
    item: { objectId: 'big-new', originalObjectId: 'big-old', gitObjectType: 'blob', path: generated },
    changeType: 'edit'
  })
  ado.on(isChanges, () => json(200, { changeEntries: entries, nextSkip: 1_000, nextTop: 1_000 }))
  const bundle = 'export const chunk = "…";\n'.repeat(200_000)
  assert.ok(Buffer.byteLength(bundle) > 5_000_000)
  ado.review.files[`${COMMON}:${generated}`] = { objectId: 'big-old', content: bundle, isBinary: false }
  ado.review.files[`${SOURCE}:${generated}`] = { objectId: 'big-new', content: `${bundle}export const extra = 1;\n`, isBinary: false }
  const note = `${'The generated bundle changed again; regenerate it from a clean checkout before merging. '.repeat(4)}\n`.repeat(60)
  ado.review.threads = Array.from(
    { length: 150 },
    (_, i): RawThread => ({
      id: 1_000 + i,
      status: 'active',
      threadContext: { filePath: generated, rightFileStart: { line: i + 1 }, leftFileStart: null },
      comments: [1, 2].map(id => ({
        id,
        author: { id: ME, displayName: 'Alex Contoso' },
        content: note,
        publishedDate: new Date(T0 - (i * 2 + id) * 60_000).toISOString(),
        commentType: 'text'
      }))
    })
  )
  assert.ok(Buffer.byteLength(note) > 20_000)

  const review = await reviews.open(KEY)
  assert.ok(byteLength(review) <= ANSWER_BYTES, `${byteLength(review)} bytes`)
  assert.deepEqual([review.files.length, review.moreFiles, review.threadCount], [1_000, true, 150])
  assert.equal(review.message, `${CAPPED} ${TRIMMED}`)
  assert.ok(review.threads.length > 0 && review.threads.length < 100, `${review.threads.length} threads`)
  assert.deepEqual(review.threads.map(thread => thread.id), review.threads.map((_, i) => 1_000 + i))
  assert.ok(review.threads.every(thread => thread.comments.every(comment => Buffer.byteLength(comment.content) <= 8_000)))
  assert.equal(ado.count(isItem), 0)

  assert.deepEqual(await diff(generated), { path: generated, text: null, message: TOO_LARGE, lines: { old: 'unknown', new: 'unknown' } })
  assert.equal(ado.count(isItem), 0)
  assert.equal(ado.count(isBlob), 2)
})
