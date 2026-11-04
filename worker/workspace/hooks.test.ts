import { assert, mountWorker, test } from 'orca/testing'
import type { StorePort } from '../connections'
import { drain, memoryStore } from '../test-support'
import { createContextCache } from './agents'
import { createArm } from './arm'
import { registerWorkspaceHooks, type WorkspaceHookDeps } from './hooks'
import { createLinkStore, LINKS_KEY } from './links'

const T0 = Date.parse('2026-11-04T09:00:00Z')
const MINUTE = 60_000
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ARMED = { org: 'contoso', itemId: 1204, branch: BRANCH }
const ITEM_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1204'
const PREFIX = `[ADO User Story #1204: Add vehicle search filters](${ITEM_URL})`
const CREATE = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2', base: 'main' } as const
const HOOKS = ['workspace.create.before', 'workspace.create.after', 'agent.prompt.before', 'agent.launch.before']

async function setup(over: Partial<WorkspaceHookDeps> = {}) {
  let now = T0
  const { data, store } = memoryStore()
  const arm = createArm(() => now)
  const links = await createLinkStore(store, () => now)
  const context = createContextCache()
  const state = { agentContext: true }
  const deps: WorkspaceHookDeps = {
    arm,
    links,
    context,
    itemInfo: (org, itemId) => (org === 'contoso' && itemId === 1204 ? { type: 'User Story', title: 'Add vehicle search filters', url: ITEM_URL } : null),
    agentContext: () => state.agentContext,
    ...over
  }
  const w = await mountWorker({ default: orca => registerWorkspaceHooks(orca, deps) }, { hooks: HOOKS, events: ['agent.status.changed'] })
  return {
    w,
    arm,
    links,
    context,
    data,
    state,
    advance: (ms: number) => void (now += ms)
  }
}

const status = (terminalId: string | undefined, workspaceId: string | null) =>
  ({ workspaceId, paneKey: 'pane-1', ...(terminalId ? { terminalId } : {}), state: 'working', receivedAt: T0 }) as const

test('an armed branch renames exactly one workspace creation', async () => {
  const { w, arm } = await setup()
  arm.arm(ARMED)
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: { ...CREATE, branch: BRANCH, name: BRANCH } })
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: CREATE })
  assert.deepEqual(w.logs, [])
})

test('an expired or consumed arm passes the event through', async () => {
  const { w, arm, advance } = await setup()
  const passes = { kind: 'continue', event: CREATE }
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'nothing armed')

  arm.arm(ARMED)
  advance(10 * MINUTE)
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'expired')

  arm.arm(ARMED)
  assert.equal((await w.hooks.fire('workspace.create.before', CREATE)).kind, 'continue')
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'consumed')
  assert.deepEqual(w.logs, [])
})

test('a folder creation passes unchanged and leaves the arm for the next worktree', async () => {
  const { w, arm } = await setup()
  arm.arm(ARMED)
  const folder = { kind: 'folder', projectId: 'repo-web', name: 'notes' } as const
  assert.deepEqual(await w.hooks.fire('workspace.create.before', folder), { kind: 'continue', event: folder })
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: { ...CREATE, branch: BRANCH, name: BRANCH } })
})

test('create.after links the workspace to the item', async () => {
  const { w, arm, links, data } = await setup()
  arm.arm(ARMED)
  await w.hooks.fire('workspace.create.before', CREATE)
  await w.hooks.fire('workspace.create.after', { workspaceId: 'ws-9', kind: 'worktree', path: '/repos/web-app-2', branch: BRANCH })
  await drain()
  assert.deepEqual(links.byWorkspace('ws-9'), { org: 'contoso', itemId: 1204 })
  assert.deepEqual(Object.keys(data[LINKS_KEY] as object), ['ws-9'])

  await w.hooks.fire('workspace.create.after', { workspaceId: 'ws-10', kind: 'worktree', path: '/repos/other', branch: BRANCH })
  assert.equal(links.byWorkspace('ws-10'), null, 'the arm links one workspace')
  assert.deepEqual(w.logs, [])
})

