import { assert, test } from 'orca/testing'
import { otherRemoteOf, parseAdoRemote, remotesOf, repoOfPullRequestUrl, sameProject, sameRepo } from './remotes'

const WEB = { org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }

test('parseAdoRemote reads every Azure DevOps remote form', () => {
  assert.deepEqual(parseAdoRemote('https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam%20Web/web-app'), WEB)
})

test('parseAdoRemote reads the default-repository forms that name no project', () => {
  const noProject = { org: 'contoso', project: '', repo: 'web-app' }
  assert.deepEqual(parseAdoRemote('https://dev.azure.com/contoso/_git/web-app'), noProject)
  assert.deepEqual(parseAdoRemote('https://ada@dev.azure.com/contoso/_git/web%2Dapp'), noProject)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/_git/web-app'), noProject)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/DefaultCollection/_git/web-app'), noProject)
  for (const url of [
    'https://dev.azure.com/_git/web-app',
    'https://dev.azure.com/contoso/_git/',
    'https://dev.azure.com/contoso/_git/web-app/extra',
    'https://contoso.visualstudio.com/_git',
    'git@ssh.dev.azure.com:v3/contoso//web-app',
    'git@ssh.dev.azure.com:v3//Fabrikam%20Web/web-app'
  ]) {
    assert.equal(parseAdoRemote(url), null, url)
  }
})

test('parseAdoRemote percent-decodes segments and keeps their case for comparing', () => {
  assert.deepEqual(parseAdoRemote('https://DEV.Azure.com/Contoso/Fabrikam%20Web/_GIT/Web%2DApp'), { org: 'Contoso', project: 'Fabrikam Web', repo: 'Web-App' })
  assert.deepEqual(parseAdoRemote('https://dev.azure.com/contoso/Caf%C3%A9/_git/r%C3%A9sum%C3%A9'), { org: 'contoso', project: 'Café', repo: 'résumé' })
  assert.equal(parseAdoRemote('https://dev.azure.com/contoso/Fabrikam%ZZWeb/_git/web-app'), null)
  assert.equal(parseAdoRemote('git@ssh.dev.azure.com:v3/contoso/Fabrikam%ZZWeb/web-app'), null)
})

test('parseAdoRemote ignores GitHub and other hosts', () => {
  const others = [
    '',
    '   ',
    'https://github.com/contoso/web-app.git',
    'git@github.com:contoso/web-app.git',
    'https://gitlab.com/contoso/Fabrikam%20Web/_git/web-app',
    'https://dev.azure.com.example.net/contoso/Fabrikam%20Web/_git/web-app',
    'https://example.net/dev.azure.com/contoso/Fabrikam%20Web/_git/web-app',
    'https://contoso.visualstudio.com.example.net/Fabrikam%20Web/_git/web-app',
    'https://visualstudio.com/Fabrikam%20Web/_git/web-app',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_apis/git/repositories/web-app',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/extra',
    'git@ssh.dev.azure.com:v3/contoso/web-app',
    'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app/extra',
    'git@ssh.dev.azure.com:v2/contoso/Fabrikam%20Web/web-app',
    'git@ssh.dev.azure.com.example.net:v3/contoso/Fabrikam%20Web/web-app',
    'git@example.net:v3/contoso/Fabrikam%20Web/web-app',
    'ftp://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app',
    '/srv/git/web-app',
    '../web-app',
    'file:///srv/git/web-app'
  ]
  for (const url of others) assert.equal(parseAdoRemote(url), null, url)
})

test('remotesOf reads git remote -v output', () => {
  const output = [
    'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)',
    'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (push)',
    'github\thttps://github.com/contoso/web-app.git (fetch)',
    'github\thttps://github.com/contoso/web-app.git (push)',
    'api\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/api (fetch)',
    'api\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/api (push)',
    'mirror\thttps://contoso.visualstudio.com/Fabrikam%20Web/_git/web-app (push)',
    'lazy\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/lazy (fetch) [blob:none]',
    'lazy\tno_push (push)',
    ''
  ].join('\n')
  assert.deepEqual(remotesOf(output), [
    { remote: 'origin', ...WEB },
    { remote: 'api', org: 'contoso', project: 'Fabrikam Web', repo: 'api', ssh: true },
    { remote: 'lazy', org: 'contoso', project: 'Fabrikam Web', repo: 'lazy' }
  ])
})

