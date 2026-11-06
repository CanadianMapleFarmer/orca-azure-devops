import type { PrReview, ReviewKey, ReviewThread } from '../../../shared/reviews'
import { NOW, prOf, reviewerOf } from '../fixtures'

export const REVIEW_KEY: ReviewKey = { org: 'contoso', projectId: 'proj-web', repoId: 'repo-web', prId: 4110 }

export const REVIEW_TITLE = 'Harden the login redirect'

export const OPEN_REVIEW = { ...REVIEW_KEY, title: REVIEW_TITLE }

const HOUR = 60 * 60_000

export const REVIEW_THREADS: ReviewThread[] = [
  {
    id: 101,
    status: 'active',
    anchor: null,
    comments: [
      { id: 1, author: 'Grace Hopper', at: NOW - 3 * HOUR, content: '@Alex Contoso could you look at the decoding order before I merge?' },
      { id: 2, author: 'Alex Contoso', at: NOW - 2 * HOUR, content: 'Looking now.' }
    ],
    hidden: 0
  },
  {
    id: 103,
    status: 'pending',
    anchor: { path: '/src/auth/legacy-return.ts', line: null, side: 'new' },
    comments: [{ id: 1, author: 'Dennis Ritchie', at: NOW - HOUR, content: 'Was anything else calling `legacyReturn`?' }],
    hidden: 0
  },
  {
    id: 102,
    status: 'fixed',
    anchor: { path: '/src/auth/redirect.ts', line: 12, side: 'new' },
    comments: [
      { id: 1, author: 'Dennis Ritchie', at: NOW - 5 * HOUR, content: 'Prefer URL parsing here over string checks.' },
      { id: 2, author: 'Grace Hopper', at: NOW - 4 * HOUR, content: 'Done in iteration 2.' }
    ],
    hidden: 0
  }
]

export function reviewOf(over: Partial<PrReview> = {}): PrReview {
  return {
    key: REVIEW_KEY,
    pr: prOf(4110, {
      title: REVIEW_TITLE,
      source: 'hotfix/1211-login-redirect',
      target: 'main',
      createdBy: { id: 'u-grace', name: 'Grace Hopper' },
      createdAt: NOW - 3 * HOUR,
      reviewers: [reviewerOf('Alex Contoso', 0, { id: 'u-contoso' }), reviewerOf('Dennis Ritchie', 10, { isRequired: true })]
    }),
    description: 'Fixes the open redirect reported in #1211.\n\n- Decode the target once before checking it.\n- Refuse protocol-relative targets.',
    myVote: 0,
    files: [
      { path: '/src/auth/redirect.ts', originalPath: null, kind: 'edited' },
      { path: '/src/auth/redirect.test.ts', originalPath: null, kind: 'added' },
      { path: '/src/auth/legacy-return.ts', originalPath: null, kind: 'deleted' },
      { path: '/docs/auth.md', originalPath: '/docs/login.md', kind: 'renamed' },
      { path: '/assets/lock.png', originalPath: null, kind: 'added' }
    ],
    moreFiles: false,
    threads: REVIEW_THREADS,
    threadCount: REVIEW_THREADS.length,
    loadedAt: NOW,
    ...over
  }
}
