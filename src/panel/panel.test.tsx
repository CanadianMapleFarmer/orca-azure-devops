import { afterEach, assert, hostError, mockHost, mount, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import type { WorkSnapshot } from '../shared/work'
import * as panelModule from './panel'

const PAT = 'secret'
const SETTINGS = { label: 'Organization settings' }

const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' }
]
const TEAMS: Record<string, { id: string; name: string }[]> = {
  'proj-boards': [{ id: 'team-ops', name: 'Ops' }, { id: 'team-alpha', name: 'Alpha' }],
  'proj-web': [{ id: 'team-web', name: 'Web Team' }]
}

function org(name: string, over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'azure-cli',
    state: 'connected',
    account: { adoId: `u-${name}`, uniqueName: `ada@${name}.com`, displayName: 'Ada Lovelace', tenantId: null, objectId: null },
    tokenStore: { kind: 'az-profile', path: `/Users/ada/.orca-azure-devops/az/${name}` },
    boards: null,
    codeProjects: 'all',
    ...over
  }
}

let panel: TestPanel

async function closeCleanly(): Promise<void> {
  const issues = { errors: panel.errors, warnings: panel.warnings, refusals: panel.refusals }
  await panel.unmount()
  assert.deepEqual(issues, { errors: [], warnings: [], refusals: [] })
}

afterEach(closeCleanly)

async function open(list: OrgStatus[], requests: MockRequests = {}, persisted?: { plugin?: Record<string, unknown> }) {
  const host = mockHost({
    requests: {
      'orgs.list': list,
      'ui.visibility': { ok: true },
      'work.snapshot': input => ({ org: input.org, board: null, mine: [], other: [], nudges: [], updatedAt: 0, stale: false }),
      ...requests
    }
  })
  panel = await mount(panelModule, { host, persisted })
  return host
}

const requestsTo = (host: ReturnType<typeof mockHost>, name: string) =>
  (host.callsOf('plugin.request') as { name: string; input: unknown; timeoutMs?: number }[]).filter(call => call.name === name)

const optionValues = (label: string) =>
  ((panel.find({ label })?.props as { options: { value: string }[] }).options ?? []).map(option => option.value)

const summaryText = () => panel.summary().join('\n')

const settingsRequests: MockRequests = {
  'ado.projects': PROJECTS,
  'ado.teams': ({ projectId }) => TEAMS[projectId] ?? []
}

test('shows setup when there are no orgs', async () => {
  await open([])
  assert.ok(summaryText().includes('Connect Azure DevOps'))
  assert.ok(panel.find({ label: 'Organization' }))
  assert.equal(panel.find({ label: 'Organization' })?.props?.placeholder, 'https://dev.azure.com/your-org')
  assert.equal(panel.valueOf({ label: 'Sign in with' }), 'azure-cli')
  assert.equal(panel.find({ label: 'Personal access token' }), null)
  assert.ok(panel.find({ text: 'Connect' }))
  assert.equal(panel.find({ text: 'Back' }), null)
})

test('connect sends the typed org and method', async () => {
  const sent: unknown[] = []
  const host = await open([], {
    'orgs.connect': input => {
      sent.push(input)
      return org('contoso', { method: 'pat' })
    }
  })
  await panel.type({ label: 'Organization' }, 'https://dev.azure.com/contoso')
  await panel.select({ label: 'Sign in with' }, 'pat')
  await panel.type({ label: 'Personal access token' }, PAT)
  assert.equal(JSON.stringify(panel.tree()).includes(PAT), false)
  assert.equal(summaryText().includes(PAT), false)

  await panel.press({ text: 'Connect' })
  assert.deepEqual(sent, [{ orgInput: 'https://dev.azure.com/contoso', method: 'pat', pat: PAT }])
  assert.equal(requestsTo(host, 'orgs.connect')[0]?.timeoutMs, 90000)
  assert.equal(JSON.stringify(panel.tree()).includes(PAT), false)
  assert.equal(panel.persisted.plugin.activeOrg, 'contoso')

  await panel.post('orgs.changed', { orgs: [org('contoso', { method: 'pat', tokenStore: { kind: 'orca-secrets' } })] })
  assert.ok(panel.find({ type: 'Tabs' }))
  assert.equal(JSON.stringify([panel.tree(), panel.persisted]).includes(PAT), false)
  assert.deepEqual(host.data(), { storage: {}, settings: {}, secrets: {} })
})

test('connect with the Azure CLI sends no token', async () => {
  const sent: unknown[] = []
  const host = await open([], {
    'orgs.connect': input => {
      sent.push(input)
      return org('contoso', { state: 'signing-in', account: null })
    }
  })
  await panel.type({ label: 'Organization' }, 'contoso')
  await panel.press({ text: 'Connect' })
  assert.deepEqual(sent, [{ orgInput: 'contoso', method: 'azure-cli' }])
  assert.equal(requestsTo(host, 'orgs.connect')[0]?.timeoutMs, 90000)
})

