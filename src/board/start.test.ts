import { assert, test } from 'orca/testing'
import { CLONE_LATE_MS, CLONE_VALUE, LATE_MS, SETUP_SKIPPED, SHORTENED } from '../shared/start-flow'
import type { CloneTargets, ItemWorkspace, StartAgentResult, StartRepo, StartRepos, StartWorkResult, WorkspaceRef } from '../shared/work'
import { find, findAll, fire, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { createStart, startSection, type StartRequests } from './start'

const ORG = 'contoso'
const STORY = 4211
const OTHER = 4213
const BOARD = { teamId: '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e', boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091' }
const ITEM_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4211'
const BRANCH = 'feature/4211-add-vehicle-search-filters'
const AGENT = 'Claude'
const CREATING: WorkspaceRef = { id: 'wt-4211', name: BRANCH }
const SENT: StartWorkResult = { status: 'sent', branch: BRANCH, repo: 'web-app', agent: AGENT, workspace: CREATING, shortened: false, clone: null }
const NOT_ON_WINDOWS = "Starting a workspace or an agent from an item isn't supported on Windows yet."
const STILL_CREATING = "This item's workspace is still being created. If Orca's terminal shows an error, try again in two minutes."
const REPO_GONE = "That repository isn't in Orca any more. Choose another."
const NO_TERMINAL_HOME = 'Cloning needs a workspace in Orca to run in. Open any folder in Orca, then try again.'
const REPOS_UNLISTED = "Azure DevOps didn't list this organisation's repositories, so the plugin can't clone from it. Clone the repository yourself and add it to Orca."
const CLONE_GONE = 'Azure DevOps no longer lists that repository. Choose another.'
const CLONE_RELOAD = 'The repository list needs reloading. Choose the repository to clone again.'
const WEB_ROW: StartRepo = { key: 'web-app', name: 'web-app', detail: 'Fabrikam Web', source: 'pr' }
const API_ROW: StartRepo = { key: 'api', name: 'api', detail: 'Fabrikam API', source: 'last' }
const TOOLS_ROW: StartRepo = { key: 'tools', name: 'tools', detail: 'Tools', source: 'org' }
const CLONE_HERE = { folder: '~/orca/repos' }
const KNOWN: StartRepos = { repos: [WEB_ROW, API_ROW, TOOLS_ROW], selected: 'web-app', clone: CLONE_HERE }
const UNKNOWN: StartRepos = { ...KNOWN, selected: null }
const NONE: StartRepos = { repos: [], selected: null, clone: CLONE_HERE }
const TARGETS: CloneTargets = {
  projects: [
    { id: 'p-web', name: 'Fabrikam Web', repos: [{ id: 'r-web', name: 'web-app' }, { id: 'r-api', name: 'api' }] },
    { id: 'p-tools', name: 'Tools', repos: [{ id: 'r-tools', name: 'tools' }] },
  ],
  readAt: Date.parse('2026-11-12T09:00:00Z'),
  more: 0,
}
const REPO_ROWS = [
  ['', 'Choose a repository'],
  ['web-app', 'web-app · Fabrikam Web (linked pull request)'],
  ['api', 'api · Fabrikam API (last used)'],
  ['tools', 'tools · Tools'],
  [CLONE_VALUE, 'Clone from Azure DevOps…'],
]

interface Pending<I, O> {
  input: I
  resolve(value: O): void
  reject(error: Error): void
}

function recorder<I, O>() {
  const list: Pending<I, O>[] = []
  const call = (input: I) => new Promise<O>((resolve, reject) => list.push({ input, resolve, reject }))
  return { list, call }
}

const fake = (node: HTMLElement) => node as unknown as FakeNode
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { board?: typeof BOARD | null } = {}) {
  const lookups = recorder<Parameters<StartRequests['itemWorkspace']>[0], ItemWorkspace>()
  const repoLists = recorder<Parameters<StartRequests['startRepos']>[0], StartRepos>()
  const targetLists = recorder<Parameters<StartRequests['cloneTargets']>[0], CloneTargets>()
  const works = recorder<Parameters<StartRequests['startWork']>[0], StartWorkResult>()
  const agents = recorder<Parameters<StartRequests['startAgent']>[0], StartAgentResult>()
  const opens: string[] = []
  const opened: string[] = []
  const timeouts = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 1
  const timers = {
    setTimeout: ((run: () => void, ms: number) => {
      timeouts.set(nextTimer, { run, ms })
      return nextTimer++
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number | undefined) => {
      if (id !== undefined) timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
  }
  const counter = { changes: 0 }
  let openAnswer: () => Promise<{ opened: true }> = () => Promise.resolve({ opened: true })
  const start = createStart({
    org: ORG,
    itemId: STORY,
    board: options.board === undefined ? BOARD : options.board,
    requests: {
      itemWorkspace: lookups.call,
      startRepos: repoLists.call,
      cloneTargets: targetLists.call,
      startWork: works.call,
      startAgent: agents.call,
      openWorkspace: ({ workspaceId }) => {
        opens.push(workspaceId)
        return openAnswer()
      },
    },
    timers,
    changed: () => counter.changes++,
  })
  const handlers = {
    startWork: () => void start.startWork(),
    startAgent: () => void start.startAgent(),
    show: (workspace: WorkspaceRef) => void start.show(workspace),
    changeRepo: () => start.changeRepo(),
    chooseRepo: (value: string) => start.chooseRepo(value),
    chooseProject: (id: string) => start.chooseProject(id),
    chooseCloneRepo: (id: string) => start.chooseCloneRepo(id),
    open: (url: string) => opened.push(url),
  }
  return {
    start,
    counter,
    lookups: lookups.list,
    repoLists: repoLists.list,
    targetLists: targetLists.list,
    works: works.list,
    agents: agents.list,
    opens,
    opened,
    timeouts,
    failOpen: (error: Error) => {
      openAnswer = () => Promise.reject(error)
    },
    view: (disabled = false) => fake(startSection(start.state(), ITEM_URL, handlers, disabled)),
    ready: async (found: ItemWorkspace = { workspace: null, unsupported: null }) => {
      lookups.list[0].resolve(found)
      await settle()
    },
    offered: async (repos: StartRepos) => {
      lookups.list[0].resolve({ workspace: null, unsupported: null })
      await settle()
      repoLists.list[0].resolve(repos)
      await settle()
    },
  }
}

const buttons = (root: FakeNode) => findAll(root, node => node.tagName === 'button').map(node => [textOf(node), node.disabled])

function buttonNamed(root: FakeNode, text: string): FakeNode {
  const node = find(root, entry => entry.tagName === 'button' && textOf(entry) === text)
  assert.ok(node, `a ${text} button`)
  return node
}

const controlOf = (root: FakeNode, key: string) => find(root, node => node.dataset.start === key)

function selectOf(root: FakeNode, key: string): FakeNode {
  const node = controlOf(root, key)
  assert.ok(node, `a ${key} select`)
  assert.equal(node.tagName, 'select')
  return node
}

const optionsOf = (select: FakeNode) => select.children.map(option => [option.value, textOf(option)])

function choose(select: FakeNode, value: string): void {
  select.value = value
  fire(select, 'change')
}

const notes = (root: FakeNode) => findAll(root, node => node.tagName === 'p' && node.className === 'muted').map(textOf)

function ownText(node: FakeNode): string {
  return node.tagName === 'button' ? '' : node.text + node.children.map(ownText).join('')
}

function notices(root: FakeNode) {
  return findAll(root, node => node.className.split(' ').includes('notice')).map(node => ({
    className: node.className,
    role: node.attributes.get('role'),
    text: ownText(node),
  }))
}

test('the footer offers Start a workspace and agent until a workspace is linked, then Start an agent and Open workspace', async () => {
  await withFakeDom(async () => {
    const t = setup()
    assert.deepEqual(
      t.lookups.map(entry => entry.input),
      [{ org: ORG, id: STORY }],
      'the lookup goes out at once'
    )
    assert.deepEqual(buttons(t.view()), [['Start a workspace and agent', true]], 'off while the lookup runs')
    assert.equal(t.repoLists.length, 0, 'the repositories wait for the lookup')

    const link = find(t.view(), node => node.tagName === 'a')
    assert.ok(link)
    assert.equal(textOf(link), 'Open in Azure DevOps')
    assert.equal(link.attributes.has('href'), false)
    fire(link, 'click')
    assert.deepEqual(t.opened, [ITEM_URL])

    await t.ready()
    assert.equal(t.counter.changes, 1)
    assert.deepEqual(buttons(t.view()), [['Start a workspace and agent', false]], 'on while the repositories are read')
    assert.deepEqual(
      t.repoLists.map(entry => entry.input),
      [{ org: ORG, id: STORY, board: BOARD }]
    )

    t.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    const linked = t.view()
    assert.deepEqual(buttons(linked), [
      ['Start an agent', false],
      ['Open workspace', false],
    ])
    fire(buttonNamed(linked, 'Open workspace'), 'click')
    assert.deepEqual(t.opens, [CREATING.id])
  })
})

test('the repositories are read only when the lookup finds no workspace on a supported platform', async () => {
  await withFakeDom(async () => {
    const linked = setup()
    await linked.ready({ workspace: CREATING, unsupported: null })
    const unsupported = setup()
    await unsupported.ready({ workspace: null, unsupported: NOT_ON_WINDOWS })
    const failed = setup()
    failed.lookups[0].reject(new Error('The request timed out.'))
    await settle()
    assert.deepEqual([linked.repoLists.length, unsupported.repoLists.length, failed.repoLists.length], [0, 0, 0])

    const boardless = setup({ board: null })
    await boardless.ready()
    assert.deepEqual(
      boardless.repoLists.map(entry => entry.input),
      [{ org: ORG, id: STORY }]
    )
  })
})

test('with a known repo the footer shows it with Change repo, and Start uses it', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(KNOWN)
    const root = t.view()
    const line = controlOf(root, 'change')?.parent
    assert.ok(line)
    assert.equal(line.className, 'choice')
    assert.equal(ownText(line), 'web-app · Fabrikam Web (linked pull request)')
    assert.equal(find(root, node => node.tagName === 'select'), undefined)
    assert.deepEqual(buttons(root), [
      ['Change repo', false],
      ['Start a workspace and agent', false],
    ])

    fire(buttonNamed(root, 'Start a workspace and agent'), 'click')
    assert.deepEqual(
      t.works.map(entry => entry.input),
      [{ org: ORG, id: STORY, board: BOARD, repo: { kind: 'orca', key: 'web-app' } }]
    )
    assert.deepEqual(buttons(t.view()), [
      ['Change repo', true],
      ['Start a workspace and agent', true],
    ], 'the picker is off while the start runs')
  })
})

