import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import type { WikiPage, WikiPageRef } from '../../src/shared/wiki'
import { AdoError, createAdoHttp } from '../ado/http'
import { ORG, ORG_URL, PROJECT } from '../boards/fake-ado'
import { createEntities } from '../data/entities'
import { ME } from '../prs/fake-prs'
import type { HostCall, WorkspaceEntry } from '../workspace/focused'
import { listing } from './draft-test-support'
import { fakeWiki, isPage } from './fake-wiki'
import { createReader, MAX_READER_BYTES, readerMarkdown, type ReaderFs } from './reader'
import { createWikiService } from './service'

const WIKI = '6b7c8d9e-8888-4a1b-9c2d-3e4f5a6b7c8d'
const CODE_WIKI = '7c8d9e0f-8888-4b2c-8d3e-4f5a6b7c8d9e'
const CHECKLIST = '/Release process/Checklist'
const COPY = 'wiki-read/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const CODE_COPY = 'wiki-read/contoso/api-docs/Release process/Checklist.md'
const DRAFT = 'wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md'
const ROLLBACK_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_wiki/wikis/Fabrikam%20Web.wiki?pagePath=%2FRelease%20process%2FRollback'
const BANNER = '*A read-only copy of Checklist. To change it, use Edit in Orca in the Azure DevOps sidebar.*'
const CODE_BANNER = '*A read-only copy of Checklist. To change it, edit the page in its repository.*'
const OPENED = 'Opened Checklist in a tab.'
const NO_WORKSPACE = 'Open a local workspace first; wiki pages open in a tab there.'
const TOO_LONG = '\n\n*This page is too long to show here in full. Open it in Azure DevOps to read the rest.*'
const PANEL_CUT_NOTE = 'The rest is in Azure DevOps.'
const READ_ONLY = 0o444
const READER_OUTSIDE = "The .orca-ado folder leads outside this workspace or is in the way, so the page wasn't opened."

const PAGE = [
  '# Release flow',
  '',
  '::: mermaid',
  'graph TD',
  '  Build --> Test',
  ':::',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Ada->>Grace: ship it',
  '```',
  '',
  'If something goes wrong, see [Rollback](/Release-process/Rollback).',
  ''
].join('\n')

const COPY_TEXT = [
  BANNER,
  '',
  '# Release flow',
  '',
  '```mermaid',
  'graph TD',
  '  Build --> Test',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Ada->>Grace: ship it',
  '```',
  '',
  `If something goes wrong, see [Rollback](${ROLLBACK_URL}).`,
  ''
].join('\n')

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

function workspace(dir: string, hostId: string | null = null): WorkspaceEntry {
  return { id: 'ws-web', kind: 'worktree', name: 'web-app', path: dir, branch: 'main', hostId }
}

function harness(workspaces: WorkspaceEntry[], files: ReaderFs = fs) {
  const ado = fakeWiki()
  const http = createAdoHttp({
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => ado.fetch(input, init)) as typeof globalThis.fetch,
    authHeader: async () => 'Bearer test-credential',
    sleep: async () => {}
  })
  const wiki = createWikiService({ http, orgs: async () => [status()], entities: createEntities(() => 0) })
  wiki.onOrgs([status()])
  const host = { focused: workspaces.length > 0 }
  const opened: { workspaceId: string; path: string }[] = []
  const call: HostCall = async (method, params) => {
    if (method === 'workspace.readContext') return host.focused ? { branch: 'main', displayName: 'web-app', terminals: [] } : null
    if (method === 'workspace.list') return { workspaces: structuredClone(workspaces), truncated: false }
    if (method === 'editor.open') {
      opened.push(params as { workspaceId: string; path: string })
      return { opened: true }
    }
    throw new Error(`unexpected host call ${method}`)
  }
  ado.pages.set(CHECKLIST, { content: PAGE, etag: '"2"' })
  return { ado, host, opened, reader: createReader({ wiki, call, fs: files }) }
}

function ref(pagePath: string, wikiId = WIKI): WikiPageRef {
  return { org: ORG, projectId: PROJECT, wikiId, path: pagePath }
}

