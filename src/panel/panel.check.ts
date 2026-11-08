import { defineCheck } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import type { WorkSnapshot } from '../shared/work'
import { approvalOf, MINUTE, NOW as RUN_NOW, runOf, runsSnapshotOf, stageOf, waitingRun } from './pipelines/fixtures'
import { workViewKey } from './prefs'
import { prOf as summaryOf, reviewerOf, setOf, snapshotOf } from './prs/fixtures'
import { OPEN_REVIEW, reviewOf } from './prs/review/fixtures'
import { draftOf, LEVELS, OPEN_PAGE, pageOf, PROJECT_WIKI } from './wiki/fixtures'
import { board, BOARDS, item, LANES, listOf, parentOf, pr, snapshotOf as snapshotOfWork, task, workTask } from './work/fixtures'

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

const NOW = 1_700_000_000_000
const states = { columns: [], states: ['New', 'Active', 'Resolved', 'Closed'] }

const workSnapshot: WorkSnapshot = snapshotOfWork({
  mine: [
    item(101, { title: 'Fix the sign-in redirect that sends people to the wrong page', column: 'Active', prs: [pr(55, { state: 'merged' })] }),
    item(102, { title: 'Add CSV export', column: 'New', prs: [pr(56, { build: 'running' }), pr(57, { target: 'release', build: 'failed' })] }),
    item(103, { title: 'Cache invalidation', column: 'Active' })
  ],
  other: [
    item(210, { type: 'Feature', title: 'Checkout revamp', column: null, targets: states }),
    task(201, { title: 'Update the runbook', state: 'New', targets: { columns: [], states: ['Active', 'Closed'] } }),
    task(301, { title: 'Write the redirect tests', parentId: 101, parentTitle: 'Fix the sign-in redirect that sends people to the wrong page' }),
    task(304, { title: 'Draft the delivery copy', parentId: 150, parentTitle: 'Show the delivery estimate' }),
    task(305, { title: 'Check the payment flags', parentId: 210, parentTitle: 'Checkout revamp' })
  ],
  nudges: [{ itemId: 101, prId: 55, branch: 'main', toColumn: 'Done' }],
  families: {
    parents: [parentOf(150, { title: 'Show the delivery estimate', column: 'Active' })],
    lists: [
      listOf(
        101,
        [
          workTask(301, { title: 'Write the redirect tests', mine: true, assignee: 'Ada Lovelace' }),
          workTask(302, { title: 'Update the sign-in copy', assignee: null }),
          workTask(303, { title: 'Reproduce on staging', state: 'Closed', done: true, assignee: 'Grace Hopper' })
        ],
        { total: 4, done: 2 }
      ),
      listOf(150, [workTask(304, { title: 'Draft the delivery copy', mine: true, assignee: 'Ada Lovelace' }), workTask(306, { title: 'Pick the estimate rules' })])
    ]
  }
})

const workLanesSnapshot: WorkSnapshot = {
  ...workSnapshot,
  board: board('contoso', { lanes: LANES }),
  mine: workSnapshot.mine.map(each => (each.id === 102 ? { ...each, lane: 'Expedite' } : each)),
  families: { ...workSnapshot.families, parents: workSnapshot.families.parents.map(parent => ({ ...parent, lane: 'Expedite' })) }
}

const WEB_API = { repoId: 'repo-api', repoName: 'fabrikam-api' }
const TOOLS_APP = { projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: 'repo-tools-app', repoName: 'web-app' }
const GRACE = { id: 'u-grace', name: 'Grace Hopper' }