test('with no known repo the list shows every row and Start waits for a choice', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(UNKNOWN)
    const root = t.view()
    const select = selectOf(root, 'repo')
    assert.equal(select.parent?.tagName, 'label')
    assert.equal(select.parent?.className, 'field')
    assert.equal(textOf(select.parent!).startsWith('Repository'), true)
    assert.equal(select.parent?.parent?.className, 'choice')
    assert.deepEqual(optionsOf(select), REPO_ROWS)
    assert.equal(select.children[0].disabled, true, 'the placeholder is not a choice')
    assert.equal(select.value, '')
    assert.deepEqual(buttons(root), [['Start a workspace and agent', true]])

    choose(select, 'api')
    const chosen = t.view()
    assert.equal(selectOf(chosen, 'repo').value, 'api')
    assert.deepEqual(buttons(chosen), [['Start a workspace and agent', false]])
    fire(buttonNamed(chosen, 'Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[0].input, { org: ORG, id: STORY, board: BOARD, repo: { kind: 'orca', key: 'api' } })
  })
})

test('Change repo opens the list on the current repo, and picking another starts there', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(KNOWN)
    fire(buttonNamed(t.view(), 'Change repo'), 'click')
    const root = t.view()
    assert.equal(controlOf(root, 'change'), undefined)
    assert.equal(selectOf(root, 'repo').value, 'web-app')
    assert.deepEqual(buttons(root), [['Start a workspace and agent', false]])

    choose(selectOf(root, 'repo'), 'tools')
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[0].input, { org: ORG, id: STORY, board: BOARD, repo: { kind: 'orca', key: 'tools' } })
  })
})

