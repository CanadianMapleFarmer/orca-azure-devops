import {
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  IconButton,
  plugin,
  read,
  Row,
  Select,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { OrgState, OrgStatus } from '../shared/types'
import { OrgSettings, openSettings, settingsOrg, signOut, syncSettings } from './org-settings'
import { Setup, connecting, openSetup, reconnect } from './setup'
import { TABS, actionError, activeOrg, busy, currentOrg, isTab, listing, messageOf, orgs, tab, view } from './state'

type ProblemState = Exclude<OrgState, 'connected' | 'signing-in'>

const STATE_TONE = {
  connected: 'success',
  expired: 'warning',
  mismatch: 'danger',
  error: 'danger',
  'signing-in': 'neutral',
  disconnected: 'neutral'
} as const

const STATE_LABEL: Record<OrgState, string> = {
  connected: 'Connected',
  expired: 'Expired',
  mismatch: 'Mismatch',
  error: 'Error',
  'signing-in': 'Signing in',
  disconnected: 'Signed out'
}

const PROBLEMS: Record<ProblemState, { tone: 'danger' | 'warning' | 'neutral'; actions: readonly ('reconnect' | 'sign-out')[] }> = {
  mismatch: { tone: 'danger', actions: ['sign-out'] },
  expired: { tone: 'warning', actions: ['reconnect'] },
  error: { tone: 'danger', actions: ['reconnect', 'sign-out'] },
  disconnected: { tone: 'neutral', actions: ['reconnect'] }
}

async function loadOrgs(): Promise<void> {
  set(listing, { status: 'loading' })
  try {
    const list = await plugin.request('orgs.list', {})
    if (read(listing).status !== 'loading') return
    set(orgs, list)
    set(listing, { status: 'ready' })
  } catch (error) {
    if (read(listing).status === 'loading') set(listing, { status: 'failed', message: messageOf(error) })
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('orgs.changed', payload => {
      set(orgs, payload.orgs)
      set(listing, { status: 'ready' })
      syncSettings(payload.orgs)
    })
  )
  void loadOrgs()
}

export function TabBody(props: { tab: string }): OrcaNode {
  return <EmptyState title="Coming in a later update" />
}

function Workspace(): OrcaNode {
  return (
    <Tabs
      label="Azure DevOps"
      value={read(tab)}
      onChange={value => {
        if (isTab(value)) set(tab, value)
      }}
    >
      {TABS.map(item => (
        <Tab key={item.id} value={item.id} label={item.label}>
          <TabBody tab={item.id} />
        </Tab>
      ))}
    </Tabs>
  )
}

function SigningIn({ org }: { org: OrgStatus }): OrcaNode {
  return (
    <Stack gap="sm">
      <Spinner label="Finish signing in in your browser…" />
      {org.tokenStore.kind === 'az-profile' ? (
        <Callout tone="neutral">
          {`Pick the account you use for Azure DevOps. Tokens stay in a private Azure CLI folder: ${org.tokenStore.path}. Sign out deletes it.`}
        </Callout>
      ) : null}
    </Stack>
  )
}

function Problem({ org, state }: { org: OrgStatus; state: ProblemState }): OrcaNode {
  const { tone, actions } = PROBLEMS[state]
  const idle = read(busy) === null && !read(connecting)
  return (
    <Stack gap="sm">
      <Callout tone={tone}>{org.message ?? STATE_LABEL[state]}</Callout>
      <Row gap="sm" wrap>
        {actions.includes('reconnect') ? (
          <Button disabled={!idle} onPress={() => reconnect(org)}>
            Reconnect
          </Button>
        ) : null}
        {actions.includes('sign-out') ? (
          <Button tone="danger" disabled={!idle} onPress={() => signOut(org.org)}>
            Sign out
          </Button>
        ) : null}
      </Row>
    </Stack>
  )
}

function HubBody({ org }: { org: OrgStatus }): OrcaNode {
  switch (org.state) {
    case 'connected':
      return <Workspace />
    case 'signing-in':
      return <SigningIn org={org} />
    default:
      return <Problem org={org} state={org.state} />
  }
}

function Header({ org, all }: { org: OrgStatus; all: readonly OrgStatus[] }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        {all.length > 1 ? (
          <Box grow shrink minWidth={0}>
            <Select
              label="Organization"
              labelHidden
              value={org.org}
              options={all.map(item => ({ value: item.org, label: item.org }))}
              onChange={value => set(activeOrg, value)}
            />
          </Box>
        ) : (
          <Text weight="semibold" truncate>
            {org.org}
          </Text>
        )}
        <Row gap="xs" align="center">
          <IconButton icon="add" label="Add organization" variant="ghost" size="sm" onPress={openSetup} />
          <IconButton icon="settings" label="Organization settings" variant="ghost" size="sm" onPress={() => openSettings(org)} />
        </Row>
      </Row>
      <Row gap="sm" align="center" wrap>
        {org.state === 'connected' && org.account ? (
          <Text muted size="sm" truncate>
            {`signed in as ${org.account.uniqueName}`}
          </Text>
        ) : null}
        <Badge tone={STATE_TONE[org.state]}>{STATE_LABEL[org.state]}</Badge>
      </Row>
    </Stack>
  )
}

function Hub({ org, all }: { org: OrgStatus; all: readonly OrgStatus[] }): OrcaNode {
  const error = read(actionError)
  return (
    <Stack gap="md">
      <Header org={org} all={all} />
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <HubBody org={org} />
    </Stack>
  )
}

export default function Panel(): OrcaNode {
  const loaded = read(listing)
  if (loaded.status === 'loading') return <Skeleton lines={3} label="Loading organizations" />
  if (loaded.status === 'failed') {
    return (
      <Stack gap="md">
        <Callout tone="danger">{loaded.message}</Callout>
        <Button onPress={loadOrgs}>Try again</Button>
      </Stack>
    )
  }
  const all = read(orgs)
  const org = currentOrg(all, read(activeOrg))
  const shown = read(view)
  if (!org || shown === 'setup') return <Setup />
  const editing = shown === 'settings' ? all.find(item => item.org === read(settingsOrg)) : undefined
  if (editing) return <OrgSettings org={editing} />
  return <Hub org={org} all={all} />
}
