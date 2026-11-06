import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { DiffText } from '../../src/shared/diff'
import type { OrgStatus } from '../../src/shared/types'
import type { WikiPageRef, WikiResult } from '../../src/shared/wiki'
import { createAdoHttp } from '../ado/http'
import { json, ORG, ORG_URL, PROJECT } from '../boards/fake-ado'
import { badRequest } from '../messages'
import { ME } from '../prs/fake-prs'
import { diffText } from '../reviews/diff'
import { memoryStore } from '../test-support'
import type { HostCall } from '../workspace/focused'
import { listing } from './draft-test-support'
import { createDrafts, type Drafts, type StoredDraft } from './drafts'
import { fakeWiki, isPage, isPagePut } from './fake-wiki'
import { createPublisher } from './publish'
import { createWikiService } from './service'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const MINUTE = 60_000
const WIKI = '6b7c8d9e-8888-4a1b-9c2d-3e4f5a6b7c8d'
const CHECKLIST = '/Release process/Checklist'
const CHECKLIST_ETAG = '"5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e"'
const THEIR_ETAG = '"7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"'
const KEY = `${ORG}:${WIKI}:${CHECKLIST}`
const REF: WikiPageRef = { org: ORG, projectId: PROJECT, wikiId: WIKI, path: CHECKLIST }
const DRAFT_FILE = 'wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const BASE_FILE = 'wiki/.base/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const THEIRS_FILE = 'wiki/.theirs/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const SMOKE = '2. Run the smoke tests.'
const TAG = '3. Tag the release.'

const PUBLISHED = 'Published.'
const PUBLISHED_OVER = 'Published. Their changes were replaced.'
const NOTHING_TO_PUBLISH = 'Nothing to publish yet. Save your changes in the editor first.'
const CONFLICT = 'Someone changed this page in Azure DevOps after you started editing.'
const MERGE_NOT_SAVED = "Your draft hasn't changed since their version opened. Copy what you need into it and save, or choose Publish mine."
const GONE_KEPT = 'This page was moved or deleted in Azure DevOps. Your draft is kept.'
const FILE_GONE = 'The draft file is gone. Press Edit to start again.'
const BASE_GONE = "The draft's base copy is gone, so it can't be compared. Your draft is kept."
const DRAFT_GONE = 'That draft no longer exists.'
const BUSY = 'This draft is already being published.'
const TOOK_THEIRS = 'Your draft now holds their version.'
const TOO_LARGE = 'This page is too large to edit here. Edit it in Azure DevOps.'
const NEEDS_READ = 'The wiki needs Wiki (Read) access.'
const NOT_CONNECTED = 'Connect this organization first.'
const OUTSIDE = 'The wiki draft folder leads outside this workspace, so nothing was written.'
const NOT_UPDATED = `Your draft couldn't be updated to match: ${OUTSIDE}`
const OPENED_THEIRS = `Opened their version as .orca-ado/${THEIRS_FILE}. Copy what you need into your draft, save it, then press Publish.`
const STALE = 'TF401028: The page was changed by someone else since you last read it.'

