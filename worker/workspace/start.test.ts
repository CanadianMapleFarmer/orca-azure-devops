import { assert, hostError, mountWorker, test } from 'orca/testing'
import type { StartRepo, WorkItemDetails, WorkItemSummary } from '../../src/shared/work'
import { fakeAdo, json, type AdoCall } from '../boards/fake-ado'
import { cachedCodeRepos, CODE_REPOS_KEY, type CodeRepos } from '../ado/code-projects'
import { createAdoHttp } from '../ado/http'
import type { PrRef } from '../ado/workitems'
import { createEntities } from '../data/entities'
import type { RepoRecord } from '../data/records'
import { CLONE_GONE, CLONE_NAME_UNSAFE, CLONE_RELOAD, CLONE_URL_UNSAFE, cloneFolderNotYours, cloneFolderTaken, cloneRootFailed, cloneRootUnsafe, REPOS_UNLISTED, stillCloning } from '../messages'
import { drain, memoryStore } from '../test-support'
import { itemPrompt, shortPrompt } from './agents'
import type { FolderDeps, RootDeps } from './clone'
import { cloneCommand, createCommand, launchCommand, MAX_PROMPT_BYTES } from './command'
import type { WorkspaceEntry } from './focused'
import { createLinkStore, LINKS_KEY } from './links'
import { createPendingLinks } from './pending'
import type { AdoRemote, OtherRemote } from './remotes'
import { createRepoChoices } from './repo-for-item'
import { registerStartHandlers, type StartDeps } from './start'
import { START_FILE_MS } from './start-files'

const T0 = Date.parse('2026-11-11T09:00:00Z')
const BRANCH = 'feature/1204-add-vehicle-search-filters'
const ITEM_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1204'
const ITEM = { org: 'contoso', itemId: 1204 }
const WEB: AdoRemote = { remote: 'origin', org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const API: AdoRemote = { ...WEB, repo: 'api' }
const TOOLS: AdoRemote = { ...WEB, project: 'Tools', repo: 'tools' }
const PORTAL: AdoRemote = { ...WEB, org: 'fabrikam', project: 'Platform', repo: 'portal' }
const NOTES: OtherRemote = { remote: 'origin', key: 'git:github.com/fabrikam/notes', name: 'notes', host: 'github.com' }
const WEB_KEY = 'contoso/fabrikam web/web-app'
const API_KEY = 'contoso/fabrikam web/api'
const TOOLS_KEY = 'contoso/tools/tools'
const WORK = { org: 'contoso', id: 1204, repo: { kind: 'orca', key: WEB_KEY } } as const
const BOARD = { teamId: 't1', boardId: 'b1' }
const TOOLS_PR: PrRef = { projectId: '5a2b3c4d-1111-4b3c-8d4e-1f2a3b4c5d6e', repoId: '9e0f1a2b-3333-4e6f-9a7b-4c5d6e7f8091', prId: 88 }
const TOOLS_RECORD: RepoRecord = { id: TOOLS_PR.repoId, name: 'tools', projectId: TOOLS_PR.projectId, projectName: 'Tools', ssh: true, disabled: false }
const HOME = '/home/ada'
const ROOT = '/home/ada/orca/repos'
const UID = 501
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WEB_RECORD: RepoRecord = { id: '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f', name: 'web-app', projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d', projectName: 'Fabrikam Web', ssh: true, disabled: false }
const API_RECORD: RepoRecord = { ...WEB_RECORD, id: '8d9e0f1a-4444-4d5e-8f6a-3b4c5d6e7f80', name: 'api' }
const CLONE_WEB = { kind: 'clone', projectId: WEB_RECORD.projectId, repoId: WEB_RECORD.id } as const
const FOLDER = `${ROOT}/web-app`
const SHOWN_FOLDER = '~/orca/repos/web-app'
const WEB_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'
const MINE = { uid: UID, mode: 0o40755, directory: true }
const SYSTEM = { uid: 0, mode: 0o40755, directory: true }
const PARENTS: Record<string, Folder> = { '/': SYSTEM, '/home': SYSTEM, [HOME]: MINE, [`${HOME}/orca`]: MINE, '/private': SYSTEM, '/private/tmp': { ...SYSTEM, mode: 0o41777 } }
const CLONE_HERE = { folder: '~/orca/repos' }
const REPO_GONE = "That repository isn't in Orca any more. Choose another."
const NO_TERMINAL_HOME = 'Cloning needs a workspace in Orca to run in. Open any folder in Orca, then try again.'
const NO_GIT = "Git wasn't found, so the plugin can't clone. Install Git, then try again."
const CLONE_FOLDER_SETTING = '"Folder for new clones" must be a full path, such as ~/orca/repos.'
const BAD_AGENT = 'Default agent must be an agent name such as claude or codex.'
const TERMINAL_REFUSED = "Orca didn't let the plugin open a terminal. Update the plugin and approve its access in Settings → Plugins."
const TOO_LONG = 'The command for this item is too long for Orca. Shorten the branch name template.'
const NO_WORKSPACE = 'This item has no workspace in Orca yet. Start a workspace and agent first.'
const PROMPT_NOT_SAVED = "Couldn't save the agent's prompt in ~/.orca-azure-devops/starts. Check that folder's permissions."
const fileId = (n: number) => `f${String(n).padStart(23, '0')}`
const AGENT_STARTING = 'An agent is already starting for this item.'
const STILL_CREATING = "This item's workspace is still being created. If Orca's terminal shows an error, try again in two minutes."
const FISH = 'Starting a workspace or an agent from an item works with the bash and zsh shells only for now. Yours is fish.'

function workspace(id: string, over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: `/repos/${id}`, branch: 'main', hostId: null, ...over }
}

const MAIN = workspace('web-main')
const SECOND = workspace('web-2')
const API_MAIN = workspace('api-main')
const TOOLS_MAIN = workspace('tools-main')

function detailsOf(over: Partial<WorkItemDetails> = {}): WorkItemDetails {
  const item = { org: 'contoso', id: 1204, type: 'User Story', title: 'Add vehicle search filters', url: ITEM_URL } as WorkItemSummary
  return { item, descriptionMd: 'Filter by make.', acceptanceMd: '', comments: [], links: [], assignee: null, tasks: [], moreTasks: 0, tasksRead: true, prs: [], taskTypes: [], taskType: null, readAt: 0, ...over }
}

interface Folder { uid: number; mode: number; directory: boolean; entries?: string[] }

interface Desk {
  listed: WorkspaceEntry[]
  focused: WorkspaceEntry | null
  remotes: Record<string, AdoRemote[]>
  others: Record<string, OtherRemote>
  details: WorkItemDetails
  detailsCached: boolean
  prRefs: PrRef[]
  repos: RepoRecord[]
  team: string | null
  cloneFolder: string
  hasGit: boolean
  folders: Record<string, Folder>
  links: Record<string, string>
  git: Record<string, { topLevel: string; head: boolean }>
  failMkdir: boolean
  reposAt: number | null
  served: { status: number; repos: RepoRecord[] }
  agent: string
  shell: string | undefined
  platform: string
  template: string
  terminal: () => unknown
  failWrite: boolean
  kept: number[]
  gate: Promise<unknown>
}

async function setup(over: Partial<Desk> = {}, stored: Record<string, unknown> = {}) {
  const desk: Desk = {
    listed: [MAIN, SECOND, TOOLS_MAIN],
    focused: MAIN,
    remotes: { [MAIN.path]: [WEB], [SECOND.path]: [WEB], [API_MAIN.path]: [API], [TOOLS_MAIN.path]: [TOOLS] },
    others: {},
    details: detailsOf(),
    detailsCached: true,
    prRefs: [],
    repos: [],
    team: null,
    cloneFolder: '~/orca/repos',
    hasGit: true,
    folders: {},
    links: {},
    git: {},
    failMkdir: false,
    reposAt: T0,
    served: { status: 200, repos: [] },
    agent: 'claude',
    shell: '/bin/zsh',
    platform: 'darwin',
    template: 'feature/{id}-{slug}',
    terminal: () => ({ terminalId: 'term-ado' }),
    failWrite: false,
    kept: [0],
    gate: Promise.resolve(),
    ...over
  }
  const calls: { method: string; params: unknown }[] = []
  const disarms: number[] = []
  const loads: string[] = []
  const requests: string[] = []
  const made: string[] = []
  const logs: string[] = []
  const { data, store } = memoryStore(stored)
  const links = await createLinkStore(store, () => T0)
  const clock = { now: T0 }
  const files = { ids: 0, written: {} as Record<string, string>, removed: [] as string[], sweeps: 0 }
  const timers: { ms: number; run: () => void }[] = []
  const pending = createPendingLinks(() => clock.now)
  const entities = createEntities(() => clock.now)
  if (desk.reposAt !== null) entities.of('contoso').codeRepos.put(CODE_REPOS_KEY, desk.repos, desk.reposAt)
  const ado = fakeAdo()
  ado.on(isRepositories, () => json(desk.served.status, { value: desk.served.repos.map(rawRepository) }))
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const repoLists = new Map<string, CodeRepos>()
  const missing = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  const folderAt = (path: string) => {
    const folder = desk.folders[path] ?? PARENTS[path]
    if (!folder) throw missing()
    return folder
  }
  const resolved = (path: string) => {
    const link = Object.keys(desk.links).find(from => path === from || path.startsWith(`${from}/`))
    return link === undefined ? path : `${desk.links[link]}${path.slice(link.length)}`
  }
  const fs = {
    mkdir: async (path: string) => {
      made.push(path)
      if (desk.failMkdir) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      desk.folders[resolved(path)] ??= MINE
    },
    realpath: async (path: string) => (folderAt(resolved(path)), resolved(path)),
    lstat: async (path: string) => {
      const { uid, mode, directory } = folderAt(path)
      return { uid, mode, isDirectory: () => directory }
    },
    readdir: async (path: string) => folderAt(path).entries ?? []
  }
  const deps: StartDeps = {
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'workspace.list') return { workspaces: desk.listed, truncated: false }
      if (method === 'workspace.readContext') return desk.focused && { branch: desk.focused.branch, displayName: desk.focused.name, terminals: [] }
      if (method === 'terminal.create') return desk.terminal()
      if (method === 'workspace.open') return { opened: true }
      throw new Error(`unexpected ${method}`)
    },
    remoteSets: async path => ({ ado: desk.remotes[path] ?? [], other: desk.others[path] ?? null }),
    log: message => logs.push(message),
    shell: { platform: desk.platform, shell: desk.shell },
    links,
    pending,
    choices: await createRepoChoices(store),
    item: async () => {
      loads.push('item')
      return desk.details.item
    },
    details: async () => {
      loads.push('details')
      await desk.gate
      if (!desk.detailsCached) {
        requests.push('details')
        desk.detailsCached = true
      }
      return desk.details
    },
    prRefs: () => (desk.detailsCached ? desk.prRefs : []),
    tables: org => entities.of(org),
    team: async () => desk.team,
    cloneFolder: () => desk.cloneFolder,
    home: HOME,
    hasGit: desk.hasGit,
    root: { fs: fs as unknown as RootDeps['fs'], uid: UID },
    codeRepos: org => {
      const known = repoLists.get(org) ?? cachedCodeRepos(http, org, entities.of(org).codeRepos, () => clock.now)
      repoLists.set(org, known)
      return known
    },
    folders: {
      fs: fs as unknown as FolderDeps['fs'],
      uid: UID,
      topLevel: async folder => desk.git[folder]?.topLevel ?? null,
      hasHead: async folder => desk.git[folder]?.head ?? false,
      remotes: async folder => desk.remotes[folder] ?? []
    },
    now: () => clock.now,
    defaultAgent: () => desk.agent,
    branchTemplate: () => desk.template,
    disarm: () => void disarms.push(calls.length),
    files: {
      id: () => fileId(++files.ids),
      write: async written => {
        if (desk.failWrite) throw new Error('EACCES: permission denied, open /Users/ada/.orca-azure-devops/starts/x')
        Object.assign(files.written, written)
      },
      remove: async names => {
        files.removed.push(...names)
        for (const name of names) delete files.written[name]
      },
      sweep: async () => {
        files.sweeps += 1
        return desk.kept.length > 1 ? (desk.kept.shift() ?? 0) : desk.kept[0]
      }
    },
    later: (ms, run) => void timers.push({ ms, run })
  }
  const w = await mountWorker({ default: orca => registerStartHandlers(orca, deps) }, { events: ['agent.status.changed'], hooks: ['agent.prompt.before'] })
  const terminals = () => calls.filter(call => call.method === 'terminal.create').map(call => call.params)
  return { w, desk, calls, disarms, loads, requests, made, logs, data, links, pending, terminals, files, timers, ado, advance: (ms: number) => void (clock.now += ms) }
}

