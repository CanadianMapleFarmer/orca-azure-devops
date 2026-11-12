import { assert, test } from 'orca/testing'
import type { OrgStatus } from '../../src/shared/types'
import type { WikiPageRef } from '../../src/shared/wiki'
import { AdoError, createAdoHttp } from '../ado/http'
import { fixture, json, ORG, ORG_URL, PROJECT, type AdoCall } from '../boards/fake-ado'
import { createEntities } from '../data/entities'
import { ME } from '../prs/fake-prs'
import { fakeWiki, isLevel, isPage, isProjects, isSearch, isWikis } from './fake-wiki'
import { createWikiService, type WikiService } from './service'

const T0 = Date.parse('2026-11-06T10:00:00Z')
const TEN_MINUTES = 10 * 60_000
const WIKI = '6b7c8d9e-8888-4a1b-9c2d-3e4f5a6b7c8d'
const CODE_WIKI = '7c8d9e0f-8888-4b2c-8d3e-4f5a6b7c8d9e'
const RUNBOOKS = 'b3b3b3b3-1111-4a1b-9c2d-3e4f5a6b7c8d'
const MISSING_WIKI = 'c4c4c4c4-1111-4a1b-9c2d-3e4f5a6b7c8d'
const CHECKLIST = '/Release process/Checklist'
const WIKI_URL = `${ORG_URL}/Fabrikam%20Web/_wiki/wikis/Fabrikam%20Web.wiki`
const CODE_WIKI_URL = `${ORG_URL}/Fabrikam%20Web/_wiki/wikis/api-docs`
const NOT_CONNECTED = 'Connect this organization first.'
const NEEDS_READ = 'The wiki needs Wiki (Read) access.'
const UNKNOWN_WIKI = "That wiki no longer exists, or you can't see it."
const PAGE_GONE = 'This page was moved or deleted in Azure DevOps.'
const READ_ONLY = 'This wiki is published from a repository. Edit its files there.'
const SEARCH_UNAVAILABLE = "Wiki search isn't available in this organization."
const TOO_SHORT = 'Type at least 2 characters to search.'
const LOAD_FAILED = "Couldn't load wikis."
const CUT_NOTE = '\n\n*The rest is in Azure DevOps.*'

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

function harness() {
  const ado = fakeWiki()
  const urls: string[] = []
  let orgs = [status()]
  let now = T0
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    return ado.fetch(input, init)
  }) as typeof globalThis.fetch
  const http = createAdoHttp({ fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const entities = createEntities(() => now)
  const wiki = createWikiService({ http, orgs: async () => structuredClone(orgs), entities })
  wiki.onOrgs(structuredClone(orgs))
  return {
    ado,
    urls,
    wiki,
    entities,
    advance(ms: number) {
      now += ms
    },
    setOrgs(next: OrgStatus[]) {
      orgs = next
      wiki.onOrgs(structuredClone(next))
    }
  }
}

function ref(path: string, wikiId = WIKI): WikiPageRef {
  return { org: ORG, projectId: PROJECT, wikiId, path }
}

function find(text: string, wikiId = WIKI) {
  return { org: ORG, projectId: PROJECT, wikiId, text }
}

function adoError(code: AdoError['code'], status: number, message: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    assert.deepEqual([error.code, error.status, error.message], [code, status, message])
    return true
  }
}

async function until(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !reached(); turn++) await new Promise(resolve => setImmediate(resolve))
}

function hit(path: string, ...hits: [string, string[]][]) {
  return { path, hits: hits.map(([fieldReferenceName, highlights]) => ({ fieldReferenceName, highlights })) }
}

test('wikis marks project wikis editable and code wikis read-only', async () => {
  const { ado, wiki } = harness()
  assert.deepEqual(await wiki.wikis(ORG), [
    { id: CODE_WIKI, name: 'api-docs', projectId: PROJECT, projectName: 'Fabrikam Web', editable: false, mappedPath: '/docs' },
    { id: WIKI, name: 'Fabrikam Web.wiki', projectId: PROJECT, projectName: 'Fabrikam Web', editable: true, mappedPath: '/' }
  ])
  assert.deepEqual([ado.count(isWikis), ado.count(isProjects)], [1, 1])
  assert.deepEqual(await wiki.wiki(ORG, CODE_WIKI), (await wiki.wikis(ORG))[0])
  assert.equal(ado.calls.length, 2, 'one wiki is answered from the list')
})

