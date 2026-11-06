import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { orgWebUrl } from './org'
import { expectList, expectText, shaped } from './shape'
import { textOr } from './workitems'

export interface RawPage {
  path: string
  order?: number
  isParentPage?: boolean
  remoteUrl?: string
  content?: string
  subPages?: RawPage[]
}

export interface RawWiki {
  id: string
  name: string
  type: string
  projectId: string
  mappedPath: string | null
}

export interface RawSearchResult {
  path?: string
  hits?: { fieldReferenceName?: string; highlights?: string[] }[]
}

const SEARCH_TOP = 25
const MARKDOWN_EXTENSION = /\.md$/

export async function listWikis(http: AdoHttp, org: string, signal?: AbortSignal): Promise<RawWiki[]> {
  const { data } = await http.json<{ value?: unknown }>({ org, path: '/_apis/wiki/wikis', signal })
  return shape(() =>
    expectList<Record<string, unknown>>(data?.value).map(raw => ({
      id: expectText(raw.id),
      name: expectText(raw.name),
      type: expectText(raw.type),
      projectId: expectText(raw.projectId),
      mappedPath: textOr(raw.mappedPath, null)
    }))
  )
}

export async function pageLevel(
  http: AdoHttp,
  org: string,
  projectId: string,
  wikiId: string,
  path: string,
  signal?: AbortSignal
): Promise<RawPage> {
  const { data } = await http.json<RawPage>({
    org,
    project: projectId,
    path: pagesPath(wikiId),
    query: { path, recursionLevel: 'oneLevel' },
    signal
  })
  return shape(() => checkedPage(data))
}

export async function getPage(
  http: AdoHttp,
  org: string,
  projectId: string,
  wikiId: string,
  path: string,
  signal?: AbortSignal
): Promise<{ page: RawPage; etag: string }> {
  const { data, headers } = await http.json<RawPage>({
    org,
    project: projectId,
    path: pagesPath(wikiId),
    query: { path, includeContent: true },
    signal
  })
  return versioned(data, headers)
}

export async function putPage(
  http: AdoHttp,
  org: string,
  projectId: string,
  wikiId: string,
  path: string,
  content: string,
  etag: string
): Promise<{ page: RawPage; etag: string }> {
  const { data, headers } = await http.json<RawPage>({
    org,
    project: projectId,
    method: 'PUT',
    path: pagesPath(wikiId),
    query: { path },
    body: { content },
    ifMatch: etag
  })
  return versioned(data, headers)
}

export async function searchWiki(
  http: AdoHttp,
  org: string,
  projectId: string,
  wikiName: string,
  text: string,
  signal?: AbortSignal
): Promise<{ count: number; results: RawSearchResult[] }> {
  const { data } = await http.json<{ count?: unknown; results?: unknown }>({
    org,
    host: 'almsearch',
    project: projectId,
    method: 'POST',
    path: '/_apis/search/wikisearchresults',
    body: { searchText: text, $top: SEARCH_TOP, $skip: 0, filters: { Wiki: [wikiName] }, includeFacets: false },
    signal
  })
  return shape(() => ({
    count: expectCount(data?.count),
    results: expectList<RawSearchResult>(data?.results).map(checkedResult)
  }))
}

export function wikiPageUrl(org: string, projectName: string, wikiName: string, path: string): string {
  return `${orgWebUrl(org)}/${encodeURIComponent(projectName)}/_wiki/wikis/${encodeURIComponent(wikiName)}?pagePath=${encodeURIComponent(path)}`
}

export function pagePathOf(gitPath: string): string {
  return gitPath.split('/').map(decodedSegment).join('/').replace(MARKDOWN_EXTENSION, '')
}

export function titleOf(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function pagesPath(wikiId: string): string {
  return `/_apis/wiki/wikis/${encodeURIComponent(wikiId)}/pages`
}

function decodedSegment(segment: string): string {
  const spaced = segment.replaceAll('-', ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

function versioned(data: RawPage, headers: Headers): { page: RawPage; etag: string } {
  const etag = headers.get('etag')
  return shape(() => {
    if (!etag) throw new TypeError('expected an ETag')
    return { page: checkedPage(data), etag }
  })
}

function checkedPage(page: RawPage): RawPage {
  expectText(page.path)
  optional(page.order, expectNumber)
  optional(page.isParentPage, expectFlag)
  optional(page.remoteUrl, expectText)
  optional(page.content, expectText)
  optional(page.subPages, subPages => expectList<RawPage>(subPages).forEach(checkedPage))
  return page
}

function checkedResult(result: RawSearchResult): RawSearchResult {
  optional(result.path, expectText)
  optional(result.hits, hits =>
    expectList<NonNullable<RawSearchResult['hits']>[number]>(hits).forEach(hit => {
      optional(hit.fieldReferenceName, expectText)
      optional(hit.highlights, highlights => expectList<string>(highlights).forEach(expectText))
    })
  )
  return result
}

function optional(value: unknown, check: (value: unknown) => unknown): void {
  if (value !== undefined && value !== null) check(value)
}

function expectNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('expected a number')
  return value
}

function expectFlag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('expected a flag')
  return value
}

function expectCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('expected a count')
  return value
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.wiki)
}
