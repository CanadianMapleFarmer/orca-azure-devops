import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import type { BoardConfig } from '../../src/shared/work'
import { byteLength } from '../budget'
import { drain, fakeClock, memoryCache } from '../test-support'
import { createEntities } from './entities'
import { cacheKey, createPersisted, VALUE_BUDGET_BYTES, type Saved } from './persist'
import { prKey, type CheckRecord, type PrRecord } from './records'
import { createSavedTables, MAX_SAVED_PRS, metaOf, prRecordsOf, seedMeta, seedPrRecords, type SavedPrRecords } from './saved-tables'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const HOUR = 3_600_000
const MINUTE = 60_000
const ADA = '5e6f7a8b-1111-4c2d-9e3f-4a5b6c7d8e9f'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const REVIEWERS = 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d:10,b2c3d4e5-6666-4b7c-9d8e-0f1a2b3c4d5e:0'
const CHECKS: CheckRecord = { build: 'succeeded', policies: 'approved', commit: 'c0ffee', reviewers: REVIEWERS }

function record(prId: number, status: PrRecord['status'] = 'completed'): PrRecord {
  return {
    projectId: PROJECT,
    repoId: REPO,
    prId,
    status,
    target: 'main',
    sourceCommit: '3f786850e387550fdab836ed7e6dc881de23001b',
    reviewers: REVIEWERS,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${prId}`
  }
}

function tablesAt(now: number) {
  return createEntities(() => now).of('contoso')
}

test('PR records keep the newest that fit in 160 KiB, at most 600, each with its checks', () => {
  const tables = tablesAt(T0)
  for (let prId = 1; prId <= 700; prId++) tables.prs.put(prKey(record(prId)), record(prId), T0 + prId)
  tables.prChecks.put(prKey(record(700)), CHECKS, T0 + 701)

  const saved = prRecordsOf(tables)
  const prs = saved.repos.flatMap(repo => repo.prs)
  assert.ok(byteLength(saved) <= VALUE_BUDGET_BYTES, String(byteLength(saved)))
  assert.ok(prs.length > 400 && prs.length <= MAX_SAVED_PRS, String(prs.length))
  assert.deepEqual(prs.map(pr => pr.prId), Array.from({ length: prs.length }, (_, index) => 700 - index), 'newest first')
  assert.deepEqual(prs[0].checks, { value: CHECKS, at: T0 + 701 })
  assert.equal(prs[1].checks, undefined)

  const small = tablesAt(T0)
  for (let prId = 1; prId <= 700; prId++) small.prs.put(`p/r/${prId}`, { ...record(prId), projectId: 'p', repoId: 'r', reviewers: '', url: '' }, T0 + prId)
  assert.equal(prRecordsOf(small).repos[0].prs.length, MAX_SAVED_PRS)
})

test('saved pull request records leave out titles', () => {
  const tables = tablesAt(T0)
  tables.prs.put(prKey(record(321)), { ...record(321), title: 'Add vehicle search filters' })
  const saved = prRecordsOf(tables)
  assert.equal('title' in saved.repos[0].prs[0], false)
  assert.equal(tables.prs.get(prKey(record(321)))?.value.title, 'Add vehicle search filters')

  const restored = tablesAt(T0)
  seedPrRecords(restored, saved)
  assert.deepEqual(restored.prs.get(prKey(record(321)))?.value, record(321))
})

test('seeding restores the tables with their original age and never replaces a newer entry', () => {
  const before = tablesAt(T0)
  const config = { boardId: 'b1', boardName: 'Stories' } as BoardConfig
  before.boardConfigs.put('contoso/p/t/b1', config, T0 - HOUR)
  before.typeStates.put('p/Task', [{ name: 'Active', category: 'InProgress' }], T0 - 2 * HOUR)
  before.projects.put('all', [{ id: 'p', name: 'Web' }], T0 - 3 * HOUR)
  before.prs.put(prKey(record(1)), record(1), T0 - HOUR)
  before.prs.put(prKey(record(2, 'active')), record(2, 'active'), T0 - HOUR)
  before.prChecks.put(prKey(record(2)), CHECKS, T0 - HOUR)
  const meta = JSON.parse(JSON.stringify(metaOf(before)))
  const records = JSON.parse(JSON.stringify(prRecordsOf(before)))

  const after = tablesAt(T0 + HOUR)
  after.prs.put(prKey(record(2)), record(2, 'completed'), T0)
  seedMeta(after, meta)
  seedPrRecords(after, records)

  assert.deepEqual(after.boardConfigs.get('contoso/p/t/b1'), { value: config, at: T0 - HOUR })
  assert.deepEqual(after.typeStates.get('p/Task'), { value: [{ name: 'Active', category: 'InProgress' }], at: T0 - 2 * HOUR })
  assert.deepEqual(after.projects.get('all'), { value: [{ id: 'p', name: 'Web' }], at: T0 - 3 * HOUR })
  assert.deepEqual(after.prs.get(prKey(record(1))), { value: record(1), at: T0 - HOUR })
  assert.deepEqual(after.prs.get(prKey(record(2))), { value: record(2, 'completed'), at: T0 }, 'a newer entry stays')
  assert.deepEqual(after.prChecks.get(prKey(record(2))), { value: CHECKS, at: T0 - HOUR })

  const untouched = tablesAt(T0)
  seedMeta(untouched, { configs: 'none', states: [['k', null, 1]], projects: [[1, [], 2]] })
  seedPrRecords(untouched, { repos: [{ projectId: PROJECT }, { projectId: PROJECT, repoId: REPO, prs: [{ prId: 'x' }] }] })
  assert.deepEqual([untouched.typeStates.entries(), untouched.projects.entries(), untouched.prs.entries()], [[], [], []])
})

test("meta and PR records whose rows changed only their age are written again only once their saved copy is 15 minutes old, and on flush", async () => {
  const clock = fakeClock(T0)
  const cache = memoryCache()
  const entities = createEntities(clock.now)
  const connected: OrgStatus = {
    org: 'contoso',
    url: 'https://dev.azure.com/contoso',
    method: 'pat',
    state: 'connected',
    account: { adoId: ADA, uniqueName: 'dev@contoso.example', displayName: 'Dev', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
  const persisted = createPersisted({ port: cache.port, orgs: async () => [connected], now: clock.now, clock, log: () => {} })
  const saved = createSavedTables(entities, persisted)
  const tables = entities.of('contoso')
  const keys = [cacheKey('contoso', 'meta'), cacheKey('contoso', 'pr-records')]
  const writes = () => keys.map(key => cache.writes.filter(written => written === key).length)
  const reread = async (minute: number) => {
    const [older, newer] = minute % 2 === 0 ? [1, 2] : [2, 1]
    tables.projects.put('all', [{ id: 'p', name: 'Web' }])
    tables.prs.put(prKey(record(older)), record(older), clock.now() - 1)
    tables.prs.put(prKey(record(newer)), record(newer))
    tables.prChecks.put(prKey(record(1)), CHECKS)
    await drain()
    saved.save('contoso', ADA)
  }
  const written: number[][] = [[], []]
  for (let minute = 0; minute <= 30; minute += 1) {
    const before = writes()
    await reread(minute)
    await clock.tick(0)
    writes().forEach((count, index) => count > before[index] && written[index].push(minute))
    await clock.tick(MINUTE)
  }
  assert.deepEqual(written, [[0, 15, 30], [0, 15, 30]])

  await reread(31)
  await persisted.flush()
  assert.deepEqual(writes(), [4, 4])
  const prs = (cache.data[keys[1]] as Saved<SavedPrRecords>).value.repos[0].prs
  assert.deepEqual(
    prs.map(pr => [pr.prId, pr.at, pr.checks?.at]),
    [
      [1, T0 + 31 * MINUTE, T0 + 31 * MINUTE],
      [2, T0 + 31 * MINUTE - 1, undefined]
    ]
  )
})