test('wikis are sorted by project then name, capped at 50 and cached for ten minutes', async () => {
  const { ado, wiki, advance } = harness()
  const MOBILE = 'a1a1a1a1-1111-4a1b-9c2d-3e4f5a6b7c8d'
  const UNLISTED = 'e0e0e0e0-9999-4a1b-9c2d-3e4f5a6b7c8d'
  ado.projects.unshift({ id: MOBILE, name: 'Alpha Mobile' })
  ado.wikis.push(
    { id: 'z1', name: 'zed', type: 'projectWiki', projectId: MOBILE, mappedPath: '/' },
    { id: 'u1', name: 'Lost', type: 'projectWiki', projectId: UNLISTED, mappedPath: '/' }
  )
  const listed = await wiki.wikis(ORG)
  assert.deepEqual(
    listed.map(item => [item.projectName, item.name]),
    [['Alpha Mobile', 'zed'], [UNLISTED, 'Lost'], ['Fabrikam Web', 'api-docs'], ['Fabrikam Web', 'Fabrikam Web.wiki']]
  )

  await wiki.wikis(ORG)
  advance(TEN_MINUTES - 1)
  await wiki.wikis(ORG)
  assert.deepEqual([ado.count(isWikis), ado.count(isProjects)], [1, 1])
  advance(1)
  await wiki.wikis(ORG)
  assert.deepEqual([ado.count(isWikis), ado.count(isProjects)], [2, 2])

  for (let i = 0; i < 60; i += 1) ado.wikis.push({ id: `w${i}`, name: `w${String(i).padStart(2, '0')}`, type: 'projectWiki', projectId: PROJECT, mappedPath: '/' })
  advance(TEN_MINUTES)
  const capped = await wiki.wikis(ORG)
  assert.equal(capped.length, 50)
  assert.equal(capped.at(-1)?.name, 'w45')
  assert.equal(capped.filter(item => item.projectName === 'Alpha Mobile').length, 1)
})

test('level sorts children by order, then title, and caps a level at 200 with the total', async () => {
  const { ado, wiki } = harness()
  assert.deepEqual(await wiki.level(ref('/')), {
    pages: [
      { path: '/Home', title: 'Home', hasChildren: false },
      { path: '/Release process', title: 'Release process', hasChildren: true },
      { path: '/Onboarding', title: 'Onboarding', hasChildren: false },
      { path: '/Résumé', title: 'Résumé', hasChildren: true }
    ],
    total: 4
  })
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', `/${ORG}/${PROJECT}/_apis/wiki/wikis/${WIKI}/pages`])
  assert.deepEqual([call.query.get('path'), call.query.get('recursionLevel')], ['/', 'oneLevel'])
  assert.deepEqual((await wiki.level(ref('/Release process'))).pages.map(page => page.title), ['Checklist', 'Rollback'])

  const children = Array.from({ length: 300 }, (_, i) => ({ path: `/Page ${String(i).padStart(3, '0')}`, order: i % 3, isParentPage: i === 1 }))
  children.push({ path: `/${'x'.repeat(300)}`, order: 9, isParentPage: false })
  ado.on(isLevel, () => json(200, { path: '/', order: 0, subPages: children }))
  const big = await wiki.level(ref('/'))
  assert.equal(big.total, 301)
  assert.equal(big.pages.length, 200)
  assert.deepEqual([big.pages[0].title, big.pages[99].title, big.pages[100].title, big.pages[199].title], ['Page 000', 'Page 297', 'Page 001', 'Page 298'])
  assert.equal(big.pages[100].hasChildren, true)

  ado.on(isLevel, () => json(200, { path: '/', subPages: [{ path: `/${'x'.repeat(300)}` }, { path: '/Later', order: 1 }, { path: '/Earlier' }] }))
  const long = (await wiki.level(ref('/'))).pages
  assert.deepEqual(long.map(page => page.title.length), [7, 200, 5])
  assert.equal(long[1].title, `${'x'.repeat(199)}…`)
  assert.equal(long[1].path, `/${'x'.repeat(300)}`)
})

