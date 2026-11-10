import { read } from 'orca'
import { assert, mount, test } from 'orca/testing'
import {
  ACROSS_PROJECTS,
  ACROSS_REPOS,
  ALL_PROJECTS,
  ALL_REPOS,
  CHOOSE_ALL,
  COLLAPSE_ALL,
  counted,
  EXPAND_ALL,
  needYouHint,
  nothingIn,
  OPEN_IN_TAB,
  repoCount,
  showMore
} from './copy'
import { ACROSS_PROJECTS_KEY, choicesOf, groupByPlace, inScope, type Grouped, type Place } from './grouping'
import { chooseProject, chooseRepo, prsPrefs, runsPrefs, scopeIn } from './prefs'
import { closeCleanly } from './test-support'

interface Item {
  id: string
  at: Place[]
}

const at = (item: Item) => item.at
const item = (id: string, ...places: Place[]): Item => ({ id, at: places })
const ids = (items: readonly Item[]) => items.map(each => each.id)
const place = (projectId: string, projectName: string, repoId: string | null = null, repoName: string | null = null): Place => ({
  projectId,
  projectName,
  repoId,
  repoName
})

const WEB_APP = place('p1', 'Fabrikam Web', 'r1', 'web-app')
const WEB_API = place('p1', 'Fabrikam Web', 'r3', 'fabrikam-api')
const WEB_NO_REPO = place('p1', 'Fabrikam Web')
const TOOLS_APP = place('p2', 'Contoso Tools', 'r2', 'web-app')
const TOOLS_API = place('p2', 'Contoso Tools', 'r4', 'fabrikam-api')
const TOOLS_NO_REPO = place('p2', 'Contoso Tools')

const shape = (grouped: Grouped<Item>) => ({
  across: ids(grouped.across),
  projects: grouped.projects.map(project => ({
    ...project,
    loose: ids(project.loose),
    repos: project.repos.map(repo => ({ ...repo, items: ids(repo.items) }))
  }))
})

const everyItem = (grouped: Grouped<Item>) => [
  ...grouped.across,
  ...grouped.projects.flatMap(project => [...project.loose, ...project.repos.flatMap(repo => repo.items)])
]

test('groupByPlace keeps a one-repo project flat and names the repo', () => {
  const grouped = groupByPlace([item('a', WEB_APP), item('b', WEB_APP, WEB_APP), item('c', WEB_APP)], at)

  assert.deepEqual(shape(grouped), {
    across: [],
    projects: [
      { key: 'project:p1', projectId: 'p1', projectName: 'Fabrikam Web', repoName: 'web-app', repoCount: 1, loose: ['a', 'b', 'c'], repos: [], count: 3 }
    ]
  })
})

test('groupByPlace splits a project into repo groups only when its items come from several repos', () => {
  const grouped = groupByPlace([item('a', WEB_APP), item('b', WEB_API), item('c', WEB_APP)], at)

  assert.deepEqual(shape(grouped), {
    across: [],
    projects: [
      {
        key: 'project:p1',
        projectId: 'p1',
        projectName: 'Fabrikam Web',
        repoName: null,
        repoCount: 2,
        loose: [],
        repos: [
          { key: 'project:p1/repo:r3', repoName: 'fabrikam-api', items: ['b'] },
          { key: 'project:p1/repo:r1', repoName: 'web-app', items: ['a', 'c'] }
        ],
        count: 3
      }
    ]
  })
})

test('an item spanning repos goes in Across repos at the top of its project, and one spanning projects in Across projects, never copied', () => {
  const items = [item('a', WEB_APP), item('set', WEB_APP, WEB_API), item('x', WEB_APP, TOOLS_APP), item('b', WEB_API), item('t', TOOLS_APP)]
  const grouped = groupByPlace(items, at)

  assert.equal(ACROSS_PROJECTS_KEY, 'across-projects')
  assert.deepEqual(shape(grouped), {
    across: ['x'],
    projects: [
      { key: 'project:p2', projectId: 'p2', projectName: 'Contoso Tools', repoName: 'web-app', repoCount: 1, loose: ['t'], repos: [], count: 1 },
      {
        key: 'project:p1',
        projectId: 'p1',
        projectName: 'Fabrikam Web',
        repoName: null,
        repoCount: 2,
        loose: [],
        repos: [
          { key: 'project:p1/across-repos', repoName: null, items: ['set'] },
          { key: 'project:p1/repo:r3', repoName: 'fabrikam-api', items: ['b'] },
          { key: 'project:p1/repo:r1', repoName: 'web-app', items: ['a'] }
        ],
        count: 3
      }
    ]
  })
  assert.equal(everyItem(grouped).filter(each => each.id === 'x').length, 1)
  assert.deepEqual(ids(everyItem(grouped)).sort(), ids(items).sort())
})