test('remotesOf copes with CRLF, blank lines, junk and no remotes', () => {
  assert.deepEqual(remotesOf(''), [])
  assert.deepEqual(remotesOf('\n\n'), [])
  assert.deepEqual(remotesOf('fatal: not a git repository'), [])
  assert.deepEqual(remotesOf('origin\thttps://github.com/contoso/web-app.git (fetch)\r\n'), [])
  assert.deepEqual(
    remotesOf('origin\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)\r\norigin\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (push)\r\n'),
    [{ remote: 'origin', ...WEB }]
  )
  assert.deepEqual(remotesOf('origin https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)'), [{ remote: 'origin', ...WEB }])
})

test('remotesOf drops the credentials a remote URL carries', () => {
  const secret = 'pat-remote-test-1f2e3d'
  const remotes = remotesOf(`origin\thttps://ada:${secret}@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)\n`)
  assert.deepEqual(remotes, [{ remote: 'origin', ...WEB }])
  assert.ok(!JSON.stringify(remotes).includes(secret))
})

test("remotesOf keeps each remote's name", () => {
  const output = [
    'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app-ada (fetch)',
    'origin\thttps://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app-ada (push)',
    'upstream\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app (fetch)',
    'upstream\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app (push)',
    'vsts-mirror\thttps://contoso.visualstudio.com/Fabrikam%20Web/_git/web-app (fetch)',
    'review.team\thttps://dev.azure.com/contoso/_git/docs (fetch)'
  ].join('\n')
  assert.deepEqual(remotesOf(output), [
    { remote: 'origin', org: 'contoso', project: 'Fabrikam Web', repo: 'web-app-ada' },
    { remote: 'upstream', ...WEB, ssh: true },
    { remote: 'review.team', org: 'contoso', project: '', repo: 'docs' }
  ])
})

test('sameRepo matches org, project and repo case-insensitively', () => {
  const origin = { remote: 'origin', ...WEB }
  assert.equal(sameRepo(origin, WEB), true)
  assert.equal(sameRepo({ remote: 'upstream', org: 'Contoso', project: 'FABRIKAM WEB', repo: 'Web-App' }, WEB), true)
  assert.equal(sameRepo(origin, { org: 'CONTOSO', project: 'fabrikam web', repo: 'WEB-APP' }), true)
  assert.equal(sameRepo({ remote: 'origin', org: 'contoso', project: 'Café', repo: 'résumé' }, { org: 'contoso', project: 'CAFÉ', repo: 'RÉSUMÉ' }), true)
  assert.equal(sameRepo({ ...origin, org: 'fabrikam' }, WEB), false)
  assert.equal(sameRepo({ ...origin, project: 'Other' }, WEB), false)
  assert.equal(sameRepo({ ...origin, repo: 'api' }, WEB), false)
  assert.equal(sameRepo({ ...origin, repo: 'web-app-ada' }, WEB), false)
})

test('the default-project form is the project named after its repository, not a wildcard', () => {
  const noProject = { remote: 'origin', org: 'Contoso', project: '', repo: 'WEB-APP' }
  assert.equal(sameRepo(noProject, { org: 'contoso', project: 'web-app', repo: 'web-app' }), true)
  assert.equal(sameRepo(noProject, WEB), false)
  assert.equal(sameRepo({ ...noProject, org: 'fabrikam' }, { org: 'contoso', project: 'web-app', repo: 'web-app' }), false)
  assert.equal(sameRepo({ ...noProject, repo: 'api' }, { org: 'contoso', project: 'web-app', repo: 'web-app' }), false)
})

test('a lookalike repository name is a different repository', () => {
  assert.equal(sameRepo({ remote: 'origin', ...WEB, repo: 'w\u0435b-app' }, WEB), false)
  assert.equal(sameRepo({ remote: 'origin', ...WEB }, { ...WEB, repo: 'w\u0435b-app' }), false)
})

