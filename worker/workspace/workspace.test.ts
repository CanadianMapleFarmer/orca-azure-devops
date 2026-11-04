import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrgConfig } from '../../src/shared/types'
import { basicAuth } from '../auth/pat'
import { BOARDS, fakeAdo, ORG_URL, type FakeAdo } from '../boards/fake-ado'
import * as worker from '../main'
import { drain } from '../test-support'

const PAT = 'pat-workspace-test-8a41'
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ITEM_URL = `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204`
const PREFIX = `[ADO User Story #1204: Add vehicle search filters](${ITEM_URL})`
const ADA = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: '0f0e0d0c-0b0a-4908-8706-050403020100', objectId: null }
const ORG = {
  org: 'contoso',
  url: ORG_URL,
  tenantId: ADA.tenantId,
  method: 'pat',
  pinned: ADA,
  boards: BOARDS,
  codeProjects: 'all'
} satisfies OrgConfig
const FOCUSED = { id: 'ws-web', kind: 'worktree', name: 'web-app', path: '/repos/web-app', branch: 'main', hostId: null } as const
const REMOTE = { ...FOCUSED, id: 'ws-remote', path: '/srv/web-app', hostId: 'ssh:build-box' } as const
const STARTED = { id: 'ws-1204', kind: 'worktree', name: BRANCH, path: '/repos/web-app-1204', branch: BRANCH, hostId: null } as const
const NO_WORKSPACE = 'Start a workspace for this item first, or open one in Orca.'
const CREATE = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2', base: 'main' } as const

interface Desk { focused: typeof FOCUSED | typeof REMOTE | null; workspaces: (typeof FOCUSED | typeof REMOTE | typeof STARTED)[] }

interface Options { settings?: Record<string, string | boolean>; desk?: Partial<Desk>; launch?: () => unknown }

async function withDesk(
  options: Options,
  run: (desk: { w: Awaited<ReturnType<typeof mountWorker>>; host: ReturnType<typeof mockHost>; desk: Desk; ado: FakeAdo; block(): void; blockedCalls(): number }) => Promise<void>
): Promise<void> {
  const ado = fakeAdo()
  const realFetch = globalThis.fetch
  const guard = { blocked: false, hits: 0 }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (guard.blocked) {
      guard.hits += 1
      throw new Error('the network was used inside a hook')
    }
    const request = new Request(input, init)
    if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
    return ado.fetch(input, init)
  }) as typeof fetch
  const desk: Desk = { focused: FOCUSED, workspaces: [FOCUSED], ...options.desk }
  const host = mockHost({
    storage: { orgs: [ORG] },
    secrets: { 'pat:contoso': PAT },
    settings: options.settings,
    results: {
      'workspace.readContext': () => (desk.focused ? { branch: desk.focused.branch, displayName: desk.focused.name, terminals: [] } : null),
      'workspace.list': () => ({ workspaces: desk.workspaces, truncated: false }),
      'agent.launch': options.launch ?? (() => ({ terminalId: 'term-new' }))
    }
  })
  const w = await mountWorker(worker, { host })
  try {
    await run({ w, host, desk, ado, block: () => void (guard.blocked = true), blockedCalls: () => guard.hits })
  } finally {
    await w.deactivate()
    globalThis.fetch = realFetch
  }
}

const launchOf = (host: ReturnType<typeof mockHost>, index: number) => host.callsOf('agent.launch')[index] as unknown as { workspaceId: string; agent: string; prompt: string }

test('startAgent launches the default agent with the item prompt', async () => {
  await withDesk({ settings: { defaultAgent: 'codex' } }, async ({ w, host, ado }) => {
    const item = ado.items.get(1204)
    assert.ok(item)
    item.fields['System.Description'] = '<p>Filter results by make and model.</p>'
    item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] = '<p>Saved filters survive a reload.</p>'

    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    assert.deepEqual(host.callsOf('agent.launch'), [
      {
        workspaceId: 'ws-web',
        agent: 'codex',
        prompt: `${PREFIX}\n\n## Description\n\nFilter results by make and model.\n\n## Acceptance criteria\n\nSaved filters survive a reload.`
      }
    ])
    assert.equal(w.refusals.length, 0)
  })
})

