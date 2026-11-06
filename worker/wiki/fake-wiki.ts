import { createHash } from 'node:crypto'
import { fakeAdo, fixture, json, ORG, ORG_URL, PROJECT, type AdoCall, type FakeAdo } from '../boards/fake-ado'

export interface FakeWikiRecord {
  id: string
  name: string
  type: string
  projectId: string
  mappedPath?: string
}

export interface FakePage {
  content: string
  etag: string
}

export type FakeWiki = FakeAdo & {
  wikis: FakeWikiRecord[]
  projects: { id: string; name: string }[]
  pages: Map<string, FakePage>
}

const WIKIS = new RegExp(`^/${ORG}/_apis/wiki/wikis$`)
const PROJECTS = new RegExp(`^/${ORG}/_apis/projects$`)
const PAGES = /^\/[^/]+\/([^/]+)\/_apis\/wiki\/wikis\/([^/]+)\/pages$/
const SEARCH = /^\/[^/]+\/([^/]+)\/_apis\/search\/wikisearchresults$/
const SEARCH_HOST = 'almsearch.dev.azure.com'
const LEVELS: Record<string, string> = { '/': 'wiki-level-root', '/Release process': 'wiki-level-release' }
const PAGE_FIXTURES = ['wiki-page-checklist', 'wiki-page-unicode']

export const isProjects = (call: AdoCall) => call.method === 'GET' && PROJECTS.test(call.path)
export const isWikis = (call: AdoCall) => call.method === 'GET' && WIKIS.test(call.path)
export const isLevel = (call: AdoCall) => call.method === 'GET' && PAGES.test(call.path) && call.query.has('recursionLevel')
export const isPage = (call: AdoCall) => call.method === 'GET' && PAGES.test(call.path) && !call.query.has('recursionLevel')
export const isPagePut = (call: AdoCall) => call.method === 'PUT' && PAGES.test(call.path)
export const isSearch = (call: AdoCall) => call.method === 'POST' && call.host === SEARCH_HOST && SEARCH.test(call.path)

export function fakeWiki(): FakeWiki {
  const ado = fakeAdo()
  const wikis = fixture<{ value: FakeWikiRecord[] }>('wikis').value
  const projects = [{ id: PROJECT, name: 'Fabrikam Web' }]
  const pages = new Map<string, FakePage>()
  for (const name of PAGE_FIXTURES) {
    const { etag, page } = fixture<{ etag: string; page: { path: string; content: string } }>(name)
    pages.set(page.path, { content: page.content, etag })
  }
  let versions = 0

  const missing = (what: string) => json(404, { message: `TF401019: ${what} was not found.` })
  const wikiOf = (call: AdoCall) => wikis.find(item => [item.id, item.name].includes(PAGES.exec(call.path)?.[2] ?? ''))
  const body = (wiki: FakeWikiRecord, path: string, content?: string) => ({
    path,
    order: 0,
    gitItemPath: `${path.replaceAll(' ', '-')}.md`,
    subPages: [],
    remoteUrl: `${ORG_URL}/${wiki.projectId}/_wiki/wikis/${wiki.id}?pagePath=${encodeURIComponent(path)}`,
    ...(content === undefined ? {} : { content })
  })

  ado.on(isProjects, () => json(200, { count: projects.length, value: structuredClone(projects) }))
  ado.on(isWikis, () => json(200, { count: wikis.length, value: structuredClone(wikis) }))
  ado.on(isLevel, call => {
    const wiki = wikiOf(call)
    if (!wiki) return missing('The wiki')
    const path = call.query.get('path') ?? '/'
    if (LEVELS[path]) return json(200, fixture(LEVELS[path]))
    return pages.has(path) ? json(200, body(wiki, path)) : missing('The page')
  })
  ado.on(isPage, call => {
    const wiki = wikiOf(call)
    const path = call.query.get('path') ?? '/'
    const page = pages.get(path)
    if (!wiki) return missing('The wiki')
    return page ? json(200, body(wiki, path, page.content), { etag: page.etag }) : missing('The page')
  })
  ado.on(isPagePut, call => {
    const wiki = wikiOf(call)
    const path = call.query.get('path') ?? '/'
    const page = pages.get(path)
    if (!wiki || !page) return missing('The page')
    if (call.headers.get('if-match') !== page.etag) return json(412, { message: 'The page was changed since this version was read.' })
    versions += 1
    page.content = call.body.content
    page.etag = `"${createHash('sha1').update(`${path}\n${versions}`).digest('hex')}"`
    return json(200, body(wiki, path, page.content), { etag: page.etag })
  })
  ado.on(isSearch, call => {
    const names: string[] = call.body?.filters?.Wiki ?? []
    const all = fixture<{ results: { wiki: { name: string } }[] }>('wiki-search')
    const results = all.results.filter(result => names.includes(result.wiki.name))
    return json(200, { ...all, count: results.length, results })
  })
  return Object.assign(ado, { wikis, projects, pages })
}
