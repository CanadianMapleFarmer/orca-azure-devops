import { assert, test } from 'orca/testing'
import { memoryStore } from '../test-support'
import type { WorkspaceEntry } from './focused'
import type { AdoRemote } from './remotes'
import { rankRepos } from './repo-candidates'
import { createRepoChoices, projectOf, runIn } from './repo-for-item'

const TEAM_SCOPE = { org: 'contoso', teamId: 't1', project: 'Fabrikam Web' }
const WEB: AdoRemote = { remote: 'origin', org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }
const API: AdoRemote = { ...WEB, repo: 'api' }

function workspace(id: string, over: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return { id, kind: 'worktree', name: id, path: `/repos/${id}`, branch: 'main', hostId: null, ...over }
}

test("projectOf reads the item's project from its link", () => {
  assert.equal(projectOf('https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1204'), 'Fabrikam Web')
  assert.equal(projectOf('https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Web/_workitems/edit/1204'), 'Fabrikam Web')
  assert.equal(projectOf('https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'), null)
  assert.equal(projectOf('https://dev.azure.com/contoso/%E0%A4%A/_workitems/edit/1204'), null)
  assert.equal(projectOf('not a link'), null)
})

test('runIn takes the focused workspace when it holds the repository, otherwise the first by name', () => {
  const repo = { key: 'k', name: 'web-app', workspaces: [workspace('web-b'), workspace('Web-a'), workspace('web-c')] }
  assert.equal(runIn(repo, 'web-c').id, 'web-c')
  assert.equal(runIn(repo, 'elsewhere').id, 'Web-a')
  assert.equal(runIn(repo, null).id, 'Web-a')
})

test("the repository chosen for a team is remembered in storage, and the team's choice comes before the project's", async () => {
  const { data, store } = memoryStore()
  const choices = await createRepoChoices(store)
  assert.deepEqual(choices.chosen(TEAM_SCOPE), [])
  await choices.choose(TEAM_SCOPE, 'contoso/fabrikam web/api')
  assert.deepEqual(choices.chosen(TEAM_SCOPE), ['contoso/fabrikam web/api'])
  await choices.choose({ ...TEAM_SCOPE, teamId: null }, 'contoso/fabrikam web/web-app')
  assert.deepEqual(choices.chosen({ org: 'CONTOSO', teamId: 'T1', project: 'fabrikam web' }), ['contoso/fabrikam web/api', 'contoso/fabrikam web/web-app'])
  assert.deepEqual(choices.chosen({ org: 'contoso', teamId: 't2', project: null }), [])
  assert.deepEqual(choices.chosen({ org: 'fabrikam', teamId: 't1', project: 'Fabrikam Web' }), [])
  await choices.choose({ org: 'contoso', teamId: null, project: null }, 'contoso/tools/tools')

  const again = await createRepoChoices(store)
  assert.deepEqual(again.chosen(TEAM_SCOPE), ['contoso/fabrikam web/api', 'contoso/fabrikam web/web-app'])
  assert.deepEqual(Object.keys(data.workspaceRepos as object), ['contoso/team:t1', 'contoso/fabrikam web'])
})

test("today's saved per-project choice is still offered as last used", async () => {
  const { store } = memoryStore({ workspaceRepos: { 'contoso/fabrikam web': 'contoso/fabrikam web/api' } })
  const remembered = (await createRepoChoices(store)).chosen(TEAM_SCOPE)
  assert.deepEqual(remembered, ['contoso/fabrikam web/api'])
  const api = { key: 'contoso/fabrikam web/api', name: 'api', detail: 'Fabrikam Web', ado: [API], workspaces: [workspace('api')] }
  const web = { key: 'contoso/fabrikam web/web-app', name: 'web-app', detail: 'Fabrikam Web', ado: [WEB], workspaces: [workspace('web-app')] }
  const ranked = rankRepos({ org: 'contoso', local: [web, api], prs: [], remembered })
  assert.deepEqual(ranked.map(repo => [repo.key, repo.source]), [
    ['contoso/fabrikam web/api', 'last'],
    ['contoso/fabrikam web/web-app', 'org']
  ])
})

test('at most 100 scopes are remembered, and junk in storage is ignored', async () => {
  const { data, store } = memoryStore({ workspaceRepos: { 'contoso/web': 7, 'contoso/api': 'contoso/api/api' } })
  const choices = await createRepoChoices(store)
  assert.deepEqual(choices.chosen({ org: 'contoso', teamId: null, project: 'web' }), [])
  assert.deepEqual(choices.chosen({ org: 'contoso', teamId: null, project: 'api' }), ['contoso/api/api'])
  for (let index = 0; index < 100; index += 1) await choices.choose({ org: 'contoso', teamId: `t${index}`, project: 'web' }, `contoso/p${index}/r`)
  assert.equal(Object.keys(data.workspaceRepos as object).length, 100)
  assert.deepEqual(choices.chosen({ org: 'contoso', teamId: null, project: 'api' }), [])
  assert.deepEqual(choices.chosen({ org: 'contoso', teamId: 't99', project: 'web' }), ['contoso/p99/r'])
})