test('switching away from the token method discards a typed token', async () => {
  const sent: unknown[] = []
  await open([], {
    'orgs.connect': input => {
      sent.push(input)
      return org('contoso', { state: 'signing-in', account: null })
    }
  })
  await panel.select({ label: 'Sign in with' }, 'pat')
  await panel.type({ label: 'Personal access token' }, PAT)
  await panel.select({ label: 'Sign in with' }, 'azure-cli')
  await panel.select({ label: 'Sign in with' }, 'pat')
  assert.equal(panel.valueOf({ label: 'Personal access token' }), '')
  await panel.type({ label: 'Organization' }, 'contoso')
  await panel.press({ text: 'Connect' })
  assert.deepEqual(sent, [{ orgInput: 'contoso', method: 'pat', pat: '' }])
})

test('Connect stays disabled while a connection request is in flight', async () => {
  let release: (status: OrgStatus) => void = () => {}
  await open([], { 'orgs.connect': () => new Promise<OrgStatus>(resolve => (release = resolve)) })
  await panel.type({ label: 'Organization' }, 'contoso')
  const pressing = panel.press({ text: 'Connect' })
  for (let turn = 0; turn < 20 && panel.find({ text: 'Connect' })?.disabled !== true; turn++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.equal(panel.find({ text: 'Connect' })?.disabled, true)
  assert.ok(panel.find({ type: 'Spinner' }))
  release(org('contoso', { state: 'signing-in', account: null }))
  await pressing
  assert.equal(panel.find({ text: 'Connect' })?.disabled, false)
})

test('a rejected connect shows the message and discards the token', async () => {
  await open([], {
    'orgs.connect': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await panel.type({ label: 'Organization' }, 'contoso')
  await panel.select({ label: 'Sign in with' }, 'pat')
  await panel.type({ label: 'Personal access token' }, PAT)
  await panel.press({ text: 'Connect' })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, 'Azure DevOps is unreachable.')
  assert.equal(panel.valueOf({ label: 'Personal access token' }), '')
  assert.equal(panel.find({ text: 'Connect' })?.disabled, false)
  assert.equal(JSON.stringify(panel.tree()).includes(PAT), false)
})

test('a connect that answers with an error status shows its message in setup', async () => {
  await open([], { 'orgs.connect': () => org('contoso', { state: 'error', account: null, message: 'Paste a personal access token.' }) })
  await panel.type({ label: 'Organization' }, 'contoso')
  await panel.press({ text: 'Connect' })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Paste a personal access token.')
  assert.ok(panel.find({ label: 'Organization' }))
  await panel.press({ text: 'Connect' })
  assert.equal(panel.findAll({ type: 'Callout' }).length, 1)
})

test('a first connect the worker gave up on shows its reason in setup, ready to try again', async () => {
  await open([org('contoso', { state: 'signing-in', account: null })])
  await panel.post('orgs.changed', { orgs: [] })
  await panel.post('orgs.connectFailed', {
    org: 'contoso',
    url: 'https://dev.azure.com/contoso',
    method: 'azure-cli',
    message: "Azure DevOps didn't accept that sign-in."
  })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, "Azure DevOps didn't accept that sign-in.")
  assert.equal(panel.valueOf({ label: 'Organization' }), 'https://dev.azure.com/contoso')
  assert.equal(panel.valueOf({ label: 'Sign in with' }), 'azure-cli')
})

test('a failed first connect shows setup even while other orgs remain', async () => {
  await open([org('contoso'), org('fabrikam', { state: 'signing-in', account: null })], {}, { plugin: { activeOrg: 'fabrikam' } })
  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  await panel.post('orgs.connectFailed', {
    org: 'fabrikam',
    url: 'https://dev.azure.com/fabrikam',
    method: 'pat',
    message: 'Azure DevOps rejected the credentials.'
  })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps rejected the credentials.')
  assert.equal(panel.valueOf({ label: 'Organization' }), 'https://dev.azure.com/fabrikam')
  assert.equal(panel.valueOf({ label: 'Sign in with' }), 'pat')
  assert.ok(panel.find({ text: 'Back' }))
})

test('signing-in shows the browser hint and token location', async () => {
  await open([])
  await panel.post('orgs.changed', { orgs: [org('contoso', { state: 'signing-in', account: null })] })
  assert.ok(summaryText().includes('Spinner "Finish signing in in your browser…"'))
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'neutral')
  assert.equal(
    callout?.text,
    'Pick the account you use for Azure DevOps. Tokens stay in a private Azure CLI folder: /Users/ada/.orca-azure-devops/az/contoso. Sign out deletes it.'
  )
  assert.equal(panel.find({ type: 'Tabs' }), null)
})

test('signing in offers Cancel, which cancels the sign-in with a long timeout and keeps the pin', async () => {
  const host = await open([org('contoso', { state: 'signing-in' })], {
    'orgs.cancel': () => org('contoso', { state: 'disconnected', message: 'Sign-in was cancelled.' })
  })
  await panel.press({ text: 'Cancel' })
  assert.deepEqual(requestsTo(host, 'orgs.cancel'), [{ name: 'orgs.cancel', input: { org: 'contoso' }, timeoutMs: 90000 }])
  assert.deepEqual(requestsTo(host, 'orgs.signOut'), [])
})

