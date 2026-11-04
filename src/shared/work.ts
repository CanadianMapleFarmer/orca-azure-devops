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

export interface WorkItemDetails {
  item: WorkItemSummary
  descriptionMd: string
  acceptanceMd: string
  comments: WorkComment[]
  links: { kind: string; title: string; url: string }[]
}

export interface Nudge { itemId: number; prId: number; branch: string; toColumn: string }

export interface WorkSnapshot {
  org: string
  board: BoardConfig | null
  mine: WorkItemSummary[]
  other: WorkItemSummary[]
  nudges: Nudge[]
  updatedAt: number
  stale: boolean
  message?: string
}
