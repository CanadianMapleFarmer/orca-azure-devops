import { assert, test } from 'orca/testing'
import type { OrgStatus, PinnedAccount } from '../../src/shared/types'
import { NO_FAMILIES, type TaskList, type WorkItemSummary, type WorkSnapshot } from '../../src/shared/work'
import { loadBoardConfig } from '../ado/board-config'
import { AdoError, createAdoHttp } from '../ado/http'
import { CHILD_LINK, TASK_FIELDS, type RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { currentContext, type Priority } from '../data/context'
import { createEntities } from '../data/entities'
import { cacheKey, createPersisted, type CachePort } from '../data/persist'
import { createSavedTables } from '../data/saved-tables'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock, memoryCache } from '../test-support'
import {
  addChildren,
  BOARDS,
  fixture,
  fakeAdo,
  FEATURES,
  FEATURES_WEF,
  isActiveList,
  isBatch,
  isDelta,
  isFieldsBatch,
  isHydrate,
  isPatch,
  isPullRequest,
  isRevRead,
  isStillIn,
  isTypeStates,
  isWiql,
  json,
  ORG,
  ORG_URL,
  PROJECT,
  REPO,
  STORIES,
  TEAM,
  WEF,
  type AdoCall
} from './fake-ado'
import { createBoardFilters } from './board-filters'
import { createBoardsService, type BoardChange, type BoardResult } from './service'
import { createItemSource, loadMine } from './snapshot'

const T0 = Date.parse('2026-11-04T09:00:00Z')
const MINUTE = 60_000
const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const NO_BOARDS = "Pick a boards project and team in this org's settings."
const NEEDS_CODE_READ = 'Linked PR status needs Code (Read) access.'
const NOT_CONNECTED = 'Connect this organization first.'
const SHOWING_SAVED = 'Showing what was saved last time. Refreshing…'
const INTERRUPTED = 'Sign-in was interrupted. Try again.'
const REJECTED = 'Azure DevOps rejected the credentials.'
const FILTER_NOT_SAVED = "Couldn't save this board's filter."
const DATE_PRECISION = 'You cannot supply a time with the date when running a query using date precision.'
const COLUMNS = ['New', 'Active', 'In Review', 'Resolved', 'Closed']
const MINE_QUERY =
  "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed') ORDER BY [System.ChangedDate] DESC"

function status(overrides: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: null,
    tokenStore: { kind: 'orca-secrets' },
    boards: BOARDS,
    codeProjects: 'all',
    ...overrides
  }
}

