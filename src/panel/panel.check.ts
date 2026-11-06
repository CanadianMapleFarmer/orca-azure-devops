import { defineCheck } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import type { WorkItemSummary, WorkSnapshot } from '../shared/work'
import { approvalOf, MINUTE, NOW as RUN_NOW, runOf, runsSnapshotOf, stageOf, waitingRun } from './pipelines/fixtures'
import { prOf as summaryOf, reviewerOf, setOf, snapshotOf } from './prs/fixtures'
import { OPEN_REVIEW, reviewOf } from './prs/review/fixtures'
import { draftOf, LEVELS, OPEN_PAGE, pageOf, PROJECT_WIKI } from './wiki/fixtures'

function org(name: string, over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'azure-cli',
    state: 'connected',
    account: { adoId: `u-${name}`, uniqueName: `ada@${name}.com`, displayName: 'Ada Lovelace', tenantId: null, objectId: null },
    tokenStore: { kind: 'az-profile', path: `/Users/ada/.orca-azure-devops/az/${name}` },
    boards: null,
    codeProjects: 'all',
    ...over
  }
}

const BOARDS = { projectId: 'proj-web', projectName: 'Fabrikam Web', teamId: 'team-web', teamName: 'Web Team' }
const NOW = 1_700_000_000_000

function item(id: number, over: Partial<WorkItemSummary>): WorkItemSummary {
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
    assignedTo: 'Ada Lovelace',
    parentId: null,
    parentTitle: null,
    changedAt: NOW,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/${id}`,
    prs: [],
    targets: { columns: ['New', 'Active', 'Done'], states: [] },
    ...over
  }
}

const prOf = (prId: number, over: Partial<WorkItemSummary['prs'][number]>): WorkItemSummary['prs'][number] => ({
  prId,
  repoId: 'repo-web',
  projectId: BOARDS.projectId,
  target: 'main',
  state: 'open',
  build: 'none',
  url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web/pullrequest/${prId}`,
  ...over
})

const workSnapshot: WorkSnapshot = {
  org: 'contoso',
  board: {
    org: 'contoso',
    projectId: BOARDS.projectId,
    teamId: BOARDS.teamId,
    boardId: 'board-stories',
    boardName: 'Stories',
    requirementTypes: ['User Story'],
    columns: ['New', 'Active', 'Done'].map((name, index) => ({
      id: `col-${index}`,
      name,
      isSplit: false,
      columnType: index === 0 ? 'incoming' : index === 2 ? 'outgoing' : 'inProgress',
      stateMappings: { 'User Story': name }
    })),
    lanes: [],
    fields: { column: 'WEF_1_Kanban.Column', columnDone: 'WEF_1_Kanban.Column.Done', lane: 'WEF_1_Kanban.Lane' },
    areaPaths: [],
    doneStates: {}
  },
  mine: [
    item(101, { title: 'Fix the sign-in redirect that sends people to the wrong page', column: 'Active', prs: [prOf(55, { state: 'merged' })] }),
    item(102, { title: 'Add CSV export', column: 'New', prs: [prOf(56, { build: 'running' }), prOf(57, { target: 'release', build: 'failed' })] }),
    item(103, { title: 'Cache invalidation', column: 'Active' })
  ],
  other: [
    item(201, { type: 'Task', title: 'Update the runbook', state: 'New', column: null, targets: { columns: [], states: ['Active', 'Closed'] } })
  ],
  nudges: [{ itemId: 101, prId: 55, branch: 'main', toColumn: 'Done' }],
  updatedAt: NOW,
  stale: false
}