test('Clone from Azure DevOps… reads the list once, selects nothing, and says where it clones once a repository is chosen', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(KNOWN)
    fire(buttonNamed(t.view(), 'Change repo'), 'click')
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    assert.deepEqual(
      t.targetLists.map(entry => entry.input),
      [{ org: ORG }]
    )
    const loading = t.view()
    assert.equal(selectOf(loading, 'repo').value, CLONE_VALUE)
    assert.equal(controlOf(loading, 'project'), undefined)
    assert.deepEqual(notes(loading), ['Reading the repository list…'])
    assert.deepEqual(buttons(loading), [['Start a workspace and agent', true]])

    t.targetLists[0].resolve(TARGETS)
    await settle()
    const listed = t.view()
    const project = selectOf(listed, 'project')
    assert.equal(textOf(project.parent!).startsWith('Project'), true)
    assert.deepEqual(optionsOf(project), [
      ['', 'Choose a project'],
      ['p-web', 'Fabrikam Web'],
      ['p-tools', 'Tools'],
    ])
    assert.equal(project.value, '', 'nothing is preselected, though the item has a linked pull request')
    const repo = selectOf(listed, 'clone-repo')
    assert.equal(textOf(repo.parent!).startsWith('Repository to clone'), true)
    assert.deepEqual(optionsOf(repo), [['', 'Choose a repository']])
    assert.equal(repo.disabled, true, 'no repositories until a project is chosen')
    assert.deepEqual(notes(listed), [])
    assert.deepEqual(buttons(listed), [['Start a workspace and agent', true]])

    choose(project, 'p-web')
    const inProject = t.view()
    assert.equal(selectOf(inProject, 'project').value, 'p-web')
    assert.deepEqual(optionsOf(selectOf(inProject, 'clone-repo')), [
      ['', 'Choose a repository'],
      ['r-web', 'web-app'],
      ['r-api', 'api'],
    ])
    assert.equal(selectOf(inProject, 'clone-repo').value, '')
    assert.deepEqual(buttons(inProject), [['Start a workspace and agent', true]])

    choose(selectOf(inProject, 'clone-repo'), 'r-api')
    const ready = t.view()
    assert.deepEqual(notes(ready), ['Clones into ~/orca/repos/api'])
    assert.deepEqual(buttons(ready), [['Start a workspace and agent', false]])

    choose(selectOf(ready, 'project'), 'p-tools')
    assert.equal(selectOf(t.view(), 'clone-repo').value, '', "a project's only repository is still the user's to choose")
    assert.deepEqual(notes(t.view()), [])
    assert.deepEqual(buttons(t.view()), [['Start a workspace and agent', true]])
    choose(selectOf(t.view(), 'clone-repo'), 'r-tools')
    assert.deepEqual(notes(t.view()), ['Clones into ~/orca/repos/tools'])

    choose(selectOf(t.view(), 'repo'), 'api')
    assert.equal(controlOf(t.view(), 'project'), undefined)
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    await settle()
    assert.equal(t.targetLists.length, 1, 'the list is read once')
    assert.equal(selectOf(t.view(), 'project').value, '', 'a fresh Clone selects nothing')

    choose(selectOf(t.view(), 'project'), 'p-web')
    choose(selectOf(t.view(), 'clone-repo'), 'r-web')
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[0].input, { org: ORG, id: STORY, board: BOARD, repo: { kind: 'clone', projectId: 'p-web', repoId: 'r-web' } })
  })
})