function harness(first: OrgStatus = status(), restart: { cache?: Record<string, unknown>; at?: number } = {}) {
  const clock = fakeClock(restart.at ?? T0)
  const ado = fakeAdo({ now: clock.now })
  const storage: Record<string, unknown> = {}
  const heldReads = new Map<string, Promise<void>>()
  const store: StorePort = {
    get: async <T,>(key: string) => {
      const gate = heldReads.get(key)
      heldReads.delete(key)
      await gate
      return key in storage ? (structuredClone(storage[key]) as T) : null
    },
    set: async (key, value) => {
      storage[key] = structuredClone(value)
    }
  }
  const posts: WorkSnapshot[] = []
  const boardPosts: BoardChange[] = []
  let orgs = [first]
  const authHeader = async (org: string) => {
    if (orgs.find(entry => entry.org === org)?.state !== 'connected') throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return 'Bearer test-credential'
  }
  const http = createAdoHttp({ fetch: ado.fetch, authHeader, sleep: async () => {} })
  const scheduler = createScheduler(clock)
  const entities = createEntities(clock.now)
  const cache = memoryCache(restart.cache)
  const heldCacheReads = new Map<string, Promise<void>>()
  const port: CachePort = {
    ...cache.port,
    get: async key => {
      const gate = heldCacheReads.get(key)
      heldCacheReads.delete(key)
      await gate
      return cache.port.get(key)
    }
  }
  const logs: string[] = []
  const persisted = createPersisted({ port, orgs: async () => structuredClone(orgs), now: clock.now, clock, log: message => logs.push(message) })
  const service = createBoardsService({
    http,
    orgs: async () => structuredClone(orgs),
    store,
    scheduler,
    post: snapshot => posts.push(structuredClone(snapshot)),
    postBoard: change => boardPosts.push(change),
    now: clock.now,
    entities,
    persisted,
    savedTables: createSavedTables(entities, persisted),
    log: message => logs.push(message)
  })
  return {
    ado,
    clock,
    store,
    storage,
    posts,
    boardPosts,
    service,
    scheduler,
    entities,
    cache,
    persisted,
    logs,
    setOrgs(next: OrgStatus[]) {
      orgs = next
      service.onOrgs(structuredClone(next))
    },
    holdRead(key: string): { release(): void } {
      let release = () => {}
      heldReads.set(key, new Promise<void>(resolve => (release = resolve)))
      return { release: () => release() }
    },
    holdCacheRead(key: string): { release(): void } {
      let release = () => {}
      heldCacheReads.set(key, new Promise<void>(resolve => (release = resolve)))
      return { release: () => release() }
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function item(snapshot: WorkSnapshot | undefined, id: number): WorkItemSummary | undefined {
  return [...(snapshot?.mine ?? []), ...(snapshot?.other ?? [])].find(entry => entry.id === id)
}

const isMineWiql = (call: AdoCall) => isWiql(call) && !isStillIn(call) && !call.body.query.includes('[System.WorkItemType] IN')
const isBoardWiql = (call: AdoCall) => isWiql(call) && !isStillIn(call) && call.body.query.includes('[System.WorkItemType] IN')

function story(id: number, changedAt: number, title = `Story ${id}`): RawWorkItem {
  return {
    id,
    rev: 1,
    url: `${ORG_URL}/${PROJECT}/_apis/wit/workItems/${id}`,
    fields: {
      'System.TeamProject': 'Fabrikam Web',
      'System.WorkItemType': 'User Story',
      'System.Title': title,
      'System.State': 'Active',
      'System.ChangedDate': new Date(changedAt).toISOString(),
      [`${WEF}.Column`]: 'Active'
    }
  }
}

test('snapshot splits mine and other and attaches chips and parents', async () => {
  const h = harness()
  const snapshot = await h.service.snapshot(ORG)

  assert.equal(snapshot.org, ORG)
  assert.equal(snapshot.board?.boardId, STORIES)
  assert.deepEqual(snapshot.mine.map(entry => entry.id), [1204])
  assert.deepEqual(snapshot.other.map(entry => entry.id), [1207, 1205])
  assert.deepEqual(snapshot.mine[0], {
    org: ORG,
    id: 1204,
    rev: 9,
    type: 'User Story',
    title: 'Add vehicle search filters',
    state: 'Active',
    column: 'In Review',
    columnDone: true,
    lane: 'Expedite',
    assignedTo: 'Alex Contoso',
    parentId: 1100,
    parentTitle: 'Vehicle search',
    changedAt: Date.parse('2026-11-03T14:20:11.5Z'),
    url: `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204`,
    prs: [
      {
        prId: 321,
        repoId: REPO,
        projectId: PROJECT,
        target: 'release/2026.11',
        state: 'merged',
        build: 'none',
        url: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/321`
      }
    ],
    targets: { columns: COLUMNS, states: [] }
  })
  assert.equal(snapshot.other[0].parentTitle, 'Add vehicle search filters')
  assert.equal(snapshot.other[1].parentTitle, null)
  assert.deepEqual(snapshot.nudges, [])
  assert.equal(snapshot.stale, false)
  assert.equal(snapshot.updatedAt, T0)
  assert.equal(snapshot.message, undefined)

  const batches = h.ado.calls.filter(isBatch).map(call => call.body.ids)
  assert.deepEqual(batches, [[1204, 1207, 1205, 1208], [1100]], 'items, then every missing parent in one batch call')
  assert.deepEqual(h.ado.calls.filter(isPullRequest).map(call => call.path), [`/${ORG}/${PROJECT}/_apis/git/pullrequests/321`])
  assert.deepEqual(h.posts, [snapshot])

  const again = await h.service.snapshot(ORG)
  assert.deepEqual(again, snapshot)
  assert.equal(h.ado.calls.filter(isWiql).length, 1, 'snapshot serves the cached one')
})

test('"mine" asks only for items outside the done states of the board types', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const [wiql] = h.ado.calls.filter(isWiql)
  assert.equal(wiql.path, `/${ORG}/${PROJECT}/${TEAM}/_apis/wit/wiql`)
  assert.equal(wiql.body.query, MINE_QUERY)
})

test('items of types off the board are dropped when their state is done, with states cached for an hour', async () => {
  const h = harness()
  const first = await h.service.refresh(ORG)
  assert.equal(item(first, 1208), undefined)
  assert.equal(h.ado.count(isTypeStates('Task')), 1)

  await h.clock.tick(59 * MINUTE)
  await h.service.refresh(ORG)
  assert.equal(h.ado.count(isTypeStates('Task')), 1)

  await h.clock.tick(MINUTE)
  await h.service.refresh(ORG)
  assert.equal(h.ado.count(isTypeStates('Task')), 2)
})

test('board items move by column and items off the board by state', async () => {
  const h = harness()
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(item(snapshot, 1204)?.targets, { columns: COLUMNS, states: [] })
  assert.deepEqual(item(snapshot, 1207)?.targets, { columns: [], states: ['New', 'Closed', 'Removed'] })
})

test('a board-type item with no column is listed under Other and moves by state, with no board-column write', async () => {
  const h = harness()
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(snapshot.other.map(entry => entry.id), [1207, 1205])
  assert.deepEqual(item(snapshot, 1205)?.targets, { columns: [], states: ['Active', 'Resolved', 'Closed'] })

  const moved = await h.service.move({ org: ORG, id: 1205, rev: 3, to: { state: 'Active' } })
  assert.deepEqual(h.ado.calls.find(isPatch)?.body, [
    { op: 'test', path: '/rev', value: 3 },
    { op: 'replace', path: '/fields/System.State', value: 'Active' }
  ])
  assert.deepEqual([moved.state, moved.column, moved.rev], ['Active', null, 4])
  assert.deepEqual(h.posts.at(-1)?.other.map(entry => entry.id), [1207, 1205])
})

const JOINERS: Record<string, (service: ReturnType<typeof harness>['service']) => Promise<WorkSnapshot>> = {
  'a Work snapshot request': service => service.snapshot(ORG),
  'a Work refresh': service => service.refresh(ORG)
}

for (const [name, request] of Object.entries(JOINERS)) {
  test(`${name} that joins a background load raises its lane`, async () => {
    const h = harness()
    const priorities: Priority[] = []
    h.ado.on(
      () => {
        priorities.push(currentContext().lane.priority)
        return false
      },
      () => assert.fail('only records')
    )
    const held = h.ado.hold(() => true)
    h.service.visibility({ surface: 'work', org: ORG, visible: true })
    h.setOrgs([status()])
    await h.clock.tick(0)
    assert.ok(priorities.length > 0, 'the background load is waiting on its first answer')
    assert.deepEqual(priorities.filter(priority => priority !== 'visible'), [], 'in its visible lane')

    const answer = request(h.service)
    await drain()
    held.release()
    assert.equal((await answer).org, ORG)
    const joined = priorities.indexOf('user')
    assert.ok(joined > 0, 'calls after the join were made')
    assert.deepEqual(priorities.slice(joined).filter(priority => priority !== 'user'), [], 'every call after the join is a user call')
  })
}

test('a failed refresh keeps the last snapshot as stale', async () => {
  const h = harness()
  h.ado.on(isWiql, () => json(500, { message: 'TF246017: the database is unavailable.' }))
  const first = await rejection(h.service.snapshot(ORG))
  assert.equal(first.message, 'TF246017: the database is unavailable.')
  assert.deepEqual(h.posts, [])

  h.ado.clear()
  const good = await h.service.refresh(ORG)
  await h.clock.tick(MINUTE)
  h.ado.on(isWiql, () => json(500, { message: 'TF246017: the database is unavailable.' }))
  const stale = await h.service.refresh(ORG)
  assert.deepEqual(stale, { ...good, stale: true, message: 'TF246017: the database is unavailable.' })
  assert.deepEqual(h.posts.at(-1), stale)
  assert.deepEqual(await h.service.snapshot(ORG), stale)

  h.ado.clear()
  const recovered = await h.service.refresh(ORG)
  assert.equal(recovered.stale, false)
  assert.equal(recovered.message, undefined)
  assert.equal(recovered.updatedAt, T0 + MINUTE)
})

test('nudge appears for a merged PR into a ruled branch and not after dismissal', async () => {
  const h = harness()
  h.storage[`nudgeRules:${ORG}:${TEAM}`] = [{ branch: 'release/2026.11', column: 'Active' }]
  assert.deepEqual((await h.service.refresh(ORG)).nudges, [], 'the item is already past Active')

  h.storage[`nudgeRules:${ORG}:${TEAM}`] = [{ branch: 'main', column: 'Closed' }, { branch: 'refs/heads/release/2026.11', column: 'Resolved' }]
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(snapshot.nudges, [{ itemId: 1204, prId: 321, branch: 'release/2026.11', toColumn: 'Resolved' }])

  assert.deepEqual(await h.service.dismissNudge({ org: ORG, itemId: 1204, prId: 321 }), { ok: true })
  assert.deepEqual(h.posts.at(-1)?.nudges, [])
  assert.deepEqual(h.storage[`nudgeDismissed:${ORG}`], ['1204:321'])
  assert.deepEqual((await h.service.refresh(ORG)).nudges, [])
})

test('no rules means no nudges', async () => {
  const h = harness()
  const snapshot = await h.service.refresh(ORG)
  assert.equal(item(snapshot, 1204)?.prs[0].state, 'merged')
  assert.deepEqual(snapshot.nudges, [])
})

const RULES_KEY = `nudgeRules:${ORG}:${TEAM}`
const UNKNOWN_COLUMN = "That column isn't on this board."
const isBacklogConfig = (call: AdoCall) => call.path.endsWith('/work/backlogconfiguration')

test('nudge rules read back what is stored without calling Azure DevOps', async () => {
  const h = harness()
  assert.deepEqual(await h.service.nudgeRules({ org: ORG, teamId: TEAM }), { rules: [] })
  h.storage[RULES_KEY] = [{ branch: 'uat', column: 'Resolved' }]
  assert.deepEqual(await h.service.nudgeRules({ org: ORG, teamId: TEAM }), { rules: [{ branch: 'uat', column: 'Resolved' }] })
  assert.equal(h.ado.calls.length, 0)
})

test('saving nudge rules refreshes the snapshot so nudges appear and disappear', async () => {
  const h = harness()
  await h.service.snapshot(ORG)
  assert.deepEqual(h.posts.at(-1)?.nudges, [])

  const saved = await h.service.nudgeRules({ org: ORG, teamId: TEAM, rules: [{ branch: 'release/2026.11', column: 'Resolved' }] })
  assert.deepEqual(saved, { rules: [{ branch: 'release/2026.11', column: 'Resolved' }] })
  assert.deepEqual(h.storage[RULES_KEY], saved.rules)
  await drain()
  assert.deepEqual(h.posts.at(-1)?.nudges, [{ itemId: 1204, prId: 321, branch: 'release/2026.11', toColumn: 'Resolved' }])

  await h.service.nudgeRules({ org: ORG, teamId: TEAM, rules: [] })
  await drain()
  assert.deepEqual(h.storage[RULES_KEY], [])
  assert.deepEqual(h.posts.at(-1)?.nudges, [])
  assert.equal(h.ado.calls.filter(isBacklogConfig).length, 1, 'the board configuration the service already cached is reused')
})

test('saved nudge rules are trimmed, lose refs/heads and drop rows without a branch or column', async () => {
  const h = harness()
  const saved = await h.service.nudgeRules({
    org: ORG,
    teamId: TEAM,
    rules: [
      { branch: '  refs/heads/release/2026.11  ', column: 'Resolved' },
      { branch: '   ', column: 'Closed' },
      { branch: 'uat', column: '' },
      { branch: 'refs/heads/', column: 'Closed' },
      { branch: 'main', column: 'Closed' }
    ]
  })
  const expected = [{ branch: 'release/2026.11', column: 'Resolved' }, { branch: 'main', column: 'Closed' }]
  assert.deepEqual(saved.rules, expected)
  assert.deepEqual(h.storage[RULES_KEY], expected)
})

test('saved nudge rules are trimmed again after refs/heads is stripped, and other casings are kept as typed', async () => {
  const h = harness()
  const saved = await h.service.nudgeRules({
    org: ORG,
    teamId: TEAM,
    rules: [
      { branch: 'refs/heads/ uat', column: 'Resolved' },
      { branch: 'uat', column: 'Closed' },
      { branch: 'Refs/Heads/release', column: 'Active' },
      { branch: 'refs/heads/   ', column: 'Active' }
    ]
  })
  assert.deepEqual(saved.rules, [{ branch: 'uat', column: 'Closed' }, { branch: 'Refs/Heads/release', column: 'Active' }])
  assert.deepEqual(h.storage[RULES_KEY], saved.rules)
})

test('saved nudge rules keep one row per branch and the last one wins', async () => {
  const h = harness()
  const saved = await h.service.nudgeRules({
    org: ORG,
    teamId: TEAM,
    rules: [
      { branch: 'uat', column: 'Active' },
      { branch: 'main', column: 'Closed' },
      { branch: 'refs/heads/uat', column: 'Resolved' }
    ]
  })
  assert.deepEqual(saved.rules, [{ branch: 'uat', column: 'Resolved' }, { branch: 'main', column: 'Closed' }])
  assert.deepEqual(h.storage[RULES_KEY], saved.rules)
})

test('saved nudge rules are capped at 20, keeping the first', async () => {
  const h = harness()
  const many = Array.from({ length: 25 }, (_, index) => ({ branch: `release/${index}`, column: 'Closed' }))
  const saved = await h.service.nudgeRules({ org: ORG, teamId: TEAM, rules: many })
  assert.deepEqual(saved.rules, many.slice(0, 20))
  assert.deepEqual(h.storage[RULES_KEY], many.slice(0, 20))
})

test('nudge rules naming a column that is not on the board are refused and nothing is saved', async () => {
  const h = harness()
  const before = [{ branch: 'uat', column: 'Resolved' }]
  h.storage[RULES_KEY] = before
  const error = await rejection(
    h.service.nudgeRules({ org: ORG, teamId: TEAM, rules: [{ branch: 'main', column: 'Closed' }, { branch: 'qa', column: 'Shipped' }] })
  )
  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, UNKNOWN_COLUMN])
  assert.deepEqual(h.storage[RULES_KEY], before)
  await drain()
  assert.deepEqual(h.posts, [], 'a refused save refreshes nothing')
})

test('nudge rules can only be saved for the boards team the org is set to', async () => {
  const h = harness()
  const error = await rejection(h.service.nudgeRules({ org: ORG, teamId: 'another-team', rules: [{ branch: 'main', column: 'Closed' }] }))
  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, NO_BOARDS])
  assert.equal(RULES_KEY in h.storage, false)

  h.setOrgs([status({ boards: null })])
  const without = await rejection(h.service.nudgeRules({ org: ORG, teamId: TEAM, rules: [{ branch: 'main', column: 'Closed' }] }))
  assert.equal(without.message, NO_BOARDS)
  assert.equal(RULES_KEY in h.storage, false)
})

test('dismissed nudges are capped at 500 with the oldest dropped', async () => {
  const h = harness()
  h.storage[`nudgeDismissed:${ORG}`] = Array.from({ length: 500 }, (_, index) => `${index}:1`)
  await h.service.dismissNudge({ org: ORG, itemId: 1204, prId: 321 })
  await h.service.dismissNudge({ org: ORG, itemId: 1204, prId: 321 })
  const stored = h.storage[`nudgeDismissed:${ORG}`] as string[]
  assert.equal(stored.length, 500)
  assert.equal(stored[0], '1:1')
  assert.equal(stored.at(-1), '1204:321')
  assert.equal(stored.filter(entry => entry === '1204:321').length, 1)
})

test('move conflict refreshes the item and rethrows', async () => {
  for (const staleStatus of [400, 409, 412]) {
    const h = harness()
    h.ado.state.staleStatus = staleStatus
    await h.service.refresh(ORG)
    const theirs = h.ado.items.get(1204)!
    theirs.rev = 10
    theirs.fields['System.State'] = 'Resolved'
    theirs.fields[`${WEF}.Column`] = 'Resolved'
    theirs.fields[`${WEF}.Column.Done`] = false
    const posts = h.posts.length

    const error = await rejection(h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Closed' } }))
    assert.deepEqual({ code: error.code, status: error.status, message: error.message }, { code: 'conflict', status: 409, message: CONFLICT }, String(staleStatus))
    assert.equal(h.ado.items.get(1204)?.fields[`${WEF}.Column`], 'Resolved', 'their change is never overwritten')
    assert.equal(h.posts.length, posts + 1)
    const refreshed = item(h.posts.at(-1), 1204)
    assert.deepEqual([refreshed?.rev, refreshed?.column, refreshed?.state], [10, 'Resolved', 'Resolved'])
  }
})

test('a refused move of an unchanged item rethrows the original error after refreshing it', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  h.ado.on(isPatch, () => json(400, { message: 'TF401320: Rule Error for field Remaining Work.' }))
  const posts = h.posts.length
  const calls = h.ado.calls.length

  const error = await rejection(h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } }))
  assert.deepEqual({ code: error.code, message: error.message }, { code: 'bad_request', message: 'TF401320: Rule Error for field Remaining Work.' })
  const after = h.ado.calls.slice(calls)
  assert.equal(after.findIndex(isPatch), 0)
  assert.deepEqual(after.find(isBatch)?.body.ids, [1204])
  assert.equal(h.posts.length, posts + 1)
})

test('move reloads the item before patching when the cached rev is older', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const fresh = h.ado.items.get(1204)!
  fresh.rev = 11
  fresh.fields[`${WEF}.Column`] = 'Active'
  fresh.fields[`${WEF}.Column.Done`] = false
  const calls = h.ado.calls.length

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 11, to: { column: 'Resolved' } })
  const after = h.ado.calls.slice(calls)
  assert.deepEqual(after[0].body?.ids, [1204], 'the item is reloaded first')
  assert.deepEqual(after.find(isPatch)?.body, [
    { op: 'test', path: '/rev', value: 11 },
    { op: 'replace', path: '/fields/System.State', value: 'Resolved' },
    { op: 'replace', path: `/fields/${WEF}.Column`, value: 'Resolved' }
  ])
  assert.deepEqual([moved.rev, moved.column, moved.state, moved.parentTitle], [12, 'Resolved', 'Resolved', 'Vehicle search'])
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)
})

test('move tests the rev the caller saw, not a newer cached one', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const error = await rejection(h.service.move({ org: ORG, id: 1204, rev: 8, to: { column: 'Resolved' } }))
  assert.equal(error.message, CONFLICT)
  assert.equal(h.ado.calls.find(isPatch)?.body[0].value, 8)
  assert.equal(h.ado.items.get(1204)?.rev, 9)
})

test('linkPr links the pull request and returns the item with its chip', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const linked = await h.service.linkPr({ org: ORG, id: 1205, rev: 3, prUrl: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322` })
  assert.equal(linked.rev, 4)
  assert.deepEqual(linked.prs.map(chip => [chip.prId, chip.state, chip.build, chip.target]), [[322, 'open', 'succeeded', 'main']])
  assert.deepEqual(item(h.posts.at(-1), 1205), linked)
})

const PR_322 = `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322`
const NOT_A_PR = "That isn't an Azure DevOps pull request link."
const isCommentPost = (id: number) => (call: AdoCall) => call.method === 'POST' && call.path.endsWith(`/workItems/${id}/comments`)

test('a linkPr refused because someone edited the item meanwhile reports the conflict, and the retry links it', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const theirs = h.ado.items.get(1205)!
  let edited = false
  h.ado.on(
    call => isPatch(call) && !edited,
    () => {
      edited = true
      theirs.rev = 4
      theirs.fields['System.Title'] = 'Fix the pagination offset'
      return json(400, { message: 'TF26071: This work item has been changed by someone else since you opened it.' })
    }
  )
  const error = await rejection(h.service.linkPr({ org: ORG, id: 1205, rev: 3, prUrl: PR_322 }))
  assert.deepEqual({ code: error.code, message: error.message }, { code: 'conflict', message: CONFLICT })
  assert.deepEqual([item(h.posts.at(-1), 1205)?.rev, item(h.posts.at(-1), 1205)?.title], [4, 'Fix the pagination offset'])
  assert.equal(theirs.relations, undefined)

  const linked = await h.service.linkPr({ org: ORG, id: 1205, rev: 3, prUrl: PR_322 })
  assert.equal(linked.rev, 5)
  assert.deepEqual(linked.prs.map(chip => chip.prId), [322])
})

test('linkPr succeeds after a comment in the same details session', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  h.ado.on(isCommentPost(1205), () => {
    h.ado.items.get(1205)!.rev += 1
    return json(200, { id: 78, text: 'Linking the fix', createdBy: { displayName: 'Alex Contoso' }, createdDate: '2026-11-04T09:00:00Z' })
  })
  const details = await h.service.details(ORG, 1205)
  await h.service.comment(ORG, 1205, 'Linking the fix')
  assert.equal(item(h.posts.at(-1), 1205)?.rev, 4, 'the comment publishes the item at its new rev')

  const linked = await h.service.linkPr({ org: ORG, id: 1205, rev: details.item.rev, prUrl: PR_322 })
  assert.equal(linked.rev, 5)
  assert.deepEqual(linked.prs.map(chip => chip.prId), [322])
  assert.deepEqual(item(h.posts.at(-1), 1205), linked)
})

test('a posted comment is returned even when publishing the reloaded item fails', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  Object.defineProperty(h.storage, `nudgeDismissed:${ORG}`, {
    enumerable: true,
    get() {
      throw new Error('storage unavailable')
    }
  })
  const added = await h.service.comment(ORG, 1204, 'Ready for review')
  assert.equal(added.textMd, 'Ready for review')
  assert.equal(h.ado.calls.filter(isCommentPost(1204)).length, 1)
})

test('a bad pull request link gets the link message, never the conflict, and nothing is sent', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  h.ado.items.get(1205)!.rev = 5
  const calls = h.ado.calls.length
  for (const prUrl of ['nope', 'https://dev.azure.com/fabrikam/Ops/_git/web-app/pullrequest/5', `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/0`]) {
    const error = await rejection(h.service.linkPr({ org: ORG, id: 1205, rev: 3, prUrl }))
    assert.deepEqual({ code: error.code, status: error.status, message: error.message }, { code: 'bad_request', status: 400, message: NOT_A_PR }, prUrl)
  }
  assert.deepEqual(h.ado.calls.slice(calls), [])
})

test('orgs without boards get the settings message', async () => {
  const h = harness()
  h.setOrgs([status({ boards: null })])
  assert.deepEqual(await h.service.snapshot(ORG), {
    org: ORG,
    board: null,
    mine: [],
    other: [],
    nudges: [],
    families: NO_FAMILIES,
    updatedAt: T0,
    stale: false,
    message: NO_BOARDS
  })
  assert.equal((await h.service.refresh(ORG)).message, NO_BOARDS)
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, 0)
  assert.deepEqual(h.posts, [])
})

