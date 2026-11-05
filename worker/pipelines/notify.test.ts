import { assert, hostError, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApprovalSummary, RunState, RunSummary, StageChip } from '../../src/shared/pipelines'
import { drain, withWorker } from '../test-support'
import { createNotifier, MAX_NOTIFICATIONS_PER_UPDATE, notificationsFor, type Notifier } from './notify'
import type { NotifyPrefs } from './settings'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SINCE = NOW
const ALEX = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const NOTIFY_FAILED = "Couldn't show a desktop notification."
const MORE_BODY = 'Open the Pipelines tab in the Azure DevOps panel to see them.'
const ALL_ON: NotifyPrefs = { failures: true, approvals: true, watched: true }

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
    queuedAt: NOW - HOUR,
    startedAt: NOW - HOUR,
    finishedAt: null,
    stages: null,
    approvals: [],
    mine: true,
    watched: false,
    ...over
  }
}

function failed(buildId: number, over: Partial<RunSummary> = {}): RunSummary {
  return run(buildId, { state: 'failed', finishedAt: SINCE + buildId * MINUTE, ...over })
}

function finished(buildId: number, state: RunState, over: Partial<RunSummary> = {}): RunSummary {
  return run(buildId, { state, finishedAt: SINCE + buildId * MINUTE, mine: false, watched: true, ...over })
}

function waiting(buildId: number, approvals: ApprovalSummary[], over: Partial<RunSummary> = {}): RunSummary {
  return run(buildId, { state: 'waiting', branch: 'main', pipeline: { id: 9, name: 'web-app-cd' }, finishedAt: null, approvals, ...over })
}

function approval(approvalId: string, buildId: number, over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    buildId,
    approvalId,
    stage: 'Deploy production',
    environment: 'production',
    approvers: [{ id: ALEX, name: 'Alex Contoso', uniqueName: 'alex@contoso.example', isGroup: false }],
    minRequired: 1,
    instructions: '',
    createdAt: SINCE + MINUTE,
    canApprove: false,
    ...over
  }
}

function chips(...states: [string, StageChip['state']][]): StageChip[] {
  return states.map(([name, state], index) => ({ id: `stage-${index}`, name, state }))
}

interface Harness {
  notifier: Notifier
  prefs: NotifyPrefs
  shown(): { title: string; body: string }[]
  logs(): readonly string[]
}

async function withNotifier(options: { reject?: boolean }, body: (h: Harness) => Promise<void>): Promise<void> {
  const host = mockHost({
    results: {
      'notifications.show': () => {
        if (options.reject) throw hostError('action_failed', 'secret-detail')
        return { delivered: true }
      }
    }
  })
  const prefs: NotifyPrefs = { ...ALL_ON }
  const made: { notifier?: Notifier } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      made.notifier = createNotifier({
        show: n => orca.host.call('notifications.show', n),
        prefs: () => prefs,
        since: SINCE,
        log: message => orca.log(message)
      })
    }
  }
  await withWorker(module, { host }, async w => {
    const harness: Harness = {
      notifier: made.notifier as Notifier,
      prefs,
      shown: () => host.callsOf('notifications.show') as { title: string; body: string }[],
      logs: () => w.logs
    }
    await body(harness)
    assert.equal(w.refusals.length, 0)
  })
}

async function observe(h: Harness, runs: RunSummary[], org = 'contoso'): Promise<{ title: string; body: string }[]> {
  const before = h.shown().length
  h.notifier.observe(org, runs)
  await drain()
  return h.shown().slice(before)
}

