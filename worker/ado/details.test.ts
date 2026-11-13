import { assert, test } from 'orca/testing'
import { addComment, addPullRequestLink, bodyOf, linkedIds, linkRows, readComments, resolvePullRequest } from './details'
import { AdoError, createAdoHttp, type AdoHttp } from './http'
import type { RawWorkItem } from './workitems'

const ORG = 'contoso'
const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const OTHER_PROJECT = '9d8c7b6a-4444-4d5e-8f6a-3b4c5d6e7f80'
const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
const BASE = `https://dev.azure.com/${ORG}`
const HOME = 'Fabrikam Web'
const ITEM_URL = `${BASE}/Fabrikam%20Web/_workitems/edit/42`
const COMMENTS_URL = `${BASE}/${PROJECT}/_apis/wit/workItems/42/comments`
const SUFFIX = '… open in Azure DevOps for the rest'
const CONFLICT_MESSAGE = "Someone else changed this item. It's been refreshed; try again."
const NOT_A_PR = "That isn't an Azure DevOps pull request link."
const EMPTY_COMMENT = 'Write a comment first.'

interface Call { url: string; method: string; contentType: string | null; body: any }

function adoServer(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: new Headers(init?.headers).get('content-type'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    calls.push(call)
    return respond(call)
  }
  const http = createAdoHttp({ fetch: fetch as typeof globalThis.fetch, authHeader: async () => 'Bearer test-credential' })
  return { http, calls }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function rejection(promise: Promise<unknown>): Promise<AdoError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof AdoError, `expected an AdoError, got ${String(error)}`)
    return error
  }
  return assert.fail('expected the call to fail')
}

function raw(fields: Record<string, unknown> = {}, relations?: RawWorkItem['relations']): RawWorkItem {
  return {
    id: 42,
    rev: 7,
    url: `${BASE}/_apis/wit/workItems/42`,
    fields: { 'System.TeamProject': 'Fabrikam Web', ...fields },
    relations
  }
}

function linked(id: number, title: string, project = 'Fabrikam Web'): RawWorkItem {
  return { id, rev: 1, url: '', fields: { 'System.Title': title, 'System.TeamProject': project } }
}

function itemLink(rel: string, id: number) {
  return { rel, url: `${BASE}/_apis/wit/workItems/${id}`, attributes: { name: 'Link' } }
}

