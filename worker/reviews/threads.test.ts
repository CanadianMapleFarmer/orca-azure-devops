import { assert, test } from 'orca/testing'
import type { PrReview, ReviewThread } from '../../src/shared/reviews'
import type { RawThread } from '../ado/pr-review'
import { toPrSummary, type RawPullRequest } from '../ado/pullrequests'
import { fixture, ORG, PROJECT, REPO } from '../boards/fake-ado'
import { ANSWER_BUDGET_BYTES, byteLength, itemBytes } from '../budget'
import { MALFORMED, MARKDOWN_CUT_NOTE } from '../messages'
import { fitReview, MAX_COMMENT_BYTES, MAX_COMMENTS_PER_THREAD, MAX_THREADS, peopleOf, toReviewThreads } from './threads'

const PR_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4110'
const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const GRACE = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d'
const DENNIS = 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e'
const STRANGER = '5e6f7a8b-9999-4c0d-8e1f-2a3b4c5d6e7f'
const TRIMMED = 'Some comments were left out to keep this view small. Open the pull request in Azure DevOps to see them all.'
const CAPPED = 'More than 1,000 files changed. Open the pull request in Azure DevOps, or check it out in Orca, to see them all.'
const T0 = Date.parse('2026-11-05T10:00:00Z')

function pr(): RawPullRequest {
  return fixture<RawPullRequest>('pull-request-4110')
}

function rawThreads(): RawThread[] {
  return fixture<{ value: RawThread[] }>('pr-threads-4110').value
}

function context(threads: readonly RawThread[] = rawThreads()) {
  return { people: peopleOf(pr(), threads), prUrl: PR_URL }
}

function comment(id: number, minute: number, content = `Comment ${id}`, extra: Record<string, unknown> = {}) {
  return {
    id,
    author: { id: GRACE, displayName: 'Grace Hopper' },
    content,
    publishedDate: new Date(T0 + minute * 60_000).toISOString(),
    commentType: 'text',
    ...extra
  }
}

function thread(id: number, extra: Partial<RawThread> = {}): RawThread {
  return { id, status: 'active', threadContext: null, comments: [comment(1, id)], ...extra }
}

function review(threads: ReviewThread[], threadCount: number, message?: string): PrReview {
  return {
    key: { org: ORG, projectId: PROJECT, repoId: REPO, prId: 4110 },
    pr: toPrSummary(pr(), ORG),
    description: 'Fixes the open redirect.',
    myVote: 0,
    files: [{ path: '/src/auth/redirect.ts', originalPath: null, kind: 'edited' }],
    moreFiles: message !== undefined,
    threads,
    threadCount,
    loadedAt: T0,
    ...(message ? { message } : {})
  }
}

test('peopleOf names the author, reviewers, identities and commenters', () => {
  const threads = rawThreads()
  threads.push(thread(106, { comments: [comment(1, 0, 'hi', { author: { id: STRANGER, displayName: 'Ada Lovelace' } })] }))
  const people = peopleOf(pr(), threads)
  assert.deepEqual(
    [GRACE, ME, DENNIS, STRANGER].map(id => people.get(id)),
    ['Grace Hopper', 'Alex Contoso', 'Dennis Ritchie', 'Ada Lovelace']
  )
  const voter = rawThreads().find(item => item.id === 104)!
  const onlyIdentities = peopleOf({ ...pr(), reviewers: [] }, [{ ...voter, comments: [] }])
  assert.equal(onlyIdentities.get(DENNIS), 'Dennis Ritchie')
})

