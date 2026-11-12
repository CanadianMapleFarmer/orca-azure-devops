import { assert, test } from 'orca/testing'
import type { RawThread } from '../ado/pr-review'
import { createThreadCadence, threadSignature, THREADS_FIRST_MS, THREADS_MAX_MS } from './thread-cadence'

type RawComment = NonNullable<RawThread['comments']>[number]

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const PROJECT = 'fabrikam-web'
const REPO = 'web-app'
const QUIET = 'quiet'

function pr(prId: number) {
  return { projectId: PROJECT, repoId: REPO, prId }
}

function comment(id: number, at: number, over: Partial<RawComment> = {}): RawComment {
  return { id, content: `Comment ${id}`, publishedDate: new Date(at).toISOString(), commentType: 'text', ...over }
}

function setup() {
  const clock = { now: T0 }
  const cadence = createThreadCadence(() => clock.now)
  const dueAt = (at: number, watched = [pr(4101)]) => {
    clock.now = at
    return cadence.due(watched).map(due => due.prId)
  }
  return { clock, cadence, dueAt }
}

test("a PR whose threads didn't change is re-read after 2, then 4, 8 and 10 minutes", () => {
  assert.deepEqual([THREADS_FIRST_MS, THREADS_MAX_MS], [2 * MINUTE, 10 * MINUTE])
  const { cadence, dueAt } = setup()
  cadence.read(pr(4101), QUIET)

  let readAt = T0
  for (const minutes of [2, 4, 8, 10, 10]) {
    assert.deepEqual(dueAt(readAt + minutes * MINUTE - 1), [], `not before ${minutes} minutes`)
    assert.deepEqual(dueAt(readAt + minutes * MINUTE), [4101], `after ${minutes} minutes`)
    readAt += minutes * MINUTE
    cadence.read(pr(4101), QUIET)
  }
})

test('a changed signature resets that PR to 2 minutes', () => {
  const { cadence, dueAt } = setup()
  cadence.read(pr(4101), QUIET)
  dueAt(T0 + 2 * MINUTE)
  cadence.read(pr(4101), QUIET)
  assert.deepEqual(dueAt(T0 + 6 * MINUTE - 1), [], 'backed off to 4 minutes')

  dueAt(T0 + 6 * MINUTE)
  cadence.read(pr(4101), 'a new comment')
  assert.deepEqual(dueAt(T0 + 8 * MINUTE - 1), [])
  assert.deepEqual(dueAt(T0 + 8 * MINUTE), [4101])
})

test('a PR never read is due at once', () => {
  const { cadence, dueAt } = setup()
  const watched = [pr(4101), pr(4102)]
  assert.deepEqual(dueAt(T0, watched), [4101, 4102])
  cadence.read(pr(4101), QUIET)
  assert.deepEqual(dueAt(T0, watched), [4102])
  assert.deepEqual(dueAt(T0, [...watched, pr(4103)]), [4102, 4103])
})

test('PRs no longer watched are dropped from the cadence', () => {
  const { cadence, dueAt } = setup()
  cadence.read(pr(4101), QUIET)
  cadence.read(pr(4102), QUIET)
  assert.deepEqual(dueAt(T0 + MINUTE, [pr(4102)]), [])
  assert.deepEqual(dueAt(T0 + MINUTE), [4101], 'its last read was forgotten when it left the watched list')

  cadence.read(pr(4101), QUIET)
  cadence.forget()
  assert.deepEqual(dueAt(T0 + MINUTE), [4101], 'forget drops every PR')
})

test('the signature moves with a new thread, a new comment or an edit, and with nothing else', () => {
  const threads: RawThread[] = [{ id: 201, status: 'active', comments: [comment(1, T0), comment(2, T0 + MINUTE)] }]
  const before = threadSignature(threads)
  assert.equal(threadSignature(structuredClone(threads)), before)
  assert.notEqual(threadSignature([]), threadSignature([{ id: 202, comments: [] }]))

  const added = structuredClone(threads)
  added[0].comments?.push(comment(3, T0 + 2 * MINUTE))
  const edited = structuredClone(threads)
  edited[0].comments?.splice(0, 1, comment(1, T0, { lastUpdatedDate: new Date(T0 + 3 * MINUTE).toISOString() }))
  const another = [...structuredClone(threads), { id: 202, comments: [comment(1, T0 - MINUTE)] }]
  for (const [name, changed] of Object.entries({ added, edited, another })) assert.notEqual(threadSignature(changed), before, name)
})
