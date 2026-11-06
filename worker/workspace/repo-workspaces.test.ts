import { assert, test } from 'orca/testing'
import type { WorkspaceEntry } from './focused'
import type { AdoRemote } from './remotes'
import { workspacesOfRepo } from './repo-workspaces'

const TARGET = { org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const WEB: AdoRemote = { remote: 'origin', org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const API: AdoRemote = { ...WEB, repo: 'api' }
const UNREAD = "Couldn't read the git remotes of a local workspace."

function workspace(id: string): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: `/repos/${id}`, branch: 'main', hostId: null }
}

test('workspacesOfRepo pairs each matching workspace with its matching remote, in listing order', async () => {
  const [first, second, other, none] = ['first', 'second', 'other', 'none'].map(workspace)
  const upstream = { ...WEB, remote: 'upstream' }
  const remotes: Record<string, AdoRemote[]> = {
    [first.path]: [WEB],
    [second.path]: [{ ...WEB, repo: 'web-app-ada' }, upstream],
    [other.path]: [API]
  }
  const found = await workspacesOfRepo({ remotes: async path => remotes[path] ?? [], log: () => assert.fail('nothing failed') }, [first, other, none, second], TARGET)
  assert.deepEqual(found, [
    { workspace: first, remote: WEB },
    { workspace: second, remote: upstream }
  ])
  assert.deepEqual(await workspacesOfRepo({ remotes: async () => [WEB], log: () => assert.fail('nothing failed') }, [], TARGET), [])
})

test("workspacesOfRepo skips a workspace whose remotes can't be read and logs one fixed line for it", async () => {
  const broken = workspace('broken')
  const web = workspace('web-app')
  const logs: string[] = []
  const deps = {
    remotes: async (path: string) => {
      if (path === broken.path) throw new Error(`git timed out at ${path} with token-abc`)
      return [WEB]
    },
    log: (message: string) => void logs.push(message)
  }
  assert.deepEqual(await workspacesOfRepo(deps, [broken, web], TARGET), [{ workspace: web, remote: WEB }])
  assert.deepEqual(logs, [UNREAD])
})

test('workspacesOfRepo reads at most four workspaces at a time', async () => {
  const many = Array.from({ length: 9 }, (_, index) => workspace(`w${index}`))
  let running = 0
  let peak = 0
  const remotes = async () => {
    peak = Math.max(peak, ++running)
    await new Promise<void>(resolve => setImmediate(resolve))
    running--
    return [WEB]
  }
  assert.equal((await workspacesOfRepo({ remotes, log: () => assert.fail('nothing failed') }, many, TARGET)).length, 9)
  assert.equal(peak, 4)
})
