import { assert, test } from 'orca/testing'
import { focusedWorkspace, isLocalWorkspace, type HostCall, type WorkspaceEntry } from './focused'

const WEB: WorkspaceEntry = { id: 'ws-web', kind: 'worktree', name: 'web-app', path: '/repos/web-app', branch: 'feature/1204-search', hostId: null }
const NOTES: WorkspaceEntry = { id: 'ws-notes', kind: 'folder', name: 'notes', path: '/repos/notes', branch: null, hostId: null }

function host(context: { branch: string; displayName: string } | null, entries: WorkspaceEntry[]) {
  const methods: string[] = []
  const call: HostCall = async method => {
    methods.push(method)
    if (method === 'workspace.readContext') return context
    if (method === 'workspace.list') return { workspaces: entries, truncated: false }
    throw new Error(`unexpected host call ${method}`)
  }
  return { call, methods }
}

test('focusedWorkspace matches a worktree by name and branch and a folder by name alone', async () => {
  const worktree = host({ branch: 'feature/1204-search', displayName: 'web-app' }, [WEB, NOTES])
  assert.equal((await focusedWorkspace(worktree.call))?.id, 'ws-web')
  const folder = host({ branch: 'main', displayName: 'notes' }, [WEB, NOTES])
  assert.equal((await focusedWorkspace(folder.call))?.id, 'ws-notes')
  const otherBranch = host({ branch: 'main', displayName: 'web-app' }, [WEB, NOTES])
  assert.equal(await focusedWorkspace(otherBranch.call), null)
})

test('focusedWorkspace is null without a focused workspace, and then lists nothing', async () => {
  const none = host(null, [WEB])
  assert.equal(await focusedWorkspace(none.call), null)
  assert.deepEqual(none.methods, ['workspace.readContext'])
})

test('focusedWorkspace is null when two workspaces match', async () => {
  const twins = host({ branch: 'feature/1204-search', displayName: 'web-app' }, [WEB, { ...WEB, id: 'ws-twin' }])
  assert.equal(await focusedWorkspace(twins.call), null)
})

test('focusedWorkspace uses workspaces already listed instead of listing again', async () => {
  const listed = host({ branch: 'feature/1204-search', displayName: 'web-app' }, [])
  assert.equal((await focusedWorkspace(listed.call, [WEB]))?.id, 'ws-web')
  assert.deepEqual(listed.methods, ['workspace.readContext'])
})

test('isLocalWorkspace counts no host and Orca\'s "local" host as local, and an SSH host as remote', () => {
  assert.equal(isLocalWorkspace(WEB), true)
  assert.equal(isLocalWorkspace({ ...WEB, hostId: 'local' }), true)
  for (const hostId of ['ssh-1', 'ssh:build-box']) assert.equal(isLocalWorkspace({ ...WEB, hostId }), false, hostId)
})
