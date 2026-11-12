import type { PrChecks, PrKey } from '../../src/shared/prs'
import type { RawWorkItem } from '../ado/workitems'

export type ItemRecord = RawWorkItem & { withRelations: boolean }

export interface PrRecord {
  projectId: string
  repoId: string
  prId: number
  status: 'active' | 'completed' | 'abandoned'
  target: string
  sourceCommit: string | null
  reviewers: string
  url: string
}

export interface CheckRecord extends PrChecks {
  commit: string | null
  reviewers: string
}

export function prKey({ projectId, repoId, prId }: PrKey): string {
  return `${projectId}/${repoId}/${prId}`
}

export function reviewersSignature(reviewers: readonly { id: string; vote?: number }[] | undefined): string {
  return (reviewers ?? [])
    .map(({ id, vote }) => `${id}:${vote ?? 0}`)
    .sort()
    .join(',')
}
