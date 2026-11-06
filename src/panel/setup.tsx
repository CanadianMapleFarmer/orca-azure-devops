import { atom, Button, Callout, Heading, Input, plugin, RadioGroup, read, Row, set, shell, Spinner, Stack, Text, update, type OrcaNode } from 'orca'
import { OPEN_LINK_UNAVAILABLE } from '../shared/messages'
import type { ConnectFailure, ConnectionMethod, OrgStatus } from '../shared/types'
import { actionError, activeOrg, LONG_WAIT, messageOf, orgs, view } from './state'

const METHODS = [
  { value: 'azure-cli', label: 'Azure CLI (no setup)' },
  { value: 'entra', label: 'Microsoft account (needs an app ID)' },
  { value: 'pat', label: 'Personal access token' }
]

const APP_ID_HINT = 'Uses the app (client) ID in Settings → Azure DevOps. An admin registers the app once; the README explains how.'
const SIGN_IN_NOT_OPENED = "The sign-in page wasn't opened. Press Open sign-in page to try again."

const orgInput = atom('')
const method = atom<ConnectionMethod>('azure-cli')
const tokenDraft = atom('')
const tokenField = atom(0)
const setupError = atom<string | null>(null)
export const connecting = atom(false)
export const signInNotice = atom<string | null>(null)

const isMethod = (value: string): value is ConnectionMethod => value === 'azure-cli' || value === 'entra' || value === 'pat'

const waitsForBrowser = (org: OrgStatus): boolean => org.state === 'signing-in' && Boolean(org.signInUrl)

export function syncSignIn(list: readonly OrgStatus[]): void {
  if (!list.some(waitsForBrowser)) set(signInNotice, null)
}

export function openSignIn(url: string): void {
  const opening = shell.openExternal(url)
  set(signInNotice, null)
  const show = (text: string): void => {
    if (read(orgs).some(waitsForBrowser)) set(signInNotice, text)
  }
  opening.then(
    result => {
      if (!result.opened) show(result.reason === 'consent-unavailable' ? OPEN_LINK_UNAVAILABLE : SIGN_IN_NOT_OPENED)
    },
    error => show(messageOf(error))
  )
}

function discardToken(): void {
  set(tokenDraft, '')
  update(tokenField, count => count + 1)
}

function chooseMethod(value: string): void {
  if (value !== 'pat') discardToken()
  if (isMethod(value)) set(method, value)
}

export function openSetup(): void {
  discardToken()
  set(orgInput, '')
  set(method, 'azure-cli')
  set(setupError, null)
  set(actionError, null)
  set(view, 'setup')
}

function leaveSetup(): void {
  discardToken()
  set(setupError, null)
  set(view, 'hub')
}

export function showConnectFailure(failure: ConnectFailure): void {
  discardToken()
  set(orgInput, failure.url)
  set(method, failure.method)
  set(setupError, failure.message)
  set(view, 'setup')
}

export function reconnect(org: OrgStatus): void {
  discardToken()
  set(orgInput, org.url)
  set(method, org.method)
  set(setupError, null)
  set(actionError, null)
  if (org.method === 'pat') set(view, 'setup')
  else void connect()
}

async function connect(): Promise<void> {
  if (read(connecting)) return
  const input = read(orgInput)
  const chosen = read(method)
  const request = chosen === 'pat' ? { orgInput: input, method: chosen, pat: read(tokenDraft) } : { orgInput: input, method: chosen }
  set(connecting, true)
  set(setupError, null)
  set(actionError, null)
  if (chosen === 'pat') set(view, 'setup')
  try {
    const status = await plugin.request('orgs.connect', request, LONG_WAIT)
    if (status.state === 'error') {
      set(setupError, status.message ?? 'Sign-in failed.')
      set(view, 'setup')
    } else {
      set(activeOrg, status.org)
      set(orgInput, '')
      set(method, 'azure-cli')
      set(view, 'hub')
    }
  } catch (error) {
    set(setupError, messageOf(error))
    set(view, 'setup')
  } finally {
    discardToken()
    set(connecting, false)
  }
}

export function Setup(): OrcaNode {
  const pending = read(connecting)
  const chosen = read(method)
  const error = read(setupError)
  const failedAction = read(actionError)
  return (
    <Stack gap="md">
      <Row align="center" gap="sm">
        {read(orgs).length > 0 ? (
          <Button variant="ghost" size="sm" disabled={pending} onPress={leaveSetup}>
            Back
          </Button>
        ) : null}
        <Heading level={3}>Connect Azure DevOps</Heading>
      </Row>
      {failedAction ? <Callout tone="danger">{failedAction}</Callout> : null}
      <Input
        label="Organization"
        placeholder="https://dev.azure.com/your-org"
        value={read(orgInput)}
        disabled={pending}
        onChange={value => set(orgInput, value)}
      />
      <RadioGroup label="Sign in with" options={METHODS} value={chosen} disabled={pending} onChange={chooseMethod} />
      {chosen === 'entra' ? (
        <Text muted size="sm">
          {APP_ID_HINT}
        </Text>
      ) : null}
      {chosen === 'pat' ? (
        // Uncontrolled so the token never enters the rendered tree; the key resets the field.
        <Input
          key={`token-${read(tokenField)}`}
          label="Personal access token"
          type="password"
          disabled={pending}
          onChange={value => set(tokenDraft, value)}
        />
      ) : null}
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {pending ? <Spinner label="Connecting…" /> : null}
      <Button disabled={pending} onPress={connect}>
        Connect
      </Button>
    </Stack>
  )
}
