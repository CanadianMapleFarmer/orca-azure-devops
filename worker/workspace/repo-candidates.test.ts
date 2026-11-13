import { assert, test } from 'orca/testing'
import { CODE_REPOS_KEY } from '../ado/code-projects'
import type { PrRef } from '../ado/workitems'
import { createEntities } from '../data/entities'
import { prKey, type PrRecord, type RepoRecord } from '../data/records'
import { memoryStore } from '../test-support'
import type { WorkspaceEntry } from './focused'
import { remotesOf, type AdoRemote, type OtherRemote, type RemoteSet } from './remotes'
import { defaultRepo, localRepos, prRepos, rankRepos, type LocalRepo } from './repo-candidates'
import { createRepoChoices, projectOf } from './repo-for-item'

const ORG = 'contoso'
const WEB_PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TOOLS_PROJECT = '5a2b3c4d-1111-4b3c-8d4e-1f2a3b4c5d6e'
const WEB_REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const API_REPO = '8d9e0f1a-3333-4d5e-8f6a-3b4c5d6e7f80'
const TOOLS_REPO = '9e0f1a2b-3333-4e6f-9a7b-4c5d6e7f8091'
const UNKNOWN_REPO = 'a0f1a2b3-3333-4f7a-8b8c-5d6e7f809102'
const T0 = Date.parse('2026-11-12T10:00:00Z')
const UNREAD = "Couldn't read the git remotes of a local workspace."

const WEB: AdoRemote = { remote: 'origin', org: ORG, project: 'Fabrikam Web', repo: 'web-app' }
const API: AdoRemote = { ...WEB, project: 'Fabrikam API', repo: 'api' }
const TOOLS: AdoRemote = { ...WEB, project: 'Tools', repo: 'tools' }
const PORTAL: AdoRemote = { ...WEB, org: 'fabrikam', project: 'Platform', repo: 'portal' }
const NOTES: OtherRemote = { remote: 'origin', key: 'git:github.com/fabrikam/notes', name: 'notes', host: 'github.com' }

function workspace(id: string, over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: `/repos/${id}`, branch: 'main', hostId: null, ...over }
}

function remoteSetsFrom(table: Record<string, Partial<RemoteSet>>) {
  return {
    remoteSets: async (path: string): Promise<RemoteSet> => ({ ado: [], other: null, ...table[path] }),
    log: () => assert.fail('nothing failed')
  }
}

function local(key: string, name: string, detail: string, ado: AdoRemote[]): LocalRepo {
  return { key, name, detail, ado, workspaces: [workspace(name)] }
}

const WEB_LOCAL = local('contoso/fabrikam web/web-app', 'web-app', 'Fabrikam Web', [WEB])
const API_LOCAL = local('contoso/fabrikam api/api', 'api', 'Fabrikam API', [API])
const TOOLS_LOCAL = local('contoso/tools/tools', 'tools', 'Tools', [TOOLS])
const NOTES_LOCAL = local(NOTES.key, 'notes', 'github.com', [])
const PORTAL_LOCAL = local('fabrikam/platform/portal', 'portal', 'Platform', [PORTAL])

function record(id: string, name: string, projectId: string, projectName: string): RepoRecord {
  return { id, name, projectId, projectName, ssh: true, disabled: false }
}

function pr(ref: PrRef, url: string): PrRecord {
  return { ...ref, status: 'active', target: 'main', sourceCommit: null, reviewers: '', url }
}

function tables(repos: RepoRecord[] | null, prs: [PrRef, string][] = []) {
  const org = createEntities(() => T0).of(ORG)
  if (repos) org.codeRepos.put(CODE_REPOS_KEY, repos)
  for (const [ref, url] of prs) org.prs.put(prKey(ref), pr(ref, url))
  return org
}

test("localRepos groups worktrees by Azure DevOps remote, then other remote, then Orca project, then path, and skips folders and other hosts' workspaces", async () => {
  const web = workspace('web-app')
  const web2 = workspace('web-app-2')
  const tools = workspace('tools')
  const notes = workspace('notes', { project: 'p-notes' })
  const scratch = workspace('scratch-feature', { path: '/repos/scratch-worktrees/feature', project: 'p-scratch' })
  const scratchMain = workspace('scratch', { project: 'p-scratch' })
  const loose = workspace('loose', { project: null })
  const looseToo = workspace('loose-too')
  const folder = workspace('folder', { kind: 'folder' })
  const remoteHost = workspace('build-box', { hostId: 'ssh:build-box' })
  const upstream = { ...API, remote: 'upstream' }
  const deps = remoteSetsFrom({
    [web.path]: { ado: [upstream, WEB], other: NOTES },
    [web2.path]: { ado: [WEB, TOOLS] },
    [tools.path]: { ado: [{ ...WEB, project: '', repo: 'tools' }] },
    [notes.path]: { other: NOTES },
    [folder.path]: { ado: [WEB] },
    [remoteHost.path]: { ado: [WEB] }
  })
  const repos = await localRepos(deps, [web, scratch, folder, notes, web2, remoteHost, tools, loose, scratchMain, looseToo])
  assert.deepEqual(repos, [
    { key: 'contoso/fabrikam web/web-app', name: 'web-app', detail: 'Fabrikam Web', ado: [WEB, upstream, TOOLS], workspaces: [web, web2] },
    { key: 'project:p-scratch', name: 'scratch', detail: 'local', ado: [], workspaces: [scratch, scratchMain] },
    { key: NOTES.key, name: 'notes', detail: 'github.com', ado: [], workspaces: [notes] },
    { key: 'contoso/tools/tools', name: 'tools', detail: 'tools', ado: [{ ...WEB, project: '', repo: 'tools' }], workspaces: [tools] },
    { key: 'path:/repos/loose', name: 'loose', detail: 'local', ado: [], workspaces: [loose] },
    { key: 'path:/repos/loose-too', name: 'loose-too', detail: 'local', ado: [], workspaces: [looseToo] }
  ])
})