test('startAgent launches claude when no default agent is set', async () => {
  await withDesk({}, async ({ w, host }) => {
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    assert.equal(launchOf(host, 0).agent, 'claude')
  })
})

test('startAgent without a workspace returns the message', async () => {
  await withDesk({ desk: { focused: null } }, async ({ w, host, ado }) => {
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: false, message: NO_WORKSPACE })
    assert.deepEqual(host.callsOf('agent.launch'), [])
    assert.equal(ado.calls.length, 0, 'nothing is loaded for a launch that cannot happen')
  })
})

test('startAgent launches in a remote workspace too', async () => {
  await withDesk({ desk: { focused: REMOTE, workspaces: [REMOTE] } }, async ({ w, host }) => {
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    assert.equal(launchOf(host, 0).workspaceId, REMOTE.id)
  })
})

test('startAgent lets a refused launch reach the panel', async () => {
  const launch = () => {
    throw hostError('unavailable', 'Orca could not start the agent.')
  }
  await withDesk({ launch }, async ({ w }) => {
    await assert.rejects(w.request('work.startAgent', { org: 'contoso', id: 1204 }), /Orca could not start the agent\./)
  })
})

test('startWorkspace arms the branch from the cached item, without calling Azure DevOps', async () => {
  await withDesk({}, async ({ w, ado }) => {
    await w.request('work.snapshot', { org: 'contoso' })
    const calls = ado.calls.length
    const before = Date.now()
    const armed = await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
    assert.equal(armed.branch, BRANCH)
    assert.ok(armed.armedUntil >= before + 600_000 && armed.armedUntil <= Date.now() + 600_000)
    assert.equal(ado.calls.length, calls)
  })
})

test('startWorkspace loads an item that is not cached and follows the branch template setting', async () => {
  await withDesk({ settings: { branchTemplate: 'users/ada/{id}-{slug}' } }, async ({ w, ado }) => {
    assert.equal((await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })).branch, 'users/ada/1204-add-vehicle-search-filters')
    assert.ok(ado.calls.length > 0)
  })
})

test('a workspace started from an item is linked, and its agent launches there with the item context', async () => {
  await withDesk({ settings: { agentContext: true } }, async ({ w, host, desk }) => {
    await w.request('work.snapshot', { org: 'contoso' })
    await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
    const created = await w.hooks.fire('workspace.create.before', CREATE)
    assert.deepEqual(created, { kind: 'continue', event: { ...CREATE, branch: BRANCH, name: BRANCH } })
    await w.hooks.fire('workspace.create.after', { workspaceId: STARTED.id, kind: 'worktree', path: STARTED.path, branch: BRANCH })
    desk.workspaces = [FOCUSED, STARTED]
    await drain()
    assert.equal((w.host.data().storage.workspaceLinks as Record<string, { itemId: number }>)[STARTED.id]?.itemId, 1204)

    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    assert.equal(launchOf(host, 0).workspaceId, STARTED.id, 'the linked workspace, not the focused one')

    const launched = { agent: 'claude', terminalId: 'term-new', prompt: 'ignored', inputKind: 'launch' } as const
    const own = { ...launched, prompt: `${PREFIX}\n\nAlready here` }
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', own), { kind: 'continue', event: own }, 'the launch prompt already carries the context')
    const later = { ...launched, prompt: 'Next step' }
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', later), { kind: 'continue', event: later })

    await w.emit('agent.status.changed', { workspaceId: STARTED.id, paneKey: 'pane-2', terminalId: 'term-other', state: 'working', receivedAt: Date.now() })
    const other = { ...launched, terminalId: 'term-other', prompt: 'Review it' }
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', other), { kind: 'continue', event: { ...other, prompt: `${PREFIX}\n\nReview it` } })

    desk.workspaces = [FOCUSED]
    const listed = host.callsOf('workspace.list').length
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    assert.equal(launchOf(host, 1).workspaceId, FOCUSED.id, 'a removed workspace falls back to the focused one')
    assert.equal(host.callsOf('workspace.list').length, listed + 1, 'the workspaces are listed once')
    assert.equal(w.refusals.length, 0)
    assert.deepEqual(w.logs, [])
  })
})

