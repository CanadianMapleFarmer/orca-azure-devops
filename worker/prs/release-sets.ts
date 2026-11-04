import type { PrSummary, ReleaseSet } from '../../src/shared/prs'

export const COMPLETED_WINDOW_MS = 14 * 24 * 60 * 60_000

export function releaseSets(prs: PrSummary[], now: number): ReleaseSet[] {
  return groupRelated(prs.filter(pr => isRelevant(pr, now)))
    .filter(group => group.some(pr => pr.status === 'active'))
    .map(toReleaseSet)
    .sort(newestSetFirst)
}

export function toReviewOf(prs: PrSummary[], me: string): PrSummary[] {
  return prs.filter(pr => isWaitingOn(pr, me)).sort(newestPrFirst)
}

function isRelevant(pr: PrSummary, now: number): boolean {
  if (pr.status === 'active') return true
  return pr.status === 'completed' && pr.closedAt !== null && pr.closedAt >= now - COMPLETED_WINDOW_MS
}

function isWaitingOn(pr: PrSummary, me: string): boolean {
  if (pr.status !== 'active' || pr.isDraft || sameId(pr.createdBy.id, me)) return false
  return pr.reviewers.some(reviewer => sameId(reviewer.id, me) && reviewer.vote === 0 && !reviewer.hasDeclined)
}

function groupRelated(prs: PrSummary[]): PrSummary[][] {
  const parent = prs.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  const firstWithLink = new Map<string, number>()
  prs.forEach((pr, index) => {
    for (const link of linksOf(pr)) {
      const first = firstWithLink.get(link)
      if (first === undefined) firstWithLink.set(link, index)
      else parent[find(index)] = find(first)
    }
  })
  const groups = new Map<number, PrSummary[]>()
  prs.forEach((pr, index) => {
    const root = find(index)
    const group = groups.get(root)
    if (group) group.push(pr)
    else groups.set(root, [pr])
  })
  return [...groups.values()]
}

function linksOf(pr: PrSummary): string[] {
  return [`source:${pr.repoId}:${pr.source}`, ...pr.workItemIds.map(id => `work-item:${pr.org}:${id}`)]
}

function toReleaseSet(group: PrSummary[]): ReleaseSet {
  const prs = [...group].sort((a, b) => a.prId - b.prId)
  const [lowest] = prs
  return {
    key: `${lowest.org}:${lowest.prId}`,
    title: lowest.title,
    sources: [...new Set(prs.map(pr => pr.source))],
    workItemIds: [...new Set(prs.flatMap(pr => pr.workItemIds))].sort((a, b) => a - b),
    prs
  }
}

function newestSetFirst(a: ReleaseSet, b: ReleaseSet): number {
  return newestCreatedAt(b) - newestCreatedAt(a) || b.prs[0].prId - a.prs[0].prId
}

function newestCreatedAt(set: ReleaseSet): number {
  return Math.max(...set.prs.map(pr => pr.createdAt))
}

function newestPrFirst(a: PrSummary, b: PrSummary): number {
  return b.createdAt - a.createdAt || b.prId - a.prId
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