test('create.after links nothing for another branch, after 30 seconds or without a taken arm', async () => {
  const { w, arm, links, advance } = await setup()
  const created = (workspaceId: string, branch: string) => ({ workspaceId, kind: 'worktree', path: `/repos/${workspaceId}`, branch }) as const

  await w.hooks.fire('workspace.create.after', created('ws-1', BRANCH))
  assert.equal(links.byWorkspace('ws-1'), null, 'nothing was armed')

  arm.arm(ARMED)
  await w.hooks.fire('workspace.create.after', created('ws-2', BRANCH))
  assert.equal(links.byWorkspace('ws-2'), null, 'armed but not taken')

  await w.hooks.fire('workspace.create.before', CREATE)
  await w.hooks.fire('workspace.create.after', created('ws-3', 'feature/1205-fix-pagination-offset'))
  assert.equal(links.byWorkspace('ws-3'), null, 'another branch')

  advance(30_001)
  await w.hooks.fire('workspace.create.after', created('ws-4', BRANCH))
  assert.equal(links.byWorkspace('ws-4'), null, 'too late')

  arm.arm(ARMED)
  await w.hooks.fire('workspace.create.before', CREATE)
  await w.hooks.fire('workspace.create.after', created('ws-5', `orca/${BRANCH}`))
  assert.deepEqual(links.byWorkspace('ws-5'), { org: 'contoso', itemId: 1204 }, 'a prefix Orca added')
})

test('a failed link save is logged by workspace id and never fails the hook', async () => {
  const failing: StorePort = { get: async () => null, set: async () => Promise.reject(new Error('disk full: secret-value')) }
  const { w, arm } = await setup({ links: await createLinkStore(failing, () => T0) })
  arm.arm(ARMED)
  await w.hooks.fire('workspace.create.before', CREATE)
  const after = await w.hooks.fire('workspace.create.after', { workspaceId: 'ws-9', kind: 'worktree', path: '/repos/web-app-2', branch: BRANCH })
  await drain()
  assert.equal(after.kind, 'continue')
  assert.deepEqual(w.logs, ['could not save the link for workspace ws-9'])
})

test('prompt context is added only when enabled and linked, and only once', async () => {
  const { w, links, state } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  await w.emit('agent.status.changed', status('term-loose', 'ws-loose'))
  const prompt = (terminalId: string, text: string) => ({ agent: 'claude', terminalId, prompt: text, inputKind: 'orchestration' }) as const
  const unchanged = (terminalId: string, text: string) => ({ kind: 'continue', event: prompt(terminalId, text) })

  state.agentContext = false
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-linked', 'Fix it')), unchanged('term-linked', 'Fix it'), 'disabled')

  state.agentContext = true
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-loose', 'Fix it')), unchanged('term-loose', 'Fix it'), 'workspace is not linked')
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-unknown', 'Fix it')), unchanged('term-unknown', 'Fix it'), 'terminal is unknown')

  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-linked', 'Fix it')), {
    kind: 'continue',
    event: prompt('term-linked', `${PREFIX}\n\nFix it`)
  })
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-linked', 'And again')), unchanged('term-linked', 'And again'), 'only once')
  assert.deepEqual(w.logs, [])
})

test('prompt context needs the item in the cache', async () => {
  const { w, links } = await setup({ itemInfo: () => null })
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const event = { agent: 'claude', terminalId: 'term-linked', prompt: 'Fix it', inputKind: 'launch' } as const
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), { kind: 'continue', event })
})

test('prompt context escapes brackets in the title', async () => {
  const { w, links } = await setup({ itemInfo: () => ({ type: 'User Story', title: '[Bug] Search', url: ITEM_URL }) })
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const event = { agent: 'claude', terminalId: 'term-linked', prompt: 'Fix it', inputKind: 'launch' } as const
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), {
    kind: 'continue',
    event: { ...event, prompt: `[ADO User Story #1204: \\[Bug\\] Search](${ITEM_URL})\n\nFix it` }
  })
})