test('notifications fire once per finish, cap at three plus a summary, and skip what happened before activation', async () => {
  await withNotifier({}, async h => {
    const five = [1, 2, 3, 4, 5].map(id => failed(id))
    const first = await observe(h, five)
    assert.equal(MAX_NOTIFICATIONS_PER_UPDATE, 3)
    assert.deepEqual(first, [
      { title: 'web-app-ci failed', body: 'contoso · 20261105.1 on develop' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.2 on develop' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.3 on develop' },
      { title: '2 more pipeline updates', body: MORE_BODY }
    ])

    assert.deepEqual(await observe(h, five), [])

    const before = failed(6, { finishedAt: SINCE - 1 })
    assert.deepEqual(await observe(h, [...five, before]), [])

    const retried = failed(1, { finishedAt: SINCE + HOUR })
    assert.deepEqual(await observe(h, [retried, ...five.slice(1), before]), [{ title: 'web-app-ci failed', body: 'contoso · 20261105.1 on develop' }])
    assert.deepEqual(await observe(h, [retried]), [])
  })
})

test('exactly three notify without a summary, and every collapsed key counts as notified', async () => {
  await withNotifier({}, async h => {
    const three = [1, 2, 3].map(id => failed(id))
    assert.equal((await observe(h, three)).length, 3)
    const seven = [10, 11, 12, 13, 14, 15, 16].map(id => failed(id))
    const shown = await observe(h, seven)
    assert.deepEqual(shown.map(n => n.title), ['web-app-ci failed', 'web-app-ci failed', 'web-app-ci failed', '4 more pipeline updates'])
    assert.deepEqual(await observe(h, seven), [])
    assert.deepEqual(await observe(h, three), [])
  })
})

test('four failures fold one run into a singular summary', async () => {
  await withNotifier({}, async h => {
    const shown = await observe(h, [1, 2, 3, 4].map(id => failed(id)))
    assert.equal(shown[3]?.title, '1 more pipeline update')
  })
})

test('a failed run says where it failed when its stages are loaded', async () => {
  await withNotifier({}, async h => {
    const stages = chips(['Build', 'succeeded'], ['Image', 'failed'], ['Deploy production', 'failed'])
    const shown = await observe(h, [failed(1, { stages }), failed(2, { stages: chips(['Build', 'succeeded']) }), failed(3, { stages: [] })])
    assert.deepEqual(shown, [
      { title: 'web-app-ci failed', body: 'contoso · 20261105.1 on develop · failed at Image' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.2 on develop' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.3 on develop' }
    ])
  })
})

test('a run that is mine and watched notifies once', async () => {
  await withNotifier({}, async h => {
    const both = failed(1, { mine: true, watched: true })
    assert.deepEqual(await observe(h, [both]), [{ title: 'web-app-ci failed', body: 'contoso · 20261105.1 on develop' }])
    assert.deepEqual(await observe(h, [both]), [])
    assert.deepEqual(await observe(h, [{ ...both, watched: false }]), [])
    assert.deepEqual(await observe(h, [{ ...both, mine: false }]), [])
  })
})

test('a watched run that succeeded notifies its completion', async () => {
  await withNotifier({}, async h => {
    const shown = await observe(h, [
      finished(1, 'succeeded'),
      finished(2, 'warning', { pipeline: { id: 9, name: 'web-app-cd' }, branch: 'main' }),
      finished(3, 'canceled'),
      run(5, { state: 'succeeded', finishedAt: SINCE + 5 * MINUTE, mine: true }),
      finished(6, 'running', { finishedAt: null }),
      finished(7, 'succeeded', { finishedAt: null })
    ])
    assert.deepEqual(shown, [
      { title: 'web-app-ci succeeded', body: 'contoso · 20261105.1 on develop' },
      { title: 'web-app-cd finished with warnings', body: 'contoso · 20261105.2 on main' },
      { title: 'web-app-ci was canceled', body: 'contoso · 20261105.3 on develop' }
    ])
    assert.deepEqual(await observe(h, [finished(4, 'succeeded', { mine: true })]), [{ title: 'web-app-ci succeeded', body: 'contoso · 20261105.4 on develop' }])
  })
})