test('a list still being read is asked for once, however often Clone is chosen', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(UNKNOWN)
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    choose(selectOf(t.view(), 'repo'), 'tools')
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    assert.equal(t.targetLists.length, 1)
    t.targetLists[0].resolve(TARGETS)
    await settle()
    assert.ok(controlOf(t.view(), 'project'))
  })
})

test('with no repos in Orca the picker opens on Clone and says so', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(NONE)
    const root = t.view()
    const select = selectOf(root, 'repo')
    assert.deepEqual(optionsOf(select), [
      ['', 'Choose a repository'],
      [CLONE_VALUE, 'Clone from Azure DevOps…'],
    ])
    assert.equal(select.value, CLONE_VALUE)
    assert.deepEqual(notes(root), ['No repositories are in Orca on this computer yet. Clone one from Azure DevOps.', 'Reading the repository list…'])
    assert.deepEqual(
      t.targetLists.map(entry => entry.input),
      [{ org: ORG }],
      'the list is read at once'
    )

    t.targetLists[0].resolve({ ...TARGETS, more: 12 })
    await settle()
    assert.deepEqual(notes(t.view()), [
      'No repositories are in Orca on this computer yet. Clone one from Azure DevOps.',
      "12 more repositories aren't listed. Clone them yourself and add them to Orca.",
    ])
  })
})

