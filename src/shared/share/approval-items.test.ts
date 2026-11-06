import { assert, test } from 'orca/testing'
import { APPROVAL_4520 as APPROVAL, APPROVAL_ID, RUN_4520 as RUN, RUN_URL as URL } from './approval-fixtures'
import { APPROVAL_TEMPLATE, APPROVAL_VARS, approvalItemKey, approvalShareItem, parseApprovalItemKey } from './approval-items'
import { buildMessage, toHtml, toMarkdown, toPlain } from './message'

const build = (template: string) =>
  buildMessage({ template, fallback: APPROVAL_TEMPLATE, vars: APPROVAL_VARS, intro: '', items: [approvalShareItem(RUN, APPROVAL)] })

test('the default approval template gives the reference-style line', () => {
  const { message, warning } = build(APPROVAL_TEMPLATE)
  assert.equal(warning, undefined)
  assert.equal(APPROVAL_TEMPLATE, 'Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}')
  assert.equal(
    toHtml(message),
    `<div>Approval needed for production: <a href="${URL}">web-app-cd 20261105.3</a> on main</div>`
  )
  assert.equal(toPlain(message), `Approval needed for production: web-app-cd 20261105.3 on main ${URL}`)
  assert.equal(toMarkdown(message), `Approval needed for production: [web-app-cd 20261105.3](${URL}) on main`)
})

test('approvalShareItem fills every variable', () => {
  const item = approvalShareItem(RUN, APPROVAL)
  assert.equal(item.key, `approval:proj-web/${APPROVAL_ID}`)
  assert.deepEqual(item.vars, {
    pipeline: 'web-app-cd',
    run: '20261105.3',
    url: URL,
    environment: 'production',
    stage: 'Deploy production',
    branch: 'main',
    requestedBy: 'Grace Hopper',
    project: 'Fabrikam Web'
  })
  assert.deepEqual(Object.keys(item.vars).sort(), [...APPROVAL_VARS].sort())
})

test('approvalItemKey round-trips', () => {
  const key = approvalItemKey(APPROVAL)
  assert.equal(key, `approval:proj-web/${APPROVAL_ID}`)
  assert.deepEqual(parseApprovalItemKey(key), { projectId: 'proj-web', approvalId: APPROVAL_ID })
  for (const bad of ['', 'approval:', 'approval:a', 'approval:a/', 'approval:/b', 'approval:a/b/c', 'pr:a/b/1', 'xapproval:a/b', ' approval:a/b']) {
    assert.equal(parseApprovalItemKey(bad), null, bad)
  }
})

test('the environment falls back to the stage', () => {
  const stageOnly = approvalShareItem(RUN, { ...APPROVAL, environment: null })
  assert.equal(stageOnly.vars.environment, 'Deploy production')
  assert.equal(stageOnly.vars.stage, 'Deploy production')
  const neither = approvalShareItem(RUN, { ...APPROVAL, environment: null, stage: null })
  assert.deepEqual([neither.vars.environment, neither.vars.stage], ['', ''])
})