test('the Work job runs every minute while visible, backs off to 2 min while unchanged, and still posts each load', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isMineWiql), 0, 'a hidden Work tab is not polled')

  assert.deepEqual(h.service.visibility({ surface: 'work', org: ORG, visible: true }), { ok: true })
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 1, 'shown, it loads at once')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 2)
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 2, 'an unchanged load backs off')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 3)
  assert.equal(h.posts.length, 3, 'unchanged loads still post')
  assert.deepEqual(h.posts.map(post => post.updatedAt), [T0 + 5 * MINUTE, T0 + 6 * MINUTE, T0 + 8 * MINUTE], 'so "Updated" stays honest')

  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 3, 'back-off stops at 2 min')
  h.ado.change(1204)
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 4)
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 5, 'a change returns it to every minute')

  const early = harness()
  early.service.visibility({ surface: 'work', org: ORG, visible: true })
  early.setOrgs([status()])
  await early.clock.tick(0)
  await early.clock.tick(MINUTE)
  assert.equal(early.ado.count(isMineWiql), 2, 'visibility reported before the job existed still applies')
})

test('jobs follow org status: added when connected, removed otherwise', async () => {
  const h = harness()
  h.service.visibility({ surface: 'work', org: ORG, visible: true })
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 1)

  for (const state of ['error', 'expired', 'mismatch', 'signing-in', 'disconnected'] as const) {
    h.setOrgs([status({ state })])
    await h.clock.tick(10 * MINUTE)
    assert.equal(h.ado.count(isMineWiql), 1, state)
  }

  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 2)
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 2, 'an unchanged status keeps the job and its cadence')

  h.setOrgs([status({ boards: null })])
  await h.clock.tick(10 * MINUTE)
  h.setOrgs([])
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.count(isMineWiql), 2)
})

test('a forbidden PR-chip load disables chips for 10 minutes with the scope message', async () => {
  const h = harness()
  h.ado.on(isPullRequest, () => json(403, { message: 'TF401027: You need the Git GenericRead permission.' }))
  const first = await h.service.refresh(ORG)
  assert.equal(first.message, NEEDS_CODE_READ)
  assert.deepEqual(first.mine.map(entry => [entry.id, entry.prs]), [[1204, []]])
  assert.equal(h.ado.count(isPullRequest), 1)

  h.ado.clear()
  await h.clock.tick(9 * MINUTE)
  const cooling = await h.service.refresh(ORG)
  assert.equal(cooling.message, NEEDS_CODE_READ)
  assert.equal(h.ado.count(isPullRequest), 1, 'no retry while chips are off')

  await h.clock.tick(MINUTE)
  const back = await h.service.refresh(ORG)
  assert.equal(back.message, undefined)
  assert.equal(h.ado.count(isPullRequest), 2)
  assert.equal(item(back, 1204)?.prs[0].prId, 321)
})

function linkPullRequests(h: ReturnType<typeof harness>, id: number, prs: Record<number, { status: string; target: string }>): void {
  const raw = h.ado.items.get(id)!
  const links = Object.keys(prs).map(prId => ({ rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F${prId}`, attributes: { name: 'Pull Request' } }))
  raw.relations = [...(raw.relations ?? []), ...links]
  h.ado.on(
    call => isPullRequest(call) && Number(call.path.split('/').at(-1)) in prs,
    call => {
      const prId = Number(call.path.split('/').at(-1))
      return json(200, { ...fixture<object>('pull-request-active'), pullRequestId: prId, status: prs[prId].status, targetRefName: `refs/heads/${prs[prId].target}` })
    }
  )
}

test('an item shows one chip per target branch, and its details give every linked PR its state', async () => {
  const h = harness()
  linkPullRequests(h, 1204, {
    401: { status: 'abandoned', target: 'dev' },
    402: { status: 'active', target: 'dev' },
    403: { status: 'completed', target: 'staging' },
    404: { status: 'active', target: 'master' }
  })
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(item(snapshot, 1204)?.prs.map(chip => [chip.target, chip.prId, chip.state]), [
    ['release/2026.11', 321, 'merged'],
    ['dev', 402, 'open'],
    ['staging', 403, 'merged'],
    ['master', 404, 'open']
  ])

  const details = await h.service.details(ORG, 1204)
  assert.deepEqual(details.item.prs, item(snapshot, 1204)?.prs)
  assert.deepEqual(
    details.links.filter(link => link.kind === 'pr').map(link => link.title),
    ['Pull request 321 (merged)', 'Pull request 401 (abandoned)', 'Pull request 402 (open)', 'Pull request 403 (merged)', 'Pull request 404 (open)']
  )
})

test('new checks from the PRs tab update board and Work chips without a request', async () => {
  const h = harness()
  linkPullRequests(h, 1204, { 402: { status: 'active', target: 'dev' } })
  boardIds(h, [1204])
  const chipOf402 = (items: WorkItemSummary[] | undefined) => items?.find(entry => entry.id === 1204)?.prs.find(chip => chip.prId === 402)
  assert.equal(chipOf402((await h.service.refresh(ORG)).mine)?.build, 'succeeded')
  assert.equal(chipOf402((await h.service.board({ ...STORIES_BOARD, everyone: true })).items)?.build, 'succeeded')
  const calls = h.ado.calls.length
  const boardPosts = h.boardPosts.length

  const key = `${PROJECT}/${REPO}/402`
  const checks = h.entities.of(ORG).prChecks
  checks.put(key, { ...checks.get(key)!.value, build: 'failed' })
  await drain()

  assert.equal(chipOf402(h.posts.at(-1)?.mine)?.build, 'failed')
  assert.deepEqual(h.boardPosts.slice(boardPosts), [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.equal(chipOf402((await h.service.board({ ...STORIES_BOARD, everyone: true })).items)?.build, 'failed')
  assert.equal(h.ado.calls.length, calls)
})

test('a PR that merges updates the Work tab\'s nudges without a request', async () => {
  const h = harness()
  h.storage[`nudgeRules:${ORG}:${TEAM}`] = [{ branch: 'dev', column: 'Resolved' }]
  linkPullRequests(h, 1204, { 402: { status: 'active', target: 'dev' } })
  assert.deepEqual((await h.service.refresh(ORG)).nudges, [])
  const calls = h.ado.calls.length
  const posts = h.posts.length

  const key = `${PROJECT}/${REPO}/402`
  const prs = h.entities.of(ORG).prs
  prs.put(key, { ...prs.get(key)!.value, status: 'completed' })
  await drain()

  assert.equal(h.posts.length, posts + 1)
  assert.deepEqual(h.posts.at(-1)?.nudges, [{ itemId: 1204, prId: 402, branch: 'dev', toColumn: 'Resolved' }])
  assert.equal(item(h.posts.at(-1), 1204)?.prs.find(chip => chip.prId === 402)?.state, 'merged')
  assert.equal(h.ado.calls.length, calls)
})

test('a PR store change that leaves the chips as they were posts nothing', async () => {
  const h = harness()
  linkPullRequests(h, 1204, { 402: { status: 'active', target: 'dev' } })
  boardIds(h, [1204])
  await h.service.refresh(ORG)
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  const posts = h.posts.length
  const boardPosts = h.boardPosts.length

  const tables = h.entities.of(ORG)
  const key = `${PROJECT}/${REPO}/402`
  tables.prs.put(key, tables.prs.get(key)!.value)
  tables.prChecks.put(`${PROJECT}/${REPO}/777`, { build: 'failed', policies: 'rejected', commit: null, reviewers: '' })
  await drain()

  assert.equal(h.posts.length, posts)
  assert.equal(h.boardPosts.length, boardPosts)
})

test('an hour later merged PR chips are not read again', async () => {
  const h = harness()
  assert.equal(item(await h.service.refresh(ORG), 1204)?.prs[0].state, 'merged')
  assert.deepEqual([h.ado.count(isActiveList), h.ado.count(isPullRequest)], [1, 1], 'one sweep, then the merged PR by id')

  await h.clock.tick(61 * MINUTE)
  assert.equal(item(await h.service.refresh(ORG), 1204)?.prs[0].state, 'merged')
  assert.deepEqual([h.ado.count(isActiveList), h.ado.count(isPullRequest)], [1, 1])
})

test('a snapshot keeps the newest items that fit in one post', async () => {
  const h = harness()
  const ids = Array.from({ length: 600 }, (_, index) => 7000 + index)
  for (const id of ids) h.ado.items.set(id, story(id, T0 - (id - 7000) * MINUTE, `${id} ${'é'.repeat(250)}`))
  h.ado.state.wiql = ids

  const snapshot = await h.service.refresh(ORG)
  const count = snapshot.mine.length
  assert.ok(count > 100 && count < 600, String(count))
  assert.deepEqual(snapshot.mine.map(entry => entry.id), ids.slice(0, count))
  assert.equal(snapshot.message, `Showing the ${count} most recently changed items.`)
  assert.ok(Buffer.byteLength(JSON.stringify(h.posts.at(-1))) < 256 * 1024)
})

test('the board loads at 30 s, backs off to 60 s while unchanged, and returns to 30 s after a change', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.state.wiql = [1204, 1205, 1206]
  const args = { org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true }
  const view = await h.service.board(args)
  assert.equal(view.board.boardId, STORIES)
  assert.deepEqual(view.items.map(entry => entry.id), [1204, 1205, 1206])
  assert.equal(h.ado.count(isBoardWiql), 1)
  assert.ok(!h.ado.calls.find(isBoardWiql)?.body.query.includes('@Me'), 'everyone')

  assert.deepEqual(await h.service.board(args), view)
  assert.equal(h.ado.count(isBoardWiql), 1, 'a fresh board is served from the cache')

  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 2, 'the first reload comes at 30 s')
  assert.deepEqual(h.boardPosts, [], 'nothing changed')

  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 2, 'an unchanged board backs off')
  h.ado.change(1205)
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 3, 'the next reload comes 60 s after the unchanged one')
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.equal((await h.service.board(args)).items[1].rev, 4)

  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 4, 'a change returns it to 30 s')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 5)
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 5, 'back-off stops at 60 s')
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 6)

  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 6, 'a hidden board is not polled')

  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  assert.equal((await h.service.board(args)).items[1].rev, 4, 'a board shown again is served from its held view')
  await drain()
  assert.equal(h.ado.count(isBoardWiql), 7, 'and revalidated, since it is older than 30 s')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 8)

  h.setOrgs([status({ state: 'expired' })])
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 8, 'a board of an org that is not connected is not polled')
})

test('a failed background board reload keeps the last board and says so, until a reload succeeds', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.state.wiql = [1204, 1205, 1206]
  const args = { org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true }
  const view = await h.service.board(args)

  h.ado.on(isBoardWiql, () => json(500, { message: 'TF246017: the database is unavailable.' }))
  await h.clock.tick(30_000)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  const calls = h.ado.calls.length
  assert.deepEqual(await h.service.board(args), { ...view, stale: true, message: 'TF246017: the database is unavailable. Showing the last loaded board.' })
  assert.equal(h.ado.calls.length, calls, 'the frame is answered from the stale view')

  h.ado.clear()
  await h.clock.tick(30_000)
  assert.equal(h.boardPosts.length, 2)
  assert.deepEqual(await h.service.board(args), { ...view, updatedAt: T0 + MINUTE })
})

test('disposing the scheduler aborts an in-flight "mine" load and shows no error', async () => {
  const h = harness()
  h.service.visibility({ surface: 'work', org: ORG, visible: true })
  h.setOrgs([status()])
  await h.clock.tick(0)
  const posts = h.posts.length
  const hung = h.ado.hang(isMineWiql)
  await h.clock.tick(MINUTE)
  assert.equal(hung.length, 1)

  h.scheduler.dispose()
  await drain()
  assert.equal(hung[0].signal?.aborted, true)
  assert.equal(h.posts.length, posts, 'no stale snapshot is posted')
  assert.equal((await h.service.snapshot(ORG)).stale, false)
})

test('removing the "mine" job aborts its in-flight load', async () => {
  const h = harness()
  const hung = h.ado.hang(isMineWiql)
  h.service.visibility({ surface: 'work', org: ORG, visible: true })
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(hung.length, 1)

  h.setOrgs([status({ state: 'disconnected' })])
  await drain()
  assert.equal(hung[0].signal?.aborted, true)
  assert.deepEqual(h.posts, [])
})

test('hiding a board aborts its in-flight reload and shows no error', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.state.wiql = [1204, 1205, 1206]
  await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })
  const hung = h.ado.hang(isBoardWiql)
  await h.clock.tick(30_000)
  assert.equal(hung.length, 1)

  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: { teamId: TEAM, boardId: STORIES } })
  await drain()
  assert.equal(hung[0].signal?.aborted, true)
  assert.deepEqual(h.boardPosts, [])
})

test('disposing the scheduler aborts an in-flight board reload and leaves the board as it was', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.state.wiql = [1204, 1205, 1206]
  const args = { org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true }
  const view = await h.service.board(args)
  const hung = h.ado.hang(isBoardWiql)
  await h.clock.tick(30_000)
  assert.equal(hung.length, 1)

  h.scheduler.dispose()
  await drain()
  assert.equal(hung[0].signal?.aborted, true)
  assert.deepEqual(h.boardPosts, [])
  h.ado.clear()
  await h.clock.tick(30_000)
  assert.deepEqual(await h.service.board(args), view)
})

test('a board whose query returned 500 items says only the newest are shown', async () => {
  const h = harness()
  const ids = Array.from({ length: 500 }, (_, index) => 7000 + index)
  for (const id of ids) h.ado.items.set(id, story(id, T0 - (id - 7000) * MINUTE))
  boardIds(h, ids)
  const view = await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })
  assert.equal(view.items.length, 500)
  assert.equal(view.message, 'Showing the 500 most recently changed items.')
})

test('a board answer is capped at 900 KiB', async () => {
  const h = harness()
  const ids = Array.from({ length: 450 }, (_, index) => 7000 + index)
  for (const id of ids) h.ado.items.set(id, story(id, T0 - (id - 7000) * MINUTE, `${id} ${'é'.repeat(1_500)}`))
  boardIds(h, ids)
  const view = await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })
  const count = view.items.length
  assert.ok(count > 100 && count < 450, String(count))
  assert.deepEqual(view.items.map(entry => entry.id), ids.slice(0, count))
  assert.equal(view.message, `Showing the ${count} most recently changed items.`)
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 900 * 1024)
})

test('defaultBoard names the requirement board of the org boards team, or null without one', async () => {
  const h = harness()
  h.setOrgs([status()])
  assert.deepEqual(await h.service.defaultBoard(ORG), { projectId: PROJECT, teamId: TEAM, boardId: STORIES })
  const configCalls = h.ado.calls.length
  assert.deepEqual(await h.service.defaultBoard(ORG), { projectId: PROJECT, teamId: TEAM, boardId: STORIES })
  assert.equal(h.ado.calls.length, configCalls, 'the board configuration is cached')

  h.setOrgs([status({ boards: null })])
  assert.equal(await h.service.defaultBoard(ORG), null)
  assert.equal(h.ado.calls.length, configCalls)
})

test('details load the item with its description, comments and links', async () => {
  const h = harness()
  const details = await h.service.details(ORG, 1204)
  assert.equal(details.item.id, 1204)
  assert.equal(details.item.parentTitle, 'Vehicle search')
  assert.deepEqual(details.comments, [])
  assert.deepEqual(details.links.map(link => link.kind), ['parent', 'pr'])

  const added = await h.service.comment(ORG, 1204, 'Ready for review')
  assert.deepEqual(added, { id: 77, author: 'Alex Contoso', createdAt: Date.parse('2026-11-04T09:00:00Z'), textMd: 'Ready for review' })
})

const onBoard = (types: string) => (call: AdoCall) => isWiql(call) && call.body.query.includes(`[System.WorkItemType] IN (${types})`)
const isStoriesWiql = (call: AdoCall) => onBoard("'User Story', 'Bug'")(call) && !isStillIn(call)
const isFeaturesWiql = (call: AdoCall) => onBoard("'Feature'")(call) && !isStillIn(call)

function boardIds(h: ReturnType<typeof harness>, stories: number[], features: number[] = [1100]): void {
  h.ado.on(onBoard("'User Story', 'Bug'"), call => h.ado.answerWiql(call, stories))
  h.ado.on(onBoard("'Feature'"), call => h.ado.answerWiql(call, features))
}

const STORIES_BOARD = { org: ORG, projectId: PROJECT, teamId: TEAM, boardId: STORIES }
const FEATURES_BOARD = { org: ORG, projectId: PROJECT, teamId: TEAM, boardId: FEATURES }

test('a move on a Features board uses that board even when the item is also in "other"', async () => {
  const h = harness()
  h.ado.state.wiql = [1204, 1207, 1205, 1208, 1100]
  boardIds(h, [1204, 1205])
  assert.ok(item(await h.service.refresh(ORG), 1100), 'the Feature is in "other"')
  const view = await h.service.board({ ...FEATURES_BOARD, everyone: true })
  assert.deepEqual(view.items[0].targets.columns, ['New', 'Active', 'Closed'])

  const moved = await h.service.move({ org: ORG, id: 1100, rev: 1, to: { column: 'Closed' }, board: { teamId: TEAM, boardId: FEATURES } })
  assert.deepEqual(h.ado.calls.find(isPatch)?.body, [
    { op: 'test', path: '/rev', value: 1 },
    { op: 'replace', path: '/fields/System.State', value: 'Closed' },
    { op: 'replace', path: `/fields/${FEATURES_WEF}.Column`, value: 'Closed' }
  ])
  assert.deepEqual([moved.rev, moved.column, moved.state], [2, 'Closed', 'Closed'])

  const linked = await h.service.linkPr({
    org: ORG,
    id: 1100,
    rev: 2,
    prUrl: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322`,
    board: { teamId: TEAM, boardId: FEATURES }
  })
  assert.equal(linked.column, 'Closed', 'read with the Features board fields')
})