const isRepositories = (call: AdoCall) => call.path.endsWith('/_apis/git/repositories')

function rawRepository(record: RepoRecord) {
  return {
    id: record.id,
    name: record.name,
    project: { id: record.projectId, name: record.projectName },
    sshUrl: record.ssh ? `git@ssh.dev.azure.com:v3/contoso/${record.projectName}/${record.name}` : null,
    isDisabled: record.disabled
  }
}

const PROMPTS = { full: itemPrompt(detailsOf()), short: shortPrompt(detailsOf()) }
const created = (agent = 'claude') => createCommand({ fileId: fileId(1), branch: BRANCH, agent, prompts: PROMPTS })?.command
const launched = (workspaceId: string) => launchCommand({ fileId: fileId(1), workspaceId, agent: 'claude', prompts: PROMPTS })?.command

test('an item without a workspace has none, and nothing is created by asking', async () => {
  const { w, calls } = await setup()
  assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: null, unsupported: null })
  assert.deepEqual(calls.map(call => call.method), ['workspace.list'])
})

test("the item's linked workspace is found without loading the item", async () => {
  const linked = workspace('web-1204', { branch: 'some/other-name' })
  const { w, links, loads } = await setup({ listed: [MAIN, linked] })
  await links.link(linked.id, ITEM)
  assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: { id: linked.id, name: linked.name }, unsupported: null })
  assert.deepEqual(loads, [])
})

test('a workspace made by hand on the branch, or on <branch>-N, is linked to the item', async () => {
  const handMade = workspace('web-1204-2', { branch: `${BRANCH}-2` })
  const { w, data } = await setup({ listed: [MAIN, handMade] })
  assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: { id: handMade.id, name: handMade.name }, unsupported: null })
  assert.deepEqual((data[LINKS_KEY] as Record<string, unknown>)[handMade.id], { ...ITEM, linkedAt: T0 })
})

test('the exact branch wins over a -N copy, and a removed linked workspace falls back to the branch', async () => {
  const copy = workspace('web-1204-2', { branch: `${BRANCH}-2` })
  const exact = workspace('web-1204', { branch: `refs/heads/${BRANCH}` })
  const { w, links } = await setup({ listed: [copy, exact] })
  await links.link('ws-removed', ITEM)
  assert.equal((await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 })).workspace?.id, exact.id)
  assert.equal(links.byItem('contoso', 1204), exact.id)
})

test('another item\'s branch, a folder, a remote workspace and a workspace linked to another item are never taken', async () => {
  const otherItem = workspace('web-1205', { branch: 'feature/1205-add-vehicle-search-filters' })
  const prefixed = workspace('web-ada', { branch: `users/ada/${BRANCH}` })
  const folder = workspace('notes', { kind: 'folder', branch: BRANCH })
  const remote = workspace('build-box', { branch: BRANCH, hostId: 'ssh:build-box' })
  const taken = workspace('web-taken', { branch: BRANCH })
  const { w, links } = await setup({ listed: [otherItem, prefixed, folder, remote, taken], focused: otherItem })
  await links.link(taken.id, { org: 'contoso', itemId: 999 })
  assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: null, unsupported: null })
  assert.equal(links.byItem('contoso', 1204), null)
})

test('the item says when the platform or shell is not supported', async () => {
  const { w } = await setup({ shell: '/opt/homebrew/bin/fish' })
  assert.deepEqual(await w.request('work.itemWorkspace', { org: 'contoso', id: 1204 }), { workspace: null, unsupported: FISH })
})