test("localRepos leaves out a workspace whose remotes can't be read and logs one fixed line", async () => {
  const broken = workspace('broken', { project: 'p-broken' })
  const web = workspace('web-app')
  const logs: string[] = []
  const deps = {
    remoteSets: async (path: string): Promise<RemoteSet> => {
      if (path === broken.path) throw new Error('git exploded at /secret/path')
      return { ado: [WEB], other: null }
    },
    log: (message: string) => logs.push(message)
  }
  assert.deepEqual(
    (await localRepos(deps, [broken, web])).map(repo => repo.key),
    ['contoso/fabrikam web/web-app']
  )
  assert.deepEqual(logs, [UNREAD])
})

test('rankRepos puts linked pull requests first, then the last choice, then this organisation, then the rest', () => {
  const ranked = rankRepos({
    org: 'Contoso',
    local: [PORTAL_LOCAL, TOOLS_LOCAL, NOTES_LOCAL, API_LOCAL, WEB_LOCAL],
    prs: [{ org: ORG, project: 'Fabrikam Web', repo: 'web-app' }, { org: ORG, project: 'Planning', repo: 'docs' }],
    remembered: ['contoso/fabrikam api/api', 'contoso/fabrikam web/web-app']
  })
  assert.deepEqual(ranked, [
    { key: 'contoso/fabrikam web/web-app', name: 'web-app', detail: 'Fabrikam Web', source: 'pr' },
    { key: 'contoso/fabrikam api/api', name: 'api', detail: 'Fabrikam API', source: 'last' },
    { key: 'contoso/tools/tools', name: 'tools', detail: 'Tools', source: 'org' },
    { key: NOTES.key, name: 'notes', detail: 'github.com', source: 'other' },
    { key: 'fabrikam/platform/portal', name: 'portal', detail: 'fabrikam/Platform', source: 'other' }
  ])
  assert.deepEqual(ranked.map(repo => repo.source), ['pr', 'last', 'org', 'other', 'other'])
  assert.equal(defaultRepo(ranked), 'contoso/fabrikam web/web-app')
})

test('an item in a project with no repositories still gets every Orca repo', async () => {
  const web = workspace('web-app')
  const tools = workspace('tools')
  const repos = await localRepos(remoteSetsFrom({ [web.path]: { ado: [WEB] }, [tools.path]: { ado: [TOOLS] } }), [web, tools])
  const project = projectOf('https://dev.azure.com/contoso/Planning/_workitems/edit/1204')
  const choices = await createRepoChoices(memoryStore().store)
  const ranked = rankRepos({ org: ORG, local: repos, prs: [], remembered: choices.chosen({ org: ORG, teamId: null, project }) })
  assert.deepEqual(ranked, [
    { key: 'contoso/tools/tools', name: 'tools', detail: 'Tools', source: 'org' },
    { key: 'contoso/fabrikam web/web-app', name: 'web-app', detail: 'Fabrikam Web', source: 'org' }
  ])
  assert.equal(defaultRepo(ranked), null)
})