test('a clone problem shows instead of the project and repository selects, and Start stays off', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered({ ...UNKNOWN, clone: { problem: NO_TERMINAL_HOME } })
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    const root = t.view()
    assert.equal(t.targetLists.length, 0, 'no list is read for a clone that cannot run')
    assert.equal(controlOf(root, 'project'), undefined)
    assert.equal(controlOf(root, 'clone-repo'), undefined)
    assert.deepEqual(notes(root), [])
    assert.deepEqual(notices(root), [{ className: 'notice warning', role: 'status', text: NO_TERMINAL_HOME }], 'a warning, as in the sidebar')
    assert.deepEqual(buttons(root), [['Start a workspace and agent', true]])
  })
})

test('a list that could not be read says why, and Clone asks again next time', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(UNKNOWN)
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    t.targetLists[0].reject(new Error(REPOS_UNLISTED))
    await settle()
    const root = t.view()
    assert.equal(controlOf(root, 'project'), undefined)
    assert.deepEqual(notes(root), [])
    assert.deepEqual(notices(root), [{ className: 'notice warning', role: 'status', text: REPOS_UNLISTED }])
    assert.deepEqual(buttons(root), [['Start a workspace and agent', true]])

    choose(selectOf(t.view(), 'repo'), 'tools')
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    assert.equal(t.targetLists.length, 2)
  })
})

test('a clone the worker answers with CLONE_GONE, or with a list to reload, reads the list again on the next Clone', async () => {
  await withFakeDom(async () => {
    for (const message of [CLONE_GONE, CLONE_RELOAD]) {
      const t = setup()
      await t.offered(UNKNOWN)
      choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
      t.targetLists[0].resolve(TARGETS)
      await settle()
      choose(selectOf(t.view(), 'project'), 'p-web')
      choose(selectOf(t.view(), 'clone-repo'), 'r-web')
      fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
      t.works[0].resolve({ status: 'choose-repo', repos: UNKNOWN, message })
      await settle()
      assert.deepEqual(notices(t.view()), [{ className: 'notice warning', role: 'status', text: message }])
      assert.equal(selectOf(t.view(), 'repo').value, '')

      choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
      assert.equal(t.targetLists.length, 2, message)
      assert.deepEqual(notes(t.view()), ['Reading the repository list…'])
      t.targetLists[1].resolve(TARGETS)
      await settle()
      assert.equal(selectOf(t.view(), 'project').value, '')
    }

    const none = setup()
    await none.offered(NONE)
    none.targetLists[0].resolve(TARGETS)
    await settle()
    choose(selectOf(none.view(), 'project'), 'p-tools')
    choose(selectOf(none.view(), 'clone-repo'), 'r-tools')
    fire(buttonNamed(none.view(), 'Start a workspace and agent'), 'click')
    none.works[0].resolve({ status: 'choose-repo', repos: NONE, message: CLONE_RELOAD })
    await settle()
    assert.equal(none.targetLists.length, 2, 'with no repos in Orca the picker is on Clone, so it reads the list at once')
  })
})

test("an Orca pick that is gone keeps the clone list, which the worker still has", async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(UNKNOWN)
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    t.targetLists[0].resolve(TARGETS)
    await settle()
    choose(selectOf(t.view(), 'repo'), 'tools')
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    t.works[0].resolve({ status: 'choose-repo', repos: UNKNOWN, message: REPO_GONE })
    await settle()
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    await settle()
    assert.equal(t.targetLists.length, 1)
    assert.ok(controlOf(t.view(), 'project'))
  })
})

