import { assert, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AutoCompleteOptions } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { createAdoHttp } from '../ado/http'
import type { RawThread } from '../ado/pr-review'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, ORG, ORG_URL, PROJECT } from '../boards/fake-ado'
import { createScheduler } from '../poll/scheduler'
import { drain, fakeClock, withWorker } from '../test-support'
import { fakePrs, isMineActive, isReviewList, isThreads, ME, projectOf, threadsPrIdOf } from './fake-prs'
import { createPrNotifier, MAX_WATCHED_PRS } from './notify'
import { createPrsService, type PrsService } from './service'
import type { PrNotifyPrefs } from './settings'

type RawComment = NonNullable<RawThread['comments']>[number]
type Person = { id: string; displayName: string }

const T0 = Date.parse('2026-11-05T09:00:00Z')
const MINUTE = 60_000
const BACKGROUND = 5 * MINUTE
const AUTHORIZATION = 'Basic cHItbm90aWZ5LXNlY3JldC03ZjNh'
const AUTO: AutoCompleteOptions = { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false }
const GRACE: Person = { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper' }
const DENNIS: Person = { id: 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e', displayName: 'Dennis Ritchie' }
const ALEX: Person = { id: ME, displayName: 'Alex Contoso' }
const MORE_BODY = 'Open the PRs tab in the Azure DevOps panel to see them.'
const COMMENTS_UNREAD = "Couldn't read the comments on your pull requests for notifications."

interface Shown {
  title: string
  body: string
}

function status(overrides: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all',
    ...overrides
  }
}

function comment(id: number, author: Person, at: number, content: string, over: Partial<RawComment> = {}): RawComment {
  return { id, author, content, publishedDate: new Date(at).toISOString(), commentType: 'text', ...over }
}

function thread(id: number, comments: RawComment[], over: Partial<RawThread> = {}): RawThread {
  return { id, status: 'active', isDeleted: false, threadContext: null, comments, ...over }
}

function requested(prId: number, title: string, over: Partial<RawPullRequest> = {}): RawPullRequest {
  const [base] = fixture<{ value: RawPullRequest[] }>('pull-requests-review').value
  return {
    ...base,
    pullRequestId: prId,
    title,
    sourceRefName: `refs/heads/feature/${prId}`,
    reviewers: [{ id: ME, displayName: 'Alex Contoso', vote: 0 }],
    ...over
  }
}

function mineAt(prId: number, createdAt: number): RawPullRequest {
  const [base] = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value
  return { ...base, pullRequestId: prId, title: `Change ${prId}`, sourceRefName: `refs/heads/feature/${prId}`, creationDate: new Date(createdAt).toISOString() }
}

interface Harness {
  ado: ReturnType<typeof fakePrs>
  clock: ReturnType<typeof fakeClock>
  prefs: PrNotifyPrefs
  review: RawPullRequest[]
  mine: RawPullRequest[]
  threads: Map<number, RawThread[]>
  service: PrsService
  shown(): Shown[]
  logs(): readonly string[]
  setOrgs(next: OrgStatus[]): void
  poll(ms?: number): Promise<Shown[]>
}

async function withPrNotifications(body: (h: Harness) => Promise<void>): Promise<void> {
  const host = mockHost({ results: { 'notifications.show': { delivered: true } } })
  const ado = fakePrs()
  const clock = fakeClock(T0)
  const review = fixture<{ value: RawPullRequest[] }>('pull-requests-review').value
  const mine = fixture<{ value: RawPullRequest[] }>('pull-requests-mine').value
  const threads = new Map<number, RawThread[]>()
  const prefs: PrNotifyPrefs = { reviews: true, comments: true }
  let orgs: OrgStatus[] = []
  ado.on(isReviewList, call => json(200, { value: projectOf(call) === PROJECT ? review : [] }))
  ado.on(isMineActive, call => json(200, { value: projectOf(call) === PROJECT ? mine : [] }))
  ado.on(isThreads, call => json(200, { value: threads.get(threadsPrIdOf(call)) ?? [] }))
  const made: { service?: PrsService } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      const log = (message: string) => orca.log(message)
      made.service = createPrsService({
        http: createAdoHttp({ fetch: ado.fetch, authHeader: async () => AUTHORIZATION, sleep: async () => {} }),
        orgs: async () => structuredClone(orgs),
        scheduler: createScheduler(clock),
        autoComplete: () => AUTO,
        post: () => {},
        counts: () => {},
        now: clock.now,
        notifier: createPrNotifier({ show: n => orca.host.call('notifications.show', n), prefs: () => prefs, log }),
        log
      })
    }
  }
  await withWorker(module, { host }, async w => {
    const service = made.service as PrsService
    const shown = () => host.callsOf('notifications.show') as Shown[]
    const harness: Harness = {
      ado,
      clock,
      prefs,
      review,
      mine,
      threads,
      service,
      shown,
      logs: () => w.logs,
      setOrgs(next) {
        orgs = next
        service.onOrgs(structuredClone(next))
      },
      async poll(ms = BACKGROUND) {
        const before = shown().length
        await clock.tick(ms)
        return shown().slice(before)
      }
    }
    try {
      await body(harness)
    } finally {
      service.dispose()
    }
    assert.equal(w.refusals.length, 0)
  })
}

