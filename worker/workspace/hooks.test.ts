import { assert, mountWorker, test } from 'orca/testing'
import type { StorePort } from '../connections'
import { drain, fakeTimeouts, memoryStore } from '../test-support'
import { createContextCache, type ItemInfo } from './agents'
import { createArm } from './arm'
import { registerWorkspaceHooks, type WorkspaceHookDeps } from './hooks'
import { createLinkStore, LINKS_KEY } from './links'
import { createPendingLinks } from './pending'

const T0 = Date.parse('2026-11-04T09:00:00Z')
const MINUTE = 60_000
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ITEM = { org: 'contoso', itemId: 1204 }
const ITEM_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1204'
const PREFIX = `[ADO User Story #1204: Add vehicle search filters](${ITEM_URL})`
const CREATE = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2', base: 'main' } as const
const SOURCE = 'hotfix/1211-login-redirect'
const PR_ARMED = { org: 'contoso', branch: SOURCE, base: `origin/${SOURCE}`, prId: 4110 }
const REVIEWING = { ...CREATE, branch: SOURCE, name: SOURCE, base: `origin/${SOURCE}` }
const INFO: ItemInfo = { type: 'User Story', title: 'Add vehicle search filters', url: ITEM_URL }
const HOOKS = ['workspace.create.before', 'workspace.create.after', 'agent.prompt.before', 'agent.launch.before']

async function setup(over: Partial<WorkspaceHookDeps> = {}) {
  let now = T0
  const { data, store } = memoryStore()
  const arm = createArm(() => now)
  const pending = createPendingLinks(() => now)
  const links = await createLinkStore(store, () => now)
  const context = createContextCache()
  const state = { agentContext: true }
  const timeouts = fakeTimeouts()
  const deps: WorkspaceHookDeps = {
    arm,
    links,
    pending,
    context,
    itemInfo: async (org, itemId) => (org === 'contoso' && itemId === 1204 ? INFO : null),
    timeout: timeouts.timeout,
    agentContext: () => state.agentContext,
    ...over
  }
  const w = await mountWorker({ default: orca => registerWorkspaceHooks(orca, deps) }, { hooks: HOOKS, events: ['agent.status.changed'] })
  return {
    w,
    arm,
    pending,
    links,
    context,
    data,
    state,
    timeouts,
    advance: (ms: number) => void (now += ms)
  }
}

const status = (terminalId: string | undefined, workspaceId: string | null) =>
  ({ workspaceId, paneKey: 'pane-1', ...(terminalId ? { terminalId } : {}), state: 'working', receivedAt: T0 }) as const

test('an armed pull request sets the branch, name and base of exactly one worktree and links nothing', async () => {
  const { w, arm, links, data } = await setup()
  arm.arm(PR_ARMED)
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: REVIEWING })
  await w.hooks.fire('workspace.create.after', { workspaceId: 'ws-9', kind: 'worktree', path: '/repos/web-app-2', branch: SOURCE })
  await drain()
  assert.equal(links.byWorkspace('ws-9'), null)
  assert.equal(data[LINKS_KEY], undefined)
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: CREATE }, 'used once')
  assert.deepEqual(w.logs, [])
})

test('an expired or consumed arm passes the event through', async () => {
  const { w, arm, advance } = await setup()
  const passes = { kind: 'continue', event: CREATE }
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'nothing armed')

  arm.arm(PR_ARMED)
  advance(10 * MINUTE)
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'expired')

  arm.arm(PR_ARMED)
  assert.equal((await w.hooks.fire('workspace.create.before', CREATE)).kind, 'continue')
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), passes, 'consumed')
  assert.deepEqual(w.logs, [])
})

test('a pull request arm skips folder workspaces and stays armed for a worktree in any project', async () => {
  const { w, arm } = await setup()
  arm.arm(PR_ARMED)
  const folder = { kind: 'folder', projectId: 'repo-web', name: 'notes' } as const
  assert.deepEqual(await w.hooks.fire('workspace.create.before', folder), { kind: 'continue', event: folder })
  const elsewhere = { ...CREATE, projectId: 'repo-api' }
  assert.deepEqual(
    await w.hooks.fire('workspace.create.before', elsewhere),
    { kind: 'continue', event: { ...REVIEWING, projectId: 'repo-api' } },
    'no project ties the arm, so the next worktree in any project takes it, as the armed message warns'
  )
})

test("a pull request arm leaves alone the worktree an item's command creates, and serves the next one", async () => {
  const { w, arm, pending } = await setup()
  arm.arm(PR_ARMED)
  pending.expect({ ...ITEM, branch: BRANCH })
  const itemCreate = { ...CREATE, branch: `${BRANCH}-2`, name: BRANCH }
  assert.deepEqual(await w.hooks.fire('workspace.create.before', itemCreate), { kind: 'continue', event: itemCreate })
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: REVIEWING }, 'still armed')
})

test('a worktree created by hand passes through unnamed while nothing is armed', async () => {
  const { w, pending } = await setup()
  pending.expect({ ...ITEM, branch: BRANCH })
  assert.deepEqual(await w.hooks.fire('workspace.create.before', CREATE), { kind: 'continue', event: CREATE })
})

