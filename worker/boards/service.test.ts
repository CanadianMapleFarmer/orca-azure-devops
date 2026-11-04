import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import type { WorkItemSummary, WorkSnapshot } from '../../src/shared/work'
import { AdoError, createAdoHttp } from '../ado/http'
import type { RawWorkItem } from '../ado/workitems'
import type { StorePort } from '../connections'
import { createScheduler } from '../poll/scheduler'
import {
  BOARDS,
  fakeAdo,
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

async function drain(): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

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
  const store: StorePort = {
    get: async <T,>(key: string) => (key in storage ? (structuredClone(storage[key]) as T) : null),
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
  assert.deepEqual(snapshot.mine.map(entry => entry.id), [1204, 1205])
  assert.deepEqual(snapshot.other.map(entry => entry.id), [1207])
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
  assert.equal(snapshot.mine[1].parentTitle, null)
  assert.equal(snapshot.other[0].parentTitle, 'Add vehicle search filters')
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
  assert.deepEqual(item(snapshot, 1205)?.targets, { columns: COLUMNS, states: [] })
  assert.deepEqual(item(snapshot, 1207)?.targets, { columns: [], states: ['New', 'Closed', 'Removed'] })
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

test('a refused linkPr refreshes the item and reports the conflict', async () => {
  const h = harness()
  h.ado.state.staleStatus = 400
  await h.service.refresh(ORG)
  const error = await rejection(h.service.linkPr({ org: ORG, id: 1205, rev: 2, prUrl: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322` }))
  assert.deepEqual({ code: error.code, message: error.message }, { code: 'conflict', message: CONFLICT })
  assert.equal(item(h.posts.at(-1), 1205)?.rev, 3)
  assert.equal(h.ado.items.get(1205)?.relations, undefined)
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
  assert.deepEqual(first.mine.map(entry => [entry.id, entry.prs]), [[1204, []], [1205, []]])
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
  await h.clock.tick(0)
  assert.equal(h.ado.count(isBoardWiql), 4)

  h.setOrgs([status({ state: 'expired' })])
  await h.clock.tick(5 * MINUTE)
  assert.equal(h.ado.count(isBoardWiql), 4, 'a board of an org that is not connected is not polled')
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
