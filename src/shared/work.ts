import type { PrChecks } from './prs'

export type StateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed' | 'Removed'

export interface BoardColumn {
  id: string
  name: string
  isSplit: boolean
  columnType: 'incoming' | 'inProgress' | 'outgoing'
  stateMappings: Record<string, string>
}

export interface BoardConfig {
  org: string
  projectId: string
  teamId: string
  boardId: string
  boardName: string
  requirementTypes: string[]
  columns: BoardColumn[]
  lanes: { id: string; name: string }[]
  fields: { column: string; columnDone: string; lane: string }
  areaPaths: { value: string; includeChildren: boolean }[]
  doneStates: Record<string, string[]>
  taskTypes?: string[]
}

export interface PrChip {
  prId: number
  repoId: string
  projectId: string
  target: string
  state: 'open' | 'merged' | 'abandoned'
  build: 'running' | 'succeeded' | 'failed' | 'none'
  url: string
}

export interface MoveTarget { column?: string; lane?: string; state?: string }

export interface WorkItemSummary {
  org: string
  id: number
  rev: number
  type: string
  title: string
  state: string
  column: string | null
  columnDone: boolean
  lane: string | null
  assignedTo: string | null
  parentId: number | null
  parentTitle: string | null
  changedAt: number
  url: string
  prs: PrChip[]
  targets: { columns: string[]; states: string[] }
}

export interface WorkComment { id: number; author: string; createdAt: number; textMd: string }

export interface Assignee { displayName: string; uniqueName: string }

export interface DetailTask {
  id: number
  rev: number
  type: string
  title: string
  state: string
  done: boolean
  assignedTo: string | null
  doneState: string | null
  openState: string | null
  url: string
}

export interface DetailPr {
  prId: number
  title: string | null
  target: string | null
  state: PrChip['state'] | null
  build: PrChecks['build'] | null
  policies: PrChecks['policies'] | null
  url: string
}

export interface WorkItemDetails {
  item: WorkItemSummary
  descriptionMd: string
  acceptanceMd: string
  assignee: Assignee | null
  comments: WorkComment[]
  links: { kind: string; title: string; url: string }[]
  tasks: DetailTask[]
  moreTasks: number
  tasksRead: boolean
  prs: DetailPr[]
  taskTypes: string[]
  taskType: string | null
  readAt: number
}

export const MAX_NUDGE_RULES = 20

export interface Nudge { itemId: number; prId: number; branch: string; toColumn: string }

export const MAX_CHILD_TASKS = 20

export interface WorkTask { id: number; title: string; state: string; done: boolean; assignee: string | null; mine: boolean }

export interface TaskList { parentId: number; tasks: WorkTask[]; total: number; done: number }

export interface WorkParent { id: number; type: string; title: string; state: string; column: string | null; lane: string | null }

export interface WorkFamilies { lists: TaskList[]; parents: WorkParent[] }

export const NO_FAMILIES: WorkFamilies = { lists: [], parents: [] }

export interface WorkSnapshot {
  org: string
  board: BoardConfig | null
  mine: WorkItemSummary[]
  other: WorkItemSummary[]
  nudges: Nudge[]
  families: WorkFamilies
  updatedAt: number
  stale: boolean
  message?: string
}

export type ArmIdentity = { org: string; prId: number }

export function sameArm(a: ArmIdentity | null, b: ArmIdentity | null): boolean {
  return a !== null && b !== null && a.org === b.org && a.prId === b.prId
}

export interface WorkspaceRef { id: string; name: string }

export interface ItemWorkspace { workspace: WorkspaceRef | null; unsupported: string | null }

export type RepoSource = 'pr' | 'last' | 'org' | 'other'

export interface StartRepo { key: string; name: string; detail: string; source: RepoSource }

export interface CloneTarget { projectId: string; repoId: string }

export interface StartRepos {
  repos: StartRepo[]
  selected: string | null
  clone: { folder: string } | { problem: string }
}

export type RepoPick = { kind: 'orca'; key: string } | ({ kind: 'clone' } & CloneTarget)

export interface CloneProject { id: string; name: string; repos: { id: string; name: string }[] }

export interface CloneTargets { projects: CloneProject[]; readAt: number; more: number }

export type StartRefused = { status: 'refused'; message: string; tone: 'warning' | 'danger' }

export type StartWorkResult =
  | { status: 'sent'; branch: string; repo: string; agent: string; workspace: WorkspaceRef; shortened: boolean; clone: { folder: string; fresh: boolean; setupSkipped: boolean } | null }
  | { status: 'linked'; branch: string; workspace: WorkspaceRef }
  | { status: 'choose-repo'; repos: StartRepos; message: string | null }
  | StartRefused

export type StartAgentResult = { status: 'sent'; agent: string; workspace: WorkspaceRef; shortened: boolean } | StartRefused