test('a failed read of the repositories leaves the picker off and Start on, and the worker then asks for a choice', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    t.repoLists[0].reject(new Error('The request timed out.'))
    await settle()
    const root = t.view()
    assert.equal(find(root, node => node.className === 'choice'), undefined)
    assert.deepEqual(notices(root), [])
    assert.deepEqual(buttons(root), [['Start a workspace and agent', false]])

    fire(buttonNamed(root, 'Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[0].input, { org: ORG, id: STORY, board: BOARD })
    t.works[0].resolve({ status: 'choose-repo', repos: UNKNOWN, message: null })
    await settle()
    assert.equal(selectOf(t.view(), 'repo').value, '')
  })
})

test("the panel's own writes turn every start control off, as the sidebar's do", async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(KNOWN)
    assert.deepEqual(buttons(t.view(true)), [
      ['Change repo', true],
      ['Start a workspace and agent', true],
    ])

    t.start.changeRepo()
    choose(selectOf(t.view(), 'repo'), CLONE_VALUE)
    t.targetLists[0].resolve(TARGETS)
    await settle()
    t.start.chooseProject('p-web')
    const choosing = t.view(true)
    assert.deepEqual(
      ['repo', 'project', 'clone-repo'].map(key => controlOf(choosing, key)?.disabled),
      [true, true, true]
    )
    assert.deepEqual(buttons(choosing), [['Start a workspace and agent', true]])

    t.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    assert.deepEqual(buttons(t.view(true)), [
      ['Start an agent', true],
      ['Open workspace', true],
    ])
  })
})

test("an unsupported platform turns the start buttons off and shows why, but a linked workspace still opens", async () => {
  await withFakeDom(async () => {
    const fresh = setup()
    await fresh.ready({ workspace: null, unsupported: NOT_ON_WINDOWS })
    assert.deepEqual(buttons(fresh.view()), [['Start a workspace and agent', true]])
    assert.ok(find(fresh.view(), node => node.className === 'muted' && node.text === NOT_ON_WINDOWS))

    const linked = setup()
    await linked.ready({ workspace: CREATING, unsupported: NOT_ON_WINDOWS })
    assert.deepEqual(buttons(linked.view()), [
      ['Start an agent', true],
      ['Open workspace', false],
    ])
  })
})

test('a sent start waits for the workspace, and Start stays off until it is ready', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(KNOWN)
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    assert.deepEqual(
      t.works.map(entry => entry.input),
      [{ org: ORG, id: STORY, board: BOARD, repo: { kind: 'orca', key: 'web-app' } }]
    )
    assert.deepEqual(buttons(t.view())[1], ['Start a workspace and agent', true], 'off while the request runs')

    t.works[0].resolve({ ...SENT, shortened: true })
    await settle()
    assert.deepEqual(notices(t.view()), [
      { className: 'notice accent', role: 'status', text: `Creating ${BRANCH} in web-app. Orca opens it when it's ready.` },
      { className: 'notice warning', role: 'status', text: SHORTENED },
    ])
    assert.deepEqual(buttons(t.view())[1], ['Start a workspace and agent', true], 'off while the start waits for its answer')

    t.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    assert.equal(t.timeouts.size, 0, 'the late notice is off')
    assert.deepEqual(notices(t.view())[0], { className: 'notice success', role: 'status', text: `${BRANCH} is open, and ${AGENT} is starting with the item's details.` })
    assert.deepEqual(buttons(t.view()), [
      ['Start an agent', false],
      ['Open workspace', false],
    ])

    t.start.agentWorking({ org: ORG, itemId: STORY })
    assert.equal(notices(t.view())[0].text, `${AGENT} is working on it.`)

    fire(buttonNamed(t.view(), 'Start an agent'), 'click')
    assert.deepEqual(
      t.agents.map(entry => entry.input),
      [{ org: ORG, id: STORY }]
    )
    t.agents[0].resolve({ status: 'sent', agent: AGENT, workspace: CREATING, shortened: false })
    await settle()
    assert.deepEqual(notices(t.view()), [{ className: 'notice success', role: 'status', text: `${AGENT} is starting in ${BRANCH}.` }])
    assert.deepEqual(buttons(t.view()), [
      ['Start an agent', true],
      ['Open workspace', false],
    ])
    t.start.agentWorking({ org: ORG, itemId: STORY })
    assert.deepEqual(buttons(t.view())[0], ['Start an agent', false])
  })
})

