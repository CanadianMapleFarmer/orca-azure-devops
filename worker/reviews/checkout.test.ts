import { assert, test } from 'orca/testing'
import type { ReviewKey } from '../../src/shared/reviews'
import type { RawPullRequest } from '../ado/pullrequests'
import { fixture, ORG, PROJECT, REPO } from '../boards/fake-ado'
import type { ArmedBranch } from '../workspace/arm'
import type { HostCall, WorkspaceEntry } from '../workspace/focused'
import type { AdoRemote } from '../workspace/remotes'
import { checkoutPr, type CheckoutDeps } from './checkout'

const KEY: ReviewKey = { org: ORG, projectId: PROJECT, repoId: REPO, prId: 4110 }
const SOURCE = 'hotfix/1211-login-redirect'
const UNTIL = Date.parse('2026-11-06T10:10:00Z')
const WEB: AdoRemote = { remote: 'origin', org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const API: AdoRemote = { ...WEB, repo: 'api' }
const CLOSED = 'This pull request is no longer active.'
const FORK = "This pull request comes from a fork. Check it out from the fork's repository instead."
const NO_WORKSPACE = 'Open a local workspace of web-app first.'
const FOLDER_ONLY =
  "This repository is open in Orca only as a folder, which can't create worktrees. Open it as a git project in Orca, then press Check out in Orca again."
const ANY_PROJECT = 'Create it before any other new workspace: the next one, in any project, gets this branch.'
const UNREAD = "Couldn't read the git remotes of a local workspace."

function armedText(base: string): string {
  return (
    `Now create a new workspace in Orca from the web-app project. It will check out ${SOURCE} from ${base} (or ${SOURCE}-2 if that name is taken), ` +
    `the source of Pull Request 4110. To review it, set Source Control's compare base to main. ${ANY_PROJECT}`
  )
}

function workspace(id: string, over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: `/repos/${id}`, branch: 'main', hostId: null, ...over }
}

interface Desk {
  workspaces: WorkspaceEntry[]
  focused?: WorkspaceEntry
  remotes?: Record<string, AdoRemote[] | Error>
  pr?: (raw: RawPullRequest) => RawPullRequest
  openFails?: Error
}

function desk({ workspaces, focused, remotes = {}, pr = raw => raw, openFails }: Desk) {
  const steps: string[] = []
  const opened: unknown[] = []
  const read: string[] = []
  const armed: ArmedBranch[] = []
  const logs: string[] = []
  const call: HostCall = async (method, params) => {
    steps.push(method)
    if (method === 'workspace.list') return { workspaces, truncated: false }
    if (method === 'workspace.readContext') return focused ? { branch: focused.branch ?? '', displayName: focused.name, terminals: [] } : null
    if (method !== 'workspace.open') throw new Error(`unexpected host call ${method}`)
    if (openFails) throw openFails
    opened.push(params)
    return { opened: true }
  }
  const deps: CheckoutDeps = {
    call,
    remotes: async path => {
      read.push(path)
      const known = remotes[path] ?? []
      if (known instanceof Error) throw known
      return known
    },
    arm: {
      arm: value => {
        armed.push(value)
        return UNTIL
      }
    },
    pullRequest: async key => {
      steps.push(`pullRequest ${key.org}/${key.prId}`)
      return pr(fixture<RawPullRequest>('pull-request-4110'))
    },
    log: message => void logs.push(message)
  }
  return { deps, steps, opened, read, armed, logs }
}

test('checkout opens a workspace that is already on the source branch', async () => {
  const web = workspace('web-app')
  const api = workspace('api', { branch: SOURCE })
  const remote = workspace('web-app-remote', { branch: SOURCE, hostId: 'ssh:build-box' })
  const review = workspace('web-app-review', { branch: SOURCE })
  const d = desk({
    workspaces: [api, remote, web, review],
    focused: web,
    remotes: { [api.path]: [API], [remote.path]: [WEB], [web.path]: [WEB], [review.path]: [WEB] }
  })
  assert.deepEqual(await checkoutPr(d.deps, KEY), { status: 'opened', message: `Opened web-app-review. It's already on ${SOURCE}.` })
  assert.deepEqual(d.opened, [{ workspaceId: 'web-app-review' }])
  assert.deepEqual(d.armed, [])
  assert.equal(d.steps[0], 'pullRequest contoso/4110', 'the pull request is read fresh first')
  assert.ok(!d.read.includes(remote.path), "a workspace on another host isn't a candidate")

  const named = workspace('web-app-review', { branch: `refs/heads/${SOURCE}` })
  const full = desk({ workspaces: [web, named], focused: web, remotes: { [web.path]: [WEB], [named.path]: [WEB] } })
  assert.equal((await checkoutPr(full.deps, KEY)).status, 'opened', 'a full ref names the same branch')
  assert.deepEqual(full.opened, [{ workspaceId: 'web-app-review' }])
})