test('Start a workspace and agent runs the create command in the focused workspace of the repository', async () => {
  const { w, terminals, pending } = await setup()
  const result = await w.request('work.startWork', WORK)
  assert.deepEqual(result, { status: 'sent', branch: BRANCH, repo: 'web-app', agent: 'claude', workspace: { id: MAIN.id, name: MAIN.name }, shortened: false, clone: null })
  assert.deepEqual(terminals(), [{ workspaceId: MAIN.id, title: 'ADO #1204', command: created() }])
  assert.deepEqual(pending.claim(`${BRANCH}-2`), ITEM, 'the workspace the command creates is linked when it appears')
})

test('a Check out in Orca arm is cancelled once the create command is in its terminal, and only then', async () => {
  const { w, calls, disarms } = await setup()
  await w.request('work.startWork', WORK)
  assert.deepEqual(disarms, [calls.findIndex(call => call.method === 'terminal.create') + 1])

  const blocked = await setup({ terminal: () => { throw hostError('capability_denied', 'no') } })
  await blocked.w.request('work.startWork', WORK)
  const refused = await setup({ listed: [] })
  await refused.w.request('work.startWork', WORK)
  const asked = await setup({ listed: [MAIN, API_MAIN] })
  await asked.w.request('work.startWork', { org: 'contoso', id: 1204 })
  const linked = await setup({ listed: [workspace('web-1204', { branch: BRANCH })] })
  await linked.w.request('work.startWork', WORK)
  const agent = await setup({ listed: [workspace('web-1204', { branch: BRANCH })] })
  await agent.w.request('work.startAgent', { org: 'contoso', id: 1204 })
  assert.deepEqual([blocked, refused, asked, linked, agent].map(each => each.disarms), [[], [], [], [], []], 'nothing else touches the arm')
})

test('a second start while Orca still creates the workspace is refused, until the workspace appears or two minutes pass', async () => {
  const { w, terminals, pending, advance } = await setup()
  assert.equal((await w.request('work.startWork', WORK)).status, 'sent')
  assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: STILL_CREATING, tone: 'warning' })
  assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: STILL_CREATING, tone: 'warning' })
  assert.equal(terminals().length, 1)

  assert.equal((await w.request('work.startWork', { ...WORK, id: 1205 })).status, 'sent', 'another item is not held up')
  assert.deepEqual(pending.claim(BRANCH), ITEM)
  assert.equal((await w.request('work.startWork', WORK)).status, 'sent', 'the workspace appeared')

  advance(2 * 60_000 + 1)
  assert.equal((await w.request('work.startWork', WORK)).status, 'sent', 'the first attempt ran out')
})

function gated() {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  return { gate, open }
}

test('a start still on its way refuses a second one, so two requests at once open one terminal', async () => {
  const { gate, open } = gated()
  const { w, terminals } = await setup({ gate })
  const first = w.request('work.startWork', WORK)
  try {
    await drain()
    assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: STILL_CREATING, tone: 'warning' })
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: STILL_CREATING, tone: 'warning' })
  } finally {
    open()
  }
  assert.equal((await first).status, 'sent')
  assert.equal(terminals().length, 1)
})

test('an agent still starting refuses another start for the item', async () => {
  const { gate, open } = gated()
  const linked = workspace('web-1204', { branch: BRANCH })
  const { w, terminals, links } = await setup({ gate, listed: [MAIN, linked] })
  await links.link(linked.id, ITEM)
  const first = w.request('work.startAgent', { org: 'contoso', id: 1204 })
  try {
    await drain()
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: AGENT_STARTING, tone: 'warning' })
    assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: AGENT_STARTING, tone: 'warning' })
  } finally {
    open()
  }
  assert.equal((await first).status, 'sent')
  assert.equal(terminals().length, 1)
  assert.equal((await w.request('work.startAgent', { org: 'contoso', id: 1204 })).status, 'sent', 'once it has started, another agent is a choice')
})

test('every way a start ends clears its mark: a failure, a refusal or a question', async () => {
  const { w, desk } = await setup()
  desk.gate = Promise.reject(new Error('Azure DevOps is unreachable.'))
  desk.gate.catch(() => {})
  await assert.rejects(w.request('work.startWork', WORK), /unreachable/)
  desk.gate = Promise.resolve()
  assert.equal((await w.request('work.startWork', { org: 'contoso', id: 1204 })).status, 'choose-repo')
  desk.failWrite = true
  assert.equal((await w.request('work.startWork', WORK)).status, 'refused')
  desk.failWrite = false
  assert.equal((await w.request('work.startWork', WORK)).status, 'sent')
})

test('the default agent and the branch template come from the settings at the moment of the press', async () => {
  const { w, desk, terminals } = await setup()
  desk.agent = 'codex'
  await w.request('work.startWork', WORK)
  assert.equal((terminals()[0] as { command: string }).command, created('codex'))
})

test('outside the repository, the command runs in its first workspace by name', async () => {
  const { w, terminals } = await setup({ focused: TOOLS_MAIN, listed: [SECOND, MAIN, TOOLS_MAIN] })
  await w.request('work.startWork', WORK)
  assert.equal((terminals()[0] as { workspaceId: string }).workspaceId, SECOND.id)
})

const row = (key: string, name: string, detail: string, source: StartRepo['source']): StartRepo => ({ key, name, detail, source })

test("startRepos ranks linked pull requests, the team's last choice, this organisation, then other repos, and selects the first of the first two", async () => {
  const notes = workspace('notes-main')
  const portal = workspace('portal-main')
  const scratch = workspace('scratch', { kind: 'folder' })
  const { w, terminals } = await setup(
    {
      listed: [MAIN, SECOND, API_MAIN, TOOLS_MAIN, notes, portal, scratch],
      remotes: { [MAIN.path]: [WEB], [SECOND.path]: [WEB], [API_MAIN.path]: [API], [TOOLS_MAIN.path]: [TOOLS], [portal.path]: [PORTAL] },
      others: { [notes.path]: NOTES },
      prRefs: [TOOLS_PR],
      repos: [TOOLS_RECORD]
    },
    { workspaceRepos: { 'contoso/team:t1': API_KEY } }
  )
  assert.deepEqual(await w.request('work.startRepos', { org: 'contoso', id: 1204, board: BOARD }), {
    repos: [
      row(TOOLS_KEY, 'tools', 'Tools', 'pr'),
      row(API_KEY, 'api', 'Fabrikam Web', 'last'),
      row(WEB_KEY, 'web-app', 'Fabrikam Web', 'org'),
      row(NOTES.key, 'notes', 'github.com', 'other'),
      row('fabrikam/platform/portal', 'portal', 'fabrikam/Platform', 'other')
    ],
    selected: TOOLS_KEY,
    clone: CLONE_HERE
  })
  assert.deepEqual(terminals(), [])

  const remembered = await setup({ listed: [MAIN, API_MAIN, TOOLS_MAIN] }, { workspaceRepos: { 'contoso/team:t1': API_KEY } })
  assert.equal((await remembered.w.request('work.startRepos', { org: 'contoso', id: 1204, board: BOARD })).selected, API_KEY)
  const unknown = await setup({ listed: [MAIN, API_MAIN, TOOLS_MAIN] })
  assert.equal((await unknown.w.request('work.startRepos', { org: 'contoso', id: 1204, board: BOARD })).selected, null)
})

test('an item in a project with no repositories can start in any Orca repo', async () => {
  const item = { ...detailsOf().item, url: 'https://dev.azure.com/contoso/Planning/_workitems/edit/1204' }
  const { w, terminals, data } = await setup({ details: detailsOf({ item }), listed: [MAIN, TOOLS_MAIN], focused: null })
  const offered = await w.request('work.startRepos', { org: 'contoso', id: 1204 })
  assert.deepEqual(offered.repos, [row(TOOLS_KEY, 'tools', 'Tools', 'org'), row(WEB_KEY, 'web-app', 'Fabrikam Web', 'org')])
  assert.equal(offered.selected, null)

  const sent = await w.request('work.startWork', { org: 'contoso', id: 1204, repo: { kind: 'orca', key: TOOLS_KEY } })
  assert.equal(sent.status === 'sent' && sent.repo, 'tools')
  assert.deepEqual(terminals().map(each => (each as { workspaceId: string }).workspaceId), [TOOLS_MAIN.id])
  assert.deepEqual(data.workspaceRepos, { 'contoso/planning': TOOLS_KEY })
})

