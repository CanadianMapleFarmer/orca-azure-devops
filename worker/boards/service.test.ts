import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import type { WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { createScheduler } from '../poll/scheduler'
import { drain } from '../test-support'
import {
  BOARDS,
  fixture,
  fakeAdo,
  FEATURES,
  FEATURES_WEF,
  isBatch,
  isPatch,
  isPullRequest,
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
import { createBoardsService, type BoardChange } from './service'

const T0 = Date.parse('2026-11-04T09:00:00Z')
const MINUTE = 60_000
const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const NO_BOARDS = "Pick a boards project and team in this org's settings."
const NEEDS_CODE_READ = 'Linked PR status needs Code (Read) access.'
const COLUMNS = ['New', 'Active', 'In Review', 'Resolved', 'Closed']
const MINE_QUERY =
  "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed') ORDER BY [System.ChangedDate] DESC"

function fakeClock() {
  let now = T0
  let nextHandle = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const handle = nextHandle++
      timers.set(handle, { due: now + ms, fn })
      return handle
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number)
    },
    async tick(ms: number): Promise<void> {
      const target = now + ms
      for (let fired = 0; ; fired += 1) {
        if (fired > 1000) throw new Error('more than 1000 timers fired in one tick')
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort(([ha, a], [hb, b]) => a.due - b.due || ha - hb)[0]
        if (!next) break
        timers.delete(next[0])
        now = Math.max(now, next[1].due)
        next[1].fn()
        await drain()
      }
      now = target
      await drain()
    }
  }
}

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

function harness() {
  const ado = fakeAdo()
  const clock = fakeClock()
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
  let orgs = [status()]
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const service = createBoardsService({
    http,
    orgs: async () => structuredClone(orgs),
    store,
    scheduler: createScheduler(clock),
    post: snapshot => posts.push(structuredClone(snapshot)),
    postBoard: change => boardPosts.push(change),
    now: clock.now
  })
  return {
    ado,
    clock,
    storage,
    posts,
    boardPosts,
    service,
    setOrgs(next: OrgStatus[]) {
      orgs = next
      service.onOrgs(structuredClone(next))
    },
    holdRead(key: string): { release(): void } {
      let release = () => {}
      heldReads.set(key, new Promise<void>(resolve => (release = resolve)))
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

const isMineWiql = (call: AdoCall) => isWiql(call) && !call.body.query.includes('[System.WorkItemType] IN')
const isBoardWiql = (call: AdoCall) => isWiql(call) && call.body.query.includes('[System.WorkItemType] IN')

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
    updatedAt: T0,
    stale: false,
    message: NO_BOARDS
  })
  assert.equal((await h.service.refresh(ORG)).message, NO_BOARDS)
  await h.clock.tick(10 * MINUTE)
  assert.equal(h.ado.calls.length, 0)
  assert.deepEqual(h.posts, [])
})

test('visibility switches the job cadence', async () => {
  const h = harness()
  h.setOrgs([status()])
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 1, 'a new job runs at once')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 1, 'hidden: every 5 min')

  assert.deepEqual(h.service.visibility({ surface: 'work', org: ORG, visible: true }), { ok: true })
  await h.clock.tick(0)
  assert.equal(h.ado.count(isMineWiql), 2, 'visible: due once a minute has passed')
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 3)

  h.service.visibility({ surface: 'work', org: ORG, visible: false })
  await h.clock.tick(4 * MINUTE)
  assert.equal(h.ado.count(isMineWiql), 3)
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isMineWiql), 4)
  assert.equal(h.posts.length, 4)

  const early = harness()
  early.service.visibility({ surface: 'work', org: ORG, visible: true })
  early.setOrgs([status()])
  await early.clock.tick(0)
  await early.clock.tick(MINUTE)
  assert.equal(early.ado.count(isMineWiql), 2, 'visibility reported before the job existed still applies')
})

test('jobs follow org status: added when connected, removed otherwise', async () => {
  const h = harness()
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

test('the board loads every 30 s while a board is visible', async () => {
  const h = harness()
  h.setOrgs([status()])
  h.ado.state.wiql = [1204, 1205, 1206]
  const view = await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })
  assert.equal(view.board.boardId, STORIES)
  assert.deepEqual(view.items.map(entry => entry.id), [1204, 1205, 1206])
  assert.equal(h.ado.count(isBoardWiql), 1)
  assert.ok(!h.ado.calls.find(isBoardWiql)?.body.query.includes('@Me'), 'everyone')

  assert.deepEqual(await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true }), view)
  assert.equal(h.ado.count(isBoardWiql), 1, 'a fresh board is served from the cache')

  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 2)
  assert.deepEqual(h.boardPosts, [], 'nothing changed')

  h.ado.items.get(1205)!.rev = 4
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 3)
  assert.deepEqual(h.boardPosts, [{ org: ORG, teamId: TEAM, boardId: STORIES }])
  assert.equal((await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })).items[1].rev, 4)

  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 3, 'a hidden board is not polled')

  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  await h.service.board({ org: ORG, projectId: PROJECT, teamId: TEAM, everyone: true })
  assert.equal(h.ado.count(isBoardWiql), 4, 'a board shown again is asked for again')
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isBoardWiql), 5)

  h.setOrgs([status({ state: 'expired' })])
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 5, 'a board of an org that is not connected is not polled')
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