test('a failed cancel shows the message', async () => {
  await open([org('contoso', { state: 'signing-in' })], {
    'orgs.cancel': () => {
      throw hostError('action_failed', "Couldn't delete this org's saved sign-in. Sign out to try again.")
    }
  })
  await panel.press({ text: 'Cancel' })
  assert.ok(panel.find({ text: "Couldn't delete this org's saved sign-in. Sign out to try again." }))
  assert.equal(panel.find({ text: 'Cancel' })?.disabled, false)
})

test('mismatch shows a danger callout with both accounts and signs out', async () => {
  const message = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
  const host = await open([org('contoso', { state: 'mismatch', message })], {
    'orgs.signOut': () => org('contoso', { state: 'disconnected', account: null })
  })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, message)
  assert.equal(panel.find({ type: 'Badge' })?.props?.tone, 'danger')
  assert.equal(panel.find({ text: /signed in as/ }), null)
  assert.equal(panel.find({ type: 'Tabs' }), null)

  await panel.press({ text: 'Sign out' })
  const [call] = requestsTo(host, 'orgs.signOut')
  assert.deepEqual(call, { name: 'orgs.signOut', input: { org: 'contoso' }, timeoutMs: 90000 })

  await panel.post('orgs.changed', { orgs: [org('contoso', { state: 'disconnected', account: null, message: 'Signed out.' })] })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Signed out.')
  assert.ok(panel.find({ text: 'Reconnect' }))
})

test('mismatch Try again reconnects with the same method and never signs out', async () => {
  const message = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
  const host = await open([org('contoso', { state: 'mismatch', message })], {
    'orgs.connect': () => org('contoso', { state: 'signing-in' })
  })
  await panel.press({ text: 'Try again' })
  assert.deepEqual(requestsTo(host, 'orgs.connect').map(call => call.input), [{ orgInput: 'https://dev.azure.com/contoso', method: 'azure-cli' }])
  assert.deepEqual(requestsTo(host, 'orgs.signOut'), [])
})

test('mismatch Try again on a token org asks for a token again and never signs out', async () => {
  const message = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
  const host = await open([org('contoso', { method: 'pat', state: 'mismatch', message, tokenStore: { kind: 'orca-secrets' } })])
  await panel.press({ text: 'Try again' })
  assert.equal(panel.valueOf({ label: 'Organization' }), 'https://dev.azure.com/contoso')
  assert.equal(panel.valueOf({ label: 'Sign in with' }), 'pat')
  assert.deepEqual(requestsTo(host, 'orgs.signOut'), [])
})

test('expired shows a warning callout and reconnects the Azure CLI org', async () => {
  const sent: unknown[] = []
  await open([org('contoso', { state: 'expired', message: 'Your sign-in expired. Reconnect to continue.' })], {
    'orgs.connect': input => {
      sent.push(input)
      return org('contoso', { state: 'signing-in', account: null })
    }
  })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'warning')
  assert.equal(callout?.text, 'Your sign-in expired. Reconnect to continue.')
  assert.equal(panel.find({ type: 'Badge' })?.props?.tone, 'warning')

  await panel.press({ text: 'Reconnect' })
  assert.deepEqual(sent, [{ orgInput: 'https://dev.azure.com/contoso', method: 'azure-cli' }])
})

test('reconnecting a token org opens setup with the org filled in', async () => {
  const host = await open([org('contoso', { method: 'pat', state: 'expired', tokenStore: { kind: 'orca-secrets' }, message: 'Your sign-in expired. Reconnect to continue.' })])
  await panel.press({ text: 'Reconnect' })
  assert.equal(panel.valueOf({ label: 'Organization' }), 'https://dev.azure.com/contoso')
  assert.equal(panel.valueOf({ label: 'Sign in with' }), 'pat')
  assert.equal(panel.valueOf({ label: 'Personal access token' }), '')
  assert.deepEqual(requestsTo(host, 'orgs.connect'), [])
})

test('an error state offers to reconnect or sign out', async () => {
  await open([org('contoso', { state: 'error', message: "Azure DevOps didn't accept that sign-in." })])
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, "Azure DevOps didn't accept that sign-in.")
  assert.ok(panel.find({ text: 'Reconnect' }))
  assert.ok(panel.find({ text: 'Sign out' }))
})

