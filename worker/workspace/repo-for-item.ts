import type { StorePort } from '../connections'
import type { WorkspaceEntry } from './focused'

export const REPO_CHOICES_KEY = 'workspaceRepos'

const CHOICES_CAP = 100
const WORKITEMS_SEGMENT = '_workitems'

export interface ChoiceScope { org: string; teamId: string | null; project: string | null }

export interface RepoChoices {
  chosen(scope: ChoiceScope): string[]
  choose(scope: ChoiceScope, repoKey: string): Promise<void>
}

export function projectOf(itemUrl: string): string | null {
  try {
    const segments = new URL(itemUrl).pathname.split('/')
    const at = segments.indexOf(WORKITEMS_SEGMENT)
    return at > 0 && segments[at - 1] ? decodeURIComponent(segments[at - 1]) : null
  } catch {
    return null
  }
}

export function runIn(repo: { workspaces: WorkspaceEntry[] }, focusedId: string | null): WorkspaceEntry {
  return repo.workspaces.find(entry => entry.id === focusedId) ?? [...repo.workspaces].sort((a, b) => a.name.localeCompare(b.name))[0]
}

export async function createRepoChoices(store: StorePort): Promise<RepoChoices> {
  const stored = await store.get<unknown>(REPO_CHOICES_KEY)
  const entries = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.entries(stored) : []
  const choices = new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  let writes: Promise<void> = Promise.resolve()

  return {
    chosen: scope => [teamKey(scope), projectKey(scope)].flatMap(key => (key === null ? [] : (choices.get(key) ?? []))),
    choose(scope, repoKey) {
      const key = teamKey(scope) ?? projectKey(scope)
      if (key === null) return writes
      choices.delete(key)
      choices.set(key, repoKey)
      if (choices.size > CHOICES_CAP) choices.delete(choices.keys().next().value as string)
      const saved = Object.fromEntries(choices)
      writes = writes.catch(() => {}).then(() => store.set(REPO_CHOICES_KEY, saved))
      return writes
    }
  }
}

function teamKey({ org, teamId }: ChoiceScope): string | null {
  return teamId === null ? null : `${org}/team:${teamId}`.toLowerCase()
}

function projectKey({ org, project }: ChoiceScope): string | null {
  return project === null ? null : `${org}/${project}`.toLowerCase()
}