test('a watched run that finished before activation still notifies, a mine-only one does not', async () => {
  await withNotifier({}, async h => {
    const early = SINCE - 3 * HOUR
    const shown = await observe(h, [
      finished(1, 'succeeded', { finishedAt: early }),
      finished(2, 'failed', { finishedAt: early }),
      failed(3, { finishedAt: early }),
      failed(4, { finishedAt: early, watched: true, mine: true })
    ])
    assert.deepEqual(shown, [
      { title: 'web-app-ci succeeded', body: 'contoso · 20261105.1 on develop' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.2 on develop' },
      { title: 'web-app-ci failed', body: 'contoso · 20261105.4 on develop' }
    ])
    assert.deepEqual(await observe(h, [failed(5, { finishedAt: SINCE - 1 })]), [])
    assert.deepEqual(await observe(h, [failed(6, { finishedAt: SINCE })]), [{ title: 'web-app-ci failed', body: 'contoso · 20261105.6 on develop' }])
  })
})

test('approvals notify only when they need me and say when I can approve', async () => {
  await withNotifier({}, async h => {
    const runs = [
      waiting(1, [approval('a1', 1)]),
      waiting(2, [approval('a2', 2, { canApprove: true })], { mine: false }),
      waiting(3, [approval('a3', 3)], { mine: false }),
      waiting(4, [approval('a4', 4, { createdAt: SINCE - 1, canApprove: true })])
    ]
    assert.deepEqual(await observe(h, runs), [
      { title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.1 on main · waiting at production' },
      { title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.2 on main · waiting at production · You can approve it.' }
    ])
    assert.deepEqual(await observe(h, runs), [])

    const places = await observe(h, [
      waiting(5, [approval('a5', 5, { environment: null })]),
      waiting(6, [approval('a6', 6, { environment: null, stage: null })]),
      waiting(7, [approval('a7', 7)], { state: 'succeeded', finishedAt: SINCE - 1, mine: true }),
      waiting(8, [approval('a9', 8, { createdAt: SINCE })])
    ])
    assert.deepEqual(places, [
      { title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.5 on main · waiting at Deploy production' },
      { title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.6 on main' },
      { title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.8 on main · waiting at production' }
    ])

    const second = await observe(h, [waiting(1, [approval('a1', 1), approval('a8', 1, { stage: 'Deploy staging', environment: 'staging' })])])
    assert.deepEqual(second, [{ title: 'web-app-cd is waiting for approval', body: 'contoso · 20261105.1 on main · waiting at staging' }])
  })
})

test('each toggle turns its kind off', async () => {
  await withNotifier({}, async h => {
    const mine = (id: number) => failed(id)
    const watchedOnly = (id: number) => finished(id, 'failed')
    const succeeded = (id: number) => finished(id, 'succeeded')
    const needsMe = (id: number) => waiting(id, [approval(`a${id}`, id)])
    const everything = (from: number) => [mine(from), watchedOnly(from + 1), succeeded(from + 2), needsMe(from + 3)]

    h.prefs.failures = false
    h.prefs.approvals = false
    h.prefs.watched = false
    assert.deepEqual(await observe(h, everything(10)), [])

    h.prefs.failures = true
    assert.deepEqual((await observe(h, everything(20))).map(n => n.body), ['contoso · 20261105.20 on develop'])

    h.prefs.failures = false
    h.prefs.watched = true
    assert.deepEqual((await observe(h, everything(30))).map(n => n.body), ['contoso · 20261105.31 on develop', 'contoso · 20261105.32 on develop'])

    h.prefs.watched = false
    h.prefs.approvals = true
    assert.deepEqual((await observe(h, everything(40))).map(n => n.body), ['contoso · 20261105.43 on main · waiting at production'])

    assert.deepEqual(await observe(h, [failed(50, { mine: true, watched: true })]), [])
    h.prefs.failures = true
    assert.deepEqual((await observe(h, [failed(51, { mine: true, watched: true })])).length, 1)
    h.prefs.failures = false
    h.prefs.watched = true
    assert.deepEqual((await observe(h, [failed(52, { mine: true, watched: true })])).length, 1)
  })
})

test('long titles and bodies are cut', async () => {
  await withNotifier({}, async h => {
    const pipeline = { id: 8, name: `web-app-${'x'.repeat(300)}` }
    const branch = `feature/${'y'.repeat(2000)}`
    const shown = await observe(h, [failed(1, { pipeline, branch }), waiting(2, [approval('a2', 2, { environment: 'z'.repeat(2000) })], { pipeline })])
    assert.equal(shown.length, 2)
    for (const note of shown) {
      assert.equal(note.title.length, 120)
      assert.ok(note.title.startsWith('web-app-xxx') && note.title.endsWith('…'))
      assert.equal(note.body.length, 1000)
      assert.ok(note.body.endsWith('…'))
    }
    const short = await observe(h, [failed(3)])
    assert.ok(!short[0].title.endsWith('…') && !short[0].body.endsWith('…'))
  })
})

test('a failed show logs once and is not retried', async () => {
  await withNotifier({ reject: true }, async h => {
    const runs = [1, 2, 3, 4, 5].map(id => failed(id))
    assert.equal((await observe(h, runs)).length, 4)
    assert.deepEqual(h.logs(), [NOTIFY_FAILED])
    assert.ok(!JSON.stringify(h.logs()).includes('secret-detail'))

    assert.deepEqual(await observe(h, runs), [])
    assert.equal(h.shown().length, 4)
    assert.deepEqual(h.logs(), [NOTIFY_FAILED])

    assert.equal((await observe(h, [failed(6)])).length, 1)
    assert.deepEqual(h.logs(), [NOTIFY_FAILED, NOTIFY_FAILED])
  })
})

test('a show that throws is logged, not thrown, and shows are not awaited in turn', async () => {
  const logs: string[] = []
  const started: string[] = []
  const release: (() => void)[] = []
  const notifier = createNotifier({
    show: n => {
      started.push(n.body)
      if (n.body.includes('.1 ')) throw new Error('boom')
      return new Promise<void>(resolve => release.push(resolve))
    },
    prefs: () => ALL_ON,
    since: SINCE,
    log: message => logs.push(message)
  })
  notifier.observe('contoso', [failed(1), failed(2), failed(3)])
  assert.equal(started.length, 3)
  await drain()
  assert.deepEqual(logs, [])
  for (const resolve of release) resolve()
  await drain()
  assert.deepEqual(logs, [NOTIFY_FAILED])
})

test('the notified set holds the newest 500 keys', async () => {
  await withNotifier({}, async h => {
    const oldest = failed(1)
    assert.equal((await observe(h, [oldest])).length, 1)
    for (let from = 2; from <= 500; from += 100) {
      const batch = Array.from({ length: Math.min(100, 500 - from + 1) }, (_, index) => failed(from + index))
      await observe(h, batch)
    }
    assert.deepEqual(await observe(h, [oldest]), [], '1 + 499 others keeps the oldest')
    assert.equal((await observe(h, [failed(501)])).length, 1)
    assert.equal((await observe(h, [oldest])).length, 1, 'the 501st key pushed the oldest out')
    assert.deepEqual(await observe(h, [failed(501)]), [])
  })
})

test('notificationsFor is pure and lists every candidate not yet notified', () => {
  const runs = [1, 2, 3, 4, 5].map(id => failed(id))
  const input = { org: 'contoso', runs, prefs: ALL_ON, since: SINCE, notified: new Set<string>() }
  const all = notificationsFor(input)
  assert.deepEqual(
    all.map(note => note.key),
    runs.map(item => `done:contoso:${item.buildId}:${item.finishedAt}`)
  )
  assert.deepEqual(notificationsFor(input), all)
  assert.equal(input.notified.size, 0)
  const some = notificationsFor({ ...input, notified: new Set([all[0].key, all[3].key]) })
  assert.deepEqual(some.map(note => note.key), [all[1].key, all[2].key, all[4].key])

  const approvals = notificationsFor({ ...input, runs: [waiting(9, [approval('abc', 9)])] })
  assert.deepEqual(approvals.map(note => note.key), ['approval:contoso:abc'])
  assert.deepEqual(notificationsFor({ ...input, runs: [failed(1), failed(1)] }).length, 1)
})