test('an item with no place is kept in Across projects rather than dropped', () => {
  const grouped = groupByPlace([item('a', WEB_APP), item('nowhere')], at)

  assert.deepEqual(ids(grouped.across), ['nowhere'])
  assert.deepEqual(ids(everyItem(grouped)).sort(), ['a', 'nowhere'])
})

test('runs without a repository stay loose beside the repo groups', () => {
  const grouped = groupByPlace(
    [item('run-0', WEB_NO_REPO), item('a', WEB_APP), item('b', WEB_API), item('run-1', WEB_NO_REPO), item('tools-run', TOOLS_NO_REPO)],
    at
  )

  assert.deepEqual(shape(grouped), {
    across: [],
    projects: [
      { key: 'project:p2', projectId: 'p2', projectName: 'Contoso Tools', repoName: null, repoCount: 0, loose: ['tools-run'], repos: [], count: 1 },
      {
        key: 'project:p1',
        projectId: 'p1',
        projectName: 'Fabrikam Web',
        repoName: null,
        repoCount: 2,
        loose: ['run-0', 'run-1'],
        repos: [
          { key: 'project:p1/repo:r3', repoName: 'fabrikam-api', items: ['b'] },
          { key: 'project:p1/repo:r1', repoName: 'web-app', items: ['a'] }
        ],
        count: 4
      }
    ]
  })
})

test('groups are keyed by id, so same-named repos in two projects stay apart, ordered by name', () => {
  const lowerTools = place('p0', 'contoso tools', 'r5', 'web-app')
  const grouped = groupByPlace(
    [item('web-1', WEB_APP), item('tools-1', TOOLS_APP), item('web-2', WEB_API), item('tools-2', TOOLS_API), item('lower', lowerTools)],
    at
  )

  assert.deepEqual(
    grouped.projects.map(project => [project.key, project.projectName]),
    [
      ['project:p0', 'contoso tools'],
      ['project:p2', 'Contoso Tools'],
      ['project:p1', 'Fabrikam Web']
    ]
  )
  assert.deepEqual(shape(grouped).projects[1].repos, [
    { key: 'project:p2/repo:r4', repoName: 'fabrikam-api', items: ['tools-2'] },
    { key: 'project:p2/repo:r2', repoName: 'web-app', items: ['tools-1'] }
  ])
  assert.deepEqual(shape(grouped).projects[2].repos, [
    { key: 'project:p1/repo:r3', repoName: 'fabrikam-api', items: ['web-2'] },
    { key: 'project:p1/repo:r1', repoName: 'web-app', items: ['web-1'] }
  ])
  assert.deepEqual(shape(grouped).projects[0].loose, ['lower'])
})

test('choicesOf lists the projects, and the repos of a chosen project with several', () => {
  const items = [item('a', WEB_APP), item('b', WEB_API), item('x', WEB_APP, TOOLS_APP)]
  const projects = [
    { id: 'p2', name: 'Contoso Tools' },
    { id: 'p1', name: 'Fabrikam Web' }
  ]

  assert.deepEqual(choicesOf(items, at, { project: null, repo: null }), { projects, repos: [], scope: { project: null, repo: null } })
  assert.deepEqual(choicesOf(items, at, { project: 'p1', repo: null }), {
    projects,
    repos: [
      { id: 'r3', name: 'fabrikam-api' },
      { id: 'r1', name: 'web-app' }
    ],
    scope: { project: 'p1', repo: null }
  })
  assert.deepEqual(choicesOf(items, at, { project: 'p1', repo: 'r1' }).scope, { project: 'p1', repo: 'r1' })
  assert.deepEqual(choicesOf(items, at, { project: 'p2', repo: 'r2' }), { projects, repos: [], scope: { project: 'p2', repo: null } })
})

test('a remembered project or repo that is no longer in the data falls back to All without forgetting it', async () => {
  const remembered = { contoso: { project: 'p9', repo: 'r9' } }
  const panel = await mount(() => null, { persisted: { plugin: { runsPrefs: remembered } } })
  const items = [item('a', WEB_APP), item('b', WEB_API)]
  const stored = Object.freeze(scopeIn(read(runsPrefs), 'contoso'))

  const choices = choicesOf(items, at, stored)

  assert.deepEqual(choices.scope, { project: null, repo: null })
  assert.deepEqual(choices.projects, [{ id: 'p1', name: 'Fabrikam Web' }])
  assert.deepEqual(stored, { project: 'p9', repo: 'r9' })
  assert.deepEqual(choicesOf(items, at, { project: 'p1', repo: 'r9' }).scope, { project: 'p1', repo: null })
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.runsPrefs, remembered)

  const back = [...items, item('c', place('p9', 'Fabrikam Mobile', 'r9', 'web-app')), item('d', place('p9', 'Fabrikam Mobile', 'r8', 'fabrikam-api'))]
  assert.deepEqual(choicesOf(back, at, stored).scope, { project: 'p9', repo: 'r9' })
  await closeCleanly(panel)
})