test('without a board, a move uses the first open board that maps the item type, then the "mine" board', async () => {
  const h = harness()
  h.ado.state.wiql = [1204, 1207, 1205, 1208, 1100]
  boardIds(h, [1204, 1205])
  await h.service.refresh(ORG)
  await h.service.board({ ...FEATURES_BOARD, everyone: true })

  await h.service.move({ org: ORG, id: 1100, rev: 1, to: { column: 'Closed' } })
  await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  const patches = h.ado.calls.filter(isPatch).map(call => call.body.map((op: { path: string }) => op.path))
  assert.deepEqual(patches, [
    ['/rev', '/fields/System.State', `/fields/${FEATURES_WEF}.Column`],
    ['/rev', '/fields/System.State', `/fields/${WEF}.Column`, `/fields/${WEF}.Column.Done`]
  ])
})

test('two boards opened at once load their shared board config once', async () => {
  const h = harness()
  const args = { org: ORG, projectId: PROJECT, teamId: TEAM }
  const [everyone, mine] = await Promise.all([h.service.board({ ...args, everyone: true }), h.service.board({ ...args, everyone: false })])
  assert.deepEqual([everyone.board.boardId, mine.board.boardId], [STORIES, STORIES])
  assert.equal(h.ado.count(isBacklogConfig), 1)
})

test('a move naming a board that is not loaded loads its configuration first', async () => {
  const h = harness()
  await h.service.move({ org: ORG, id: 1100, rev: 1, to: { column: 'Closed' }, board: { teamId: TEAM, boardId: FEATURES } })
  assert.ok(h.ado.calls.some(call => call.path.endsWith(`/_apis/work/boards/${FEATURES}`)))
  assert.equal(h.ado.calls.find(isPatch)?.body[2].path, `/fields/${FEATURES_WEF}.Column`)
})

test('a panel move tells an open board that shows the item', async () => {
  const h = harness()
  boardIds(h, [1204, 1205])
  await h.service.refresh(ORG)
  await h.service.board({ ...STORIES_BOARD, everyone: false })

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  const served = await h.service.board({ ...STORIES_BOARD, everyone: false })
  assert.deepEqual(served.items.find(entry => entry.id === 1204), moved)
})

test('a refused move of an item only on the board refreshes the board', async () => {
  const h = harness()
  boardIds(h, [1206])
  await h.service.refresh(ORG)
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.ado.items.get(1206)!.rev = 13

  const error = await rejection(h.service.move({ org: ORG, id: 1206, rev: 12, to: { column: 'Resolved' }, board: { teamId: TEAM, boardId: STORIES } }))
  assert.equal(error.message, CONFLICT)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.equal((await h.service.board({ ...STORIES_BOARD, everyone: true })).items[0].rev, 13)
})

test('a "mine" load in flight when a move lands does not bring the old item back', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  h.ado.change(1204, { fields: { 'System.Title': 'Add vehicle search and sort filters' } })
  const held = h.ado.hold(isHydrate)
  const polling = h.service.refresh(ORG)
  await drain()

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 10, to: { column: 'Resolved' } })
  held.release()
  const landed = await polling
  assert.deepEqual(item(landed, 1204), moved)
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)

  h.ado.change(1204)
  assert.equal(item(await h.service.refresh(ORG), 1204)?.rev, 12)
})

test('the Work job idles while the Work tab is hidden', async () => {
  const h = harness()
  h.service.visibility({ surface: 'work', org: ORG, visible: true })
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 1)

  h.service.visibility({ surface: 'work', org: ORG, visible: false })
  const calls = h.ado.calls.length
  await h.clock.tick(15 * MINUTE)
  assert.equal(h.ado.calls.length, calls)
})

test('a board load in flight when a move lands does not bring the old item back', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  h.ado.change(1204, { fields: { 'System.Title': 'Add vehicle search and sort filters' } })
  const held = h.ado.hold(isHydrate)
  await h.clock.tick(30_000)

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 10, to: { column: 'Resolved' }, board: { teamId: TEAM, boardId: STORIES } })
  held.release()
  await drain()
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: false })).items[0], moved)
  assert.equal(h.boardPosts.length, 1, 'only the move changed the board')
})

test('hiding the boards keeps their views and stops their polling until they are shown again', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 2])

  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  await h.clock.tick(MINUTE)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 2], 'hidden boards are not polled')
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  assert.equal(h.ado.count(isFeaturesWiql), 2, 'a hidden board is served from its held view')

  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  await h.clock.tick(0)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [3, 3], 'shown again, both held views revalidate at once')
})

test('an in-flight load of a signed-out or removed org posts nothing', async () => {
  for (const after of [[status({ state: 'disconnected', account: null })], []]) {
    const h = harness()
    const held = h.ado.hold(isWiql)
    const loading = h.service.refresh(ORG).catch(() => null)
    await drain()
    h.setOrgs(after)
    held.release()
    await loading
    assert.deepEqual(h.posts, [], JSON.stringify(after))
  }
})

test('a stale-rev refusal whose reload fails still reports the conflict', async () => {
  for (const status of [409, 412]) {
    const h = harness()
    await h.service.refresh(ORG)
    h.ado.on(isPatch, () => json(status, { message: 'TF26071: This work item has been changed by someone else since you opened it.' }))
    h.ado.on(isBatch, () => json(500, { message: 'TF246017: the database is unavailable.' }))
    const error = await rejection(h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } }))
    assert.deepEqual({ code: error.code, message: error.message }, { code: 'conflict', message: CONFLICT }, String(status))
  }
})

test('a board carries the PR-status scope message while chips are off', async () => {
  const h = harness()
  boardIds(h, [1204])
  h.ado.on(isPullRequest, () => json(403, { message: 'TF401027: You need the Git GenericRead permission.' }))
  const view = await h.service.board({ ...STORIES_BOARD, everyone: true })
  assert.equal(view.message, NEEDS_CODE_READ)
  assert.deepEqual(view.items[0].prs, [])
})

test('without a board, a move prefers an open board over the "mine" board when both map the type', async () => {
  const h = harness()
  const team = '7b8c9d0e-3333-4c4d-9e5f-2a3b4c5d6e7f'
  const boardId = 'f4e5d6c7-6666-4f70-8a8c-5d6e7f8091a3'
  const otherWef = 'WEF_0A1B2C3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban'
  const stories = JSON.parse(JSON.stringify(fixture('board-stories')).replaceAll(WEF, otherWef))
  const teamPath = `/${ORG}/${PROJECT}/${team}/_apis`
  h.ado.on(call => call.path === `${teamPath}/work/boards/${boardId}`, () => json(200, { ...stories, id: boardId }))
  h.ado.on(call => call.path === `${teamPath}/work/teamsettings/teamfieldvalues`, () => json(200, fixture('team-field-values')))
  h.ado.on(call => call.path === `${teamPath}/wit/wiql`, call => h.ado.answerWiql(call, [1204]))
  await h.service.refresh(ORG)
  await h.service.board({ org: ORG, projectId: PROJECT, teamId: team, boardId, everyone: true })

  await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  assert.equal(h.ado.calls.find(isPatch)?.body[2].path, `/fields/${otherWef}.Column`)
})