test("prRepos names pull request repositories from the repository cache, then from the pull request's own link, newest first", () => {
  const older = { projectId: WEB_PROJECT, repoId: WEB_REPO, prId: 5 }
  const tools = { projectId: TOOLS_PROJECT, repoId: TOOLS_REPO, prId: 9 }
  const newest = { projectId: WEB_PROJECT, repoId: WEB_REPO.toUpperCase(), prId: 12 }
  const api = { projectId: WEB_PROJECT, repoId: API_REPO, prId: 3 }
  const cached = tables(
    [record(WEB_REPO, 'web-app', WEB_PROJECT, 'Fabrikam Web'), record(API_REPO, 'api', WEB_PROJECT, 'Fabrikam Web')],
    [
      [newest, 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/old-name/pullrequest/12'],
      [tools, 'https://contoso.visualstudio.com/Tools/_git/tools/pullrequest/9']
    ]
  )
  assert.deepEqual(prRepos(ORG, [older, api, tools, newest], cached), [
    { org: ORG, project: 'Fabrikam Web', repo: 'web-app' },
    { org: ORG, project: 'Tools', repo: 'tools' },
    { org: ORG, project: 'Fabrikam Web', repo: 'api' }
  ])
  assert.deepEqual(prRepos(ORG, [tools], tables(null, [[tools, 'https://dev.azure.com/contoso/_git/tools/pullrequest/9']])), [
    { org: ORG, project: 'tools', repo: 'tools' }
  ])
})

test('prRepos skips a pull request neither cache can name, including a link that holds ids', () => {
  const unknown = { projectId: WEB_PROJECT, repoId: UNKNOWN_REPO, prId: 4 }
  const byIds = { projectId: WEB_PROJECT, repoId: API_REPO, prId: 6 }
  const repoById = { projectId: WEB_PROJECT, repoId: TOOLS_REPO, prId: 7 }
  const junk = { projectId: TOOLS_PROJECT, repoId: WEB_REPO, prId: 8 }
  const named = { projectId: TOOLS_PROJECT, repoId: TOOLS_REPO, prId: 2 }
  const cached = tables(
    [],
    [
      [byIds, `https://dev.azure.com/contoso/${WEB_PROJECT}/_git/${API_REPO}/pullrequest/6`],
      [repoById, `https://dev.azure.com/contoso/Tools/_git/${TOOLS_REPO}/pullrequest/7`],
      [junk, 'not a link'],
      [named, 'https://dev.azure.com/contoso/Tools/_git/tools/pullrequest/2']
    ]
  )
  assert.deepEqual(prRepos(ORG, [unknown, byIds, repoById, junk, named], cached), [{ org: ORG, project: 'Tools', repo: 'tools' }])
  assert.deepEqual(prRepos(ORG, [unknown, byIds], tables(null)), [])
})

test('ssh:// remotes rank with their pull requests like any other form', async () => {
  const web = workspace('web-app')
  const tools = workspace('tools')
  const api = workspace('api')
  const sets = remoteSetsFrom({
    [web.path]: { ado: remotesOf('origin\tssh://git@ssh.dev.azure.com:22/v3/contoso/Fabrikam%20Web/web-app (fetch)') },
    [tools.path]: { ado: remotesOf('origin\tgit@ssh.dev.azure.com:v3/contoso/Tools/tools (fetch)') },
    [api.path]: { ado: remotesOf('origin\thttps://contoso@dev.azure.com/contoso/Fabrikam%20Web/_git/api (fetch)') }
  })
  const repos = await localRepos(sets, [web, tools, api])
  assert.deepEqual(repos[0].ado, [{ ...WEB, ssh: true }])
  const cached = tables([record(WEB_REPO, 'web-app', WEB_PROJECT, 'Fabrikam Web'), record(TOOLS_REPO, 'tools', TOOLS_PROJECT, 'Tools')])
  const refs = [
    { projectId: WEB_PROJECT, repoId: WEB_REPO, prId: 5 },
    { projectId: TOOLS_PROJECT, repoId: TOOLS_REPO, prId: 3 }
  ]
  const ranked = rankRepos({ org: ORG, local: repos, prs: prRepos(ORG, refs, cached), remembered: [] })
  assert.deepEqual(
    ranked.map(({ name, source }) => [name, source]),
    [
      ['web-app', 'pr'],
      ['tools', 'pr'],
      ['api', 'org']
    ]
  )
})

test('a remembered repo no longer in Orca is ignored, and defaultRepo is null without a pr or last row', () => {
  const gone = 'contoso/fabrikam web/gone'
  const fallback = rankRepos({ org: ORG, local: [WEB_LOCAL, API_LOCAL], prs: [], remembered: [gone, API_LOCAL.key] })
  assert.deepEqual(fallback.map(repo => [repo.key, repo.source]), [
    [API_LOCAL.key, 'last'],
    [WEB_LOCAL.key, 'org']
  ])
  assert.equal(defaultRepo(fallback), API_LOCAL.key)

  const none = rankRepos({ org: ORG, local: [WEB_LOCAL, API_LOCAL], prs: [], remembered: [gone] })
  assert.deepEqual(none.map(repo => repo.source), ['org', 'org'])
  assert.equal(defaultRepo(none), null)
  assert.equal(defaultRepo([]), null)
})

test("localRepos counts Orca's \"local\" host as local, as Orca 1.4.258 reports it", async () => {
  const listed = [workspace('web-app', { hostId: 'local' }), workspace('api'), workspace('build-box', { hostId: 'ssh:build-box' })]
  const deps = remoteSetsFrom({ '/repos/web-app': { ado: [WEB] }, '/repos/api': { ado: [API] }, '/repos/build-box': { ado: [TOOLS] } })
  const found = await localRepos(deps, listed)
  assert.deepEqual(found.map(repo => repo.name).sort(), ['api', 'web-app'])
})
