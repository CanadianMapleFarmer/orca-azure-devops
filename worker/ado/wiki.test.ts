import { assert, test } from 'orca/testing'
import { fixture, json, ORG, ORG_URL, PROJECT } from '../boards/fake-ado'
import { MALFORMED } from '../messages'
import { fakeWiki, isLevel, isPage, isPagePut, isSearch, isWikis } from '../wiki/fake-wiki'
import { AdoError, createAdoHttp } from './http'
import { getPage, listWikis, pageLevel, pagePathOf, putPage, searchWiki, titleOf, wikiPageUrl } from './wiki'

const WIKI = '6b7c8d9e-8888-4a1b-9c2d-3e4f5a6b7c8d'
const CODE_WIKI = '7c8d9e0f-8888-4b2c-8d3e-4f5a6b7c8d9e'
const CHECKLIST = '/Release process/Checklist'
const CHECKLIST_ETAG = '"5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e"'
const PAGES = `/${ORG}/${PROJECT}/_apis/wiki/wikis/${WIKI}/pages`

function setup() {
  const ado = fakeWiki()
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

test('listWikis reads the kind, project and mapped path of each wiki', async () => {
  const { ado, http } = setup()
  assert.deepEqual(await listWikis(http, ORG), [
    { id: CODE_WIKI, name: 'api-docs', type: 'codeWiki', projectId: PROJECT, mappedPath: '/docs' },
    { id: WIKI, name: 'Fabrikam Web.wiki', type: 'projectWiki', projectId: PROJECT, mappedPath: '/' }
  ])
  const [call] = ado.calls
  assert.deepEqual([call.method, call.host, call.path, call.query.get('api-version')], ['GET', 'dev.azure.com', `/${ORG}/_apis/wiki/wikis`, '7.1'])

  ado.wikis[0] = { id: CODE_WIKI, name: 'api-docs', type: 'codeWiki', projectId: PROJECT }
  assert.equal((await listWikis(http, ORG))[0].mappedPath, null)

  for (const broken of [
    {},
    { value: 'wikis' },
    { value: [{ name: 'a', type: 'projectWiki', projectId: PROJECT }] },
    { value: [{ id: WIKI, type: 'projectWiki', projectId: PROJECT }] },
    { value: [{ id: WIKI, name: 'a', projectId: PROJECT }] },
    { value: [{ id: WIKI, name: 'a', type: 'projectWiki' }] },
    { value: [null] }
  ]) {
    ado.on(isWikis, () => json(200, broken))
    const error = await failure(listWikis(http, ORG))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.wiki], JSON.stringify(broken))
  }
})

test('pageLevel reads one level with its sub pages', async () => {
  const { ado, http } = setup()
  const level = await pageLevel(http, ORG, PROJECT, WIKI, '/')
  assert.equal(level.path, '/')
  assert.deepEqual(level.subPages?.map(page => [page.path, page.order, page.isParentPage]), [
    ['/Onboarding', 2, undefined],
    ['/Home', 0, undefined],
    ['/Résumé', 2, true],
    ['/Release process', 1, true]
  ])
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', PAGES])
  assert.deepEqual([call.query.get('path'), call.query.get('recursionLevel'), call.query.has('includeContent')], ['/', 'oneLevel', false])

  assert.deepEqual((await pageLevel(http, ORG, PROJECT, WIKI, '/Release process')).subPages?.map(page => page.path), [
    '/Release process/Rollback',
    '/Release process/Checklist'
  ])
  ado.on(isLevel, () => json(200, { path: '/Empty', order: 0 }))
  assert.equal((await pageLevel(http, ORG, PROJECT, WIKI, '/Empty')).subPages, undefined)

  for (const broken of [
    {},
    { path: 7 },
    { path: '/', subPages: 'none' },
    { path: '/', subPages: [{ order: 1 }] },
    { path: '/', subPages: [{ path: '/a', order: 'first' }] },
    { path: '/', subPages: [{ path: '/a', isParentPage: 'yes' }] },
    { path: '/', subPages: [null] }
  ]) {
    ado.on(isLevel, () => json(200, broken))
    const error = await failure(pageLevel(http, ORG, PROJECT, WIKI, '/'))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.wiki], JSON.stringify(broken))
  }
  ado.on(isLevel, () => json(404, { message: 'TF401019: The page was not found.' }))
  assert.equal((await failure(pageLevel(http, ORG, PROJECT, WIKI, '/Gone'))).code, 'not_found')
})

