import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, mockHost, test, type TestWorker } from 'orca/testing'
import type { OrgConfig, OrgStatus } from '../src/shared/types'
import { AdoError } from './ado/http'
import { basicAuth } from './auth/pat'
import { BOARDS, fakeAdo, isWiql, json as reply, ORG_URL, PROJECT, STORIES, TEAM, type FakeAdo } from './boards/fake-ado'
import * as worker from './main'
import { withWorker } from './test-support'

function running(pattern: string): boolean {
  return spawnSync('pgrep', ['-f', pattern]).status === 0
}

async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return condition()
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-home-'))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    await run(home)
  } finally {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

const PAT = 'pat-main-test-6e1f0b'
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const CAPABILITIES = ['storage:own', 'secrets:own', 'settings:own']
const ADA_DATA = { authenticatedUser: { id: 'u1', providerDisplayName: 'Ada Lovelace', properties: { Account: { $value: 'ada@contoso.com' } } } }

const PAT_ORG = {
  org: 'contoso',
  url: 'https://dev.azure.com/contoso',
  tenantId: TENANT,
  method: 'pat',
  pinned: null,
  boards: null,
  codeProjects: 'all'
} satisfies OrgConfig

const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' },
  { id: 'proj-infra', name: 'infra' }
]
const TEAMS: Record<string, { id: string; name: string }[]> = {
  'proj-boards': [{ id: 'team-ops', name: 'Ops' }, { id: 'team-alpha', name: 'Alpha' }],
  'proj-web': [{ id: 'team-web', name: 'Web Team' }]
}

const LISTED_BUT_DELETED = 'proj-infra'
const outage = { projects: false }

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname === 'vssps.dev.azure.com') return new Response(null, { headers: { 'x-vss-resourcetenant': TENANT } })
  if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
  if (url.pathname === '/contoso/_apis/connectionData') return json(ADA_DATA)
  if (url.pathname === '/contoso/_apis/projects') {
    return outage.projects ? new Response('', { status: 404 }) : json({ count: PROJECTS.length, value: PROJECTS })
  }
  const teams = /^\/contoso\/_apis\/projects\/([^/]+)\/teams$/.exec(url.pathname)
  if (teams) return teams[1] === LISTED_BUT_DELETED ? new Response('', { status: 404 }) : json({ value: TEAMS[teams[1]] ?? [] })
  return new Response('', { status: 404 })
}) as typeof fetch

async function withFakeFetch(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

function adoErrorWith(code: AdoError['code'], status: number, message: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError)
    assert.deepEqual({ code: error.code, status: error.status, message: error.message }, { code, status, message })
    return true
  }
}

function orgsChanged(posts: readonly { event: string; payload?: unknown }[]): OrgStatus[][] {
  return posts.filter(post => post.event === 'orgs.changed').map(post => (post.payload as { orgs: OrgStatus[] }).orgs)
}

test('ping answers with the plugin version', async () => {
  await withWorker(worker, {}, async w => {
    const out = await w.request('plugin.ping', {})
    assert.match(out.version, /^\d+\.\d+\.\d+$/)
    assert.equal(w.refusals.length, 0)
  })
})

test('activate shows the status bar item and the status command reports no orgs', async () => {
  await withWorker(worker, {}, async w => {
    assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
      id: 'status',
      text: 'ADO',
      tone: 'neutral',
      tooltip: 'Azure DevOps: not connected'
    })
    assert.equal(await w.command('status'), 'Not connected. Open the Azure DevOps panel to connect.')
    assert.deepEqual(await w.request('orgs.list', {}), [])
    assert.equal(w.refusals.length, 0)
  })
})