test('startRepos makes no Azure DevOps request when the details are cached, and reads them only through boards.details when not', async () => {
  const { w, desk, loads, requests, calls } = await setup({ listed: [MAIN, TOOLS_MAIN], prRefs: [TOOLS_PR], repos: [TOOLS_RECORD] })
  const cached = await w.request('work.startRepos', { org: 'contoso', id: 1204 })
  assert.equal(cached.selected, TOOLS_KEY)
  assert.deepEqual(requests, [])

  desk.detailsCached = false
  assert.deepEqual(await w.request('work.startRepos', { org: 'contoso', id: 1204 }), cached, 'evicted details are read again, and the pull request still ranks')
  assert.deepEqual(requests, ['details'])
  assert.deepEqual(loads, ['details', 'details'])
  assert.deepEqual([...new Set(calls.map(call => call.method))], ['workspace.list'])
})

test("Start with a pick runs in that repo's workspace, focused first, and remembers it for the board's team", async () => {
  const { w, terminals, data } = await setup({ listed: [MAIN, SECOND, API_MAIN, TOOLS_MAIN], focused: SECOND, team: 't9' })
  assert.deepEqual(await w.request('work.startWork', { ...WORK, board: BOARD }), {
    status: 'sent',
    branch: BRANCH,
    repo: 'web-app',
    agent: 'claude',
    workspace: { id: SECOND.id, name: SECOND.name },
    shortened: false,
    clone: null
  })
  assert.deepEqual(terminals(), [{ workspaceId: SECOND.id, title: 'ADO #1204', command: created() }])
  assert.deepEqual(data.workspaceRepos, { 'contoso/team:t1': WEB_KEY })

  const elsewhere = await setup({ listed: [MAIN, SECOND, API_MAIN, TOOLS_MAIN], focused: TOOLS_MAIN })
  const sent = await elsewhere.w.request('work.startWork', { org: 'contoso', id: 1204, board: BOARD, repo: { kind: 'orca', key: API_KEY } })
  assert.equal(sent.status === 'sent' && sent.repo, 'api')
  assert.deepEqual(elsewhere.terminals().map(each => (each as { workspaceId: string }).workspaceId), [API_MAIN.id])
  assert.deepEqual(elsewhere.data.workspaceRepos, { 'contoso/team:t1': API_KEY })
  elsewhere.pending.claim(BRANCH)
  assert.equal((await elsewhere.w.request('work.startRepos', { org: 'contoso', id: 1204, board: BOARD })).selected, API_KEY, 'offered first next time')
})

test("the sidebar's start remembers for the organisation's board team, and an item with no team for its project", async () => {
  const teamed = await setup({ team: 't9' })
  await teamed.w.request('work.startWork', WORK)
  assert.deepEqual(teamed.data.workspaceRepos, { 'contoso/team:t9': WEB_KEY })
  teamed.pending.claim(BRANCH)
  assert.equal((await teamed.w.request('work.startRepos', { org: 'contoso', id: 1204 })).selected, WEB_KEY)

  const alone = await setup({ team: null })
  await alone.w.request('work.startWork', WORK)
  assert.deepEqual(alone.data.workspaceRepos, { 'contoso/fabrikam web': WEB_KEY })
})

test('Start without a pick uses the selected repo, and with none answers choose-repo with the list', async () => {
  const remembered = await setup({ listed: [MAIN, API_MAIN] }, { workspaceRepos: { 'contoso/fabrikam web': API_KEY } })
  const sent = await remembered.w.request('work.startWork', { org: 'contoso', id: 1204 })
  assert.equal(sent.status === 'sent' && sent.repo, 'api')
  assert.deepEqual(remembered.terminals().map(each => (each as { workspaceId: string }).workspaceId), [API_MAIN.id])

  const { w, terminals, data } = await setup({ listed: [MAIN, API_MAIN] })
  assert.deepEqual(await w.request('work.startWork', { org: 'contoso', id: 1204 }), {
    status: 'choose-repo',
    repos: { repos: [row(API_KEY, 'api', 'Fabrikam Web', 'org'), row(WEB_KEY, 'web-app', 'Fabrikam Web', 'org')], selected: null, clone: CLONE_HERE },
    message: null
  })
  assert.deepEqual(terminals(), [])
  assert.equal(data.workspaceRepos, undefined)

  for (const listed of [[], [workspace('web-remote', { hostId: 'ssh:box' })]]) {
    const empty = await setup({ listed, focused: null, remotes: { '/repos/web-remote': [WEB] } })
    assert.deepEqual(await empty.w.request('work.startWork', { org: 'contoso', id: 1204 }), {
      status: 'choose-repo',
      repos: { repos: [], selected: null, clone: { problem: NO_TERMINAL_HOME } },
      message: null
    })
    assert.deepEqual(empty.terminals(), [])
  }
})

test('a pick that is no longer in Orca answers choose-repo with REPO_GONE', async () => {
  const { w, terminals, data } = await setup({ listed: [MAIN, API_MAIN] })
  const fresh = { repos: [row(API_KEY, 'api', 'Fabrikam Web', 'org'), row(WEB_KEY, 'web-app', 'Fabrikam Web', 'org')], selected: null, clone: CLONE_HERE }
  assert.deepEqual(await w.request('work.startWork', { org: 'contoso', id: 1204, repo: { kind: 'orca', key: TOOLS_KEY } }), { status: 'choose-repo', repos: fresh, message: REPO_GONE })
  assert.deepEqual(
    await w.request('work.startWork', { org: 'contoso', id: 1204, repo: { kind: 'clone', projectId: TOOLS_PR.projectId, repoId: TOOLS_PR.repoId } }),
    { status: 'choose-repo', repos: fresh, message: CLONE_GONE },
    'a clone pick the list no longer has'
  )
  assert.deepEqual(terminals(), [])
  assert.equal(data.workspaceRepos, undefined)
})

test("startRepos says why Clone can't be used: no git, no local workspace, a bad or unsafe folder", async () => {
  const cloneOf = async (over: Partial<Desk>) => {
    const { w, made } = await setup(over)
    const { clone } = await w.request('work.startRepos', { org: 'contoso', id: 1204 })
    assert.deepEqual(made, [], 'nothing is created')
    return clone
  }
  const mine = { uid: UID, mode: 0o40755, directory: true }
  assert.deepEqual(await cloneOf({}), CLONE_HERE)
  assert.deepEqual(await cloneOf({ folders: { [ROOT]: mine } }), CLONE_HERE)
  assert.deepEqual(await cloneOf({ cloneFolder: '/srv/repos' }), { folder: '/srv/repos' })
  assert.deepEqual(await cloneOf({ listed: [workspace('notes', { kind: 'folder' })] }), CLONE_HERE, 'a folder can hold the terminal')
  assert.deepEqual(await cloneOf({ hasGit: false, listed: [], cloneFolder: 'repos' }), { problem: NO_GIT })
  assert.deepEqual(await cloneOf({ listed: [workspace('build-box', { hostId: 'ssh:build-box' })], cloneFolder: 'repos' }), { problem: NO_TERMINAL_HOME })
  for (const cloneFolder of ['repos', './repos', '/srv/re\npos']) assert.deepEqual(await cloneOf({ cloneFolder }), { problem: CLONE_FOLDER_SETTING })
  assert.deepEqual(await cloneOf({ folders: { [ROOT]: { ...mine, mode: 0o40777 } } }), { problem: cloneRootUnsafe(ROOT) })
  assert.deepEqual(await cloneOf({ folders: { [ROOT]: { ...mine, uid: UID + 1 } } }), { problem: cloneRootUnsafe(ROOT) })
  assert.deepEqual(await cloneOf({ folders: { [ROOT]: mine, [`${HOME}/orca`]: { ...mine, mode: 0o40777 } } }), { problem: cloneRootUnsafe(ROOT) })
  assert.deepEqual(await cloneOf({ folders: { [ROOT]: { ...mine, mode: 0o100644, directory: false } } }), { problem: cloneRootFailed(ROOT) })
})

test('a workspace already on the branch is linked instead of creating another', async () => {
  const onBranch = workspace('web-1204', { branch: BRANCH })
  const { w, terminals, links } = await setup({ listed: [MAIN, onBranch] })
  assert.deepEqual(await w.request('work.startWork', WORK), {
    status: 'linked',
    branch: BRANCH,
    workspace: { id: onBranch.id, name: onBranch.name }
  })
  assert.equal(links.byItem('contoso', 1204), onBranch.id)
  assert.deepEqual(terminals(), [])
})