test('a panel move of a "mine" item ignores an open board in another project that does not hold it', async () => {
  const h = harness()
  const project = '5e6f7a8b-7777-4a8b-9c0d-1e2f3a4b5c6d'
  const team = '8c9d0e1f-8888-4d5e-8f60-7a8b9c0d1e2f'
  const boardId = 'a5b6c7d8-9999-4e6f-9a7b-4c5d6e7f8092'
  const otherWef = 'WEF_1B2C3D4E5F6A4B7C8D9E0F1A2B3C4D5E_Kanban'
  const stories = JSON.parse(JSON.stringify(fixture('board-stories')).replaceAll(WEF, otherWef))
  const base = `/${ORG}/${project}`
  h.ado.on(call => call.path === `${base}/${team}/_apis/work/boards/${boardId}`, () => json(200, { ...stories, id: boardId }))
  h.ado.on(call => call.path === `${base}/${team}/_apis/work/teamsettings/teamfieldvalues`, () => json(200, fixture('team-field-values')))
  h.ado.on(call => call.path === `${base}/_apis/wit/workitemtypes/User Story/states`, () => json(200, fixture('states-user-story')))
  h.ado.on(call => call.path === `${base}/_apis/wit/workitemtypes/Bug/states`, () => json(200, fixture('states-bug')))
  h.ado.on(call => call.path === `${base}/${team}/_apis/wit/wiql`, call => h.ado.answerWiql(call, []))
  await h.service.refresh(ORG)
  await h.service.board({ org: ORG, projectId: project, teamId: team, boardId, everyone: true })

  await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  await h.service.details(ORG, 1204)
  await h.service.comment(ORG, 1204, 'Ready')
  const patch = h.ado.calls.find(isPatch)
  assert.equal(patch?.path, `/${ORG}/${PROJECT}/_apis/wit/workitems/1204`)
  assert.equal(patch?.body[2].path, `/fields/${WEF}.Column`)
  const comments = h.ado.calls.filter(call => call.path.endsWith('/1204/comments'))
  assert.deepEqual(comments.map(call => [call.method, call.path.startsWith(`/${ORG}/${PROJECT}/`)]), [['GET', true], ['POST', true]])
})

test('a move published while a load reads the nudge rules is not overwritten', async () => {
  const h = harness()
  await h.service.refresh(ORG)
  const rules = h.holdRead(`nudgeRules:${ORG}:${TEAM}`)
  const polling = h.service.refresh(ORG)
  await drain()

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  rules.release()
  assert.deepEqual(item(await polling, 1204), moved)
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)
})

test('a board that lands after the boards were hidden is kept but not polled until they are shown', async () => {
  const h = harness()
  h.setOrgs([status()])
  const held = h.ado.hold(isStoriesWiql)
  const opening = h.service.board({ ...STORIES_BOARD, everyone: false })
  await drain()
  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  held.release()
  const view = await opening

  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isStoriesWiql), 1, 'no job polls it while hidden')
  assert.deepEqual(await h.service.board({ ...STORIES_BOARD, everyone: false }), view)
  assert.equal(h.ado.count(isStoriesWiql), 1, 'its view was kept')

  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  await h.clock.tick(0)
  assert.equal(h.ado.count(isStoriesWiql), 2, 'shown again, it revalidates at once')
})

const STORIES_REF = { teamId: TEAM, boardId: STORIES }

test('hiding one board stops only its job and keeps its view; another board of the org keeps polling', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  await h.service.board({ ...FEATURES_BOARD, everyone: true })

  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [1, 2], 'only Features polls')

  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  assert.equal(h.ado.count(isFeaturesWiql), 2, 'the Features view was kept and serves from its cache')
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  assert.equal(h.ado.count(isStoriesWiql), 1, 'the Stories view was kept too, and is not reloaded while hidden')
})

test('showing a hidden board polls it again at once, without it being asked for', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  await h.clock.tick(MINUTE)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [1, 2])

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  await h.clock.tick(0)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 2], 'only the shown board revalidates')
})

test('a board asked for while it is hidden is not polled until it is shown', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.setOrgs([status()])
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isStoriesWiql), 1, 'a hidden board is not polled')

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  await h.clock.tick(0)
  assert.equal(h.ado.count(isStoriesWiql), 2, 'shown again, its stale view reloads at once')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isStoriesWiql), 3, 'and keeps polling, backed off while unchanged')
})

test('a board load in flight across that board being hidden is kept but not polled', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  const held = h.ado.hold(isStoriesWiql)
  const opening = h.service.board({ ...STORIES_BOARD, everyone: true })
  await drain()
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  held.release()
  const view = await opening

  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [1, 2], 'no job polls Stories while it is hidden')
  assert.deepEqual(await h.service.board({ ...STORIES_BOARD, everyone: true }), view)
  assert.equal(h.ado.count(isStoriesWiql), 1, 'its view was kept')

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  await h.clock.tick(0)
  assert.equal(h.ado.count(isStoriesWiql), 2, 'shown again, it revalidates at once')
})

test('hiding a board keeps its view and stops its polling', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  const view = await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  const calls = h.ado.calls.length

  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, calls, 'nothing is polled while the board is hidden')
  assert.deepEqual(await h.service.board({ ...STORIES_BOARD, everyone: true }), view)
  assert.equal(h.ado.calls.length, calls, 'the held view is served without a call')
})

test('showing a held board older than 30 s returns it at once and revalidates in the background', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  const view = await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  await h.clock.tick(MINUTE)

  const gate = h.ado.hold(isStoriesWiql)
  h.ado.change(1205)
  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  let answered: BoardResult | undefined
  void h.service.board({ ...STORIES_BOARD, everyone: true }).then(result => (answered = result))
  await drain()
  assert.deepEqual(answered, view, 'answered from the held view before the reload is answered')
  assert.deepEqual(h.boardPosts, [])

  gate.release()
  await drain()
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.equal((await h.service.board({ ...STORIES_BOARD, everyone: true })).items[1].rev, 4)
})

test('a held board under 30 s old is served without any request', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  const view = await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  await h.clock.tick(20_000)
  const calls = h.ado.calls.length

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  assert.deepEqual(await h.service.board({ ...STORIES_BOARD, everyone: true }), view)
  await h.clock.tick(0)
  assert.equal(h.ado.calls.length, calls)
})

const EXTRA_BOARDS = ['c3d4e5f6-6001-4a7b-8c9d-0e1f2a3b4c01', 'c3d4e5f6-6002-4a7b-8c9d-0e1f2a3b4c02', 'c3d4e5f6-6003-4a7b-8c9d-0e1f2a3b4c03']

function extraBoards(h: ReturnType<typeof harness>): void {
  for (const boardId of EXTRA_BOARDS) {
    h.ado.on(
      call => call.method === 'GET' && call.path === `/${ORG}/${PROJECT}/${TEAM}/_apis/work/boards/${boardId}`,
      () => json(200, { ...fixture<object>('board-stories'), id: boardId })
    )
  }
}

test('at most 4 board views are held per org, and the oldest hidden one goes first', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  extraBoards(h)
  const [third, fourth, fifth] = EXTRA_BOARDS
  const open = (boardId: string) => h.service.board({ ...STORIES_BOARD, boardId, everyone: true })
  const hide = (boardId: string) => h.service.visibility({ surface: 'board', org: ORG, visible: false, board: { teamId: TEAM, boardId } })
  for (const boardId of [STORIES, FEATURES, third, fourth]) await open(boardId)
  await open(STORIES)
  hide(STORIES)
  hide(third)

  await open(fifth)
  const calls = h.ado.calls.length
  for (const boardId of [STORIES, FEATURES, fourth, fifth]) await open(boardId)
  assert.equal(h.ado.calls.length, calls, 'four views are still held')
  await open(third)
  assert.ok(h.ado.calls.length > calls, 'the least recently opened hidden view was dropped, so it loads again')
})

test('opening a board without a filter uses the remembered one and says which', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await createBoardFilters(h.store).remember(ORG, TEAM, STORIES, false)

  const view = await h.service.board(STORIES_BOARD)
  assert.equal(view.everyone, false)
  assert.ok(h.ado.calls.find(isStoriesWiql)?.body.query.includes('[System.AssignedTo] = @Me'))
  const other = await h.service.board(FEATURES_BOARD)
  assert.equal(other.everyone, true, 'a board never chosen for uses Everyone')
  assert.ok(!h.ado.calls.find(isFeaturesWiql)?.body.query.includes('@Me'))
})

test('choosing a filter remembers it for that board only', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  const filters = createBoardFilters(h.store)

  const view = await h.service.board({ ...STORIES_BOARD, everyone: false, remember: true })
  assert.equal(view.everyone, false)
  assert.equal(await filters.everyone(ORG, TEAM, STORIES), false)
  assert.equal(await filters.everyone(ORG, TEAM, FEATURES), true)
  assert.equal((await h.service.board(FEATURES_BOARD)).everyone, true)
})

test('a load that re-sends the current filter does not overwrite a remembered choice', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  const filters = createBoardFilters(h.store)
  await filters.remember(ORG, TEAM, STORIES, false)

  assert.equal((await h.service.board({ ...STORIES_BOARD, everyone: true })).everyone, true)
  assert.equal(await filters.everyone(ORG, TEAM, STORIES), false, 'only remember: true stores a choice')
  await h.service.board({ ...STORIES_BOARD, remember: true })
  assert.equal(await filters.everyone(ORG, TEAM, STORIES), false, 'remember without a filter stores nothing')
})

test('a filter choice that cannot be saved is logged and the board still opens', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  h.store.set = async () => {
    throw new Error('storage unavailable')
  }
  const view = await h.service.board({ ...STORIES_BOARD, everyone: false, remember: true })
  assert.equal(view.everyone, false)
  assert.deepEqual(view.items.map(entry => entry.id), [1204, 1205])
  assert.deepEqual(h.logs, [FILTER_NOT_SAVED])
})

test('without a board, a move prefers a board holding the item that maps its type', async () => {
  const h = harness()
  boardIds(h, [1204, 1205], [1204])
  await h.service.refresh(ORG)
  await h.service.board({ ...FEATURES_BOARD, everyone: true })

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  assert.equal(h.ado.calls.find(isPatch)?.body[2].path, `/fields/${WEF}.Column`)
  assert.equal(moved.column, 'Resolved')
})

test('cachedItem reads the snapshot, then the open board views, and never calls Azure DevOps', async () => {
  const h = harness()
  assert.equal(h.service.cachedItem(ORG, 1204), null, 'nothing is cached before the first load')
  await h.service.refresh(ORG)
  const calls = h.ado.calls.length
  assert.equal(h.service.cachedItem(ORG, 1204)?.title, 'Add vehicle search filters', 'a "mine" item')
  assert.equal(h.service.cachedItem(ORG, 1207)?.title, 'Write the filter tests', 'an "other" item')
  assert.equal(h.service.cachedItem(ORG, 1100), null, 'a Feature that is on no loaded list')
  assert.equal(h.service.cachedItem('fabrikam', 1204), null, 'another org')

  boardIds(h, [1204, 1205])
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  const viewCalls = h.ado.calls.length
  assert.equal(h.service.cachedItem(ORG, 1100)?.title, 'Vehicle search', 'an item only an open board view holds')
  assert.equal(h.ado.calls.length, viewCalls)
  assert.ok(viewCalls > calls)
})

test('itemInfo reads an item it does not hold with one fields read in a user lane, and a held one with none', async () => {
  const h = harness()
  const contexts: string[] = []
  h.ado.on(
    () => {
      const { feature, lane } = currentContext()
      contexts.push(`${feature}/${lane.priority}`)
      return false
    },
    () => assert.fail('only records')
  )
  const signal = new AbortController().signal
  const info = { type: 'User Story', title: 'Add vehicle search filters', url: `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204` }

  assert.deepEqual(await h.service.itemInfo(ORG, 1204, signal), info)
  assert.deepEqual(h.ado.calls.map(isFieldsBatch), [true])
  assert.deepEqual(contexts, ['work/user'])
  assert.equal(await h.service.itemInfo(ORG, 9999, signal), null, 'an item ADO does not return')

  await h.service.refresh(ORG)
  const calls = h.ado.calls.length
  assert.deepEqual(await h.service.itemInfo(ORG, 1204, signal), info)
  assert.equal(h.ado.calls.length, calls, 'a held item needs no request')

  const hung = h.ado.hang(isFieldsBatch)
  const abort = new AbortController()
  const reading = h.service.itemInfo(ORG, 1301, abort.signal).catch(() => 'aborted')
  await drain()
  abort.abort()
  assert.equal(await reading, 'aborted')
  assert.equal(hung[0].signal?.aborted, true, 'the caller can abort the read')
})

