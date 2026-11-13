import { assert, test } from 'orca/testing'
import {
  changeRepo,
  chooseCloneRepo,
  chooseProject,
  chooseRepo,
  CLONE_LATE_MS,
  CLONE_VALUE,
  cloneNote,
  cloneRepoOptions,
  LATE_MS,
  lateNotice,
  pickerOf,
  pickOf,
  projectOptions,
  readyNotice,
  REPO_LABELS,
  repoOptions,
  repoSummary,
  SETUP_SKIPPED,
  SHORTENED,
  shownText,
  START_LABELS,
  startAgentOutcome,
  startWorkOutcome,
  withTargets,
  workingNotice
} from './start-flow'
import type { CloneTargets, StartRepo, StartRepos } from './work'

const BRANCH = 'feature/101-sign-in'
const WEB = { id: 'ws-web', name: 'web' }
test('a sent start says what is being created and waits for the agent', () => {
  assert.deepEqual(startWorkOutcome({ status: 'sent', branch: BRANCH, repo: 'web', agent: 'claude', workspace: WEB, shortened: true, clone: null }), {
    kind: 'notice',
    notice: { tone: 'accent', text: `Creating ${BRANCH} in web. Orca opens it when it's ready.` },
    shortened: true,
    setupSkipped: false,
    waitFor: { agent: 'claude', workspace: WEB, awaited: `${BRANCH} didn't appear`, lateMs: LATE_MS },
    linked: null
  })
  assert.deepEqual(startAgentOutcome({ status: 'sent', agent: 'claude', workspace: WEB, shortened: false }), {
    kind: 'notice',
    notice: { tone: 'success', text: 'claude is starting in web.' },
    shortened: false,
    setupSkipped: false,
    waitFor: { agent: 'claude', workspace: WEB, awaited: "claude didn't start", lateMs: LATE_MS },
    linked: null
  })
  assert.deepEqual(readyNotice(BRANCH, 'claude'), { tone: 'success', text: `${BRANCH} is open, and claude is starting with the item's details.` })
  assert.deepEqual(workingNotice('claude'), { tone: 'success', text: 'claude is working on it.' })
  assert.equal(
    SHORTENED,
    'The description is too long to give the agent, so it got the title and link only. With "Add work item context to agent prompts" on, later prompts in this workspace start with the link too.'
  )
})

test('a linked workspace says so and links it', () => {
  assert.deepEqual(startWorkOutcome({ status: 'linked', branch: BRANCH, workspace: WEB }), {
    kind: 'notice',
    notice: { tone: 'success', text: `web is already on ${BRANCH}, so it's now this item's workspace.` },
    shortened: false,
    setupSkipped: false,
    waitFor: null,
    linked: WEB
  })
})

test('a refused start shows its own message and tone', () => {
  const refusal = (tone: 'warning' | 'danger', text: string) => ({ kind: 'notice', notice: { tone, text }, shortened: false, setupSkipped: false, waitFor: null, linked: null })
  assert.deepEqual(startWorkOutcome({ status: 'refused', tone: 'warning', message: 'Orca has no agent to start.' }), refusal('warning', 'Orca has no agent to start.'))
  assert.deepEqual(startAgentOutcome({ status: 'refused', tone: 'danger', message: 'The workspace is gone.' }), refusal('danger', 'The workspace is gone.'))
})

test('the late notice names the terminal and offers Show it', () => {
  assert.equal(LATE_MS, 60_000)
  assert.deepEqual(lateNotice(101, { agent: 'claude', workspace: WEB, awaited: `${BRANCH} didn't appear`, lateMs: LATE_MS }), {
    tone: 'neutral',
    text: `Sent to Orca. If ${BRANCH} didn't appear, the terminal "ADO #101" in web shows why.`,
    show: WEB
  })
})

const CLONE = { folder: '~/orca/repos/web-app', fresh: true, setupSkipped: true }

