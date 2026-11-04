export interface PrKey {
  projectId: string
  repoId: string
  prId: number
}

export interface PrReviewer {
  id: string
  name: string
  uniqueName: string
  vote: number
  isRequired: boolean
  isGroup: boolean
  hasDeclined: boolean
}

export interface PrChecks {
  build: 'none' | 'running' | 'succeeded' | 'failed'
  policies: 'none' | 'pending' | 'approved' | 'rejected'
}

export interface PrSummary extends PrKey {
  org: string
  projectName: string
  repoName: string
  title: string
  url: string
  source: string
  target: string
  status: 'active' | 'completed' | 'abandoned'
  isDraft: boolean
  mergeStatus: 'ok' | 'pending' | 'conflicts' | 'failed'
  createdBy: { id: string; name: string }
  createdAt: number
  closedAt: number | null
  reviewers: PrReviewer[]
  autoComplete: boolean
  workItemIds: number[]
  checks: PrChecks | null
}

export type MergeStrategy = 'noFastForward' | 'squash' | 'rebase' | 'rebaseMerge'

export interface AutoCompleteOptions {
  mergeStrategy: MergeStrategy
  deleteSourceBranch: boolean
  transitionWorkItems: boolean
}

export interface ReleaseSet {
  key: string
  title: string
  sources: string[]
  workItemIds: number[]
  prs: PrSummary[]
}

export interface PrSnapshot {
  org: string
  me: string | null
  sets: ReleaseSet[]
  toReview: PrSummary[]
  toReviewCount: number
  autoComplete: AutoCompleteOptions
  updatedAt: number
  stale: boolean
  message?: string
}

export interface RowResult {
  prId: number
  ok: boolean
  message: string
}