const prsSnapshot = snapshotOf({
  sets: [
    setOf(
      [
        summaryOf(55, {
          target: 'develop',
          autoComplete: true,
          checks: { build: 'succeeded', policies: 'approved' },
          reviewers: [reviewerOf('Grace Hopper', 10), reviewerOf('Edsger Dijkstra', 0, { isRequired: true })]
        }),
        summaryOf(56, { target: 'qa', mergeStatus: 'conflicts', checks: { build: 'failed', policies: 'rejected' } }),
        summaryOf(57, { target: 'main', status: 'completed', closedAt: NOW - 3_600_000 })
      ],
      { title: 'Fix the sign-in redirect that sends people to the wrong page', sources: ['feature/login'] }
    ),
    setOf([summaryOf(60, { title: 'Add CSV export', repoName: 'api', isDraft: true, checks: { build: 'running', policies: 'pending' } })])
  ],
  toReview: [summaryOf(80, { title: 'Cache the lookups', repoName: 'api', createdBy: { id: 'u-grace', name: 'Grace Hopper' } })],
  toReviewCount: 1,
  reviewed: [
    summaryOf(81, {
      title: 'Add the health endpoint',
      repoName: 'api',
      createdBy: { id: 'u-grace', name: 'Grace Hopper' },
      reviewers: [reviewerOf('Ada Lovelace', 5, { id: 'u-contoso' })]
    })
  ],
  updatedAt: NOW
})

const runsSnapshot = runsSnapshotOf({
  runs: [
    waitingRun(3, [approvalOf('approval-3', 3, { canApprove: true, instructions: 'Check the smoke tests before approving.' })]),
    runOf(2, {
      state: 'running',
      startedAt: RUN_NOW - 4 * MINUTE,
      finishedAt: null,
      watched: true,
      stages: [stageOf('Build', 'succeeded'), stageOf('Image', 'running'), stageOf('Deploy production', 'pending')]
    }),
    runOf(1, {
      state: 'failed',
      prId: 77,
      finishedAt: RUN_NOW - 12 * MINUTE,
      stages: [stageOf('Build', 'succeeded'), stageOf('Image', 'failed'), stageOf('Deploy production', 'skipped')]
    })
  ]
})

export default defineCheck({
  empty: { requests: { 'orgs.list': [] } },
  'signing-in': { requests: { 'orgs.list': [org('contoso', { state: 'signing-in', account: null })] } },
  connected: { requests: { 'orgs.list': [org('contoso'), org('fabrikam')] } },
  work: {
    requests: {
      'orgs.list': [org('contoso', { boards: BOARDS })],
      'ui.visibility': { ok: true },
      'work.snapshot': workSnapshot
    }
  },
  prs: {
    persisted: { workspace: { tab: 'prs' } },
    requests: {
      'orgs.list': [org('contoso')],
      'ui.visibility': { ok: true },
      'prs.snapshot': prsSnapshot
    }
  },
  review: {
    persisted: { workspace: { tab: 'prs', openReview: OPEN_REVIEW } },
    requests: {
      'orgs.list': [org('contoso')],
      'ui.visibility': { ok: true },
      'prs.snapshot': prsSnapshot,
      'reviews.open': reviewOf()
    }
  },
  pipelines: {
    persisted: { workspace: { tab: 'pipelines' } },
    requests: {
      'orgs.list': [org('contoso')],
      'ui.visibility': { ok: true },
      'runs.snapshot': runsSnapshot
    }
  },
  wiki: {
    persisted: { workspace: { tab: 'wiki', wikiPage: OPEN_PAGE } },
    requests: {
      'orgs.list': [org('contoso')],
      'ui.visibility': { ok: true },
      'wiki.list': [PROJECT_WIKI],
      'wiki.pages': input => LEVELS[input.path] ?? { pages: [], total: 0 },
      'wiki.page': pageOf('/Runbooks/Deploy'),
      'wiki.drafts': [draftOf('/Runbooks/Deploy', { changed: true })]
    }
  },
  wikiTree: {
    persisted: { workspace: { tab: 'wiki' } },
    requests: {
      'orgs.list': [org('contoso')],
      'ui.visibility': { ok: true },
      'wiki.list': [PROJECT_WIKI],
      'wiki.pages': input => LEVELS[input.path] ?? { pages: [], total: 0 },
      'wiki.drafts': [draftOf('/Runbooks/Deploy', { changed: true }), draftOf('/Home', { publishedAt: 1_700_000_000_000 })]
    }
  },
  mismatch: {
    requests: {
      'orgs.list': [
        org('contoso', {
          state: 'mismatch',
          message: 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
        })
      ]
    }
  }
})
