import type { Identity } from '../../src/shared/types'
import { FIND_PEOPLE_NEEDS_ACCESS, MALFORMED } from '../messages'
import { AdoError, type AdoHttp } from './http'
import { expectList, expectText, shaped } from './shape'
import { textOr } from './workitems'

interface RawSubject {
  subjectKind?: string
  descriptor?: string
  displayName?: string
  principalName?: string
  mailAddress?: string
}

interface RawIdentity {
  id?: string
  subjectDescriptor?: string
}

const GRAPH_PREVIEW_VERSION = '7.1-preview.1'
const MIN_QUERY_LENGTH = 2
const MAX_SUBJECTS = 20

export async function searchIdentities(http: AdoHttp, org: string, query: string, groups: boolean): Promise<Identity[]> {
  const text = query.trim()
  if (text.length < MIN_QUERY_LENGTH) return []
  try {
    const subjects = await findSubjects(http, org, text, groups)
    if (subjects.length === 0) return []
    const ids = await resolveIds(http, org, subjects)
    return shaped(() => subjects.flatMap(subject => toIdentity(subject, ids)), MALFORMED.identity)
  } catch (error) {
    if (error instanceof AdoError && error.code === 'forbidden') throw new AdoError('forbidden', 403, FIND_PEOPLE_NEEDS_ACCESS)
    throw error
  }
}

async function findSubjects(http: AdoHttp, org: string, query: string, groups: boolean): Promise<RawSubject[]> {
  const { data } = await http.json<{ value: RawSubject[] }>({
    org,
    host: 'vssps',
    method: 'POST',
    path: '/_apis/graph/subjectquery',
    apiVersion: GRAPH_PREVIEW_VERSION,
    body: { query, subjectKind: groups ? ['User', 'Group'] : ['User'] }
  })
  return shaped(
    () => expectList<RawSubject>(data.value).slice(0, MAX_SUBJECTS).filter(subject => typeof subject.descriptor === 'string'),
    MALFORMED.identity
  )
}

async function resolveIds(http: AdoHttp, org: string, subjects: RawSubject[]): Promise<Map<string, string>> {
  const { data } = await http.json<{ value: RawIdentity[] }>({
    org,
    host: 'vssps',
    path: '/_apis/identities',
    query: { subjectDescriptors: subjects.map(subject => subject.descriptor).join(','), queryMembership: 'None' }
  })
  return shaped(() => new Map(expectList<RawIdentity>(data.value).flatMap(idEntry)), MALFORMED.identity)
}

function idEntry({ id, subjectDescriptor }: RawIdentity): [string, string][] {
  return typeof id === 'string' && typeof subjectDescriptor === 'string' ? [[subjectDescriptor, id]] : []
}

function toIdentity(subject: RawSubject, ids: Map<string, string>): Identity[] {
  const id = ids.get(expectText(subject.descriptor))
  if (id === undefined) return []
  return [
    {
      id,
      displayName: expectText(subject.displayName),
      uniqueName: textOr(subject.principalName, textOr(subject.mailAddress, '')),
      kind: subject.subjectKind?.toLowerCase() === 'group' ? 'group' : 'user'
    }
  ]
}
