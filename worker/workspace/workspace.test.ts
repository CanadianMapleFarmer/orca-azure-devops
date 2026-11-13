import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, mockHost, test, type TestWorker } from 'orca/testing'
import type { OrgConfig } from '../../src/shared/types'
import { basicAuth } from '../auth/pat'
import { BOARDS, fakeAdo, ORG_URL, type FakeAdo } from '../boards/fake-ado'
import * as worker from '../main'
import { drain, withWorker } from '../test-support'
import { createCommand, launchCommand, START_FILES_FOLDER } from './command'

const PAT = 'pat-workspace-test-8a41'
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ITEM_URL = `${ORG_URL}/Fabrikam%20Web/_workitems/edit/1204`
const PREFIX = `[ADO User Story #1204: Add vehicle search filters](${ITEM_URL})`
const ITEM = { org: 'contoso', itemId: 1204 }
const WEB_KEY = 'contoso/fabrikam web/web-app'
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
const NO_WORKSPACE = 'This item has no workspace in Orca yet. Start a workspace and agent first.'
const FISH = 'Starting a workspace or an agent from an item works with the bash and zsh shells only for now. Yours is fish.'

interface Entry { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }

interface Desk { focused: Entry | null; workspaces: Entry[] }

interface Options { settings?: Record<string, string | boolean>; shell?: string }

interface Run { w: TestWorker; host: ReturnType<typeof mockHost>; desk: Desk; web: Entry; started: Entry; ado: FakeAdo; starts: string; block(): void; blockedCalls(): number }

async function withDesk(options: Options, run: (desk: Run) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-'))
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', `${ORG_URL}/Fabrikam%20Web/_git/web-app`]]) {
    const result = spawnSync('git', ['-C', dir, ...args])
    assert.equal(result.status, 0, String(result.stderr))
  }
  const web: Entry = { id: 'repo-web::/repos/web-app', kind: 'worktree', name: 'web-app', path: dir, branch: 'main', hostId: null }
  const started: Entry = { id: 'repo-web::/repos/web-app-1204', kind: 'worktree', name: BRANCH, path: `${dir}-1204`, branch: BRANCH, hostId: null }
  const ado = fakeAdo()
  const realFetch = globalThis.fetch
  const realShell = process.env.SHELL
  const realHome = process.env.HOME
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-test-home-'))
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
  process.env.SHELL = options.shell ?? '/bin/zsh'
  process.env.HOME = home
  const desk: Desk = { focused: web, workspaces: [web] }
  const host = mockHost({
    storage: { orgs: [ORG] },
    secrets: { 'pat:contoso': PAT },
    settings: options.settings,
    results: {
      'workspace.readContext': () => (desk.focused ? { branch: desk.focused.branch ?? '', displayName: desk.focused.name, terminals: [] } : null),
      'workspace.list': () => ({ workspaces: desk.workspaces, truncated: false }),
      'terminal.create': () => ({ terminalId: 'term-ado' }),
      'workspace.open': { opened: true }
    }
  })
  try {
    const starts = path.join(home, ...START_FILES_FOLDER.split('/'))
    await withWorker(worker, { host }, w => run({ w, host, desk, web, started, ado, starts, block: () => void (guard.blocked = true), blockedCalls: () => guard.hits }))
  } finally {
    globalThis.fetch = realFetch
    if (realShell === undefined) delete process.env.SHELL
    else process.env.SHELL = realShell
    process.env.HOME = realHome
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
}

const terminalsOf = (host: ReturnType<typeof mockHost>) => host.callsOf('terminal.create') as { workspaceId: string; title: string; command: string }[]

const fileIdOf = (command: string) => /starts\/([0-9a-f]+)\.prompt\)/.exec(command)?.[1] ?? ''

async function startFiles(starts: string): Promise<Record<string, { text: string; mode: number }>> {
  const names = await fs.readdir(starts).catch(() => [] as string[])
  const entries = await Promise.all(names.map(async name => [name, { text: await fs.readFile(path.join(starts, name), 'utf8'), mode: (await fs.stat(path.join(starts, name))).mode & 0o777 }] as const))
  return Object.fromEntries(entries)
}

async function startLinked({ w, desk, started }: Run): Promise<void> {
  await w.request('work.snapshot', { org: 'contoso' })
  await w.request('work.startWork', { org: 'contoso', id: 1204 })
  await w.hooks.fire('workspace.create.after', { workspaceId: started.id, kind: 'worktree', path: started.path, branch: BRANCH })
  desk.workspaces = [...desk.workspaces, started]
  await drain()
}