function prLink(projectId: string, repoId: string, prId: number) {
  return { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${projectId}%2f${repoId}%2f${prId}`, attributes: { name: 'Pull Request' } }
}

const PARENT = 'System.LinkTypes.Hierarchy-Reverse'
const CHILD = 'System.LinkTypes.Hierarchy-Forward'
const RELATED = 'System.LinkTypes.Related'

function comment(id: number, html: string, author: string | null, createdDate: string) {
  return { id, text: html, createdBy: author === null ? undefined : { displayName: author }, createdDate }
}

function commentServer(comments: unknown[] = []) {
  return adoServer(() => reply(200, { comments, totalCount: comments.length }))
}

test('bodyOf converts description and acceptance criteria', () => {
  const body = bodyOf(raw({
    'System.Description': '<div>Let users <b>export</b> the grid.</div><ul><li>CSV</li><li>XLSX</li></ul><img src="https://cdn.contoso.test/mock.png">',
    'Microsoft.VSTS.Common.AcceptanceCriteria': '<ol><li>Header row</li><li>UTF-8</li></ol>'
  }), ITEM_URL)
  assert.equal(body.descriptionMd, `Let users **export** the grid.\n\n- CSV\n- XLSX\n\n[image](${ITEM_URL})`)
  assert.equal(body.acceptanceMd, '1. Header row\n2. UTF-8')
})

test('missing or non-text description fields become empty Markdown', () => {
  const body = bodyOf(raw({ 'System.Description': 12, 'Microsoft.VSTS.Common.AcceptanceCriteria': null }), ITEM_URL)
  assert.equal(body.descriptionMd, '')
  assert.equal(body.acceptanceMd, '')
})

test('description and acceptance criteria are each capped at 30000 characters', () => {
  const huge = '<p>0123456789</p>'.repeat(5000)
  const body = bodyOf(raw({ 'System.Description': huge, 'Microsoft.VSTS.Common.AcceptanceCriteria': huge }), ITEM_URL)
  for (const markdown of [body.descriptionMd, body.acceptanceMd]) {
    assert.ok(markdown.endsWith(SUFFIX))
    assert.ok(markdown.length <= 30_000 + SUFFIX.length + 2)
    assert.ok(markdown.length > 29_000)
  }
})

test("bodyOf reads the assignee's display and unique names", () => {
  const grace = { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', id: 'b2c3d4e5-6666-4b7c-9d8e-0f1a2b3c4d5e' }
  assert.deepEqual(bodyOf(raw({ 'System.AssignedTo': grace }), ITEM_URL).assignee, { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' })
  for (const assignedTo of [undefined, 'Grace Hopper', { displayName: 'Grace Hopper' }, { uniqueName: 'grace@contoso.example' }, { displayName: '', uniqueName: 'grace@contoso.example' }]) {
    assert.equal(bodyOf(raw({ 'System.AssignedTo': assignedTo }), ITEM_URL).assignee, null, JSON.stringify(assignedTo))
  }
})

test('comments are newest first, capped and converted', async () => {
  const comments = [
    comment(103, '<div>Looks <i>good</i><br>ship it</div>', 'Ada Lovelace', '2026-11-03T09:30:00Z'),
    comment(102, `<p>${'long '.repeat(2000)}</p>`.repeat(3), null, '2026-11-02T08:00:00.5Z'),
    comment(101, '<script>steal()</script>First!', 'Grace Hopper', '2026-11-01T07:15:00Z')
  ]
  const { http, calls } = commentServer(comments)
  const read = await readComments(http, ORG, PROJECT, 42, ITEM_URL)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, `${COMMENTS_URL}?$top=50&order=desc&api-version=7.1-preview.4`)
  assert.deepEqual(read.map(entry => entry.id), [103, 102, 101])
  assert.deepEqual(read.map(entry => entry.author), ['Ada Lovelace', 'Unknown', 'Grace Hopper'])
  assert.deepEqual(read.map(entry => entry.createdAt), [Date.parse('2026-11-03T09:30:00Z'), Date.parse('2026-11-02T08:00:00.5Z'), Date.parse('2026-11-01T07:15:00Z')])
  assert.equal(read[0].textMd, 'Looks *good*\nship it')
  assert.equal(read[2].textMd, 'First!')
  assert.ok(read[1].textMd.endsWith(SUFFIX))
  assert.ok(read[1].textMd.length <= 4000 + SUFFIX.length + 2)
  assert.ok(read[1].textMd.length > 3500)
})

test('at most 50 comments are returned', async () => {
  const comments = Array.from({ length: 60 }, (_, index) => comment(1000 - index, 'text', 'Ada', '2026-11-01T00:00:00Z'))
  const read = await readComments(commentServer(comments).http, ORG, PROJECT, 42, ITEM_URL)
  assert.equal(read.length, 50)
  assert.equal(read[0].id, 1000)
})

test('a malformed comment response is reported as such', async () => {
  for (const comments of [{ comments: 'nope' }, { comments: [null] }, { comments: [{ text: 'no id' }] }]) {
    const { http } = adoServer(() => reply(200, comments))
    const error = await rejection(readComments(http, ORG, PROJECT, 42, ITEM_URL))
    assert.equal(error.code, 'server')
    assert.equal(error.message, 'Azure DevOps returned an unexpected comment response.')
  }
})

test('links list parent, children, related and pull requests, titled from the linked records', () => {
  const relations = [
    itemLink(RELATED, 7),
    itemLink(CHILD, 11),
    prLink(OTHER_PROJECT, REPO, 55),
    itemLink(PARENT, 3),
    itemLink(CHILD, 12),
    itemLink(RELATED, 3),
    { rel: 'ArtifactLink', url: 'vstfs:///Git/Commit/abc%2fdef%2f0123', attributes: { name: 'Fixed in Commit' } },
    { rel: 'Hyperlink', url: 'https://example.com/spec' }
  ]
  const item = raw({}, relations)
  assert.deepEqual(linkedIds(item), [
    { kind: 'parent', id: 3 },
    { kind: 'child', id: 11 },
    { kind: 'child', id: 12 },
    { kind: 'related', id: 7 },
    { kind: 'related', id: 3 }
  ])
  const records = [linked(3, 'Reporting epic'), linked(11, 'Wire up the endpoint'), linked(7, 'Billing export', 'Contoso Ops')]
  assert.deepEqual(linkRows(ORG, item, records, [], HOME), [
    { kind: 'parent', title: 'Reporting epic', url: `${BASE}/Fabrikam%20Web/_workitems/edit/3` },
    { kind: 'child', title: 'Wire up the endpoint', url: `${BASE}/Fabrikam%20Web/_workitems/edit/11` },
    { kind: 'child', title: '#12', url: `${BASE}/Fabrikam%20Web/_workitems/edit/12` },
    { kind: 'related', title: 'Billing export', url: `${BASE}/Contoso%20Ops/_workitems/edit/7` },
    { kind: 'related', title: 'Reporting epic', url: `${BASE}/Fabrikam%20Web/_workitems/edit/3` },
    { kind: 'pr', title: 'Pull request 55', url: `${BASE}/${OTHER_PROJECT}/_git/${REPO}/pullrequest/55` }
  ])
})

test('an item with no linked work items lists only its pull requests', () => {
  const item = raw({}, [prLink(PROJECT, REPO, 8)])
  assert.deepEqual(linkedIds(item), [])
  assert.deepEqual(linkRows(ORG, item, [], [], HOME), [{ kind: 'pr', title: 'Pull request 8', url: `${BASE}/${PROJECT}/_git/${REPO}/pullrequest/8` }])
})

test('a pull request link shows the state of the pull request when it is known', () => {
  const merged = { prId: 8, repoId: REPO, projectId: PROJECT, target: 'main', state: 'merged' as const, build: 'none' as const, url: '' }
  const rows = linkRows(ORG, raw({}, [prLink(PROJECT, REPO, 8), prLink(PROJECT, REPO, 9)]), [], [merged], HOME)
  assert.deepEqual(rows.map(link => link.title), ['Pull request 8 (merged)', 'Pull request 9'])
})

test('linked items without a record show their ids in the home project', () => {
  const rows = linkRows(ORG, raw({}, [itemLink(PARENT, 3), itemLink(CHILD, 11)]), [], [], 'Contoso Ops')
  assert.deepEqual(rows, [
    { kind: 'parent', title: '#3', url: `${BASE}/Contoso%20Ops/_workitems/edit/3` },
    { kind: 'child', title: '#11', url: `${BASE}/Contoso%20Ops/_workitems/edit/11` }
  ])
})

test('a pull request link that cannot be resolved keeps the relation url', () => {
  const unresolvable = { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/not-a-reference' }
  assert.deepEqual(linkRows(ORG, raw({}, [unresolvable]), [], [], HOME), [{ kind: 'pr', title: 'Pull request', url: unresolvable.url }])
})

test('addComment escapes HTML and refuses empty text', async () => {
  const { http, calls } = adoServer(() => reply(200, {
    id: 9,
    text: '<div>if a &lt; b &amp;&amp; c<br>done</div>',
    createdBy: { displayName: 'Ada Lovelace' },
    createdDate: '2026-11-04T10:00:00Z'
  }))
  const added = await addComment(http, ORG, PROJECT, 42, `if a < b && c > "d" it's <script>x</script>\nnext\r\nline`)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, `${COMMENTS_URL}?api-version=7.1-preview.4`)
  assert.equal(calls[0].contentType, 'application/json')
  assert.deepEqual(calls[0].body, {
    text: `if a &lt; b &amp;&amp; c &gt; &quot;d&quot; it&#39;s &lt;script&gt;x&lt;/script&gt;<br>next<br>line`
  })
  assert.deepEqual(added, { id: 9, author: 'Ada Lovelace', createdAt: Date.parse('2026-11-04T10:00:00Z'), textMd: 'if a \\< b && c\ndone' })

  for (const blank of ['', '   ', '\n\t \r\n', ' ']) {
    const error = await rejection(addComment(http, ORG, PROJECT, 42, blank))
    assert.equal(error.code, 'bad_request')
    assert.equal(error.status, 400)
    assert.equal(error.message, EMPTY_COMMENT)
  }
  assert.equal(calls.length, 1)
})