const ALEX: PinnedAccount = { adoId: '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b', uniqueName: 'alex@contoso.example', displayName: 'Alex Contoso', tenantId: null, objectId: null }
const ALEX_IDENTITY = { displayName: 'Alex Contoso', uniqueName: 'alex@contoso.example', id: ALEX.adoId }
const GRACE_IDENTITY = { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d' }
const TASKS_NOT_LOADED = "Couldn't load the tasks under your items. They show after the next refresh."

function children(): RawWorkItem[] {
  return fixture<{ value: RawWorkItem[] }>('workitems-children').value
}

function task(id: number, parent: number, fields: Record<string, unknown> = {}): RawWorkItem {
  return {
    id,
    rev: 1,
    url: `${ORG_URL}/${PROJECT}/_apis/wit/workItems/${id}`,
    fields: {
      'System.TeamProject': 'Fabrikam Web',
      'System.WorkItemType': 'Task',
      'System.Title': `Task ${id}`,
      'System.State': 'Active',
      'System.Parent': parent,
      'System.ChangedDate': '2026-11-02T10:00:00Z',
      ...fields
    }
  }
}

function shortLists(snapshot: WorkSnapshot | undefined): [number, number[], number, number][] {
  return (snapshot?.families.lists ?? []).map(list => [list.parentId, list.tasks.map(entry => entry.id), list.total, list.done])
}

function listOf(snapshot: WorkSnapshot | undefined, parentId: number): TaskList | undefined {
  return snapshot?.families.lists.find(list => list.parentId === parentId)
}

function myTask1207(h: ReturnType<typeof harness>): RawWorkItem {
  const raw = h.ado.items.get(1207)!
  raw.fields['System.AssignedTo'] = ALEX_IDENTITY
  return raw
}

test('no child links means no children read', async () => {
  const h = harness(status({ account: ALEX }))
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(snapshot.families, NO_FAMILIES, "the story's own parent is not a dimmed parent")
  assert.equal(h.ado.count(isBatch), 2)
  assert.equal(h.ado.count(isFieldsBatch), 0)
})

test('child task lists hold every task of a parent, any assignee, done ones marked, yours first, and count them', async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, children())
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(snapshot.families, {
    parents: [],
    lists: [
      {
        parentId: 1204,
        tasks: [
          { id: 1213, title: 'Write the filter tests', state: 'Active', done: false, assignee: 'Alex Contoso', mine: true },
          { id: 1210, title: 'Add filter analytics', state: 'New', done: false, assignee: null, mine: false },
          { id: 1209, title: 'Review the filter copy', state: 'Closed', done: true, assignee: 'Grace Hopper', mine: false }
        ],
        total: 3,
        done: 1
      }
    ]
  })
  assert.equal(snapshot.message, undefined)
  assert.deepEqual(h.posts.at(-1), snapshot)

  const byName = harness(status({ account: { ...ALEX, adoId: 'another-id', uniqueName: 'ALEX@Contoso.example' } }))
  addChildren(byName.ado, 1204, children())
  assert.deepEqual(listOf(await byName.service.refresh(ORG), 1204)?.tasks.map(entry => [entry.id, entry.mine]), [[1213, true], [1210, false], [1209, false]])

  const nobody = harness()
  addChildren(nobody.ado, 1204, children())
  assert.deepEqual(listOf(await nobody.service.refresh(ORG), 1204)?.tasks.map(entry => [entry.id, entry.mine]), [[1210, false], [1213, false], [1209, false]])
})

test("a child the account can't read comes back null and the other tasks still list, with no message", async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, children())
  h.ado.items.get(1204)!.relations!.push({ rel: CHILD_LINK, url: `${ORG_URL}/_apis/wit/workItems/1212` })
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(h.ado.calls.filter(isFieldsBatch).map(call => call.body.ids), [[1213, 1209, 1210, 1211, 1212]])
  assert.deepEqual(shortLists(snapshot), [[1204, [1213, 1210, 1209], 3, 1]])
  assert.equal(snapshot.message, undefined)
})

test('a mine load reads missing parents once and the child tasks of listed items and those parents in one more batched read', async () => {
  const h = harness(status({ account: ALEX }))
  h.ado.items.set(1230, story(1230, T0 - MINUTE, 'Show saved searches'))
  h.ado.items.set(1231, task(1231, 1230, { 'System.AssignedTo': ALEX_IDENTITY }))
  addChildren(h.ado, 1204, children())
  addChildren(h.ado, 1230, [h.ado.items.get(1231)!, task(1232, 1230, { 'System.AssignedTo': GRACE_IDENTITY })])
  h.ado.state.wiql = [1204, 1207, 1205, 1208, 1231]
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(h.ado.calls.filter(isBatch).map(call => call.body), [
    { ids: [1204, 1207, 1205, 1208, 1231], $expand: 'relations', errorPolicy: 'omit' },
    { ids: [1100, 1230], $expand: 'relations', errorPolicy: 'omit' },
    { ids: [1213, 1209, 1210, 1211, 1231, 1232], fields: TASK_FIELDS, errorPolicy: 'omit' }
  ])
  assert.deepEqual(snapshot.families.parents.map(parent => parent.id), [1230])
  assert.deepEqual(shortLists(snapshot), [[1204, [1213, 1210, 1209], 3, 1], [1230, [1231, 1232], 2, 0]])
})

test("a task under a task: the parent task's children come in the same read", async () => {
  const h = harness(status({ account: ALEX }))
  h.ado.items.set(1220, task(1220, 1204, { 'System.Title': 'Wire the filter API', 'System.AssignedTo': GRACE_IDENTITY }))
  h.ado.items.set(1221, task(1221, 1220, { 'System.Title': 'Map the filter fields', 'System.AssignedTo': ALEX_IDENTITY }))
  addChildren(h.ado, 1220, [h.ado.items.get(1221)!, task(1223, 1220, { 'System.State': 'New' })])
  addChildren(h.ado, 1207, [task(1222, 1207, { 'System.AssignedTo': GRACE_IDENTITY })])
  h.ado.state.wiql = [1204, 1207, 1205, 1208, 1221]
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(h.ado.calls.filter(isFieldsBatch).map(call => call.body.ids), [[1222, 1221, 1223]])
  assert.deepEqual(snapshot.families.parents, [{ id: 1220, type: 'Task', title: 'Wire the filter API', state: 'Active', column: null, lane: null }])
  assert.deepEqual(
    snapshot.families.lists.map(list => [list.parentId, list.tasks.map(entry => [entry.id, entry.mine])]),
    [[1207, [[1222, false]]], [1220, [[1221, true], [1223, false]]]]
  )
})

test('a parent with 30 tasks posts 20 and counts all 30, never dropping one of yours', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => 1300 + index)
  const range = (from: number, to: number) => ids.filter(id => id >= from && id <= to)

  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, ids.map(id => task(id, 1204, { 'System.AssignedTo': id >= 1325 ? ALEX_IDENTITY : GRACE_IDENTITY, 'System.State': id < 1305 ? 'Closed' : 'Active' })))
  const list = listOf(await h.service.refresh(ORG), 1204)
  assert.deepEqual(list?.tasks.map(entry => entry.id), [...range(1325, 1329), ...range(1305, 1319)])
  assert.deepEqual([list?.total, list?.done], [30, 5])

  const busy = harness(status({ account: ALEX }))
  addChildren(busy.ado, 1204, ids.map(id => task(id, 1204, { 'System.AssignedTo': id >= 1306 ? ALEX_IDENTITY : GRACE_IDENTITY })))
  const mine = listOf(await busy.service.refresh(ORG), 1204)
  assert.deepEqual(mine?.tasks.map(entry => entry.id), range(1306, 1329), 'all 24 of yours')
  assert.deepEqual([mine?.total, mine?.done], [30, 0])
})

test("a task whose parent isn't listed brings that parent as a dimmed parent with its column and lane", async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, [myTask1207(h), ...children().filter(raw => raw.id !== 1213)])
  h.ado.state.wiql = [1207, 1205]
  const snapshot = await h.service.refresh(ORG)
  assert.deepEqual(snapshot.other.map(entry => entry.id), [1207, 1205])
  assert.deepEqual(snapshot.families.parents, [{ id: 1204, type: 'User Story', title: 'Add vehicle search filters', state: 'Active', column: 'In Review', lane: 'Expedite' }])
  assert.deepEqual(shortLists(snapshot), [[1204, [1207, 1210, 1209], 3, 1]], 'with every child task of the parent')
  assert.deepEqual(h.ado.calls.filter(isBatch).map(call => call.body.ids), [[1207, 1205], [1204], [1207, 1209, 1210, 1211]])
})

test("children that aren't tasks are left out", async () => {
  const h = harness(status({ account: ALEX }))
  const bug = task(1240, 1204, { 'System.WorkItemType': 'Bug', 'System.Title': 'Filter drops the last page' })
  addChildren(h.ado, 1204, [bug, task(1241, 1204)])
  assert.deepEqual(shortLists(await h.service.refresh(ORG)), [[1204, [1241], 1, 0]])
})

test('a failed children read still posts the items, with no task lists and a message', async () => {
  for (const code of [403, 500]) {
    const h = harness(status({ account: ALEX }))
    h.ado.items.set(1220, task(1220, 1204, { 'System.AssignedTo': GRACE_IDENTITY }))
    h.ado.items.set(1221, task(1221, 1220, { 'System.AssignedTo': ALEX_IDENTITY }))
    addChildren(h.ado, 1204, children())
    addChildren(h.ado, 1220, [h.ado.items.get(1221)!])
    h.ado.state.wiql = [1204, 1207, 1205, 1208, 1221]
    h.ado.on(isFieldsBatch, () => json(code, { message: 'TF401027: You need the Read permission.' }))
    const snapshot = await h.service.refresh(ORG)
    assert.deepEqual(snapshot.mine.map(entry => entry.id), [1204], String(code))
    assert.deepEqual(snapshot.other.map(entry => entry.id), [1207, 1205, 1221], String(code))
    assert.deepEqual(snapshot.families.lists, [], String(code))
    assert.deepEqual(snapshot.families.parents.map(parent => parent.id), [1220], `${code}: the parents come from the parents read`)
    assert.equal(snapshot.message, TASKS_NOT_LOADED, String(code))
    assert.equal(snapshot.stale, false)
    assert.deepEqual(h.posts.at(-1), snapshot)
  }

  const cold = harness(status({ account: ALEX }))
  addChildren(cold.ado, 1204, children())
  cold.ado.state.wiql = [1204, 1205]
  cold.ado.on(isTypeStates('Task'), () => json(500, { message: 'TF400898: An Internal Error Occurred.' }))
  const unread = await cold.service.refresh(ORG)
  assert.equal(cold.ado.count(isFieldsBatch), 1, 'the children were read')
  assert.ok(cold.ado.count(isTypeStates('Task')) > 0, 'the Task states read was attempted')
  assert.deepEqual([...unread.mine, ...unread.other].map(entry => entry.id), [1204, 1205])
  assert.deepEqual(unread.families.lists, [])
  assert.equal(unread.message, TASKS_NOT_LOADED)
  assert.deepEqual(cold.posts.at(-1), unread)

  const ado = fakeAdo()
  addChildren(ado, 1204, children())
  const hung = ado.hang(isFieldsBatch)
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const cfg = await loadBoardConfig(http, { org: ORG, projectId: PROJECT, teamId: TEAM })
  const controller = new AbortController()
  const members = ado.state.wiql
  const source = createItemSource(http, ORG, ORG_URL, () => T0, createEntities(() => T0).of(ORG)).withSignal(controller.signal)
  const loading = loadMine(source, cfg, { id: ALEX.adoId, uniqueName: ALEX.uniqueName }, { members, stale: new Set(members) })
  const settled = loading.then(() => 'resolved', (error: unknown) => error)
  for (let turn = 0; turn < 10 && hung.length === 0; turn += 1) await drain()
  assert.equal(hung.length, 1)
  controller.abort()
  assert.equal(await settled, controller.signal.reason, 'an aborted load rejects instead')
})

test('moving your task updates its row under its parent', async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, [myTask1207(h), ...children().filter(raw => raw.id !== 1213)])
  await h.service.refresh(ORG)
  assert.deepEqual(listOf(h.posts.at(-1), 1204)?.tasks.map(entry => [entry.id, entry.done]), [[1207, false], [1210, false], [1209, true]])
  h.ado.items.get(1207)!.fields['System.Title'] = 'Write the filter and sort tests'

  const moved = await h.service.move({ org: ORG, id: 1207, rev: 1, to: { state: 'Closed' } })
  assert.equal(moved.state, 'Closed')
  const list = listOf(h.posts.at(-1), 1204)
  assert.deepEqual(list?.tasks.find(entry => entry.id === 1207), { id: 1207, title: 'Write the filter and sort tests', state: 'Closed', done: true, assignee: 'Alex Contoso', mine: true })
  assert.deepEqual([list?.total, list?.done], [3, 2])
  assert.deepEqual(item(h.posts.at(-1), 1207), moved)
})