test('a default agent that is not an agent name is refused before anything runs', async () => {
  for (const agent of ['claude; rm -rf ~', '$(id)', 'claude code', '', '--json']) {
    const { w, calls, loads } = await setup({ agent })
    assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: BAD_AGENT, tone: 'danger' })
    assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: BAD_AGENT, tone: 'danger' })
    assert.deepEqual(calls, [])
    assert.deepEqual(loads, [])
  }
})

test('an unsupported platform or shell is refused before anything runs', async () => {
  for (const over of [{ shell: '/usr/bin/fish' }, { platform: 'win32' }]) {
    const { w, calls } = await setup(over)
    const work = await w.request('work.startWork', WORK)
    const agent = await w.request('work.startAgent', { org: 'contoso', id: 1204 })
    assert.equal(work.status === 'refused' && work.tone, 'warning')
    assert.deepEqual(agent, work)
    assert.deepEqual(calls, [])
  }
})

test('a description too long for the agent is replaced by the short prompt, and the answer says so', async () => {
  const details = detailsOf({ descriptionMd: 'x'.repeat(MAX_PROMPT_BYTES) })
  const { w, terminals, files } = await setup({ details })
  const result = await w.request('work.startWork', WORK)
  assert.equal(result.status === 'sent' && result.shortened, true)
  assert.deepEqual(files.written, { [`${fileId(1)}.prompt`]: shortPrompt(details) })
  assert.equal((terminals()[0] as { command: string }).command, created())
})

test("the prompt goes to a start file the command reads, and the file goes once the item's workspace is ready", async () => {
  const { w, files, pending } = await setup()
  await w.request('work.startWork', WORK)
  assert.deepEqual(files.written, { [`${fileId(1)}.prompt`]: PROMPTS.full })
  pending.claim(BRANCH)
  assert.deepEqual(files.removed, [`${fileId(1)}.prompt`])
})

test('start files go after two minutes, whatever happens to the attempt', async () => {
  const { w, files, timers } = await setup()
  await w.request('work.startWork', WORK)
  assert.deepEqual(timers.map(timer => timer.ms), [START_FILE_MS])
  timers[0].run()
  timers[0].run()
  assert.deepEqual(files.removed, [`${fileId(1)}.prompt`], 'once')
  assert.deepEqual(files.written, {})
})

test('a refused or failed terminal removes the start files, and the item can start again at once', async () => {
  let refuse = true
  const { w, files, pending } = await setup({ terminal: () => { if (refuse) throw hostError('capability_denied', 'no'); return { terminalId: 't' } } })
  assert.equal((await w.request('work.startWork', WORK)).status, 'refused')
  assert.deepEqual(files.removed, [`${fileId(1)}.prompt`])
  assert.equal(pending.expecting(ITEM), false)
  refuse = false
  assert.equal((await w.request('work.startWork', WORK)).status, 'sent')

  const failing = await setup({ terminal: () => { throw hostError('unavailable', 'Orca is busy.') } })
  await assert.rejects(failing.w.request('work.startWork', WORK), /Orca is busy\./)
  assert.deepEqual(failing.files.removed, [`${fileId(1)}.prompt`])
  assert.equal(failing.pending.expecting(ITEM), false)
})

test("a prompt that can't be saved is refused before anything runs", async () => {
  for (const request of ['work.startWork', 'work.startAgent'] as const) {
    const { w, terminals, pending } = await setup({ failWrite: true, listed: [MAIN, workspace('web-1204', { branch: request === 'work.startAgent' ? BRANCH : 'main' })] })
    const result = request === 'work.startWork' ? await w.request(request, WORK) : await w.request(request, { org: 'contoso', id: 1204 })
    assert.deepEqual(result, { status: 'refused', message: PROMPT_NOT_SAVED, tone: 'danger' })
    assert.deepEqual(terminals(), [])
    assert.equal(pending.expecting(ITEM), false)
  }
})

test("Start an agent's files stay while agents work, and go when its terminal is refused or after two minutes", async () => {
  const linked = workspace('web-1204', { branch: BRANCH })
  const { w, files, timers } = await setup({ listed: [MAIN, linked] })
  await w.request('work.startAgent', { org: 'contoso', id: 1204 })
  assert.deepEqual(files.written, { [`${fileId(1)}.worktree`]: `id:${linked.id}`, [`${fileId(1)}.prompt`]: PROMPTS.full })
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-agent'))
  for (const terminalId of ['term-busy', 'term-agent']) await w.emit('agent.status.changed', status(linked.id, terminalId, 'working'))
  assert.deepEqual(Object.keys(files.written).length, 2, 'no status deletes the files')
  timers.find(timer => timer.ms === START_FILE_MS)?.run()
  assert.deepEqual(files.written, {})

  const refused = await setup({ listed: [MAIN, linked], terminal: () => { throw hostError('not_permitted', 'no') } })
  await refused.w.request('work.startAgent', { org: 'contoso', id: 1204 })
  assert.deepEqual(refused.files.written, {})
})

test('stale start files are swept when the handlers start, and again after two minutes while any remain', async () => {
  const { files, timers } = await setup({ kept: [2, 1, 0] })
  await drain()
  assert.equal(files.sweeps, 1)
  assert.deepEqual(timers.map(timer => timer.ms), [START_FILE_MS])
  timers.shift()?.run()
  await drain()
  assert.equal(files.sweeps, 2)
  assert.deepEqual(timers.map(timer => timer.ms), [START_FILE_MS], 'one remains, so another sweep waits')
  timers.shift()?.run()
  await drain()
  assert.equal(files.sweeps, 3)
  assert.deepEqual(timers, [], 'none remain, so nothing waits')
})

test('every start sweeps too, with at most one sweep waiting', async () => {
  const { w, files, timers } = await setup({ kept: [1] })
  await drain()
  await w.request('work.startWork', WORK)
  await drain()
  assert.equal(files.sweeps, 2)
  assert.deepEqual(timers.map(timer => timer.ms), [START_FILE_MS, START_FILE_MS], 'the sweep and the attempt each wait once')
})

test('a command too long even with the short prompt is refused', async () => {
  const { w, terminals } = await setup({ template: `feature/{id}-${'b'.repeat(2100)}` })
  assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: TOO_LONG, tone: 'danger' })
  assert.deepEqual(terminals(), [])
})

test('a terminal Orca refuses is reported, and other failures reach the panel', async () => {
  for (const code of ['capability_denied', 'not_permitted', 'consent_required'] as const) {
    const { w } = await setup({ terminal: () => { throw hostError(code, 'no') } })
    assert.deepEqual(await w.request('work.startWork', WORK), { status: 'refused', message: TERMINAL_REFUSED, tone: 'danger' })
  }
  const { w } = await setup({ terminal: () => { throw hostError('unavailable', 'Orca is busy.') } })
  await assert.rejects(w.request('work.startWork', WORK), /Orca is busy\./)
})

test("Start an agent runs the launch command in the item's workspace, even when another is focused", async () => {
  const linked = workspace('web-1204', { branch: BRANCH })
  const { w, links, terminals } = await setup({ listed: [MAIN, linked], focused: MAIN })
  await links.link(linked.id, ITEM)
  assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), {
    status: 'sent',
    agent: 'claude',
    workspace: { id: linked.id, name: linked.name },
    shortened: false
  })
  assert.deepEqual(terminals(), [{ workspaceId: linked.id, title: 'ADO #1204', command: launched(linked.id) }])
})

test('Start an agent never falls back to the focused workspace', async () => {
  const { w, calls, terminals } = await setup({ listed: [MAIN, workspace('web-1205', { branch: 'feature/1205-x' })] })
  assert.deepEqual(await w.request('work.startAgent', { org: 'contoso', id: 1204 }), { status: 'refused', message: NO_WORKSPACE, tone: 'warning' })
  assert.deepEqual(terminals(), [])
  assert.ok(!calls.some(call => call.method === 'workspace.readContext'))
})

test('Start an agent links a workspace made by hand on the branch, then runs there', async () => {
  const handMade = workspace('web-1204', { branch: BRANCH })
  const { w, links, terminals } = await setup({ listed: [MAIN, handMade] })
  const result = await w.request('work.startAgent', { org: 'contoso', id: 1204 })
  assert.equal(result.status === 'sent' && result.workspace.id, handMade.id)
  assert.equal(links.byItem('contoso', 1204), handMade.id)
  assert.equal((terminals()[0] as { workspaceId: string }).workspaceId, handMade.id)
})