function status(): OrgStatus {
  return {
    org: ORG,
    url: ORG_URL,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId: null, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

function harness(dir: string) {
  const ado = fakeWiki()
  const http = createAdoHttp({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => ado.fetch(input, init)) as typeof globalThis.fetch,
    authHeader: async () => 'Bearer test-credential',
    sleep: async () => {}
  })
  let now = T0
  let orgs = [status()]
  const wiki = createWikiService({ http, orgs: async () => structuredClone(orgs), now: () => now })
  wiki.onOrgs(structuredClone(orgs))
  const opened: { workspaceId: string; path: string }[] = []
  const call: HostCall = async (method, params) => {
    if (method === 'workspace.readContext') return { branch: 'main', displayName: 'web-app', terminals: [] }
    if (method === 'workspace.list') {
      return { workspaces: [{ id: 'ws-web', kind: 'worktree', name: 'web-app', path: dir, branch: 'main', hostId: null }], truncated: false }
    }
    if (method === 'editor.open') {
      opened.push(params as { workspaceId: string; path: string })
      return { opened: true }
    }
    throw new Error(`unexpected host call ${method}`)
  }
  const memory = memoryStore()
  const drafts = createDrafts({ store: memory.store, fs, call, wiki, now: () => now })
  const publisherOf = (over: Partial<Drafts> = {}) => createPublisher({ http, drafts: { ...drafts, ...over }, wiki, now: () => now })
  const original = ado.pages.get(CHECKLIST)!.content
  let start = 0
  const since = () => ado.calls.slice(start)
  return {
    ado,
    opened,
    drafts,
    publisher: publisherOf(),
    publisherOf,
    original,
    mine: original.replace(TAG, `${TAG}\n4. Announce it in #releases.`),
    theirs: original.replace(SMOKE, '2. Run the smoke and load tests.'),
    mark() {
      start = ado.calls.length
    },
    calls: () => since().length,
    reads: () => since().filter(isPage).length,
    puts: () => since().filter(isPagePut),
    advance(ms: number) {
      now += ms
    },
    signOut() {
      orgs = []
      wiki.onOrgs([])
    },
    theirEdit(content: string, etag = THEIR_ETAG) {
      Object.assign(ado.pages.get(CHECKLIST)!, { content, etag })
    },
    page: () => ado.pages.get(CHECKLIST),
    save: (text: string) => fs.writeFile(onDisk(dir, DRAFT_FILE), text),
    file: (name: string) => fs.readFile(onDisk(dir, name), 'utf8'),
    record: () => drafts.get(KEY)
  }
}

type Harness = ReturnType<typeof harness>

async function withDraft(run: (h: Harness, dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-test-'))
  try {
    const h = harness(dir)
    assert.equal((await h.drafts.edit(REF)).opened, true)
    h.opened.length = 0
    h.mark()
    await run(h, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function onDisk(dir: string, name: string): string {
  return path.join(dir, '.orca-ado', ...name.split('/'))
}

function diffOf(before: string, after: string): DiffText {
  const { text, message } = diffText(before, after)
  return message === undefined ? { text } : { text, message }
}

function conflict(message: string, base: string, theirs: string, mine: string): WikiResult {
  return { status: 'conflict', message, theirs: diffOf(base, theirs), mine: diffOf(base, mine) }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function versionOf(draft: StoredDraft | null): Pick<StoredDraft, 'version' | 'publishedAt' | 'mergeMark'> | null {
  return draft && { version: draft.version, publishedAt: draft.publishedAt, mergeMark: draft.mergeMark }
}

function stale(status: number): Response {
  return json(status, { message: STALE })
}

async function until(reached: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!reached() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
}

test('publish never overwrites a page that changed since the draft began', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    const result = await h.publisher.publish(KEY)
    assert.deepEqual(result, conflict(CONFLICT, h.original, h.theirs, h.mine), "someone else's edit is a conflict")
    assert.ok(result.status === 'conflict' && result.theirs.text?.includes('+') && result.theirs.text.includes('Run the smoke and load tests.'))
    assert.ok(result.status === 'conflict' && result.mine.text?.includes('Announce it in #releases.'))
    assert.deepEqual([h.reads(), h.puts().length], [1, 0], 'one read and no PUT')
    assert.deepEqual([h.page()?.content, await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.theirs, h.mine, h.original])
    assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
  })

  for (const answer of [412, 409]) {
    await withDraft(async h => {
      await h.save(h.mine)
      h.ado.on(isPagePut, () => {
        h.theirEdit(h.theirs)
        return stale(answer)
      })
      const result = await h.publisher.publish(KEY)
      assert.deepEqual(result, conflict(CONFLICT, h.original, h.theirs, h.mine), `a race answered ${answer} is a conflict`)
      assert.deepEqual([h.reads(), h.puts().length], [2, 1], `${answer}: exactly one PUT and two reads`)
      assert.equal(h.puts()[0].headers.get('if-match'), CHECKLIST_ETAG)
      assert.deepEqual([h.page()?.content, await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.theirs, h.mine, h.original])
      assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
    })
  }

  await withDraft(async h => {
    await h.save(h.mine)
    h.ado.on(isPagePut, () => {
      h.ado.pages.delete(CHECKLIST)
      return stale(412)
    })
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: GONE_KEPT }, 'a page deleted during the race fails and keeps the draft')
    assert.deepEqual([h.reads(), h.puts().length], [2, 1])
    assert.deepEqual([await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.mine, h.original])
    assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.ado.on(isPagePut, () => {
      h.ado.on(isPage, () => json(403, { message: 'TF400813: The user is not authorized to access this resource.' }))
      return stale(412)
    })
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: NEEDS_READ }, 'a second read that fails reports its message')
    assert.deepEqual([h.reads(), h.puts().length], [2, 1])
    assert.deepEqual([h.page()?.content, await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.original, h.mine, h.original])
    assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.original)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'published', message: PUBLISHED }, 'an ETag change with no content change publishes')
    assert.deepEqual([h.reads(), h.puts().length], [1, 1])
    assert.equal(h.puts()[0].headers.get('if-match'), THEIR_ETAG, 'the PUT carries the fresh ETag')
    assert.equal(h.page()?.content, h.mine)
    assert.deepEqual(versionOf(await h.record()), { version: h.page()?.etag, publishedAt: T0, mergeMark: null })
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.ado.pages.delete(CHECKLIST)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: GONE_KEPT }, 'a deleted page fails and keeps the draft')
    assert.deepEqual([h.reads(), h.puts().length], [1, 0])
    assert.deepEqual([await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.mine, h.original], 'the draft file is unchanged')
    assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'merge' }), { status: 'updated', message: OPENED_THEIRS })
    h.mark()
    assert.deepEqual(
      await h.publisher.publish(KEY),
      conflict(MERGE_NOT_SAVED, h.theirs, h.theirs, h.mine),
      'Publish right after Merge by hand, with the draft unchanged, is still a conflict'
    )
    assert.deepEqual([h.reads(), h.puts().length], [1, 0])
    assert.equal(h.page()?.content, h.theirs)

    const merged = h.theirs.replace(TAG, `${TAG}\n4. Announce it in #releases.`)
    await h.save(merged)
    h.advance(MINUTE)
    h.mark()
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'published', message: PUBLISHED }, 'the saved merge publishes')
    assert.deepEqual([h.reads(), h.puts().length], [1, 1])
    assert.equal(h.puts()[0].headers.get('if-match'), THEIR_ETAG)
    assert.equal(h.page()?.content, merged)
    assert.deepEqual(versionOf(await h.record()), { version: h.page()?.etag, publishedAt: T0 + MINUTE, mergeMark: null })
  })
})

