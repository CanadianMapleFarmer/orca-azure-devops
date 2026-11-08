import type { AutoCompleteOptions, PrReviewer, PrSnapshot, PrSummary, ReleaseSet } from '../../shared/prs'

export const NOW = 1_700_000_000_000

export const OPTIONS: AutoCompleteOptions = { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false }

export function reviewerOf(name: string, vote: number, over: Partial<PrReviewer> = {}): PrReviewer {
  return {
    id: `id-${name}`,
    name,
    uniqueName: `${name.toLowerCase().replace(/\W+/g, '.')}@contoso.com`,
    vote,
    isRequired: false,
    isGroup: false,
    hasDeclined: false,
    ...over
  }
}

export function prOf(prId: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    org: 'contoso',
    projectId: 'proj-web',
    projectName: 'Fabrikam Web',
    repoId: 'repo-web',
    repoName: 'web-app',
    prId,
    title: `Change ${prId}`,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${prId}`,
    source: 'feature/login',
    target: 'develop',
    status: 'active',
    isDraft: false,
    mergeStatus: 'ok',
    createdBy: { id: 'u-contoso', name: 'Ada Lovelace' },
    createdAt: NOW,
    closedAt: null,
    reviewers: [],
    autoComplete: false,
    workItemIds: [],
    checks: null,
    ...over
  }
}

export function setOf(prs: PrSummary[], over: Partial<ReleaseSet> = {}): ReleaseSet {
  return {
    key: `contoso:${prs[0].prId}`,
    title: prs[0].title,
    sources: [...new Set(prs.map(pr => pr.source))],
    workItemIds: [],
    prs,
    ...over
  }
}

export function snapshotOf(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return { org: 'contoso', me: 'u-contoso', sets: [], toReview: [], toReviewCount: 0, reviewed: [], autoComplete: OPTIONS, updatedAt: NOW, stale: false, ...over }
}

type PrPlace = Pick<PrSummary, 'projectId' | 'projectName' | 'repoId' | 'repoName'>

const WEB_APP: PrPlace = { projectId: 'proj-web', projectName: 'Fabrikam Web', repoId: 'repo-web', repoName: 'web-app' }
const WEB_API: PrPlace = { projectId: 'proj-web', projectName: 'Fabrikam Web', repoId: 'repo-api', repoName: 'fabrikam-api' }
const TOOLS_APP: PrPlace = { projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: 'repo-tools-app', repoName: 'web-app' }
const BOARDS_APP: PrPlace = { projectId: 'proj-boards', projectName: 'Fabrikam Boards', repoId: 'repo-boards', repoName: 'boards-app' }
const DATA_JOBS: PrPlace = { projectId: 'proj-data', projectName: 'Fabrikam Data', repoId: 'repo-data', repoName: 'data-jobs' }
const PLACES = [WEB_APP, WEB_API, TOOLS_APP, BOARDS_APP, DATA_JOBS]

const BUILDS: PrSummary['checks'][] = [
  { build: 'failed', policies: 'rejected' },
  { build: 'running', policies: 'pending' },
  { build: 'succeeded', policies: 'approved' },
  null
]

const busyReviewers = (index: number): PrReviewer[] => [
  reviewerOf('Grace Hopper', 10),
  reviewerOf('Alan Turing', index % 2 === 0 ? 0 : -5, { isRequired: true }),
  reviewerOf('Alex Contoso', 0, { isRequired: true }),
  reviewerOf('Release Approvers', 0, { isRequired: true, isGroup: true })
]

function busyPr(prId: number, place: PrPlace, index: number, merged: boolean): PrSummary {
  return prOf(prId, {
    ...place,
    title: `Rework the sign-in redirect so returning people land on the page they asked for (${prId})`,
    source: `feature/sign-in-redirect-${prId % 3}`,
    target: ['develop', 'qa', 'main'][index % 3],
    status: merged ? 'completed' : 'active',
    closedAt: merged ? NOW : null,
    isDraft: !merged && index % 7 === 3,
    autoComplete: index % 3 === 0,
    mergeStatus: index % 6 === 1 ? 'conflicts' : 'ok',
    checks: BUILDS[index % BUILDS.length],
    reviewers: busyReviewers(index)
  })
}

export function largeSets(): PrSnapshot {
  const layouts: PrPlace[][] = [
    [WEB_APP, TOOLS_APP, BOARDS_APP],
    [WEB_APP, WEB_API],
    ...[4, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2].map((size, index) => Array.from({ length: size }, () => PLACES[index % PLACES.length]))
  ]
  let next = 0
  const sets = layouts.map((places, setIndex) => {
    const prs = places.map((place, row) => {
      next += 1
      const merged = setIndex === 2 ? row < 3 : next % 5 === 0
      return busyPr(5000 + next, place, next, merged)
    })
    return setOf(prs, { key: `contoso:large-${setIndex}` })
  })
  const grace = { id: 'u-grace', name: 'Grace Hopper' }
  const votes = [10, 5, -5, -10]
  const toReview = Array.from({ length: 50 }, (_, index) =>
    prOf(7000 + index, { ...PLACES[index % PLACES.length], title: `Review the cache keys for every tenant before the release (${index})`, createdBy: grace })
  )
  const reviewed = Array.from({ length: 50 }, (_, index) =>
    prOf(8000 + index, {
      ...PLACES[index % PLACES.length],
      title: `Voted on the health endpoint for every region (${index})`,
      createdBy: grace,
      reviewers: [reviewerOf('Ada Lovelace', votes[index % votes.length], { id: 'u-contoso' })]
    })
  )
  return snapshotOf({ sets, toReview, toReviewCount: toReview.length, reviewed })
}