const created = (workspaceId: string, branch: string) => ({ workspaceId, kind: 'worktree', path: `/repos/${workspaceId}`, branch }) as const

test('create.after links the workspace made on a pending branch, or its -N copy, and tells the panel', async () => {
  const { w, pending, links, data } = await setup()
  pending.expect({ ...ITEM, branch: BRANCH })
  await w.hooks.fire('workspace.create.after', created('ws-9', `${BRANCH}-2`))
  await drain()
  assert.deepEqual(links.byWorkspace('ws-9'), ITEM)
  assert.deepEqual(Object.keys(data[LINKS_KEY] as object), ['ws-9'])
  assert.deepEqual(w.posts, [{ event: 'work.workspaceReady', payload: { ...ITEM, workspaceId: 'ws-9', branch: `${BRANCH}-2` } }])

  await w.hooks.fire('workspace.create.after', created('ws-10', BRANCH))
  assert.equal(links.byWorkspace('ws-10'), null, 'a pending link is used once')
  assert.equal(w.posts.length, 1)
  assert.deepEqual(w.logs, [])
})

test('create.after links nothing for another branch, after two minutes or without a pending link', async () => {
  const { w, pending, links, advance } = await setup()
  await w.hooks.fire('workspace.create.after', created('ws-1', BRANCH))
  assert.equal(links.byWorkspace('ws-1'), null, 'nothing pending')

  pending.expect({ ...ITEM, branch: BRANCH })
  await w.hooks.fire('workspace.create.after', created('ws-2', 'feature/1205-fix-pagination-offset'))
  await w.hooks.fire('workspace.create.after', created('ws-3', `orca/${BRANCH}`))
  assert.equal(links.byWorkspace('ws-2'), null, 'another branch')
  assert.equal(links.byWorkspace('ws-3'), null, 'another branch that ends the same')

  advance(2 * MINUTE + 1)
  await w.hooks.fire('workspace.create.after', created('ws-4', BRANCH))
  assert.equal(links.byWorkspace('ws-4'), null, 'too late')
  assert.deepEqual(w.posts, [])
})

test('a failed link save is logged by workspace id and never fails the hook', async () => {
  const failing: StorePort = { get: async () => null, set: async () => Promise.reject(new Error('disk full: secret-value')) }
  const { w, pending } = await setup({ links: await createLinkStore(failing, () => T0) })
  pending.expect({ ...ITEM, branch: BRANCH })
  const after = await w.hooks.fire('workspace.create.after', created('ws-9', BRANCH))
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

test('prompt context needs the item', async () => {
  const { w, links } = await setup({ itemInfo: async () => null })
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const event = { agent: 'claude', terminalId: 'term-linked', prompt: 'Fix it', inputKind: 'launch' } as const
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', event), { kind: 'continue', event })
})

test('prompt context waits for an item read that answers in time, capped under the 2 s hook budget', async () => {
  let answer: (info: ItemInfo | null) => void = () => {}
  const { w, links, timeouts } = await setup({ itemInfo: () => new Promise(resolve => (answer = resolve)) })
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const event = { agent: 'claude', terminalId: 'term-linked', prompt: 'Fix it', inputKind: 'launch' } as const

  const deciding = w.hooks.fire('agent.prompt.before', event)
  await drain()
  answer(INFO)
  assert.deepEqual(await deciding, { kind: 'continue', event: { ...event, prompt: `${PREFIX}\n\nFix it` } })
  assert.equal(timeouts.armed.length, 1)
  assert.ok(timeouts.armed[0].ms <= 1000, `the read is capped at ${timeouts.armed[0].ms} ms`)
})

test('a slow item read falls back to the prompt unchanged, and the next prompt tries again', async () => {
  const reads: AbortSignal[] = []
  let fast = false
  const { w, links, timeouts } = await setup({
    itemInfo: (_org, _itemId, signal) => {
      reads.push(signal)
      return fast ? Promise.resolve(INFO) : new Promise(() => {})
    }
  })
  await links.link('ws-linked', { org: 'contoso', itemId: 1204 })
  await w.emit('agent.status.changed', status('term-linked', 'ws-linked'))
  const prompt = (text: string) => ({ agent: 'claude', terminalId: 'term-linked', prompt: text, inputKind: 'orchestration' }) as const

  const deciding = w.hooks.fire('agent.prompt.before', prompt('Fix it'))
  await drain()
  timeouts.fire(timeouts.armed[0].ms)
  assert.deepEqual(await deciding, { kind: 'continue', event: prompt('Fix it') })
  assert.equal(reads[0].aborted, true, 'the read is aborted')

  fast = true
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', prompt('Next')), { kind: 'continue', event: prompt(`${PREFIX}\n\nNext`) })
  assert.deepEqual(w.logs, [])
})

test('prompt context escapes brackets in the title', async () => {
  const { w, links } = await setup({ itemInfo: async () => ({ type: 'User Story', title: '[Bug] Search', url: ITEM_URL }) })
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
    `[ADO Bug #1301: Regression of #1204: x](${ITEM_URL})\n\nGo`,
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