test('connected shows who is signed in, a success badge and the four tabs', async () => {
  await open([org('contoso')])
  assert.ok(panel.find({ text: 'signed in as ada@contoso.com' }))
  const badge = panel.find({ type: 'Badge' })
  assert.equal(badge?.props?.tone, 'success')
  assert.equal(badge?.text, 'Connected')
  assert.equal(panel.find({ type: 'Select', label: 'Organization' }), null)
  assert.ok(panel.find({ label: 'Organization settings' }))
  assert.ok(panel.find({ label: 'Add organization' }))
  assert.ok(summaryText().includes('Tabs "Azure DevOps": "Work" selected'))
  assert.ok(summaryText().includes(`EmptyState "Pick a boards project and team in this org's settings."`))
  const tabs = panel.find({ type: 'Tabs' })
  assert.deepEqual(
    panel.findAll({ type: 'Tab' }).map(tab => tab.props?.label),
    ['Work', 'Pipelines', 'PRs', 'Wiki']
  )
  assert.equal(tabs?.props?.value, 'work')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.ok(summaryText().includes('EmptyState "Coming in a later update"'))
})

test('the hub names the pinned account when the org is expired, mismatched or signed out', async () => {
  const states: Partial<OrgStatus>[] = [
    { state: 'expired', message: 'Your sign-in expired. Reconnect to continue.' },
    { state: 'mismatch', message: 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.' },
    { state: 'disconnected', message: 'Signed out.' }
  ]
  for (const over of states) {
    await open([org('contoso', over)])
    assert.ok(panel.find({ text: 'pinned to ada@contoso.com' }), over.state)
    assert.equal(panel.find({ text: /^signed in as/ }), null, over.state)
    await closeCleanly()
  }
  await open([org('contoso', { state: 'disconnected', account: null })])
  assert.equal(panel.find({ text: /^pinned to/ }), null, 'nothing pinned, nothing named')
})

test('org settings show where the tokens live', async () => {
  await open([org('contoso')], settingsRequests)
  await panel.press(SETTINGS)
  assert.ok(panel.find({ text: 'Tokens: /Users/ada/.orca-azure-devops/az/contoso' }))
  await closeCleanly()

  await open([org('contoso', { method: 'pat', tokenStore: { kind: 'orca-secrets' } })], settingsRequests)
  await panel.press(SETTINGS)
  assert.ok(panel.find({ text: "Tokens: Orca's encrypted secrets" }))
})

test('the chosen tab persists per workspace', async () => {
  await open([org('contoso')])
  await panel.select({ label: 'Azure DevOps' }, 'prs')
  assert.equal(panel.valueOf({ label: 'Azure DevOps' }), 'prs')
  assert.equal(panel.persisted.workspace.tab, 'prs')
})

test('several orgs get a picker and the choice persists for the plugin', async () => {
  await open([org('contoso'), org('fabrikam')])
  assert.deepEqual(optionValues('Organization'), ['contoso', 'fabrikam'])
  assert.equal(panel.valueOf({ label: 'Organization' }), 'contoso')
  assert.ok(panel.find({ text: 'signed in as ada@contoso.com' }))

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.ok(panel.find({ text: 'signed in as ada@fabrikam.com' }))
  assert.equal(panel.persisted.plugin.activeOrg, 'fabrikam')
})

test('an active org that no longer exists falls back to the first org', async () => {
  await open([org('contoso'), org('fabrikam')], {}, { plugin: { activeOrg: 'adatum' } })
  assert.equal(panel.valueOf({ label: 'Organization' }), 'contoso')
  assert.ok(panel.find({ text: 'signed in as ada@contoso.com' }))
})

test('a persisted active org is honoured', async () => {
  await open([org('contoso'), org('fabrikam')], {}, { plugin: { activeOrg: 'fabrikam' } })
  assert.equal(panel.valueOf({ label: 'Organization' }), 'fabrikam')
})

test('add organization opens setup with a way back', async () => {
  await open([org('contoso')])
  await panel.press({ label: 'Add organization' })
  assert.ok(panel.find({ label: 'Organization' }))
  assert.equal(panel.valueOf({ label: 'Organization' }), '')
  assert.equal(panel.find({ type: 'Tabs' }), null)

  await panel.press({ text: 'Back' })
  assert.ok(panel.find({ type: 'Tabs' }))
})

test('a newly connected org becomes the active one', async () => {
  await open([org('contoso')], { 'orgs.connect': () => org('fabrikam', { state: 'signing-in', account: null }) })
  await panel.press({ label: 'Add organization' })
  await panel.type({ label: 'Organization' }, 'fabrikam')
  await panel.press({ text: 'Connect' })
  await panel.post('orgs.changed', { orgs: [org('contoso'), org('fabrikam', { state: 'signing-in', account: null })] })
  assert.equal(panel.valueOf({ label: 'Organization' }), 'fabrikam')
  assert.ok(summaryText().includes('Spinner "Finish signing in in your browser…"'))
})

test('removing the last org returns to setup', async () => {
  await open([org('contoso')])
  await panel.post('orgs.changed', { orgs: [] })
  assert.ok(panel.find({ label: 'Organization' }))
  assert.ok(panel.find({ text: 'Connect' }))
})

test('a failed first load shows the message and can be retried', async () => {
  let attempts = 0
  await open([], {
    'orgs.list': () => {
      attempts += 1
      if (attempts === 1) throw hostError('unavailable', 'The Azure DevOps worker is not running.')
      return [org('contoso')]
    }
  })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'The Azure DevOps worker is not running.')
  await panel.press({ text: 'Try again' })
  assert.ok(panel.find({ type: 'Tabs' }))
})