test("toReviewThreads keeps people's comments, anchors and order", () => {
  const { threads, total } = toReviewThreads(rawThreads(), context())
  assert.equal(total, 3)
  assert.deepEqual(
    threads.map(item => [item.id, item.status, item.anchor, item.hidden]),
    [
      [101, 'active', null, 0],
      [103, 'pending', { path: '/src/auth/legacy-return.ts', line: 7, side: 'old' }, 0],
      [102, 'fixed', { path: '/src/auth/redirect.ts', line: 42, side: 'new' }, 0]
    ]
  )
  const [general] = threads
  assert.deepEqual(general.comments, [
    {
      id: 1,
      author: 'Grace Hopper',
      at: Date.parse('2026-11-05T09:10:00Z'),
      content: '@Alex Contoso could you look at the decoding order before I merge?'
    },
    {
      id: 2,
      author: 'Alex Contoso',
      at: Date.parse('2026-11-05T09:20:00Z'),
      content: 'Looking now. Decoding once, before the host check, reads right to me.'
    }
  ])
  assert.equal(threads[1].comments[0].content, 'Was anything else calling `legacyReturn`?')

  const spans = toReviewThreads(
    [
      thread(201, {
        threadContext: { filePath: '/src/auth/redirect.ts', rightFileStart: { line: 40 }, rightFileEnd: { line: 45 } } as RawThread['threadContext']
      }),
      thread(202, {
        threadContext: {
          filePath: '/src/auth/redirect.ts',
          rightFileStart: { line: 42, offset: 5 },
          rightFileEnd: { line: 44, offset: 30 }
        } as RawThread['threadContext']
      }),
      thread(203, { threadContext: { filePath: '/docs/auth.md', rightFileStart: null, leftFileStart: null } }),
      thread(204, { threadContext: { filePath: '/src/old.ts', leftFileStart: { line: 3 }, leftFileEnd: { line: 9 } } as RawThread['threadContext'] }),
      thread(205, { threadContext: { rightFileStart: { line: 4 } } })
    ],
    context()
  )
  assert.deepEqual(
    spans.threads.map(item => [item.id, item.anchor]),
    [
      [205, null],
      [204, { path: '/src/old.ts', line: 3, side: 'old' }],
      [203, { path: '/docs/auth.md', line: null, side: 'new' }],
      [202, { path: '/src/auth/redirect.ts', line: 42, side: 'new' }],
      [201, { path: '/src/auth/redirect.ts', line: 40, side: 'new' }]
    ]
  )

  const ties = toReviewThreads(
    [
      thread(301, { status: 'closed', comments: [comment(1, 50)] }),
      thread(302, { status: 'byDesign', comments: [comment(1, 10)] }),
      thread(303, { status: 'unknown', comments: [comment(1, 10)] }),
      thread(304, { status: 'wontFix', comments: [comment(1, 50)] }),
      thread(305, { status: 'somethingNew', comments: [comment(1, 5)] }),
      thread(306, { comments: [comment(1, 10)] })
    ],
    context()
  )
  assert.deepEqual(
    ties.threads.map(item => [item.id, item.status]),
    [
      [306, 'active'],
      [303, 'unknown'],
      [305, 'unknown'],
      [304, 'wontFix'],
      [301, 'closed'],
      [302, 'byDesign']
    ]
  )
})

test('system, deleted and empty threads are dropped', () => {
  const { threads, total } = toReviewThreads(
    [
      ...rawThreads(),
      thread(401, { comments: [comment(1, 1, 'gone', { isDeleted: true }), comment(2, 2, 'Policy status updated', { commentType: 'system' })] }),
      thread(402, { comments: [] }),
      { id: 403, status: 'active' },
      thread(404, { comments: [comment(1, 1, 'kept'), comment(2, 2, 'gone', { isDeleted: true }), comment(3, 3, 'Grace voted', { commentType: 'system' })] })
    ],
    context()
  )
  assert.deepEqual(threads.map(item => item.id), [404, 101, 103, 102])
  assert.equal(total, 4)
  assert.deepEqual(threads[0].comments.map(item => item.content), ['kept'])
  assert.equal(threads[0].hidden, 0)

  const unknown = toReviewThreads([thread(405, { comments: [{ id: 1, content: '@<5E6F7A8B-9999-4C0D-8E1F-2A3B4C5D6E7F> hi' }] })], context())
  assert.deepEqual(unknown.threads[0].comments, [{ id: 1, author: 'Unknown', at: 0, content: '@Unknown hi' }])

  for (const broken of [{ id: 'one', comments: [comment(1, 1)] }, { id: 7, comments: 'none' }, null]) {
    const listed = [broken as unknown as RawThread]
    assert.throws(
      () => toReviewThreads(listed, context(listed)),
      (error: unknown) => error instanceof Error && error.message === MALFORMED.review
    )
  }
})

