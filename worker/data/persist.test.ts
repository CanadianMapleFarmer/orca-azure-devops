import { assert, test } from 'orca/testing'
import type { OrgState, OrgStatus } from '../../src/shared/types'
import { fakeClock, memoryCache } from '../test-support'
import { cacheKey, createPersisted, TOTAL_BUDGET_BYTES, VALUE_BUDGET_BYTES, WRITE_EVERY_MS } from './persist'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const ADA = '5e6f7a8b-1111-4c2d-9e3f-4a5b6c7d8e9f'
const GRACE = '6f7a8b9c-2222-4d3e-8f4a-5b6c7d8e9f0a'
const INDEX = 'adoCache:v1:index'
const WORK = 'adoCache:v1:contoso:work'
const BIG = 150 * 1024

function status(org: string, adoId: string | null, state: OrgState = 'connected'): OrgStatus {
  return {
    org,
    url: `https://dev.azure.com/${org}`,
    method: 'pat',
    state,
    account: adoId ? { adoId, uniqueName: `dev@${org}.example`, displayName: 'Dev', tenantId: null, objectId: null } : null,
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

function setup(initial: Record<string, unknown> = {}) {
  const clock = fakeClock(T0)
  const cache = memoryCache(initial)
  const logs: string[] = []
  let orgs = [status('contoso', ADA), status('fabrikam', ADA)]
  const persisted = createPersisted({ port: cache.port, orgs: async () => orgs, now: clock.now, clock, log: message => logs.push(message) })
  return {
    clock,
    cache,
    logs,
    persisted,
    setOrgs(next: OrgStatus[]) {
      orgs = next
    }
  }
}

function cacheKeys(data: Record<string, unknown>): string[] {
  return Object.keys(data).filter(key => key.startsWith('adoCache:') && key !== INDEX).sort()
}

function totalBytes(data: Record<string, unknown>): number {
  return Object.entries(data)
    .filter(([key]) => key.startsWith('adoCache:'))
    .reduce((sum, [, value]) => sum + Buffer.byteLength(JSON.stringify(value)), 0)
}

test('cache keys are versioned and name the org', () => {
  assert.equal(cacheKey('contoso', 'board:t1:b1'), 'adoCache:v1:contoso:board:t1:b1')
})

test('a saved view comes back for the same account and not for another', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { items: [1, 2] })
  await s.clock.tick(0)

  assert.deepEqual(await s.persisted.load('contoso', 'work', ADA), { account: ADA, savedAt: T0, value: { items: [1, 2] } })
  assert.equal(await s.persisted.load('contoso', 'work', GRACE), null)
  assert.equal(await s.persisted.load('fabrikam', 'work', ADA), null)

  const restarted = createPersisted({ port: s.cache.port, orgs: async () => [], now: s.clock.now, clock: s.clock, log: () => {} })
  assert.deepEqual((await restarted.load('contoso', 'work', ADA))?.value, { items: [1, 2] })
  assert.equal(await restarted.load('contoso', 'work', GRACE), null)
})

test('writes, including the index, are debounced to one per key per minute and skipped when unchanged', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  await s.clock.tick(0)
  assert.deepEqual(s.cache.writes, [WORK, INDEX])

  s.persisted.save('contoso', 'work', ADA, { n: 2 })
  await s.clock.tick(30_000)
  s.persisted.save('contoso', 'work', ADA, { n: 3 })
  await s.clock.tick(WRITE_EVERY_MS - 30_000 - 1_000)
  assert.deepEqual(s.cache.writes, [WORK, INDEX], 'nothing more within the minute')

  await s.clock.tick(1_000)
  assert.deepEqual(s.cache.writes, [WORK, INDEX, WORK, INDEX], 'the latest value, once')
  assert.deepEqual((s.cache.data[WORK] as { value: unknown }).value, { n: 3 })

  s.persisted.save('contoso', 'work', ADA, { n: 3 })
  await s.clock.tick(5 * MINUTE)
  assert.equal(s.cache.writes.length, 4, 'an unchanged value is not written again')

  s.persisted.save('contoso', 'work', GRACE, { n: 3 })
  s.setOrgs([status('contoso', GRACE)])
  await s.clock.tick(0)
  assert.equal(s.cache.writes.length, 6, 'the same value for another account is a change')
})

test('a pending write is dropped when its org is no longer connected or its account changed', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  s.persisted.save('fabrikam', 'work', ADA, { n: 1 })
  s.setOrgs([status('contoso', ADA, 'expired')])
  await s.clock.tick(0)
  assert.deepEqual(cacheKeys(s.cache.data), [], 'an expired org and a removed one')

  s.persisted.save('contoso', 'meta', ADA, { n: 1 })
  s.setOrgs([status('contoso', GRACE)])
  await s.clock.tick(0)
  assert.deepEqual(cacheKeys(s.cache.data), [], 'another account')

  s.setOrgs([status('contoso', ADA)])
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  await s.clock.tick(WRITE_EVERY_MS)
  assert.deepEqual(cacheKeys(s.cache.data), [WORK])
})

test('a value over 160 KiB is not written and is logged', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { text: 'x'.repeat(VALUE_BUDGET_BYTES) })
  s.persisted.save('contoso', 'meta', ADA, { text: 'x'.repeat(VALUE_BUDGET_BYTES - 20) })
  await s.clock.tick(0)

  assert.deepEqual(cacheKeys(s.cache.data), ['adoCache:v1:contoso:meta'])
  assert.equal(s.logs.length, 1)
  assert.match(s.logs[0], /adoCache:v1:contoso:work/)

  s.persisted.save('contoso', 'work', ADA, { text: 'x'.repeat(VALUE_BUDGET_BYTES) })
  await s.clock.tick(2 * MINUTE)
  assert.equal(s.logs.length, 1, 'the same oversized value is not logged again')
})

