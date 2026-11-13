import { isRecord } from '../data/values'
import { badRequest, EMPTY_TASK_TITLE, MALFORMED, TASK_TITLE_TOO_LONG } from '../messages'
import type { AdoHttp } from './http'
import type { PatchOp } from './patch'
import { expectId, expectText, shaped } from './shape'
import type { RawWorkItem } from './workitems'

export const TASK_TITLE_MAX = 255
const PARENT_LINK = 'System.LinkTypes.Hierarchy-Reverse'

export function taskTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') throw badRequest(EMPTY_TASK_TITLE)
  if ([...trimmed].length > TASK_TITLE_MAX) throw badRequest(TASK_TITLE_TOO_LONG)
  return trimmed
}

export function createTaskPatch(input: { title: string; areaPath: string; iterationPath: string; parentUrl: string }): PatchOp[] {
  return [
    { op: 'add', path: '/fields/System.Title', value: taskTitle(input.title) },
    { op: 'add', path: '/fields/System.AreaPath', value: input.areaPath },
    { op: 'add', path: '/fields/System.IterationPath', value: input.iterationPath },
    { op: 'add', path: '/relations/-', value: { rel: PARENT_LINK, url: input.parentUrl } }
  ]
}

export async function createTask(http: AdoHttp, org: string, projectId: string, type: string, ops: PatchOp[]): Promise<RawWorkItem> {
  const { data } = await http.json<unknown>({
    org,
    project: projectId,
    path: `/_apis/wit/workitems/$${encodeURIComponent(type)}`,
    method: 'POST',
    query: { $expand: 'relations' },
    body: ops,
    contentType: 'application/json-patch+json'
  })
  return shaped(() => createdItem(data), MALFORMED.workItem)
}

function createdItem(data: unknown): RawWorkItem {
  if (!isRecord(data) || !isRecord(data.fields)) throw new TypeError('expected a work item')
  expectId(data.id)
  expectId(data.rev)
  expectText(data.url)
  return data as unknown as RawWorkItem
}