test('publish sends the draft with If-Match and rebases the draft on what it published', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.advance(MINUTE)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'published', message: PUBLISHED })
    assert.deepEqual([h.reads(), h.puts().length], [1, 1])
    const [put] = h.puts()
    assert.deepEqual([put.query.get('path'), put.headers.get('if-match'), put.body], [CHECKLIST, CHECKLIST_ETAG, { content: h.mine }])
    assert.equal(h.page()?.content, h.mine)
    assert.notEqual(h.page()?.etag, CHECKLIST_ETAG)
    assert.deepEqual(versionOf(await h.record()), { version: h.page()?.etag, publishedAt: T0 + MINUTE, mergeMark: null })
    assert.deepEqual([await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.mine, h.mine])
    assert.deepEqual((await h.drafts.list(ORG)).map(draft => [draft.changed, draft.publishedAt]), [[false, T0 + MINUTE]])

    h.mark()
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'unchanged', message: NOTHING_TO_PUBLISH }, 'the same text again is unchanged')
    assert.equal(h.calls(), 0, 'nothing to publish makes no call')
  })

  await withDraft(async h => {
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'unchanged', message: NOTHING_TO_PUBLISH }, 'an untouched draft is unchanged')
    await h.save(`${h.mine}${'x'.repeat(1024 * 1024)}`)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: TOO_LARGE }, 'a draft over 1 MiB is refused')
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'failed', message: TOO_LARGE }, 'so is Publish mine')
    assert.equal(h.calls(), 0)
  })
})

test('a fresh read that fails reports its message and sends no PUT', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.ado.on(isPage, () => json(403, { message: 'TF400813: The user is not authorized to access this resource.' }))
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: NEEDS_READ })
    assert.deepEqual([h.reads(), h.puts().length], [1, 0])
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'failed', message: NEEDS_READ })
    assert.deepEqual([h.reads(), h.puts().length], [2, 0])
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.signOut()
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: NOT_CONNECTED })
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'failed', message: NOT_CONNECTED })
    assert.equal(h.calls(), 0, 'a signed-out org sends nothing')
    assert.equal(await h.file(DRAFT_FILE), h.mine)
  })
})

test('a second publish of the same draft while one runs makes no calls', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    const held = h.ado.hold(isPage)
    const first = h.publisher.publish(KEY)
    await until(() => h.reads() > 0)
    assert.equal(h.calls(), 1)
    for (const second of [
      () => h.publisher.publish(KEY),
      () => h.publisher.resolve({ key: KEY, choice: 'mine' }),
      () => h.publisher.resolve({ key: KEY, choice: 'theirs' }),
      () => h.publisher.resolve({ key: KEY, choice: 'merge' })
    ]) {
      assert.deepEqual(await second(), { status: 'failed', message: BUSY })
    }
    assert.equal(h.calls(), 1, 'the second presses made no call')
    assert.deepEqual(h.opened, [])
    held.release()
    assert.deepEqual(await first, { status: 'published', message: PUBLISHED })
    assert.equal(h.puts().length, 1)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'unchanged', message: NOTHING_TO_PUBLISH }, 'the draft is free again')
  })
})

