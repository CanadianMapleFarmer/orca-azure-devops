import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import { draftKey, type WikiPageRef } from '../../src/shared/wiki'
import { AdoError, createAdoHttp } from '../ado/http'
import { ORG, ORG_URL, PROJECT } from '../boards/fake-ado'
import { ME } from '../prs/fake-prs'
import { memoryStore } from '../test-support'
import type { HostCall, WorkspaceEntry } from '../workspace/focused'
import type { DraftFs } from './draft-files'
import { listing, outside } from './draft-test-support'
import { createDrafts, type StoredDraft } from './drafts'
import { fakeWiki, isPage } from './fake-wiki'
import { createWikiService } from './service'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const MINUTE = 60_000
const WIKI = '6b7c8d9e-8888-4a1b-9c2d-3e4f5a6b7c8d'
const CODE_WIKI = '7c8d9e0f-8888-4b2c-8d3e-4f5a6b7c8d9e'
const WIKI_NAME = 'Fabrikam Web.wiki'
const CHECKLIST = '/Release process/Checklist'
const CHECKLIST_ETAG = '"5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e"'
const UNICODE = '/Résumé/Überblick 文档'
const DRAFTS = '.orca-ado/wiki/contoso/Fabrikam Web.wiki'
const CHECKLIST_FILE = 'wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const CHECKLIST_BASE = 'wiki/.base/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const CHECKLIST_THEIRS = 'wiki/.theirs/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const EMOJI = '😀'
const HASHED = /~[0-9a-f]{8}\.md$/

const OPENED_CHECKLIST = 'Opened Checklist in Orca. Save your changes there, then press Publish here.'
const READ_ONLY = 'This wiki is published from a repository. Edit its files there.'
const PAGE_GONE = 'This page was moved or deleted in Azure DevOps.'
const NO_WORKSPACE = 'Open a local workspace first; wiki pages open in a tab there.'
const TOO_LARGE = 'This page is too large to edit here. Edit it in Azure DevOps.'
const TOO_MANY = 'You have 50 wiki drafts. Publish or discard some first.'
const FILE_TAKEN = 'Another draft already uses that file name. Publish or discard it first.'
const WORKSPACE_GONE = 'The workspace holding this draft is gone. Discard the draft to edit the page again.'
const DISCARDED = 'Draft discarded.'
const DRAFT_GONE = 'That draft no longer exists.'
const NOT_REMOVED = "Couldn't remove a wiki draft file."

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

function workspace(id: string, dir: string, name = 'web-app', branch = 'main', hostId: string | null = null): WorkspaceEntry {
  return { id, kind: 'worktree', name, path: dir, branch, hostId }
}

function harness(workspaces: WorkspaceEntry[], memory = memoryStore(), files: DraftFs = fs) {
  const ado = fakeWiki()
  const http = createAdoHttp({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => ado.fetch(input, init)) as typeof globalThis.fetch,
    authHeader: async () => 'Bearer test-credential',
    sleep: async () => {}
  })
  let now = T0
  const wiki = createWikiService({ http, orgs: async () => [status()], now: () => now })
  wiki.onOrgs([status()])
  const host: { workspaces: WorkspaceEntry[]; focused: string | null } = { workspaces, focused: workspaces[0]?.id ?? null }
  const opened: { workspaceId: string; path: string }[] = []
  const logs: string[] = []
  const call: HostCall = async (method, params) => {
    if (method === 'workspace.readContext') {
      const focused = host.workspaces.find(entry => entry.id === host.focused)
      return focused ? { branch: focused.branch, displayName: focused.name, terminals: [] } : null
    }
    if (method === 'workspace.list') return { workspaces: structuredClone(host.workspaces), truncated: false }
    if (method === 'editor.open') {
      opened.push(params as { workspaceId: string; path: string })
      return { opened: true }
    }
    throw new Error(`unexpected host call ${method}`)
  }
  const start = () => createDrafts({ store: memory.store, fs: files, call, wiki, now: () => now, log: message => logs.push(message) })
  return {
    ado,
    host,
    opened,
    logs,
    data: memory.data,
    drafts: start(),
    restart: start,
    advance(ms: number) {
      now += ms
    }
  }
}