test('a malformed added comment is reported as such', async () => {
  for (const body of [{ text: 'no id' }, undefined]) {
    const { http } = adoServer(() => (body === undefined ? new Response(null, { status: 204 }) : reply(200, body)))
    const error = await rejection(addComment(http, ORG, PROJECT, 42, 'hello'))
    assert.equal(error.code, 'server')
    assert.equal(error.message, 'Azure DevOps returned an unexpected comment response.')
  }
})

function prServer(opts: { repoId?: string; projectId?: string; rev?: number; patchStatus?: number } = {}) {
  return adoServer(call => {
    if (call.method === 'PATCH') {
      return opts.patchStatus ? reply(opts.patchStatus, { message: 'TF26071: changed' }) : reply(200, { id: 42, rev: opts.rev ?? 8, fields: {} })
    }
    return reply(200, {
      pullRequestId: 55,
      repository: { id: opts.repoId ?? REPO, project: { id: opts.projectId ?? OTHER_PROJECT } }
    })
  })
}

const PR_URL = `${BASE}/Contoso%20Ops/_git/web-app/pullrequest/55`

async function linkPr(http: AdoHttp, prUrl: string, item: RawWorkItem = raw()): Promise<number> {
  return addPullRequestLink(http, ORG, PROJECT, item, await resolvePullRequest(http, ORG, prUrl))
}

