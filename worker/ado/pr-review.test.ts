import { assert, test } from 'orca/testing'
import { fixture, json, ORG, PROJECT, REPO } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { fakeReviews, isBlob, isChanges, isItem, isIterations, isThreadGet, isThreads } from '../reviews/fake-reviews'
import { AdoError, createAdoHttp } from './http'
import { blobSize, fileText, getThread, latestIteration, listChanges, listThreads } from './pr-review'

const KEY = { projectId: PROJECT, repoId: REPO, prId: 4110 }
const PR_PATH = `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/pullRequests/4110`
const SOURCE_1 = '4110a1000000000000000000000000000000a001'
const SOURCE_2 = '4110a2000000000000000000000000000000a002'
const COMMON = '4110c0000000000000000000000000000000c000'

function setup() {
  const ado = fakeReviews()
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  return { ado, http }
}

async function failure(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function iterations(): { value: Record<string, any>[] } {
  return fixture('pr-iterations-4110')
}

function changes(entries: Record<string, unknown>[], page: Record<string, unknown> = { nextSkip: 0, nextTop: 0 }) {
  return { changeEntries: entries, ...page }
}

function entry(id: number, changeType: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { changeTrackingId: id, changeId: id, item: { gitObjectType: 'blob', ...item }, changeType, ...extra }
}

test('latestIteration picks the newest iteration', async () => {
  const { ado, http } = setup()
  const listed = iterations()
  ado.on(isIterations, () => json(200, { value: [listed.value[1], listed.value[0]], count: 2 }))
  assert.deepEqual(await latestIteration(http, ORG, KEY), { id: 2, source: SOURCE_2, common: COMMON })
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', `${PR_PATH}/iterations`])

  const noCommon = iterations()
  delete noCommon.value[1].commonRefCommit
  ado.on(isIterations, () => json(200, noCommon))
  assert.deepEqual(await latestIteration(http, ORG, KEY), { id: 2, source: SOURCE_2, common: null })

  const first = iterations()
  first.value = [first.value[0]]
  ado.on(isIterations, () => json(200, first))
  assert.deepEqual(await latestIteration(http, ORG, KEY), { id: 1, source: SOURCE_1, common: COMMON })

  for (const broken of [
    { value: [{ ...iterations().value[1], sourceRefCommit: null }] },
    { value: [{ ...iterations().value[1], sourceRefCommit: {} }] },
    { value: [{ ...iterations().value[1], id: 'two' }] },
    { value: [] },
    {}
  ]) {
    ado.on(isIterations, () => json(200, broken))
    const error = await failure(latestIteration(http, ORG, KEY))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.review], JSON.stringify(broken).slice(0, 80))
  }
})

test('listChanges maps adds, edits, deletes and renames and skips folders', async () => {
  const { ado, http } = setup()
  const listed = await listChanges(http, ORG, KEY, 2)
  assert.deepEqual(listed, {
    files: [
      {
        path: '/src/auth/redirect.ts',
        originalPath: null,
        kind: 'edited',
        changeTrackingId: 1,
        objectId: 'b10b0001000000000000000000000000000000a2',
        originalObjectId: 'b10b0001000000000000000000000000000000a1'
      },
      {
        path: '/src/auth/redirect.test.ts',
        originalPath: null,
        kind: 'added',
        changeTrackingId: 2,
        objectId: 'b10b0002000000000000000000000000000000a2',
        originalObjectId: null
      },
      {
        path: '/src/auth/legacy-return.ts',
        originalPath: null,
        kind: 'deleted',
        changeTrackingId: 3,
        objectId: null,
        originalObjectId: 'b10b0003000000000000000000000000000000a1'
      },
      {
        path: '/docs/auth.md',
        originalPath: '/docs/login.md',
        kind: 'renamed',
        changeTrackingId: 4,
        objectId: 'b10b0004000000000000000000000000000000a1',
        originalObjectId: 'b10b0004000000000000000000000000000000a1'
      },
      {
        path: '/assets/lock.png',
        originalPath: null,
        kind: 'added',
        changeTrackingId: 6,
        objectId: 'b10b0005000000000000000000000000000000a2',
        originalObjectId: null
      }
    ],
    more: false
  })
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', `${PR_PATH}/iterations/2/changes`])
  assert.deepEqual([call.query.get('$compareTo'), call.query.get('$top')], ['0', '1000'])

  ado.on(isChanges, () =>
    json(
      200,
      changes([
        entry(7, 'edit, rename', { path: '/docs/sign-in.md', objectId: 'c2', originalObjectId: 'c1' }, { originalPath: '/docs/signing-in.md' }),
        entry(8, 'edit', { path: '/src/app.ts', objectId: 'd2', originalObjectId: 'd1' }, { originalPath: '/src/old-app.ts' }),
        entry(9, 'delete, sourceRename', { path: '/src/gone.ts', originalObjectId: 'e1' }),
        entry(10, 'add', { path: '/src/new', isFolder: true }),
        entry(11, 'edit', { path: '/lib', gitObjectType: 'tree' })
      ])
    )
  )
  const flagged = await listChanges(http, ORG, KEY, 2)
  assert.deepEqual(
    flagged.files.map(file => [file.path, file.kind, file.originalPath]),
    [
      ['/docs/sign-in.md', 'renamed', '/docs/signing-in.md'],
      ['/src/app.ts', 'edited', null],
      ['/src/gone.ts', 'deleted', null]
    ]
  )

  const page = Array.from({ length: 1_000 }, (_, i) => entry(i + 1, 'edit', { path: `/gen/file-${i}.ts`, objectId: `n${i}`, originalObjectId: `o${i}` }))
  ado.on(isChanges, () => json(200, changes(page)))
  assert.deepEqual([(await listChanges(http, ORG, KEY, 2)).more, (await listChanges(http, ORG, KEY, 2)).files.length], [true, 1_000])
  ado.on(isChanges, () => json(200, changes(page.slice(0, 10), { nextSkip: 10, nextTop: 10 })))
  assert.equal((await listChanges(http, ORG, KEY, 2)).more, true)
  ado.on(isChanges, () => json(200, changes(page.slice(0, 999))))
  assert.equal((await listChanges(http, ORG, KEY, 2)).more, false)

  for (const broken of [{}, changes([{ changeType: 'edit', item: { path: '/x' } }]), changes([entry(1, 'edit', {})])]) {
    ado.on(isChanges, () => json(200, broken))
    const error = await failure(listChanges(http, ORG, KEY, 2))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.review])
  }
})