function ref(pagePath: string, wikiId = WIKI): WikiPageRef {
  return { org: ORG, projectId: PROJECT, wikiId, path: pagePath }
}

function onDisk(dir: string, name: string): string {
  return path.join(dir, '.orca-ado', ...name.split('/'))
}

function stored(data: Record<string, unknown>): StoredDraft[] {
  return data['wiki:drafts'] as StoredDraft[]
}

async function withDirs(count: number, run: (dirs: string[]) => Promise<void>): Promise<void> {
  const dirs: string[] = []
  try {
    for (let i = 0; i < count; i += 1) dirs.push(await fs.mkdtemp(path.join(os.tmpdir(), 'drafts-test-')))
    await run(dirs)
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
  }
}

function missing(label: string): (error: unknown) => boolean {
  return error => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT', label)
    return true
  }
}

function seededDraft(i: number): StoredDraft {
  const org = i % 2 === 0 ? ORG : 'fabrikam'
  const pagePath = `/Page ${i}`
  return {
    key: `${org}:${WIKI}:${pagePath}`,
    org,
    projectId: PROJECT,
    wikiId: WIKI,
    wikiName: WIKI_NAME,
    path: pagePath,
    version: '"1"',
    workspaceId: 'ws-elsewhere',
    workspacePath: '/nonexistent/workspace',
    workspaceName: 'elsewhere',
    file: `wiki/${org}/Fabrikam Web.wiki/Page ${i}.md`,
    startedAt: T0 - (i + 1) * MINUTE,
    publishedAt: null,
    mergeMark: null
  }
}

interface Plant {
  label: string
  refusesTheirs: boolean
  before(workspace: string, outsideDir: string): Promise<void>
  after(workspace: string, outsideDir: string): Promise<void>
}

const PLANTS: Plant[] = [
  {
    label: 'a .orca-ado symlink',
    refusesTheirs: true,
    before: (workspace, outsideDir) => fs.symlink(outsideDir, path.join(workspace, '.orca-ado')),
    async after(workspace, outsideDir) {
      await fs.rename(path.join(workspace, '.orca-ado'), path.join(outsideDir, 'orca-ado'))
      await fs.symlink(path.join(outsideDir, 'orca-ado'), path.join(workspace, '.orca-ado'))
    }
  },
  {
    label: 'a .orca-ado/wiki symlink',
    refusesTheirs: true,
    async before(workspace, outsideDir) {
      await fs.mkdir(path.join(workspace, '.orca-ado'))
      await fs.symlink(outsideDir, path.join(workspace, '.orca-ado', 'wiki'))
    },
    async after(workspace, outsideDir) {
      await fs.rename(path.join(workspace, '.orca-ado', 'wiki'), path.join(outsideDir, 'wiki'))
      await fs.symlink(path.join(outsideDir, 'wiki'), path.join(workspace, '.orca-ado', 'wiki'))
    }
  },
  {
    label: 'a .orca-ado/wiki/.base symlink',
    refusesTheirs: false,
    async before(workspace, outsideDir) {
      await fs.mkdir(path.join(workspace, '.orca-ado', 'wiki'), { recursive: true })
      await fs.symlink(outsideDir, path.join(workspace, '.orca-ado', 'wiki', '.base'))
    },
    async after(workspace, outsideDir) {
      await fs.rename(path.join(workspace, '.orca-ado', 'wiki', '.base'), path.join(outsideDir, 'base'))
      await fs.symlink(path.join(outsideDir, 'base'), path.join(workspace, '.orca-ado', 'wiki', '.base'))
    }
  },
  {
    label: 'a draft file that is a symlink to an outside file',
    refusesTheirs: false,
    async before(workspace, outsideDir) {
      const draft = onDisk(workspace, CHECKLIST_FILE)
      await fs.mkdir(path.dirname(draft), { recursive: true })
      await fs.writeFile(path.join(outsideDir, 'secret.md'), 'secret\n')
      await fs.symlink(path.join(outsideDir, 'secret.md'), draft)
    },
    async after(workspace, outsideDir) {
      const draft = onDisk(workspace, CHECKLIST_FILE)
      await fs.rename(draft, path.join(outsideDir, 'secret.md'))
      await fs.symlink(path.join(outsideDir, 'secret.md'), draft)
    }
  }
]