test('the link tests the rev of the item it was given', async () => {
  const { http, calls } = prServer({ rev: 12 })
  assert.equal(await linkPr(http, PR_URL, { ...raw(), rev: 11 }), 12)
  assert.deepEqual(calls[1].body[0], { op: 'test', path: '/rev', value: 11 })
})

test('linkPr adds an ArtifactLink relation with the rev test and rejects non-PR URLs', async () => {
  const { http, calls } = prServer({ rev: 9 })
  const rev = await linkPr(http, PR_URL)
  assert.equal(rev, 9)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, `${BASE}/Contoso%20Ops/_apis/git/repositories/web-app/pullrequests/55?api-version=7.1`)
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].url, `${BASE}/${PROJECT}/_apis/wit/workitems/42?api-version=7.1`)
  assert.equal(calls[1].contentType, 'application/json-patch+json')
  assert.deepEqual(calls[1].body, [
    { op: 'test', path: '/rev', value: 7 },
    {
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'ArtifactLink',
        url: `vstfs:///Git/PullRequestId/${OTHER_PROJECT}%2F${REPO}%2F55`,
        attributes: { name: 'Pull Request' }
      }
    }
  ])

  const rejected = [
    '',
    'not a link',
    `${BASE}/Contoso%20Ops/_git/web-app`,
    `${BASE}/Contoso%20Ops/_git/web-app/pullrequests`,
    `${BASE}/Contoso%20Ops/_git/web-app/pullrequest/abc`,
    `${BASE}/Contoso%20Ops/_git/web-app/pullrequest/0`,
    `${BASE}/Contoso%20Ops/_git/web-app/pullrequest/12abc`,
    `${BASE}/Contoso%20Ops/_workitems/edit/42`,
    `${BASE}/_git/web-app/pullrequest/55`,
    'https://github.com/contoso/web-app/pull/55',
    'http://dev.azure.com/contoso/Ops/_git/web-app/pullrequest/55',
    'https://evil.example/contoso/Ops/_git/web-app/pullrequest/55',
    'https://dev.azure.com.evil.example/contoso/Ops/_git/web-app/pullrequest/55',
    'https://contoso.visualstudio.com.evil.example/Ops/_git/web-app/pullrequest/55',
    `${BASE}/Contoso%20Ops/_git/%E0%A4%A/pullrequest/55`
  ]
  for (const prUrl of rejected) {
    const error = await rejection(linkPr(http, prUrl))
    assert.equal(error.code, 'bad_request', prUrl)
    assert.equal(error.status, 400)
    assert.equal(error.message, NOT_A_PR)
  }
  assert.equal(calls.length, 2)
})