const status = (workspaceId: string | null, terminalId: string | undefined, state: 'working' | 'waiting') =>
  ({ workspaceId, paneKey: 'pane-1', ...(terminalId ? { terminalId } : {}), state, receivedAt: T0 }) as const

const launchPrompt = (terminalId: string, prompt = PROMPTS.full, inputKind: 'launch' | 'orchestration' = 'launch') =>
  ({ agent: 'claude', terminalId, prompt, inputKind }) as const

test("the panel hears once when the agent started for the item works, tied by its launch prompt", async () => {
  const linked = workspace('web-1204', { branch: BRANCH })
  const { w, links } = await setup({ listed: [MAIN, linked] })
  await links.link(linked.id, ITEM)
  await w.request('work.startAgent', { org: 'contoso', id: 1204 })
  assert.deepEqual(await w.hooks.fire('agent.prompt.before', launchPrompt('term-agent')), { kind: 'continue', event: launchPrompt('term-agent') }, 'the prompt passes unchanged')
  await w.emit('agent.status.changed', status(linked.id, 'term-busy', 'working'))
  await w.emit('agent.status.changed', status(linked.id, undefined, 'working'))
  await w.emit('agent.status.changed', status(linked.id, 'term-agent', 'waiting'))
  assert.deepEqual(w.posts, [], "another agent's work, or a status with no terminal, never counts")
  await w.emit('agent.status.changed', status(linked.id, 'term-agent', 'working'))
  await w.emit('agent.status.changed', status(linked.id, 'term-agent', 'working'))
  assert.deepEqual(w.posts, [{ event: 'work.agentWorking', payload: ITEM }])
})

test('the agent a create starts is tied the same way', async () => {
  const { w } = await setup()
  await w.request('work.startWork', WORK)
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-created'))
  await w.emit('agent.status.changed', status('ws-new', 'term-created', 'working'))
  assert.deepEqual(w.posts, [{ event: 'work.agentWorking', payload: ITEM }])
})

test('a prompt that is not a launch, names another item, or comes before any start ties nothing', async () => {
  const { w } = await setup()
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-early'))
  await w.request('work.startWork', WORK)
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-dispatch', PROMPTS.full, 'orchestration'))
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-other', '[ADO Bug #1205: Other](https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1205)'))
  await w.hooks.fire('agent.prompt.before', launchPrompt('term-mention', `Read this\n${PROMPTS.full}`))
  for (const terminalId of ['term-early', 'term-dispatch', 'term-other', 'term-mention']) await w.emit('agent.status.changed', status('ws-new', terminalId, 'working'))
  assert.deepEqual(w.posts, [])
})

test('Open workspace shows the workspace in Orca', async () => {
  const { w, calls } = await setup()
  assert.deepEqual(await w.request('work.openWorkspace', { workspaceId: 'web-1204' }), { opened: true })
  assert.deepEqual(calls, [{ method: 'workspace.open', params: { workspaceId: 'web-1204' } }])
})

const CLONING: Partial<Desk> = { listed: [TOOLS_MAIN], focused: TOOLS_MAIN, repos: [WEB_RECORD, TOOLS_RECORD] }
const START_CLONE = { org: 'contoso', id: 1204, repo: CLONE_WEB }
const cloned = (url: string | null, folder = FOLDER) => cloneCommand({ fileId: fileId(1), url, folder, branch: BRANCH, agent: 'claude', prompts: PROMPTS })
const commandOf = (terminal: unknown) => (terminal as { command: string }).command
const refused = (message: string, tone: 'warning' | 'danger') => ({ status: 'refused', message, tone })

test('cloneTargets answers from the cached list, reads once when it is over an hour old, groups by project and leaves out disabled repositories', async () => {
  const archive: RepoRecord = { ...API_RECORD, id: '9e0f1a2b-5555-4e6f-9a7b-4c5d6e7f8091', name: 'archive', disabled: true }
  const { w, desk, ado, advance } = await setup({ repos: [WEB_RECORD, TOOLS_RECORD, archive, API_RECORD] })
  assert.deepEqual(await w.request('work.cloneTargets', { org: 'contoso' }), {
    projects: [
      { id: WEB_RECORD.projectId, name: 'Fabrikam Web', repos: [{ id: API_RECORD.id, name: 'api' }, { id: WEB_RECORD.id, name: 'web-app' }] },
      { id: TOOLS_RECORD.projectId, name: 'Tools', repos: [{ id: TOOLS_RECORD.id, name: 'tools' }] }
    ],
    readAt: T0,
    more: 0
  })
  assert.equal(ado.count(isRepositories), 0)

  advance(HOUR + 1)
  desk.served = { status: 200, repos: [TOOLS_RECORD, { ...WEB_RECORD, disabled: true }] }
  const fresh = { projects: [{ id: TOOLS_RECORD.projectId, name: 'Tools', repos: [{ id: TOOLS_RECORD.id, name: 'tools' }] }], readAt: T0 + HOUR + 1, more: 0 }
  assert.deepEqual(await w.request('work.cloneTargets', { org: 'contoso' }), fresh)
  assert.deepEqual(await w.request('work.cloneTargets', { org: 'contoso' }), fresh)
  assert.equal(ado.count(isRepositories), 1)
})

test('cloneTargets lists at most 5,000 repositories and counts the rest', async () => {
  const numbered = (n: number): RepoRecord => ({ ...WEB_RECORD, id: `repo-${String(n).padStart(4, '0')}`, name: `web-${String(n).padStart(4, '0')}` })
  const repos = Array.from({ length: 5_003 }, (_, n) => numbered(5_002 - n))
  const { w } = await setup({ repos: [...repos, { ...API_RECORD, disabled: true }] })
  const { projects, more } = await w.request('work.cloneTargets', { org: 'contoso' })
  assert.equal(projects.length, 1)
  assert.equal(projects[0].repos.length, 5_000)
  assert.deepEqual([projects[0].repos[0].name, projects[0].repos[4_999].name], ['web-0000', 'web-4999'])
  assert.equal(more, 3)
})

test('a 404 from the repository list says REPOS_UNLISTED, and a second Clone within 10 minutes makes no request', async () => {
  for (const status of [404, 400]) {
    const { w, ado, advance } = await setup({ reposAt: null, served: { status, repos: [] } })
    const unlisted = (error: unknown) => (error as Error).message === REPOS_UNLISTED
    await assert.rejects(w.request('work.cloneTargets', { org: 'contoso' }), unlisted)
    advance(10 * MINUTE - 1)
    await assert.rejects(w.request('work.cloneTargets', { org: 'contoso' }), unlisted)
    assert.equal(ado.count(isRepositories), 1, String(status))
    advance(2)
    await assert.rejects(w.request('work.cloneTargets', { org: 'contoso' }), unlisted)
    assert.equal(ado.count(isRepositories), 2, String(status))
  }
})

test('a clone pick never makes a request, even with a list older than an hour', async () => {
  const { w, ado, advance } = await setup(CLONING)
  advance(2 * HOUR)
  assert.equal((await w.request('work.startWork', START_CLONE)).status, 'sent')
  assert.equal(ado.calls.length, 0)
})

test('a clone pick writes url, folder, repo and prompt files and runs the clone line in the focused local workspace', async () => {
  const { w, terminals, files, data, made, pending, advance } = await setup({ ...CLONING, listed: [TOOLS_MAIN, workspace('notes', { kind: 'folder' })] })
  assert.deepEqual(await w.request('work.startWork', START_CLONE), {
    status: 'sent',
    branch: BRANCH,
    repo: 'web-app',
    agent: 'claude',
    workspace: { id: TOOLS_MAIN.id, name: TOOLS_MAIN.name },
    shortened: false,
    clone: { folder: SHOWN_FOLDER, fresh: true, setupSkipped: true }
  })
  const command = cloned(WEB_URL)?.command ?? ''
  assert.deepEqual(terminals(), [{ workspaceId: TOOLS_MAIN.id, title: 'ADO #1204', command }])
  assert.match(command, /GIT_ALLOW_PROTOCOL=https:ssh command git clone -- /)
  assert.match(command, / --setup skip /)
  assert.deepEqual(files.written, {
    [`${fileId(1)}.url`]: WEB_URL,
    [`${fileId(1)}.folder`]: FOLDER,
    [`${fileId(1)}.repo`]: `path:${FOLDER}`,
    [`${fileId(1)}.prompt`]: PROMPTS.full
  })
  assert.deepEqual(made, [ROOT])
  assert.deepEqual(data.workspaceRepos, { 'contoso/fabrikam web': WEB_KEY })
  advance(9 * MINUTE)
  assert.deepEqual(pending.claim(BRANCH), ITEM, 'a long clone is still linked')

  const home = await setup({ ...CLONING, listed: [workspace('notes', { kind: 'folder' }), workspace('build-box', { hostId: 'ssh:build-box' })], focused: null })
  assert.equal((await home.w.request('work.startWork', START_CLONE)).status, 'sent')
  assert.deepEqual(home.terminals().map(each => (each as { workspaceId: string }).workspaceId), ['notes'], 'with nothing focused, the first local workspace by name')

  const linked = await setup({ ...CLONING, cloneFolder: '/tmp/repos', links: { '/tmp': '/private/tmp' } })
  const sent = await linked.w.request('work.startWork', START_CLONE)
  assert.equal(sent.status === 'sent' && sent.clone?.folder, '/private/tmp/repos/web-app')
  assert.equal(linked.files.written[`${fileId(1)}.folder`], '/private/tmp/repos/web-app', 'the real path of the root')
})

test('ssh is used when every remote of the organisation in Orca is ssh and the repository offers it, and https otherwise', async () => {
  const SSH_URL = 'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app'
  const sshTools: AdoRemote = { ...TOOLS, ssh: true }
  const cases: [Record<string, AdoRemote[]>, RepoRecord, string][] = [
    [{ [TOOLS_MAIN.path]: [sshTools], [API_MAIN.path]: [{ ...API, ssh: true }] }, WEB_RECORD, SSH_URL],
    [{ [TOOLS_MAIN.path]: [sshTools], [API_MAIN.path]: [{ ...API, ssh: true }] }, { ...WEB_RECORD, ssh: false }, WEB_URL],
    [{ [TOOLS_MAIN.path]: [sshTools], [API_MAIN.path]: [API] }, WEB_RECORD, WEB_URL],
    [{ [TOOLS_MAIN.path]: [{ ...PORTAL, ssh: true }] }, WEB_RECORD, WEB_URL]
  ]
  for (const [remotes, record, url] of cases) {
    const { w, files } = await setup({ ...CLONING, listed: [TOOLS_MAIN, API_MAIN], remotes, repos: [record] })
    assert.equal((await w.request('work.startWork', START_CLONE)).status, 'sent')
    assert.equal(files.written[`${fileId(1)}.url`], url)
  }
})

test('a folder that is already your clone, with a HEAD, is added without cloning', async () => {
  const { w, terminals, files } = await setup({
    ...CLONING,
    folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: ['.git', 'README.md'] } },
    git: { [FOLDER]: { topLevel: FOLDER, head: true } },
    remotes: { [TOOLS_MAIN.path]: [TOOLS], [FOLDER]: [WEB] }
  })
  const sent = await w.request('work.startWork', START_CLONE)
  assert.deepEqual(sent.status === 'sent' && sent.clone, { folder: SHOWN_FOLDER, fresh: false, setupSkipped: true })
  assert.deepEqual(terminals().map(commandOf), [cloned(null)?.command])
  assert.deepEqual(Object.keys(files.written).sort(), [`${fileId(1)}.folder`, `${fileId(1)}.prompt`, `${fileId(1)}.repo`])

  const empty = await setup({ ...CLONING, folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: [] } } })
  const into = await empty.w.request('work.startWork', START_CLONE)
  assert.equal(into.status === 'sent' && into.clone?.fresh, true, 'an empty folder of yours is cloned into')
})