test('draft file names stay inside the wiki folder and are valid on every OS', async () => {
  await withDirs(2, async ([web, docs]) => {
    const h = harness([workspace('ws-web', web), workspace('ws-docs', docs, 'web-app-docs', 'docs')])
    const long = `/${EMOJI.repeat(150)}`
    const deepA = `/${'Section '.repeat(9)}/${'Chapter '.repeat(9)}/${'Part '.repeat(14)}/Appendix A`
    const deepB = `/${'Section '.repeat(9)}/${'Chapter '.repeat(9)}/${'Part '.repeat(14)}/Appendix B`
    const pages = ['/../../etc/passwd', '/Q&A: what?', '/CON', '/Notes...', long, deepA, deepB, '/X', '/X.theirs', '/Foo', '/foo', '/a:b', '/a?b']
    for (const page of pages) h.ado.pages.set(page, { content: `# ${page}\n`, etag: '"1"' })
    const openedAt = async (page: string) => {
      const result = await h.drafts.edit(ref(page))
      assert.equal(result.opened, true, `${page}: ${result.message}`)
      return h.opened.at(-1)!.path
    }

    assert.equal(await openedAt('/../../etc/passwd'), `${DRAFTS}/_/_/etc/passwd.md`)
    assert.equal(await openedAt('/Q&A: what?'), `${DRAFTS}/Q&A- what-.md`)
    assert.equal(await openedAt('/CON'), `${DRAFTS}/_CON.md`)
    assert.equal(await openedAt('/Notes...'), `${DRAFTS}/Notes.md`)
    assert.equal(await openedAt(long), `${DRAFTS}/${EMOJI.repeat(40)}.md`)
    const deep = [await openedAt(deepA), await openedAt(deepB)]
    for (const opened of deep) {
      assert.ok(opened.length - '.orca-ado/'.length <= 200, opened)
      assert.match(opened, HASHED)
    }
    assert.notEqual(deep[0], deep[1])

    const x = await openedAt('/X')
    const xTheirs = await openedAt('/X.theirs')
    const theirs = await h.drafts.openTheirs((await h.drafts.get(draftKey(ref('/X'))))!, 'their X\n')
    assert.equal(xTheirs, `${DRAFTS}/X.theirs.md`)
    assert.equal(theirs, '.orca-ado/wiki/.theirs/contoso/Fabrikam Web.wiki/X.md')
    const text = (relative: string) => fs.readFile(path.join(web, relative), 'utf8')
    assert.deepEqual([await text(x), await text(xTheirs), await text(theirs)], ['# /X\n', '# /X.theirs\n', 'their X\n'])

    assert.equal(await openedAt('/Foo'), `${DRAFTS}/Foo.md`)
    assert.deepEqual(await h.drafts.edit(ref('/foo')), { opened: false, message: FILE_TAKEN })
    assert.equal(await openedAt('/a:b'), `${DRAFTS}/a-b.md`)
    assert.deepEqual(await h.drafts.edit(ref('/a?b')), { opened: false, message: FILE_TAKEN })
    assert.equal(await h.drafts.get(draftKey(ref('/foo'))), null)

    h.host.focused = 'ws-docs'
    assert.equal(await openedAt('/foo'), `${DRAFTS}/foo.md`)
    assert.equal(await openedAt('/a?b'), `${DRAFTS}/a-b.md`)
    assert.deepEqual(
      h.opened.slice(-2).map(entry => entry.workspaceId),
      ['ws-docs', 'ws-docs'],
      'the same file name is allowed in another workspace'
    )

    for (const dir of [web, docs]) {
      assert.deepEqual(await fs.readdir(dir), ['.orca-ado'])
      for (const entry of await listing(path.join(dir, '.orca-ado'))) assert.ok(entry === 'wiki/' || entry.startsWith('wiki/') || entry === '.gitignore: *\n', entry)
    }
  })

  for (const plant of PLANTS) {
    await withDirs(2, async ([web, outsideDir]) => {
      await fs.writeFile(path.join(outsideDir, 'notes.md'), 'outside\n')
      const h = harness([workspace('ws-web', web)])
      await plant.before(web, outsideDir)
      const before = [await listing(outsideDir), await listing(web)]
      await assert.rejects(h.drafts.edit(ref(CHECKLIST)), outside(plant.label))
      assert.deepEqual([await listing(outsideDir), await listing(web)], before, `${plant.label}: nothing is written, outside or in the workspace`)
      assert.deepEqual(h.opened, [])
      assert.deepEqual(await h.drafts.list(ORG), [])
    })

    await withDirs(2, async ([web, outsideDir]) => {
      await fs.writeFile(path.join(outsideDir, 'notes.md'), 'outside\n')
      const h = harness([workspace('ws-web', web)])
      assert.equal((await h.drafts.edit(ref(CHECKLIST))).opened, true)
      const draft = (await h.drafts.get(draftKey(ref(CHECKLIST))))!
      await plant.after(web, outsideDir)
      const before = await listing(outsideDir)
      await assert.rejects(h.drafts.edit(ref(CHECKLIST)), outside(`${plant.label}, after the draft began`))
      await assert.rejects(h.drafts.texts(draft), outside(`${plant.label}: texts`))
      await assert.rejects(h.drafts.rebase(draft, { version: '"2"', base: 'new base\n', mine: 'new mine\n' }), outside(`${plant.label}: rebase`))
      if (plant.refusesTheirs) await assert.rejects(h.drafts.openTheirs(draft, 'theirs\n'), outside(`${plant.label}: openTheirs`))
      assert.deepEqual(await listing(outsideDir), before, `${plant.label}: nothing reaches the outside folder`)
      assert.deepEqual(await h.drafts.get(draft.key), draft, `${plant.label}: a refused rebase keeps the record as it was`)
      assert.deepEqual(
        (await h.drafts.list(ORG)).map(draft => draft.changed),
        [true],
        'a refused file counts as changed and the list still loads'
      )
      assert.deepEqual(await h.drafts.discard(draftKey(ref(CHECKLIST))), { ok: true, message: DISCARDED })
      assert.deepEqual(await listing(outsideDir), before, `${plant.label}: discard leaves the outside files in place`)
      assert.deepEqual(h.logs, [NOT_REMOVED], `${plant.label}: the refused removal is logged once`)
      assert.equal(h.opened.length, 1)
      assert.deepEqual(await h.drafts.list(ORG), [])
    })
  }
})