test('a missing draft file says so and forgets the draft', async () => {
  await withDraft(async (h, dir) => {
    assert.deepEqual(await h.publisher.publish('contoso:nowhere:/Gone'), { status: 'failed', message: DRAFT_GONE })
    await fs.unlink(onDisk(dir, DRAFT_FILE))
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: FILE_GONE })
    assert.equal(await h.record(), null, 'the draft is forgotten')
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: DRAFT_GONE })
    assert.equal(h.calls(), 0)
  })

  await withDraft(async (h, dir) => {
    await h.save(h.mine)
    await fs.unlink(onDisk(dir, BASE_FILE))
    const before = await h.record()
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: BASE_GONE }, 'a missing base is not a missing draft')
    assert.deepEqual(await h.record(), before, 'the draft is kept')
    assert.equal(h.calls(), 0)
    assert.equal(await h.file(DRAFT_FILE), h.mine)
    for (const choice of ['mine', 'theirs', 'merge'] as const) {
      assert.deepEqual(await h.publisher.resolve({ key: KEY, choice }), { status: 'failed', message: BASE_GONE }, `${choice}: a missing base`)
    }
    assert.deepEqual(await h.record(), before)
    assert.equal(h.calls(), 0)
    assert.deepEqual(h.opened, [])
    assert.deepEqual(await h.drafts.edit(REF), { opened: true, message: 'Opened Checklist in Orca. Save your changes there, then press Publish here.' }, 'Edit reopens the draft')
    assert.deepEqual([await h.file(DRAFT_FILE), h.opened.length], [h.mine, 1], 'and does not overwrite it')
    assert.equal(h.calls(), 0)
  })

  await withDraft(async (h, dir) => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-outside-'))
    try {
      await fs.writeFile(path.join(elsewhere, 'notes.md'), 'outside\n')
      await fs.unlink(onDisk(dir, DRAFT_FILE))
      await fs.symlink(path.join(elsewhere, 'notes.md'), onDisk(dir, DRAFT_FILE))
      const before = await h.record()
      assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message: OUTSIDE }, 'a draft leading outside is refused')
      assert.deepEqual(await h.record(), before, 'and kept')
      assert.deepEqual(await listing(elsewhere), ['notes.md: outside\n'])
      assert.equal(h.calls(), 0)
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })
})

test('Publish mine replaces their version with one PUT', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    assert.equal((await h.publisher.publish(KEY)).status, 'conflict')
    h.advance(MINUTE)
    h.mark()
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'published', message: PUBLISHED_OVER })
    assert.deepEqual([h.reads(), h.puts().length], [1, 1])
    assert.deepEqual([h.puts()[0].headers.get('if-match'), h.puts()[0].body], [THEIR_ETAG, { content: h.mine }])
    assert.equal(h.page()?.content, h.mine)
    assert.deepEqual(versionOf(await h.record()), { version: h.page()?.etag, publishedAt: T0 + MINUTE, mergeMark: null })
    assert.deepEqual([await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.mine, h.mine])
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    await h.publisher.resolve({ key: KEY, choice: 'merge' })
    assert.equal((await h.record())?.mergeMark, sha256(h.mine))
    h.mark()
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'published', message: PUBLISHED_OVER }, 'Publish mine right after Merge by hand')
    assert.equal(h.page()?.content, h.mine)
    assert.equal((await h.record())?.mergeMark, null)
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    const later = h.theirs.replace(TAG, '3. Tag the release and push the tag.')
    h.ado.on(isPagePut, () => {
      h.theirEdit(later, '"8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b"')
      return stale(412)
    })
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), conflict(CONFLICT, h.original, later, h.mine), 'a conflict answer is a conflict again')
    assert.deepEqual([h.reads(), h.puts().length], [2, 1])
    assert.deepEqual([h.page()?.content, await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [later, h.mine, h.original])
    assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
  })
})

