import { createHash } from 'node:crypto'
import type { DiffText } from '../../src/shared/diff'
import { messageOf } from '../../src/shared/messages'
import type { WikiPageRef, WikiResult } from '../../src/shared/wiki'
import { AdoError, type AdoHttp } from '../ado/http'
import { putPage } from '../ado/wiki'
import {
  DRAFT_BASE_GONE,
  DRAFT_BUSY,
  DRAFT_FILE_GONE,
  DRAFT_GONE,
  DRAFT_KEPT,
  draftNotUpdated,
  joinMessages,
  MERGE_NOT_SAVED,
  NOTHING_TO_PUBLISH,
  openedTheirs,
  PUBLISHED,
  PUBLISHED_OVER,
  TOOK_THEIRS,
  WIKI_CONFLICT,
  WIKI_PAGE_GONE,
  WIKI_PAGE_TOO_LARGE
} from '../messages'
import { diffText } from '../reviews/diff'
import type { Drafts, StoredDraft } from './drafts'
import type { WikiService } from './service'

export const MAX_PUBLISH_BYTES = 1024 * 1024

export type Resolution = 'mine' | 'theirs' | 'merge'

export interface Publisher {
  publish(key: string): Promise<WikiResult>
  resolve(input: { key: string; choice: Resolution }): Promise<WikiResult>
}

export interface PublisherDeps {
  http: AdoHttp
  drafts: Drafts
  wiki: Pick<WikiService, 'fresh'>
  now: () => number
}

interface Opened {
  draft: StoredDraft
  mine: string
  base: string
}

const STALE_ANSWERS: ReadonlySet<AdoError['code']> = new Set(['precondition_failed', 'conflict'])
const PAGE_GONE_DRAFT_KEPT = joinMessages(WIKI_PAGE_GONE, DRAFT_KEPT) ?? WIKI_PAGE_GONE

export function createPublisher(deps: PublisherDeps): Publisher {
  const running = new Set<string>()

  async function once(key: string, press: () => Promise<WikiResult>): Promise<WikiResult> {
    if (running.has(key)) return failed(DRAFT_BUSY)
    running.add(key)
    try {
      return await press()
    } catch (error) {
      return failed(messageOf(error))
    } finally {
      running.delete(key)
    }
  }

  async function open(key: string): Promise<Opened | WikiResult> {
    const draft = await deps.drafts.get(key)
    if (!draft) return failed(DRAFT_GONE)
    const texts = await deps.drafts.texts(draft)
    if (!texts) {
      if (await deps.drafts.hasFile(draft)) return failed(DRAFT_BASE_GONE)
      await deps.drafts.forget(key)
      return failed(DRAFT_FILE_GONE)
    }
    return { draft, ...texts }
  }

  function fresh(draft: StoredDraft) {
    return deps.wiki.fresh(refOf(draft))
  }

  async function write(opened: Opened, etag: string, message: string): Promise<WikiResult> {
    const { draft, mine } = opened
    let saved: { etag: string }
    try {
      saved = await putPage(deps.http, draft.org, draft.projectId, draft.wikiId, draft.path, mine, etag)
    } catch (error) {
      if (!(error instanceof AdoError && STALE_ANSWERS.has(error.code))) throw error
      const page = await fresh(draft)
      return page ? conflict(WIKI_CONFLICT, opened, page.content) : failed(PAGE_GONE_DRAFT_KEPT)
    }
    try {
      await deps.drafts.rebase(draft, { version: saved.etag, base: mine, publishedAt: deps.now() })
    } catch (error) {
      return { status: 'published', message: joinMessages(message, draftNotUpdated(messageOf(error))) ?? message }
    }
    return { status: 'published', message }
  }

  async function publish(opened: Opened): Promise<WikiResult> {
    const { draft, mine, base } = opened
    if (mine === base) return { status: 'unchanged', message: NOTHING_TO_PUBLISH }
    if (tooLarge(mine)) return failed(WIKI_PAGE_TOO_LARGE)
    const page = await fresh(draft)
    if (!page) return failed(PAGE_GONE_DRAFT_KEPT)
    if (draft.mergeMark === sha256(mine)) return conflict(MERGE_NOT_SAVED, opened, page.content)
    if (page.etag !== draft.version && page.content !== base) return conflict(WIKI_CONFLICT, opened, page.content)
    return write(opened, page.etag, PUBLISHED)
  }

  async function resolve(opened: Opened, choice: Resolution): Promise<WikiResult> {
    const { draft, mine } = opened
    if (choice === 'mine' && tooLarge(mine)) return failed(WIKI_PAGE_TOO_LARGE)
    const page = await fresh(draft)
    if (!page) return failed(PAGE_GONE_DRAFT_KEPT)
    if (choice === 'mine') return write(opened, page.etag, PUBLISHED_OVER)
    if (choice === 'theirs') {
      await deps.drafts.rebase(draft, { version: page.etag, base: page.content, mine: page.content })
      return { status: 'updated', message: TOOK_THEIRS }
    }
    const name = await deps.drafts.openTheirs(draft, page.content)
    await deps.drafts.rebase(draft, { version: page.etag, base: page.content, mergeMark: sha256(mine) })
    return { status: 'updated', message: openedTheirs(name) }
  }

  function pressed(key: string, then: (opened: Opened) => Promise<WikiResult>): Promise<WikiResult> {
    return once(key, async () => {
      const opened = await open(key)
      return isResult(opened) ? opened : then(opened)
    })
  }

  return {
    publish: key => pressed(key, publish),
    resolve: ({ key, choice }) => pressed(key, opened => resolve(opened, choice))
  }
}

function failed(message: string): WikiResult {
  return { status: 'failed', message }
}

function conflict(message: string, { base, mine }: Opened, theirs: string): WikiResult {
  return { status: 'conflict', message, theirs: diffOf(base, theirs), mine: diffOf(base, mine) }
}

function diffOf(before: string, after: string): DiffText {
  const { text, message } = diffText(before, after)
  return message === undefined ? { text } : { text, message }
}

function isResult(value: Opened | WikiResult): value is WikiResult {
  return 'status' in value
}

function refOf(draft: StoredDraft): WikiPageRef {
  return { org: draft.org, projectId: draft.projectId, wikiId: draft.wikiId, path: draft.path }
}

function tooLarge(text: string): boolean {
  return Buffer.byteLength(text) > MAX_PUBLISH_BYTES
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
