import { assert, test } from 'orca/testing'
import type { RawThread } from '../ado/pr-review'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, type AdoCall } from '../boards/fake-ado'
import { isApprovals, isMineRuns } from '../pipelines/fake-pipelines'
import { isEvaluations, isMineActive, isReviewList, isThreads, PLATFORM, projectOf, threadsPrIdOf } from '../prs/fake-prs'
import { approvalFor, buildInPlatform, prInPlatform, simulate, type Sim } from './simulate'

const MINUTE = 60_000
const NOTIFY_WITHIN_MS = 5 * MINUTE

type Kind = 'a review request' | 'a failed run' | 'an approval'

const COLD_LIST: Record<Kind, (call: AdoCall) => boolean> = {
  'a review request': isReviewList,
  'a failed run': isMineRuns,
  'an approval': isApprovals
}

const shown = (sim: Sim) => sim.host.callsOf('notifications.show').length

async function afterColdRead(sim: Sim, kind: Kind): Promise<void> {
  const coldReads = () => [...sim.prs.calls, ...sim.runs.calls].filter(call => COLD_LIST[kind](call) && call.path.includes(`/${PLATFORM}/`)).length
  const seen = coldReads()
  const read = await sim.until(() => coldReads() > seen, 10 * MINUTE)
  assert.ok(read < Infinity, `the cold project's list for ${kind} was read`)
}

function happen(sim: Sim, kind: Kind, round: number): void {
  const at = new Date().toISOString()
  if (kind === 'a review request') {
    sim.reviews.push(prInPlatform(fixture<{ value: RawPullRequest[] }>('pull-requests-review').value[0], 4200 + round))
  } else if (kind === 'a failed run') {
    sim.runs.runs.builds.set(4600 + round, buildInPlatform({ id: 4600 + round, status: 'completed', result: 'failed', queueTime: at, startTime: at, finishTime: at }))
  } else {
    const grace = { id: 'grace', displayName: 'Grace', uniqueName: 'grace@contoso.example' }
    sim.runs.runs.builds.set(4700 + round, buildInPlatform({ id: 4700 + round, status: 'inProgress', result: undefined, queueTime: at, startTime: at, finishTime: undefined, requestedFor: grace } as never))
    const approval = approvalFor(4700 + round, `aaaaaaaa-0000-4000-8000-00000000000${round}`)
    sim.runs.runs.approvals.set(approval.id, approval)
  }
}

const scenarios: { kind: Kind; surface: 'prs' | 'pipelines' }[] = [
  { kind: 'a review request', surface: 'prs' },
  { kind: 'a failed run', surface: 'pipelines' },
  { kind: 'an approval', surface: 'pipelines' }
]

for (const { kind, surface } of scenarios) {
  for (const visible of [true, false]) {
    test(`${kind} in a cold project notifies within 5 minutes of its last read, ${surface} tab ${visible ? 'visible' : 'hidden'}`, async () => {
      await simulate({ notifyPrComments: false }, async sim => {
        if (visible) await sim.w.request('ui.visibility', { surface, org: 'contoso', visible: true })
        await sim.tick(12 * MINUTE)
        for (let round = 0; round < 3; round += 1) {
          await afterColdRead(sim, kind)
          const before = shown(sim)
          happen(sim, kind, round)
          const waited = await sim.until(() => shown(sim) > before, 10 * MINUTE)
          assert.ok(waited <= NOTIFY_WITHIN_MS, `round ${round}: notified after ${waited / 1000} s`)
        }
      })
    })
  }
}

test('a comment on my new PR in a cold project notifies within about 5 minutes while the PRs tab stays hidden', async () => {
  await simulate({ notifyPrComments: true }, async sim => {
    const mine = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value
    const opened: RawPullRequest[] = []
    let threads: RawThread[] = []
    sim.prs.on(isMineActive, call => json(200, { value: [...mine, ...opened].filter(pr => pr.repository.project.id === projectOf(call)) }))
    sim.runs.on(isEvaluations, () => json(200, fixture('policy-evaluations')))
    sim.prs.on(isThreads, call => json(200, { value: threadsPrIdOf(call) === 4300 ? threads : [] }))
    await sim.tick(12 * MINUTE)

    opened.push(prInPlatform(mine[0], 4300))
    await sim.tick(5 * MINUTE)
    const now = new Date().toISOString()
    const grace = { id: 'grace', displayName: 'Grace' }
    threads = [{ id: 1, status: 'active', comments: [{ id: 1, author: grace, content: 'Please rename this', publishedDate: now, lastUpdatedDate: now, commentType: 'text' }] }]
    const before = shown(sim)

    const waited = await sim.until(() => shown(sim) > before, 15 * MINUTE)
    assert.ok(waited <= NOTIFY_WITHIN_MS, `notified after ${waited / 1000} s`)
    assert.deepEqual(sim.host.callsOf('notifications.show').slice(before).map(note => (note as { title: string }).title), ['New comment on Pull Request 4300'])
  })
})
