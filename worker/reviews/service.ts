import type { ChangedFile, FileDiff, LineCount, PrReview, ReviewKey } from '../../src/shared/reviews'
import type { OrgStatus } from '../../src/shared/types'
import { linkedAbort } from '../abort'
import { AdoError, withSignal, type AdoHttp } from '../ado/http'
import { blobSize, fileText, latestIteration, listChanges, listThreads, type FileFacts, type IterationFacts } from '../ado/pr-review'
import { getPullRequest, toPrSummary, type RawPullRequest } from '../ado/pullrequests'
import { textOr } from '../ado/workitems'
import { ANSWER_BUDGET_BYTES } from '../budget'
import {
  badRequest,
  DIFF_BINARY,
  DIFF_NO_BASE,
  DIFF_NO_TEXT_CHANGES,
  DIFF_TOO_LARGE,
  FILE_NOT_IN_PR,
  joinMessages,
  PRS_LOAD_FAILED,
  PRS_NEED_CODE_READ,
  renamedFrom,
  REVIEW_FILES_CAPPED,
  REVIEW_PR_GONE
} from '../messages'
import { isSignedIn, loadFailure, notConnected, signedInStatus } from '../org-status'
import { panelMarkdown } from '../panel-markdown'
import { sameId } from '../prs/release-sets'
import { diffText, splitLines } from './diff'
import { fitReview, peopleOf, toReviewThreads } from './threads'

export interface Reviews {
  onOrgs(orgs: OrgStatus[]): void
  open(key: ReviewKey): Promise<PrReview>
  diff(input: ReviewKey & { path: string }): Promise<FileDiff>
  pullRequest(key: ReviewKey): Promise<RawPullRequest>
  fileFacts(input: ReviewKey & { path: string }): Promise<{ iterationId: number; file: FileFacts; lines: FileDiff['lines']; binary: boolean } | null>
}

export interface ReviewsDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  now: () => number
}

interface Facts {
  iteration: IterationFacts
  files: FileFacts[]
}

interface Blob {
  text: string | null
  binary: boolean
}

interface Sides {
  old: Blob | null
  new: Blob | null
  noBase: boolean
  unchanged: boolean
}

interface Load {
  http: AdoHttp
  key: ReviewKey
  me: string
  signal: AbortSignal
}

const MAX_DESCRIPTION_BYTES = 60_000
const MAX_BLOB_BYTES = 2 * 1024 * 1024
const MAX_KEPT_FACTS = 5
const MAX_BLOBS = 100
const MAX_BLOB_CACHE_BYTES = 32 * 1024 * 1024
const UNREAD: Blob = { text: null, binary: false }