test('a moved task shows its new state after the next poll while ADO still returns the old one', async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, [myTask1207(h), ...children().filter(raw => raw.id !== 1213)])
  await h.service.refresh(ORG)
  const before = structuredClone(h.ado.items.get(1207)!)
  await h.service.move({ org: ORG, id: 1207, rev: 1, to: { state: 'Closed' } })

  h.ado.items.set(1207, before)
  const polled = await h.service.refresh(ORG)
  assert.equal(h.ado.calls.filter(isFieldsBatch).length, 2, 'the poll read the children again')
  assert.equal(h.entities.of(ORG).workItems.get('1207')?.value.rev, 2, 'the older rev never replaced the move')
  assert.equal(item(polled, 1207), undefined, 'a Closed task leaves the open items, as it does once ADO catches up')
  const list = listOf(polled, 1204)
  assert.deepEqual(list?.tasks.find(entry => entry.id === 1207), { id: 1207, title: 'Write the filter tests', state: 'Closed', done: true, assignee: 'Alex Contoso', mine: true })
  assert.deepEqual([list?.total, list?.done], [3, 2])
  assert.deepEqual(h.posts.at(-1), polled)
})

test('the children read asks for at most 1,000 ids, 200 a request', async () => {
  const h = harness(status({ account: ALEX }))
  addChildren(h.ado, 1204, Array.from({ length: 1001 }, (_, index) => task(20_000 + index, 1204)))
  const list = listOf(await h.service.refresh(ORG), 1204)
  assert.deepEqual(h.ado.calls.filter(isFieldsBatch).map(call => call.body.ids.length), [200, 200, 200, 200, 200])
  assert.equal(h.ado.calls.filter(isFieldsBatch).flatMap(call => call.body.ids).includes(21_000), false, 'the 1,001st child is not read')
  assert.deepEqual([list?.tasks.length, list?.total], [20, 1000])
})

const ON_SCREEN = { surface: 'work', org: ORG, visible: true } as const

async function shownWork(h: ReturnType<typeof harness>): Promise<void> {
  h.service.visibility(ON_SCREEN)
  h.setOrgs([status()])
  await h.clock.tick(0)
}

test('a quiet Work tick sends only the delta query', async () => {
  const h = harness()
  await shownWork(h)
  const calls = h.ado.calls.length
  await h.clock.tick(MINUTE)
  const tick = h.ado.calls.slice(calls)
  assert.equal(tick.length, 1)
  assert.ok(isDelta(tick[0]) && isMineWiql(tick[0]), tick[0].body?.query)
  assert.equal(tick[0].query.get('timePrecision'), 'true')
})

test('a card moved by someone else appears after one delta, its re-check and one hydrate', async () => {
  const h = harness()
  await shownWork(h)
  const calls = h.ado.calls.length
  h.ado.change(1204, { fields: { [`${WEF}.Column`]: 'Resolved', [`${WEF}.Column.Done`]: false } })
  await h.clock.tick(MINUTE)
  const tick = h.ado.calls.slice(calls)
  assert.deepEqual(tick.map(call => [isDelta(call), isStillIn(call), isHydrate(call)]), [[true, false, false], [false, true, false], [false, false, true]])
  assert.deepEqual(tick[2].body.ids, [1204])
  assert.deepEqual([item(h.posts.at(-1), 1204)?.column, item(h.posts.at(-1), 1204)?.rev], ['Resolved', 10])
})

test("the user's move survives a delta that returns the older rev", async () => {
  const h = harness()
  await shownWork(h)
  const before = structuredClone(h.ado.items.get(1204)!)
  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  await h.clock.tick(MINUTE)
  assert.deepEqual(item(h.posts.at(-1), 1204), moved, 'the next delta read the move back')

  h.ado.change(1204, { rev: 10 })
  let lagging = 0
  h.ado.on(
    call => isHydrate(call) && call.body.ids.includes(1204),
    () => {
      lagging += 1
      return json(200, { count: 1, value: [before] })
    }
  )
  await h.clock.tick(2 * MINUTE)
  assert.equal(lagging, 1, 'a lagging replica answered with the old rev')
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)
})

test("a comment whose reload hits a lagging replica keeps the user's move in Work and on the board", async () => {
  const h = harness()
  boardIds(h, [1204, 1205])
  await h.service.refresh(ORG)
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  const before = structuredClone(h.ado.items.get(1204)!)
  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  assert.equal(moved.rev, 10)

  let lagging = 0
  h.ado.on(
    call => lagging === 0 && isHydrate(call) && call.body.ids.includes(1204),
    () => {
      lagging += 1
      return json(200, { count: 1, value: [before] })
    }
  )
  await h.service.comment(ORG, 1204, 'Ready for review')
  assert.equal(lagging, 1, 'the reload hit a lagging replica')
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: true })).items.find(entry => entry.id === 1204), moved)

  const card = item(h.posts.at(-1), 1204)!
  const again = await h.service.move({ org: ORG, id: 1204, rev: card.rev, to: { column: 'Closed' } })
  assert.deepEqual(h.ado.calls.filter(isPatch).at(-1)?.body[0], { op: 'test', path: '/rev', value: 10 })
  assert.equal(again.rev, 11)
})

test('a deleted item leaves the board at the next audit', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  h.ado.remove(1205)
  await h.clock.tick(10 * MINUTE)
  assert.deepEqual(h.boardPosts, [], 'a delta cannot see a deletion')

  await h.clock.tick(6 * MINUTE)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: true })).items.map(entry => entry.id), [1204])
  assert.equal(h.entities.of(ORG).workItems.get('1205'), undefined)
})

test('a board with no requirement types never builds an empty IN list', async () => {
  const h = harness()
  h.setOrgs([status()])
  const stories = fixture<{ columns: object[] }>('board-stories')
  h.ado.on(
    call => call.method === 'GET' && call.path.endsWith(`/_apis/work/boards/${STORIES}`),
    () => json(200, { ...stories, columns: stories.columns.map(column => ({ ...column, stateMappings: {} })) })
  )
  const view = await h.service.board({ ...STORIES_BOARD, everyone: true })
  assert.deepEqual([view.board.requirementTypes, view.items], [[], []])
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isWiql), 0)
  assert.equal(h.ado.count(isBatch), 0)
})

test('Refresh forces an audit', async () => {
  const h = harness()
  await shownWork(h)
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isDelta), 1, 'a tick runs a delta')

  const calls = h.ado.calls.length
  await h.service.refresh(ORG)
  const refreshed = h.ado.calls.slice(calls)
  assert.equal(refreshed[0].body.query, MINE_QUERY)
  assert.ok(isRevRead(refreshed[1]), 'with a revision read')
  assert.equal(refreshed.filter(isDelta).length, 0)

  await h.clock.tick(2 * MINUTE)
  assert.equal(h.ado.count(isDelta), 2, 'later ticks are deltas again')
})

test('Refresh pressed while a delta is in flight makes the next run audit', async () => {
  const h = harness()
  await shownWork(h)
  const held = h.ado.hold(call => isDelta(call) && isMineWiql(call))
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isDelta), 1, 'a delta is in flight')

  const refreshing = h.service.refresh(ORG)
  await drain()
  held.release()
  await refreshing
  const calls = h.ado.calls.length
  await h.clock.tick(2 * MINUTE)
  const next = h.ado.calls.slice(calls)
  assert.equal(next[0]?.body.query, MINE_QUERY, 'the next run audits')
  assert.ok(isRevRead(next[1]), 'with a revision read')
})

test('a quiet board tick reports unchanged and backs off', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  const calls = h.ado.calls.length
  await h.clock.tick(30_000)
  const tick = h.ado.calls.slice(calls)
  assert.equal(tick.length, 1)
  assert.ok(isDelta(tick[0]) && isStoriesWiql(tick[0]), tick[0].body?.query)
  assert.deepEqual(h.boardPosts, [])

  await h.clock.tick(30_000)
  assert.equal(h.ado.calls.length, calls + 1, 'unchanged, it backs off')
  await h.clock.tick(30_000)
  assert.equal(h.ado.calls.length, calls + 2)
})

const isWorkItemRead = (call: AdoCall) => isWiql(call) || isBatch(call)

function onlyDayPrecision(h: ReturnType<typeof harness>): void {
  h.ado.on(call => isDelta(call) && call.query.get('timePrecision') === 'true', () => json(400, { message: DATE_PRECISION }))
}

test('in day precision a card leaves the board even when the Work tab stored its new rev first', async () => {
  const h = harness()
  h.setOrgs([status()])
  const stories = [1204, 1205]
  boardIds(h, stories)
  onlyDayPrecision(h)
  await h.service.refresh(ORG)
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  await h.clock.tick(30_000)
  assert.ok(h.ado.calls.some(call => isDelta(call) && isStoriesWiql(call) && !call.query.has('timePrecision')), 'the board fell back to day precision')

  h.ado.change(1205, { fields: { 'System.AreaPath': 'Fabrikam Web\\Support' } })
  stories.splice(stories.indexOf(1205), 1)
  await h.service.refresh(ORG)
  assert.equal(h.entities.of(ORG).workItems.get('1205')?.value.rev, h.ado.items.get(1205)!.rev, 'the Work tab stored the new rev first')

  await h.clock.tick(2 * MINUTE)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: true })).items.map(entry => entry.id), [1204])
})

test('a parent that becomes assigned to me joins the Work view on the next delta', async () => {
  const h = harness()
  await shownWork(h)
  assert.equal(item(h.posts.at(-1), 1100), undefined, 'the Feature is only the parent of a listed item')
  const calls = h.ado.calls.length

  h.ado.change(1100, { fields: { 'System.AssignedTo': ALEX_IDENTITY } })
  h.ado.setMembers([...h.ado.state.wiql, 1100])
  await h.clock.tick(MINUTE)
  const tick = h.ado.calls.slice(calls).filter(isWorkItemRead)
  assert.deepEqual(tick.map(call => [isDelta(call), isStillIn(call), isHydrate(call)]), [[true, false, false], [false, true, false], [false, false, true]])
  assert.ok(tick[1].body.query.endsWith('[System.Id] IN (1100)'), tick[1].body.query)
  assert.deepEqual([item(h.posts.at(-1), 1100)?.title, item(h.posts.at(-1), 1100)?.assignedTo], ['Vehicle search', 'Alex Contoso'])
})

test("a child task moved onto the board's requirement types joins the board on the next delta", async () => {
  const h = harness()
  h.setOrgs([status()])
  const stories = [1204, 1205]
  boardIds(h, stories)
  await h.service.board({ ...STORIES_BOARD, everyone: true })

  h.ado.change(1207, { fields: { 'System.WorkItemType': 'User Story', [`${WEF}.Column`]: 'Active' } })
  stories.push(1207)
  await h.clock.tick(30_000)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: true })).items.map(entry => entry.id), [1204, 1205, 1207])
})

test('a parent assigned to me joins a board filtered to me on the next delta', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.items.get(1206)!.fields['System.Parent'] = 1205
  const stories = [1206]
  boardIds(h, stories)
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  const calls = h.ado.calls.length

  h.ado.change(1205, { fields: { 'System.AssignedTo': ALEX_IDENTITY } })
  stories.push(1205)
  await h.clock.tick(30_000)
  const recheck = h.ado.calls.slice(calls).filter(isStillIn)
  assert.deepEqual(recheck.map(call => call.body.query.endsWith('[System.Id] IN (1205)')), [true])
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: false })).items.map(entry => entry.id), [1206, 1205])
})

const HOUR = 60 * MINUTE
const OTHER_ACCOUNT: PinnedAccount = { ...ALEX, adoId: 'c4d5e6f7-8888-4a9b-8c0d-1e2f3a4b5c6d' }
const OTHER_TEAM = 'b7c8d9e0-7777-4f8a-9b0c-1d2e3f4a5b6c'
const isBoardSetting = (call: AdoCall) => call.path.includes('/_apis/work/')

async function savedFrom(h: ReturnType<typeof harness>): Promise<Record<string, unknown>> {
  await h.persisted.flush()
  return structuredClone(h.cache.data)
}

async function savedWork(): Promise<{ live: WorkSnapshot; cache: Record<string, unknown> }> {
  const before = harness(status({ account: ALEX }))
  const live = await before.service.refresh(ORG)
  return { live, cache: await savedFrom(before) }
}

async function savedBoard(): Promise<{ view: BoardResult & { everyone: boolean }; cache: Record<string, unknown> }> {
  const before = harness(status({ account: ALEX }))
  before.setOrgs([status({ account: ALEX })])
  boardIds(before, [1204, 1205])
  const view = await before.service.board(STORIES_BOARD)
  return { view, cache: await savedFrom(before) }
}

