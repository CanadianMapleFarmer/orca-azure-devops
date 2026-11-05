import { assert, test } from 'orca/testing'
import { AdoError } from '../ado/http'
import { ORG, PROJECT } from '../boards/fake-ado'
import { PLATFORM } from '../prs/fake-prs'
import { memoryStore } from '../test-support'
import { createWatchList, MAX_WATCHED } from './watched'

const TOO_MANY = 'You can watch up to 20 runs.'
const KEY = `pipelines:watched:${ORG}`

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

test('set adds and removes a run once, per org, under pipelines:watched:<org>', async () => {
  const { data, store } = memoryStore()
  const list = createWatchList(store)
  assert.deepEqual(await list.list(ORG), [])

  assert.deepEqual(await list.set(ORG, { projectId: PROJECT, buildId: 4531 }, true), [{ projectId: PROJECT, buildId: 4531 }])
  assert.deepEqual(await list.set(ORG, { projectId: PROJECT, buildId: 4531 }, true), [{ projectId: PROJECT, buildId: 4531 }], 'watching twice keeps one')
  await list.set(ORG, { projectId: PLATFORM, buildId: 4600 }, true)
  await list.set('fabrikam', { projectId: PROJECT, buildId: 77 }, true)
  assert.deepEqual(data[KEY], [{ projectId: PROJECT, buildId: 4531 }, { projectId: PLATFORM, buildId: 4600 }])
  assert.deepEqual(data['pipelines:watched:fabrikam'], [{ projectId: PROJECT, buildId: 77 }])

  assert.deepEqual(await list.set(ORG, { projectId: PROJECT, buildId: 4531 }, false), [{ projectId: PLATFORM, buildId: 4600 }])
  assert.deepEqual(await list.set(ORG, { projectId: PROJECT, buildId: 9999 }, false), [{ projectId: PLATFORM, buildId: 4600 }], 'unwatching an unknown run is a no-op')
  assert.deepEqual(await createWatchList(store).list(ORG), [{ projectId: PLATFORM, buildId: 4600 }], 'the list lives in storage')
})

test('a 21st run is refused and nothing is saved', async () => {
  const keys = Array.from({ length: MAX_WATCHED }, (_, index) => ({ projectId: PROJECT, buildId: 5000 + index }))
  const { data, store } = memoryStore({ [KEY]: keys })
  const list = createWatchList(store)

  const error = await failure(list.set(ORG, { projectId: PROJECT, buildId: 6000 }, true))
  assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, TOO_MANY])
  assert.deepEqual(data[KEY], keys)
  assert.deepEqual(await list.set(ORG, keys[3], true), keys, 'a run already watched is still accepted at the limit')
  assert.equal(MAX_WATCHED, 20)
})

test('drop removes the given runs and leaves the rest', async () => {
  const keys = [4520, 4531, 4600].map(buildId => ({ projectId: PROJECT, buildId }))
  const { data, store } = memoryStore({ [KEY]: keys })
  const list = createWatchList(store)
  await list.drop(ORG, [keys[0], keys[2], { projectId: PROJECT, buildId: 1 }])
  assert.deepEqual(data[KEY], [keys[1]])
  await list.drop(ORG, [])
  assert.deepEqual(await list.list(ORG), [keys[1]])
})

test('writes for one org are applied in turn, so none is lost', async () => {
  const { data, store } = memoryStore({ [KEY]: [{ projectId: PROJECT, buildId: 4520 }] })
  const list = createWatchList(store)
  await Promise.all([
    list.set(ORG, { projectId: PROJECT, buildId: 4531 }, true),
    list.drop(ORG, [{ projectId: PROJECT, buildId: 4520 }]),
    list.set(ORG, { projectId: PROJECT, buildId: 4600 }, true)
  ])
  assert.deepEqual(data[KEY], [{ projectId: PROJECT, buildId: 4531 }, { projectId: PROJECT, buildId: 4600 }])
})

test('stored entries that are not run keys are ignored', async () => {
  const { store } = memoryStore({ [KEY]: [{ projectId: PROJECT, buildId: 4531 }, { projectId: PROJECT }, 'x', { projectId: 7, buildId: 1 }, { projectId: PROJECT, buildId: 1.5 }] })
  assert.deepEqual(await createWatchList(store).list(ORG), [{ projectId: PROJECT, buildId: 4531 }])
  const { store: odd } = memoryStore({ [KEY]: { projectId: PROJECT, buildId: 4531 } })
  assert.deepEqual(await createWatchList(odd).list(ORG), [])
})