test('no answer within 60 s shows the late notice with Show it', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve(SENT)
    await settle()
    assert.deepEqual(
      [...t.timeouts.values()].map(entry => entry.ms),
      [LATE_MS]
    )
    assert.equal(LATE_MS, 60_000)

    const changes = t.counter.changes
    for (const entry of t.timeouts.values()) entry.run()
    assert.equal(t.counter.changes, changes + 1)
    const root = t.view()
    assert.deepEqual(notices(root), [{ className: 'notice neutral', role: 'status', text: `Sent to Orca. If ${BRANCH} didn't appear, the terminal "ADO #${STORY}" in ${BRANCH} shows why.` }])
    assert.deepEqual(buttons(root), [
      ['Start a workspace and agent', false],
      ['Show it', false],
    ])

    fire(buttonNamed(root, 'Show it'), 'click')
    assert.deepEqual(t.opens, [CREATING.id])

    t.failOpen(new Error("Orca couldn't find that workspace."))
    fire(buttonNamed(t.view(), 'Show it'), 'click')
    await settle()
    assert.deepEqual(notices(t.view()), [{ className: 'notice danger', role: 'alert', text: "Orca couldn't find that workspace." }])
  })
})

test("a sent clone says it is cloning with Show it, keeps Start off without a late notice at 60 seconds, shows it at 10 minutes, and says setup didn't run", async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(NONE)
    t.targetLists[0].resolve(TARGETS)
    await settle()
    t.start.chooseProject('p-web')
    t.start.chooseCloneRepo('r-api')
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    t.works[0].resolve({ ...SENT, repo: 'api', clone: { folder: '~/orca/repos/api', fresh: true, setupSkipped: true } })
    await settle()
    const sent = t.view()
    assert.deepEqual(notices(sent), [
      { className: 'notice accent', role: 'status', text: `Cloning api into ~/orca/repos/api, then creating ${BRANCH}. Orca opens it when it's ready.` },
      { className: 'notice warning', role: 'status', text: SETUP_SKIPPED },
    ])
    assert.deepEqual(buttons(sent), [['Start a workspace and agent', true], ['Show it', false]])
    fire(buttonNamed(sent, 'Show it'), 'click')
    assert.deepEqual(t.opens, [CREATING.id])
    assert.deepEqual(
      [...t.timeouts.values()].map(entry => entry.ms),
      [CLONE_LATE_MS]
    )
    assert.equal(CLONE_LATE_MS, 600_000)

    for (const entry of t.timeouts.values()) entry.run()
    const late = t.view()
    assert.deepEqual(notices(late), [
      { className: 'notice neutral', role: 'status', text: `Sent to Orca. If ${BRANCH} didn't appear, the terminal "ADO #${STORY}" in ${BRANCH} shows why.` },
      { className: 'notice warning', role: 'status', text: SETUP_SKIPPED },
    ])
    assert.deepEqual(buttons(late)[0], ['Start a workspace and agent', false])

    t.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    assert.deepEqual(notices(t.view())[1], { className: 'notice warning', role: 'status', text: SETUP_SKIPPED }, 'the setup note stays once the workspace is open')
  })
})

test('under the notice the setup note comes first, then the shortened-prompt note', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve({ ...SENT, repo: 'api', shortened: true, clone: { folder: '~/orca/repos/api', fresh: true, setupSkipped: true } })
    await settle()
    assert.deepEqual(notices(t.view()), [
      { className: 'notice accent', role: 'status', text: `Cloning api into ~/orca/repos/api, then creating ${BRANCH}. Orca opens it when it's ready.` },
      { className: 'notice warning', role: 'status', text: SETUP_SKIPPED },
      { className: 'notice warning', role: 'status', text: SHORTENED },
    ])
  })
})

test('the picker goes once the workspace is linked', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.offered(UNKNOWN)
    t.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    const root = t.view()
    assert.equal(find(root, node => node.className === 'choice'), undefined)
    assert.equal(t.start.state().picker, null)
    assert.deepEqual(buttons(root), [
      ['Start an agent', false],
      ['Open workspace', false],
    ])

    const late = setup()
    await late.ready()
    late.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    late.repoLists[0].resolve(KNOWN)
    await settle()
    assert.equal(late.start.state().picker, null, 'a list that lands after the link is dropped')

    const answered = setup()
    await answered.offered(KNOWN)
    void answered.start.startWork()
    answered.works[0].resolve({ status: 'linked', branch: BRANCH, workspace: CREATING })
    await settle()
    assert.equal(find(answered.view(), node => node.className === 'choice'), undefined)
  })
})