test('getPage returns the content and the ETag; a missing ETag is malformed', async () => {
  const { ado, http } = setup()
  const { page, etag } = await getPage(http, ORG, PROJECT, WIKI, CHECKLIST)
  assert.equal(etag, CHECKLIST_ETAG)
  assert.equal(page.path, CHECKLIST)
  assert.equal(page.content, fixture('wiki-page-checklist').page.content)
  assert.equal(page.remoteUrl, `${ORG_URL}/${PROJECT}/_wiki/wikis/${WIKI}?pagePath=%2FRelease%20process%2FChecklist`)
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path], ['GET', PAGES])
  assert.deepEqual([call.query.get('path'), call.query.get('includeContent'), call.query.has('recursionLevel')], [CHECKLIST, 'true', false])

  ado.on(isPage, () => json(200, { path: '/Empty' }, { etag: '"e1"' }))
  assert.deepEqual(await getPage(http, ORG, PROJECT, WIKI, '/Empty'), { page: { path: '/Empty' }, etag: '"e1"' })

  ado.on(isPage, () => json(200, { path: CHECKLIST, content: 'Text' }))
  const missing = await failure(getPage(http, ORG, PROJECT, WIKI, CHECKLIST))
  assert.deepEqual([missing.code, missing.message], ['server', MALFORMED.wiki])

  for (const broken of [{ content: 'Text' }, { path: 7 }, { path: CHECKLIST, content: 7 }, { path: CHECKLIST, subPages: 1 }]) {
    ado.on(isPage, () => json(200, broken, { etag: '"e2"' }))
    const error = await failure(getPage(http, ORG, PROJECT, WIKI, CHECKLIST))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.wiki], JSON.stringify(broken))
  }

  const controller = new AbortController()
  const hung = ado.hang(isPage)
  const pending = getPage(http, ORG, PROJECT, WIKI, CHECKLIST, controller.signal).then(
    () => assert.fail('the read was answered after the abort'),
    (error: unknown) => error
  )
  while (hung.length === 0) await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('stop'))
  assert.equal(((await pending) as Error).message, 'stop')
  assert.equal(hung[0].signal?.aborted, true)
})

test('putPage sends If-Match and returns the new ETag', async () => {
  const { ado, http } = setup()
  const saved = await putPage(http, ORG, PROJECT, WIKI, CHECKLIST, '# Release checklist\n\nNew steps.\n', CHECKLIST_ETAG)
  const [call] = ado.calls
  assert.deepEqual([call.method, call.path, call.query.get('path')], ['PUT', PAGES, CHECKLIST])
  assert.equal(call.headers.get('if-match'), CHECKLIST_ETAG)
  assert.equal(call.headers.get('content-type'), 'application/json')
  assert.deepEqual(call.body, { content: '# Release checklist\n\nNew steps.\n' })
  assert.notEqual(saved.etag, CHECKLIST_ETAG)
  assert.match(saved.etag, /^"[0-9a-f]{40}"$/)
  assert.equal(saved.page.path, CHECKLIST)
  assert.equal(saved.page.content, '# Release checklist\n\nNew steps.\n')
  assert.equal(ado.pages.get(CHECKLIST)?.etag, saved.etag)

  const stale = await failure(putPage(http, ORG, PROJECT, WIKI, CHECKLIST, 'Mine', CHECKLIST_ETAG))
  assert.deepEqual([stale.code, stale.status], ['precondition_failed', 412])
  assert.equal(ado.count(isPagePut), 2, 'a refused write is not retried')
  assert.equal(ado.pages.get(CHECKLIST)?.content, '# Release checklist\n\nNew steps.\n')

  ado.on(isPagePut, () => json(200, { path: CHECKLIST }))
  const unversioned = await failure(putPage(http, ORG, PROJECT, WIKI, CHECKLIST, 'Mine', saved.etag))
  assert.deepEqual([unversioned.code, unversioned.message], ['server', MALFORMED.wiki])
  ado.on(isPagePut, () => json(200, { content: 'Mine' }, { etag: '"e3"' }))
  assert.equal((await failure(putPage(http, ORG, PROJECT, WIKI, CHECKLIST, 'Mine', saved.etag))).message, MALFORMED.wiki)
})