test("a sent clone says it is cloning, offers Show it at once, warns only after 10 minutes, and says setup didn't run", () => {
  assert.equal(CLONE_LATE_MS, 600_000)
  assert.deepEqual(startWorkOutcome({ status: 'sent', branch: BRANCH, repo: 'web-app', agent: 'claude', workspace: WEB, shortened: false, clone: CLONE }), {
    kind: 'notice',
    notice: { tone: 'accent', text: `Cloning web-app into ~/orca/repos/web-app, then creating ${BRANCH}. Orca opens it when it's ready.`, show: WEB },
    shortened: false,
    setupSkipped: true,
    waitFor: { agent: 'claude', workspace: WEB, awaited: `${BRANCH} didn't appear`, lateMs: CLONE_LATE_MS },
    linked: null
  })
  assert.equal(
    SETUP_SKIPPED,
    "This repository's setup didn't run, because the plugin just added it to Orca. Look the repository over, then run its setup steps yourself in the workspace's terminal. Later workspaces in this repository run setup as usual."
  )
  const policy = startWorkOutcome({ status: 'sent', branch: BRANCH, repo: 'web-app', agent: 'claude', workspace: WEB, shortened: false, clone: { ...CLONE, setupSkipped: false } })
  assert.equal(policy.kind === 'notice' && policy.setupSkipped, false)
  const hidden = startWorkOutcome({ status: 'sent', branch: BRANCH, repo: 'web\u202Eapp', agent: 'claude', workspace: WEB, shortened: false, clone: { ...CLONE, folder: '~/orca/repos/web\u202Eapp' } })
  assert.equal(hidden.kind === 'notice' && hidden.notice.text, `Cloning webapp into ~/orca/repos/webapp, then creating ${BRANCH}. Orca opens it when it's ready.`)
})

test('an added folder says so', () => {
  const outcome = startWorkOutcome({ status: 'sent', branch: BRANCH, repo: 'web-app', agent: 'claude', workspace: WEB, shortened: true, clone: { ...CLONE, fresh: false } })
  assert.deepEqual(outcome, {
    kind: 'notice',
    notice: { tone: 'accent', text: `Adding ~/orca/repos/web-app to Orca, then creating ${BRANCH}. Orca opens it when it's ready.`, show: WEB },
    shortened: true,
    setupSkipped: true,
    waitFor: { agent: 'claude', workspace: WEB, awaited: `${BRANCH} didn't appear`, lateMs: CLONE_LATE_MS },
    linked: null
  })
})

test('the sidebar and the board label the start controls alike', () => {
  assert.deepEqual(START_LABELS, {
    work: 'Start a workspace and agent',
    agent: 'Start an agent',
    workspace: 'Open workspace',
    show: 'Show it'
  })
})

const WEB_APP = 'contoso/fabrikam web/web-app'
const TOOLS = 'contoso/tools/tools'
const ROWS: StartRepo[] = [
  { key: WEB_APP, name: 'web-app', detail: 'Fabrikam Web', source: 'pr' },
  { key: 'contoso/fabrikam api/api', name: 'api', detail: 'Fabrikam API', source: 'last' },
  { key: TOOLS, name: 'tools', detail: 'Tools', source: 'org' },
  { key: 'git:github.com/fabrikam/notes', name: 'notes', detail: 'github.com', source: 'other' }
]
const NO_GIT = "Git wasn't found, so the plugin can't clone. Install Git, then try again."
const UNLISTED = "Azure DevOps didn't list this organisation's repositories."
const TARGETS: CloneTargets = {
  projects: [
    { id: 'p-web', name: 'Fabrikam Web', repos: [{ id: 'r-web', name: 'web-app' }, { id: 'r-api', name: 'api' }] },
    { id: 'p-planning', name: 'Planning', repos: [] },
    { id: 'p-tools', name: 'Tools', repos: [{ id: 'r-tools', name: 'tools' }] }
  ],
  readAt: 1_000,
  more: 0
}

const reposOf = (over: Partial<StartRepos> = {}): StartRepos => ({ repos: ROWS, selected: null, clone: { folder: '~/orca/repos' }, ...over })
const cloning = (repos: StartRepos = reposOf()) => chooseRepo(pickerOf(repos), CLONE_VALUE)
const listed = (targets: CloneTargets = TARGETS) => withTargets(cloning(), targets)