test('saving past 1.5 MiB evicts the least recently used entries first', async () => {
  const s = setup()
  const names = Array.from({ length: 10 }, (_, index) => `view${index}`)
  for (const name of names) {
    s.persisted.save('contoso', name, ADA, { text: 'x'.repeat(BIG) })
    await s.clock.tick(1_000)
  }
  assert.equal(cacheKeys(s.cache.data).length, 10)
  assert.ok(await s.persisted.load('contoso', 'view0', ADA), 'view0 is used again, so view1 is now the oldest')

  s.persisted.save('fabrikam', 'work', ADA, { text: 'x'.repeat(BIG) })
  await s.clock.tick(1_000)

  const left = cacheKeys(s.cache.data)
  assert.ok(left.includes(cacheKey('fabrikam', 'work')))
  assert.ok(left.includes(cacheKey('contoso', 'view0')))
  assert.ok(!left.includes(cacheKey('contoso', 'view1')))
  assert.ok(totalBytes(s.cache.data) <= TOTAL_BUDGET_BYTES, String(totalBytes(s.cache.data)))
  await s.persisted.flush()
  assert.deepEqual(Object.keys(s.cache.data[INDEX] as object).sort(), left)
})

test('entries the index does not know count toward the budget and go first', async () => {
  const orphans = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [cacheKey('contoso', `old${index}`), { account: ADA, savedAt: T0, value: 'x'.repeat(BIG) }]))
  const s = setup(orphans)
  s.persisted.save('contoso', 'work', ADA, { text: 'x'.repeat(BIG) })
  await s.clock.tick(0)

  assert.ok(cacheKeys(s.cache.data).includes(WORK))
  assert.equal(cacheKeys(s.cache.data).length, 10)
  assert.ok(totalBytes(s.cache.data) <= TOTAL_BUDGET_BYTES)
})

test('at most 3 boards are kept per org', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  s.persisted.save('fabrikam', 'board:t1:b1', ADA, { n: 1 })
  for (const board of ['b1', 'b2', 'b3', 'b4']) {
    await s.clock.tick(1_000)
    s.persisted.save('contoso', `board:t1:${board}`, ADA, { board })
  }
  await s.clock.tick(1_000)

  assert.deepEqual(cacheKeys(s.cache.data), [
    'adoCache:v1:contoso:board:t1:b2',
    'adoCache:v1:contoso:board:t1:b3',
    'adoCache:v1:contoso:board:t1:b4',
    WORK,
    'adoCache:v1:fabrikam:board:t1:b1'
  ])
})

test('sweep deletes keys from other cache versions and leaves other plugin data alone', async () => {
  const s = setup({
    orgs: [{ org: 'contoso' }],
    'adoCache:v0:contoso:work': { account: ADA, savedAt: T0, value: {} },
    [WORK]: { account: ADA, savedAt: T0, value: {} }
  })
  await s.persisted.sweep()
  assert.deepEqual(Object.keys(s.cache.data).sort(), [WORK, 'orgs'])
})

test('forget cancels pending writes and deletes every key of that org', async () => {
  const s = setup({ [cacheKey('contoso', 'meta')]: { account: ADA, savedAt: T0, value: {} } })
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  s.persisted.save('contoso', 'board:t1:b1', ADA, { n: 1 })
  s.persisted.save('fabrikam', 'work', ADA, { n: 1 })
  await s.clock.tick(0)
  s.persisted.save('contoso', 'work', ADA, { n: 2 })

  await s.persisted.forget('contoso')
  await s.clock.tick(5 * MINUTE)

  assert.deepEqual(cacheKeys(s.cache.data), ['adoCache:v1:fabrikam:work'])
  assert.deepEqual(Object.keys(s.cache.data[INDEX] as object), ['adoCache:v1:fabrikam:work'])
})

test('flush writes pending values at once', async () => {
  const s = setup()
  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  await s.clock.tick(0)
  s.persisted.save('contoso', 'work', ADA, { n: 2 })
  s.persisted.save('fabrikam', 'work', ADA, { n: 1 })

  await s.persisted.flush()

  assert.deepEqual((s.cache.data[WORK] as { value: unknown }).value, { n: 2 })
  assert.deepEqual(Object.keys(s.cache.data[INDEX] as object).sort(), [WORK, 'adoCache:v1:fabrikam:work'])
  assert.equal(s.clock.pending(), 0, 'no write is left waiting')
})

test('a wrongly shaped saved value is ignored', async () => {
  const s = setup({
    [INDEX]: 'not an index',
    [WORK]: { items: [1] },
    [cacheKey('contoso', 'meta')]: { account: ADA, savedAt: 'yesterday', value: {} },
    [cacheKey('contoso', 'prs')]: { account: ADA, savedAt: T0 },
    [cacheKey('contoso', 'runs')]: 'text'
  })
  for (const name of ['work', 'meta', 'prs', 'runs']) assert.equal(await s.persisted.load('contoso', name, ADA), null, name)

  s.persisted.save('contoso', 'work', ADA, { n: 1 })
  await s.clock.tick(0)
  assert.deepEqual((await s.persisted.load('contoso', 'work', ADA))?.value, { n: 1 })
})