test('linkPr accepts both URL forms, trailing segments and queries, and decodes names', async () => {
  const urls = [
    `${BASE}/Contoso%20Ops/_git/web%20app/pullrequest/55`,
    `${BASE}/Contoso%20Ops/_git/web%20app/pullrequest/55/files`,
    `${BASE}/Contoso%20Ops/_git/web%20app/pullrequest/55?_a=files`,
    `${BASE}/Contoso%20Ops/_git/web%20app/pullrequest/55/?_a=overview#discussion`,
    `https://dev.azure.com/CONTOSO/Contoso%20Ops/_git/web%20app/pullrequest/55`,
    `https://contoso.visualstudio.com/Contoso%20Ops/_git/web%20app/pullrequest/55`,
    `https://Contoso.visualstudio.com/Contoso%20Ops/_git/web%20app/pullrequest/55?_a=files`
  ]
  for (const prUrl of urls) {
    const { http, calls } = prServer()
    await linkPr(http, prUrl)
    assert.equal(calls[0].url, `${BASE}/Contoso%20Ops/_apis/git/repositories/web%20app/pullrequests/55?api-version=7.1`, prUrl)
    assert.equal(calls[1].method, 'PATCH', prUrl)
  }
})

test('a pull request from another organization is refused before any request', async () => {
  const { http, calls } = prServer()
  for (const prUrl of [
    'https://dev.azure.com/fabrikam/Ops/_git/web-app/pullrequest/55',
    'https://fabrikam.visualstudio.com/Ops/_git/web-app/pullrequest/55'
  ]) {
    const error = await rejection(linkPr(http, prUrl))
    assert.equal(error.code, 'bad_request')
    assert.equal(error.message, NOT_A_PR)
  }
  assert.equal(calls.length, 0)
})

test('linkPr leaves an already linked pull request alone', async () => {
  const existing = { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${OTHER_PROJECT.toUpperCase()}%2F${REPO}%2F55`, attributes: { name: 'Pull Request' } }
  const { http, calls } = prServer()
  const rev = await linkPr(http, PR_URL, raw({}, [itemLink(PARENT, 3), existing]))
  assert.equal(rev, 7)
  assert.deepEqual(calls.map(call => call.method), ['GET'])
})

test('linkPr reports a stale rev as the refresh-and-retry conflict', async () => {
  for (const patchStatus of [409, 412]) {
    const { http } = prServer({ patchStatus })
    const error = await rejection(linkPr(http, PR_URL))
    assert.equal(error.code, 'conflict')
    assert.equal(error.status, 409)
    assert.equal(error.message, CONFLICT_MESSAGE)
  }
})

test('linkPr surfaces a pull request that cannot be read or is malformed', async () => {
  const missing = adoServer(() => reply(404, { message: 'TF401180: not found' }))
  assert.equal((await rejection(linkPr(missing.http, PR_URL))).code, 'not_found')
  assert.equal(missing.calls.length, 1)

  for (const body of [{}, { repository: {} }, { repository: { id: REPO } }, { repository: { id: REPO, project: {} } }]) {
    const { http, calls } = adoServer(() => reply(200, body))
    const error = await rejection(linkPr(http, PR_URL))
    assert.equal(error.code, 'server')
    assert.equal(error.message, 'Azure DevOps returned an unexpected pull request response.')
    assert.equal(calls.length, 1)
  }
})

test('linkPr returns the hydrated item rev when the pull request is already linked', async () => {
  const existing = { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${OTHER_PROJECT}%2F${REPO}%2F55`, attributes: { name: 'Pull Request' } }
  const { http, calls } = prServer()
  const rev = await linkPr(http, PR_URL, { ...raw({}, [existing]), rev: 9 })
  assert.equal(rev, 9)
  assert.deepEqual(calls.map(call => call.method), ['GET'])
})

test('linkPr refuses a pull request whose repository or project id is empty', async () => {
  for (const ids of [{ repoId: '' }, { projectId: '' }]) {
    const { http, calls } = prServer(ids)
    const error = await rejection(linkPr(http, PR_URL))
    assert.equal(error.code, 'server')
    assert.equal(error.message, 'Azure DevOps returned an unexpected pull request response.')
    assert.deepEqual(calls.map(call => call.method), ['GET'])
  }
})