test('a prompt that already starts with the reference passes and counts as the terminal\'s one', async () => {
  const { w, links } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const prompt = (text: string) => ({ agent: 'claude', terminalId: 'term-linked', prompt: text, inputKind: 'launch' }) as const
  const own = `${PREFIX}\n\n## Description\n\nFilter by make.`
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt(own)), { kind: 'continue', event: prompt(own) })
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('Next')), { kind: 'continue', event: prompt('Next') })
})

test('a prompt whose reference has another title or type for the item still counts as carrying the context', async () => {
  const { w, links } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  const references = [
    `[ADO User Story #1204: Add vehicle search](${ITEM_URL})`,
    `[ADO Bug #1204: Add vehicle search filters](${ITEM_URL})`,
    `[ADO Product Backlog Item #1204: \\[Old\\] title](${ITEM_URL})`
  ]
  for (const [index, reference] of references.entries()) {
    const terminalId = `term-${index}`
    await w.emit('agent.status.changed', status(terminalId, 'ws-linked'))
    const event = { agent: 'claude', terminalId, prompt: `${reference}\n\n## Description\n\nFilter by make.`, inputKind: 'launch' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), { kind: 'continue', event }, reference)
    const next = { ...event, prompt: 'Next' }
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', next), { kind: 'continue', event: next }, `${reference} counted`)
  }
})

test('a prompt that references another item, or mentions the reference below its first line, still gets the context', async () => {
  const { w, links } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  const prompts = [
    `[ADO Bug #12041: Other](${ITEM_URL})\n\nGo`,
    `[ADO Bug #1205: Other](${ITEM_URL})\n\nGo`,
    `Go\n${PREFIX}`,
    `[x] #1204: Go`
  ]
  for (const [index, text] of prompts.entries()) {
    const terminalId = `term-${index}`
    await w.emit('agent.status.changed', status(terminalId, 'ws-linked'))
    const event = { agent: 'claude', terminalId, prompt: text, inputKind: 'orchestration' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), { kind: 'continue', event: { ...event, prompt: `${PREFIX}\n\n${text}` } }, text)
  }
})

test('a terminal marked as given the context gets no reference', async () => {
  const { w, links, context } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  context.record('term-launched', 'ws-linked')
  context.markGiven('term-launched')
  const event = { agent: 'claude', terminalId: 'term-launched', prompt: 'Next step', inputKind: 'orchestration' } as const
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), { kind: 'continue', event })
})

test('the workspace of a terminal comes from agent.launch.before and status events', async () => {
  const { w, links } = await setup()
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  const prompt = (terminalId: string) => ({ agent: 'claude', terminalId, prompt: 'Go', inputKind: 'launch' }) as const
  const prefixed = (terminalId: string) => ({ kind: 'continue', event: { ...prompt(terminalId), prompt: `${PREFIX}\n\nGo` } })
  const launch = (workspaceId: string | null, terminalId?: string) =>
    ({ agent: 'claude', workspaceId, workspaceKind: 'worktree', ...(terminalId ? { terminalId } : {}), command: 'claude', env: {} }) as const

  assert.deepEqual(await w.hooks.fire('agent.launch.before', launch('ws-linked', 'term-a')), { kind: 'continue', event: launch('ws-linked', 'term-a') })
  await w.hooks.fire('agent.launch.before', launch('ws-linked'))
  await w.hooks.fire('agent.launch.before', launch(null, 'term-b'))
  await w.emit('agent.status.changed', status(undefined, 'ws-linked'))
  await w.emit('agent.status.changed', status('term-c', null))
  await w.emit('agent.status.changed', status('term-d', 'ws-linked'))

  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-a')), prefixed('term-a'), 'from the launch hook')
  for (const unknown of ['term-b', 'term-c']) {
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt(unknown)), { kind: 'continue', event: prompt(unknown) }, unknown)
  }
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('term-d')), prefixed('term-d'), 'from a status event')
})