test('sameProject matches org and project case-insensitively, whatever the repo', () => {
  const origin = { remote: 'origin', ...WEB }
  const project = { org: 'contoso', project: 'Fabrikam Web' }
  assert.equal(sameProject(origin, { org: 'CONTOSO', project: 'fabrikam web' }), true)
  assert.equal(sameProject({ ...origin, repo: 'api' }, project), true)
  assert.equal(sameProject({ ...origin, org: 'fabrikam' }, project), false)
  assert.equal(sameProject({ ...origin, project: 'Other' }, project), false)
})

test('sameProject reads a remote that names no project as the project its repo is named after', () => {
  const noProject = { remote: 'origin', org: 'contoso', project: '', repo: 'Fabrikam Web' }
  assert.equal(sameProject(noProject, { org: 'contoso', project: 'fabrikam web' }), true)
  assert.equal(sameProject({ ...noProject, repo: 'web-app' }, { org: 'contoso', project: 'Fabrikam Web' }), false)
})

test('remotesOf marks ssh remotes, and reads ssh:// urls', () => {
  const output = [
    'origin\tssh://git@ssh.dev.azure.com/v3/contoso/Fabrikam%20Web/web-app (fetch)',
    'port\tssh://git@ssh.dev.azure.com:22/v3/contoso/Fabrikam%20Web/api (fetch)',
    'legacy\tssh://contoso@vs-ssh.visualstudio.com/v3/contoso/Fabrikam%20Web/tools (fetch)',
    'scp\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/docs (fetch)',
    'web\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/site (fetch)'
  ].join('\n')
  assert.deepEqual(remotesOf(output), [
    { remote: 'origin', ...WEB, ssh: true },
    { remote: 'port', ...WEB, repo: 'api', ssh: true },
    { remote: 'legacy', ...WEB, repo: 'tools', ssh: true },
    { remote: 'scp', ...WEB, repo: 'docs', ssh: true },
    { remote: 'web', ...WEB, repo: 'site' }
  ])
  assert.deepEqual(parseAdoRemote('ssh://git@ssh.dev.azure.com/v3/contoso/Fabrikam%20Web/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('ssh://git@ssh.dev.azure.com:22/v3/contoso/Fabrikam%20Web/web-app'), WEB)
  for (const url of [
    'ssh://git@ssh.dev.azure.com:2222/v3/contoso/Fabrikam%20Web/web-app',
    'ssh://ssh.dev.azure.com/v3/contoso/Fabrikam%20Web/web-app',
    'ssh://git@github.com/v3/contoso/Fabrikam%20Web/web-app',
    'ssh://git@ssh.dev.azure.com/v2/contoso/Fabrikam%20Web/web-app',
    'ssh://git@ssh.dev.azure.com/v3/contoso/web-app'
  ]) {
    assert.equal(parseAdoRemote(url), null, url)
  }
})

test('parseAdoRemote refuses strings the URL parser would rewrite, and hostile ssh users', () => {
  for (const url of [
    String.raw`https:\\dev.azure.com\contoso\Fabrikam%20Web\_git\web-app`,
    'https://dev.azure.com\\contoso/Fabrikam%20Web/_git/web-app',
    ' https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app ',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web\napp',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web\tapp',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web\u0000app',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%0Aapp',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%7Fapp',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web%C2%85app',
    'git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web%0Aapp',
    '-oProxyCommand=touch@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app',
    '.git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app',
    'ssh://-oProxyCommand=touch@ssh.dev.azure.com/v3/contoso/Fabrikam%20Web/web-app',
    'file:///srv/git/web-app',
    '/srv/git/web-app'
  ]) {
    assert.equal(parseAdoRemote(url), null, JSON.stringify(url))
  }
})

test('otherRemoteOf prefers origin and reads https and scp forms of other hosts', () => {
  const notes = { key: 'git:github.com/fabrikam/notes', name: 'notes', host: 'github.com' }
  assert.deepEqual(otherRemoteOf('origin\tgit@github.com:fabrikam/notes.git (fetch)\n'), { remote: 'origin', ...notes })
  assert.deepEqual(otherRemoteOf('origin\thttps://github.com/fabrikam/notes/ (fetch)\n'), { remote: 'origin', ...notes })
  assert.deepEqual(otherRemoteOf('origin\thttps://ada@GitHub.com/Fabrikam/Notes.git (fetch)\n'), { remote: 'origin', ...notes, name: 'Notes' })
  assert.deepEqual(otherRemoteOf('origin\tssh://git@gitlab.example.net/fabrikam/tools/notes.git (fetch)\n'), {
    remote: 'origin',
    key: 'git:gitlab.example.net/fabrikam/tools/notes',
    name: 'notes',
    host: 'gitlab.example.net'
  })
  const output = [
    'mirror\thttps://gitlab.example.net/fabrikam/notes.git (fetch)',
    'mirror\thttps://gitlab.example.net/fabrikam/notes.git (push)',
    'origin\tgit@github.com:fabrikam/notes.git (fetch)',
    'origin\tgit@github.com:fabrikam/notes.git (push)'
  ].join('\n')
  assert.deepEqual(otherRemoteOf(output), { remote: 'origin', ...notes })
  assert.deepEqual(otherRemoteOf(output.replaceAll('origin', 'backup')), {
    remote: 'mirror',
    key: 'git:gitlab.example.net/fabrikam/notes',
    name: 'notes',
    host: 'gitlab.example.net'
  })
})

test('otherRemoteOf ignores Azure DevOps remotes and answers null without another remote', () => {
  const ado = [
    'origin\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)',
    'api\tgit@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/api (fetch)',
    'odd\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/extra (fetch)',
    'legacy\thttps://contoso.visualstudio.com/Fabrikam%20Web/_git/tools/extra (fetch)'
  ].join('\n')
  assert.equal(otherRemoteOf(ado), null)
  assert.deepEqual(otherRemoteOf(`${ado}\ngithub\thttps://github.com/fabrikam/notes.git (fetch)`), {
    remote: 'github',
    key: 'git:github.com/fabrikam/notes',
    name: 'notes',
    host: 'github.com'
  })
  for (const output of [
    '',
    'fatal: not a git repository',
    'origin\t/srv/git/notes (fetch)',
    'origin\tfile:///srv/git/notes (fetch)',
    'origin\t../notes (fetch)',
    'origin\thttps://github.com/ (fetch)',
    'origin\thttps:\\\\github.com\\fabrikam\\notes (fetch)',
    'origin\thttps://github.com/fabrikam/no%0Ates (fetch)'
  ]) {
    assert.equal(otherRemoteOf(output), null, JSON.stringify(output))
  }
})

test('repoOfPullRequestUrl reads a pull request link on both hosts and refuses ids and anything else', () => {
  assert.deepEqual(repoOfPullRequestUrl('https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812'), WEB)
  assert.deepEqual(repoOfPullRequestUrl('https://contoso.visualstudio.com/Fabrikam%20Web/_git/web-app/pullrequest/812'), WEB)
  assert.deepEqual(repoOfPullRequestUrl('https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Web/_git/web-app/pullrequest/812'), WEB)
  assert.deepEqual(repoOfPullRequestUrl('https://dev.azure.com/contoso/_git/web-app/pullrequest/812'), { org: 'contoso', project: 'web-app', repo: 'web-app' })
  const project = '0f1e2d3c-4b5a-4968-8776-655443322110'
  const repo = '9a8b7c6d-5e4f-4031-8273-645566778899'
  for (const url of [
    `https://dev.azure.com/contoso/${project}/_git/${repo}/pullrequest/812`,
    `https://dev.azure.com/contoso/${project}/_git/web-app/pullrequest/812`,
    `https://dev.azure.com/contoso/Fabrikam%20Web/_git/${repo}/pullrequest/812`,
    `https://dev.azure.com/contoso/_git/${repo}/pullrequest/812`,
    'http://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/abc',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812?_a=files',
    'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812 ',
    'https://github.com/fabrikam/notes/pull/812',
    'https://github.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/812',
    ''
  ]) {
    assert.equal(repoOfPullRequestUrl(url), null, url)
  }
})