function refused(label: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `${label}: expected an AdoError, got ${String(error)}`)
    assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, READER_OUTSIDE], label)
    return true
  }
}

function onDisk(dir: string, name: string): string {
  return path.join(dir, '.orca-ado', ...name.split('/'))
}

async function modeOf(file: string): Promise<number> {
  return (await fs.stat(file)).mode & 0o777
}

async function withDirs(count: number, run: (dirs: string[]) => Promise<void>): Promise<void> {
  const dirs: string[] = []
  try {
    for (let i = 0; i < count; i += 1) dirs.push(await fs.mkdtemp(path.join(os.tmpdir(), 'reader-test-')))
    await run(dirs)
  } finally {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
  }
}

function recording(): { files: ReaderFs; events: string[] } {
  const events: string[] = []
  const files: ReaderFs = {
    ...fs,
    writeFile: (async (file: string, data: string, options?: { flag?: string }) => {
      events.push(`write ${path.basename(file)}`)
      return fs.writeFile(file, data, options)
    }) as ReaderFs['writeFile'],
    chmod: (async (file: string, mode: number) => {
      events.push(`chmod ${path.basename(file)} ${mode.toString(8)}`)
      return fs.chmod(file, mode)
    }) as ReaderFs['chmod']
  }
  return { files, events }
}

function pageOf(content: string, title = 'Checklist'): WikiPage {
  return { ...ref(CHECKLIST), title, content, url: ROLLBACK_URL, editable: true }
}

test('Open in tab writes a read-only copy with fenced diagrams under .orca-ado/wiki-read and opens it', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace(web)])
    await fs.mkdir(path.dirname(onDisk(web, DRAFT)), { recursive: true })
    await fs.writeFile(onDisk(web, DRAFT), 'My unpublished draft.\n')

    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST)), { opened: true, message: OPENED })
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-web', path: `.orca-ado/${COPY}` }])
    assert.equal(await fs.readFile(onDisk(web, COPY), 'utf8'), COPY_TEXT)
    assert.equal(await modeOf(onDisk(web, COPY)), READ_ONLY)
    assert.equal(await fs.readFile(onDisk(web, '.gitignore'), 'utf8'), '*\n')
    assert.equal(await fs.readFile(onDisk(web, DRAFT), 'utf8'), 'My unpublished draft.\n', 'the draft of the same page is left alone')
    assert.deepEqual(await fs.readdir(web), ['.orca-ado'])
    assert.equal(h.ado.count(isPage), 1)
  })
})

test('Open in tab without a local workspace says so and writes nothing', async () => {
  const untouched = new Proxy({} as ReaderFs, {
    get: (_, name) => async () => assert.fail(`fs.${String(name)} is not called`)
  })
  const unfocused = harness([], untouched)
  const remote = harness([workspace('/srv/web-app', 'ssh:build-box')], untouched)
  for (const h of [unfocused, remote]) {
    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST)), { opened: false, message: NO_WORKSPACE })
    assert.deepEqual(h.opened, [])
    assert.equal(h.ado.count(isPage), 0, 'the page is not read')
  }
})

test('a second Open in tab rewrites the copy only when the page changed', async () => {
  await withDirs(1, async ([web]) => {
    const { files, events } = recording()
    const h = harness([workspace(web)], files)
    const copyEvents = () => events.filter(event => event.includes('Checklist.md'))

    await h.reader.openInTab(ref(CHECKLIST))
    assert.deepEqual(events, ['write .gitignore', 'write Checklist.md', 'chmod Checklist.md 444'])

    events.length = 0
    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST)), { opened: true, message: OPENED })
    assert.deepEqual(copyEvents(), [], 'the same text is not written again')

    h.ado.pages.get(CHECKLIST)!.content = `${PAGE}One more step.\n`
    events.length = 0
    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST)), { opened: true, message: OPENED })
    assert.deepEqual(copyEvents(), ['chmod Checklist.md 644', 'write Checklist.md', 'chmod Checklist.md 444'])
    assert.equal(await fs.readFile(onDisk(web, COPY), 'utf8'), `${COPY_TEXT}One more step.\n`)
    assert.deepEqual(h.opened.map(entry => entry.path), Array(3).fill(`.orca-ado/${COPY}`))
  })
})

