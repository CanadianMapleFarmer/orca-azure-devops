import { assert, test } from 'orca/testing'
import { AdoError, type AdoHttp, type AdoRequest } from '../ado/http'
import { drain, fakeClock } from '../test-support'
import { currentContext, inLane, raise, type Feature, type Priority } from './context'
import { BACKGROUND_SLOTS, createGovernor, MAX_IN_FLIGHT, mergeKey } from './governor'
import { createPressure, PRESSURE_FACTORS, type PressureLevel, type PressureState } from './rate-limit'

const T0 = Date.parse('2026-11-11T10:00:00Z')

interface Call {
  req: AdoRequest
  feature: Feature
  priority: Priority
  answer(data?: unknown): void
  fail(error: unknown): void
}

function fakeHttp() {
  const calls: Call[] = []
  const http: AdoHttp = {
    json<T>(req: AdoRequest) {
      const { feature, lane } = currentContext()
      return new Promise<{ data: T; headers: Headers }>((resolve, reject) => {
        calls.push({ req, feature, priority: lane.priority, answer: (data = {}) => resolve({ data: data as T, headers: new Headers() }), fail: reject })
      })
    }
  }
  return { http, calls }
}

function settablePressure(level: PressureLevel = 'normal') {
  let current: PressureState = { level, factor: PRESSURE_FACTORS[level], resumeAt: 0, last: null }
  return {
    state: () => current,
    set(next: PressureLevel) {
      current = { ...current, level: next, factor: PRESSURE_FACTORS[next] }
    }
  }
}

function setup(level: PressureLevel = 'normal') {
  const clock = fakeClock(T0)
  const pressure = settablePressure(level)
  const inner = fakeHttp()
  const governor = createGovernor({ http: inner.http, pressure, now: clock.now, clock })
  return { clock, pressure, inner, governor }
}

function blockedFor(seconds: number) {
  const clock = fakeClock(T0)
  const pressure = createPressure(clock.now)
  pressure.observe({ org: 'contoso', path: '/_apis/wit/wiql' }, 429, new Headers({ 'Retry-After': String(seconds) }))
  const inner = fakeHttp()
  const governor = createGovernor({ http: inner.http, pressure, now: clock.now, clock })
  return { clock, inner, governor }
}

const get = (path: string, extra: Partial<AdoRequest> = {}): AdoRequest => ({ org: 'contoso', project: 'Web', path, ...extra })
const post = (path: string, body: unknown, extra: Partial<AdoRequest> = {}): AdoRequest => ({ ...get(path, extra), method: 'POST', body })
const WIQL = '/_apis/wit/wiql'
const BATCH = '/_apis/wit/workitemsbatch'

function caught<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; error?: unknown } = { settled: false }
  promise.then(() => (outcome.settled = true), error => Object.assign(outcome, { settled: true, error }))
  return outcome
}

function fill(governor: AdoHttp, count = MAX_IN_FLIGHT, feature: Feature = 'work') {
  return Array.from({ length: count }, (_, n) => inLane(feature, 'user', () => governor.json(get(`/_apis/user/${n}`))))
}

const paths = (calls: Call[]) => calls.map(call => call.req.path)

test('identical GETs in flight share one request', async () => {
  const { inner, governor } = setup()
  const first = governor.json(get('/_apis/git/repositories', { query: { top: 10 } }))
  const second = governor.json(get('/_apis/git/repositories', { query: { top: 10 } }))
  await drain()
  assert.equal(inner.calls.length, 1)

  inner.calls[0].answer({ value: ['web'] })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a.data, { value: ['web'] })
  assert.equal(b.data, a.data)

  void governor.json(get('/_apis/git/repositories', { query: { top: 10 } }))
  await drain()
  assert.equal(inner.calls.length, 2, 'a finished request is not reused')
})

