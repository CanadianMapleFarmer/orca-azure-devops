import type { Assignee } from '../../src/shared/work'
import { BAD_ASSIGNEE, badRequest } from '../messages'
import type { AdoHttp } from './http'
import { patchWorkItem, type PatchOp } from './patch'

const UNSAFE = /[<>\p{Cc}]/u

export function identityValue(to: Assignee | null): string {
  if (to === null) return ''
  const displayName = to.displayName.trim()
  const uniqueName = to.uniqueName.trim()
  if (uniqueName === '' || UNSAFE.test(displayName) || UNSAFE.test(uniqueName)) throw badRequest(BAD_ASSIGNEE)
  return `${displayName}<${uniqueName}>`
}

export function assignPatch(rev: number, to: Assignee | null): PatchOp[] {
  return [
    { op: 'test', path: '/rev', value: rev },
    { op: 'add', path: '/fields/System.AssignedTo', value: identityValue(to) }
  ]
}

export async function assignItem(http: AdoHttp, org: string, projectId: string, id: number, rev: number, to: Assignee | null): Promise<number> {
  return patchWorkItem(http, org, projectId, id, assignPatch(rev, to))
}
