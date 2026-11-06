import {
  Badge,
  Box,
  Button,
  Callout,
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
import { acceptArm } from './arm'
import { OrgSettings, cancelSignIn, openSettings, settingsOrg, signOut, syncSettings } from './org-settings'
import { Setup, connecting, openSetup, openSignIn, reconnect, showConnectFailure, signInNotice, syncSignIn } from './setup'
import { TABS, actionError, activeOrg, busy, currentOrg, isTab, listing, messageOf, orgs, tab, view } from './state'
import { PipelinesTab } from './pipelines/pipelines-tab'
import { acceptRuns, hidePipelines, syncPipelines } from './pipelines/state'
import { PrsTab } from './prs/prs-tab'
import { syncReview } from './prs/review/state'
import { acceptPrs, hidePrs, syncPrs } from './prs/state'
import { syncShare } from './share/state'
import { watchVisibility } from './visibility'
import { syncWiki } from './wiki/state'
import { WikiTab } from './wiki/wiki-tab'
import { acceptChange, hideWork, syncWork } from './work/state'
import { WorkTab } from './work/work-tab'

type ProblemState = Exclude<OrgState, 'connected' | 'signing-in'>

const ENTRA_SIGN_IN_GUIDE =
  "Press Open sign-in page and pick the account you use for Azure DevOps. Orca asks before it opens login.microsoftonline.com. Tokens stay in Orca's encrypted secrets. Sign out deletes them. If Microsoft shows an error instead of the account picker, note its AADSTS code, press Cancel and see the README's troubleshooting."

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

const PROBLEMS: Record<ProblemState, { tone: 'danger' | 'warning' | 'neutral'; retry: string; signOut: boolean }> = {
  mismatch: { tone: 'danger', retry: 'Try again', signOut: true },
  expired: { tone: 'warning', retry: 'Reconnect', signOut: false },
  error: { tone: 'danger', retry: 'Reconnect', signOut: true },
  disconnected: { tone: 'neutral', retry: 'Reconnect', signOut: false }
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

export function setup(ctx: PanelContext): () => void {
  watchVisibility(ctx.visible)
  ctx.subscriptions.push(
    plugin.on('orgs.changed', payload => {
      set(orgs, payload.orgs)
      set(listing, { status: 'ready' })
      syncSettings(payload.orgs)
      syncSignIn(payload.orgs)
    }),
    plugin.on('orgs.connectFailed', showConnectFailure),
    plugin.on('work.changed', acceptChange),
    plugin.on('prs.changed', acceptPrs),
    plugin.on('runs.changed', acceptRuns),
    plugin.on('workspace.armChanged', acceptArm)
  )
  void loadOrgs()
  return () => {
    hideWork()
    hidePrs()
    hidePipelines()
  }
}

export function TabBody(props: { tab: string }): OrcaNode {
  if (read(tab) !== props.tab) return null
  const org = currentOrg(read(orgs), read(activeOrg))
  if (org && props.tab === 'work') return <WorkTab org={org} />
  if (org && props.tab === 'pipelines') return <PipelinesTab org={org} />
  if (org && props.tab === 'prs') return <PrsTab org={org} />
  if (org && props.tab === 'wiki') return <WikiTab org={org} />
  return null
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
  const notice = read(signInNotice)
  const { signInUrl } = org
  return (
    <Stack gap="sm">
      <Spinner label="Finish signing in in your browser…" />
      {org.tokenStore.kind === 'az-profile' ? (
        <Callout tone="neutral">
          {`Pick the account you use for Azure DevOps. Tokens stay in a private Azure CLI folder: ${org.tokenStore.path}. Sign out deletes it.`}
        </Callout>
      ) : null}
      {org.method === 'entra' ? <Callout tone="neutral">{ENTRA_SIGN_IN_GUIDE}</Callout> : null}
      {org.method === 'entra' && notice ? <Callout tone="warning">{notice}</Callout> : null}
      <Row gap="sm">
        {org.method === 'entra' && signInUrl ? (
          <Button disabled={read(busy) !== null} onPress={() => openSignIn(signInUrl)}>
            Open sign-in page
          </Button>
        ) : null}
        <Button variant="outline" disabled={read(busy) !== null} onPress={() => cancelSignIn(org.org)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

function Problem({ org, state }: { org: OrgStatus; state: ProblemState }): OrcaNode {
  const { tone, retry, signOut: offersSignOut } = PROBLEMS[state]
  const idle = read(busy) === null && !read(connecting)
  return (
    <Stack gap="sm">
      <Callout tone={tone}>{org.message ?? STATE_LABEL[state]}</Callout>
      <Row gap="sm" wrap>
        <Button disabled={!idle} onPress={() => reconnect(org)}>
          {retry}
        </Button>
        {offersSignOut ? (
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
        {org.account ? (
          <Text muted size="sm" truncate>
            {org.state === 'connected' ? `signed in as ${org.account.uniqueName}` : `pinned to ${org.account.uniqueName}`}
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
  const all = read(orgs)
  const org = currentOrg(all, read(activeOrg))
  const shown = read(view)
  const editing = shown === 'settings' ? all.find(item => item.org === read(settingsOrg)) : undefined
  const onScreen = loaded.status === 'ready' && shown !== 'setup' && !editing
  syncWork(org, onScreen)
  syncPrs(org, onScreen)
  syncPipelines(org, onScreen)
  syncShare(org?.org ?? null)
  syncReview(loaded.status === 'ready' && org?.state === 'connected' ? org.org : null)
  syncWiki(loaded.status === 'ready' && org?.state === 'connected' ? org.org : null)
  if (loaded.status === 'loading') return <Skeleton lines={3} label="Loading organizations" />
  if (loaded.status === 'failed') {
    return (
      <Stack gap="md">
        <Callout tone="danger">{loaded.message}</Callout>
        <Button onPress={loadOrgs}>Try again</Button>
      </Stack>
    )
  }
  if (!org || shown === 'setup') return <Setup />
  if (editing) return <OrgSettings org={editing} />
  return <Hub org={org} all={all} />
}