test('Take theirs rewrites the draft and its base', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    await h.publisher.resolve({ key: KEY, choice: 'merge' })
    h.mark()
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'theirs' }), { status: 'updated', message: TOOK_THEIRS })
    assert.deepEqual([h.reads(), h.puts().length], [1, 0])
    assert.deepEqual([await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.theirs, h.theirs])
    assert.deepEqual(versionOf(await h.record()), { version: THEIR_ETAG, publishedAt: null, mergeMark: null })
    assert.equal(h.page()?.content, h.theirs)
    assert.deepEqual(await h.publisher.publish(KEY), { status: 'unchanged', message: NOTHING_TO_PUBLISH })
  })
})

test('Merge by hand opens their version and rebases on it', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'merge' }), { status: 'updated', message: OPENED_THEIRS })
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-web', path: `.orca-ado/${THEIRS_FILE}` }])
    assert.deepEqual([h.reads(), h.puts().length], [1, 0])
    assert.deepEqual([await h.file(THEIRS_FILE), await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.theirs, h.mine, h.theirs])
    assert.deepEqual(versionOf(await h.record()), { version: THEIR_ETAG, publishedAt: null, mergeMark: sha256(h.mine) })
    assert.equal(h.page()?.content, h.theirs)
  })
})

test('resolve refuses a missing draft, a missing file and a deleted page before any write', async () => {
  for (const choice of ['mine', 'theirs', 'merge'] as const) {
    await withDraft(async (h, dir) => {
      assert.deepEqual(await h.publisher.resolve({ key: 'contoso:nowhere:/Gone', choice }), { status: 'failed', message: DRAFT_GONE }, `${choice}: no draft`)

      await h.save(h.mine)
      h.ado.pages.delete(CHECKLIST)
      const before = await listing(path.join(dir, '.orca-ado'))
      assert.deepEqual(await h.publisher.resolve({ key: KEY, choice }), { status: 'failed', message: GONE_KEPT }, `${choice}: a deleted page`)
      assert.deepEqual(await listing(path.join(dir, '.orca-ado')), before, `${choice}: no file is written`)
      assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })

      await fs.unlink(onDisk(dir, DRAFT_FILE))
      assert.deepEqual(await h.publisher.resolve({ key: KEY, choice }), { status: 'failed', message: FILE_GONE }, `${choice}: no draft file`)
      assert.equal(await h.record(), null)
      assert.deepEqual([h.reads(), h.puts().length], [1, 0])
      assert.deepEqual(h.opened, [])
    })
  }
})

test('a refused PUT reports Azure DevOps\'s message and is not retried', async () => {
  const refusals: [number, string][] = [
    [403, 'TF401027: You need the Git Contribute permission to perform this action.'],
    [400, 'TF401398: The page content is not valid.'],
    [500, 'TF246017: Azure DevOps had an internal error.']
  ]
  for (const [answer, message] of refusals) {
    await withDraft(async h => {
      await h.save(h.mine)
      h.ado.on(isPagePut, () => json(answer, { message }))
      assert.deepEqual(await h.publisher.publish(KEY), { status: 'failed', message }, `${answer} is reported`)
      assert.deepEqual([h.reads(), h.puts().length], [1, 1], `${answer}: the refused write was not retried`)
      assert.deepEqual([h.page()?.content, await h.file(DRAFT_FILE), await h.file(BASE_FILE)], [h.original, h.mine, h.original])
      assert.deepEqual(versionOf(await h.record()), { version: CHECKLIST_ETAG, publishedAt: null, mergeMark: null })
      assert.deepEqual(await h.publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'failed', message }, `${answer}: Publish mine too`)
      assert.deepEqual([h.reads(), h.puts().length], [2, 2])
    })
  }
})

test('a page Azure DevOps accepted is reported as published even when the draft cannot follow', async () => {
  await withDraft(async h => {
    await h.save(h.mine)
    const publisher = h.publisherOf({
      rebase: async () => {
        throw badRequest(OUTSIDE)
      }
    })
    assert.deepEqual(await publisher.publish(KEY), { status: 'published', message: `${PUBLISHED} ${NOT_UPDATED}` })
    assert.equal(h.page()?.content, h.mine)
    assert.equal(h.puts().length, 1)
  })

  await withDraft(async h => {
    await h.save(h.mine)
    h.theirEdit(h.theirs)
    const publisher = h.publisherOf({
      rebase: async () => {
        throw badRequest(OUTSIDE)
      }
    })
    assert.deepEqual(await publisher.resolve({ key: KEY, choice: 'mine' }), { status: 'published', message: `${PUBLISHED_OVER} ${NOT_UPDATED}` })
    assert.equal(h.page()?.content, h.mine)
    assert.equal(h.puts().length, 1)
  })
})