test('a folder that matches a local workspace through a link is an Orca pick', async () => {
  for (const path of ['/private/tmp/repos/web-app', '/tmp/repos/web-app']) {
    const local = workspace('web-local', { path })
    const { w, terminals, data, files } = await setup({
      ...CLONING,
      listed: [TOOLS_MAIN, local],
      cloneFolder: '/tmp/repos',
      links: { '/tmp': '/private/tmp' },
      folders: { '/private/tmp/repos': MINE, '/private/tmp/repos/web-app': { ...MINE, entries: ['.git'] } }
    })
    assert.deepEqual(await w.request('work.startWork', START_CLONE), {
      status: 'sent',
      branch: BRANCH,
      repo: 'web-app',
      agent: 'claude',
      workspace: { id: local.id, name: local.name },
      shortened: false,
      clone: null
    })
    assert.deepEqual(terminals(), [{ workspaceId: local.id, title: 'ADO #1204', command: created() }], path)
    assert.deepEqual(files.written, { [`${fileId(1)}.prompt`]: PROMPTS.full })
    assert.deepEqual(data.workspaceRepos, { 'contoso/fabrikam web': `path:${path}` })
  }
})

test('a taken folder, a folder of another user, an unsafe name, a bad or unsafe root, a root that can\'t be made, or no git is refused before any file or terminal', async () => {
  const cases: [Partial<Desk>, ReturnType<typeof refused>][] = [
    [{ folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, directory: false } } }, refused(cloneFolderTaken(SHOWN_FOLDER, 'web-app'), 'warning')],
    [{ folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: ['notes.txt'] } } }, refused(cloneFolderTaken(SHOWN_FOLDER, 'web-app'), 'warning')],
    [{ folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: ['.git'] } }, git: { [FOLDER]: { topLevel: FOLDER, head: false } }, remotes: { [FOLDER]: [WEB] } }, refused(cloneFolderTaken(SHOWN_FOLDER, 'web-app'), 'warning')],
    [{ folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: ['.git'] } }, git: { [FOLDER]: { topLevel: FOLDER, head: true } }, remotes: { [FOLDER]: [API] } }, refused(cloneFolderTaken(SHOWN_FOLDER, 'web-app'), 'warning')],
    [{ folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, uid: UID + 1 } } }, refused(cloneFolderNotYours(SHOWN_FOLDER), 'warning')],
    [{ repos: [{ ...WEB_RECORD, name: 'web:app' }] }, refused(CLONE_NAME_UNSAFE, 'danger')],
    [{ repos: [{ ...WEB_RECORD, projectName: 'Fab\uD800rikam' }] }, refused(CLONE_URL_UNSAFE, 'danger')],
    [{ cloneFolder: 'repos' }, refused(CLONE_FOLDER_SETTING, 'danger')],
    [{ folders: { [ROOT]: { ...MINE, mode: 0o40777 } } }, refused(cloneRootUnsafe(ROOT), 'danger')],
    [{ folders: { [ROOT]: { ...MINE, uid: UID + 1 } } }, refused(cloneRootUnsafe(ROOT), 'danger')],
    [{ folders: { [`${HOME}/orca`]: { ...MINE, mode: 0o40777 } } }, refused(cloneRootUnsafe(ROOT), 'danger')],
    [{ folders: { [ROOT]: MINE, '/home': { ...SYSTEM, uid: UID + 1 } } }, refused(cloneRootUnsafe(ROOT), 'danger')],
    [{ failMkdir: true }, refused(cloneRootFailed(ROOT), 'danger')],
    [{ hasGit: false }, refused(NO_GIT, 'danger')],
    [{ listed: [workspace('build-box', { hostId: 'ssh:build-box' })], focused: null }, refused(NO_TERMINAL_HOME, 'warning')]
  ]
  for (const [over, expected] of cases) {
    const { w, terminals, files, pending, data, desk } = await setup({ ...CLONING, ...over })
    assert.deepEqual(await w.request('work.startWork', START_CLONE), expected)
    assert.deepEqual([terminals(), files.written, pending.expecting(ITEM), data.workspaceRepos], [[], {}, false, undefined], expected.message)
    if (expected.message !== cloneFolderNotYours(SHOWN_FOLDER)) continue
    delete desk.folders[FOLDER]
    assert.equal((await w.request('work.startWork', { ...START_CLONE, id: 1205 })).status, 'sent', 'the refusal let go of the folder')
  }
})