test('openTheirs refuses a theirs folder or file that leads outside the workspace', async () => {
  const plants: [string, (workspace: string, outsideDir: string) => Promise<void>][] = [
    [
      'a .orca-ado/wiki/.theirs symlink',
      async (workspace, outsideDir) => {
        await fs.mkdir(path.join(workspace, '.orca-ado', 'wiki'), { recursive: true })
        await fs.symlink(outsideDir, path.join(workspace, '.orca-ado', 'wiki', '.theirs'))
      }
    ],
    [
      'a theirs file that is a symlink to an outside file',
      async (workspace, outsideDir) => {
        const file = onDisk(workspace, CHECKLIST_THEIRS)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(path.join(outsideDir, 'secret.md'), 'secret\n')
        await fs.symlink(path.join(outsideDir, 'secret.md'), file)
      }
    ]
  ]
  for (const [label, plant] of plants) {
    await withDirs(2, async ([web, outsideDir]) => {
      const h = harness([workspace('ws-web', web)])
      assert.equal((await h.drafts.edit(ref(CHECKLIST))).opened, true)
      const draft = (await h.drafts.get(draftKey(ref(CHECKLIST))))!
      await plant(web, outsideDir)
      const before = await listing(outsideDir)
      await assert.rejects(h.drafts.openTheirs(draft, 'theirs\n'), outside(label))
      assert.deepEqual(await listing(outsideDir), before, `${label}: nothing reaches the outside folder`)
      assert.equal(h.opened.length, 1, `${label}: the theirs file is not opened`)
    })
  }
})