const prsSnapshot = snapshotOf({
  sets: [
    setOf(
      [
        summaryOf(70, { target: 'develop', checks: { build: 'running', policies: 'pending' } }),
        summaryOf(71, { ...TOOLS_APP, target: 'develop', reviewers: [reviewerOf('Grace Hopper', 0, { isRequired: true })] })
      ],
      { title: 'Rename the tenant setting in every project', sources: ['feature/tenant-setting'] }
    ),
    setOf(
      [
        summaryOf(55, {
          target: 'develop',
          autoComplete: true,
          checks: { build: 'succeeded', policies: 'approved' },
          reviewers: [reviewerOf('Grace Hopper', 10), reviewerOf('Edsger Dijkstra', 0, { isRequired: true })]
        }),
        summaryOf(56, { target: 'qa', mergeStatus: 'conflicts', checks: { build: 'failed', policies: 'rejected' } }),
        summaryOf(57, { target: 'main', status: 'completed', closedAt: NOW - 3_600_000 }),
        summaryOf(58, { ...WEB_API, source: 'feature/login-api', target: 'develop', checks: { build: 'running', policies: 'pending' } })
      ],
      { title: 'Fix the sign-in redirect that sends people to the wrong page', sources: ['feature/login', 'feature/login-api'] }
    ),
    setOf([summaryOf(60, { ...WEB_API, title: 'Add CSV export', isDraft: true, checks: { build: 'running', policies: 'pending' } })]),
    setOf([summaryOf(61, { title: 'Tidy the footer links', status: 'completed', closedAt: NOW - 600_000 }), summaryOf(62, { title: 'Tidy the footer links' })]),
    setOf([summaryOf(65, { ...TOOLS_APP, title: 'Pin the build image', autoComplete: true, checks: { build: 'succeeded', policies: 'approved' } })])
  ],
  toReview: [
    summaryOf(80, { ...WEB_API, title: 'Cache the lookups', createdBy: GRACE }),
    summaryOf(82, { ...TOOLS_APP, title: 'Speed up the nightly export', createdBy: GRACE }),
    summaryOf(83, { title: 'Tighten the cookie settings', createdBy: GRACE })
  ],
  toReviewCount: 3,
  reviewed: [
    summaryOf(81, {
      ...WEB_API,
      title: 'Add the health endpoint',
      createdBy: GRACE,
      reviewers: [reviewerOf('Ada Lovelace', 5, { id: 'u-contoso' })]
    })
  ],
  updatedAt: NOW
})

const runsSnapshot = runsSnapshotOf({
  runs: [
    waitingRun(3, [approvalOf('approval-3', 3, { canApprove: true, instructions: 'Check the smoke tests before approving.' })], {
      repository: { id: 'repo-web-app', name: 'web-app' }
    }),
    runOf(2, {
      repository: { id: 'repo-api', name: 'fabrikam-api' },
      state: 'running',
      startedAt: RUN_NOW - 4 * MINUTE,
      finishedAt: null,
      watched: true,
      stages: [stageOf('Build', 'succeeded'), stageOf('Image', 'running'), stageOf('Deploy production', 'pending')]
    }),
    runOf(1, {
      projectId: 'proj-tools',
      projectName: 'Contoso Tools',
      repository: { id: 'repo-tools-app', name: 'web-app' },
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
  'signing-in-microsoft': {
    requests: {
      'orgs.list': [
        org('contoso', {
          method: 'entra',
          state: 'signing-in',
          account: null,
          tokenStore: { kind: 'orca-secrets' },
          signInUrl:
            'https://login.microsoftonline.com/0f0e0d0c-0b0a-4908-8706-050403020100/oauth2/v2.0/authorize?client_id=6a1d3b5c-7e9f-4b2d-8c4a-1f3e5d7b9a20'
        })
      ]
    }
  },
  connected: { requests: { 'orgs.list': [org('contoso'), org('fabrikam')] } },
  work: {
    requests: {
      'orgs.list': [org('contoso', { boards: BOARDS })],
      'ui.visibility': { ok: true },
      'work.snapshot': workSnapshot
    }
  },
  workLanes: {
    persisted: { plugin: { workViews: { [workViewKey('contoso', BOARDS)]: 'lanes' } } },
    requests: {
      'orgs.list': [org('contoso', { boards: BOARDS })],
      'ui.visibility': { ok: true },
      'work.snapshot': workLanesSnapshot
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
  prsToReview: {
    persisted: { plugin: { prsPrefs: { contoso: { project: null, repo: null, view: 'review' } } }, workspace: { tab: 'prs' } },
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
