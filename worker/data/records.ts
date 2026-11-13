import type { PrChecks, PrKey } from '../../src/shared/prs'
import type { Assignee, DetailTask, WorkItemDetails } from '../../src/shared/work'
import type { PrRef, RawWorkItem } from '../ado/workitems'

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
  title?: string
}

export interface RepoRecord {
  id: string
  name: string
  projectId: string
  projectName: string
  ssh: boolean
  disabled: boolean
}

export interface DetailsRecord {
  id: number
  rev: number
  projectId: string
  home: string
  relations: string
  descriptionMd: string
  acceptanceMd: string
  assignee: Assignee | null
  links: WorkItemDetails['links']
  tasks: DetailTask[]
  moreTasks: number
  tasksRead: boolean
  prRefs: PrRef[]
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