test('edit writes the page and its base into the focused workspace and opens it', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: true, message: OPENED_CHECKLIST })
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-web', path: '.orca-ado/wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md' }])
    const content = h.ado.pages.get(CHECKLIST)!.content
    assert.deepEqual(await listing(web), [
      '.orca-ado/',
      '.orca-ado/.gitignore: *\n',
      '.orca-ado/wiki/',
      '.orca-ado/wiki/.base/',
      '.orca-ado/wiki/.base/contoso/',
      '.orca-ado/wiki/.base/contoso/Fabrikam Web.wiki/',
      '.orca-ado/wiki/.base/contoso/Fabrikam Web.wiki/Release process/',
      `.orca-ado/wiki/.base/contoso/Fabrikam Web.wiki/Release process/Checklist.md: ${content}`,
      '.orca-ado/wiki/contoso/',
      '.orca-ado/wiki/contoso/Fabrikam Web.wiki/',
      '.orca-ado/wiki/contoso/Fabrikam Web.wiki/Release process/',
      `.orca-ado/wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md: ${content}`
    ])
    assert.deepEqual(stored(h.data), [
      {
        key: `contoso:${WIKI}:/Release process/Checklist`,
        org: ORG,
        projectId: PROJECT,
        wikiId: WIKI,
        wikiName: WIKI_NAME,
        path: CHECKLIST,
        version: CHECKLIST_ETAG,
        workspaceId: 'ws-web',
        workspacePath: web,
        workspaceName: 'web-app',
        file: CHECKLIST_FILE,
        startedAt: T0,
        publishedAt: null,
        mergeMark: null
      }
    ])
    assert.equal(draftKey(ref(CHECKLIST)), `contoso:${WIKI}:/Release process/Checklist`)
    assert.equal(h.ado.count(isPage), 1)
  })
})

test('a unicode page gets an NFC file name and keeps its page path', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    const nfd = UNICODE.normalize('NFD')
    assert.notEqual(nfd, UNICODE)
    h.ado.pages.set(nfd, structuredClone(h.ado.pages.get(UNICODE)!))
    assert.deepEqual(await h.drafts.edit(ref(nfd)), {
      opened: true,
      message: `Opened ${'Überblick 文档'.normalize('NFD')} in Orca. Save your changes there, then press Publish here.`
    })
    assert.equal(h.opened[0].path, `${DRAFTS}/Résumé/Überblick 文档.md`.normalize('NFC'))
    assert.equal(h.ado.calls.filter(isPage)[0].query.get('path'), nfd, 'Azure DevOps gets the path as given')
    assert.equal(stored(h.data)[0].path, nfd)
    assert.equal(stored(h.data)[0].file, 'wiki/contoso/Fabrikam Web.wiki/Résumé/Überblick 文档.md'.normalize('NFC'))
    assert.deepEqual(await fs.readdir(path.join(web, DRAFTS)), ['Résumé'.normalize('NFC')])
    assert.deepEqual(await fs.readdir(path.join(web, DRAFTS, 'Résumé')), ['Überblick 文档.md'.normalize('NFC')])
  })
})

test('edit reopens a changed draft as it is and refreshes an unchanged one', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    const draftFile = onDisk(web, CHECKLIST_FILE)
    const baseFile = onDisk(web, CHECKLIST_BASE)
    await h.drafts.edit(ref(CHECKLIST))
    const page = h.ado.pages.get(CHECKLIST)!
    Object.assign(page, { content: '# Release checklist v2\n', etag: '"v2"' })
    h.advance(MINUTE)

    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: true, message: OPENED_CHECKLIST })
    assert.deepEqual([await fs.readFile(draftFile, 'utf8'), await fs.readFile(baseFile, 'utf8')], ['# Release checklist v2\n', '# Release checklist v2\n'])
    assert.deepEqual([stored(h.data)[0].version, stored(h.data)[0].startedAt], ['"v2"', T0])

    await fs.writeFile(draftFile, 'mine\n')
    Object.assign(page, { content: '# Release checklist v3\n', etag: '"v3"' })
    const reads = h.ado.count(isPage)
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: true, message: OPENED_CHECKLIST })
    assert.deepEqual([await fs.readFile(draftFile, 'utf8'), await fs.readFile(baseFile, 'utf8')], ['mine\n', '# Release checklist v2\n'])
    assert.equal(stored(h.data)[0].version, '"v2"')
    assert.equal(h.ado.count(isPage), reads, 'a changed draft opens without a read')
    assert.equal(h.opened.length, 3)
    assert.ok(h.opened.every(entry => entry.path === `.orca-ado/${CHECKLIST_FILE}`))

    await fs.unlink(draftFile)
    h.advance(MINUTE)
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: true, message: OPENED_CHECKLIST })
    assert.deepEqual([await fs.readFile(draftFile, 'utf8'), await fs.readFile(baseFile, 'utf8')], ['# Release checklist v3\n', '# Release checklist v3\n'])
    assert.deepEqual(
      stored(h.data).map(draft => [draft.version, draft.startedAt]),
      [['"v3"', T0 + 2 * MINUTE]],
      'a draft whose file is gone starts again'
    )

    await h.drafts.edit(ref(UNICODE))
    h.ado.pages.delete(UNICODE)
    const before = await listing(web)
    const opened = h.opened.length
    assert.deepEqual(await h.drafts.edit(ref(UNICODE)), { opened: false, message: PAGE_GONE })
    assert.notEqual(await h.drafts.get(draftKey(ref(UNICODE))), null, 'the record is kept')
    assert.deepEqual(await listing(web), before)
    assert.equal(h.opened.length, opened)
  })
})

