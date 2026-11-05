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
  return { org: 'contoso', me: 'u-contoso', sets: [], toReview: [], toReviewCount: 0, autoComplete: OPTIONS, updatedAt: NOW, stale: false, ...over }
}
