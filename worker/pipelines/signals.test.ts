import { assert, test } from 'orca/testing'
import type { RunSummary } from '../../src/shared/pipelines'
import type { CountKind } from '../status-bar'
import type { Notifier } from './notify'
import { createRunSignals } from './signals'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const HOUR = 60 * 60_000
const ALEX = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'

function run(buildId: number, over: Partial<RunSummary> = {}): RunSummary {
  return {
    org: 'contoso',
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    projectName: 'Fabrikam Web',
    buildId,
    pipeline: { id: 8, name: 'web-app-ci' },
    runNumber: `20261105.${buildId}`,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=${buildId}`,
    branch: 'develop',
    prId: null,
    reason: 'individualCI',
    repository: null,
    requestedFor: { id: ALEX, name: 'Alex Contoso' },
    state: 'succeeded',
    queuedAt: NOW - 2 * HOUR,
    startedAt: null,
    finishedAt: null,
    stages: null,
    approvals: [],
    mine: true,
    watched: false,
    ...over
  }
}

function recorders() {
  const counts: [string, CountKind, number | null][] = []
  const observed: [string, readonly RunSummary[]][] = []
  const bar = { setCount: (org: string, kind: CountKind, count: number | null) => void counts.push([org, kind, count]) }
  const notifier: Notifier = { observe: (org, runs) => void observed.push([org, runs]) }
  return { counts, observed, signals: createRunSignals({ bar, notifier, now: () => NOW }) }
}

test('update sets both counts and observes; null clears them', () => {
  const { counts, observed, signals } = recorders()
  const runs = [
    run(1, { state: 'failed', finishedAt: NOW - HOUR }),
    run(2, { state: 'failed', finishedAt: NOW - 30 * HOUR }),
    run(3, { state: 'waiting', approvals: [{ projectId: 'p', buildId: 3, approvalId: 'a3', stage: null, environment: 'production', approvers: [], minRequired: 1, instructions: '', createdAt: NOW, canApprove: true }] })
  ]
  signals.update('contoso', runs)
  assert.deepEqual(counts, [
    ['contoso', 'failedRuns', 1],
    ['contoso', 'approvals', 1]
  ])
  assert.deepEqual(observed, [['contoso', runs]])

  signals.update('contoso', [])
  assert.deepEqual(counts.slice(2), [
    ['contoso', 'failedRuns', 0],
    ['contoso', 'approvals', 0]
  ])
  assert.equal(observed.length, 2)

  signals.update('fabrikam', null)
  assert.deepEqual(counts.slice(4), [
    ['fabrikam', 'failedRuns', null],
    ['fabrikam', 'approvals', null]
  ])
  assert.equal(observed.length, 2)
})