test('orgs handlers connect, sign out and remove an org', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
      const status = await w.request('orgs.connect', { orgInput: 'https://dev.azure.com/contoso', method: 'pat', pat: PAT })
      assert.equal(status.state, 'connected')
      assert.equal(status.account?.uniqueName, 'ada@contoso.com')
      assert.deepEqual(orgsChanged(w.posts).map(orgs => orgs[0].state), ['signing-in', 'connected'])
      assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
        id: 'status',
        text: 'ADO',
        tone: 'success',
        tooltip: 'Azure DevOps: contoso (ada@contoso.com)'
      })
      assert.equal(await w.command('status'), 'contoso — connected as ada@contoso.com')
      assert.equal((await w.request('orgs.list', {}))[0].state, 'connected')
      assert.equal(Object.keys(w.host.data().secrets).includes('pat:contoso'), true)

      const signedOut = await w.request('orgs.signOut', { org: 'contoso' })
      assert.equal(signedOut.state, 'disconnected')
      assert.equal(signedOut.account, null)
      assert.equal(Object.keys(w.host.data().secrets).includes('pat:contoso'), false)

      assert.deepEqual(await w.request('orgs.remove', { org: 'contoso' }), { ok: true })
      assert.deepEqual(await w.request('orgs.list', {}), [])
      assert.deepEqual(orgsChanged(w.posts).at(-1), [])
      assert.equal(w.refusals.length, 0)

      const seen = JSON.stringify([w.posts, w.logs, w.host.calls.filter(call => !call.method.startsWith('secrets.')), w.host.data().storage])
      assert.ok(!seen.includes(PAT) && !seen.includes(basicAuth(PAT).slice(6)), 'the PAT leaked outside orca.secrets')
    })
  })
})

test('a failed first connect posts orgs.connectFailed and leaves no org behind', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
      const status = await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: 'pat-nobody-knows' })
      assert.equal(status.state, 'error')
      assert.deepEqual(await w.request('orgs.list', {}), [])
      assert.deepEqual(orgsChanged(w.posts).at(-1), [])
      assert.deepEqual(w.posts.filter(post => post.event === 'orgs.connectFailed').map(post => post.payload), [
        { org: 'contoso', url: 'https://dev.azure.com/contoso', method: 'pat', message: 'Azure DevOps rejected the credentials.' }
      ])
      assert.deepEqual(w.host.data().storage.orgs, [])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('orgs.cancel stops a running az login, wrapper and all, and keeps none of its profile', async () => {
  const sleep = `sleep 30.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
  await withHome(async home => {
    const az = path.join(home, 'az')
    await fs.writeFile(az, `#!/bin/sh\n${sleep}\n`, { mode: 0o755 })
    try {
      await withFakeFetch(async () => {
        await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { azPath: az } }) }, async w => {
          const started = await w.request('orgs.connect', { orgInput: 'contoso', method: 'azure-cli' })
          assert.equal(started.state, 'signing-in')
          assert.ok(await until(() => running(sleep)), 'az login is running')

          const cancelled = await w.request('orgs.cancel', { org: 'contoso' })
          assert.equal(cancelled.state, 'disconnected')
          assert.equal(cancelled.message, 'Sign-in was cancelled.')
          assert.equal(running(sleep), false, 'nothing az started is left running')
          await assert.rejects(fs.stat(path.join(home, '.orca-azure-devops', 'az', 'contoso')), /ENOENT/)
          assert.equal(orgsChanged(w.posts).at(-1)?.[0].message, 'Sign-in was cancelled.')
          assert.equal(w.refusals.length, 0)
        })
      })
    } finally {
      spawnSync('pkill', ['-9', '-f', sleep])
    }
  })
})

test('deactivate stops a running az login, wrapper and all, within the 2 s budget', async () => {
  const sleep = `sleep 30.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
  await withHome(async home => {
    const az = path.join(home, 'az')
    await fs.writeFile(az, `#!/bin/sh\n${sleep}\n`, { mode: 0o755 })
    try {
      await withFakeFetch(async () => {
        await withWorker(worker, { host: mockHost({ capabilities: CAPABILITIES, settings: { azPath: az } }) }, async w => {
          await w.request('orgs.connect', { orgInput: 'contoso', method: 'azure-cli' })
          assert.ok(await until(() => running(sleep)), 'az login is running')

          const started = Date.now()
          await w.deactivate()
          assert.ok(Date.now() - started < 2_000, 'within the deactivate budget')
          assert.equal(running(sleep), false, 'nothing az started is left running')
        })
      })
    } finally {
      spawnSync('pkill', ['-9', '-f', sleep])
    }
  })
})

test('activate resets an org left signing-in by the previous worker', async () => {
  const host = mockHost({ capabilities: CAPABILITIES, storage: { orgs: [PAT_ORG], 'signing-in': ['contoso'] } })
  await withWorker(worker, { host }, async w => {
    const [status] = await w.request('orgs.list', {})
    assert.equal(status.state, 'disconnected')
    assert.equal(status.message, 'Sign-in was interrupted. Try again.')
    assert.deepEqual(host.data().storage['signing-in'], [])
    assert.deepEqual(w.host.callsOf('statusBar.update').at(-1), {
      id: 'status',
      text: 'ADO',
      tone: 'neutral',
      tooltip: 'Azure DevOps: contoso: Sign-in was interrupted. Try again.'
    })
    assert.equal(w.refusals.length, 0)
  })
})

