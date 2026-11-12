import { assert, test } from 'orca/testing'
import type { RawTimeline } from '../ado/timeline'
import { drain } from '../test-support'
import { currentContext, inLane, type Lane } from './context'
import { createEntities, type Table } from './entities'
import { MAX_ENTRIES } from './freshness'
import type { ItemRecord } from './records'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const ALPHA = [1201]
const BETA = [1202]
const GAMMA = [1203]
const ABANDONED = [1299]

function clock() {
  let now = T0
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function counted<T>(answer: () => Promise<T>) {
  const signals: AbortSignal[] = []
  return {
    signals,
    load: (signal: AbortSignal) => {
      signals.push(signal)
      return answer()
    }
  }
}

function tableOn(now: () => number): Table<number[]> {
  return createEntities(now).of('contoso').prWorkItems
}

function record(id: number, rev: number, withRelations: boolean): ItemRecord {
  return { id, rev, fields: { 'System.Title': `Story ${id} rev ${rev}` }, url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`, withRelations }
}

test('fresh returns a value only within its age', () => {
  const time = clock()
  const table = tableOn(time.now)
  assert.equal(table.fresh('a', MINUTE), undefined)
  table.put('a', ALPHA)
  assert.equal(table.fresh('a', MINUTE), ALPHA)
  time.advance(MINUTE - 1)
  assert.equal(table.fresh('a', MINUTE), ALPHA)
  time.advance(1)
  assert.equal(table.fresh('a', MINUTE), undefined)
  assert.deepEqual(table.get('a'), { value: ALPHA, at: T0 }, 'a stale value is still held')
})

test('read loads once for concurrent callers and caches the result', async () => {
  const time = clock()
  const table = tableOn(time.now)
  const gate = deferred<number[]>()
  const source = counted(() => gate.promise)
  const first = table.read('a', MINUTE, source.load)
  const second = table.read('a', MINUTE, source.load)
  gate.resolve(ALPHA)
  assert.deepEqual(await Promise.all([first, second]), [ALPHA, ALPHA])
  assert.equal(source.signals.length, 1)

  assert.equal(await table.read('a', MINUTE, source.load), ALPHA)
  assert.equal(source.signals.length, 1, 'a fresh value answers without loading')
  assert.deepEqual(table.get('a'), { value: ALPHA, at: T0 })

  time.advance(MINUTE)
  const again = counted(async () => BETA)
  assert.equal(await table.read('a', MINUTE, again.load), BETA)
  assert.equal(again.signals.length, 1, 'a stale value loads again')
})

test('read does not cache a failed load, and the next read tries again', async () => {
  const table = tableOn(clock().now)
  const boom = new Error('Azure DevOps is down')
  const failing = counted(() => Promise.reject(boom))
  const results = await Promise.allSettled([table.read('a', MINUTE, failing.load), table.read('a', MINUTE, failing.load)])
  assert.deepEqual(results, [{ status: 'rejected', reason: boom }, { status: 'rejected', reason: boom }])
  assert.equal(failing.signals.length, 1)
  assert.equal(table.get('a'), undefined)

  const working = counted(async () => ALPHA)
  assert.equal(await table.read('a', MINUTE, working.load), ALPHA)
  assert.equal(working.signals.length, 1)
})

test('read runs its load on its own signal: one caller aborting leaves the load running for the others', async () => {
  const table = tableOn(clock().now)
  const gate = deferred<number[]>()
  const source = counted(() => gate.promise)
  const a = new AbortController()
  const b = new AbortController()
  const first = table.read('a', MINUTE, source.load, a.signal)
  const second = table.read('a', MINUTE, source.load, b.signal)
  a.abort('panel closed')
  await assert.rejects(first, reason => reason === 'panel closed')
  assert.equal(source.signals[0].aborted, false)
  gate.resolve(ALPHA)
  assert.equal(await second, ALPHA)
  assert.equal(table.get('a')?.value, ALPHA)

  const hung = counted(() => new Promise<number[]>(() => {}))
  const c = new AbortController()
  const unbounded = table.read('b', MINUTE, hung.load, c.signal)
  void table.read('b', MINUTE, hung.load)
  c.abort('gone')
  await assert.rejects(unbounded, reason => reason === 'gone')
  assert.equal(hung.signals[0].aborted, false, 'a caller without a signal keeps the load alive')

  const late = deferred<number[]>()
  const abandoned = counted(() => late.promise)
  const d = new AbortController()
  const e = new AbortController()
  const reads = [table.read('c', MINUTE, abandoned.load, d.signal), table.read('c', MINUTE, abandoned.load, e.signal)]
  d.abort('d')
  e.abort('e')
  await Promise.allSettled(reads)
  assert.equal(abandoned.signals[0].aborted, true, 'the load aborts once every caller has')
  late.resolve(ABANDONED)
  await drain()
  assert.equal(table.get('c'), undefined, 'an aborted load is not cached')
  const next = counted(async () => GAMMA)
  assert.equal(await table.read('c', MINUTE, next.load), GAMMA)
  assert.equal(next.signals.length, 1, 'a read after every caller left starts a new load')
})

test('a user caller joining a read raises its lane', async () => {
  const table = tableOn(clock().now)
  const gate = deferred<number[]>()
  let lane: Lane | undefined
  const load = () => {
    lane = currentContext().lane
    return gate.promise
  }
  const background = inLane('board', 'hidden', () => table.read('a', MINUTE, load))
  assert.equal(lane?.priority, 'hidden')
  const visible = inLane('board', 'visible', () => table.read('a', MINUTE, load))
  assert.equal(lane?.priority, 'hidden', 'a background caller does not raise it')
  const user = inLane('board', 'user', () => table.read('a', MINUTE, load))
  assert.equal(lane?.priority, 'user')
  gate.resolve(ALPHA)
  assert.deepEqual(await Promise.all([background, visible, user]), [ALPHA, ALPHA, ALPHA])
})

test('the rev rule keeps the newer record and never trades relations away', () => {
  const items = createEntities(clock().now).of('contoso').workItems
  items.put('1', record(1, 5, false))
  assert.deepEqual(items.put('1', record(1, 4, true)), record(1, 5, false), 'rev 5 then rev 4 keeps rev 5')

  items.put('2', record(2, 5, false))
  assert.deepEqual(items.put('2', record(2, 5, true)), record(2, 5, true), 'rev 5 without relations then with takes the one with')

  items.put('3', record(3, 5, true))
  assert.deepEqual(items.put('3', record(3, 5, false)), record(3, 5, true), 'rev 5 with relations then without keeps the one with')

  items.put('4', record(4, 5, true))
  assert.deepEqual(items.put('4', record(4, 6, false)), record(4, 6, false), 'rev 5 then rev 6 without relations takes rev 6')
  assert.deepEqual(items.get('4')?.value, record(4, 6, false))
})

test('the timeline rule keeps the higher changeId', () => {
  const timelines = createEntities(clock().now).of('contoso').timelines
  const timeline = (changeId: number): RawTimeline => ({ changeId, records: [] })
  timelines.put('7', timeline(12))
  assert.equal(timelines.put('7', timeline(11)).changeId, 12)
  assert.equal(timelines.put('7', timeline(12)).changeId, 12)
  assert.equal(timelines.put('7', timeline(13)).changeId, 13)
})

test('tables evict the least recently used entries past their limit', async () => {
  const projects = createEntities(clock().now).of('contoso').projects
  assert.equal(MAX_ENTRIES.projects, 4)
  for (const key of ['a', 'b', 'c', 'd']) projects.put(key, [])
  projects.get('a')
  projects.put('e', [])
  assert.deepEqual(projects.entries().map(([key]) => key), ['c', 'd', 'a', 'e'], 'get counts as a use')
  projects.fresh('c', MINUTE)
  projects.put('f', [])
  assert.deepEqual(projects.entries().map(([key]) => key), ['a', 'e', 'c', 'f'], 'fresh counts as a use')
  await projects.read('a', MINUTE, async () => [])
  projects.put('g', [])
  assert.deepEqual(projects.entries().map(([key]) => key), ['c', 'f', 'a', 'g'], 'a read hit counts as a use')
})

test('watchers hear changed keys per org, batched per microtask, and still hear them after forget', async () => {
  const entities = createEntities(clock().now)
  const heard: [string, string[]][] = []
  const stop = entities.watch('wikis', (org, keys) => heard.push([org, keys]))
  const other: [string, string[]][] = []
  entities.watch('projects', (org, keys) => other.push([org, keys]))

  entities.of('contoso').wikis.put('all', [])
  entities.of('fabrikam').wikis.put('all', [])
  entities.of('contoso').wikis.put('all', [])
  entities.of('contoso').wikis.put('more', [])
  assert.deepEqual(heard, [], 'nothing is heard until the microtask ends')
  await drain()
  assert.deepEqual(heard, [['contoso', ['all', 'more']], ['fabrikam', ['all']]])
  assert.deepEqual(other, [], 'a watcher hears only its table')

  entities.of('contoso').wikis.drop('more')
  entities.of('contoso').wikis.drop('missing')
  await drain()
  assert.deepEqual(heard.at(-1), ['contoso', ['more']], 'a drop is a change')

  entities.forget('contoso')
  entities.of('contoso').wikis.put('all', [])
  await drain()
  assert.deepEqual(heard.at(-1), ['contoso', ['all']], 'fresh tables after forget still tell the watcher')

  stop()
  entities.of('contoso').wikis.put('all', [])
  await drain()
  assert.equal(heard.length, 4, 'a stopped watcher hears nothing more')
})

test('put with an explicit at keeps it, so restored values age honestly', () => {
  const table = tableOn(clock().now)
  table.put('a', ALPHA, T0 - 50_000)
  assert.deepEqual(table.get('a'), { value: ALPHA, at: T0 - 50_000 })
  assert.equal(table.fresh('a', MINUTE), ALPHA)
  assert.equal(table.fresh('a', 30_000), undefined)
})

test('forget drops every table of that org and leaves other orgs', () => {
  const entities = createEntities(clock().now)
  const contoso = entities.of('contoso')
  assert.equal(entities.of('contoso'), contoso, 'the same tables until forgotten')
  contoso.workItems.put('1', record(1, 1, false))
  contoso.wikis.put('all', [])
  entities.of('fabrikam').wikis.put('all', [])

  entities.forget('contoso')
  const fresh = entities.of('contoso')
  assert.notEqual(fresh, contoso)
  assert.deepEqual(fresh.workItems.entries(), [])
  assert.equal(fresh.wikis.get('all'), undefined)
  assert.deepEqual(entities.of('fabrikam').wikis.get('all'), { value: [], at: T0 })
})