test('choose-repo opens the picker on the list with its message', () => {
  const gone = "That repository isn't in Orca any more. Choose another."
  assert.deepEqual(startWorkOutcome({ status: 'choose-repo', repos: reposOf(), message: gone }), { kind: 'choose', picker: { mode: 'list', repos: reposOf(), key: null }, message: gone })
  const selected = reposOf({ selected: WEB_APP })
  assert.deepEqual(startWorkOutcome({ status: 'choose-repo', repos: selected, message: null }), { kind: 'choose', picker: { mode: 'list', repos: selected, key: WEB_APP }, message: null })
  const empty = reposOf({ repos: [] })
  assert.deepEqual(startWorkOutcome({ status: 'choose-repo', repos: empty, message: null }), {
    kind: 'choose',
    picker: { mode: 'clone', repos: empty, targets: 'loading', projectId: null, repoId: null },
    message: null
  })
})

test('pickerOf shows a selected repo as known, no selection as a list, and no repos as clone', () => {
  const selected = reposOf({ selected: WEB_APP })
  assert.deepEqual(pickerOf(selected), { mode: 'known', repos: selected, key: WEB_APP })
  assert.deepEqual(pickerOf(reposOf()), { mode: 'list', repos: reposOf(), key: null })
  assert.deepEqual(pickerOf(reposOf({ selected: 'contoso/tools/api' })), { mode: 'list', repos: reposOf({ selected: 'contoso/tools/api' }), key: null })
  const empty = reposOf({ repos: [] })
  assert.deepEqual(pickerOf(empty), { mode: 'clone', repos: empty, targets: 'loading', projectId: null, repoId: null })
})

test('repoOptions labels each row with its detail and hint, and ends with Clone', () => {
  const options = repoOptions(reposOf())
  assert.deepEqual(
    options.map(option => option.label),
    ['web-app · Fabrikam Web (linked pull request)', 'api · Fabrikam API (last used)', 'tools · Tools', 'notes · github.com', 'Clone from Azure DevOps…']
  )
  assert.deepEqual(
    options.map(option => option.value),
    [WEB_APP, 'contoso/fabrikam api/api', TOOLS, 'git:github.com/fabrikam/notes', CLONE_VALUE]
  )
})

test('labels drop format and control characters', () => {
  assert.equal(shownText('a\u200Bb\nc\u202Ed\u009Fe\u00ADf\u2066g'), 'abcdefg')
  const hostile: StartRepo = { key: 'contoso/fabrikam/web-app', name: 'web\u202E-app\u200B', detail: 'Fab\u0007rikam', source: 'org' }
  assert.equal(repoOptions(reposOf({ repos: [hostile] }))[0]?.label, 'web-app · Fabrikam')
  assert.equal(repoSummary({ mode: 'known', repos: reposOf({ repos: [hostile] }), key: hostile.key }), 'web-app · Fabrikam')
  const picker = chooseCloneRepo(chooseProject(listed({ ...TARGETS, projects: [{ id: 'p', name: 'Fab\u0007rikam', repos: [{ id: 'r', name: 'web\u202E-app\u200B' }] }] }), 'p'), 'r')
  assert.deepEqual(projectOptions(picker), [{ value: 'p', label: 'Fabrikam' }])
  assert.deepEqual(cloneRepoOptions(picker), [{ value: 'r', label: 'web-app' }])
  assert.equal(cloneNote(picker), 'Clones into ~/orca/repos/web-app')
})

test('repoSummary shows the known repo as its row', () => {
  assert.equal(repoSummary({ mode: 'known', repos: reposOf({ selected: WEB_APP }), key: WEB_APP }), 'web-app · Fabrikam Web (linked pull request)')
})

