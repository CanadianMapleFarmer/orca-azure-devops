import { assert, test } from 'orca/testing'
import type { PrSummary } from '../prs'
import { parsePrItemKey, prItemKey, prShareItem } from './pr-items'
import { PR_VARS } from './template'

const PR: PrSummary = {
  org: 'contoso',
  projectId: '4c1f0a52-0000-4000-8000-000000000001',
  projectName: 'Fabrikam Web',
  repoId: '5f3a9c1e-1111-4a2b-8c3d-4e5f6a7b8c9d',
  repoName: 'web-app',
  prId: 123396,
  title: '[PROJ-55283] Reserve a line',
  url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396',
  source: 'feature/PROJ-55283-login',
  target: 'develop',
  status: 'active',
  isDraft: false,
  mergeStatus: 'ok',
  createdBy: { id: '9d1c2b3a', name: 'Alex Morgan' },
  createdAt: 0,
  closedAt: null,
  reviewers: [],
  autoComplete: false,
  workItemIds: [],
  checks: null
}

test('prItemKey round-trips and prShareItem fills the variables', () => {
  const key = prItemKey(PR)
  assert.equal(key, 'pr:4c1f0a52-0000-4000-8000-000000000001/5f3a9c1e-1111-4a2b-8c3d-4e5f6a7b8c9d/123396')
  assert.deepEqual(parsePrItemKey(key), { projectId: PR.projectId, repoId: PR.repoId, prId: 123396 })

  const item = prShareItem(PR)
  assert.equal(item.key, key)
  assert.deepEqual(item.vars, {
    id: '123396',
    title: '[PROJ-55283] Reserve a line',
    url: PR.url,
    repo: 'web-app',
    project: 'Fabrikam Web',
    source: 'feature/PROJ-55283-login',
    target: 'develop',
    author: 'Alex Morgan'
  })
  assert.deepEqual(Object.keys(item.vars).sort(), [...PR_VARS].sort())
})

test('parsePrItemKey rejects anything that is not a pull request key', () => {
  for (const key of ['', 'pr:', 'pr:a/b', 'pr:a/b/c', 'pr:a/b/0', 'pr:a/b/-1', 'pr:a/b/1.5', 'pr:a/b/01', 'pr:/b/1', 'pr:a//1', 'pr:a/b/1/2', 'wi:a/b/1', 'xpr:a/b/1', 'pr:a/b/99999999999999999999']) {
    assert.equal(parsePrItemKey(key), null, key)
  }
})