export function createReviews(deps: ReviewsDeps): Reviews {
  const scopes = new Map<string, AbortController>()
  const facts = new Map<string, { org: string; facts: Facts }>()
  const blobs = new Map<string, { org: string; blob: Blob; bytes: number }>()
  let blobBytes = 0

  function scopeOf(org: string): AbortController {
    const existing = scopes.get(org)
    if (existing) return existing
    const controller = new AbortController()
    scopes.set(org, controller)
    return controller
  }

  function forget(org: string): void {
    scopes.get(org)?.abort()
    scopes.delete(org)
    for (const [key, kept] of facts) if (kept.org === org) facts.delete(key)
    for (const [key, kept] of blobs) {
      if (kept.org !== org) continue
      blobs.delete(key)
      blobBytes -= kept.bytes
    }
  }

  async function load<T>(input: ReviewKey, work: (load: Load) => Promise<T>): Promise<T> {
    const link = linkedAbort(scopeOf(input.org).signal)
    try {
      if (link.signal.aborted) throw notConnected()
      const status = await signedInStatus(deps.orgs, input.org, PRS_LOAD_FAILED, () => false)
      const key: ReviewKey = { org: input.org, projectId: input.projectId, repoId: input.repoId, prId: input.prId }
      const result = await work({ http: withSignal(deps.http, link.signal), key, me: status.account.adoId, signal: link.signal })
      link.signal.throwIfAborted()
      return result
    } catch (error) {
      if (link.signal.aborted) throw notConnected()
      if (error instanceof AdoError && error.code === 'forbidden') throw new AdoError('forbidden', 403, PRS_NEED_CODE_READ)
      throw loadFailure(error, PRS_LOAD_FAILED)
    } finally {
      link.release()
    }
  }

  function keptFacts(key: ReviewKey): Facts | undefined {
    const id = factsKey(key)
    const kept = facts.get(id)
    if (!kept) return undefined
    facts.delete(id)
    facts.set(id, kept)
    return kept.facts
  }

  function keepFacts(key: ReviewKey, read: Facts, signal: AbortSignal): void {
    if (signal.aborted) return
    const id = factsKey(key)
    facts.delete(id)
    facts.set(id, { org: key.org, facts: read })
    for (const oldest of facts.keys()) {
      if (facts.size <= MAX_KEPT_FACTS) break
      facts.delete(oldest)
    }
  }

  function keptBlob(org: string, objectId: string): Blob | undefined {
    const id = blobKey(org, objectId)
    const kept = blobs.get(id)
    if (!kept) return undefined
    blobs.delete(id)
    blobs.set(id, kept)
    return kept.blob
  }

  function keepBlob(org: string, objectId: string, blob: Blob, signal: AbortSignal): void {
    if (signal.aborted) return
    const id = blobKey(org, objectId)
    const bytes = blob.text === null ? 0 : Buffer.byteLength(blob.text)
    blobBytes -= blobs.get(id)?.bytes ?? 0
    blobs.delete(id)
    blobs.set(id, { org, blob, bytes })
    blobBytes += bytes
    for (const [oldest, kept] of blobs) {
      if (blobs.size <= MAX_BLOBS && blobBytes <= MAX_BLOB_CACHE_BYTES) break
      blobs.delete(oldest)
      blobBytes -= kept.bytes
    }
  }

  async function readFacts({ http, key }: Load): Promise<Facts & { more: boolean }> {
    const iteration = await prGone(latestIteration(http, key.org, key))
    const { files, more } = await listChanges(http, key.org, key, iteration.id)
    return { iteration, files, more }
  }

  async function readBlob({ http, key, signal }: Load, objectId: string | null, path: string, commit: string): Promise<Blob> {
    const cached = objectId === null ? undefined : keptBlob(key.org, objectId)
    if (cached) return cached
    if (objectId !== null && (await blobSize(http, key.org, key, objectId)) > MAX_BLOB_BYTES) {
      keepBlob(key.org, objectId, UNREAD, signal)
      return UNREAD
    }
    const read = await fileText(http, key.org, key, path, commit)
    const blob = Buffer.byteLength(read.text) > MAX_BLOB_BYTES ? UNREAD : read
    if (objectId !== null) keepBlob(key.org, objectId, blob, signal)
    return blob
  }

  async function readSides(load: Load, { iteration }: Facts, file: FileFacts): Promise<Sides> {
    const after = () => readBlob(load, file.objectId, file.path, iteration.source)
    if (file.kind === 'renamed' && file.objectId !== null && file.objectId === file.originalObjectId) {
      const blob = await after()
      return { old: blob, new: blob, noBase: false, unchanged: true }
    }
    if (file.kind === 'added') return { old: null, new: await after(), noBase: false, unchanged: false }
    const { common } = iteration
    const newSide = file.kind === 'deleted' ? Promise.resolve(null) : after()
    if (common === null) return { old: UNREAD, new: await newSide, noBase: true, unchanged: false }
    const [oldBlob, newBlob] = await Promise.all([readBlob(load, file.originalObjectId, file.originalPath ?? file.path, common), newSide])
    return { old: oldBlob, new: newBlob, noBase: false, unchanged: false }
  }

  async function fileOf(load: Load, read: Facts, path: string) {
    const file = read.files.find(item => item.path === path)
    return file ? { file, sides: await readSides(load, read, file) } : null
  }

  return {
    onOrgs(orgs) {
      const signedIn = new Set(orgs.filter(isSignedIn).map(status => status.org))
      const known = new Set([...scopes.keys(), ...[...facts.values(), ...blobs.values()].map(kept => kept.org)])
      for (const org of known) if (!signedIn.has(org)) forget(org)
    },

    open: input =>
      load(input, async current => {
        const { http, key, me, signal } = current
        const raw = await prGone(getPullRequest(http, key.org, key))
        const iteration = await prGone(latestIteration(http, key.org, key))
        const [changes, rawThreads] = await Promise.all([
          listChanges(http, key.org, key, iteration.id),
          listThreads(http, key.org, key, iteration.id)
        ])
        const pr = toPrSummary(raw, key.org)
        const people = peopleOf(raw, rawThreads)
        const { threads, total } = toReviewThreads(rawThreads, { people, prUrl: pr.url })
        keepFacts(key, { iteration, files: changes.files }, signal)
        const review: PrReview = {
          key,
          pr,
          description: panelMarkdown(textOr(raw.description, ''), { maxBytes: MAX_DESCRIPTION_BYTES, resolve: () => pr.url, people }),
          myVote: pr.reviewers.find(reviewer => sameId(reviewer.id, me))?.vote ?? 0,
          files: changes.files.map(changedFile),
          moreFiles: changes.more,
          threads,
          threadCount: total,
          loadedAt: deps.now()
        }
        return fitReview(changes.more ? { ...review, message: REVIEW_FILES_CAPPED } : review, ANSWER_BUDGET_BYTES)
      }),

    diff: input =>
      load(input, async current => {
        let read = keptFacts(current.key)
        if (!read) {
          read = await readFacts(current)
          keepFacts(current.key, read, current.signal)
        }
        const found = await fileOf(current, read, input.path)
        if (!found) throw badRequest(FILE_NOT_IN_PR)
        return fileDiff(found.file, found.sides)
      }),

    pullRequest: input => load(input, ({ http, key }) => prGone(getPullRequest(http, key.org, key))),

    fileFacts: input =>
      load(input, async current => {
        const read = await readFacts(current)
        const found = await fileOf(current, read, input.path)
        if (!found) return null
        const { file, sides } = found
        return { iterationId: read.iteration.id, file, lines: linesOf(sides), binary: isBinary(sides) }
      })
  }
}

