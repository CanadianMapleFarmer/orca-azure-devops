import type { AutoCompleteOptions, PrKey, PrSnapshot, PrSummary, ReleaseSet } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { linkedAbort, untilAborted } from '../abort'
import { cachedCodeProjects, type CodeProjects } from '../ado/code-projects'
import { AdoError, type AdoHttp } from '../ado/http'
import { byteLength, itemBytes, newestThatFit, POST_BUDGET_BYTES } from '../budget'
import { fly, join, type Flight } from '../data/context'
import type { Entities } from '../data/entities'
import { VALUE_BUDGET_BYTES, type Persisted } from '../data/persist'
import type { SavedTables } from '../data/saved-tables'
import {
  failureMessage,
  joinMessages,
  PRS_CHECKS_NEED_ACCESS,
  PR_COMMENTS_UNREAD,
  PRS_LOAD_FAILED,
  PRS_NEED_CODE_READ,
  PRS_TRIMMED,
  PRS_WORK_ITEMS_NEED_ACCESS,
  SHOWING_SAVED
} from '../messages'
import { isSignedIn, loadFailure, notConnected, signedInStatus, type SignedInStatus } from '../org-status'
import { NOTIFY_CAP_MS, type Scheduler } from '../poll/scheduler'
import { createPrSource, type FullLoad, type PrSource, type ThreadRead } from './load'
import { watchedPrs, type PrNotifier, type PrThreads } from './notify'
import { newestCreatedAt, releaseSets, reviewedOf, toReviewOf } from './release-sets'

export interface PrsServiceDeps {
  http: AdoHttp
  orgs: () => Promise<OrgStatus[]>
  scheduler: Scheduler
  autoComplete: () => AutoCompleteOptions
  post: (snapshot: PrSnapshot) => void
  counts: (org: string, toReview: number | null) => void
  now: () => number
  notifier: PrNotifier
  log: (message: string) => void
  entities: Entities
  persisted: Persisted
  savedTables: SavedTables
}

export interface PrsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<PrSnapshot>
  refresh(org: string): Promise<PrSnapshot>
  reloadFresh(org: string): Promise<PrSnapshot>
  me(org: string): Promise<string>
  cached(org: string, key: PrKey): PrSummary | null
  visibility(input: { org: string; visible: boolean }): { ok: true }
  dispose(): void
}

type Kind = 'full' | 'reviews'

interface OrgPrs {
  controller: AbortController
  source: PrSource
  projects: CodeProjects
  base: PrSnapshot | null
  snapshot: PrSnapshot | null
  fullAt: number | null
  fullLoads: number
  mine: PrSummary[]
  review: PrSummary[]
  failure: AdoError | null
  loading: { kind: Kind; all: boolean; flight: Flight<PrSnapshot> } | null
  readAll: boolean
  pausedUntil: number
  threadsPausedUntil: number
  restored: boolean
  restoring?: Promise<PrSnapshot | null>
}

const PRS_MS = { visibleMs: 60_000, backgroundMs: 300_000 }
const FRESH_MS = 60_000
const FORBIDDEN_PAUSE_MS = 10 * 60_000
const MAX_SETS = 50
const MAX_TO_REVIEW = 100
const MAX_REVIEWED = 50

