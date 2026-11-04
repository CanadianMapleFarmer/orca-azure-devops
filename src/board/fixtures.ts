import type { BoardColumn, BoardConfig, WorkItemSummary } from '../shared/work'

export const DEFAULT_LANE = '00000000-0000-0000-0000-000000000000'
export const EXPEDITE = '48c9daeb-bbbb-44c5-9fd1-a2b3c4d5e6f7'
export const COLUMNS = ['New', 'Active', 'In Review', 'Resolved', 'Closed']

const WEF = 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban'

function column(id: string, name: string, stateMappings: Record<string, string>, extra: Partial<BoardColumn> = {}): BoardColumn {
  return { id, name, isSplit: false, columnType: 'inProgress', stateMappings, ...extra }
}

export function boardConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    org: 'contoso',
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    teamId: '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e',
    boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091',
    boardName: 'Stories',
    requirementTypes: ['User Story', 'Bug'],
    columns: [
      column('c1', 'New', { 'User Story': 'New', Bug: 'New' }, { columnType: 'incoming' }),
      column('c2', 'Active', { 'User Story': 'Active', Bug: 'Active' }),
      column('c3', 'In Review', { 'User Story': 'Active' }, { isSplit: true }),
      column('c4', 'Resolved', { 'User Story': 'Resolved', Bug: 'Resolved' }),
      column('c5', 'Closed', { 'User Story': 'Closed', Bug: 'Closed' }, { columnType: 'outgoing' })
    ],
    lanes: [
      { id: DEFAULT_LANE, name: '' },
      { id: EXPEDITE, name: 'Expedite' }
    ],
    fields: { column: `${WEF}.Column`, columnDone: `${WEF}.Column.Done`, lane: `${WEF}.Lane` },
    areaPaths: [],
    doneStates: { 'User Story': ['Closed'], Bug: ['Closed'] },
    ...overrides
  }
}

export function item(id: number, overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    org: 'contoso',
    id,
    rev: 3,
    type: 'User Story',
    title: `Story ${id}`,
    state: 'Active',
    column: 'Active',
    columnDone: false,
    lane: null,
    assignedTo: null,
    parentId: null,
    parentTitle: null,
    changedAt: 0,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/${id}`,
    prs: [],
    targets: { columns: COLUMNS, states: [] },
    ...overrides
  }
}