test('searchWiki posts to almsearch with the wiki filter', async () => {
  const { ado, http } = setup()
  const found = await searchWiki(http, ORG, PROJECT, 'Fabrikam Web.wiki', 'smoke')
  const [call] = ado.calls
  assert.deepEqual([call.method, call.host, call.path], ['POST', 'almsearch.dev.azure.com', `/${ORG}/${PROJECT}/_apis/search/wikisearchresults`])
  assert.equal(call.query.get('api-version'), '7.1')
  assert.deepEqual(call.body, { searchText: 'smoke', $top: 25, $skip: 0, filters: { Wiki: ['Fabrikam Web.wiki'] }, includeFacets: false })
  assert.equal(found.count, 2)
  assert.deepEqual(found.results.map(result => result.path), ['/Release-process/Checklist.md', '/FAQ%3A-login.md'])
  assert.deepEqual(found.results[0].hits?.map(hit => [hit.fieldReferenceName, hit.highlights]), [
    ['content', ['2. Run the <highlighthit>smoke</highlighthit> tests &amp;   tag\n the release.']]
  ])

  ado.on(isSearch, () => json(200, { count: 1, results: [{}] }))
  assert.deepEqual((await searchWiki(http, ORG, PROJECT, 'api-docs', 'setup')).results, [{}])

  for (const broken of [
    {},
    { count: 'many', results: [] },
    { count: 1, results: 'none' },
    { count: 1, results: [null] },
    { count: 1, results: [{ path: 7 }] },
    { count: 1, results: [{ hits: 'none' }] },
    { count: 1, results: [{ hits: [{ highlights: 'text' }] }] },
    { count: 1, results: [{ hits: [{ highlights: [7] }] }] }
  ]) {
    ado.on(isSearch, () => json(200, broken))
    const error = await failure(searchWiki(http, ORG, PROJECT, 'api-docs', 'setup'))
    assert.deepEqual([error.code, error.message], ['server', MALFORMED.wiki], JSON.stringify(broken))
  }
})

test('pagePathOf decodes wiki git paths', () => {
  const cases: [string, string][] = [
    ['/Release-process/Checklist.md', '/Release process/Checklist'],
    ['/Setup-guide.md', '/Setup guide'],
    ['/FAQ%3A-login.md', '/FAQ: login'],
    ['/Pre%2Dprod-notes.md', '/Pre-prod notes'],
    ['/100%-done.md', '/100% done'],
    ['/50%25-%ZZ.md', '/50%25 %ZZ'],
    ['/Q%26A-%E2%80%93-what%3F.md', '/Q&A – what?'],
    ['/Résumé/Überblick-文档.md', '/Résumé/Überblick 文档'],
    ['/Notes.md/Today.md', '/Notes.md/Today'],
    ['/Notes.md.md', '/Notes.md'],
    ['/Home', '/Home'],
    ['/', '/'],
    ['', '']
  ]
  for (const [gitPath, expected] of cases) assert.equal(pagePathOf(gitPath), expected, gitPath)
})

test('wikiPageUrl encodes every part and titleOf takes the last segment', () => {
  assert.equal(
    wikiPageUrl(ORG, 'Fabrikam Web', 'Fabrikam Web.wiki', '/Release process/Rollback'),
    `${ORG_URL}/Fabrikam%20Web/_wiki/wikis/Fabrikam%20Web.wiki?pagePath=%2FRelease%20process%2FRollback`
  )
  assert.equal(
    wikiPageUrl('contoso', 'A&B/C', 'x?y', '/Q&A: 100%'),
    `${ORG_URL}/A%26B%2FC/_wiki/wikis/x%3Fy?pagePath=%2FQ%26A%3A%20100%25`
  )
  assert.equal(titleOf('/Release process/Checklist'), 'Checklist')
  assert.equal(titleOf('/Home'), 'Home')
  assert.equal(titleOf('/Résumé/Überblick 文档'), 'Überblick 文档')
  assert.equal(titleOf('/Section/'), 'Section')
  assert.equal(titleOf('/'), '/')
})