test('Start a workspace and agent in a picked repo creates the workspace, links it, and Start an agent runs there with the item context', async () => {
  await withDesk({ settings: { defaultAgent: 'codex', agentContext: true } }, async run => {
    const { w, host, desk, web, started, ado, starts } = run
    const item = ado.items.get(1204)
    assert.ok(item)
    item.fields['System.Description'] = '<p>Filter results by make and model.</p>'
    item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] = '<p>Saved filters survive a reload.</p>'
    const prompts = {
      full: `${PREFIX}\n\n## Description\n\nFilter results by make and model.\n\n## Acceptance criteria\n\nSaved filters survive a reload.`,
      short: `${PREFIX}\n\nRead the description and acceptance criteria at the link above.`
    }

    assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: null, unsupported: null })
    const offered = await w.request('work.startRepos', { org: 'contoso', id: 1204 })
    const adoCalls = ado.calls.length
    assert.deepEqual(await w.request('work.startRepos', { org: 'contoso', id: 1204 }), offered)
    assert.equal(ado.calls.length, adoCalls, 'the cached details answer again without a request')
    assert.deepEqual(offered.repos, [{ key: WEB_KEY, name: 'web-app', detail: 'Fabrikam Web', source: 'pr' }])
    assert.deepEqual(await w.request('work.startWork', { org: 'contoso', id: 1204, repo: { kind: 'orca', key: WEB_KEY } }), {
      status: 'sent',
      branch: BRANCH,
      repo: 'web-app',
      agent: 'codex',
      workspace: { id: web.id, name: web.name },
      shortened: false,
      clone: null
    })
    assert.deepEqual(w.host.data().storage.workspaceRepos, { [`contoso/team:${BOARDS.teamId}`]: WEB_KEY })
    const createId = fileIdOf(terminalsOf(host)[0].command)
    assert.deepEqual(terminalsOf(host), [{ workspaceId: web.id, title: 'ADO #1204', command: createCommand({ fileId: createId, branch: BRANCH, agent: 'codex', prompts })?.command }])
    assert.deepEqual(await startFiles(starts), { [`${createId}.prompt`]: { text: prompts.full, mode: 0o600 } })
    assert.equal((await fs.stat(starts)).mode & 0o777, 0o700)

    await w.hooks.fire('workspace.create.after', { workspaceId: started.id, kind: 'worktree', path: started.path, branch: BRANCH })
    desk.workspaces = [web, started]
    await drain()
    assert.deepEqual(await startFiles(starts), {}, 'the prompt file goes once the workspace is ready')
    assert.deepEqual(w.posts.filter(post => post.event === 'work.workspaceReady').map(post => post.payload), [{ ...ITEM, workspaceId: started.id, branch: BRANCH }])
    assert.equal((w.host.data().storage.workspaceLinks as Record<string, { itemId: number }>)[started.id]?.itemId, 1204)
    assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: { id: started.id, name: started.name }, unsupported: null })

    const working = () => w.posts.filter(post => post.event === 'work.agentWorking').map(post => post.payload)
    const status = (terminalId: string) => ({ workspaceId: started.id, paneKey: `pane-${terminalId}`, terminalId, state: 'working', receivedAt: Date.now() }) as const
    const launch = { agent: 'codex', terminalId: 'term-created', prompt: prompts.full, inputKind: 'launch' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', launch), { kind: 'continue', event: launch }, 'the launch prompt already carries the context, and ties its terminal')
    await w.emit('agent.status.changed', status('term-busy'))
    assert.deepEqual(working(), [], 'another agent at work in the workspace is not ours')
    await w.emit('agent.status.changed', status('term-created'))
    assert.deepEqual(working(), [ITEM], 'the agent the create started is working')

    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), {
      status: 'sent',
      agent: 'codex',
      workspace: { id: started.id, name: started.name },
      shortened: false
    })
    const launchId = fileIdOf(terminalsOf(host)[1].command)
    assert.deepEqual(terminalsOf(host)[1], { workspaceId: started.id, title: 'ADO #1204', command: launchCommand({ fileId: launchId, workspaceId: started.id, agent: 'codex', prompts })?.command })
    assert.deepEqual(Object.keys(await startFiles(starts)).sort(), [`${launchId}.prompt`, `${launchId}.worktree`])
    await w.emit('agent.status.changed', status('term-launched'))
    assert.deepEqual(working(), [ITEM], 'not tied yet')
    await w.hooks.fire('agent.prompt.before', { ...launch, terminalId: 'term-launched' })
    await w.emit('agent.status.changed', status('term-launched'))
    await drain()
    assert.deepEqual(working(), [ITEM, ITEM], 'and the agent Start an agent launched')
    assert.equal(Object.keys(await startFiles(starts)).length, 2, "Start an agent's files stay until the two minutes are up")

    const later = { agent: 'codex', terminalId: 'term-other', prompt: 'Review it', inputKind: 'orchestration' } as const
    await w.emit('agent.status.changed', { workspaceId: started.id, paneKey: 'pane-3', terminalId: 'term-other', state: 'waiting', receivedAt: Date.now() })
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', later), { kind: 'continue', event: { ...later, prompt: `${PREFIX}\n\nReview it` } })

    assert.deepEqual(await w.request('work.openWorkspace', { workspaceId: started.id }), { opened: true })
    assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: started.id }])
    assert.equal(w.refusals.length, 0, 'the manifest grants every host call the flow makes')
    assert.deepEqual(w.logs, [])
  })
})

