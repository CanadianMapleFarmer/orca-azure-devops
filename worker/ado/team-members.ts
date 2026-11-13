import type { Assignee } from '../../src/shared/work'
import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { expectList, shaped } from './shape'

interface RawMember {
  identity?: { displayName?: unknown; uniqueName?: unknown; isContainer?: unknown }
}

export const TEAM_MEMBERS_TOP = 200

export async function loadTeamMembers(http: AdoHttp, org: string, projectId: string, teamId: string): Promise<Assignee[]> {
  const { data } = await http.json<{ value?: unknown }>({
    org,
    path: `/_apis/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/members`,
    query: { $top: TEAM_MEMBERS_TOP }
  })
  return shaped(() => people(expectList<RawMember>(data.value)), MALFORMED.identity)
}

function people(members: RawMember[]): Assignee[] {
  const byName = new Map<string, Assignee>()
  for (const member of members) {
    const person = personOf(member)
    if (person && !byName.has(person.uniqueName.toLowerCase())) byName.set(person.uniqueName.toLowerCase(), person)
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

function personOf({ identity }: RawMember): Assignee | null {
  if (!identity || identity.isContainer === true) return null
  const { displayName, uniqueName } = identity
  return typeof displayName === 'string' && displayName !== '' && typeof uniqueName === 'string' && uniqueName !== '' ? { displayName, uniqueName } : null
}
