import { spawnSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { createScheduler } from '../poll/scheduler'
import { fakeClock } from '../test-support'
import { branchFor, createArm } from './arm'

const ITEM = { id: 1204, title: 'Add vehicle search filters' }
const ARMED = { org: 'contoso', itemId: 1204, branch: 'feature/1204-add-vehicle-search-filters' }
const T0 = Date.parse('2026-11-04T09:00:00Z')
const MINUTE = 60_000

function clock() {
  let now = T0
  return { now: () => now, advance: (ms: number) => void (now += ms) }
}

test('branchFor slugs titles and respects the template', () => {
  assert.equal(branchFor('feature/{id}-{slug}', ITEM), 'feature/1204-add-vehicle-search-filters')
  assert.equal(branchFor('bug/{id}', ITEM), 'bug/1204')
  assert.equal(branchFor('{id}', ITEM), '1204')
  assert.equal(branchFor('Users/ada/{slug}', ITEM), 'Users/ada/add-vehicle-search-filters')
  assert.equal(branchFor('team notes/{id} {slug}', ITEM), 'team-notes/1204-add-vehicle-search-filters')
  assert.equal(branchFor('feature/{id}-{slug}', { id: 7, title: 'Résumé — naïve façade ✓ Ünïcode' }), 'feature/7-resume-naive-facade-unicode')
  assert.equal(branchFor('feature/{id}-{slug}', { id: 7, title: '日本語 !!!' }), 'feature/7-item')
})

test('branchFor cuts the slug to 40 characters without a trailing dash', () => {
  const long = branchFor('{slug}', { id: 1, title: `${'x'.repeat(39)} tail` })
  assert.equal(long, 'x'.repeat(39))
  const words = branchFor('{slug}', { id: 1, title: 'Implement the dealer export retry policy for failed uploads' })
  assert.ok(words.length <= 40 && !words.endsWith('-'), words)
  assert.equal(words, 'implement-the-dealer-export-retry-policy')
})

test('branchFor always returns a valid git ref', () => {
  assert.equal(branchFor('a..b//c.lock/{id}.', ITEM), 'a.b/c/1204')
  assert.equal(branchFor('.hidden/{id}-', ITEM), 'hidden/1204')
  assert.equal(branchFor('/{id}/', ITEM), '1204')
  assert.equal(branchFor('a@{b}~^:?*[\\/{id}', ITEM), 'a-b/1204')
  assert.equal(branchFor('{slug}.lock', ITEM), 'add-vehicle-search-filters')
  assert.equal(branchFor('///', ITEM), 'feature/1204-add-vehicle-search-filters')
  assert.equal(branchFor('', ITEM), 'feature/1204-add-vehicle-search-filters')
  assert.equal(branchFor('...', ITEM), 'feature/1204-add-vehicle-search-filters')
})

test('branchFor strips trailing dots, dashes and .lock from each segment until it is stable', () => {
  assert.equal(branchFor('{id}.lock.', ITEM), '1204')
  assert.equal(branchFor('{slug}.lock!', ITEM), 'add-vehicle-search-filters')
  assert.equal(branchFor('x.lock /{id}', ITEM), 'x/1204')
  assert.equal(branchFor('a.lock.lock-.lock/{id}', ITEM), 'a/1204')
})

test('branchFor output passes git check-ref-format', () => {
  const templates = [
    'feature/{id}-{slug}', '{id}.lock.', '{slug}.lock!', 'x.lock /{id}', 'a..b//c.lock/{id}.', '.hidden/{id}-', '/{id}/', '@{slug}', '-{id}', '{slug}.lock.lock.',
    'a@{b}~^:?*[\\/{id}', 'team notes/{id} {slug}', '{slug}/.lock', '...', ''
  ]
  const titles = [ITEM.title, 'Résumé — naïve façade ✓', '日本語', '[Bug] Search..lock', '   ', 'a'.repeat(80)]
  for (const template of templates) {
    for (const title of titles) {
      const ref = branchFor(template, { id: 1204, title })
      const check = spawnSync('git', ['check-ref-format', '--branch', ref])
      assert.equal(check.status, 0, `${JSON.stringify(template)} with ${JSON.stringify(title)} gave ${JSON.stringify(ref)}`)
    }
  }
})

test('an arm is taken once and reports when it expires', () => {
  const time = clock()
  const arm = createArm(time.now)
  assert.equal(arm.take(), null, 'nothing armed')
  assert.equal(arm.arm(ARMED), T0 + 10 * MINUTE)
  assert.deepEqual(arm.take(), ARMED)
  assert.equal(arm.take(), null, 'single use')
})

test('a disarmed branch is not taken, so the next worktree creation passes through', () => {
  const time = clock()
  const arm = createArm(time.now)
  arm.arm(ARMED)
  arm.disarm()
  assert.equal(arm.take(), null)
  assert.equal(arm.claim(ARMED.branch), null)
})

test('arming again replaces the previous arm', () => {
  const time = clock()
  const arm = createArm(time.now)
  arm.arm(ARMED)
  time.advance(MINUTE)
  const later = { org: 'contoso', itemId: 1205, branch: 'feature/1205-fix-pagination-offset' }
  assert.equal(arm.arm(later), T0 + 11 * MINUTE)
  assert.deepEqual(arm.take(), later)
  assert.equal(arm.take(), null)
})

test('an arm older than ten minutes is not taken', () => {
  const time = clock()
  const arm = createArm(time.now)
  arm.arm(ARMED)
  time.advance(10 * MINUTE - 1)
  assert.deepEqual(arm.take(), ARMED, 'one millisecond before it expires')

  arm.arm(ARMED)
  time.advance(10 * MINUTE)
  assert.equal(arm.take(), null, 'at the expiry')
  assert.equal(arm.take(), null)
})

test('claim hands back the taken arm once, for its branch or a prefixed one, within 30 seconds', () => {
  const time = clock()
  const arm = createArm(time.now)
  assert.equal(arm.claim(ARMED.branch), null, 'nothing taken')

  arm.arm(ARMED)
  arm.take()
  assert.equal(arm.claim('feature/1205-fix-pagination-offset'), null, 'another branch')
  assert.equal(arm.claim(`orca/${ARMED.branch}`)?.itemId, 1204, 'a prefix Orca added')
  assert.equal(arm.claim(ARMED.branch), null, 'once')

  arm.arm(ARMED)
  arm.take()
  time.advance(30_000)
  assert.equal(arm.claim(ARMED.branch)?.itemId, 1204, 'at 30 seconds')

  arm.arm(ARMED)
  arm.take()
  time.advance(30_001)
  assert.equal(arm.claim(ARMED.branch), null, 'after 30 seconds')
})

test('an arm that was never taken cannot be claimed', () => {
  const time = clock()
  const arm = createArm(time.now)
  arm.arm(ARMED)
  assert.equal(arm.claim(ARMED.branch), null)
})

const PR_ARMED = { org: 'contoso', branch: 'hotfix/1211-login-redirect', base: 'origin/hotfix/1211-login-redirect', prId: 4110 }
const ITEM_ARM = { org: 'contoso', itemId: 1204 }
const PR_ARM = { org: 'contoso', prId: 4110 }

function watched() {
  const time = fakeClock(T0)
  const changes: unknown[] = []
  const arm = createArm(time.now, { scheduler: createScheduler(time), changed: current => changes.push(current) })
  return { time, changes, arm }
}

test('every change of the arm is reported with its identity only: armed, replaced, taken and disarmed', () => {
  const { changes, arm } = watched()
  arm.arm(ARMED)
  arm.arm(PR_ARMED)
  assert.deepEqual(arm.take(), PR_ARMED)
  arm.take()
  arm.disarm()
  arm.arm(ARMED)
  arm.disarm()
  arm.disarm()
  assert.deepEqual(changes, [ITEM_ARM, PR_ARM, null, ITEM_ARM, null])
})

test('an arm that expires is reported once by the scheduler, which keeps no timer afterwards', async () => {
  const { time, changes, arm } = watched()
  arm.arm(ARMED)
  await time.tick(0)
  await time.tick(10 * MINUTE - 1)
  assert.deepEqual(changes, [ITEM_ARM], 'still armed a millisecond before it expires')
  await time.tick(1)
  assert.deepEqual(changes, [ITEM_ARM, null])
  assert.equal(time.pending(), 0)
  assert.equal(arm.take(), null)
  await time.tick(60 * MINUTE)
  assert.deepEqual(changes, [ITEM_ARM, null])
})

test('arming again restarts the ten minutes, and a taken or disarmed arm leaves no timer', async () => {
  const { time, changes, arm } = watched()
  arm.arm(ARMED)
  await time.tick(5 * MINUTE)
  arm.arm(PR_ARMED)
  await time.tick(10 * MINUTE - 1)
  assert.deepEqual(changes, [ITEM_ARM, PR_ARM])
  await time.tick(1)
  assert.deepEqual(changes, [ITEM_ARM, PR_ARM, null])

  arm.arm(ARMED)
  arm.take()
  assert.equal(time.pending(), 0, 'taken')
  arm.arm(ARMED)
  arm.disarm()
  assert.equal(time.pending(), 0, 'disarmed')
  await time.tick(60 * MINUTE)
  assert.deepEqual(changes, [ITEM_ARM, PR_ARM, null, ITEM_ARM, null, ITEM_ARM, null])
})

test('disarming with an identity disarms only that arm', () => {
  const { changes, arm } = watched()
  arm.arm(ARMED)
  arm.disarm(PR_ARM)
  arm.disarm({ org: 'fabrikam', itemId: 1204 })
  arm.disarm({ org: 'contoso', itemId: 1205 })
  assert.deepEqual(changes, [ITEM_ARM], 'another arm is left alone')
  arm.disarm(ITEM_ARM)
  assert.deepEqual(changes, [ITEM_ARM, null])
  assert.equal(arm.take(), null)

  arm.arm(PR_ARMED)
  arm.disarm(ITEM_ARM)
  arm.disarm({ org: 'contoso', prId: 4111 })
  arm.disarm(PR_ARM)
  assert.deepEqual(changes, [ITEM_ARM, null, PR_ARM, null])
})
