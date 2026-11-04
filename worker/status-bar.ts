import type { OrgState, OrgStatus } from '../src/shared/types'

export type CountKind = 'toReview'
export type OrgCounts = ReadonlyMap<string, Partial<Record<CountKind, number>>>

export interface StatusBarState {
  text: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

export interface StatusBar {
  setOrgs(orgs: OrgStatus[]): void
  setCount(org: string, kind: CountKind, count: number | null): void
  counts(): OrgCounts
}

const STATE_LABEL: Record<OrgState, string> = {
  disconnected: 'not connected',
  'signing-in': 'signing in',
  connected: 'connected',
  expired: 'expired',
  mismatch: 'signed in as a different account',
  error: 'error'
}

const TONES_WORST_FIRST: StatusBarState['tone'][] = ['danger', 'warning', 'accent', 'success', 'neutral']

export function statusBarFor(orgs: OrgStatus[], counts?: OrgCounts): StatusBarState {
  if (orgs.length === 0) return { text: 'ADO', tone: 'neutral', tooltip: 'Azure DevOps: not connected' }
  const lines = orgs.map(status => (connectedAs(status) ? `${status.org} (${connectedAs(status)})` : `${status.org}: ${detail(status)}`))
  const review = reviewOf(orgs, counts)
  return {
    text: review ? `ADO · ${review.total} to review` : 'ADO',
    tone: review ? worst(toneFor(orgs), 'accent') : toneFor(orgs),
    tooltip: [`Azure DevOps: ${lines.join('\n')}`, review?.line].filter(Boolean).join('\n')
  }
}

export function statusText(orgs: OrgStatus[], counts?: OrgCounts): string {
  if (orgs.length === 0) return 'Not connected. Open the Azure DevOps panel to connect.'
  const lines = orgs.map(status => (connectedAs(status) ? `${status.org} — connected as ${connectedAs(status)}` : `${status.org} — ${detail(status)}`))
  return [...lines, reviewOf(orgs, counts)?.line].filter(Boolean).join('\n')
}

export function createStatusBar(update: (state: StatusBarState) => void): StatusBar {
  let orgs: OrgStatus[] = []
  const counts = new Map<string, Partial<Record<CountKind, number>>>()
  let shown = ''

  const repaint = () => {
    const state = statusBarFor(orgs, counts)
    const json = JSON.stringify(state)
    if (json === shown) return
    shown = json
    update(state)
  }

  return {
    setOrgs(next) {
      orgs = next
      const names = new Set(next.map(status => status.org))
      for (const name of [...counts.keys()]) if (!names.has(name)) counts.delete(name)
      repaint()
    },
    setCount(org, kind, count) {
      const kinds = { ...counts.get(org) }
      if (count === null) delete kinds[kind]
      else kinds[kind] = count
      if (Object.keys(kinds).length === 0) counts.delete(org)
      else counts.set(org, kinds)
      repaint()
    },
    counts: () => new Map([...counts].map(([org, kinds]) => [org, { ...kinds }]))
  }
}

function reviewOf(orgs: OrgStatus[], counts?: OrgCounts): { total: number; line: string } | null {
  const perOrg = orgs
    .filter(status => status.state === 'connected')
    .map(status => ({ org: status.org, count: counts?.get(status.org)?.toReview ?? 0 }))
    .filter(entry => entry.count > 0)
  const total = perOrg.reduce((sum, entry) => sum + entry.count, 0)
  if (total === 0) return null
  const noun = total === 1 ? 'pull request' : 'pull requests'
  return { total, line: `${total} ${noun} to review: ${perOrg.map(entry => `${entry.org} ${entry.count}`).join(', ')}` }
}

function toneFor(orgs: OrgStatus[]): StatusBarState['tone'] {
  if (orgs.some(status => status.state === 'mismatch' || status.state === 'error')) return 'danger'
  if (orgs.some(status => status.state === 'expired')) return 'warning'
  return orgs.every(status => status.state === 'connected') ? 'success' : 'neutral'
}

function worst(a: StatusBarState['tone'], b: StatusBarState['tone']): StatusBarState['tone'] {
  return TONES_WORST_FIRST.indexOf(a) <= TONES_WORST_FIRST.indexOf(b) ? a : b
}

function connectedAs(status: OrgStatus): string | undefined {
  return status.state === 'connected' ? status.account?.uniqueName : undefined
}

function detail(status: OrgStatus): string {
  return status.message ?? STATE_LABEL[status.state]
}