test("checkout arms the next worktree from the remote branch and opens the repository's workspace", async () => {
  const notes = workspace('notes', { kind: 'folder', branch: null })
  const api = workspace('api')
  const web = workspace('web-app', { branch: 'feature/1204-search' })
  const d = desk({ workspaces: [notes, api, web], focused: api, remotes: { [api.path]: [API], [web.path]: [WEB] } })
  assert.deepEqual(await checkoutPr(d.deps, KEY), { status: 'armed', message: armedText(`origin/${SOURCE}`), armedUntil: UNTIL })
  assert.deepEqual(d.armed, [{ org: 'contoso', branch: SOURCE, base: `origin/${SOURCE}`, prId: 4110 }])
  assert.deepEqual(d.opened, [{ workspaceId: 'web-app' }])

  const fork: AdoRemote = { ...WEB, repo: 'web-app-ada' }
  const upstream = desk({ workspaces: [web], remotes: { [web.path]: [fork, { ...WEB, remote: 'upstream' }] } })
  assert.deepEqual(await checkoutPr(upstream.deps, KEY), { status: 'armed', message: armedText(`upstream/${SOURCE}`), armedUntil: UNTIL })
  assert.deepEqual(upstream.armed, [{ org: 'contoso', branch: SOURCE, base: `upstream/${SOURCE}`, prId: 4110 }])

  const second = workspace('web-app-2', { branch: 'feature/1205-paging' })
  const focusedDesk = desk({ workspaces: [web, second], focused: second, remotes: { [web.path]: [WEB], [second.path]: [WEB] } })
  assert.equal((await checkoutPr(focusedDesk.deps, KEY)).status, 'armed')
  assert.equal(focusedDesk.armed.length, 1)
  assert.deepEqual(focusedDesk.opened, [], 'nothing is opened when the candidate is focused')

  const folder = workspace('web-app-folder', { kind: 'folder', branch: null })
  const ranked = desk({ workspaces: [folder, web], focused: folder, remotes: { [folder.path]: [WEB], [web.path]: [WEB] } })
  assert.equal((await checkoutPr(ranked.deps, KEY)).status, 'armed')
  assert.deepEqual(ranked.opened, [{ workspaceId: 'web-app' }], 'a git worktree ranks above a focused folder, which cannot create worktrees')
})

test('checkout refuses a closed PR, a fork and a repository with no local workspace', async () => {
  const web = workspace('web-app')
  const remotes = { [web.path]: [WEB] }
  for (const status of ['completed', 'abandoned']) {
    const closed = desk({ workspaces: [web], focused: web, remotes, pr: raw => ({ ...raw, status }) })
    assert.deepEqual(await checkoutPr(closed.deps, KEY), { status: 'refused', message: CLOSED })
    assert.deepEqual([closed.steps, closed.armed, closed.read], [['pullRequest contoso/4110'], [], []], status)
  }

  const forkSource = { name: `refs/heads/${SOURCE}`, repository: { id: 'f0f0f0f0-0000-4000-8000-000000000000', name: 'web-app' } }
  const forked = desk({ workspaces: [web], focused: web, remotes, pr: raw => ({ ...raw, forkSource }) })
  assert.deepEqual(await checkoutPr(forked.deps, KEY), { status: 'refused', message: FORK })
  assert.deepEqual([forked.steps, forked.armed, forked.read], [['pullRequest contoso/4110'], [], []])

  const remote = workspace('web-app', { hostId: 'ssh:build-box' })
  const api = workspace('api')
  const elsewhere = desk({ workspaces: [remote, api], focused: api, remotes: { [remote.path]: [WEB], [api.path]: [API] } })
  assert.deepEqual(await checkoutPr(elsewhere.deps, KEY), { status: 'refused', message: NO_WORKSPACE })
  assert.deepEqual([elsewhere.opened, elsewhere.armed], [[], []])

  const none = desk({ workspaces: [] })
  assert.deepEqual(await checkoutPr(none.deps, KEY), { status: 'refused', message: NO_WORKSPACE })
  assert.deepEqual([none.opened, none.armed], [[], []])
})

test('checkout refuses a repository that is open only as a folder, which cannot create worktrees', async () => {
  const folder = workspace('web-app', { kind: 'folder', branch: null })
  const d = desk({ workspaces: [folder], focused: folder, remotes: { [folder.path]: [WEB] } })
  assert.deepEqual(await checkoutPr(d.deps, KEY), { status: 'refused', message: FOLDER_ONLY })
  assert.deepEqual([d.opened, d.armed], [[], []])
})

test("a workspace whose git remotes can't be read is skipped with a fixed log line", async () => {
  const broken = workspace('broken')
  const web = workspace('web-app')
  const d = desk({ workspaces: [broken, web], remotes: { [broken.path]: new Error('git timed out after 5000ms'), [web.path]: [WEB] } })
  assert.equal((await checkoutPr(d.deps, KEY)).status, 'armed')
  assert.deepEqual(d.opened, [{ workspaceId: 'web-app' }])
  assert.deepEqual(d.logs, [UNREAD])
})

test('a workspace that fails to open leaves nothing armed and reaches the panel', async () => {
  const web = workspace('web-app', { branch: 'feature/1204-search' })
  const gone = new Error('That workspace is no longer in Orca.')
  const d = desk({ workspaces: [web], remotes: { [web.path]: [WEB] }, openFails: gone })
  await assert.rejects(checkoutPr(d.deps, KEY), gone)
  assert.deepEqual([d.opened, d.armed], [[], []])

  const onBranch = desk({ workspaces: [{ ...web, branch: SOURCE }], remotes: { [web.path]: [WEB] }, openFails: gone })
  await assert.rejects(checkoutPr(onBranch.deps, KEY), gone)
  assert.deepEqual([onBranch.opened, onBranch.armed], [[], []])
})

test('a failed pull request read reaches the panel and touches nothing', async () => {
  const web = workspace('web-app')
  const d = desk({ workspaces: [web], remotes: { [web.path]: [WEB] } })
  const gone = new Error("That pull request no longer exists, or you can't see it.")
  await assert.rejects(checkoutPr({ ...d.deps, pullRequest: async () => Promise.reject(gone) }, KEY), gone)
  assert.deepEqual([d.steps, d.armed], [[], []])
})