test('a level that is gone says so', async () => {
  const { ado, wiki } = harness()
  ado.on(isLevel, () => json(404, { message: 'TF401019: The page was not found.' }))
  await assert.rejects(wiki.level(ref('/Release process')), adoError('not_found', 404, PAGE_GONE))
  await assert.rejects(wiki.level(ref('/')), adoError('not_found', 404, UNKNOWN_WIKI))
})

test('page renders Markdown for the panel with links into Azure DevOps', async () => {
  const { ado, wiki } = harness()
  const page = await wiki.page(ref(CHECKLIST))
  const here = `${ORG_URL}/${PROJECT}/_wiki/wikis/${WIKI}?pagePath=%2FRelease%20process%2FChecklist`
  assert.deepEqual(page, {
    org: ORG,
    projectId: PROJECT,
    wikiId: WIKI,
    path: CHECKLIST,
    title: 'Checklist',
    url: here,
    editable: true,
    content:
      '\n# Release checklist\n\nFollow these steps before every release.\n\n' +
      `[Image: Release flow](${here})\n\n` +
      '1. Freeze the `main` branch.\n2. Run the smoke tests.\n3. Tag the release.\n\n' +
      `[Image: x.png](${here})\n\n` +
      `If something goes wrong, see [Rollback](${WIKI_URL}?pagePath=%2FRelease%20process%2FRollback).\n`
  })
  assert.ok(!page.content.includes('[[_TOC_]]'))
  assert.ok(!/!\[|<img/i.test(page.content), 'no image survives')
  assert.equal('notice' in page, false)
  const reads = ado.calls.filter(isPage)
  assert.equal(reads.length, 1)
  assert.deepEqual([reads[0].query.get('path'), reads[0].query.get('includeContent')], [CHECKLIST, 'true'])
})

test('page links go to the page itself, or to the page they name', async () => {
  const { ado, wiki } = harness()
  ado.pages.set('/Links', {
    content:
      '[attachment](/.attachments/spec%20v2.pdf) [relative](Release-process/Rollback) [anchor](#steps) ' +
      '[page](/Q%26A-what%3F) [safe](https://learn.microsoft.com/azure) [evil](javascript:alert(1)) ' +
      '[section](/Release-process/Rollback#steps) [query](/Release-process/Rollback?tab=history) [hash](/C%23-notes#top)',
    etag: '"l1"'
  })
  const self = `${ORG_URL}/${PROJECT}/_wiki/wikis/${WIKI}?pagePath=%2FLinks`
  assert.equal(
    (await wiki.page(ref('/Links'))).content,
    `[attachment](${self}) [relative](${self}) [anchor](${self}) ` +
      `[page](${WIKI_URL}?pagePath=%2FQ%26A%20what%3F) [safe](https://learn.microsoft.com/azure) [evil](${self}) ` +
      `[section](${WIKI_URL}?pagePath=%2FRelease%20process%2FRollback) [query](${WIKI_URL}?pagePath=%2FRelease%20process%2FRollback) ` +
      `[hash](${WIKI_URL}?pagePath=%2FC%23%20notes)`
  )
})

test('a code wiki page is read-only and says so', async () => {
  const { wiki } = harness()
  const page = await wiki.page(ref(CHECKLIST, CODE_WIKI))
  assert.deepEqual([page.editable, page.notice, page.wikiId], [false, READ_ONLY, CODE_WIKI])
  assert.ok(page.content.includes(`[Rollback](${CODE_WIKI_URL}?pagePath=%2FRelease%20process%2FRollback)`), page.content)
  assert.equal((await wiki.page(ref(CHECKLIST))).editable, true)
})

test('page says when it was moved or deleted', async () => {
  const { wiki } = harness()
  await assert.rejects(wiki.page(ref('/Gone')), adoError('not_found', 404, PAGE_GONE))
})

test('a long page is cut at 60,000 bytes with a note', async () => {
  const { ado, wiki } = harness()
  ado.pages.set('/Long', { content: 'A paragraph of words that goes on and on.\n\n'.repeat(5_000), etag: '"l2"' })
  const long = (await wiki.page(ref('/Long'))).content
  assert.ok(Buffer.byteLength(long) <= 60_000, `${Buffer.byteLength(long)} bytes`)
  assert.ok(long.endsWith(CUT_NOTE))
})

test("a page without a usable remoteUrl links to its address in the wiki's project", async () => {
  const { ado, wiki } = harness()
  for (const remoteUrl of ['not a url', undefined]) {
    ado.on(isPage, () => json(200, { path: '/Own', remoteUrl }, { etag: '"o1"' }))
    assert.equal((await wiki.page(ref('/Own'))).url, `${WIKI_URL}?pagePath=%2FOwn`)
  }
})

test('a page with no content renders as empty text', async () => {
  const { ado, wiki } = harness()
  ado.on(isPage, () => json(200, { path: '/Empty', order: 0, remoteUrl: `${ORG_URL}/${PROJECT}/_wiki/wikis/${WIKI}?pagePath=%2FEmpty` }, { etag: '"e1"' }))
  const page = await wiki.page(ref('/Empty'))
  assert.equal(page.content, '')
  assert.equal(page.title, 'Empty')
  assert.deepEqual(await wiki.fresh(ref('/Empty')), { content: '', etag: '"e1"', title: 'Empty' })
})

test('fresh reads the raw page and ETag every time, and says null when the page is gone', async () => {
  const { ado, wiki } = harness()
  const original = fixture('wiki-page-checklist')
  assert.deepEqual(await wiki.fresh(ref(CHECKLIST)), { content: original.page.content, etag: original.etag, title: 'Checklist' })
  assert.ok(original.page.content.includes('[[_TOC_]]'))
  ado.pages.set(CHECKLIST, { content: 'Changed by someone else.\n', etag: '"c2"' })
  assert.deepEqual(await wiki.fresh(ref(CHECKLIST)), { content: 'Changed by someone else.\n', etag: '"c2"', title: 'Checklist' })
  assert.equal(ado.count(isPage), 2)
  assert.equal(await wiki.fresh(ref('/Gone')), null)

  ado.on(isPage, () => json(500, { message: 'Boom.' }))
  await assert.rejects(wiki.fresh(ref(CHECKLIST)), adoError('server', 500, 'Boom.'))
})

test('search maps hits to pages', async () => {
  const { ado, wiki } = harness()
  const found = await wiki.search(find('  smoke  '))
  assert.deepEqual(found, {
    hits: [
      { path: '/Release process/Checklist', title: 'Checklist', snippet: '2. Run the smoke tests & tag the release.' },
      { path: '/FAQ: login', title: 'FAQ: login', snippet: 'Why does login send me back to <Home>?' }
    ],
    total: 2
  })
  const [search] = ado.calls.filter(isSearch)
  assert.deepEqual([search.method, search.host, search.path], ['POST', 'almsearch.dev.azure.com', `/${ORG}/${PROJECT}/_apis/search/wikisearchresults`])
  assert.deepEqual(search.body, { searchText: 'smoke', $top: 25, $skip: 0, filters: { Wiki: ['Fabrikam Web.wiki'] }, includeFacets: false })
})

test('a search text over 200 characters is cut without splitting a character', async () => {
  const { ado, wiki } = harness()
  for (const [text, sent] of [
    ['x'.repeat(250), 'x'.repeat(200)],
    ['🙂'.repeat(150), '🙂'.repeat(150)],
    ['🙂'.repeat(250), '🙂'.repeat(200)],
    ['ab', 'ab'],
    ['日本', '日本']
  ]) {
    await wiki.search(find(text))
    assert.equal(ado.calls.filter(isSearch).at(-1)?.body.searchText, sent)
  }
})

test('search snippets prefer the content highlight, lose their tags and are cut at 300', async () => {
  const { ado, wiki } = harness()
  const long = `${'word '.repeat(120)}end`
  ado.on(isSearch, () =>
    json(200, {
      count: 6,
      results: [
        hit('/Only-names.md', ['fileNames', ['<highlighthit>Only</highlighthit>-names.md']]),
        hit('/Content-wins.md', ['fileNames', ['<highlighthit>Content</highlighthit>-wins.md']], ['content', ['The <highlighthit>content</highlighthit> line']]),
        hit('/Long.md', ['content', [`<highlighthit>${long}</highlighthit>`, 'second']]),
        hit('/Tags.md', ['content', ['<b>bold</b> &amp;lt; <highlighthit>a</highlighthit>\n\n\t b &#39;q&#39; &quot;']]),
        hit('/No-highlights.md', ['content', []]),
        { path: '/No-hits.md' }
      ]
    })
  )
  const { hits, total } = await wiki.search(find('word'))
  assert.equal(total, 6)
  assert.deepEqual(hits.map(item => [item.path, item.title]), [
    ['/Only names', 'Only names'],
    ['/Content wins', 'Content wins'],
    ['/Long', 'Long'],
    ['/Tags', 'Tags'],
    ['/No highlights', 'No highlights'],
    ['/No hits', 'No hits']
  ])
  assert.deepEqual(hits.map(item => item.snippet), ['Only-names.md', 'The content line', `${long.slice(0, 299)}…`, "bold &lt; a b 'q' \"", '', ''])
  assert.equal(hits[2].snippet.length, 300)
})

test("a code wiki's hit drops its mappedPath", async () => {
  const { ado, wiki } = harness()
  assert.deepEqual(await wiki.search(find('setup', CODE_WIKI)), {
    hits: [{ path: '/Setup guide', title: 'Setup guide', snippet: 'Run the setup script once.' }],
    total: 1
  })
  assert.deepEqual(ado.calls.filter(isSearch)[0].body.filters, { Wiki: ['api-docs'] })

  ado.on(isSearch, () =>
    json(200, {
      count: 40,
      results: [
        hit('/docs/Guides/Install-steps.md', ['content', ['<highlighthit>install</highlighthit>']]),
        hit('/docs-old/Install-steps.md', ['content', ['old']]),
        hit('/other/Page.md', ['content', ['other']]),
        hit('/Docs/Case.md', ['content', ['case']]),
        { hits: [] }
      ]
    })
  )
  const scoped = await wiki.search(find('install', CODE_WIKI))
  assert.deepEqual(scoped.hits, [{ path: '/Guides/Install steps', title: 'Install steps', snippet: 'install' }])
  assert.equal(scoped.total, 36)

  for (const [mappedPath, expected] of [
    ['/docs/', '/Guides/Install steps'],
    [undefined, '/docs/Guides/Install steps'],
    ['/', '/docs/Guides/Install steps'],
    ['', '/docs/Guides/Install steps']
  ] as const) {
    const other = harness()
    other.ado.wikis[0] = { id: CODE_WIKI, name: 'api-docs', type: 'codeWiki', projectId: PROJECT, ...(mappedPath === undefined ? {} : { mappedPath }) }
    other.ado.on(isSearch, () => json(200, { count: 1, results: [hit('/docs/Guides/Install-steps.md', ['content', ['install']])] }))
    assert.equal((await other.wiki.search(find('install', CODE_WIKI))).hits[0]?.path, expected, `mappedPath ${JSON.stringify(mappedPath)}`)
  }
})

test("search the organization doesn't offer says so, and a rejected query shows ADO's message", async () => {
  const { ado, wiki } = harness()
  ado.on(isSearch, () => json(404, { message: 'The search service is not available.' }))
  await assert.rejects(wiki.search(find('smoke')), adoError('not_found', 404, SEARCH_UNAVAILABLE))

  ado.on(isSearch, () => json(400, { message: 'The query has too many terms.', typeKey: 'SearchQueryException' }))
  await assert.rejects(wiki.search(find('smoke')), adoError('bad_request', 400, 'The query has too many terms.'))

  ado.on(isSearch, () => json(403, { message: 'TF400813: The user is not authorized.' }))
  await assert.rejects(wiki.search(find('smoke')), adoError('forbidden', 403, NEEDS_READ))

  await assert.rejects(wiki.search(find('smoke', 'no-such-wiki')), adoError('not_found', 404, UNKNOWN_WIKI))
})

test('too short a search is refused before any call', async () => {
  const { ado, wiki } = harness()
  for (const text of ['', ' ', 'a', '  a  ', '\n\t', '🙂', '日']) {
    await assert.rejects(wiki.search(find(text)), adoError('bad_request', 400, TOO_SHORT))
  }
  assert.equal(ado.calls.length, 0)
})

test('a unicode page keeps its path through the query, the link and the hits', async () => {
  const { ado, urls, wiki } = harness()
  const nfc = '/Résumé/Überblick 文档'
  const nfd = nfc.normalize('NFD')
  assert.notEqual(nfc, nfd)
  const forms = [
    { path: nfc, encoded: '%2FR%C3%A9sum%C3%A9%2F%C3%9Cberblick%20%E6%96%87%E6%A1%A3' },
    { path: nfd, encoded: '%2FRe%CC%81sume%CC%81%2FU%CC%88berblick%20%E6%96%87%E6%A1%A3' }
  ]
  for (const { path, encoded } of forms) {
    ado.pages.set(path, { content: `See [it](${path.replaceAll(' ', '-')}).`, etag: '"u1"' })
    const page = await wiki.page(ref(path))
    const wire = urls.filter(url => url.includes('/pages?')).at(-1) ?? ''
    assert.ok(wire.includes(`path=${encoded}&`), wire)
    assert.deepEqual([page.path, page.title], [path, path.slice(path.lastIndexOf('/') + 1)])
    assert.equal(page.url, `${ORG_URL}/${PROJECT}/_wiki/wikis/${WIKI}?pagePath=${encoded}`)
    assert.equal(page.content, `See [it](${WIKI_URL}?pagePath=${encoded}).`)
  }

  ado.on(isPage, call => json(200, { path: call.query.get('path'), content: 'Body' }, { etag: '"u2"' }))
  for (const { path, encoded } of forms) assert.equal((await wiki.page(ref(path))).url, `${WIKI_URL}?pagePath=${encoded}`, 'built from the path')

  for (const { path } of forms) {
    ado.on(isSearch, () => json(200, { count: 1, results: [hit(`${path.replaceAll(' ', '-')}.md`, ['content', ['<highlighthit>Body</highlighthit>']])] }))
    assert.deepEqual((await wiki.search(find('Body'))).hits, [{ path, title: path.slice(path.lastIndexOf('/') + 1), snippet: 'Body' }])
  }
})

test('a wiki created since the list was cached is found by listing again once', async () => {
  const { ado, wiki } = harness()
  await wiki.wikis(ORG)
  assert.equal(ado.count(isWikis), 1)
  ado.wikis.push({ id: RUNBOOKS, name: 'Runbooks.wiki', type: 'projectWiki', projectId: PROJECT, mappedPath: '/' })

  const created = await wiki.wiki(ORG, RUNBOOKS)
  assert.deepEqual([created.name, created.editable, created.projectName], ['Runbooks.wiki', true, 'Fabrikam Web'])
  assert.equal(ado.count(isWikis), 2)
  await wiki.wiki(ORG, RUNBOOKS)
  assert.equal(ado.count(isWikis), 2, 'the new wiki is cached now')

  await assert.rejects(wiki.wiki(ORG, MISSING_WIKI), adoError('not_found', 404, UNKNOWN_WIKI))
  assert.equal(ado.count(isWikis), 3, 'one more listing, no more')

  const pageOfNew = await wiki.page(ref(CHECKLIST, RUNBOOKS))
  assert.ok(pageOfNew.content.includes(`${ORG_URL}/Fabrikam%20Web/_wiki/wikis/Runbooks.wiki?pagePath=`), pageOfNew.content)
  await assert.rejects(wiki.page(ref(CHECKLIST, MISSING_WIKI)), adoError('not_found', 404, UNKNOWN_WIKI))
  assert.equal(ado.count(isWikis), 4)
  await assert.rejects(wiki.search(find('smoke', MISSING_WIKI)), adoError('not_found', 404, UNKNOWN_WIKI))
  assert.equal(ado.count(isSearch), 0)
})

test('a wiki beyond the first 50 is answered from the cached list', async () => {
  const { ado, wiki } = harness()
  for (let i = 0; i < 60; i += 1) ado.wikis.push({ id: `w${i}`, name: `w${String(i).padStart(2, '0')}`, type: 'projectWiki', projectId: PROJECT, mappedPath: '/' })
  const listed = await wiki.wikis(ORG)
  assert.equal(listed.length, 50)
  assert.ok(!listed.some(item => item.id === 'w55'), 'the 55th wiki is past the cap')
  const lists = ado.count(isWikis)

  const found = await wiki.wiki(ORG, 'w55')
  assert.deepEqual([found.name, found.editable], ['w55', true])
  assert.ok((await wiki.page(ref(CHECKLIST, 'w55'))).content.includes('/_wiki/wikis/w55?pagePath='))
  assert.deepEqual(await wiki.search(find('smoke', 'w55')), { hits: [], total: 0 })
  assert.equal(ado.count(isSearch), 1)
  assert.deepEqual([ado.count(isWikis), ado.count(isProjects)], [lists, lists], 'no listing for a cached wiki')
  assert.equal((await wiki.wikis(ORG)).length, 50, 'the list is still capped')
})

test('an expired wiki list is read again once, whether or not the wiki is in it', async () => {
  const { ado, wiki, advance } = harness()
  await wiki.wikis(ORG)
  advance(TEN_MINUTES)
  await wiki.wiki(ORG, CODE_WIKI)
  assert.equal(ado.count(isWikis), 2)
  advance(TEN_MINUTES)
  await assert.rejects(wiki.wiki(ORG, MISSING_WIKI), adoError('not_found', 404, UNKNOWN_WIKI))
  assert.equal(ado.count(isWikis), 3)
})

test('nothing is answered after the org signs out', async () => {
  const { ado, wiki, entities, setOrgs } = harness()
  await wiki.wikis(ORG)
  const hung = ado.hang(isPage)
  const answer = wiki.page(ref(CHECKLIST)).then(
    () => assert.fail('the page was answered after sign-out'),
    (error: unknown) => error
  )
  await until(() => hung.length > 0)
  assert.equal(hung.length, 1)
  setOrgs([])
  entities.forget(ORG)
  assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await answer))
  assert.equal(hung[0].signal?.aborted, true)

  const count = ado.calls.length
  const gone = adoError('unauthorized', 401, NOT_CONNECTED)
  await assert.rejects(wiki.wikis(ORG), gone)
  await assert.rejects(wiki.wiki(ORG, WIKI), gone)
  await assert.rejects(wiki.level(ref('/')), gone)
  await assert.rejects(wiki.page(ref(CHECKLIST)), gone)
  await assert.rejects(wiki.fresh(ref(CHECKLIST)), gone)
  await assert.rejects(wiki.search(find('smoke')), gone)
  assert.equal(ado.calls.length, count, 'a signed-out org sends nothing')

  setOrgs([status({ state: 'expired' })])
  await assert.rejects(wiki.wikis(ORG), gone)
  setOrgs([status()])
  await wiki.wikis(ORG)
  assert.equal(ado.count(isWikis), 2, 'signing out dropped the cached wikis')
})

