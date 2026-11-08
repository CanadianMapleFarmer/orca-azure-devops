import { atom, plugin, read, set, update } from 'orca'
import { messageOf } from '../../shared/messages'
import type { ApprovalSummary, RunActionResult, RunFilter, RunsSnapshot, RunSummary } from '../../shared/pipelines'
import type { OrgStatus } from '../../shared/types'
import type { Place } from '../grouping'
import { LONG_WAIT } from '../state'
import { syncSurface, type SyncedSurface } from '../surface-sync'
import { surfaceVisibility } from '../visibility'

type Load = { status: 'idle' | 'loading' | 'ready' } | { status: 'failed'; message: string }
type Decision = 'approved' | 'rejected'
export interface Confirm {
  decision: Decision
  comment: string
}
export interface Outcome {
  approvalId: string
  buildId: number
  result: RunActionResult
}

export const runFilter = atom<RunFilter>('pipelinesFilter', 'mine', { persist: 'workspace' })
export const snapshot = atom<RunsSnapshot | null>(null)
export const load = atom<Load>({ status: 'idle' })
export const notice = atom<string | null>(null)
export const refreshing = atom(false)
const confirms = atom<Record<string, Confirm>>({})
const outcomes = atom<Outcome[]>([])
const runNotes = atom<Record<number, string>>({})
const inFlight = atom<string[]>([])
const source = atom<string | null>(null)
const visibility = surfaceVisibility('pipelines')

export const hidePipelines = visibility.hide

export const confirmOf = (approvalId: string): Confirm | undefined => read(confirms)[approvalId]

export const outcomesOf = (run: RunSummary): Outcome[] => read(outcomes).filter(outcome => outcome.buildId === run.buildId)

export const runPlaces = (run: RunSummary): Place[] => [
  { projectId: run.projectId, projectName: run.projectName, repoId: run.repository?.id ?? null, repoName: run.repository?.name ?? null }
]

export const noteOf = (buildId: number): string | undefined => read(runNotes)[buildId]

export const isBusy = (key: string): boolean => read(inFlight).includes(key)

async function loadSnapshot(org: string): Promise<void> {
  set(load, { status: 'loading' })
  try {
    const next = await plugin.request('runs.snapshot', { org })
    if (read(source) !== org) return
    set(snapshot, next)
    set(load, { status: 'ready' })
  } catch (error) {
    if (read(source) === org) set(load, { status: 'failed', message: messageOf(error) })
  }
}

const surface: SyncedSurface = {
  tab: 'pipelines',
  source,
  visibility,
  isIdle: () => read(load).status === 'idle',
  reset() {
    set(snapshot, null)
    set(confirms, {})
    set(outcomes, [])
    set(runNotes, {})
    set(inFlight, [])
    set(notice, null)
    set(refreshing, false)
    set(load, { status: 'idle' })
  },
  load: org => void loadSnapshot(org)
}

export const syncPipelines = (org: OrgStatus | null, onScreen: boolean): void => syncSurface(surface, org, onScreen)

export function acceptRuns(next: RunsSnapshot): void {
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
    const next = await plugin.request('runs.refresh', { org })
    if (read(source) === org) set(snapshot, next)
  } catch (error) {
    if (read(source) === org) set(notice, messageOf(error))
  }
  if (read(source) === org) set(refreshing, false)
}

export const selectFilter = (filter: RunFilter): void => set(runFilter, filter)

function without<K extends string | number, V>(record: Record<K, V>, key: K): Record<K, V> {
  const next = { ...record }
  delete next[key]
  return next
}

function setNote(buildId: number, text: string | null): void {
  update(runNotes, notes => (text === null ? without(notes, buildId) : { ...notes, [buildId]: text }))
}

async function exclusively(key: string, org: string, work: () => Promise<void>): Promise<void> {
  if (isBusy(key)) return
  update(inFlight, keys => [...keys, key])
  try {
    await work()
  } finally {
    if (read(source) === org) update(inFlight, keys => keys.filter(item => item !== key))
  }
}

export function openRun(org: string, run: RunSummary): Promise<void> {
  return exclusively(`open:${run.buildId}`, org, async () => {
    setNote(run.buildId, null)
    try {
      const result = await plugin.request('runs.open', { org, projectId: run.projectId, buildId: run.buildId }, LONG_WAIT)
      if (read(source) === org && !result.opened) setNote(run.buildId, result.message ?? messageOf(null))
    } catch (error) {
      if (read(source) === org) setNote(run.buildId, messageOf(error))
    }
  })
}

export function toggleWatch(org: string, run: RunSummary): Promise<void> {
  return exclusively(`watch:${run.buildId}`, org, async () => {
    setNote(run.buildId, null)
    try {
      const next = await plugin.request('runs.watch', { org, projectId: run.projectId, buildId: run.buildId, watched: !run.watched })
      if (read(source) === org) set(snapshot, next)
    } catch (error) {
      if (read(source) === org) setNote(run.buildId, messageOf(error))
    }
  })
}

function withoutOutcome(approvalId: string): (list: Outcome[]) => Outcome[] {
  return list => list.filter(outcome => outcome.approvalId !== approvalId)
}

export function askToDecide(approvalId: string, decision: Decision): void {
  update(outcomes, withoutOutcome(approvalId))
  update(confirms, all => ({ ...all, [approvalId]: { decision, comment: '' } }))
}

export function typeComment(approvalId: string, comment: string): void {
  update(confirms, all => (all[approvalId] ? { ...all, [approvalId]: { ...all[approvalId], comment } } : all))
}

export function cancelDecision(approvalId: string): void {
  update(confirms, all => without(all, approvalId))
}

export function decide(org: string, approval: ApprovalSummary): Promise<void> {
  const confirm = confirmOf(approval.approvalId)
  if (!confirm) return Promise.resolve()
  return exclusively(`decide:${approval.approvalId}`, org, async () => {
    update(outcomes, withoutOutcome(approval.approvalId))
    let result: RunActionResult
    try {
      const { projectId, approvalId } = approval
      result = await plugin.request('runs.decide', { org, projectId, approvalId, decision: confirm.decision, comment: confirm.comment }, LONG_WAIT)
    } catch (error) {
      result = { ok: false, message: messageOf(error) }
    }
    if (read(source) !== org) return
    cancelDecision(approval.approvalId)
    update(outcomes, list => [...list, { approvalId: approval.approvalId, buildId: approval.buildId, result }])
  })
}