test('changeRepo opens the list on the current repo; chooseRepo with CLONE_VALUE switches to clone and loads', () => {
  const repos = reposOf({ selected: WEB_APP })
  const list = changeRepo(pickerOf(repos))
  assert.deepEqual(list, { mode: 'list', repos, key: WEB_APP })
  assert.equal(changeRepo(list), list)
  assert.deepEqual(chooseRepo(list, TOOLS), { mode: 'list', repos, key: TOOLS })
  assert.equal(chooseRepo(list, 'contoso/tools/api'), list)
  const clone = chooseRepo(list, CLONE_VALUE)
  assert.deepEqual(clone, { mode: 'clone', repos, targets: 'loading', projectId: null, repoId: null })
  assert.deepEqual(chooseRepo(clone, TOOLS), { mode: 'list', repos, key: TOOLS })
  const chosen = chooseCloneRepo(chooseProject(withTargets(clone, TARGETS), 'p-web'), 'r-api')
  assert.equal(chooseRepo(chosen, CLONE_VALUE), chosen)
})

test('withTargets selects nothing, even when the item has linked pull requests', () => {
  const clone = cloning(reposOf({ selected: WEB_APP }))
  assert.deepEqual(withTargets(clone, TARGETS), { mode: 'clone', repos: reposOf({ selected: WEB_APP }), targets: TARGETS, projectId: null, repoId: null })
  assert.deepEqual(withTargets(clone, { error: UNLISTED }), { mode: 'clone', repos: reposOf({ selected: WEB_APP }), targets: { error: UNLISTED }, projectId: null, repoId: null })
  const list = pickerOf(reposOf())
  assert.equal(withTargets(list, TARGETS), list)
  const chosen = chooseCloneRepo(chooseProject(listed(), 'p-web'), 'r-api')
  assert.equal(withTargets(chosen, TARGETS), chosen)
})

test("chooseProject clears the repository, even when it is the project's only one", () => {
  const web = chooseCloneRepo(chooseProject(listed(), 'p-web'), 'r-api')
  assert.deepEqual(web, { mode: 'clone', repos: reposOf(), targets: TARGETS, projectId: 'p-web', repoId: 'r-api' })
  assert.deepEqual(chooseProject(web, 'p-tools'), { ...web, projectId: 'p-tools', repoId: null })
  assert.deepEqual(chooseCloneRepo(chooseProject(web, 'p-tools'), 'r-tools'), { ...web, projectId: 'p-tools', repoId: 'r-tools' })
  assert.deepEqual(chooseProject(web, 'p-planning'), { ...web, projectId: 'p-planning', repoId: null })
  assert.deepEqual(chooseProject(chooseProject(listed(), 'p-tools'), 'p-web'), { ...web, projectId: 'p-web', repoId: null })
  assert.equal(chooseProject(web, 'p-gone'), web)
  assert.equal(chooseCloneRepo(web, 'r-tools'), web)
  const loading = cloning()
  assert.equal(chooseProject(loading, 'p-web'), loading)
  assert.deepEqual(projectOptions(web), [
    { value: 'p-web', label: 'Fabrikam Web' },
    { value: 'p-planning', label: 'Planning' },
    { value: 'p-tools', label: 'Tools' }
  ])
  assert.deepEqual(cloneRepoOptions(web), [
    { value: 'r-web', label: 'web-app' },
    { value: 'r-api', label: 'api' }
  ])
  assert.deepEqual([projectOptions(cloning()), cloneRepoOptions(listed()), projectOptions(pickerOf(reposOf()))], [[], [], []])
})

test('pickOf answers an orca pick, a clone pick, or null until the choice is complete', () => {
  assert.deepEqual(pickOf(pickerOf(reposOf({ selected: WEB_APP }))), { kind: 'orca', key: WEB_APP })
  assert.equal(pickOf(pickerOf(reposOf())), null)
  assert.deepEqual(pickOf(chooseRepo(pickerOf(reposOf()), TOOLS)), { kind: 'orca', key: TOOLS })
  assert.equal(pickOf(cloning()), null)
  assert.equal(pickOf(listed()), null)
  assert.equal(pickOf(chooseProject(listed(), 'p-web')), null)
  assert.deepEqual(pickOf(chooseCloneRepo(chooseProject(listed(), 'p-web'), 'r-api')), { kind: 'clone', projectId: 'p-web', repoId: 'r-api' })
  assert.deepEqual(pickOf(chooseCloneRepo(chooseProject(listed(), 'p-tools'), 'r-tools')), { kind: 'clone', projectId: 'p-tools', repoId: 'r-tools' })
})