function withConnected(run: (w: TestWorker) => Promise<void>): Promise<void> {
  return withWorker(worker, {}, async w => {
    await w.request('orgs.connect', { orgInput: 'contoso', method: 'pat', pat: PAT })
    await run(w)
  })
}

function storedOrg(w: TestWorker): OrgConfig {
  return (w.host.data().storage.orgs as OrgConfig[])[0]
}

test('ado.projects and ado.teams list sorted names through the connected org', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      assert.deepEqual(await w.request('ado.projects', { org: 'contoso' }), [
        { id: 'proj-boards', name: 'Boards' },
        { id: 'proj-infra', name: 'infra' },
        { id: 'proj-web', name: 'Web' }
      ])
      assert.deepEqual(await w.request('ado.teams', { org: 'contoso', projectId: 'proj-boards' }), [
        { id: 'team-alpha', name: 'Alpha' },
        { id: 'team-ops', name: 'Ops' }
      ])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('ado.projects refuses an org that is not connected', async () => {
  await withFakeFetch(async () => {
    await withWorker(worker, {}, async w => {
      await assert.rejects(w.request('ado.projects', { org: 'fabrikam' }), adoErrorWith('unauthorized', 401, 'Connect this organization first.'))
    })
  })
})

test('orgs.setBoards stores the project and team names and posts orgs.changed', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const status = await w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' })
      const boards = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
      assert.deepEqual(status.boards, boards)
      assert.deepEqual(storedOrg(w).boards, boards)
      assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].boards, boards)
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('orgs.setBoards refuses an unknown project or team and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const posts = w.posts.length
      const gone = adoErrorWith('bad_request', 400, 'That project or team no longer exists.')
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-gone', teamId: 'team-ops' }), gone)
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-web' }), gone)
      assert.equal(storedOrg(w).boards, null)
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setBoards reports a project or team deleted mid-call as no longer existing and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const posts = w.posts.length
      const gone = adoErrorWith('bad_request', 400, 'That project or team no longer exists.')
      await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: LISTED_BUT_DELETED, teamId: 'team-ops' }), gone)
      outage.projects = true
      try {
        await assert.rejects(w.request('orgs.setBoards', { org: 'contoso', projectId: 'proj-boards', teamId: 'team-ops' }), gone)
      } finally {
        outage.projects = false
      }
      assert.equal(storedOrg(w).boards, null)
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setCodeProjects stores all, or the named projects resolved by id', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const some = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web', 'proj-infra'] })
      const expected = [{ id: 'proj-web', name: 'Web' }, { id: 'proj-infra', name: 'infra' }]
      assert.deepEqual(some.codeProjects, expected)
      assert.deepEqual(storedOrg(w).codeProjects, expected)
      assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].codeProjects, expected)

      const all = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: 'all' })
      assert.equal(all.codeProjects, 'all')
      assert.equal(storedOrg(w).codeProjects, 'all')
      assert.deepEqual(orgsChanged(w.posts).at(-1)?.[0].codeProjects, 'all')
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('orgs.setCodeProjects refuses an unknown project id and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web'] })
      const posts = w.posts.length
      await assert.rejects(
        w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-infra', 'proj-gone'] }),
        adoErrorWith('bad_request', 400, 'One or more projects no longer exist.')
      )
      assert.deepEqual(storedOrg(w).codeProjects, [{ id: 'proj-web', name: 'Web' }])
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setCodeProjects refuses an empty list and saves nothing', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web'] })
      const posts = w.posts.length
      await assert.rejects(
        w.request('orgs.setCodeProjects', { org: 'contoso', projects: [] }),
        adoErrorWith('bad_request', 400, 'Pick at least one project, or choose all projects.')
      )
      assert.deepEqual(storedOrg(w).codeProjects, [{ id: 'proj-web', name: 'Web' }])
      assert.equal(w.posts.length, posts)
    })
  })
})