test('edit refuses code wikis, pages over 1 MiB, a 51st draft and no local workspace', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    assert.deepEqual(await h.drafts.edit(ref('/Overview', CODE_WIKI)), { opened: false, message: READ_ONLY })
    assert.equal(h.ado.count(isPage), 0)

    h.ado.pages.set('/Big', { content: `${'é'.repeat(512 * 1024)}x`, etag: '"big"' })
    assert.deepEqual(await h.drafts.edit(ref('/Big')), { opened: false, message: TOO_LARGE })
    h.ado.pages.set('/Just fits', { content: 'é'.repeat(512 * 1024), etag: '"fits"' })
    assert.equal((await h.drafts.edit(ref('/Just fits'))).opened, true)

    h.host.focused = null
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: false, message: NO_WORKSPACE })
    h.host.workspaces = [workspace('ws-remote', '/srv/web-app', 'web-app', 'main', 'ssh:build-box')]
    h.host.focused = 'ws-remote'
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: false, message: NO_WORKSPACE })

    assert.deepEqual(stored(h.data).map(draft => draft.path), ['/Just fits'])
    assert.deepEqual(
      (await listing(web)).filter(entry => entry.includes(': ')).map(entry => entry.split(': ')[0]),
      ['.orca-ado/.gitignore', '.orca-ado/wiki/.base/contoso/Fabrikam Web.wiki/Just fits.md', '.orca-ado/wiki/contoso/Fabrikam Web.wiki/Just fits.md']
    )
  })

  await withDirs(1, async ([web]) => {
    const memory = memoryStore({ 'wiki:drafts': Array.from({ length: 50 }, (_, i) => seededDraft(i)) })
    const h = harness([workspace('ws-web', web)], memory)
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: false, message: TOO_MANY })
    assert.equal(stored(h.data).length, 50)
    assert.deepEqual(await fs.readdir(web), [])
    await h.drafts.discard(seededDraft(1).key)
    assert.equal((await h.drafts.edit(ref(CHECKLIST))).opened, true, 'the limit counts drafts across orgs')
  })
})

test('a draft whose workspace is gone says so', async () => {
  await withDirs(2, async ([web, docs]) => {
    const h = harness([workspace('ws-web', web), workspace('ws-docs', docs, 'web-app-docs', 'docs')])
    await h.drafts.edit(ref(CHECKLIST))
    h.host.workspaces = [workspace('ws-docs', docs, 'web-app-docs', 'docs')]
    h.host.focused = 'ws-docs'
    const before = await listing(web)
    assert.deepEqual(await h.drafts.edit(ref(CHECKLIST)), { opened: false, message: WORKSPACE_GONE })
    assert.equal(stored(h.data).length, 1)
    assert.equal(h.opened.length, 1)
    assert.deepEqual(await listing(web), before)
    assert.deepEqual(await fs.readdir(docs), [])
  })
})

