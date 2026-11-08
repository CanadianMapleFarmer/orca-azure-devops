import { NO_FAMILIES, type BoardConfig, type PrChip, type TaskList, type WorkItemSummary, type WorkParent, type WorkSnapshot, type WorkTask } from '../../shared/work'

export const NOW = 1_700_000_000_000
export const BOARDS = { projectId: 'proj-web', projectName: 'Fabrikam Web', teamId: 'team-web', teamName: 'Web Team' }
export const COLUMN_NAMES = ['New', 'Active', 'Done']

export function board(name = 'contoso', over: Partial<BoardConfig> = {}, columns: readonly string[] = COLUMN_NAMES): BoardConfig {
  return {
    org: name,
    projectId: BOARDS.projectId,
    teamId: BOARDS.teamId,
    boardId: 'board-stories',
    boardName: 'Stories',
    requirementTypes: ['User Story'],
    columns: columns.map((column, index) => ({
      id: `col-${index}`,
      name: column,
      isSplit: false,
      columnType: index === 0 ? 'incoming' : index === columns.length - 1 ? 'outgoing' : 'inProgress',
      stateMappings: { 'User Story': column }
    })),
    lanes: [],
    fields: { column: 'WEF_1_Kanban.Column', columnDone: 'WEF_1_Kanban.Column.Done', lane: 'WEF_1_Kanban.Lane' },
    areaPaths: [],
    doneStates: {},
    taskTypes: ['Task'],
    ...over
  }
}

export function item(id: number, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    org: 'contoso',
    id,
    rev: 7,
    type: 'User Story',
    title: `Story ${id}`,
    state: 'Active',
    column: 'Active',
    columnDone: false,
    lane: null,
    assignedTo: 'Ada Lovelace',
    parentId: null,
    parentTitle: null,
    changedAt: NOW,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/${id}`,
    prs: [],
    targets: { columns: COLUMN_NAMES, states: [] },
    ...over
  }
}

export function task(id: number, over: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return item(id, { type: 'Task', title: `Task ${id}`, column: null, targets: { columns: [], states: ['New', 'Active', 'Closed'] }, ...over })
}

export function pr(prId: number, over: Partial<PrChip> = {}): PrChip {
  return {
    prId,
    repoId: 'repo-web',
    projectId: BOARDS.projectId,
    target: 'main',
    state: 'open',
    build: 'none',
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/${prId}`,
    ...over
  }
}

export function workTask(id: number, over: Partial<WorkTask> = {}): WorkTask {
  return { id, title: `Task ${id}`, state: 'Active', done: false, assignee: 'Grace Hopper', mine: false, ...over }
}

export function listOf(parentId: number, tasks: WorkTask[], over: Partial<TaskList> = {}): TaskList {
  return { parentId, tasks, total: tasks.length, done: tasks.filter(each => each.done).length, ...over }
}

export function parentOf(id: number, over: Partial<WorkParent> = {}): WorkParent {
  return { id, type: 'User Story', title: `Story ${id}`, state: 'Active', column: 'Active', lane: null, ...over }
}

export function snapshotOf(over: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return { org: 'contoso', board: board(), mine: [], other: [], nudges: [], families: NO_FAMILIES, updatedAt: NOW, stale: false, ...over }
}

const LARGE_COLUMNS = ['New', 'Ready', 'Active', 'Review', 'Done']
export const LANES = [
  { id: 'lane-default', name: '' },
  { id: 'lane-expedite', name: 'Expedite' }
]

const laneAt = (index: number): string | null => (index % 2 === 0 ? null : 'Expedite')

export function largeWork(): WorkSnapshot {
  const columnAt = (index: number) => LARGE_COLUMNS[index % LARGE_COLUMNS.length]!
  const stories = Array.from({ length: 130 }, (_, index) =>
    item(5000 + index, {
      title: `Make the checkout page load faster on slow connections, part ${index + 1}`,
      column: columnAt(index),
      lane: laneAt(index),
      targets: { columns: LARGE_COLUMNS, states: [] },
      prs: [pr(20_000 + index * 2, { target: 'dev', state: 'merged' }), pr(20_001 + index * 2, { target: 'main', build: 'running' })]
    })
  )
  const states = { columns: [], states: ['New', 'Active', 'Resolved', 'Closed'] }
  const features = Array.from({ length: 9 }, (_, index) =>
    item(6000 + index, { type: 'Feature', title: `Rework the account settings for every tenant, phase ${index + 1}`, column: null, targets: states })
  )
  const bug = item(6100, { type: 'Bug', title: 'The export button stays disabled after a failed upload', column: null, targets: states })
  const parents = Array.from({ length: 10 }, (_, index) =>
    parentOf(7000 + index, { title: `Show the delivery estimate on the order summary, step ${index + 1}`, column: columnAt(index), lane: laneAt(index) })
  )
  const myTasks = parents.map((parent, index) =>
    task(8000 + index, { title: `Write the estimate tests for step ${index + 1}`, parentId: parent.id, parentTitle: parent.title })
  )
  const pairOf = (parentId: number) =>
    listOf(parentId, [
      workTask(parentId * 10, { title: `Review the copy and the layout for ${parentId}` }),
      workTask(parentId * 10 + 1, { title: `Add the tracking events for ${parentId}`, state: 'Closed', done: true, assignee: 'Alan Turing' })
    ])
  const lists = [
    ...[...stories, ...features, bug].map(each => pairOf(each.id)),
    ...parents.map((parent, index) =>
      listOf(parent.id, [
        workTask(myTasks[index]!.id, { title: myTasks[index]!.title, mine: true, assignee: 'Ada Lovelace' }),
        workTask(parent.id * 10 + 1, { title: `Add the tracking events for ${parent.id}`, state: 'Closed', done: true, assignee: 'Alan Turing' })
      ])
    )
  ]
  return snapshotOf({
    board: board('contoso', { lanes: LANES }, LARGE_COLUMNS),
    mine: stories,
    other: [...features, bug, ...myTasks],
    families: { lists, parents }
  })
}
