import { atom, plugin, read, set, shell, update } from 'orca'
import { messageOf, OPEN_LINK_UNAVAILABLE } from '../../shared/messages'
import type { PrSnapshot, PrSummary, RowResult } from '../../shared/prs'
import type { OrgStatus } from '../../shared/types'
import { LONG_WAIT, tab } from '../state'
import { hostIsVisible, surfaceVisibility } from '../visibility'

type Load = { status: 'idle' | 'loading' | 'ready' } | { status: 'failed'; message: string }
export type Outcome = { prIds: number[] } & ({ results: RowResult[] } | { error: string })
type ActionRequest = 'prs.approve' | 'prs.autoComplete'

export const snapshot = atom<PrSnapshot | null>(null)
export const load = atom<Load>({ status: 'idle' })
export const notice = atom<string | null>(null)
export const reviewNotice = atom<string | null>(null)
export const refreshing = atom(false)
export const toReviewOpen = atom(false)
const outcomes = atom<Outcome[]>([])
const acting = atom<number[]>([])
const source = atom<string | null>(null)
const visibility = surfaceVisibility('prs')

export const hidePrs = visibility.hide

const sharesPr = (ids: readonly number[], others: readonly number[]): boolean => ids.some(id => others.includes(id))

export function outcomeOf(prIds: readonly number[]): Outcome | undefined {
  return read(outcomes).filter(outcome => sharesPr(outcome.prIds, prIds)).pop()
}

export function isActing(prIds: readonly number[]): boolean {
  return sharesPr(read(acting), prIds)
}

async function loadSnapshot(org: string): Promise<void> {
  set(load, { status: 'loading' })
  try {
    const next = await plugin.request('prs.snapshot', { org })
    if (read(source) !== org) return
    set(snapshot, next)
    set(load, { status: 'ready' })
  } catch (error) {
    if (read(source) === org) set(load, { status: 'failed', message: messageOf(error) })
  }
}

function align(org: string | null, visibleOrg: string | null): void {
  if (read(source) !== org) {
    set(source, org)
    set(snapshot, null)
    set(outcomes, [])
    set(acting, [])
    set(toReviewOpen, false)
    set(notice, null)
    set(reviewNotice, null)
    set(refreshing, false)
    set(load, { status: 'idle' })
  }
  if (org !== null && visibleOrg === org && read(load).status === 'idle') void loadSnapshot(org)
  visibility.report(visibleOrg)
}

export function syncPrs(org: OrgStatus | null, onScreen: boolean): void {
  const connected = org?.state === 'connected' ? org.org : null
  const visibleOrg = connected && onScreen && hostIsVisible() && read(tab) === 'prs' ? connected : null
  void Promise.resolve().then(() => align(connected, visibleOrg))
}

export function acceptPrs(next: PrSnapshot): void {
  if (read(source) !== next.org) return
  set(snapshot, next)
  set(load, { status: 'ready' })
}

export function retryLoad(): void {
  const org = read(source)
  if (org) void loadSnapshot(org)
}

export async function refresh(org: string): Promise<void> {
  set(refreshing, true)
  set(notice, null)
  try {
    const next = await plugin.request('prs.refresh', { org })
    if (read(source) === org) set(snapshot, next)
  } catch (error) {
    if (read(source) === org) set(notice, messageOf(error))
  }
  if (read(source) === org) set(refreshing, false)
}

export const setToReviewOpen = (open: boolean): void => set(toReviewOpen, open)

export function openPr(url: string): void {
  const org = read(source)
  const opening = shell.openExternal(url)
  set(reviewNotice, null)
  const show = (text: string): void => {
    if (read(source) === org) set(reviewNotice, text)
  }
  opening.then(
    result => {
      if (!result.opened && result.reason === 'consent-unavailable') show(OPEN_LINK_UNAVAILABLE)
    },
    error => show(messageOf(error))
  )
}

export async function act(request: ActionRequest, org: string, prs: PrSummary[]): Promise<void> {
  const ids = prs.map(pr => pr.prId)
  if (isActing(ids)) return
  const keys = prs.map(({ projectId, repoId, prId }) => ({ projectId, repoId, prId }))
  update(outcomes, list => list.filter(outcome => !sharesPr(outcome.prIds, ids)))
  update(acting, list => [...list, ...ids])
  let outcome: Outcome
  try {
    outcome = { prIds: ids, ...(await plugin.request(request, { org, prs: keys }, LONG_WAIT)) }
  } catch (error) {
    outcome = { prIds: ids, error: messageOf(error) }
  }
  if (read(source) !== org) return
  update(outcomes, list => [...list, outcome])
  update(acting, list => list.filter(id => !ids.includes(id)))
}
