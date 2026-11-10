import { SEARCH_TOO_SHORT } from '../../src/shared/messages'
import type { OrgStatus } from '../../src/shared/types'
import { MIN_SEARCH_CHARS, type WikiHit, type WikiLevel, type WikiNode, type WikiPage, type WikiPageRef, type WikiRef } from '../../src/shared/wiki'
import { listProjects } from '../ado/core'
import { cutText } from '../ado/cut-text'
import { decode } from '../ado/html-text'
import { AdoError, type AdoHttp } from '../ado/http'
import { parsedHref } from '../ado/pr-links'
import { getPage, listWikis, pageLevel, pagePathOf, searchWiki, titleText, wikiPageUrl, type RawSearchResult, type RawWiki } from '../ado/wiki'
import {
  badRequest,
  UNKNOWN_WIKI,
  WIKI_NEEDS_READ,
  WIKI_PAGE_GONE,
  WIKI_READ_ONLY,
  WIKI_SEARCH_UNAVAILABLE,
  WIKIS_LOAD_FAILED
} from '../messages'
import { createOrgLoads, type OrgLoad } from '../org-loads'
import { isSignedIn } from '../org-status'
import { panelMarkdown } from '../panel-markdown'

export interface WikiService {
  onOrgs(orgs: OrgStatus[]): void
  wikis(org: string): Promise<WikiRef[]>
  wiki(org: string, wikiId: string): Promise<WikiRef>
  level(ref: WikiPageRef): Promise<WikiLevel>
  page(ref: WikiPageRef, maxBytes?: number, cutNote?: string): Promise<WikiPage>
  fresh(ref: WikiPageRef): Promise<{ content: string; etag: string; title: string } | null>
  search(input: Omit<WikiPageRef, 'path'> & { text: string }): Promise<{ hits: WikiHit[]; total: number }>
}

export interface WikiServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  now: () => number
}

interface Listing {
  at: number
  wikis: WikiRef[]
}