test('the first load notifies nothing and sets the baseline', async () => {
  await withPrNotifications(async h => {
    const open = thread(201, [comment(1, GRACE, T0 - MINUTE, 'Please add a test.')])
    h.threads.set(4101, [open])
    h.setOrgs([status()])
    assert.deepEqual(await h.poll(0), [], 'a review already waiting and comments already written notify nothing')
    assert.equal(h.ado.count(isThreads), 5, 'the threads of my active pull requests were read')
    assert.deepEqual(await h.poll(), [])

    h.review.push(requested(4120, 'Tighten the redirect check'))
    open.comments?.push(comment(2, GRACE, T0 + 6 * MINUTE, 'And a changelog line.'))
    assert.deepEqual((await h.poll()).map(note => note.title), ['Review requested: Pull Request 4120', 'New comment on Pull Request 4101'])
    assert.deepEqual(h.logs(), [])
  })
})

test('a new review request notifies once', async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)

    const fresh = requested(4120, 'Tighten the redirect check')
    const draft = requested(4121, 'Try a new parser', { isDraft: true })
    const voted = requested(4122, 'Voted already', { reviewers: [{ id: ME, displayName: 'Alex Contoso', vote: 10 }] })
    const declined = requested(4123, 'Declined', { reviewers: [{ id: ME, displayName: 'Alex Contoso', vote: 0, hasDeclined: true }] })
    const own = requested(4124, 'My own', { createdBy: { id: ME, displayName: 'Alex Contoso' } })
    h.review.push(fresh, draft, voted, declined, own)
    assert.deepEqual(await h.poll(), [{ title: 'Review requested: Pull Request 4120', body: 'Tighten the redirect check\nGrace Hopper · web-app' }])
    assert.deepEqual(await h.poll(), [], 'once')

    fresh.reviewers = [{ id: ME, displayName: 'Alex Contoso', vote: 10 }]
    assert.deepEqual(await h.poll(), [])
    fresh.reviewers = [{ id: ME, displayName: 'Alex Contoso', vote: 0 }]
    assert.deepEqual(await h.poll(), [], 'leaving To review and coming back does not notify again')

    draft.isDraft = false
    assert.deepEqual((await h.poll()).map(note => note.title), ['Review requested: Pull Request 4121'], 'a draft counts once To review lists it')

    h.prefs.reviews = false
    h.review.push(requested(4125, 'While the setting is off'))
    assert.deepEqual(await h.poll(), [])
    h.prefs.reviews = true
    assert.deepEqual(await h.poll(), [], 'a request that arrived while the setting was off stays quiet')

    h.setOrgs([status({ state: 'expired' })])
    h.review.push(requested(4126, 'While signed out'))
    h.setOrgs([status()])
    assert.deepEqual(await h.poll(0), [], 'a reconnect sets a new baseline')
    h.review.push(requested(4127, 'After reconnecting'))
    assert.deepEqual((await h.poll()).map(note => note.title), ['Review requested: Pull Request 4127'])
  })
})

test('a comment by someone else on my pull request notifies once, naming the latest of several', async () => {
  await withPrNotifications(async h => {
    const open = thread(201, [comment(1, GRACE, T0 - MINUTE, 'Please add a test.')])
    h.threads.set(4101, [open])
    h.setOrgs([status()])
    await h.poll(0)

    open.comments?.push(
      comment(2, ALEX, T0 + MINUTE, 'Added one.'),
      comment(3, GRACE, T0 + 2 * MINUTE, 'Thanks!'),
      comment(4, DENNIS, T0 + 3 * MINUTE, `\n> **Nit:** rename [the helper](${ORG_URL}/_git/web-app?path=/src/a.ts) to \`parse_url\`, @<${ME.toUpperCase()}>\nSecond line.`),
      comment(5, ALEX, T0 + 4 * MINUTE, 'Will do.')
    )
    h.threads.set(4104, [thread(301, [comment(1, GRACE, T0 + 4 * MINUTE, 'Why the offset?')])])
    assert.deepEqual(await h.poll(), [
      { title: 'New comment on Pull Request 4104', body: 'Grace Hopper: Why the offset?' },
      { title: '2 new comments on Pull Request 4101', body: 'Dennis Ritchie: Nit: rename the helper to parse_url, @Alex Contoso' }
    ])
    assert.deepEqual(await h.poll(), [], 'each comment notifies once')

    open.comments?.push(comment(6, GRACE, T0 + 6 * MINUTE, 'One more thing.'))
    assert.deepEqual(await h.poll(), [{ title: 'New comment on Pull Request 4101', body: 'Grace Hopper: One more thing.' }])
  })
})