test('wiql and workitemsbatch posts with the same body share one request, other writes never do', async () => {
  const { inner, governor } = setup()
  const count = (path: string) => inner.calls.filter(call => call.req.path === path).length

  void governor.json(post(WIQL, { query: 'SELECT [System.Id] FROM WorkItems' }))
  void governor.json(post(WIQL, { query: 'SELECT [System.Id] FROM WorkItems' }))
  void governor.json(post(BATCH, { ids: [1, 2] }))
  void governor.json(post(BATCH, { ids: [1, 2] }))
  await drain()
  assert.equal(count(WIQL), 1)
  assert.equal(count(BATCH), 1)

  const patch: AdoRequest = { ...get('/_apis/wit/workitems/7'), method: 'PATCH', body: [{ op: 'add', path: '/fields/System.State', value: 'Done' }] }
  void governor.json(patch)
  void governor.json(patch)
  await drain()
  assert.equal(count('/_apis/wit/workitems/7'), 2)

  const fresh = setup()
  void fresh.governor.json(post(WIQL, { query: 'SELECT [System.Id] FROM WorkItems' }))
  void fresh.governor.json(post(WIQL, { query: 'SELECT [System.Title] FROM WorkItems' }))
  await drain()
  assert.equal(fresh.inner.calls.length, 2)
})

test('mergeKey ignores query order and the signal, and refuses writes', () => {
  const signal = new AbortController().signal
  const base = get('/_apis/build/builds', { query: { top: 5, statusFilter: 'inProgress' } })
  assert.equal(mergeKey(base), mergeKey({ ...base, query: { statusFilter: 'inProgress', top: 5 }, signal }))
  assert.equal(mergeKey(base), mergeKey({ ...base, query: { ...base.query, skip: undefined } }))

  for (const other of [
    { ...base, org: 'fabrikam' },
    { ...base, host: 'vssps' as const },
    { ...base, project: 'Boards' },
    { ...base, path: '/_apis/build/definitions' },
    { ...base, query: { top: 6, statusFilter: 'inProgress' } },
    { ...base, apiVersion: '7.1-preview' }
  ]) assert.notEqual(mergeKey(other), mergeKey(base), JSON.stringify(other))

  assert.notEqual(mergeKey(post(WIQL, { query: 'a' })), null)
  assert.notEqual(mergeKey(post(WIQL, { query: 'a' })), mergeKey(post(WIQL, { query: 'b' })))
  assert.notEqual(mergeKey(post(BATCH, { ids: [1] })), null)
  assert.equal(mergeKey(post('/_apis/wit/workitems/$Task', [])), null)
  for (const method of ['PATCH', 'PUT', 'DELETE'] as const) assert.equal(mergeKey({ ...get(WIQL), method }), null)
})

test('a lone mergeable request runs on its own controller and aborts when its caller does', async () => {
  const { inner, governor } = setup()
  const caller = new AbortController()
  const pending = governor.json(get('/_apis/projects', { signal: caller.signal }))
  await drain()
  const own = inner.calls[0].req.signal ?? assert.fail('the shared request has no signal')
  assert.notEqual(own, caller.signal)
  assert.equal(own.aborted, false)

  const reason = new Error('the panel closed')
  caller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(own.aborted, true)
})

test('a caller that aborts leaves the shared request running for the others', async () => {
  const { inner, governor } = setup()
  const first = new AbortController()
  const second = new AbortController()
  const a = governor.json(get('/_apis/projects', { signal: first.signal }))
  const b = governor.json(get('/_apis/projects', { signal: second.signal }))
  await drain()
  const own = inner.calls[0].req.signal ?? assert.fail('the shared request has no signal')

  const firstReason = new Error('first closed')
  first.abort(firstReason)
  await assert.rejects(a, error => error === firstReason)
  assert.equal(own.aborted, false, 'the second caller still wants it')

  const secondReason = new Error('second closed')
  second.abort(secondReason)
  await assert.rejects(b, error => error === secondReason)
  assert.equal(own.aborted, true)

  void governor.json(get('/_apis/projects'))
  await drain()
  assert.equal(inner.calls.length, 2, 'a new caller does not join the abandoned request')
})