test('orgs.setCodeProjects stores each project once, in first-seen order', async () => {
  await withFakeFetch(async () => {
    await withConnected(async w => {
      const status = await w.request('orgs.setCodeProjects', { org: 'contoso', projects: ['proj-web', 'proj-infra', 'proj-web', 'proj-infra'] })
      const expected = [{ id: 'proj-web', name: 'Web' }, { id: 'proj-infra', name: 'infra' }]
      assert.deepEqual(status.codeProjects, expected)
      assert.deepEqual(storedOrg(w).codeProjects, expected)
    })
  })
})

const ADA = { adoId: 'u1', uniqueName: 'ada@contoso.com', displayName: 'Ada Lovelace', tenantId: TENANT, objectId: null }

function signedIn(ado: FakeAdo): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.headers.get('authorization') !== basicAuth(PAT)) return new Response('', { status: 401 })
    return ado.fetch(input, init)
  }) as typeof fetch
}

async function withFetch(fetch: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch
  globalThis.fetch = fetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

function boardsHost(boards: typeof BOARDS | null, results: Record<string, unknown> = {}) {
  return mockHost({
    capabilities: [...CAPABILITIES, 'workspace:read', 'workspace:write'],
    storage: { orgs: [{ ...PAT_ORG, pinned: ADA, boards }] },
    secrets: { 'pat:contoso': PAT },
    results
  })
}

function workChanged(posts: readonly { event: string; payload?: unknown }[]) {
  return posts.filter(post => post.event === 'work.changed').map(post => post.payload as { mine: { id: number }[] })
}

test('work handlers serve the connected org through the boards service', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      const snapshot = await w.request('work.snapshot', { org: 'contoso' })
      assert.deepEqual(snapshot.mine.map(item => item.id), [1204, 1205])
      assert.deepEqual(snapshot.other.map(item => item.id), [1207])
      assert.equal((await w.request('work.refresh', { org: 'contoso' })).board?.boardId, STORIES)
      assert.ok(workChanged(w.posts).length > 0)

      assert.deepEqual(await w.request('ui.visibility', { surface: 'work', org: 'contoso', visible: true }), { ok: true })
      assert.equal((await w.request('work.details', { org: 'contoso', id: 1204 })).item.id, 1204)
      assert.equal((await w.request('work.comment', { org: 'contoso', id: 1204, text: 'Ready' })).id, 77)
      const moved = await w.request('work.move', { org: 'contoso', id: 1204, rev: 9, to: { column: 'Resolved' } })
      assert.deepEqual([moved.column, moved.rev], ['Resolved', 10])
      const linked = await w.request('work.linkPr', { org: 'contoso', id: 1205, rev: 3, prUrl: `${ORG_URL}/Fabrikam%20Web/_git/web-app/pullrequest/322` })
      assert.deepEqual(linked.prs.map(chip => chip.prId), [322])
      const board = await w.request('work.board', { org: 'contoso', projectId: PROJECT, teamId: TEAM, everyone: false })
      assert.equal(board.board.boardId, STORIES)
      assert.deepEqual(await w.request('ui.visibility', { surface: 'board', org: 'contoso', visible: false }), { ok: true })
      assert.deepEqual(await w.request('work.dismissNudge', { org: 'contoso', itemId: 1204, prId: 321 }), { ok: true })
      assert.deepEqual(w.host.data().storage['nudgeDismissed:contoso'], ['1204:321'])
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('work.nudgeRules reads and saves the rules of the boards team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      assert.deepEqual(await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM }), { rules: [] })

      const rules = [{ branch: 'refs/heads/release/2026.11', column: 'Resolved' }]
      const saved = await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM, rules })
      assert.deepEqual(saved, { rules: [{ branch: 'release/2026.11', column: 'Resolved' }] })
      assert.deepEqual(w.host.data().storage[`nudgeRules:contoso:${TEAM}`], saved.rules)
      assert.deepEqual(await w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM }), saved)
      assert.ok(await until(() => workChanged(w.posts).length > 0), 'saving refreshed the snapshot')

      await assert.rejects(
        w.request('work.nudgeRules', { org: 'contoso', teamId: TEAM, rules: [{ branch: 'main', column: 'Shipped' }] }),
        adoErrorWith('bad_request', 400, "That column isn't on this board.")
      )
      assert.equal(w.refusals.length, 0)
    })
  })
})