test("no clone pick exists until the user chooses the repository, even a project's only one", () => {
  const tools = chooseProject(listed(), 'p-tools')
  assert.equal(pickOf(tools), null)
  assert.equal(cloneNote(tools), null)
  assert.deepEqual(cloneRepoOptions(tools), [{ value: 'r-tools', label: 'tools' }])
  const chosen = chooseCloneRepo(tools, 'r-tools')
  assert.deepEqual(pickOf(chosen), { kind: 'clone', projectId: 'p-tools', repoId: 'r-tools' })
  assert.equal(cloneNote(chosen), 'Clones into ~/orca/repos/tools')
})

test('Clone is always listed, and pickOf stays null in clone mode while clone has a problem', () => {
  const clone = { value: CLONE_VALUE, label: 'Clone from Azure DevOps…' }
  assert.deepEqual(repoOptions(reposOf({ repos: [] })), [clone])
  assert.deepEqual(repoOptions(reposOf({ repos: [], clone: { problem: NO_GIT } })), [clone])
  assert.deepEqual(repoOptions(reposOf({ clone: { problem: NO_GIT } })).at(-1), clone)
  const blocked = reposOf({ clone: { problem: NO_GIT } })
  const unread = cloning(blocked)
  assert.deepEqual(unread, { mode: 'clone', repos: blocked, targets: { error: NO_GIT }, projectId: null, repoId: null })
  assert.equal(withTargets(unread, TARGETS), unread)
  const empty = reposOf({ repos: [], clone: { problem: NO_GIT } })
  assert.deepEqual(pickerOf(empty), { mode: 'clone', repos: empty, targets: { error: NO_GIT }, projectId: null, repoId: null })
  assert.equal(pickOf({ mode: 'clone', repos: blocked, targets: TARGETS, projectId: 'p-web', repoId: 'r-api' }), null)
})

test("cloneNote says where the clone goes, or the problem, or the empty project, or how many repositories aren't listed", () => {
  assert.equal(cloneNote(pickerOf(reposOf())), null)
  assert.equal(cloneNote(cloning()), null)
  assert.equal(cloneNote(listed()), null)
  assert.equal(cloneNote(chooseProject(listed(), 'p-web')), null)
  assert.equal(cloneNote(chooseCloneRepo(chooseProject(listed(), 'p-web'), 'r-web')), 'Clones into ~/orca/repos/web-app')
  assert.equal(cloneNote(cloning(reposOf({ clone: { problem: NO_GIT } }))), NO_GIT)
  assert.equal(cloneNote(withTargets(cloning(), { error: UNLISTED })), UNLISTED)
  assert.equal(cloneNote(chooseProject(listed(), 'p-planning')), 'This project has no repositories to clone.')
  const many = listed({ ...TARGETS, more: 12 })
  assert.equal(cloneNote(many), "12 more repositories aren't listed. Clone them yourself and add them to Orca.")
  assert.equal(cloneNote(listed({ ...TARGETS, more: 1 })), "1 more repository isn't listed. Clone it yourself and add it to Orca.")
  assert.equal(cloneNote(chooseCloneRepo(chooseProject(many, 'p-web'), 'r-web')), 'Clones into ~/orca/repos/web-app')
})

test('the sidebar and the board label the repo picker alike', () => {
  assert.deepEqual(REPO_LABELS, {
    repo: 'Repository',
    change: 'Change repo',
    choose: 'Choose a repository',
    clone: 'Clone from Azure DevOps…',
    project: 'Project',
    chooseProject: 'Choose a project',
    cloneRepo: 'Repository to clone',
    reading: 'Reading the repository list…',
    noRepos: 'No repositories are in Orca on this computer yet. Clone one from Azure DevOps.',
    emptyProject: 'This project has no repositories to clone.',
    hints: { pr: 'linked pull request', last: 'last used' }
  })
})
