import { assert, test } from 'orca/testing'
import type { BoardConfig } from '../../src/shared/work'
import { byteLength } from '../budget'
import { createEntities } from './entities'
import { VALUE_BUDGET_BYTES } from './persist'
import { prKey, type CheckRecord, type PrRecord } from './records'
import { MAX_SAVED_PRS, metaOf, prRecordsOf, seedMeta, seedPrRecords } from './saved-tables'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const HOUR = 3_600_000
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