test('settings saves the boards project and team', async () => {
  const saved: unknown[] = []
  const host = await open([org('contoso')], {
    ...settingsRequests,
    'orgs.setBoards': input => {
      saved.push(input)
      return org('contoso', { boards: { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' } })
    }
  })
  await panel.press(SETTINGS)
  assert.deepEqual(optionValues('Boards project'), ['proj-web', 'proj-boards'])
  assert.equal(panel.find({ label: 'Team' })?.disabled, true)
  assert.equal(panel.find({ text: /Showing the first/ }), null)

  await panel.select({ label: 'Boards project' }, 'proj-boards')
  assert.deepEqual(requestsTo(host, 'ado.teams').map(call => call.input), [{ org: 'contoso', projectId: 'proj-boards' }])
  assert.deepEqual(optionValues('Team'), ['team-ops', 'team-alpha'])
  assert.deepEqual(saved, [])

  await panel.select({ label: 'Team' }, 'team-ops')
  assert.deepEqual(saved, [{ org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' }])
  assert.equal(panel.valueOf({ label: 'Team' }), 'team-ops')
})

test('settings opens on the saved boards target', async () => {
  const boards = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-alpha', teamName: 'Alpha' }
  await open([org('contoso', { boards })], settingsRequests)
  await panel.press(SETTINGS)
  assert.equal(panel.valueOf({ label: 'Boards project' }), 'proj-boards')
  assert.deepEqual(optionValues('Team'), ['team-ops', 'team-alpha'])
  assert.equal(panel.valueOf({ label: 'Team' }), 'team-alpha')
})

test('picking another project clears the team until one is chosen', async () => {
  const boards = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-alpha', teamName: 'Alpha' }
  await open([org('contoso', { boards })], settingsRequests)
  await panel.press(SETTINGS)
  await panel.select({ label: 'Boards project' }, 'proj-web')
  assert.deepEqual(optionValues('Team'), ['team-web'])
  assert.equal(panel.valueOf({ label: 'Team' }), '')
})

test('code projects follow the all projects switch and a checkbox per project', async () => {
  const saved: unknown[] = []
  await open([org('contoso')], {
    ...settingsRequests,
    'orgs.setCodeProjects': input => {
      saved.push(input)
      return org('contoso')
    }
  })
  await panel.press(SETTINGS)
  assert.equal(panel.valueOf({ label: 'All projects with code' }), true)
  assert.equal(panel.find({ type: 'Checkbox' }), null)

  await panel.toggle({ label: 'All projects with code' })
  assert.deepEqual(panel.findAll({ type: 'Checkbox' }).map(box => box.props?.label), ['Web', 'Boards'])
  assert.deepEqual(saved, [])

  await panel.toggle({ label: 'Web' })
  await panel.toggle({ label: 'Boards' })
  assert.deepEqual(saved, [
    { org: 'contoso', projects: ['proj-web'] },
    { org: 'contoso', projects: ['proj-web', 'proj-boards'] }
  ])

  await panel.toggle({ label: 'Web' })
  await panel.toggle({ label: 'Boards' })
  assert.equal(saved.length, 3)
  assert.ok(panel.find({ text: /Pick at least one project/ }))

  await panel.toggle({ label: 'All projects with code' })
  assert.deepEqual(saved.at(-1), { org: 'contoso', projects: 'all' })
  assert.equal(panel.find({ type: 'Checkbox' }), null)
})

test('settings opens with the saved code projects ticked', async () => {
  await open([org('contoso', { codeProjects: [{ id: 'proj-web', name: 'Web' }] })], settingsRequests)
  await panel.press(SETTINGS)
  assert.equal(panel.valueOf({ label: 'All projects with code' }), false)
  assert.equal(panel.valueOf({ label: 'Web' }), true)
  assert.equal(panel.valueOf({ label: 'Boards' }), false)
})

test('a failed save shows the worker message', async () => {
  await open([org('contoso')], {
    ...settingsRequests,
    'orgs.setBoards': () => {
      throw hostError('action_failed', 'That project or team no longer exists.')
    }
  })
  await panel.press(SETTINGS)
  await panel.select({ label: 'Boards project' }, 'proj-boards')
  await panel.select({ label: 'Team' }, 'team-ops')
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, 'That project or team no longer exists.')
})

test('settings shows why the projects could not load and still offers sign out', async () => {
  await open([org('contoso')], {
    'ado.projects': () => {
      throw hostError('action_failed', "Your account can't access this in Azure DevOps.")
    }
  })
  await panel.press(SETTINGS)
  assert.equal(panel.find({ type: 'Callout' })?.text, "Your account can't access this in Azure DevOps.")
  assert.ok(panel.find({ text: 'Sign out' }))
})

test('settings for an org that is not connected skips the project lists', async () => {
  const host = await open([org('contoso', { state: 'signing-in', account: null })], settingsRequests)
  await panel.press(SETTINGS)
  assert.deepEqual(requestsTo(host, 'ado.projects'), [])
  assert.equal(panel.find({ label: 'Boards project' }), null)
  assert.ok(panel.find({ text: 'Sign out' }))
  assert.ok(panel.find({ text: 'Remove organization' }))
})

test('settings signs out with a long timeout and returns to the hub', async () => {
  const host = await open([org('contoso')], {
    ...settingsRequests,
    'orgs.signOut': () => org('contoso', { state: 'disconnected', account: null })
  })
  await panel.press(SETTINGS)
  await panel.press({ text: 'Sign out' })
  const [call] = requestsTo(host, 'orgs.signOut')
  assert.deepEqual(call, { name: 'orgs.signOut', input: { org: 'contoso' }, timeoutMs: 90000 })
  assert.equal(panel.find({ label: 'Boards project' }), null)
  assert.ok(panel.find({ label: 'Organization settings' }))
})

test('settings removes the org with a long timeout', async () => {
  const host = await open([org('contoso'), org('fabrikam')], {
    ...settingsRequests,
    'orgs.remove': () => ({ ok: true as const })
  })
  await panel.press(SETTINGS)
  await panel.press({ text: 'Remove organization' })
  await panel.press({ text: 'Confirm remove' })
  const [call] = requestsTo(host, 'orgs.remove')
  assert.deepEqual(call, { name: 'orgs.remove', input: { org: 'contoso' }, timeoutMs: 90000 })

  await panel.post('orgs.changed', { orgs: [org('fabrikam')] })
  assert.ok(panel.find({ text: 'signed in as ada@fabrikam.com' }))
  assert.equal(panel.find({ label: 'Boards project' }), null)
})

test('settings give way to the hub when the org being edited disappears', async () => {
  await open([org('contoso'), org('fabrikam')], settingsRequests)
  await panel.press(SETTINGS)
  await panel.post('orgs.changed', { orgs: [org('fabrikam')] })
  assert.equal(panel.find({ label: 'Boards project' }), null)
  assert.ok(panel.find({ text: 'signed in as ada@fabrikam.com' }))
})

test('a failed sign out shows the message and keeps the buttons', async () => {
  await open([org('contoso')], {
    ...settingsRequests,
    'orgs.signOut': () => {
      throw hostError('action_failed', "Couldn't delete this org's saved sign-in. Sign out to try again.")
    }
  })
  await panel.press(SETTINGS)
  await panel.press({ text: 'Sign out' })
  assert.equal(panel.find({ type: 'Callout' })?.text, "Couldn't delete this org's saved sign-in. Sign out to try again.")
  assert.equal(panel.find({ text: 'Sign out' })?.disabled, false)
})

test('a failed remove of the last org still shows why once setup takes over', async () => {
  const reason = "Couldn't delete this org's saved sign-in. It will be retried the next time Orca starts the plugin."
  await open([org('contoso')], {
    ...settingsRequests,
    'orgs.remove': () => {
      throw hostError('action_failed', reason)
    }
  })
  await panel.press(SETTINGS)
  await panel.press({ text: 'Remove organization' })
  await panel.press({ text: 'Confirm remove' })
  await panel.post('orgs.changed', { orgs: [] })
  assert.ok(panel.find({ text: 'Connect Azure DevOps' }))
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, reason)
})

test('settings has a way back', async () => {
  await open([org('contoso')], settingsRequests)
  await panel.press(SETTINGS)
  await panel.press({ text: 'Back' })
  assert.ok(panel.find({ type: 'Tabs' }))
})

test('code projects shown always match what the worker holds', async () => {
  let held: 'all' | string[] = ['proj-web']
  const status = () =>
    org('contoso', {
      codeProjects: held === 'all' ? 'all' : PROJECTS.filter(project => held.includes(project.id))
    })
  await open([status()], {
    ...settingsRequests,
    'orgs.setCodeProjects': ({ projects }) => {
      held = projects
      return status()
    }
  })
  await panel.press(SETTINGS)
  assert.equal(panel.valueOf({ label: 'All projects with code' }), false)
  assert.equal(panel.valueOf({ label: 'Web' }), true)

  await panel.toggle({ label: 'All projects with code' })
  assert.equal(held, 'all')
  await panel.post('orgs.changed', { orgs: [status()] })

  await panel.toggle({ label: 'All projects with code' })
  assert.equal(held, 'all')
  assert.equal(panel.valueOf({ label: 'Web' }), false)
  assert.equal(panel.valueOf({ label: 'Boards' }), false)
  assert.ok(panel.find({ text: /Pick at least one project/ }))

  await panel.toggle({ label: 'Boards' })
  assert.deepEqual(held, ['proj-boards'])
  await panel.post('orgs.changed', { orgs: [status()] })

  await panel.press({ text: 'Back' })
  await panel.press(SETTINGS)
  assert.equal(panel.valueOf({ label: 'All projects with code' }), false)
  assert.equal(panel.valueOf({ label: 'Boards' }), true)
  assert.equal(panel.valueOf({ label: 'Web' }), false)
})

test('long project and team lists stop at 500 entries with a note', async () => {
  const many = Array.from({ length: 501 }, (_, index) => ({ id: `item-${index}`, name: `Item ${index}` }))
  await open([org('contoso')], { 'ado.projects': many, 'ado.teams': many })
  const note = { text: 'Showing the first 500.' }
  await panel.press(SETTINGS)
  assert.equal(optionValues('Boards project').length, 500)
  assert.equal(panel.findAll(note).length, 1)

  await panel.select({ label: 'Boards project' }, 'item-0')
  assert.equal(optionValues('Team').length, 500)
  assert.equal(panel.findAll(note).length, 2)

  await panel.toggle({ label: 'All projects with code' })
  assert.equal(panel.findAll({ type: 'Checkbox' }).length, 500)
  assert.equal(panel.findAll(note).length, 3)
})

test('Remove organization asks for a second press before it removes anything', async () => {
  const host = await open([org('contoso')], { ...settingsRequests, 'orgs.remove': () => ({ ok: true as const }) })
  await panel.press(SETTINGS)
  await panel.press({ text: 'Remove organization' })
  assert.deepEqual(requestsTo(host, 'orgs.remove'), [])
  assert.equal(panel.find({ text: 'Remove organization' }), null)
  assert.ok(panel.find({ text: 'Confirm remove' }))

  await panel.press({ text: 'Cancel' })
  assert.deepEqual(requestsTo(host, 'orgs.remove'), [])
  assert.ok(panel.find({ text: 'Remove organization' }))
  assert.equal(panel.find({ text: 'Confirm remove' }), null)

  await panel.press({ text: 'Remove organization' })
  await panel.press({ text: 'Back' })
  await panel.press(SETTINGS)
  assert.ok(panel.find({ text: 'Remove organization' }))
})

test('settings opened while signing in load the projects once the org connects', async () => {
  const host = await open([org('contoso', { state: 'signing-in', account: null })], settingsRequests)
  await panel.press(SETTINGS)
  assert.deepEqual(requestsTo(host, 'ado.projects'), [])

  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  assert.equal(requestsTo(host, 'ado.projects').length, 1)
  assert.deepEqual(optionValues('Boards project'), ['proj-web', 'proj-boards'])

  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  assert.equal(requestsTo(host, 'ado.projects').length, 1)
})

const OPS = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
const ALPHA = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-alpha', teamName: 'Alpha' }
const RULE_COLUMNS = ['New', 'Active', 'Resolved']
const SUGGEST_MOVES = { type: 'Collapsible' }

type Rule = { branch: string; column: string }

function snapshotFor(name: string): WorkSnapshot {
  return {
    org: name,
    board: {
      org: name,
      projectId: OPS.projectId,
      teamId: OPS.teamId,
      boardId: 'board-stories',
      boardName: 'Stories',
      requirementTypes: ['User Story'],
      columns: RULE_COLUMNS.map((column, index) => ({ id: `col-${index}`, name: column, isSplit: false, columnType: 'inProgress', stateMappings: {} })),
      lanes: [],
      fields: { column: 'WEF_1_Kanban.Column', columnDone: 'WEF_1_Kanban.Column.Done', lane: 'WEF_1_Kanban.Lane' },
      areaPaths: [],
      doneStates: {}
    },
    mine: [],
    other: [],
    nudges: [],
    updatedAt: 0,
    stale: false
  }
}

function ruleRequests(stored: Rule[] = []) {
  const saves: { org: string; teamId: string; rules: Rule[] }[] = []
  const requests: MockRequests = {
    ...settingsRequests,
    'work.snapshot': input => snapshotFor(input.org),
    'work.nudgeRules': ({ org, teamId, rules }) => {
      if (!rules) return { rules: stored }
      saves.push({ org, teamId, rules })
      return { rules }
    }
  }
  return { saves, requests }
}

const branches = () => panel.findAll({ label: 'Branch' })
const columns = () => panel.findAll({ label: 'Column' })

async function openRules(stored: Rule[] = [], boards: OrgStatus['boards'] = OPS) {
  const rules = ruleRequests(stored)
  const host = await open([org('contoso', { boards })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  return { ...rules, host }
}

test('rules load, edit and save', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  const host = await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.title, 'Suggest moves')
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.open, false)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules'), [], 'nothing loads until the section opens')

  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules').map(call => call.input), [{ org: 'contoso', teamId: 'team-ops' }])
  assert.equal(requestsTo(host, 'work.snapshot').length, 1, 'the columns come from the Work snapshot already loaded')
  assert.ok(panel.find({ text: 'When a linked PR merges into this branch, suggest moving the item to this column.' }))
  assert.equal(branches().length, 1)
  assert.equal(panel.valueOf(branches()[0]), 'uat')
  assert.equal(panel.valueOf(columns()[0]), 'Resolved')
  assert.deepEqual(optionValues('Column'), RULE_COLUMNS)
  assert.equal(branches()[0].props.placeholder, 'uat')

  await panel.type(branches()[0], 'staging', { replace: true })
  await panel.select(columns()[0], 'Active')
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 2)
  assert.equal(panel.valueOf(branches()[1]), '')
  await panel.type(branches()[1], 'release/2026.11')
  await panel.select(columns()[1], 'Resolved')
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 3)
  await panel.press(panel.findAll({ label: 'Remove rule' })[2])
  assert.equal(branches().length, 2)
  assert.deepEqual(rules.saves, [])

  await panel.press({ text: 'Save rules' })
  assert.deepEqual(rules.saves, [
    {
      org: 'contoso',
      teamId: 'team-ops',
      rules: [{ branch: 'staging', column: 'Active' }, { branch: 'release/2026.11', column: 'Resolved' }]
    }
  ])
  assert.equal(branches().length, 2)
  assert.equal(panel.find({ type: 'Callout' }), null)

  await panel.press(panel.findAll({ label: 'Remove rule' })[0])
  assert.deepEqual(branches().map(row => panel.valueOf(row)), ['release/2026.11'])
})

test('empty branch rows are not saved', async () => {
  const { saves } = await openRules()
  assert.equal(branches().length, 0)
  await panel.press({ text: 'Add rule' })
  await panel.press({ text: 'Add rule' })
  await panel.press({ text: 'Add rule' })
  await panel.type(branches()[0], '  uat  ')
  await panel.select(columns()[0], 'Resolved')
  await panel.type(branches()[2], '   ')
  await panel.select(columns()[2], 'Active')

  await panel.press({ text: 'Save rules' })
  assert.deepEqual(saves, [{ org: 'contoso', teamId: 'team-ops', rules: [{ branch: 'uat', column: 'Resolved' }] }])
  assert.equal(branches().length, 1, 'the empty rows are gone once the saved rules come back')
  assert.equal(panel.valueOf(branches()[0]), 'uat')
})

test('Suggest moves only shows when the org has a boards team', async () => {
  const host = await open([org('contoso')], ruleRequests().requests)
  await panel.press(SETTINGS)
  assert.equal(panel.find(SUGGEST_MOVES), null)

  await panel.post('orgs.changed', { orgs: [org('contoso', { boards: OPS })] })
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.title, 'Suggest moves')

  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  assert.equal(panel.find(SUGGEST_MOVES), null)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules'), [])
})