test('a long thread keeps its first and newest comments and counts the rest', () => {
  const comments = Array.from({ length: 25 }, (_, i) => comment(i + 1, i))
  const shuffled = [comments[3], ...comments.slice(0, 3), ...comments.slice(4).reverse()]
  const { threads } = toReviewThreads([thread(501, { comments: shuffled })], context())
  const [long] = threads
  assert.equal(long.comments.length, MAX_COMMENTS_PER_THREAD)
  assert.deepEqual(long.comments.map(item => item.id), [1, ...Array.from({ length: 19 }, (_, i) => i + 7)])
  assert.equal(long.hidden, 5)

  const exact = toReviewThreads([thread(502, { comments: comments.slice(0, 20) })], context()).threads[0]
  assert.deepEqual([exact.comments.length, exact.hidden], [20, 0])

  const huge = 'A long note about redirects.\n'.repeat(10_000)
  const cut = toReviewThreads([thread(503, { comments: [comment(1, 1, `[docs](/docs/auth.md)\n${huge}`)] })], context()).threads[0]
  assert.ok(Buffer.byteLength(cut.comments[0].content) <= MAX_COMMENT_BYTES)
  assert.ok(cut.comments[0].content.startsWith(`[docs](${PR_URL})\n`))
  assert.ok(cut.comments[0].content.endsWith(`*${MARKDOWN_CUT_NOTE}*`))
})

test('150 short threads keep 100, count all 150 and say some were left out', () => {
  const raw = Array.from({ length: 150 }, (_, i) => thread(i + 1))
  const { threads, total } = toReviewThreads(raw, context(raw))
  assert.deepEqual([threads.length, total], [MAX_THREADS, 150])
  assert.deepEqual([threads[0].id, threads.at(-1)?.id], [150, 51])

  const fitted = fitReview(review(threads, total), ANSWER_BUDGET_BYTES)
  assert.equal(fitted.threadCount, 150)
  assert.equal(fitted.threads.length, 100)
  assert.equal(fitted.message, TRIMMED)
  assert.ok(byteLength(fitted) < 64 * 1024, `far under budget: ${byteLength(fitted)}`)

  const capped = fitReview(review(threads, total, CAPPED), ANSWER_BUDGET_BYTES)
  assert.equal(capped.message, `${CAPPED} ${TRIMMED}`)

  const whole = review(threads.slice(0, 3), 3)
  assert.deepEqual(fitReview(whole, ANSWER_BUDGET_BYTES), whole)
})

test('fitReview drops threads from the end until the review fits', () => {
  const raw = Array.from({ length: 40 }, (_, i) => thread(i + 1, { comments: [comment(1, i, 'x'.repeat(2_000))] }))
  const { threads } = toReviewThreads(raw, context(raw))
  const full = review(threads, 40)
  const budget = byteLength({ ...full, threads: threads.slice(0, 25), message: TRIMMED })
  const fitted = fitReview(full, budget)
  assert.ok(byteLength(fitted) <= budget)
  assert.deepEqual(fitted.threads, threads.slice(0, 25))
  assert.equal(fitted.message, TRIMMED)
  assert.equal(fitReview(full, budget - itemBytes(threads[0]) * 2).threads.length, 23)
  assert.deepEqual(fitReview(full, 10).threads, [])
})