test('Start an agent never uses the focused workspace', async () => {
  await withDesk({}, async ({ w, host }) => {
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: NO_WORKSPACE, tone: 'warning' })
    assert.deepEqual(terminalsOf(host), [])
  })
})

test('the default agent is claude when none is set', async () => {
  await withDesk({}, async ({ w }) => {
    const sent = await w.request('work.startWork', { org: 'contoso', id: 1204 })
    assert.equal(sent.status === 'sent' && sent.agent, 'claude')
  })
})

test('a login shell other than bash or zsh turns the actions off', async () => {
  await withDesk({ shell: '/opt/homebrew/bin/fish' }, async ({ w, host }) => {
    assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: null, unsupported: FISH })
    assert.deepEqual(await w.request('work.startWork', { org: 'contoso', id: 1204 }), { status: 'refused', message: FISH, tone: 'warning' })
    assert.deepEqual(terminalsOf(host), [])
  })
})

test('a launch prompt built from a newer title than the cached one is not prefixed again', async () => {
  await withDesk({ settings: { agentContext: true } }, async run => {
    const { w, host, ado, started, starts } = run
    await startLinked(run)
    ado.change(1204, { fields: { 'System.Title': 'Add vehicle search filters [v2]' } })
    await w.request('work.details', { org: 'contoso', id: 1204, fresh: true })
    await w.request('work.startAgent', { org: 'contoso', id: 1204 })
    const reference = `[ADO User Story #1204: Add vehicle search filters \\[v2\\]](${ITEM_URL})`
    const prompts = { full: reference, short: `${reference}\n\nRead the description and acceptance criteria at the link above.` }
    const launchId = fileIdOf(terminalsOf(host)[1].command)
    assert.equal(terminalsOf(host)[1].command, launchCommand({ fileId: launchId, workspaceId: started.id, agent: 'claude', prompts })?.command)
    assert.equal((await startFiles(starts))[`${launchId}.prompt`]?.text, reference)

    await w.emit('agent.status.changed', { workspaceId: started.id, paneKey: 'pane-3', terminalId: 'term-hooked-first', state: 'working', receivedAt: Date.now() })
    const launch = { agent: 'claude', terminalId: 'term-hooked-first', prompt: reference, inputKind: 'launch' } as const
    assert.deepEqual(await w.hooks.fire('agent.prompt.before', launch), { kind: 'continue', event: launch })
  })
})

test('hooks answer without awaiting the network', async () => {
  await withDesk({ settings: { agentContext: true } }, async ({ w, host, ado, started, block, blockedCalls }) => {
    await w.request('work.snapshot', { org: 'contoso' })
    await w.request('work.startWork', { org: 'contoso', id: 1204 })
    await w.emit('agent.status.changed', { workspaceId: started.id, paneKey: 'pane-2', terminalId: 'term-1', state: 'working', receivedAt: Date.now() })
    const adoCalls = ado.calls.length
    const hostCalls = host.calls.length
    block()

    const create = { kind: 'worktree', projectId: 'repo-web', name: 'web-app-2', base: 'main' } as const
    assert.deepEqual(await w.hooks.fire('workspace.create.before', create), { kind: 'continue', event: create })
    await w.hooks.fire('workspace.create.after', { workspaceId: started.id, kind: 'worktree', path: started.path, branch: BRANCH })
    const launch = { agent: 'claude', workspaceId: started.id, workspaceKind: 'worktree', terminalId: 'term-2', command: 'claude', env: {} } as const
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