export function createPrsService(deps: PrsServiceDeps): PrsService {
  const { http, scheduler, now } = deps
  const entries = new Map<string, OrgPrs>()
  const jobs = new Set<string>()
  const visible = new Set<string>()
  const baselined = new Set<string>()
  let disposed = false

  async function statusOf(org: string): Promise<SignedInStatus> {
    const status = await signedInStatus(deps.orgs, org, PRS_LOAD_FAILED, () => disposed)
    await deps.savedTables.seed(org, status.account.adoId)
    return status
  }

  function entryOf(org: string): OrgPrs {
    const entry = entries.get(org) ?? {
      controller: new AbortController(),
      source: createPrSource(http, org, now, deps.entities.of(org)),
      projects: cachedCodeProjects(http, org, deps.entities.of(org).projects),
      base: null,
      snapshot: null,
      fullAt: null,
      fullLoads: 0,
      mine: [],
      review: [],
      failure: null,
      loading: null,
      readAll: false,
      pausedUntil: -Infinity,
      threadsPausedUntil: -Infinity,
      restored: false
    }
    entries.set(org, entry)
    return entry
  }

  function forget(org: string): void {
    entries.get(org)?.controller.abort()
    entries.delete(org)
  }

  function connected(org: string): boolean {
    return jobs.has(org)
  }

  function resetBaseline(org: string): void {
    baselined.delete(org)
    deps.notifier.forget(org)
  }

  function jobKey(org: string): string {
    return `prs:${org}`
  }

  function fresh(entry: OrgPrs | undefined): entry is OrgPrs & { snapshot: PrSnapshot } {
    return entry !== undefined && entry.snapshot !== null && entry.fullAt !== null && now() - entry.fullAt < FRESH_MS
  }

  function painted(entry: OrgPrs): boolean {
    return entry.fullAt !== null || entry.restored
  }

  function lastFull(org: string): PrSnapshot | null {
    const entry = entries.get(org)
    return entry && painted(entry) ? entry.snapshot : null
  }

  function publish(entry: OrgPrs, base: PrSnapshot): PrSnapshot {
    const snapshot = capPrSnapshot(base)
    entry.base = base
    entry.snapshot = snapshot
    if (painted(entry)) deps.post(snapshot)
    return snapshot
  }

  function restore(org: string, status: SignedInStatus): Promise<PrSnapshot | null> {
    const entry = entryOf(org)
    if (painted(entry)) return Promise.resolve(null)
    entry.restoring ??= restoreFrom(org, entry, status.account.adoId)
    return entry.restoring
  }

  async function restoreFrom(org: string, entry: OrgPrs, account: string): Promise<PrSnapshot | null> {
    const saved = await deps.persisted.load(org, 'prs', account)
    if (entries.get(org) !== entry || !connected(org) || painted(entry) || !isSavedPrs(saved?.value, org)) return null
    entry.restored = true
    const restored = { ...saved.value, stale: true, message: SHOWING_SAVED }
    entry.base = restored
    entry.snapshot = capPrSnapshot(restored)
    void loadInFull(org)
    return entry.snapshot
  }

  function compose(org: string, me: string, sets: ReleaseSet[], review: PrSummary[], message?: string): PrSnapshot {
    const toReview = toReviewOf(review, me)
    const reviewed = reviewedOf(review, me)
    const snapshot: PrSnapshot = {
      org,
      me,
      sets,
      toReview,
      toReviewCount: toReview.length,
      reviewed,
      autoComplete: deps.autoComplete(),
      updatedAt: now(),
      stale: false
    }
    return message ? { ...snapshot, message } : snapshot
  }

  function load(org: string, kind: Kind): Promise<PrSnapshot> {
    const entry = entryOf(org)
    const all = kind === 'full' && entry.readAll
    const current = entry.loading
    if (current && (current.kind === 'full' || kind === 'reviews') && (current.all || !all)) return join(current.flight)
    if (all) entry.readAll = false
    const loading = { kind, all, flight: fly(run) }
    entry.loading = loading
    return join(loading.flight)

    async function run(): Promise<PrSnapshot> {
      if (current) await join(current.flight).catch(() => {})
      try {
        return await attempt(org, entry, kind, all)
      } finally {
        if (entry.loading === loading) entry.loading = null
      }
    }
  }

  async function attempt(org: string, entry: OrgPrs, kind: Kind, all: boolean): Promise<PrSnapshot> {
    const link = linkedAbort(entry.controller.signal)
    try {
      return await attemptWith(org, entry, kind, all, link.signal)
    } finally {
      link.release()
    }
  }

  async function attemptWith(org: string, entry: OrgPrs, kind: Kind, all: boolean, signal: AbortSignal): Promise<PrSnapshot> {
    if (signal.aborted) throw notConnected()
    if (now() < entry.pausedUntil) {
      const last = lastFull(org)
      if (last) return last
      throw entry.failure ?? loadFailure(null, PRS_LOAD_FAILED)
    }
    try {
      const status = await statusOf(org)
      const me = status.account.adoId
      const projects = await entry.projects(status.codeProjects, signal)
      if (kind === 'full') {
        const loaded = await entry.source.full(me, projects, all, signal)
        signal.throwIfAborted()
        const base = compose(org, me, releaseSets(loaded.mine, now()), loaded.review, offMessage(loaded))
        Object.assign(entry, { mine: loaded.mine, review: loaded.review, fullAt: now(), restored: false, failure: null })
        entry.fullLoads += 1
        deps.counts(org, base.toReviewCount)
        deps.persisted.save(org, 'prs', me, capPrSnapshot(base, VALUE_BUDGET_BYTES))
        deps.savedTables.save(org, me)
        return publish(entry, base)
      }
      const review = await entry.source.reviews(me, projects, false, signal)
      signal.throwIfAborted()
      const toReview = toReviewOf(review, me)
      const reviewed = reviewedOf(review, me)
      const base = { ...(entry.base ?? compose(org, me, [], [])), me, toReview, toReviewCount: toReview.length, reviewed }
      entry.review = review
      entry.failure = null
      deps.counts(org, base.toReviewCount)
      deps.savedTables.save(org, me)
      return publish(entry, base)
    } catch (error) {
      if (signal.aborted) throw notConnected()
      const forbidden = error instanceof AdoError && error.code === 'forbidden'
      if (forbidden) entry.pausedUntil = now() + FORBIDDEN_PAUSE_MS
      if (kind === 'full') entry.fullLoads += 1
      entry.failure = forbidden ? new AdoError('forbidden', 403, PRS_NEED_CODE_READ) : loadFailure(error, PRS_LOAD_FAILED)
      if (entry.base) publish(entry, { ...entry.base, stale: true, message: forbidden ? PRS_NEED_CODE_READ : failureMessage(error, PRS_LOAD_FAILED) })
      throw entry.failure
    }
  }

  async function loadInFull(org: string): Promise<void> {
    const entry = entryOf(org)
    const loads = entry.fullLoads
    void scheduler.runNow(jobKey(org))
    if (entry.loading) await join(entry.loading.flight).catch(() => {})
    if ((entry.fullLoads === loads || entry.readAll) && !entry.controller.signal.aborted) await load(org, 'full').catch(() => {})
  }

  async function poll(org: string, signal: AbortSignal): Promise<void> {
    const entry = entryOf(org)
    await untilAborted(load(org, visible.has(org) ? 'full' : 'reviews'), signal)
    await untilAborted(observe(org, entry), signal)
  }

  async function observe(org: string, entry: OrgPrs): Promise<void> {
    if (now() < entry.pausedUntil) return
    const link = linkedAbort(entry.controller.signal)
    try {
      const status = await statusOf(org)
      const threads = await threadsOf(entry, status, link.signal)
      if (link.signal.aborted) return
      baselined.add(org)
      deps.notifier.observe(org, { me: status.account.adoId, review: entry.review, threads })
    } finally {
      link.release()
    }
  }

  async function threadsOf(entry: OrgPrs, status: SignedInStatus, signal: AbortSignal): Promise<PrThreads[] | null> {
    if (!deps.notifier.readsThreads() || now() < entry.threadsPausedUntil) return null
    try {
      const me = status.account.adoId
      const mine = fresh(entry) ? entry.mine : await entry.source.active(me, await entry.projects(status.codeProjects, signal), false, signal)
      const watched = watchedPrs(mine)
      return settleThreads(entry, watched, await entry.source.threads(watched, signal))
    } catch (error) {
      if (signal.aborted) return null
      if (error instanceof AdoError && error.code === 'rate_limited') throw error
      if (error instanceof AdoError && error.code === 'forbidden') entry.threadsPausedUntil = now() + FORBIDDEN_PAUSE_MS
      else deps.log(PR_COMMENTS_UNREAD)
      return null
    }
  }

  function settleThreads(entry: OrgPrs, watched: PrSummary[], reads: ThreadRead[]): PrThreads[] | null {
    const reasons = reads.map(read => ('unreadable' in read ? read.unreadable : null))
    if (reasons.length > 0 && reasons.every(reason => reason === 'forbidden')) {
      entry.threadsPausedUntil = now() + FORBIDDEN_PAUSE_MS
      return null
    }
    if (reasons.includes('failed')) deps.log(PR_COMMENTS_UNREAD)
    return watched.flatMap((pr, index): PrThreads[] => {
      const read = reads[index]
      if ('threads' in read) return [{ pr, threads: read.threads }]
      return read.unreadable === 'gone' ? [] : [{ pr, threads: null }]
    })
  }

  return {
    onOrgs(orgs) {
      if (disposed) return
      const signedIn = new Set(orgs.filter(isSignedIn).map(status => status.org))
      const failing = new Set(orgs.filter(status => status.state === 'error').map(status => status.org))
      for (const org of new Set([...entries.keys(), ...jobs])) {
        if (signedIn.has(org)) continue
        forget(org)
        if (jobs.delete(org)) scheduler.remove(jobKey(org))
        deps.counts(org, null)
      }
      for (const org of baselined) if (!signedIn.has(org) && !failing.has(org)) resetBaseline(org)
      for (const org of signedIn) {
        if (jobs.has(org)) continue
        jobs.add(org)
        scheduler.upsert({ key: jobKey(org), org, ...PRS_MS, quietCapMs: NOTIFY_CAP_MS, run: signal => poll(org, signal) })
        scheduler.setVisible(jobKey(org), visible.has(org))
      }
    },

    async snapshot(org) {
      const status = await statusOf(org)
      const entry = entries.get(org)
      if (fresh(entry)) return entry.snapshot
      const restored = await restore(org, status)
      if (restored && connected(org)) return restored
      try {
        return await load(org, 'full')
      } catch (error) {
        const last = lastFull(org)
        if (last) return last
        throw error
      }
    },

    async refresh(org) {
      await statusOf(org)
      entryOf(org).readAll = true
      await loadInFull(org)
      const last = lastFull(org)
      if (last) return last
      const entry = entries.get(org)
      throw entry ? (entry.failure ?? loadFailure(null, PRS_LOAD_FAILED)) : notConnected()
    },

    async reloadFresh(org) {
      await statusOf(org)
      const entry = entryOf(org)
      entry.readAll = true
      if (entry.loading) await join(entry.loading.flight).catch(() => {})
      return load(org, 'full')
    },

    async me(org) {
      return (await statusOf(org)).account.adoId
    },

    cached(org, key) {
      const entry = entries.get(org)
      if (!entry || entry.restored) return null
      return [...entry.mine, ...entry.review].find(pr => samePr(pr, key)) ?? null
    },

    visibility({ org, visible: shown }) {
      const becameVisible = shown && !visible.has(org)
      if (shown) visible.add(org)
      else visible.delete(org)
      scheduler.setVisible(jobKey(org), shown)
      if (becameVisible && jobs.has(org) && !fresh(entries.get(org))) void loadInFull(org)
      return { ok: true }
    },

    dispose() {
      disposed = true
      for (const org of jobs) scheduler.remove(jobKey(org))
      jobs.clear()
      for (const org of [...entries.keys()]) forget(org)
      for (const org of baselined) resetBaseline(org)
    }
  }
}