function factsKey(key: ReviewKey): string {
  return JSON.stringify([key.org, key.projectId, key.repoId, key.prId])
}

function blobKey(org: string, objectId: string): string {
  return JSON.stringify([org, objectId])
}

async function prGone<T>(read: Promise<T>): Promise<T> {
  try {
    return await read
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') throw new AdoError('not_found', 404, REVIEW_PR_GONE)
    throw error
  }
}

function changedFile({ path, originalPath, kind }: FileFacts): ChangedFile {
  return { path, originalPath, kind }
}

function lineCount(blob: Blob | null): LineCount {
  if (blob === null) return null
  return blob.text === null ? 'unknown' : splitLines(blob.text).length
}

function linesOf(sides: Sides): FileDiff['lines'] {
  return { old: lineCount(sides.old), new: lineCount(sides.new) }
}

function isBinary(sides: Sides): boolean {
  return sides.old?.binary === true || sides.new?.binary === true
}

function fileDiff(file: FileFacts, sides: Sides): FileDiff {
  const lines = linesOf(sides)
  const note = file.kind === 'renamed' && file.originalPath !== null ? renamedFrom(file.originalPath) : undefined
  const answer = (text: string | null, ...messages: (string | undefined)[]): FileDiff => {
    const message = joinMessages(...messages)
    return message === undefined ? { path: file.path, text, lines } : { path: file.path, text, message, lines }
  }
  if (sides.unchanged) return answer(null, note ?? DIFF_NO_TEXT_CHANGES)
  if (sides.noBase) return answer(null, note, DIFF_NO_BASE)
  if (sides.old?.text === null || sides.new?.text === null) return answer(null, note, DIFF_TOO_LARGE)
  if (isBinary(sides)) return answer(null, note, DIFF_BINARY)
  const shown = diffText(sides.old?.text ?? null, sides.new?.text ?? null)
  return answer(shown.text, note, shown.message)
}