async function startLinked(w: Awaited<ReturnType<typeof mountWorker>>, desk: Desk): Promise<void> {
  await w.request('work.snapshot', { org: 'contoso' })
  await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
  await w.hooks.fire('workspace.create.before', CREATE)
  await w.hooks.fire('workspace.create.after', { workspaceId: STARTED.id, kind: 'worktree', path: STARTED.path, branch: BRANCH })
  desk.workspaces = [FOCUSED, STARTED]
  await drain()
}

test('the terminal startAgent launched gets no second reference', async () => {
  await withDesk({ settings: { agentContext: true } }, async ({ w, host, desk }) => {
    await startLinked(w, desk)
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    const next = { agent: 'claude', terminalId: 'term-new', prompt: 'Next step', inputKind: 'orchestration' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', next), { kind: 'continue', event: next })
    assert.equal(launchOf(host, 0).workspaceId, STARTED.id)
  })
})

test('a launch prompt built from a newer title than the cached one is not prefixed again', async () => {
  await withDesk({ settings: { agentContext: true } }, async ({ w, host, desk, ado }) => {
    await startLinked(w, desk)
    const item = ado.items.get(1204)
    assert.ok(item)
    item.fields['System.Title'] = 'Add vehicle search filters [v2]'
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { launched: true })
    const { prompt } = launchOf(host, 0)
    assert.equal(prompt, `[ADO User Story #1204: Add vehicle search filters \\[v2\\]](${ITEM_URL})`)

    await w.emit('agent.status.changed', { workspaceId: STARTED.id, paneKey: 'pane-3', terminalId: 'term-hooked-first', state: 'working', receivedAt: Date.now() })
    const launch = { agent: 'claude', terminalId: 'term-hooked-first', prompt, inputKind: 'launch' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', launch), { kind: 'continue', event: launch })
  })
})

test('hooks answer without awaiting the network', async () => {
  await withDesk({ settings: { agentContext: true } }, async ({ w, host, ado, block, blockedCalls }) => {
    await w.request('work.snapshot', { org: 'contoso' })
    await w.request('work.startWorkspace', { org: 'contoso', id: 1204 })
    await w.emit('agent.status.changed', { workspaceId: STARTED.id, paneKey: 'pane-2', terminalId: 'term-1', state: 'working', receivedAt: Date.now() })
    const adoCalls = ado.calls.length
    const hostCalls = host.calls.length
    block()

    const created = await w.hooks.fire('workspace.create.before', CREATE)
    assert.equal(created.kind === 'continue' && created.event.name, BRANCH)
    await w.hooks.fire('workspace.create.after', { workspaceId: STARTED.id, kind: 'worktree', path: STARTED.path, branch: BRANCH })
    const launch = { agent: 'claude', workspaceId: STARTED.id, workspaceKind: 'worktree', terminalId: 'term-2', command: 'claude', env: {} } as const
    assert.equal((await w.hooks.fire('agent.launch.before', launch)).kind, 'continue')
    const prompt = await w.hooks.fire('agent.prompt.before', { agent: 'claude', terminalId: 'term-1', prompt: 'Fix it', inputKind: 'orchestration' })
    assert.equal(prompt.kind === 'continue' && prompt.event.prompt, `${PREFIX}\n\nFix it`)

    assert.equal(blockedCalls(), 0)
    assert.equal(ado.calls.length, adoCalls)
    const hostMethods = host.calls.slice(hostCalls).map(call => call.method)
    assert.deepEqual(hostMethods.filter(method => !method.startsWith('storage.')), [], 'no host call besides the link write')
    assert.deepEqual(w.logs, [])
  })
})