const WIKIS_TTL_MS = 10 * 60_000
const MAX_WIKIS = 50
const MAX_LEVEL_PAGES = 200
const MAX_SEARCH_CHARS = 200
const MAX_SNIPPET = 300
const MAX_PAGE_MARKDOWN_BYTES = 60_000
const PROJECT_WIKI = 'projectWiki'
const CONTENT_FIELD = 'content'
const ROOT = '/'
const ATTACHMENTS = /^\/\.attachments(?:\/|$)/i
const TAGS = /<\/?[A-Za-z][^<>]*>/g
const ANCHOR_OR_QUERY = /[#?]/

export function createWikiService(deps: WikiServiceDeps): WikiService {
  const loads = createOrgLoads({ http: deps.http, orgs: deps.orgs, fallback: WIKIS_LOAD_FAILED, forbidden: WIKI_NEEDS_READ })
  const listings = new Map<string, Listing>()

  function forget(org: string): void {
    loads.forget(org)
    listings.delete(org)
  }

  function cached(org: string): Listing | undefined {
    const listing = listings.get(org)
    return listing && deps.now() - listing.at < WIKIS_TTL_MS ? listing : undefined
  }

  async function readWikis({ http, signal }: OrgLoad, org: string): Promise<Listing> {
    const [wikis, projects] = await Promise.all([listWikis(http, org), listProjects(http, org)])
    const names = new Map(projects.map(project => [project.id, project.name]))
    const refs = wikis.map(raw => toRef(raw, names.get(raw.projectId) ?? raw.projectId))
    const listing = { at: deps.now(), wikis: refs.sort(byProjectThenName) }
    if (!signal.aborted) listings.set(org, listing)
    return listing
  }

  async function wikiOf(current: OrgLoad, org: string, wikiId: string): Promise<WikiRef> {
    const known = cached(org)?.wikis.find(wiki => wiki.id === wikiId)
    if (known) return known
    const found = (await readWikis(current, org)).wikis.find(wiki => wiki.id === wikiId)
    if (!found) throw new AdoError('not_found', 404, UNKNOWN_WIKI)
    return found
  }

  return {
    onOrgs(orgs) {
      const signedIn = new Set(orgs.filter(isSignedIn).map(status => status.org))
      for (const org of new Set([...loads.orgs(), ...listings.keys()])) if (!signedIn.has(org)) forget(org)
    },

    wikis: org => loads.load(org, async current => (cached(org) ?? (await readWikis(current, org))).wikis.slice(0, MAX_WIKIS)),

    wiki: (org, wikiId) => loads.load(org, current => wikiOf(current, org, wikiId)),

    level: ref =>
      loads.load(ref.org, async ({ http }) => {
        const gone = ref.path === ROOT ? UNKNOWN_WIKI : WIKI_PAGE_GONE
        const raw = await missingAs(pageLevel(http, ref.org, ref.projectId, ref.wikiId, ref.path), gone)
        const nodes = (raw.subPages ?? []).map(sub => ({
          order: sub.order ?? 0,
          node: { path: sub.path, title: titleText(sub.path), hasChildren: sub.isParentPage === true }
        }))
        nodes.sort((a, b) => a.order - b.order || compareText(a.node.title, b.node.title) || compareText(a.node.path, b.node.path))
        return { pages: nodes.slice(0, MAX_LEVEL_PAGES).map(item => item.node), total: nodes.length }
      }),

    page: (ref, maxBytes = MAX_PAGE_MARKDOWN_BYTES, cutNote) =>
      loads.load(ref.org, async current => {
        const wiki = await wikiOf(current, ref.org, ref.wikiId)
        const { page } = await missingAs(getPage(current.http, ref.org, ref.projectId, ref.wikiId, ref.path), WIKI_PAGE_GONE)
        const urlOf = (path: string) => wikiPageUrl(ref.org, wiki.projectName, wiki.name, path)
        const url = parsedHref(page.remoteUrl ?? '') ?? urlOf(ref.path)
        const read: WikiPage = {
          org: ref.org,
          projectId: ref.projectId,
          wikiId: ref.wikiId,
          path: ref.path,
          title: titleText(ref.path),
          content: panelMarkdown(page.content ?? '', {
            maxBytes,
            cutNote,
            resolve: href => (isPageLink(href) ? urlOf(pagePathOf(beforeAnchorOrQuery(href))) : url)
          }),
          url,
          editable: wiki.editable
        }
        return wiki.editable ? read : { ...read, notice: WIKI_READ_ONLY }
      }),

    fresh: ref =>
      loads.load(ref.org, async ({ http }) => {
        try {
          const { page, etag } = await getPage(http, ref.org, ref.projectId, ref.wikiId, ref.path)
          return { content: page.content ?? '', etag, title: titleText(ref.path) }
        } catch (error) {
          if (error instanceof AdoError && error.code === 'not_found') return null
          throw error
        }
      }),

    async search(input) {
      const text = queryOf(input.text)
      return loads.load(input.org, async current => {
        const wiki = await wikiOf(current, input.org, input.wikiId)
        const found = await missingAs(searchWiki(current.http, input.org, input.projectId, wiki.name, text), WIKI_SEARCH_UNAVAILABLE)
        const folder = wiki.editable ? '' : folderOf(wiki.mappedPath)
        const hits: WikiHit[] = []
        for (const result of found.results) {
          const gitPath = insideFolder(result.path, folder)
          if (gitPath === null) continue
          const path = pagePathOf(gitPath)
          hits.push({ path, title: titleText(path), snippet: snippetOf(result.hits) })
        }
        return { hits, total: Math.max(found.count - (found.results.length - hits.length), hits.length) }
      })
    }
  }
}

function toRef(raw: RawWiki, projectName: string): WikiRef {
  return { id: raw.id, name: raw.name, projectId: raw.projectId, projectName, editable: raw.type === PROJECT_WIKI, mappedPath: raw.mappedPath }
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function byProjectThenName(a: WikiRef, b: WikiRef): number {
  return compareText(a.projectName, b.projectName) || compareText(a.name, b.name) || compareText(a.id, b.id)
}

function isPageLink(href: string): boolean {
  return href.startsWith('/') && !ATTACHMENTS.test(href)
}

function beforeAnchorOrQuery(href: string): string {
  const end = href.search(ANCHOR_OR_QUERY)
  return end === -1 ? href : href.slice(0, end)
}

async function missingAs<T>(read: Promise<T>, message: string): Promise<T> {
  try {
    return await read
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') throw new AdoError('not_found', 404, message)
    throw error
  }
}

function queryOf(text: string): string {
  const characters = [...text.trim()]
  if (characters.length < MIN_SEARCH_CHARS) throw badRequest(SEARCH_TOO_SHORT)
  return characters.slice(0, MAX_SEARCH_CHARS).join('')
}

function folderOf(mappedPath: string | null): string {
  return (mappedPath ?? '').replace(/\/+$/, '')
}

function insideFolder(gitPath: string | undefined, folder: string): string | null {
  if (gitPath === undefined) return null
  if (folder === '') return gitPath
  return gitPath.startsWith(`${folder}/`) ? gitPath.slice(folder.length) : null
}

function snippetOf(hits: RawSearchResult['hits']): string {
  const withText = (hits ?? []).filter(hit => (hit.highlights?.length ?? 0) > 0)
  const best = withText.find(hit => hit.fieldReferenceName === CONTENT_FIELD) ?? withText[0]
  const highlight = best?.highlights?.[0] ?? ''
  return cutText(decode(highlight.replace(TAGS, '')).replace(/\s+/g, ' ').trim(), MAX_SNIPPET)
}