test('work.snapshot tells an org without a boards team to pick one', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(null) }, async w => {
      const snapshot = await w.request('work.snapshot', { org: 'contoso' })
      assert.equal(snapshot.board, null)
      assert.equal(snapshot.message, "Pick a boards project and team in this org's settings.")
      assert.equal(ado.calls.length, 0)
    })
  })
})

test('org changes reach the boards service: setting a boards team starts polling "my work"', async () => {
  const ado = fakeAdo()
  ado.on(call => call.path === '/contoso/_apis/projects', () => reply(200, { value: [{ id: PROJECT, name: BOARDS.projectName }] }))
  ado.on(call => call.path === `/contoso/_apis/projects/${PROJECT}/teams`, () => reply(200, { value: [{ id: TEAM, name: BOARDS.teamName }] }))
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(null) }, async w => {
      await w.request('orgs.setBoards', { org: 'contoso', projectId: PROJECT, teamId: TEAM })
      assert.ok(await until(() => workChanged(w.posts).length > 0), 'the new job loaded and posted a snapshot')
      assert.deepEqual(workChanged(w.posts)[0].mine.map(item => item.id), [1204, 1205])
      assert.equal(ado.calls.filter(isWiql).length, 1)

      await w.request('orgs.signOut', { org: 'contoso' })
    })
  })
})

test('work.boards lists the boards of a team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    await withWorker(worker, { host: boardsHost(BOARDS) }, async w => {
      const boards = await w.request('work.boards', { org: 'contoso', projectId: PROJECT, teamId: TEAM })
      assert.deepEqual(boards.map(board => board.name), ['Epics', 'Stories', 'Features'])
      assert.equal(boards[1].id, STORIES)
      assert.equal(w.refusals.length, 0)
    })
  })
})

const FOCUSED = { branch: 'feature/1204-search', displayName: 'web-app', terminals: [] }

function workspaceAt(path: string, hostId: string | null = null) {
  return { workspaces: [{ id: 'ws-web', kind: 'worktree', name: 'web-app', path, branch: 'feature/1204-search', hostId }], truncated: false }
}

test('work.openBoard writes the board file into the focused local workspace and opens it', async () => {
  const ado = fakeAdo()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'main-test-workspace-'))
  try {
    await withFetch(signedIn(ado), async () => {
      const host = boardsHost(BOARDS, {
        'workspace.readContext': () => FOCUSED,
        'workspace.list': () => workspaceAt(dir),
        'editor.open': { opened: true }
      })
      await withWorker(worker, { host }, async w => {
        assert.deepEqual(await w.request('work.openBoard', { org: 'contoso' }), { opened: true })
        assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: 'ws-web', path: `.orca-ado/contoso.${TEAM}.adoboard` }])
        const written = JSON.parse(await fs.readFile(path.join(dir, '.orca-ado', `contoso.${TEAM}.adoboard`), 'utf8'))
        assert.deepEqual(written, { org: 'contoso', projectId: PROJECT, teamId: TEAM, boardId: STORIES })
        assert.equal(await fs.readFile(path.join(dir, '.orca-ado', '.gitignore'), 'utf8'), '*\n')
        assert.equal(w.refusals.length, 0)
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('work.openBoard refuses without a focused local workspace or a boards team', async () => {
  const ado = fakeAdo()
  await withFetch(signedIn(ado), async () => {
    const noWorkspace = { opened: false, message: 'Open a local workspace first, or use + → Azure DevOps board.' }
    await withWorker(worker, { host: boardsHost(BOARDS, { 'workspace.readContext': () => null }) }, async unfocused => {
      assert.deepEqual(await unfocused.request('work.openBoard', { org: 'contoso' }), noWorkspace)
    })

    const remoteHost = boardsHost(BOARDS, { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt('/srv/web-app', 'ssh:build-box') })
    await withWorker(worker, { host: remoteHost }, async remote => {
      assert.deepEqual(await remote.request('work.openBoard', { org: 'contoso' }), noWorkspace)
      assert.deepEqual(remoteHost.callsOf('editor.open'), [])
    })

    const noBoardsHost = boardsHost(null, { 'workspace.readContext': () => FOCUSED, 'workspace.list': () => workspaceAt('/repos/web-app') })
    await withWorker(worker, { host: noBoardsHost }, async noBoards => {
      assert.deepEqual(await noBoards.request('work.openBoard', { org: 'contoso' }), {
        opened: false,
        message: "Pick a boards project and team in this org's settings."
      })
    })
    assert.equal(ado.calls.length, 0)
  })
})
