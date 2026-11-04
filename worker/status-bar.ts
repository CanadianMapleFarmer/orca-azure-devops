import type { OrgState, OrgStatus } from '../src/shared/types'

export interface StatusBarState {
  text: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  tooltip: string
}

const STATE_LABEL: Record<OrgState, string> = {
  disconnected: 'not connected',
  'signing-in': 'signing in',
  connected: 'connected',
  expired: 'expired',
  mismatch: 'signed in as a different account',
  error: 'error'
}

export function statusBarFor(orgs: OrgStatus[]): StatusBarState {
  if (orgs.length === 0) return { text: 'ADO', tone: 'neutral', tooltip: 'Azure DevOps: not connected' }
  const lines = orgs.map(status => (connectedAs(status) ? `${status.org} (${connectedAs(status)})` : `${status.org}: ${detail(status)}`))
  return { text: 'ADO', tone: toneFor(orgs), tooltip: `Azure DevOps: ${lines.join('\n')}` }
}

export function statusText(orgs: OrgStatus[]): string {
  if (orgs.length === 0) return 'Not connected. Open the Azure DevOps panel to connect.'
  return orgs
    .map(status => (connectedAs(status) ? `${status.org} — connected as ${connectedAs(status)}` : `${status.org} — ${detail(status)}`))
    .join('\n')
}

function toneFor(orgs: OrgStatus[]): StatusBarState['tone'] {
  if (orgs.some(status => status.state === 'mismatch' || status.state === 'error')) return 'danger'
  if (orgs.some(status => status.state === 'expired')) return 'warning'
  return orgs.every(status => status.state === 'connected') ? 'success' : 'neutral'
}

function connectedAs(status: OrgStatus): string | undefined {
  return status.state === 'connected' ? status.account?.uniqueName : undefined
}

function detail(status: OrgStatus): string {
  return status.message ?? STATE_LABEL[status.state]
}