test('the copy stays inside .orca-ado and refuses a symlinked folder', async () => {
  const plants: [string, (web: string, outsideDir: string) => Promise<void>][] = [
    ['.orca-ado is a symlink', (web, outsideDir) => fs.symlink(outsideDir, path.join(web, '.orca-ado'))],
    [
      '.orca-ado/wiki-read is a symlink',
      async (web, outsideDir) => {
        await fs.mkdir(path.join(web, '.orca-ado'))
        await fs.symlink(outsideDir, path.join(web, '.orca-ado', 'wiki-read'))
      }
    ],
    [
      'a deeper folder is a symlink to a folder inside the workspace',
      async web => {
        await fs.mkdir(path.join(web, 'docs'))
        await fs.mkdir(path.join(web, '.orca-ado', 'wiki-read'), { recursive: true })
        await fs.symlink(path.join(web, 'docs'), path.join(web, '.orca-ado', 'wiki-read', 'contoso'))
      }
    ],
    [
      'the copy is a symlink to an outside file',
      async (web, outsideDir) => {
        await fs.mkdir(path.dirname(onDisk(web, COPY)), { recursive: true })
        await fs.writeFile(path.join(outsideDir, 'secret.md'), 'secret\n')
        await fs.symlink(path.join(outsideDir, 'secret.md'), onDisk(web, COPY))
      }
    ]
  ]
  for (const [label, plant] of plants) {
    await withDirs(2, async ([web, outsideDir]) => {
      await fs.writeFile(path.join(outsideDir, 'notes.md'), 'outside\n')
      const h = harness([workspace(web)])
      await plant(web, outsideDir)
      const before = [await listing(outsideDir), await listing(web)]
      await assert.rejects(h.reader.openInTab(ref(CHECKLIST)), refused(label))
      assert.deepEqual([await listing(outsideDir), await listing(web)], before, `${label}: nothing is written, outside or in the workspace`)
      assert.deepEqual(h.opened, [], label)
    })
  }

  await withDirs(2, async ([web, outsideDir]) => {
    const h = harness([workspace(web)])
    h.ado.pages.set('/../../etc/passwd', { content: 'climb\n', etag: '"1"' })
    assert.equal((await h.reader.openInTab(ref('/../../etc/passwd'))).opened, true)
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-web', path: '.orca-ado/wiki-read/contoso/Fabrikam Web.wiki/_/_/etc/passwd.md' }])
    assert.deepEqual(await fs.readdir(web), ['.orca-ado'])
    assert.deepEqual(await fs.readdir(outsideDir), [])
  })
})

test('a file and a folder wanting the same name refuse with the reader wording, whichever came first', async () => {
  const folderPage = '/Release process/Checklist.md/Steps'
  for (const [label, first, second] of [
    ['the file first', CHECKLIST, folderPage],
    ['the folder first', folderPage, CHECKLIST]
  ]) {
    await withDirs(1, async ([web]) => {
      const h = harness([workspace(web)])
      h.ado.pages.set(folderPage, { content: 'Steps.\n', etag: '"1"' })
      assert.equal((await h.reader.openInTab(ref(first))).opened, true, label)
      const before = await listing(web)
      await assert.rejects(h.reader.openInTab(ref(second)), refused(label))
      assert.deepEqual(await listing(web), before, `${label}: nothing is written`)
      assert.equal(h.opened.length, 1, label)
    })
  }
})

test('a changed page rewrites a read-only copy and leaves it read-only', async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace(web)])
    await h.reader.openInTab(ref(CHECKLIST))
    assert.equal(await modeOf(onDisk(web, COPY)), READ_ONLY)

    h.ado.pages.get(CHECKLIST)!.content = 'Rewritten by Grace Hopper.\n'
    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST)), { opened: true, message: OPENED })
    assert.equal(await fs.readFile(onDisk(web, COPY), 'utf8'), `${BANNER}\n\nRewritten by Grace Hopper.\n`)
    assert.equal(await modeOf(onDisk(web, COPY)), READ_ONLY)
  })
})

