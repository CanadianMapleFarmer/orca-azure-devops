import { atom } from 'orca'
import type { OrgStatus } from '../shared/types'

export { messageOf } from '../shared/messages'

export type TabId = 'work' | 'pipelines' | 'prs' | 'wiki'
export type View = 'hub' | 'setup' | 'settings'
export type Busy = 'sign-out' | 'remove' | 'cancel' | null
export type Listing = { status: 'loading' | 'ready' } | { status: 'failed'; message: string }

export const LONG_WAIT = { timeoutMs: 90_000 }

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'prs', label: 'PRs' },
  { id: 'wiki', label: 'Wiki' }
]

export const orgs = atom<OrgStatus[]>([])
export const activeOrg = atom<string | null>('activeOrg', null, { persist: 'plugin' })
export const tab = atom<TabId>('tab', 'work', { persist: 'workspace' })
export const view = atom<View>('hub')
export const listing = atom<Listing>({ status: 'loading' })
export const actionError = atom<string | null>(null)
export const busy = atom<Busy>(null)

export const isTab = (value: string): value is TabId => TABS.some(item => item.id === value)

export const currentOrg = (list: readonly OrgStatus[], active: string | null): OrgStatus | null =>
  list.find(item => item.org === active) ?? list[0] ?? null

