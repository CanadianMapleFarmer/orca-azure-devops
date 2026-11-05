import { assert, test } from 'orca/testing'
import { parseAdoRemote, remotesOf } from './remote'

const WEB = { org: 'contoso', project: 'Fabrikam Web', repo: 'web-app' }

test('parseAdoRemote reads every Azure DevOps remote form', () => {
  assert.deepEqual(parseAdoRemote('https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://ada@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('https://contoso.visualstudio.com/DefaultCollection/Fabrikam%20Web/_git/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('git@ssh.dev.azure.com:v3/contoso/Fabrikam%20Web/web-app'), WEB)
  assert.deepEqual(parseAdoRemote('contoso@vs-ssh.visualstudio.com:v3/contoso/Fabrikam%20Web/web-app'), WEB)
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
    'https://dev.azure.com/contoso/_git/web-app',
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
    ''
  ].join('\n')
  assert.deepEqual(remotesOf(output), [WEB, { org: 'contoso', project: 'Fabrikam Web', repo: 'api' }])
})

test('remotesOf copes with CRLF, blank lines, junk and no remotes', () => {
  assert.deepEqual(remotesOf(''), [])
  assert.deepEqual(remotesOf('\n\n'), [])
  assert.deepEqual(remotesOf('fatal: not a git repository'), [])
  assert.deepEqual(remotesOf('origin\thttps://github.com/contoso/web-app.git (fetch)\r\n'), [])
  assert.deepEqual(
    remotesOf('origin\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)\r\norigin\thttps://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (push)\r\n'),
    [WEB]
  )
  assert.deepEqual(remotesOf('origin https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)'), [WEB])
})

test('remotesOf drops the credentials a remote URL carries', () => {
  const secret = 'pat-remote-test-1f2e3d'
  const remotes = remotesOf(`origin\thttps://ada:${secret}@dev.azure.com/contoso/Fabrikam%20Web/_git/web-app (fetch)\n`)
  assert.deepEqual(remotes, [WEB])
  assert.ok(!JSON.stringify(remotes).includes(secret))
})