test("a code wiki copy's banner says to edit it in its repository, not Edit in Orca", async () => {
  await withDirs(1, async ([web]) => {
    const h = harness([workspace(web)])
    assert.deepEqual(await h.reader.openInTab(ref(CHECKLIST, CODE_WIKI)), { opened: true, message: OPENED })
    assert.deepEqual(h.opened, [{ workspaceId: 'ws-web', path: `.orca-ado/${CODE_COPY}` }])
    const text = await fs.readFile(onDisk(web, CODE_COPY), 'utf8')
    assert.equal(text.split('\n')[0], CODE_BANNER)
    assert.equal(text.includes('Edit in Orca'), false)
    assert.equal(await modeOf(onDisk(web, CODE_COPY)), READ_ONLY)
  })
})

test("a page too long for Orca's rich view is cut at a line with a note, and the copy stays within 614,400 bytes", async () => {
  assert.equal(MAX_READER_BYTES, 614_400)
  const paragraphs = Array.from({ length: 7_000 }, (_, i) => `Paragraph ${i} ${'x'.repeat(90)}`).join('\n\n')
  const longLast = `${Array.from({ length: 6_000 }, (_, i) => `Line ${i} ${'y'.repeat(90)}`).join('\n')}\n${'z'.repeat(20_000)}`
  await withDirs(1, async ([web]) => {
    const h = harness([workspace(web)])
    for (const source of [paragraphs, longLast]) {
      h.ado.pages.get(CHECKLIST)!.content = source
      await h.reader.openInTab(ref(CHECKLIST))
      const text = await fs.readFile(onDisk(web, COPY), 'utf8')
      assert.ok(Buffer.byteLength(text) <= MAX_READER_BYTES, `${Buffer.byteLength(text)} bytes`)
      assert.ok(text.startsWith(`${BANNER}\n\n`))
      assert.ok(text.endsWith(TOO_LONG), text.slice(-120))
      const head = text.slice(BANNER.length + 2, text.length - TOO_LONG.length)
      assert.ok(source.startsWith(`${head}\n`), 'the copy ends at a whole line of the page')
      assert.ok(head.length > 500_000)
      assert.equal(text.split(TOO_LONG).length, 2, 'the note shows once')
      assert.equal(text.includes(PANEL_CUT_NOTE), false)
      assert.equal(await modeOf(onDisk(web, COPY)), READ_ONLY)
    }
  })
})

test('readerMarkdown closes a diagram the cut lands in, and leaves a page that fits whole', () => {
  const lines = ['Intro', '', '::: mermaid', 'graph TD']
  let size = lines.join('\n').length
  for (let i = 0; size < MAX_READER_BYTES - 40; i += 1) {
    const line = `  N${i} --> N${i + 1}`
    lines.push(line)
    size += line.length + 1
  }
  lines.push(':::')
  const content = lines.join('\n')
  assert.ok(Buffer.byteLength(content) <= MAX_READER_BYTES, 'the page alone fits')
  const fenced = `${BANNER}\n\n${content.replace('::: mermaid', '```mermaid').replace(/\n:::$/, '\n```')}`

  const text = readerMarkdown(pageOf(content), true)
  assert.ok(Buffer.byteLength(text) <= MAX_READER_BYTES, `${Buffer.byteLength(text)} bytes`)
  const head = text.slice(0, text.length - `\n\`\`\`${TOO_LONG}`.length)
  assert.ok(text.endsWith(`\n\`\`\`${TOO_LONG}`), text.slice(-120))
  assert.ok(fenced.startsWith(`${head}\n`), 'the cut keeps whole lines of the fenced page')

  assert.equal(readerMarkdown(pageOf(PAGE.replace(`[Rollback](/Release-process/Rollback)`, `[Rollback](${ROLLBACK_URL})`)), true), COPY_TEXT)
})

test('the banner names the page as plain text, whatever its title holds', () => {
  const text = readerMarkdown(pageOf('Body', 'Q&A *draft* <v2> [old] `x` _y_ ~z~'), false)
  assert.equal(
    text,
    '*A read-only copy of Q\\&A \\*draft\\* \\<v2> \\[old\\] \\`x\\` \\_y\\_ \\~z\\~. To change it, edit the page in its repository.*\n\nBody'
  )
})