test('a failed save shows the message in a danger callout and keeps the edits', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  let refuse = true
  rules.requests['work.nudgeRules'] = ({ rules: sent }) => {
    if (!sent) return { rules: [{ branch: 'uat', column: 'Resolved' }] }
    if (refuse) throw hostError('action_failed', "That column isn't on this board.")
    return { rules: sent }
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  await panel.type(branches()[0], 'staging', { replace: true })
  await panel.press({ text: 'Save rules' })

  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, "That column isn't on this board.")
  assert.equal(panel.valueOf(branches()[0]), 'staging')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)

  refuse = false
  await panel.press({ text: 'Save rules' })
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('rules that fail to load show the message and can be retried', async () => {
  const rules = ruleRequests()
  let attempts = 0
  rules.requests['work.nudgeRules'] = () => {
    attempts += 1
    if (attempts === 1) throw hostError('action_failed', "Couldn't read the saved rules.")
    return { rules: [{ branch: 'uat', column: 'Resolved' }] }
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  assert.equal(panel.find({ type: 'Callout' })?.props?.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, "Couldn't read the saved rules.")
  assert.equal(panel.find({ text: 'Add rule' }), null)

  await panel.press({ text: 'Try again' })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.valueOf(branches()[0]), 'uat')
})

test('the columns come from work.snapshot when the Work tab has none loaded', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  let snapshots = 0
  rules.requests['work.snapshot'] = input => {
    snapshots += 1
    if (snapshots === 1) throw hostError('action_failed', "Couldn't load work items.")
    return snapshotFor(input.org)
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  assert.equal(snapshots, 2)
  assert.deepEqual(optionValues('Column'), RULE_COLUMNS)
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('at most 20 rules can be added', async () => {
  const stored = Array.from({ length: 19 }, (_, index) => ({ branch: `release/${index}`, column: 'Resolved' }))
  await openRules(stored)
  assert.equal(branches().length, 19)
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, false)
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 20)
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, true)
  await panel.press(panel.findAll({ label: 'Remove rule' })[0])
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, false)
})

test('changing the boards team closes Suggest moves and loads that team\'s rules next time', async () => {
  const { host } = await openRules([{ branch: 'uat', column: 'Resolved' }])
  assert.equal(branches().length, 1)

  await panel.post('orgs.changed', { orgs: [org('contoso', { boards: ALPHA })] })
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.open, false)
  assert.equal(branches().length, 0)

  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules').map(call => call.input), [
    { org: 'contoso', teamId: 'team-ops' },
    { org: 'contoso', teamId: 'team-alpha' }
  ])
})