test('the Work tab paints a saved snapshot at once, marked stale with its age, then replaces it with a live one', async () => {
  const { live, cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + 3 * HOUR })
  h.setOrgs([status({ account: ALEX })])
  const gate = h.ado.hold(() => true)

  const painted = await h.service.snapshot(ORG)
  assert.deepEqual(painted, { ...live, stale: true, message: SHOWING_SAVED })
  assert.equal(painted.updatedAt, T0)
  assert.ok(h.ado.calls.length <= 1, 'answered before the first request of the revalidation is answered')
  assert.equal(h.posts.length, 0)

  gate.release()
  await drain()
  const latest = h.posts.at(-1)
  assert.equal(latest?.stale, false)
  assert.equal(latest?.message, undefined)
  assert.equal(latest?.updatedAt, T0 + 3 * HOUR)
  assert.deepEqual(await h.service.snapshot(ORG), latest)
})

test('a saved Work snapshot is held from start-up, so cachedItem answers without a request', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX })])
  await drain()

  assert.equal(h.service.cachedItem(ORG, 1204)?.title, 'Add vehicle search filters')
  assert.equal(h.ado.calls.length, 0, 'the hidden Work tab does not load until it is asked for')
})

test('a saved Work snapshot from another account or another boards target is ignored', async () => {
  const { cache } = await savedWork()
  const elsewhere = structuredClone(cache)
  ;(elsewhere[cacheKey(ORG, 'work')] as { value: WorkSnapshot }).value.board!.teamId = OTHER_TEAM

  for (const [account, saved] of [[OTHER_ACCOUNT, cache], [ALEX, elsewhere]] as const) {
    const h = harness(status({ account }), { cache: saved, at: T0 + HOUR })
    const snapshot = await h.service.snapshot(ORG)
    assert.equal(snapshot.stale, false, account.adoId)
    assert.equal(snapshot.updatedAt, T0 + HOUR)
    assert.equal(snapshot.message, undefined)
  }
})

test('a saved snapshot is not served while the org is expired', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX, state: 'expired' }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  assert.equal((await rejection(h.service.snapshot(ORG))).message, NOT_CONNECTED)

  h.setOrgs([status({ account: ALEX })])
  await drain()
  assert.ok(h.service.cachedItem(ORG, 1204), 'held once connected')
  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  assert.equal((await rejection(h.service.snapshot(ORG))).message, NOT_CONNECTED)
  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.deepEqual(h.posts, [])

  h.setOrgs([status({ account: ALEX })])
  assert.equal((await h.service.snapshot(ORG)).message, SHOWING_SAVED, 'served once it reconnects')
})

test('a saved snapshot is not served once the org expires while its revalidation is being rejected', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX })])
  h.ado.on(() => true, () => json(401, {}))
  assert.equal((await h.service.snapshot(ORG)).message, SHOWING_SAVED)

  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  await drain()
  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.equal((await rejection(h.service.snapshot(ORG))).message, NOT_CONNECTED)
  assert.deepEqual(h.posts, [])

  h.setOrgs([status({ account: ALEX })])
  assert.equal((await h.service.snapshot(ORG)).message, SHOWING_SAVED, 'served again once it reconnects')
})

test('a restored Work snapshot whose revalidation was rejected is dropped when the org expires', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX })])
  h.ado.on(() => true, () => json(401, {}))
  assert.equal((await h.service.snapshot(ORG)).message, SHOWING_SAVED)
  await drain()
  assert.deepEqual([h.posts.at(-1)?.stale, h.posts.at(-1)?.message], [true, REJECTED])
  assert.ok(h.service.cachedItem(ORG, 1204), 'still held while the org is connected')

  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.equal((await rejection(h.service.snapshot(ORG))).message, NOT_CONNECTED)
})

test('a saved Work snapshot whose read finishes after the org expired is not served', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX })])
  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  await drain()

  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.equal((await rejection(h.service.snapshot(ORG))).message, NOT_CONNECTED)
  assert.deepEqual(h.posts, [])
})

test('a sign-in interrupted by a restart drops the restored view from memory, and it is restored again once connected', async () => {
  const { cache } = await savedWork()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + HOUR })
  h.setOrgs([status({ account: ALEX })])
  await drain()
  assert.ok(h.service.cachedItem(ORG, 1204))

  h.setOrgs([status({ account: ALEX, state: 'disconnected', message: INTERRUPTED })])
  assert.equal(h.service.cachedItem(ORG, 1204), null)

  h.setOrgs([status({ account: ALEX })])
  assert.equal((await h.service.snapshot(ORG)).message, SHOWING_SAVED)
})

test('the board paints a saved view at once when no view is held, and revalidates it', async () => {
  const { view, cache } = await savedBoard()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  boardIds(h, [1204, 1205])
  h.ado.change(1205)
  const gate = h.ado.hold(() => true)

  const painted = await h.service.board(STORIES_BOARD)
  assert.deepEqual(painted, { ...view, stale: true })
  assert.ok(h.ado.calls.length <= 1, 'answered before the first request of the revalidation is answered')
  assert.deepEqual(h.boardPosts, [])

  gate.release()
  await drain()
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  const live = await h.service.board(STORIES_BOARD)
  assert.equal(live.stale, undefined)
  assert.equal(live.message, undefined)
  assert.equal(live.items.find(entry => entry.id === 1205)?.rev, view.items.find(entry => entry.id === 1205)!.rev + 1)
})

test('a restored board view is dropped when its org expires, even after its revalidation was rejected', async () => {
  const { cache } = await savedBoard()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  h.ado.on(() => true, () => json(401, {}))
  assert.equal((await h.service.board(STORIES_BOARD)).stale, true)
  await drain()
  const rejected = await h.service.board(STORIES_BOARD)
  assert.equal(rejected.stale, true)
  assert.match(rejected.message ?? '', /rejected the credentials/)

  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.equal((await rejection(h.service.board(STORIES_BOARD))).message, NOT_CONNECTED)
})

test('a saved board view whose read finishes after the org expired is not served', async () => {
  const { cache } = await savedBoard()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  boardIds(h, [1204, 1205])
  const read = h.holdCacheRead(cacheKey(ORG, `board:${TEAM}:${STORIES}`))
  const opening = h.service.board(STORIES_BOARD)
  await drain()

  h.setOrgs([status({ account: ALEX, state: 'expired' })])
  read.release()
  assert.equal((await rejection(opening)).message, NOT_CONNECTED)
  assert.equal(h.service.cachedItem(ORG, 1204), null)
  assert.deepEqual(h.boardPosts, [])
})

test('a saved board view is served only for the filter it was saved with', async () => {
  const { cache } = await savedBoard()
  const h = harness(status({ account: ALEX }), { cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  boardIds(h, [1204, 1205])

  const mine = await h.service.board({ ...STORIES_BOARD, everyone: false })
  assert.equal(mine.everyone, false)
  assert.equal(mine.stale, undefined)
  assert.ok(h.ado.calls.some(isStoriesWiql))
})

test('a board result carries when it was loaded, and a restored one carries when it was saved', async () => {
  const { view, cache } = await savedBoard()
  assert.equal(view.updatedAt, T0)
  const savedAt = T0 + 5 * MINUTE
  ;(cache[cacheKey(ORG, `board:${TEAM}:${STORIES}`)] as { savedAt: number }).savedAt = savedAt

  const h = harness(status({ account: ALEX }), { cache, at: T0 + 30 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  boardIds(h, [1204, 1205])
  const gate = h.ado.hold(() => true)
  const painted = await h.service.board(STORIES_BOARD)
  assert.equal(painted.stale, true)
  assert.equal(painted.updatedAt, savedAt)
  assert.equal(painted.message, undefined, "the editor's own note says it is refreshing")

  gate.release()
  await drain()
  const live = await h.service.board(STORIES_BOARD)
  assert.equal(live.stale, undefined)
  assert.equal(live.updatedAt, T0 + 30 * MINUTE)
})

test('a quiet Work tab and board keep polling without rewriting their saved copies, refreshing each at most once per 15 minutes', async () => {
  const h = harness(status({ account: ALEX }))
  h.service.visibility({ surface: 'work', org: ORG, visible: true })
  h.setOrgs([status({ account: ALEX })])
  boardIds(h, [1204, 1205])
  await h.service.board(STORIES_BOARD)
  await h.clock.tick(0)
  const views = [cacheKey(ORG, 'work'), cacheKey(ORG, `board:${TEAM}:${STORIES}`)]
  const written: number[][] = views.map(() => [])
  const record = () =>
    views.forEach((key, index) => {
      while (written[index].length < h.cache.writes.filter(entry => entry === key).length) written[index].push((h.clock.now() - T0) / MINUTE)
    })
  record()
  assert.deepEqual(written, [[0], [0]])
  const loads = [h.ado.count(isMineWiql), h.ado.count(isBoardWiql)]

  const settled = h.cache.writes.length
  for (let minute = 1; minute <= 10; minute += 1) {
    await h.clock.tick(MINUTE)
    record()
  }
  assert.ok(h.ado.count(isMineWiql) >= loads[0] + 4 && h.ado.count(isBoardWiql) >= loads[1] + 8, 'both views kept polling')
  assert.deepEqual(written, [[0], [0]], 'nothing changed, so nothing was written')
  assert.deepEqual(h.cache.writes.slice(settled), [], 'nor the meta, the PR records or the index')

  for (let minute = 11; minute <= 60; minute += 1) {
    await h.clock.tick(MINUTE)
    record()
  }
  for (const [index, times] of written.entries()) {
    assert.ok(times.length >= 4, `${views[index]} is refreshed: ${times}`)
    times.slice(1).forEach((at, step) => assert.ok(at - times[step] >= 15 && at - times[step] <= 17, `${views[index]} written at ${times}`))
  }
})

test('saved board configs, type states and PR records seed the store with their original age', async () => {
  const prs = { 402: { status: 'active', target: 'dev' }, 403: { status: 'completed', target: 'staging' } }
  const before = harness(status({ account: ALEX }))
  linkPullRequests(before, 1204, prs)
  await before.service.refresh(ORG)
  const cache = await savedFrom(before)

  const h = harness(status({ account: ALEX }), { cache, at: T0 + 10 * MINUTE })
  linkPullRequests(h, 1204, prs)
  const snapshot = await h.service.refresh(ORG)

  assert.deepEqual(item(snapshot, 1204)?.prs.map(chip => [chip.prId, chip.state]), [[321, 'merged'], [402, 'open'], [403, 'merged']])
  assert.equal(h.ado.count(isBoardSetting), 0, 'no board configuration request')
  assert.equal(h.ado.count(isTypeStates('Task')), 0, 'no type-state request')
  const read = h.ado.calls.filter(isPullRequest).map(call => Number(call.path.split('/').at(-1)))
  assert.ok(!read.includes(321) && !read.includes(403), `no merged PR is read again: ${read}`)
  const tables = h.entities.of(ORG)
  assert.deepEqual(tables.boardConfigs.entries().map(([, entry]) => entry.at), [T0])
  assert.equal(tables.prs.get(`${PROJECT}/${REPO}/321`)?.at, T0)
})

function manyLinkedPrs(h: ReturnType<typeof harness>): void {
  const stories = Array.from({ length: 40 }, (_, index) => 9000 + index)
  const prIds = Array.from({ length: 400 }, (_, index) => 5000 + index)
  const open = new Set(prIds.slice(0, 30))
  const raw = (prId: number) => ({ ...fixture<object>('pull-request-active'), pullRequestId: prId, codeReviewId: prId, status: open.has(prId) ? 'active' : 'completed' })
  stories.forEach((id, index) => {
    const linked = story(id, T0 - index * MINUTE)
    linked.relations = prIds.slice(index * 10, index * 10 + 10).map(prId => ({ rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${PROJECT}%2F${REPO}%2F${prId}`, attributes: { name: 'Pull Request' } }))
    h.ado.items.set(id, linked)
  })
  boardIds(h, stories)
  h.ado.on(isActiveList, () => json(200, { value: [...open].map(raw) }))
  h.ado.on(isPullRequest, call => json(200, raw(Number(call.path.split('/').at(-1)))))
}

test('a cold start of a board with 400 linked PRs costs under 15 requests when PR records were saved', async () => {
  const before = harness(status({ account: ALEX }))
  before.setOrgs([status({ account: ALEX })])
  manyLinkedPrs(before)
  await before.service.board(STORIES_BOARD)
  await before.clock.tick(5 * MINUTE)
  assert.ok(before.ado.count(isPullRequest) >= 370, 'the first start reads every merged PR')
  const cache = await savedFrom(before)

  const h = harness(status({ account: ALEX }), { cache, at: before.clock.now() + 10 * MINUTE })
  h.setOrgs([status({ account: ALEX })])
  manyLinkedPrs(h)
  const painted = await h.service.board(STORIES_BOARD)
  assert.equal(painted.stale, true)
  await drain()

  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  const live = await h.service.board(STORIES_BOARD)
  assert.equal(live.stale, undefined)
  assert.deepEqual(new Set(live.items.flatMap(entry => entry.prs.map(chip => chip.state))), new Set(['merged', 'open']))
  assert.equal(h.ado.count(isPullRequest), 0)
  assert.ok(h.ado.calls.length < 15, `${h.ado.calls.length} requests: ${h.ado.calls.map(call => call.path).join(', ')}`)
})