test('an aborted queued request leaves the queue and is never sent', async () => {
  const { inner, governor } = setup()
  fill(governor)
  const caller = new AbortController()
  const queued = governor.json({ ...get('/_apis/wit/workitems/9'), method: 'PATCH', body: [], signal: caller.signal })
  await drain()
  assert.equal(inner.calls.length, MAX_IN_FLIGHT)

  const reason = new Error('gave up')
  caller.abort(reason)
  await assert.rejects(queued, error => error === reason)

  inner.calls[0].answer()
  await drain()
  assert.equal(inner.calls.length, MAX_IN_FLIGHT)
})

test('no more than 6 requests run at once for an org, and other orgs are not held back', async () => {
  const { inner, governor } = setup()
  fill(governor, 8)
  await drain()
  assert.equal(inner.calls.length, 6)

  void governor.json(get('/_apis/projects', { org: 'fabrikam' }))
  void governor.json(get('/_apis/teams', { org: 'fabrikam' }))
  await drain()
  assert.equal(inner.calls.filter(call => call.req.org === 'fabrikam').length, 2)

  inner.calls[0].answer()
  await drain()
  assert.deepEqual(paths(inner.calls.slice(8)), ['/_apis/user/6'])
})

test('background requests take at most 4, 3, 2 and 1 slots as pressure rises, leaving the rest for user requests', async () => {
  const expected: [PressureLevel, number][] = [['normal', 4], ['near', 3], ['tight', 2], ['delayed', 1]]
  for (const [level, slots] of expected) {
    assert.equal(BACKGROUND_SLOTS[level], slots)
    const { inner, governor } = setup(level)
    for (let n = 0; n < MAX_IN_FLIGHT; n += 1) {
      void inLane('prs', n % 2 === 0 ? 'visible' : 'hidden', () => governor.json(get(`/_apis/background/${n}`)))
    }
    await drain()
    assert.equal(inner.calls.length, slots, level)

    fill(governor, MAX_IN_FLIGHT)
    await drain()
    const user = inner.calls.filter(call => call.priority === 'user').length
    assert.deepEqual({ level, background: inner.calls.length - user, user }, { level, background: slots, user: MAX_IN_FLIGHT - slots })
  }
})

test('queued requests start user first, then visible, then hidden', async () => {
  const { inner, governor } = setup()
  fill(governor)
  void inLane('pipelines', 'hidden', () => governor.json(get('/hidden/1')))
  void inLane('board', 'visible', () => governor.json(get('/visible/1')))
  void inLane('work', 'user', () => governor.json(get('/user/1')))
  void inLane('pipelines', 'hidden', () => governor.json(get('/hidden/2')))
  void inLane('board', 'visible', () => governor.json(get('/visible/2')))
  void inLane('work', 'user', () => governor.json(get('/user/2')))
  await drain()

  for (let n = 0; n < MAX_IN_FLIGHT; n += 1) {
    inner.calls[n].answer()
    await drain()
  }
  assert.deepEqual(paths(inner.calls.slice(MAX_IN_FLIGHT)), ['/user/1', '/user/2', '/visible/1', '/visible/2', '/hidden/1', '/hidden/2'])
})

test('each queued request is sent in its own context, not the one that freed its slot', async () => {
  const { inner, governor } = setup()
  fill(governor, MAX_IN_FLIGHT, 'prs')
  void inLane('board', 'hidden', () => governor.json(get('/_apis/work/boards')))
  await drain()

  inLane('prs', 'user', () => inner.calls[0].answer())
  await drain()
  const sent = inner.calls[MAX_IN_FLIGHT] ?? assert.fail('the board request was not sent')
  assert.deepEqual({ feature: sent.feature, priority: sent.priority }, { feature: 'board', priority: 'hidden' })
})