test('a clone pick already in Orca starts there instead, and one the list no longer has answers choose-repo with CLONE_GONE', async () => {
  const { w, terminals, made, data } = await setup({ listed: [MAIN, TOOLS_MAIN], repos: [WEB_RECORD] })
  assert.deepEqual(await w.request('work.startWork', START_CLONE), {
    status: 'sent',
    branch: BRANCH,
    repo: 'web-app',
    agent: 'claude',
    workspace: { id: MAIN.id, name: MAIN.name },
    shortened: false,
    clone: null
  })
  assert.deepEqual(terminals(), [{ workspaceId: MAIN.id, title: 'ADO #1204', command: created() }])
  assert.deepEqual(made, [])
  assert.deepEqual(data.workspaceRepos, { 'contoso/fabrikam web': WEB_KEY })

  const archived = { ...API_RECORD, disabled: true }
  const gone = await setup({ listed: [MAIN, TOOLS_MAIN], repos: [WEB_RECORD, archived] })
  const fresh = { repos: [row(TOOLS_KEY, 'tools', 'Tools', 'org'), row(WEB_KEY, 'web-app', 'Fabrikam Web', 'org')], selected: null, clone: CLONE_HERE }
  for (const repo of [{ ...CLONE_WEB, repoId: '0a1b2c3d-6666-4e5f-8a9b-0c1d2e3f4a5b' }, { ...CLONE_WEB, projectId: TOOLS_RECORD.projectId }, { ...CLONE_WEB, repoId: archived.id }]) {
    assert.deepEqual(await gone.w.request('work.startWork', { ...START_CLONE, repo }), { status: 'choose-repo', repos: fresh, message: CLONE_GONE })
  }
  assert.deepEqual(gone.terminals(), [])
})

test('a clone pick with no repository list read since the worker started asks for the list again, instead of saying the repository is gone', async () => {
  const { w, terminals, ado } = await setup({ ...CLONING, reposAt: null, served: { status: 200, repos: [WEB_RECORD, TOOLS_RECORD] } })
  const fresh = { repos: [row(TOOLS_KEY, 'tools', 'Tools', 'org')], selected: null, clone: CLONE_HERE }
  assert.deepEqual(await w.request('work.startWork', START_CLONE), { status: 'choose-repo', repos: fresh, message: CLONE_RELOAD })
  assert.deepEqual([terminals(), ado.calls.length], [[], 0], 'the pick itself still makes no request')

  await w.request('work.cloneTargets', { org: 'contoso' })
  assert.equal((await w.request('work.startWork', START_CLONE)).status, 'sent', 'once the list is read again, the same pick clones')
})

test('two starts for the same folder at once: the second is refused before either awaits', async () => {
  const upper: RepoRecord = { ...TOOLS_RECORD, id: '1b2c3d4e-7777-4f6a-9b8c-1d2e3f4a5b6c', name: 'Web-App' }
  const { gate, open } = gated()
  const { w, terminals, loads } = await setup({ ...CLONING, repos: [WEB_RECORD, upper], gate })
  const answers: unknown[] = []
  const first = w.request('work.startWork', START_CLONE)
  const second = w.request('work.startWork', { org: 'contoso', id: 1205, repo: { kind: 'clone', projectId: upper.projectId, repoId: upper.id } })
  void second.then(answer => answers.push(answer))
  try {
    await drain()
    assert.deepEqual(answers, [refused(stillCloning('web-app', 1204), 'warning')])
    assert.deepEqual(loads, ['details'], 'the second start never awaited anything')
  } finally {
    open()
  }
  assert.equal((await first).status, 'sent')
  await second
  assert.equal(terminals().length, 1)
})

test('a pending clone holds its folder for any item, the same item included, until it is linked, 10 minutes pass, or the folder is absent or empty after 2 minutes', async () => {
  const other = { ...START_CLONE, id: 1205 }
  const still = refused(stillCloning('web-app', 1204), 'warning')

  const linked = await setup(CLONING)
  assert.equal((await linked.w.request('work.startWork', START_CLONE)).status, 'sent')
  assert.deepEqual(await linked.w.request('work.startWork', other), still)
  linked.pending.claim(BRANCH)
  assert.equal((await linked.w.request('work.startWork', other)).status, 'sent', 'linked')

  const present = await setup(CLONING)
  assert.equal((await present.w.request('work.startWork', START_CLONE)).status, 'sent')
  present.desk.folders[FOLDER] = { ...MINE, entries: ['.git'] }
  present.advance(2 * MINUTE + 1)
  assert.deepEqual(await present.w.request('work.startWork', START_CLONE), still, 'the same item')
  assert.deepEqual(await present.w.request('work.startWork', other), still)
  present.desk.gate = Promise.reject(new Error('Azure DevOps is unreachable.'))
  present.desk.gate.catch(() => {})
  await assert.rejects(present.w.request('work.startWork', { ...START_CLONE, id: 1206 }), /unreachable/)
  present.desk.gate = Promise.resolve()
  assert.deepEqual(await present.w.request('work.startWork', other), still, 'a start that failed gave the hold back')
  present.advance(8 * MINUTE)
  present.desk.git[FOLDER] = { topLevel: FOLDER, head: true }
  present.desk.remotes[FOLDER] = [WEB]
  const added = await present.w.request('work.startWork', other)
  assert.equal(added.status === 'sent' && added.clone?.fresh, false, 'ten minutes passed')

  const absent = await setup(CLONING)
  assert.equal((await absent.w.request('work.startWork', START_CLONE)).status, 'sent')
  absent.advance(2 * MINUTE)
  assert.deepEqual(await absent.w.request('work.startWork', other), still, 'not before two minutes')
  absent.advance(1)
  const again = await absent.w.request('work.startWork', other)
  assert.equal(again.status === 'sent' && again.clone?.fresh, true, 'git removed the folder of a failed clone')
  assert.deepEqual(await absent.w.request('work.startWork', { ...START_CLONE, id: 1206 }), refused(stillCloning('web-app', 1205), 'warning'))

  const empty = await setup({ ...CLONING, folders: { [ROOT]: MINE, [FOLDER]: { ...MINE, entries: [] } } })
  assert.equal((await empty.w.request('work.startWork', START_CLONE)).status, 'sent')
  empty.advance(2 * MINUTE)
  assert.deepEqual(await empty.w.request('work.startWork', other), still, 'not before two minutes')
  empty.advance(1)
  const retried = await empty.w.request('work.startWork', other)
  assert.equal(retried.status === 'sent' && retried.clone?.fresh, true, 'git kept the folder that was empty before the failed clone, still empty')
})

test('hostile project and repository names never reach the command', async () => {
  const template = cloned('https://dev.azure.com/contoso/x/_git/y', '/x')?.command
  const names: [string, string][] = [
    ["it's \"x\"", 'Fabrikam Web'],
    ['$(touch PWNED)', 'Fabrikam Web'],
    ['a`b', 'Fabrikam Web'],
    ['web\napp', 'Fabrikam Web'],
    ['-rf', 'Fabrikam Web'],
    ['web‮app', 'Fabrikam Web'],
    ['wеb-app', "Fab'rikam"],
    ['web app', "Fab'rikam"],
    ['web-app', '$(touch PWNED)'],
    ['web-app', 'a`b"c']
  ]
  const accepted: string[] = []
  for (const [name, projectName] of names) {
    const { w, terminals, files, loads } = await setup({ ...CLONING, repos: [{ ...WEB_RECORD, name, projectName }] })
    const result = await w.request('work.startWork', START_CLONE)
    if (result.status === 'refused') {
      assert.deepEqual(result, refused(CLONE_NAME_UNSAFE, 'danger'), name)
      assert.deepEqual([terminals(), files.written, loads], [[], {}, []], name)
      continue
    }
    assert.equal(result.status, 'sent', name)
    const [command] = terminals().map(commandOf)
    assert.equal(command, template, name)
    for (const text of [name, projectName]) assert.ok(!command.includes(text), text)
    assert.equal(files.written[`${fileId(1)}.folder`], `${ROOT}/${name}`)
    accepted.push(files.written[`${fileId(1)}.url`])
  }
  assert.deepEqual(accepted, [
    'https://dev.azure.com/contoso/Fab%27rikam/_git/w%D0%B5b-app',
    'https://dev.azure.com/contoso/Fab%27rikam/_git/web%20app',
    'https://dev.azure.com/contoso/%24%28touch%20PWNED%29/_git/web-app',
    'https://dev.azure.com/contoso/a%60b%22c/_git/web-app'
  ])
})