test('choose-repo shows the list with the remembered one selected and its message, and Start sends the choice', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve({ status: 'choose-repo', repos: { ...KNOWN, selected: 'api' }, message: REPO_GONE })
    await settle()
    const root = t.view()
    assert.deepEqual(notices(root), [{ className: 'notice warning', role: 'status', text: REPO_GONE }])
    const select = selectOf(root, 'repo')
    assert.deepEqual(optionsOf(select), REPO_ROWS)
    assert.equal(select.value, 'api')

    choose(select, 'web-app')
    assert.equal(selectOf(t.view(), 'repo').value, 'web-app')
    fire(buttonNamed(t.view(), 'Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[1].input, { org: ORG, id: STORY, board: BOARD, repo: { kind: 'orca', key: 'web-app' } })
    assert.equal(selectOf(t.view(), 'repo').disabled, true, 'the choice is off once sent')
  })
})

test('a choose-repo answer that lands before the repositories keeps its list', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve({ status: 'choose-repo', repos: UNKNOWN, message: REPO_GONE })
    await settle()
    t.repoLists[0].resolve(KNOWN)
    await settle()
    assert.equal(controlOf(t.view(), 'change'), undefined)
    assert.equal(selectOf(t.view(), 'repo').value, '')
  })
})

test('a refused start shows its message and tone', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve({ status: 'refused', message: STILL_CREATING, tone: 'warning' })
    await settle()
    assert.deepEqual(notices(t.view()), [{ className: 'notice warning', role: 'status', text: STILL_CREATING }])
    assert.deepEqual(buttons(t.view()), [['Start a workspace and agent', false]])
    assert.equal(t.timeouts.size, 0)

    void t.start.startWork()
    t.works[1].reject(new Error('The request timed out.'))
    await settle()
    assert.deepEqual(notices(t.view()), [{ className: 'notice danger', role: 'alert', text: 'The request timed out.' }])
    assert.deepEqual(buttons(t.view()), [['Start a workspace and agent', false]])
  })
})

test('events for another item are ignored', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve(SENT)
    await settle()
    const before = t.start.state()
    const changes = t.counter.changes

    t.start.workspaceReady({ org: ORG, itemId: OTHER, workspaceId: 'wt-4213', branch: 'feature/4213-show-filter-counts' })
    t.start.workspaceReady({ org: 'fabrikam', itemId: STORY, workspaceId: 'wt-4211', branch: BRANCH })
    t.start.agentWorking({ org: ORG, itemId: OTHER })
    t.start.agentWorking({ org: 'fabrikam', itemId: STORY })
    assert.equal(t.start.state(), before)
    assert.equal(t.counter.changes, changes)
    assert.equal(t.timeouts.size, 1)
  })
})

test('dispose stops the late timer and drops answers still on their way', async () => {
  await withFakeDom(async () => {
    const t = setup()
    await t.ready()
    void t.start.startWork()
    t.works[0].resolve(SENT)
    await settle()
    assert.equal(t.timeouts.size, 1)
    t.start.dispose()
    assert.equal(t.timeouts.size, 0)

    const pending = setup()
    await pending.ready()
    void pending.start.startWork()
    pending.start.dispose()
    const changes = pending.counter.changes
    pending.works[0].resolve(SENT)
    pending.repoLists[0].resolve(NONE)
    await settle()
    pending.start.workspaceReady({ org: ORG, itemId: STORY, workspaceId: CREATING.id, branch: BRANCH })
    assert.equal(pending.timeouts.size, 0, 'an answer after dispose starts no timer')
    assert.equal(pending.counter.changes, changes)
    assert.equal(pending.targetLists.length, 0)

    const listing = setup()
    await listing.offered(NONE)
    listing.start.dispose()
    const before = listing.counter.changes
    listing.targetLists[0].resolve(TARGETS)
    await settle()
    assert.equal(listing.counter.changes, before, 'a list read after dispose changes nothing')
  })
})