test("drafts lists this org's drafts with whether they changed", async () => {
  await withDirs(1, async ([web]) => {
    const memory = memoryStore({ 'wiki:drafts': [seededDraft(1)] })
    const h = harness([workspace('ws-web', web)], memory)
    h.ado.pages.set('/Onboarding', { content: '# Onboarding\n', etag: '"o1"' })
    await h.drafts.edit(ref(CHECKLIST))
    h.advance(MINUTE)
    await h.drafts.edit(ref(UNICODE))
    h.advance(MINUTE)
    await h.drafts.edit(ref('/Onboarding'))
    await fs.writeFile(onDisk(web, CHECKLIST_FILE), 'mine\n')
    await fs.unlink(onDisk(web, 'wiki/contoso/Fabrikam Web.wiki/Onboarding.md'))

    const summary = (pagePath: string, file: string, title: string, changed: boolean) => ({
      org: ORG,
      projectId: PROJECT,
      wikiId: WIKI,
      path: pagePath,
      key: `contoso:${WIKI}:${pagePath}`,
      wikiName: WIKI_NAME,
      title,
      file,
      workspaceName: 'web-app',
      changed,
      publishedAt: null
    })
    assert.deepEqual(await h.drafts.list(ORG), [
      summary('/Onboarding', 'wiki/contoso/Fabrikam Web.wiki/Onboarding.md', 'Onboarding', true),
      summary(UNICODE, 'wiki/contoso/Fabrikam Web.wiki/Résumé/Überblick 文档.md', 'Überblick 文档', false),
      summary(CHECKLIST, CHECKLIST_FILE, 'Checklist', true)
    ])
    assert.deepEqual(
      (await h.drafts.list('fabrikam')).map(draft => [draft.path, draft.workspaceName, draft.changed]),
      [['/Page 1', 'elsewhere', true]]
    )
    assert.deepEqual(await h.drafts.list('northwind'), [])
  })
})

test('discard removes the record and its files', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    await h.drafts.edit(ref(CHECKLIST))
    await h.drafts.edit(ref(UNICODE))
    await h.drafts.openTheirs((await h.drafts.get(draftKey(ref(CHECKLIST))))!, 'theirs\n')
    assert.deepEqual(await h.drafts.discard(draftKey(ref(CHECKLIST))), { ok: true, message: DISCARDED })
    for (const name of [CHECKLIST_FILE, CHECKLIST_BASE, CHECKLIST_THEIRS]) {
      await assert.rejects(fs.lstat(onDisk(web, name)), missing(name))
    }
    assert.equal(await h.drafts.get(draftKey(ref(CHECKLIST))), null)
    assert.deepEqual(stored(h.data).map(draft => draft.path), [UNICODE])

    await assert.rejects(h.drafts.discard(draftKey(ref(CHECKLIST))), (error: unknown) => {
      assert.ok(error instanceof AdoError)
      assert.deepEqual([error.code, error.message], ['bad_request', DRAFT_GONE])
      return true
    })

    await fs.rm(path.join(web, '.orca-ado', 'wiki'), { recursive: true })
    assert.deepEqual(await h.drafts.discard(draftKey(ref(UNICODE))), { ok: true, message: DISCARDED }, 'missing files are ignored')
    assert.deepEqual(stored(h.data), [])
    assert.deepEqual(h.logs, [])
  })
})

test('a file that cannot be removed is logged and discard still succeeds', async () => {
  await withDirs(1, async ([web]) => {
    const busy: DraftFs = {
      ...fs,
      rm: async () => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
    }
    const h = harness([workspace('ws-web', web)], memoryStore(), busy)
    await h.drafts.edit(ref(CHECKLIST))
    assert.deepEqual(await h.drafts.discard(draftKey(ref(CHECKLIST))), { ok: true, message: DISCARDED })
    assert.equal(await h.drafts.get(draftKey(ref(CHECKLIST))), null)
    assert.ok(await fs.readFile(onDisk(web, CHECKLIST_FILE), 'utf8'))
    assert.deepEqual(h.logs, [NOT_REMOVED])
  })
})

