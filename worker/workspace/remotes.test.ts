import { assert, test } from 'orca/testing'
import { parseAdoRemote, remotesOf, sameRepo } from './remotes'

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
    { remote: 'api', org: 'contoso', project: 'Fabrikam Web', repo: 'api' },
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
    { remote: 'upstream', ...WEB },
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

test('sameRepo compares org and repo when the remote names no project', () => {
  const noProject = { remote: 'origin', org: 'Contoso', project: '', repo: 'WEB-APP' }
  assert.equal(sameRepo(noProject, WEB), true)
  assert.equal(sameRepo(noProject, { ...WEB, project: 'Other' }), true)
  assert.equal(sameRepo({ ...noProject, org: 'fabrikam' }, WEB), false)
  assert.equal(sameRepo({ ...noProject, repo: 'api' }, WEB), false)
})