test('my own comments, system comments and deleted comments never notify', async () => {
  await withPrNotifications(async h => {
    const open = thread(201, [comment(1, GRACE, T0 - MINUTE, 'Please add a test.')])
    const gone = thread(202, [comment(1, GRACE, T0 - MINUTE, 'Hmm.')])
    h.threads.set(4101, [open, gone])
    h.setOrgs([status()])
    await h.poll(0)

    open.comments?.push(
      comment(2, { id: ME.toUpperCase(), displayName: 'Alex Contoso' }, T0 + MINUTE, 'Added one.'),
      comment(3, DENNIS, T0 + MINUTE, 'Dennis Ritchie voted 10', { commentType: 'system' }),
      comment(4, GRACE, T0 + 2 * MINUTE, 'Never mind.', { isDeleted: true })
    )
    gone.comments?.push(comment(2, GRACE, T0 + 2 * MINUTE, 'Wrong pull request.'))
    gone.isDeleted = true
    h.threads.set(4102, [thread(301, [comment(1, ALEX, T0 + MINUTE, 'Note to self.')])])
    assert.deepEqual(await h.poll(), [])
    assert.deepEqual(h.logs(), [])
  })
})

test('turning notifyPrComments off stops thread reads', async () => {
  await withPrNotifications(async h => {
    const open = thread(201, [comment(1, GRACE, T0 - MINUTE, 'Please add a test.')])
    h.threads.set(4101, [open])
    h.setOrgs([status()])
    await h.poll(0)
    const reads = () => ({ threads: h.ado.count(isThreads), mine: h.ado.count(isMineActive) })
    const before = reads()
    assert.deepEqual(before, { threads: 5, mine: 2 })

    h.prefs.comments = false
    open.comments?.push(comment(2, GRACE, T0 + MINUTE, 'While the setting is off.'))
    h.review.push(requested(4120, 'Tighten the redirect check'))
    assert.deepEqual((await h.poll()).map(note => note.title), ['Review requested: Pull Request 4120'], 'review requests still notify')
    assert.deepEqual(reads(), before, 'no thread reads, and no list of my pull requests to read them for')

    h.prefs.comments = true
    assert.deepEqual(await h.poll(), [], 'the first read after turning it back on sets a new baseline')
    open.comments?.push(comment(3, GRACE, T0 + 11 * MINUTE, 'After turning it on.'))
    assert.deepEqual((await h.poll()).map(note => note.body), ['Grace Hopper: After turning it on.'])
  })
})

test("a forbidden thread read pauses that org's thread reads for ten minutes", async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)
    const refused = { now: true }
    h.ado.on(call => refused.now && isThreads(call) && threadsPrIdOf(call) === 4103, () => json(403, { message: 'TF401019: no access.' }))
    const reads = () => h.ado.count(isThreads)

    const before = reads()
    await h.poll()
    assert.ok(reads() > before, 'the refused read happened at the 5 minute poll')
    const paused = reads()

    h.review.push(requested(4120, 'Tighten the redirect check'))
    await h.clock.tick(10 * MINUTE - 1)
    assert.deepEqual(h.shown().map(note => note.title), ['Review requested: Pull Request 4120'], 'pull request loads and review requests carry on')
    await h.service.refresh(ORG)
    assert.equal(reads(), paused, 'no thread reads for ten minutes')

    refused.now = false
    await h.clock.tick(1)
    await h.service.refresh(ORG)
    assert.equal(reads(), paused + 5, 'thread reads resume after ten minutes')
    assert.deepEqual(h.logs(), [], 'a refusal pauses; it is not logged')
  })
})