test('a read that lands after the org signs out keeps nothing', async () => {
  const { ado, wiki, setOrgs } = harness()
  const held = ado.hold(isWikis)
  const answer = wiki.wikis(ORG).then(
    () => assert.fail('the wikis were answered after sign-out'),
    (error: unknown) => error
  )
  await until(() => ado.count(isWikis) > 0)
  setOrgs([])
  held.release()
  assert.ok(adoError('unauthorized', 401, NOT_CONNECTED)(await answer))

  setOrgs([status()])
  assert.equal((await wiki.wikis(ORG)).length, 2)
  assert.equal(ado.count(isWikis), 2, 'nothing was kept from the late read')
})

test('reads without Wiki (Read) access say what is needed', async () => {
  const denied = () => json(403, { message: 'TF400813: The user is not authorized to access this resource.' })
  const cases: [(call: AdoCall) => boolean, (wiki: WikiService) => Promise<unknown>][] = [
    [isWikis, wiki => wiki.wikis(ORG)],
    [isLevel, wiki => wiki.level(ref('/'))],
    [isPage, wiki => wiki.page(ref(CHECKLIST))],
    [isPage, wiki => wiki.fresh(ref(CHECKLIST))],
    [isSearch, wiki => wiki.search(find('smoke'))]
  ]
  for (const [match, read] of cases) {
    const { ado, wiki } = harness()
    if (match !== isWikis) await wiki.wikis(ORG)
    ado.on(match, denied)
    await assert.rejects(read(wiki), adoError('forbidden', 403, NEEDS_READ))
  }
})

test('a failed read says what Azure DevOps said, or that the wikis could not be loaded', async () => {
  const { ado, wiki } = harness()
  ado.on(isProjects, () => json(500, { message: 'Boom.' }))
  await assert.rejects(wiki.wikis(ORG), adoError('server', 500, 'Boom.'))

  const broken = createWikiService({
    http: createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} }),
    orgs: async () => {
      throw new Error('the store failed')
    },
    entities: createEntities(() => T0)
  })
  await assert.rejects(broken.wikis(ORG), adoError('server', 500, LOAD_FAILED))
})