const isStoriesWiql = (call: AdoCall) => isBoardWiql(call) && call.body.query.includes("'User Story'")
const isFeaturesWiql = (call: AdoCall) => isBoardWiql(call) && call.body.query.includes("IN ('Feature')")

function boardIds(h: ReturnType<typeof harness>, stories: number[], features: number[] = [1100]): void {
  const ids = (list: number[]) => json(200, { workItems: list.map(id => ({ id })) })
  h.ado.on(isStoriesWiql, () => ids(stories))
  h.ado.on(isFeaturesWiql, () => ids(features))
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
  const held = h.ado.hold(call => isBatch(call) && call.body.ids.length === 4)
  const polling = h.service.refresh(ORG)
  await drain()

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' } })
  held.release()
  const landed = await polling
  assert.deepEqual(item(landed, 1204), moved)
  assert.deepEqual(item(h.posts.at(-1), 1204), moved)

  h.ado.items.get(1204)!.rev = 11
  assert.equal(item(await h.service.refresh(ORG), 1204)?.rev, 11)
})

test('a board load in flight when a move lands does not bring the old item back', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  const held = h.ado.hold(call => isBatch(call) && call.body.ids.join() === '1204,1205')
  await h.clock.tick(30_000)

  const moved = await h.service.move({ org: ORG, id: 1204, rev: 9, to: { column: 'Resolved' }, board: { teamId: TEAM, boardId: STORIES } })
  held.release()
  await drain()
  assert.deepEqual((await h.service.board({ ...STORIES_BOARD, everyone: false })).items[0], moved)
  assert.equal(h.boardPosts.length, 1, 'only the move changed the board')
})

test('hiding the boards drops them, and only a board asked for again polls', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 2])

  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  await h.clock.tick(MINUTE)
  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  await h.clock.tick(MINUTE)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 2])

  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [2, 4])
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
  h.ado.on(call => call.path === `${teamPath}/wit/wiql`, () => json(200, { workItems: [{ id: 1204 }] }))
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
  h.ado.on(call => call.path === `${base}/${team}/_apis/wit/wiql`, () => json(200, { workItems: [] }))
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

test('a board that lands after the boards were hidden is neither kept nor polled', async () => {
  const h = harness()
  h.setOrgs([status()])
  const held = h.ado.hold(isStoriesWiql)
  const opening = h.service.board({ ...STORIES_BOARD, everyone: false })
  await drain()
  h.service.visibility({ surface: 'board', org: ORG, visible: false })
  held.release()
  await opening

  h.service.visibility({ surface: 'board', org: ORG, visible: true })
  await h.clock.tick(MINUTE)
  assert.equal(h.ado.count(isStoriesWiql), 1, 'no job was armed for it')
  await h.service.board({ ...STORIES_BOARD, everyone: false })
  assert.equal(h.ado.count(isStoriesWiql), 2, 'its view was not kept, so asking again loads it')
})

const STORIES_REF = { teamId: TEAM, boardId: STORIES }

test('hiding one board drops only that view and its job; another board of the org keeps polling', async () => {
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
  assert.equal(h.ado.count(isStoriesWiql), 2, 'the Stories view was dropped, so asking again loads it')
})

test('showing a hidden board polls only it again, once it is asked for again', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [1, 2])

  await h.service.board({ ...STORIES_BOARD, everyone: true })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [3, 3])
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
  await h.clock.tick(30_000)
  assert.equal(h.ado.count(isStoriesWiql), 3, 'and keeps polling')
})

test('a board load in flight across that board being hidden is neither kept nor polled', async () => {
  const h = harness()
  h.setOrgs([status()])
  boardIds(h, [1204, 1205])
  await h.service.board({ ...FEATURES_BOARD, everyone: true })
  const held = h.ado.hold(isStoriesWiql)
  const opening = h.service.board({ ...STORIES_BOARD, everyone: true })
  await drain()
  h.service.visibility({ surface: 'board', org: ORG, visible: false, board: STORIES_REF })
  held.release()
  await opening

  h.service.visibility({ surface: 'board', org: ORG, visible: true, board: STORIES_REF })
  await h.clock.tick(30_000)
  assert.deepEqual([h.ado.count(isStoriesWiql), h.ado.count(isFeaturesWiql)], [1, 2], 'no job was armed for Stories')
  await h.service.board({ ...STORIES_BOARD, everyone: true })
  assert.equal(h.ado.count(isStoriesWiql), 2, 'its view was not kept, so asking again loads it')
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