function capPrSnapshot(snapshot: PrSnapshot, budget = POST_BUDGET_BYTES): PrSnapshot {
  const message = joinMessages(snapshot.message, PRS_TRIMMED)
  const room = budget - byteLength({ ...snapshot, sets: [], toReview: [], reviewed: [], message })
  const sets = newestThatFit(snapshot.sets, room, newestCreatedAt, MAX_SETS)
  const setBytes = [...sets].reduce((sum, set) => sum + itemBytes(set), 0)
  const toReview = newestThatFit(snapshot.toReview, room - setBytes, pr => pr.createdAt, MAX_TO_REVIEW)
  const toReviewBytes = [...toReview].reduce((sum, pr) => sum + itemBytes(pr), 0)
  const reviewed = newestThatFit(snapshot.reviewed, room - setBytes - toReviewBytes, pr => pr.createdAt, MAX_REVIEWED)
  if (sets.size === snapshot.sets.length && toReview.size === snapshot.toReview.length && reviewed.size === snapshot.reviewed.length) return snapshot
  return {
    ...snapshot,
    sets: snapshot.sets.filter(set => sets.has(set)),
    toReview: snapshot.toReview.filter(pr => toReview.has(pr)),
    reviewed: snapshot.reviewed.filter(pr => reviewed.has(pr)),
    message
  }
}

function offMessage({ off }: FullLoad): string | undefined {
  return joinMessages(off.workItems ? PRS_WORK_ITEMS_NEED_ACCESS : undefined, off.checks ? PRS_CHECKS_NEED_ACCESS : undefined)
}

function isSavedPrs(value: unknown, org: string): value is PrSnapshot {
  return (
    isRecord(value) &&
    value.org === org &&
    [value.sets, value.toReview, value.reviewed].every(list => Array.isArray(list) && list.every(isRecord)) &&
    Number.isFinite(value.toReviewCount) &&
    isRecord(value.autoComplete) &&
    Number.isFinite(value.updatedAt)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function samePr(pr: PrKey, key: PrKey): boolean {
  return pr.projectId === key.projectId && pr.repoId === key.repoId && pr.prId === key.prId
}
