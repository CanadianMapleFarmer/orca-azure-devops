import { AdoError, type AdoHttp } from './http'
import { shaped } from './shape'

export interface PatchOp {
  op: 'test' | 'replace' | 'add'
  path: string
  value: unknown
}

const CONFLICT_MESSAGE = "Someone else changed this item. It's been refreshed; try again."
const MALFORMED_MESSAGE = 'Azure DevOps returned an unexpected work item response.'

export async function patchWorkItem(http: AdoHttp, org: string, projectId: string, id: number, ops: PatchOp[]): Promise<number> {
  const data = await send(http, org, projectId, id, ops)
  return shaped(() => readRev(data), MALFORMED_MESSAGE)
}

async function send(http: AdoHttp, org: string, projectId: string, id: number, ops: PatchOp[]): Promise<{ rev?: unknown } | undefined> {
  try {
    const { data } = await http.json<{ rev?: unknown } | undefined>({
      org,
      project: projectId,
      path: `/_apis/wit/workitems/${id}`,
      method: 'PATCH',
      body: ops,
      contentType: 'application/json-patch+json'
    })
    return data
  } catch (error) {
    throw isStaleEdit(error) ? new AdoError('conflict', 409, CONFLICT_MESSAGE) : error
  }
}

function isStaleEdit(error: unknown): boolean {
  return error instanceof AdoError && (error.code === 'precondition_failed' || error.code === 'conflict')
}

function readRev(data: { rev?: unknown } | undefined): number {
  const rev = data?.rev
  if (typeof rev !== 'number') throw new TypeError('expected a revision')
  return rev
}
