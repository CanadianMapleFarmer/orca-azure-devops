import { atom, plugin, read, set, update } from 'orca'
import { messageOf } from '../../shared/messages'
import type { Identity } from '../../shared/types'

export interface PeopleSearch {
  query: string
  status: 'idle' | 'searching' | 'ready' | 'failed'
  results: Identity[]
  message?: string
  id: number
}

const NO_SEARCH: PeopleSearch = { query: '', status: 'idle', results: [], id: 0 }

const searches = atom<Record<string, PeopleSearch>>({})

let searchId = 0

export const forgetSearches = (): void => set(searches, {})

export const searchOf = (label: string): PeopleSearch => read(searches)[label] ?? NO_SEARCH

export function setQuery(label: string, query: string): void {
  update(searches, all => ({ ...all, [label]: { ...(all[label] ?? NO_SEARCH), query } }))
}

function landSearch(label: string, id: number, patch: Partial<PeopleSearch>): void {
  update(searches, all => (all[label]?.id === id ? { ...all, [label]: { ...all[label], ...patch } } : all))
}

export async function findPeople(input: { org: string; label: string; groups: boolean; query: string }): Promise<void> {
  const query = input.query.trim()
  if (query === '') return
  const id = (searchId += 1)
  update(searches, all => ({ ...all, [input.label]: { ...(all[input.label] ?? NO_SEARCH), query: input.query, status: 'searching' as const, id } }))
  try {
    const results = await plugin.request('share.people', { org: input.org, query, groups: input.groups })
    landSearch(input.label, id, { status: 'ready', results, message: undefined })
  } catch (error) {
    landSearch(input.label, id, { status: 'failed', results: [], message: messageOf(error) })
  }
}