test('drafts survive a restart', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    await h.drafts.edit(ref(CHECKLIST))
    const record = stored(h.data)[0]
    await fs.writeFile(onDisk(web, CHECKLIST_FILE), 'mine\n')

    const restarted = h.restart()
    assert.deepEqual(await restarted.get(record.key), record)
    assert.deepEqual(
      (await restarted.list(ORG)).map(draft => [draft.key, draft.changed]),
      [[record.key, true]]
    )
    const reads = h.ado.count(isPage)
    assert.deepEqual(await restarted.edit(ref(CHECKLIST)), { opened: true, message: OPENED_CHECKLIST })
    assert.equal(await fs.readFile(onDisk(web, CHECKLIST_FILE), 'utf8'), 'mine\n')
    assert.equal(h.ado.count(isPage), reads)
    assert.deepEqual(stored(h.data), [record])
  })
})

test('edits pressed together keep every draft', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    const results = await Promise.all([h.drafts.edit(ref(CHECKLIST)), h.drafts.edit(ref(UNICODE)), h.drafts.edit(ref(CHECKLIST))])
    assert.deepEqual(
      results.map(result => result.opened),
      [true, true, true]
    )
    assert.deepEqual(stored(h.data).map(draft => draft.path), [CHECKLIST, UNICODE])
  })
})

test('texts, rebase, openTheirs and forget keep the files and the record in step', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace('ws-web', web)])
    await h.drafts.edit(ref(CHECKLIST))
    const content = h.ado.pages.get(CHECKLIST)!.content
    const draft = (await h.drafts.get(draftKey(ref(CHECKLIST))))!
    assert.deepEqual(await h.drafts.texts(draft), { mine: content, base: content })

    await fs.writeFile(onDisk(web, CHECKLIST_FILE), 'mine\n')
    await h.drafts.rebase(draft, { version: '"v2"', base: 'theirs\n', mergeMark: 'mark' })
    assert.deepEqual(await h.drafts.texts(draft), { mine: 'mine\n', base: 'theirs\n' })
    assert.deepEqual(pick(stored(h.data)[0]), { version: '"v2"', publishedAt: null, mergeMark: 'mark' })

    await h.drafts.rebase(draft, { version: '"v3"', base: 'mine\n', publishedAt: T0 + MINUTE })
    assert.deepEqual(pick(stored(h.data)[0]), { version: '"v3"', publishedAt: T0 + MINUTE, mergeMark: null })
    await h.drafts.rebase(draft, { version: '"v4"', base: 'theirs\n', mine: 'theirs\n' })
    assert.deepEqual(await h.drafts.texts(draft), { mine: 'theirs\n', base: 'theirs\n' })
    assert.deepEqual(pick(stored(h.data)[0]), { version: '"v4"', publishedAt: T0 + MINUTE, mergeMark: null })

    const opened = await h.drafts.openTheirs(draft, 'their version\n')
    assert.equal(opened, `.orca-ado/${CHECKLIST_THEIRS}`)
    assert.deepEqual(h.opened.at(-1), { workspaceId: 'ws-web', path: opened })
    assert.equal(await fs.readFile(onDisk(web, CHECKLIST_THEIRS), 'utf8'), 'their version\n')

    assert.equal(await h.drafts.hasFile(draft), true)
    await fs.unlink(onDisk(web, CHECKLIST_BASE))
    assert.equal(await h.drafts.texts(draft), null, 'a missing base gives no texts')
    assert.equal(await h.drafts.hasFile(draft), true, 'a missing base leaves the draft file')
    await fs.unlink(onDisk(web, CHECKLIST_FILE))
    assert.equal(await h.drafts.texts(draft), null, 'a missing draft gives no texts')
    assert.equal(await h.drafts.hasFile(draft), false, 'a missing draft file is reported')

    await h.drafts.forget(draft.key)
    assert.equal(await h.drafts.get(draft.key), null)
    await h.drafts.rebase(draft, { version: '"v5"', base: 'late\n', mine: 'late\n' })
    await assert.rejects(fs.lstat(onDisk(web, CHECKLIST_FILE)), missing('a forgotten draft is not rewritten'))
    assert.deepEqual(stored(h.data), [])
  })
})

function pick(draft: StoredDraft): Pick<StoredDraft, 'version' | 'publishedAt' | 'mergeMark'> {
  return { version: draft.version, publishedAt: draft.publishedAt, mergeMark: draft.mergeMark }
}