test('inScope keeps a set when any of its pull requests is in the chosen project', () => {
  const items = [item('s1', WEB_APP), item('s2', TOOLS_APP), item('x', WEB_API, TOOLS_APP)]

  assert.deepEqual(ids(inScope(items, at, { project: 'p2', repo: null })), ['s2', 'x'])
  assert.deepEqual(ids(inScope(items, at, { project: 'p1', repo: null })), ['s1', 'x'])
  assert.deepEqual(ids(inScope(items, at, { project: 'p1', repo: 'r3' })), ['x'])
  assert.deepEqual(ids(inScope(items, at, { project: 'p1', repo: 'r2' })), [])
  const all = inScope(items, at, { project: null, repo: null })
  assert.deepEqual(ids(all), ['s1', 's2', 'x'])
  assert.notEqual(all, items)
})

test('choosing a project or repository keeps the remembered Mine/To review view', async () => {
  const fabrikam = { project: 'p2', repo: null, view: 'mine' }
  const panel = await mount(() => null, {
    persisted: { plugin: { prsPrefs: { contoso: { project: null, repo: null, view: 'review' }, fabrikam } } }
  })

  chooseProject(prsPrefs, 'contoso', 'p1')
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.prsPrefs, { contoso: { project: 'p1', repo: null, view: 'review' }, fabrikam })

  chooseRepo(prsPrefs, 'contoso', 'r3')
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.prsPrefs, { contoso: { project: 'p1', repo: 'r3', view: 'review' }, fabrikam })

  chooseProject(prsPrefs, 'contoso', 'p2')
  chooseProject(runsPrefs, 'contoso', 'p1')
  chooseRepo(runsPrefs, 'contoso', 'r1')
  await panel.settled()
  assert.deepEqual(panel.persisted.plugin.prsPrefs, { contoso: { project: 'p2', repo: null, view: 'review' }, fabrikam })
  assert.deepEqual(panel.persisted.plugin.runsPrefs, { contoso: { project: 'p1', repo: 'r1' } })

  const plugin = panel.persisted.plugin
  await closeCleanly(panel)
  const reloaded = await mount(() => null, { persisted: { plugin } })
  assert.deepEqual(scopeIn(read(prsPrefs), 'contoso'), { project: 'p2', repo: null })
  assert.deepEqual(scopeIn(read(prsPrefs), 'fabrikam'), { project: 'p2', repo: null })
  assert.deepEqual(scopeIn(read(runsPrefs), 'contoso'), { project: 'p1', repo: 'r1' })
  assert.deepEqual(scopeIn(read(runsPrefs), 'fabrikam'), { project: null, repo: null })
  await closeCleanly(reloaded)
})

test('scopeIn reads a missing or malformed remembered entry as All', () => {
  const malformed = { contoso: { project: 7, repo: ['r1'] }, fabrikam: 'p1' } as unknown as Record<string, { project?: string | null; repo?: string | null }>

  assert.deepEqual(scopeIn(malformed, 'contoso'), { project: null, repo: null })
  assert.deepEqual(scopeIn(malformed, 'fabrikam'), { project: null, repo: null })
  assert.deepEqual(scopeIn({}, 'contoso'), { project: null, repo: null })
  assert.deepEqual(scopeIn({ contoso: { project: 'p1' } }, 'contoso'), { project: 'p1', repo: null })
})

test('counted, needYouHint and showMore read naturally for one and many', () => {
  assert.equal(counted(1, 'set', 'sets'), '1 set')
  assert.equal(counted(3, 'set', 'sets'), '3 sets')
  assert.equal(counted(0, 'run', 'runs'), '0 runs')
  assert.equal(needYouHint(1), '1 needs you')
  assert.equal(needYouHint(3), '3 need you')
  assert.equal(showMore(1), 'Show 1 more')
  assert.equal(showMore(25), 'Show 25 more')
  assert.equal(nothingIn('Fabrikam Web'), 'Nothing here for Fabrikam Web')
  assert.equal(repoCount(1), '1 repo')
  assert.equal(repoCount(3), '3 repos')
  assert.deepEqual(
    [COLLAPSE_ALL, EXPAND_ALL, ALL_PROJECTS, ALL_REPOS, ACROSS_PROJECTS, ACROSS_REPOS, OPEN_IN_TAB, CHOOSE_ALL],
    ['Collapse all', 'Expand all', 'All projects', 'All repos', 'Across projects', 'Across repos', 'Open in tab', 'Choose All projects to see everything.']
  )
})