test('other thread read failures log a fixed message, and an aborted read nothing', async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)
    const failing = { now: true }
    h.ado.on(call => failing.now && isThreads(call), () => json(500, { message: 'TF246017: the database is unavailable.' }))
    assert.deepEqual(await h.poll(), [])
    assert.deepEqual(h.logs(), [COMMENTS_UNREAD])

    failing.now = false
    const reads = h.ado.count(isThreads)
    await h.poll()
    assert.equal(h.ado.count(isThreads), reads + 5, 'a failure does not pause the reads')

    const hung = h.ado.hang(isThreads)
    await h.poll()
    assert.ok(hung.length > 0, 'thread reads are in flight')
    h.setOrgs([status({ state: 'disconnected', account: null })])
    await drain()
    assert.ok(hung.every(call => call.signal?.aborted), 'signing out aborts them')
    assert.deepEqual(h.logs(), [COMMENTS_UNREAD], 'the abort is not logged')
    assert.deepEqual(h.shown(), [])
  })
})

test('more than three notifications in one update collapse into the summary', async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)

    h.review.push(requested(4120, 'First'), requested(4121, 'Second'))
    for (const prId of [4101, 4102, 4103]) h.threads.set(prId, [thread(prId, [comment(1, GRACE, T0 + MINUTE, `On ${prId}`)])])
    assert.deepEqual(await h.poll(), [
      { title: 'Review requested: Pull Request 4121', body: 'Second\nGrace Hopper · web-app' },
      { title: 'Review requested: Pull Request 4120', body: 'First\nGrace Hopper · web-app' },
      { title: 'New comment on Pull Request 4103', body: 'Grace Hopper: On 4103' },
      { title: '2 more pull request updates', body: MORE_BODY }
    ])
    assert.deepEqual(await h.poll(), [], 'every collapsed one counts as notified')

    h.review.push(requested(4122, 'Third'), requested(4123, 'Fourth'), requested(4124, 'Fifth'), requested(4125, 'Sixth'))
    const shown = await h.poll()
    assert.equal(shown.length, 4)
    assert.deepEqual(shown[3], { title: '1 more pull request update', body: MORE_BODY })
  })
})

test('long pull request titles and comments are cut as run notifications are', async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)

    h.review.push(requested(4120, `Tighten ${'x'.repeat(2000)}`))
    h.threads.set(4101, [thread(201, [comment(1, { id: GRACE.id, displayName: 'G'.repeat(300) }, T0 + MINUTE, 'y'.repeat(3000))])])
    const shown = await h.poll()
    assert.deepEqual(shown.map(note => note.title), ['Review requested: Pull Request 4120', 'New comment on Pull Request 4101'])
    for (const note of shown) {
      assert.equal(note.body.length, 1000)
      assert.ok(note.body.endsWith('…'))
    }
  })
})

test('notification text carries no token or Authorization value', async () => {
  await withPrNotifications(async h => {
    h.setOrgs([status()])
    await h.poll(0)

    h.review.push(requested(4120, 'Tighten the redirect check'))
    const links = `![build log](${ORG_URL}/_apis/git/attachments/log.png) see [the run](${ORG_URL}/_build/results?buildId=4512) <${ORG_URL}/_git/web-app>`
    h.threads.set(4101, [thread(201, [comment(1, GRACE, T0 + MINUTE, links)])])
    const shown = await h.poll()
    assert.deepEqual(shown.map(note => note.body), ['Tighten the redirect check\nGrace Hopper · web-app', 'Grace Hopper: build log see the run'])
    assert.ok(h.ado.calls.every(call => call.headers.get('authorization') === AUTHORIZATION), 'every request carried the credential')
    const seen = JSON.stringify([h.shown(), h.logs()])
    for (const secret of [AUTHORIZATION, AUTHORIZATION.split(' ')[1], 'Bearer', 'https://', ORG_URL]) assert.ok(!seen.includes(secret), secret)
  })
})

test('my 20 newest active pull requests are watched, from the tab load while it is fresh', async () => {
  await withPrNotifications(async h => {
    h.mine.splice(0, h.mine.length, ...Array.from({ length: 25 }, (_, index) => mineAt(5000 + index, T0 - index * MINUTE)))
    h.setOrgs([status()])
    await h.poll(0)
    const read = () => h.ado.calls.filter(isThreads).map(threadsPrIdOf)
    assert.equal(MAX_WATCHED_PRS, 20)
    assert.deepEqual(read().sort(), Array.from({ length: 20 }, (_, index) => 5000 + index))

    const lists = h.ado.count(isMineActive)
    h.service.visibility({ org: ORG, visible: true })
    await drain()
    assert.equal(h.ado.count(isMineActive), lists + 2, 'the full load lists them, and the thread reads use that list')
    assert.equal(read().length, 40)
  })
})