test('listThreads asks for positions on the latest iteration', async () => {
  const { ado, http } = setup()
  const threads = await listThreads(http, ORG, KEY, 2)
  assert.deepEqual(threads.map(thread => thread.id), [101, 102, 103, 104, 105])
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', `${PR_PATH}/threads`])
  assert.deepEqual([call.query.get('$iteration'), call.query.get('$baseIteration')], ['2', '0'])

  ado.on(isThreads, () => json(200, { count: 0 }))
  assert.equal((await failure(listThreads(http, ORG, KEY, 2))).message, MALFORMED.review)
})

test('getThread reads one thread and answers null when it is gone', async () => {
  const { ado, http } = setup()
  assert.equal((await getThread(http, ORG, KEY, 102))?.status, 'fixed')
  assert.deepEqual([ado.calls[0].method, ado.calls[0].path], ['GET', `${PR_PATH}/threads/102`])
  assert.equal(await getThread(http, ORG, KEY, 999), null)
  ado.on(isThreadGet, () => json(403, { message: 'TF401027: You need the Git "GenericRead" permission.' }))
  assert.equal((await failure(getThread(http, ORG, KEY, 102))).code, 'forbidden')
})

test('getThread refuses a body that is not a thread', async () => {
  const { ado, http } = setup()
  for (const body of [{}, { id: '102', comments: [] }, { id: 102, comments: 'none' }, null]) {
    ado.on(isThreadGet, () => json(200, body))
    assert.equal((await failure(getThread(http, ORG, KEY, 102))).message, MALFORMED.review, JSON.stringify(body))
  }
  ado.on(isThreadGet, () => json(200, { id: 102 }))
  assert.equal((await getThread(http, ORG, KEY, 102))?.id, 102)
})

test('fileText reads JSON content and spots binaries', async () => {
  const { ado, http } = setup()
  const text = await fileText(http, ORG, KEY, '/src/auth/redirect.ts', SOURCE_2)
  assert.equal(text.binary, false)
  assert.match(text.text, /^import \{ URL \} from 'node:url'\n/)
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/items`])
  assert.deepEqual(Object.fromEntries(call.query), {
    path: '/src/auth/redirect.ts',
    'versionDescriptor.version': SOURCE_2,
    'versionDescriptor.versionType': 'commit',
    includeContent: 'true',
    includeContentMetadata: 'true',
    $format: 'json',
    'api-version': '7.1'
  })

  assert.equal((await fileText(http, ORG, KEY, '/assets/lock.png', SOURCE_2)).binary, true)
  ado.on(isItem, () => json(200, { content: 'GIF89a\u0000\u0001', contentMetadata: { isBinary: false } }))
  assert.equal((await fileText(http, ORG, KEY, '/assets/x.gif', SOURCE_2)).binary, true)
  ado.on(isItem, () => json(200, { objectId: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', contentMetadata: { isBinary: false } }))
  assert.deepEqual(await fileText(http, ORG, KEY, '/empty.txt', SOURCE_2), { text: '', binary: false })
  ado.on(isItem, () => json(200, { content: 42 }))
  assert.equal((await failure(fileText(http, ORG, KEY, '/x', SOURCE_2))).message, MALFORMED.review)
})

test('blobSize reads the size in bytes', async () => {
  const { ado, http } = setup()
  const size = await blobSize(http, ORG, KEY, 'b10b0001000000000000000000000000000000a2')
  assert.equal(size, Buffer.byteLength(ado.review.files[`${SOURCE_2}:/src/auth/redirect.ts`].content))
  assert.deepEqual(
    [ado.calls[0].method, ado.calls[0].path],
    ['GET', `/${ORG}/${PROJECT}/_apis/git/repositories/${REPO}/blobs/b10b0001000000000000000000000000000000a2`]
  )
  for (const broken of [{ objectId: 'x' }, { size: -1 }, { size: '12' }]) {
    ado.on(isBlob, () => json(200, broken))
    assert.equal((await failure(blobSize(http, ORG, KEY, 'x'))).message, MALFORMED.review)
  }
})
