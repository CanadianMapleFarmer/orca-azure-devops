import type { PrKey } from '../../src/shared/prs'
import type { ChangedFile, ChangeKind } from '../../src/shared/reviews'
import { MALFORMED } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { expectId, expectList, expectText, shaped } from './shape'
import { textOr } from './workitems'

export interface RawThread {
  id: number
  status?: string
  isDeleted?: boolean
  threadContext?: {
    filePath?: string
    rightFileStart?: { line: number } | null
    leftFileStart?: { line: number } | null
  } | null
  comments?: {
    id: number
    author?: { id: string; displayName: string }
    content?: string
    publishedDate?: string
    commentType?: string
    isDeleted?: boolean
  }[]
  identities?: Record<string, { id: string; displayName: string }> | null
}

export interface IterationFacts {
  id: number
  source: string
  common: string | null
}

export interface FileFacts extends ChangedFile {
  changeTrackingId: number
  objectId: string | null
  originalObjectId: string | null
}

interface RawIteration {
  id?: unknown
  sourceRefCommit?: { commitId?: unknown } | null
  commonRefCommit?: { commitId?: unknown } | null
}

interface RawChange {
  changeTrackingId?: unknown
  changeType?: unknown
  originalPath?: unknown
  item?: { path?: unknown; objectId?: unknown; originalObjectId?: unknown; isFolder?: unknown; gitObjectType?: unknown }
}

const MAX_CHANGES = 1_000
const FOLDER_TYPE = 'tree'
const NUL = '\u0000'

export async function latestIteration(http: AdoHttp, org: string, key: PrKey, signal?: AbortSignal): Promise<IterationFacts> {
  const { data } = await http.json<{ value?: RawIteration[] }>({ org, project: key.projectId, path: `${prPath(key)}/iterations`, signal })
  return shape(() => {
    const latest = expectList<RawIteration>(data.value).reduce<RawIteration | null>(
      (best, iteration) => (best === null || expectId(iteration.id) > expectId(best.id) ? iteration : best),
      null
    )
    if (latest === null) throw new TypeError('expected an iteration')
    return { id: expectId(latest.id), source: expectText(latest.sourceRefCommit?.commitId), common: textOr(latest.commonRefCommit?.commitId, null) }
  })
}

export async function listChanges(
  http: AdoHttp,
  org: string,
  key: PrKey,
  iterationId: number,
  signal?: AbortSignal
): Promise<{ files: FileFacts[]; more: boolean }> {
  const { data } = await http.json<{ changeEntries?: RawChange[]; nextTop?: unknown }>({
    org,
    project: key.projectId,
    path: `${prPath(key)}/iterations/${iterationId}/changes`,
    query: { $compareTo: 0, $top: MAX_CHANGES },
    signal
  })
  return shape(() => {
    const entries = expectList<RawChange>(data.changeEntries)
    const more = (typeof data.nextTop === 'number' && data.nextTop > 0) || entries.length === MAX_CHANGES
    return { files: entries.filter(entry => !isFolder(entry)).map(toFileFacts), more }
  })
}

export async function listThreads(http: AdoHttp, org: string, key: PrKey, iterationId: number, signal?: AbortSignal): Promise<RawThread[]> {
  const { data } = await http.json<{ value?: RawThread[] }>({
    org,
    project: key.projectId,
    path: `${prPath(key)}/threads`,
    query: { $iteration: iterationId, $baseIteration: 0 },
    signal
  })
  return shape(() => expectList<RawThread>(data.value))
}

export async function getThread(http: AdoHttp, org: string, key: PrKey, threadId: number): Promise<RawThread | null> {
  try {
    const { data } = await http.json<RawThread>({ org, project: key.projectId, path: `${prPath(key)}/threads/${threadId}` })
    return shape(() => {
      expectId(data.id)
      expectList(data.comments ?? [])
      return data
    })
  } catch (error) {
    if (error instanceof AdoError && error.code === 'not_found') return null
    throw error
  }
}

export async function blobSize(http: AdoHttp, org: string, key: PrKey, objectId: string, signal?: AbortSignal): Promise<number> {
  const { data } = await http.json<{ size?: unknown }>({
    org,
    project: key.projectId,
    path: `${repoPath(key)}/blobs/${encodeURIComponent(objectId)}`,
    signal
  })
  return shape(() => {
    const { size } = data
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new TypeError('expected a size')
    return size
  })
}

export async function fileText(
  http: AdoHttp,
  org: string,
  key: PrKey,
  path: string,
  commitId: string,
  signal?: AbortSignal
): Promise<{ text: string; binary: boolean }> {
  const { data } = await http.json<{ content?: unknown; contentMetadata?: { isBinary?: unknown } | null }>({
    org,
    project: key.projectId,
    path: `${repoPath(key)}/items`,
    query: {
      path,
      'versionDescriptor.version': commitId,
      'versionDescriptor.versionType': 'commit',
      includeContent: true,
      includeContentMetadata: true,
      $format: 'json'
    },
    signal
  })
  return shape(() => {
    const text = data.content === undefined ? '' : expectText(data.content)
    return { text, binary: data.contentMetadata?.isBinary === true || text.includes(NUL) }
  })
}

function repoPath(key: PrKey): string {
  return `/_apis/git/repositories/${encodeURIComponent(key.repoId)}`
}

function prPath(key: PrKey): string {
  return `${repoPath(key)}/pullRequests/${key.prId}`
}

function isFolder(entry: RawChange): boolean {
  return entry.item?.isFolder === true || entry.item?.gitObjectType === FOLDER_TYPE
}

function toFileFacts(entry: RawChange): FileFacts {
  const flags = new Set(expectText(entry.changeType).split(',').map(flag => flag.trim().toLowerCase()))
  const kind = kindOf(flags)
  const item = entry.item ?? {}
  return {
    path: expectText(item.path),
    originalPath: kind === 'renamed' ? textOr(entry.originalPath, null) : null,
    kind,
    changeTrackingId: expectId(entry.changeTrackingId),
    objectId: textOr(item.objectId, null),
    originalObjectId: textOr(item.originalObjectId, null)
  }
}

function kindOf(flags: ReadonlySet<string>): ChangeKind {
  if (flags.has('delete')) return 'deleted'
  if (flags.has('add')) return 'added'
  return flags.has('rename') ? 'renamed' : 'edited'
}

function shape<T>(build: () => T): T {
  return shaped(build, MALFORMED.review)
}
