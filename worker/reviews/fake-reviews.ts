import type { RawThread } from '../ado/pr-review'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, json, type AdoCall, type FakeAdo } from '../boards/fake-ado'
import { fakePrs } from '../prs/fake-prs'

export interface FakeFile {
  objectId: string
  content: string
  isBinary: boolean
}

export interface FakeReview {
  pr: RawPullRequest | null
  threads: RawThread[]
  files: Record<string, FakeFile>
}

export type FakeReviews = FakeAdo & { review: FakeReview }

const REVIEW_PR = /\/_apis\/git\/repositories\/[^/]+\/pullrequests\/4110$/i
const ITERATIONS = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/iterations$/
const CHANGES = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/iterations\/\d+\/changes$/
const THREADS = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/threads$/
const THREAD = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/threads\/(\d+)$/
const BLOB = /\/_apis\/git\/repositories\/[^/]+\/blobs\/([^/]+)$/
const ITEMS = /\/_apis\/git\/repositories\/[^/]+\/items$/

const isReviewPr = (call: AdoCall) => call.method === 'GET' && REVIEW_PR.test(call.path)
export const isIterations = (call: AdoCall) => call.method === 'GET' && ITERATIONS.test(call.path)
export const isChanges = (call: AdoCall) => call.method === 'GET' && CHANGES.test(call.path)
export const isThreads = (call: AdoCall) => call.method === 'GET' && THREADS.test(call.path)
export const isThreadGet = (call: AdoCall) => call.method === 'GET' && THREAD.test(call.path)
export const isBlob = (call: AdoCall) => call.method === 'GET' && BLOB.test(call.path)
export const isItem = (call: AdoCall) => call.method === 'GET' && ITEMS.test(call.path)

export function fakeReviews(): FakeReviews {
  const ado = fakePrs()
  const review: FakeReview = {
    pr: fixture<RawPullRequest>('pull-request-4110'),
    threads: fixture<{ value: RawThread[] }>('pr-threads-4110').value,
    files: fixture<Record<string, FakeFile>>('pr-files-4110')
  }
  const missing = (what: string) => json(404, { message: `TF401180: ${what} was not found.` })

  ado.on(isReviewPr, () => (review.pr ? json(200, structuredClone(review.pr)) : missing('The requested pull request')))
  ado.on(isIterations, () => json(200, fixture('pr-iterations-4110')))
  ado.on(isChanges, () => json(200, fixture('pr-changes-4110')))
  ado.on(isThreads, () => json(200, { value: structuredClone(review.threads), count: review.threads.length }))
  ado.on(isThreadGet, call => {
    const thread = review.threads.find(item => item.id === Number(THREAD.exec(call.path)?.[1]))
    return thread ? json(200, structuredClone(thread)) : missing('The comment thread')
  })
  ado.on(isBlob, call => {
    const objectId = BLOB.exec(call.path)?.[1]
    const file = Object.values(review.files).find(item => item.objectId === objectId)
    return file ? json(200, { objectId, size: Buffer.byteLength(file.content) }) : missing('The blob')
  })
  ado.on(isItem, call => {
    const commitId = call.query.get('versionDescriptor.version')
    const path = call.query.get('path')
    const file = review.files[`${commitId}:${path}`]
    if (!file) return missing('The item')
    return json(200, { objectId: file.objectId, commitId, path, content: file.content, contentMetadata: { isBinary: file.isBinary } })
  })
  return Object.assign(ado, { review })
}
