import { atom, plugin, read, set, update } from 'orca'
import { messageOf } from '../../shared/messages'
import type { OrgStatus } from '../../shared/types'
import type { MoveTarget, Nudge, WorkSnapshot } from '../../shared/work'
import { tab } from '../state'
import { hostIsVisible, surfaceVisibility } from '../visibility'

export type Load = { status: 'loading' | 'ready' } | { status: 'failed'; message: string }
export type Notice = { tone: 'danger' | 'neutral'; text: string }
type Source = { org: string; key: string }

export const snapshot = atom<WorkSnapshot | null>(null)
export const load = atom<Load>({ status: 'loading' })
export const notice = atom<Notice | null>(null)
export const refreshing = atom(false)
export const openItem = atom<{ org: string; id: number } | null>(null)
export const moveResets = atom(0)
const source = atom<Source | null>(null)
const visibility = surfaceVisibility('work')

export const hideWork = visibility.hide

async function loadSnapshot(wanted: Source): Promise<void> {
  set(load, { status: 'loading' })
  try {
    const next = await plugin.request('work.snapshot', { org: wanted.org })
    if (read(source)?.key !== wanted.key) return
    set(snapshot, next)
    set(load, { status: 'ready' })
  } catch (error) {
    if (read(source)?.key === wanted.key) set(load, { status: 'failed', message: messageOf(error) })
  }
}

function align(wanted: Source | null, visibleOrg: string | null): void {
  if (read(source)?.key !== wanted?.key) {
    set(source, wanted)
    set(snapshot, null)
    set(openItem, null)
    set(notice, null)
    set(refreshing, false)
    if (wanted) void loadSnapshot(wanted)
    else set(load, { status: 'loading' })
  }
  visibility.report(visibleOrg)
}

// Orca offers no atom subscription, so Panel calls this while rendering and the effects run after the render.
export function syncWork(org: OrgStatus | null, onScreen: boolean): void {
  const connected = org?.state === 'connected' ? org : null
  const wanted = connected?.boards
    ? { org: connected.org, key: `${connected.org}/${connected.boards.projectId}/${connected.boards.teamId}` }
    : null
  const visibleOrg = connected && onScreen && hostIsVisible() && read(tab) === 'work' ? connected.org : null
  void Promise.resolve().then(() => align(wanted, visibleOrg))
}

export function acceptChange(next: WorkSnapshot): void {
  if (read(source)?.org !== next.org) return
  set(snapshot, next)
  set(load, { status: 'ready' })
}

export function retryLoad(): void {
  const wanted = read(source)
  if (wanted) void loadSnapshot(wanted)
}

async function act(run: (current: () => boolean) => Promise<unknown>): Promise<void> {
  const key = read(source)?.key
  const current = () => read(source)?.key === key
  set(notice, null)
  try {
    await run(current)
  } catch (error) {
    if (!current()) return
    set(notice, { tone: 'danger', text: messageOf(error) })
    update(moveResets, count => count + 1)
  }
}

export async function refresh(org: string): Promise<void> {
  set(refreshing, true)
  await act(async current => {
    const next = await plugin.request('work.refresh', { org })
    if (current()) set(snapshot, next)
  })
  set(refreshing, false)
}

export function openBoard(org: string): Promise<void> {
  return act(async current => {
    const result = await plugin.request('work.openBoard', { org })
    if (current() && !result.opened && result.message) set(notice, { tone: 'neutral', text: result.message })
  })
}

export function move(org: string, id: number, rev: number, to: MoveTarget): Promise<void> {
  return act(() => plugin.request('work.move', { org, id, rev, to }))
}

export function dismiss(org: string, nudge: Nudge): Promise<void> {
  return act(() => plugin.request('work.dismissNudge', { org, itemId: nudge.itemId, prId: nudge.prId }))
}
