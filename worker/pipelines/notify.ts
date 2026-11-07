import type { ApprovalSummary, RunSummary } from '../../src/shared/pipelines'
import { approvalsNeedingMe } from '../../src/shared/runs'
import { cutText } from '../ado/cut-text'
import {
  approvalTitle,
  failedAt,
  MORE_UPDATES_BODY,
  moreRunUpdates,
  NOTIFY_FAILED,
  runBody,
  runFailedTitle,
  runFinishedTitle,
  waitingAt,
  YOU_CAN_APPROVE
} from '../messages'
import type { NotifyPrefs } from './settings'

export const MAX_NOTIFICATIONS_PER_UPDATE = 3
const MAX_NOTIFIED_KEYS = 500
const MAX_TITLE_CHARS = 120
const MAX_BODY_CHARS = 1000

export interface Shown {
  title: string
  body: string
}

export interface DesktopNotification extends Shown {
  key: string
}

export interface Notifier {
  observe(org: string, runs: readonly RunSummary[]): void
}

export interface Delivery {
  notified: ReadonlySet<string>
  send(found: readonly DesktopNotification[], more: (extra: number) => Shown): void
}

export function cutNote(note: DesktopNotification): DesktopNotification {
  return { key: note.key, title: cutText(note.title, MAX_TITLE_CHARS), body: cutText(note.body, MAX_BODY_CHARS) }
}

export function createDelivery(deps: { show: (n: Shown) => Promise<unknown>; log: (message: string) => void }): Delivery {
  const notified = new Set<string>()

  const remember = (keys: string[]) => {
    for (const key of keys) notified.add(key)
    for (const key of notified) {
      if (notified.size <= MAX_NOTIFIED_KEYS) break
      notified.delete(key)
    }
  }

  return {
    notified,
    send(found, more) {
      if (found.length === 0) return
      remember(found.map(note => note.key))
      const outgoing = found.slice(0, MAX_NOTIFICATIONS_PER_UPDATE).map(({ title, body }) => ({ title, body }))
      const extra = found.length - MAX_NOTIFICATIONS_PER_UPDATE
      if (extra > 0) outgoing.push(more(extra))
      void Promise.allSettled(outgoing.map(async note => deps.show(note))).then(results => {
        if (results.some(result => result.status === 'rejected')) deps.log(NOTIFY_FAILED)
      })
    }
  }
}

export function notificationsFor(input: {
  org: string
  runs: readonly RunSummary[]
  prefs: NotifyPrefs
  since: number
  notified: ReadonlySet<string>
}): DesktopNotification[] {
  const { org, runs, prefs, since, notified } = input
  const found = new Map<string, DesktopNotification>()
  const add = (note: DesktopNotification | null) => {
    if (note && !notified.has(note.key)) found.set(note.key, cutNote(note))
  }
  for (const run of runs) {
    add(finishNote(org, run, prefs, since))
    if (prefs.approvals) {
      for (const approval of approvalsNeedingMe([run])) if (approval.createdAt >= since) add(approvalNote(org, run, approval))
    }
  }
  return [...found.values()]
}

export function createNotifier(deps: {
  show: (n: Shown) => Promise<unknown>
  prefs: () => NotifyPrefs
  since: number
  log: (message: string) => void
}): Notifier {
  const delivery = createDelivery(deps)
  return {
    observe(org, runs) {
      const found = notificationsFor({ org, runs, prefs: deps.prefs(), since: deps.since, notified: delivery.notified })
      delivery.send(found, extra => ({ title: moreRunUpdates(extra), body: MORE_UPDATES_BODY }))
    }
  }
}

function finishNote(org: string, run: RunSummary, prefs: NotifyPrefs, since: number): DesktopNotification | null {
  const finishedAt = run.finishedAt
  if (finishedAt === null) return null
  const key = `done:${org}:${run.buildId}:${finishedAt}`
  const watching = run.watched && prefs.watched
  switch (run.state) {
    case 'failed': {
      if (!watching && !(run.mine && prefs.failures && finishedAt >= since)) return null
      const stage = run.stages?.find(chip => chip.state === 'failed')
      return { key, title: runFailedTitle(run.pipeline.name), body: runBody(org, run.runNumber, run.branch, stage && failedAt(stage.name)) }
    }
    case 'succeeded':
    case 'warning':
    case 'canceled':
      return watching ? { key, title: runFinishedTitle(run.pipeline.name, run.state), body: runBody(org, run.runNumber, run.branch) } : null
    default:
      return null
  }
}

function approvalNote(org: string, run: RunSummary, approval: ApprovalSummary): DesktopNotification {
  const place = approval.environment ?? approval.stage
  const body = runBody(org, run.runNumber, run.branch, place ? waitingAt(place) : undefined)
  return {
    key: `approval:${org}:${approval.approvalId}`,
    title: approvalTitle(run.pipeline.name),
    body: approval.canApprove ? `${body} · ${YOU_CAN_APPROVE}` : body
  }
}