test('while blocked, user requests are still sent first and background requests wait without holding a slot', async () => {
  const { clock, inner, governor } = blockedFor(30)
  void inLane('pipelines', 'hidden', () => governor.json(get('/_apis/build/builds')))
  await drain()
  assert.equal(inner.calls.length, 0)

  fill(governor)
  await drain()
  assert.equal(inner.calls.length, MAX_IN_FLIGHT, 'every user request is sent')
  assert.ok(inner.calls.every(call => call.priority === 'user'))

  for (const call of inner.calls) call.answer()
  await clock.tick(29_000)
  assert.equal(inner.calls.length, MAX_IN_FLIGHT, 'the background request waits out Retry-After')

  await clock.tick(1_000)
  assert.deepEqual(paths(inner.calls.slice(MAX_IN_FLIGHT)), ['/_apis/build/builds'])
  assert.equal(inner.calls[MAX_IN_FLIGHT].priority, 'hidden')
})

test('a held request that is aborted leaves at once', async () => {
  const { clock, inner, governor } = blockedFor(30)
  const caller = new AbortController()
  const held = inLane('pipelines', 'hidden', () => governor.json({ ...get('/_apis/wit/workitems/3'), method: 'PATCH', body: [], signal: caller.signal }))
  const outcome = caught(held)
  await drain()

  const reason = new Error('stopped')
  caller.abort(reason)
  await drain()
  assert.deepEqual(outcome, { settled: true, error: reason })

  await clock.tick(60_000)
  assert.equal(inner.calls.length, 0)
})

test('raising a lane releases its held requests and moves its queued ones to the front', async () => {
  const blocked = blockedFor(30)
  const heldLane = inLane('pipelines', 'hidden', () => {
    void blocked.governor.json(get('/_apis/build/builds'))
    return currentContext().lane
  })
  await drain()
  assert.equal(blocked.inner.calls.length, 0)
  raise(heldLane)
  await drain()
  assert.deepEqual(paths(blocked.inner.calls), ['/_apis/build/builds'])
  assert.equal(blocked.inner.calls[0].priority, 'user')

  const { inner, governor } = setup()
  fill(governor)
  void inLane('board', 'visible', () => governor.json(get('/visible/1')))
  const queuedLane = inLane('pipelines', 'hidden', () => {
    void governor.json(get('/hidden/1'))
    return currentContext().lane
  })
  await drain()
  raise(queuedLane)
  inner.calls[0].answer()
  await drain()
  assert.deepEqual(paths(inner.calls.slice(MAX_IN_FLIGHT)), ['/hidden/1'])
})

test('a user joining a held shared request raises it and it is sent at once', async () => {
  const { inner, governor } = blockedFor(30)
  const background = inLane('board', 'hidden', () => governor.json(get('/_apis/work/boards')))
  await drain()
  assert.equal(inner.calls.length, 0)

  const user = inLane('board', 'user', () => governor.json(get('/_apis/work/boards')))
  await drain()
  assert.equal(inner.calls.length, 1)
  inner.calls[0].answer({ value: [] })
  const [a, b] = await Promise.all([background, user])
  assert.equal(a.data, b.data)
})

test('errors pass through unchanged, including unauthorized', async () => {
  const { inner, governor } = setup()
  const shared = [governor.json(get('/_apis/projects')), governor.json(get('/_apis/projects'))]
  const write = governor.json({ ...get('/_apis/wit/workitems/1'), method: 'PATCH', body: [] })
  await drain()

  const expired = new AdoError('unauthorized', 401, 'Azure DevOps rejected the credentials.')
  const conflict = new AdoError('conflict', 409, 'Azure DevOps reported a conflict with the current state.')
  inner.calls[0].fail(expired)
  inner.calls[1].fail(conflict)
  for (const pending of shared) await assert.rejects(pending, error => error === expired)
  await assert.rejects(write, error => error === conflict)
})
