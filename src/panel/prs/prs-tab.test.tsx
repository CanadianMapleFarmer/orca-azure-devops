import { afterEach, assert, hostError, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { PrSummary, RowResult } from '../../shared/prs'
import type { OrgStatus } from '../../shared/types'
import { closeCleanly, mountPanel, org, requestsTo, type TestHost } from '../test-support'
import { NOW, OPTIONS, prOf, reviewerOf, setOf, snapshotOf } from './fixtures'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  visible?: boolean
  tab?: string
}

async function open(snapshot: MockRequests['prs.snapshot'], more: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    { 'prs.snapshot': snapshot, ...more },
    { visible: options.visible, persisted: { workspace: { tab: options.tab ?? 'prs' } } }
  )
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const titles = () => panel.findAll({ type: 'Card' }).map(card => card.label)

const rowText = (prId: number) => panel.find({ type: 'Row', text: new RegExp(`^Pull Request ${prId} →`) })?.text

const toneOf = (text: string | RegExp) => panel.find({ type: 'Badge', text })?.props.tone

const keyOf = (prId: number) => ({ projectId: 'proj-web', repoId: 'repo-web', prId })

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const KEPT = 'Azure DevOps is unreachable. Showing the last results.'

const mixedSet = () =>
  setOf(
    [
      prOf(55, {
        target: 'develop',
        autoComplete: true,
        checks: { build: 'succeeded', policies: 'approved' },
        reviewers: [reviewerOf('Grace Hopper', 10), reviewerOf('Linus Torvalds', 5), reviewerOf('Edsger Dijkstra', 0, { isRequired: true })]
      }),
      prOf(56, {
        target: 'qa',
        isDraft: true,
        mergeStatus: 'conflicts',
        checks: { build: 'failed', policies: 'rejected' },
        reviewers: [reviewerOf('Margaret Hamilton', -10)]
      }),
      prOf(57, { target: 'main', status: 'completed', closedAt: NOW - 60_000 }),
      prOf(58, { target: 'develop', repoId: 'repo-api', repoName: 'api', checks: { build: 'running', policies: 'pending' } })
    ],
    { title: 'Fix the sign-in redirect', sources: ['feature/login', 'hotfix/login'] }
  )

test('sets show one row per PR with target, checks, votes and auto-complete', async () => {
  await open(snapshotOf({ sets: [mixedSet()] }))
  assert.deepEqual(titles(), ['Fix the sign-in redirect'])
  assert.equal(panel.findAll({ type: 'Card' })[0]?.props.description, 'feature/login, hotfix/login · web-app, api')
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => [link.text, link.props.href]),
    [55, 56, 57, 58].map(id => [`Pull Request ${id}`, `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${id}`])
  )
  assert.equal(rowText(55), 'Pull Request 55 → develop ✓ build 2 approved waiting for Edsger Dijkstra auto-complete')
  assert.equal(rowText(56), 'Pull Request 56 → qa draft conflicts ✗ build ✗ policies 1 rejected')
  assert.equal(rowText(57), 'Pull Request 57 → main merged ✓')
  assert.equal(rowText(58), 'Pull Request 58 → develop ● build · policies')
  assert.equal(toneOf('merged ✓'), 'success')
  assert.equal(toneOf('draft'), 'neutral')
  assert.equal(toneOf('conflicts'), 'danger')
  assert.equal(toneOf('✓ build'), 'success')
  assert.equal(toneOf('✗ build'), 'danger')
  assert.equal(toneOf('● build'), 'warning')
  assert.equal(toneOf('✗ policies'), 'danger')
  assert.equal(toneOf('· policies'), 'neutral')
  assert.equal(toneOf('2 approved'), 'success')
  assert.equal(toneOf('1 rejected'), 'danger')
  assert.equal(toneOf('waiting for Edsger Dijkstra'), 'warning')
  assert.equal(toneOf('auto-complete'), 'accent')
  assert.equal(panel.findAll({ type: 'Badge', text: 'auto-complete' }).length, 1)
})

test('only a required reviewer who has not decided counts as waited for', async () => {
  const pr = prOf(55, {
    reviewers: [
      reviewerOf('Ada Optional', 0),
      reviewerOf('Declined Required', 0, { isRequired: true, hasDeclined: true }),
      reviewerOf('Approved Required', 10, { isRequired: true }),
      reviewerOf('Rejected Required', -10, { isRequired: true }),
      reviewerOf('Author Required', -5, { isRequired: true })
    ]
  })
  await open(snapshotOf({ sets: [setOf([pr])] }))
  assert.equal(rowText(55), 'Pull Request 55 → develop 1 approved 1 rejected waiting for Author Required')
})

test('several waited-for reviewers share one badge', async () => {
  const pr = prOf(55, { reviewers: [reviewerOf('Edsger Dijkstra', 0, { isRequired: true }), reviewerOf('Barbara Liskov', -5, { isRequired: true })] })
  await open(snapshotOf({ sets: [setOf([pr])] }))
  assert.equal(rowText(55), 'Pull Request 55 → develop waiting for Edsger Dijkstra, Barbara Liskov')
})

test('Approve all sends prs.approve with the set\'s active PRs and shows each row\'s result', async () => {
  const results: RowResult[] = [
    { prId: 55, ok: true, message: 'Approved.' },
    { prId: 56, ok: true, warn: true, message: 'Already set to auto-complete. It will delete the source branch Pull Request 59 also uses.' },
    { prId: 59, ok: false, message: 'You need Contribute access to approve.' }
  ]
  const host = await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56), prOf(57, { status: 'completed', closedAt: NOW }), prOf(59, { isDraft: true })])] }), {
    'prs.approve': { results }
  })
  assert.equal(panel.find({ type: 'Callout' }), null)
  await panel.press({ type: 'Button', text: 'Approve all' })
  assert.deepEqual(inputsTo(host, 'prs.approve'), [{ org: 'contoso', prs: [keyOf(55), keyOf(56), keyOf(59)] }])
  assert.equal(requestsTo(host, 'prs.approve')[0]?.timeoutMs, 90000)
  assert.equal(requestsTo(host, 'prs.autoComplete').length, 0)
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'warning')
  const rows = panel.findAll({ type: 'Text', text: /^Pull Request \d+: / })
  assert.deepEqual(
    rows.map(row => [row.text, row.props.tone]),
    [
      ['Pull Request 55: Approved.', 'success'],
      ['Pull Request 56: Already set to auto-complete. It will delete the source branch Pull Request 59 also uses.', 'warning'],
      ['Pull Request 59: You need Contribute access to approve.', 'danger']
    ]
  )
})

test('Auto-complete all sends prs.autoComplete; the options line reflects the snapshot', async () => {
  const options = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true } as const
  const host = await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56)])], autoComplete: options }), {
    'prs.autoComplete': {
      results: [
        { prId: 55, ok: true, message: 'Auto-complete set.' },
        { prId: 56, ok: true, message: 'Auto-complete set. Source branch kept: Pull Request 55 also uses it.' }
      ]
    }
  })
  const line = () => panel.find({ type: 'Text', text: /^Auto-complete uses/ })
  assert.equal(line()?.text, 'Auto-complete uses Squash commit, deletes the source branch, completes linked work items. Change this in Settings → Azure DevOps.')
  assert.equal(line()?.props.muted, true)
  await panel.press({ type: 'Button', text: 'Auto-complete all' })
  assert.deepEqual(inputsTo(host, 'prs.autoComplete'), [{ org: 'contoso', prs: [keyOf(55), keyOf(56)] }])
  assert.equal(requestsTo(host, 'prs.autoComplete')[0]?.timeoutMs, 90000)
  assert.equal(requestsTo(host, 'prs.approve').length, 0)
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'success')
  assert.equal(panel.findAll({ type: 'Text', text: /^Pull Request \d+: / }).length, 2)

  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(55), prOf(56)])], autoComplete: { ...OPTIONS, mergeStrategy: 'rebaseMerge' } }))
  assert.equal(line()?.text, 'Auto-complete uses Semi-linear merge, keeps the source branch, leaves work items alone. Change this in Settings → Azure DevOps.')
})

test('the options line names each merge type', async () => {
  const labels = { noFastForward: 'Merge (no fast-forward)', squash: 'Squash commit', rebase: 'Rebase and fast-forward', rebaseMerge: 'Semi-linear merge' } as const
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }))
  for (const [strategy, label] of Object.entries(labels)) {
    await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(55)])], autoComplete: { ...OPTIONS, mergeStrategy: strategy as keyof typeof labels } }))
    assert.ok(panel.find({ type: 'Text', text: new RegExp(`^Auto-complete uses ${label.replace(/[()]/g, '\\$&')}, `) }), strategy)
  }
})

test('a failed action shows the message and frees the buttons', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }), {
    'prs.approve': () => {
      throw hostError('action_failed', 'Azure DevOps refused the request.')
    }
  })
  await panel.press({ type: 'Button', text: 'Approve all' })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps refused the request.')
  assert.equal(panel.find({ type: 'Button', text: 'Approve all' })?.disabled, false)
})

test('both buttons are disabled while an action runs and when no PR qualifies', async () => {
  let release: (value: { results: RowResult[] }) => void = () => {}
  const held = new Promise<{ results: RowResult[] }>(resolve => {
    release = resolve
  })
  await open(snapshotOf({ sets: [setOf([prOf(55)]), setOf([prOf(60)]), setOf([prOf(70, { status: 'completed', closedAt: NOW })])] }), { 'prs.approve': () => held })
  const buttons = (text: string) => panel.findAll({ type: 'Button', text }).map(button => button.disabled)
  assert.deepEqual(buttons('Approve all'), [false, false, true])
  assert.deepEqual(buttons('Auto-complete all'), [false, false, true])
  const pending = panel.press(panel.findAll({ type: 'Button', text: 'Approve all' })[0])
  await pause(10)
  assert.deepEqual(buttons('Approve all'), [true, false, true])
  assert.deepEqual(buttons('Auto-complete all'), [true, false, true])
  release({ results: [{ prId: 55, ok: true, message: 'Approved.' }] })
  await pending
  assert.deepEqual(buttons('Approve all'), [false, false, true])
})

test('an action result stays with its PRs when the set key changes and is never persisted', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56)], { key: 'contoso:55' })] }), {
    'prs.approve': { results: [{ prId: 55, ok: true, message: 'Approved.' }, { prId: 56, ok: true, message: 'Approved.' }] }
  })
  await panel.press({ type: 'Button', text: 'Approve all' })
  assert.equal(panel.findAll({ type: 'Text', text: /^Pull Request \d+: / }).length, 2)
  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(56), prOf(57)], { key: 'contoso:56' })], updatedAt: NOW + 1 }))
  assert.equal(panel.findAll({ type: 'Text', text: /^Pull Request \d+: / }).length, 2)
  assert.deepEqual(panel.persisted, { plugin: {}, workspace: { tab: 'prs' }, storage: {} })
})

test('prs.changed replaces the sets; a stale snapshot keeps them with the warning', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'First' })])] }))
  assert.deepEqual(titles(), ['First'])
  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(60, { title: 'Second' })]), setOf([prOf(61, { title: 'Third' })])], updatedAt: NOW + 1 }))
  assert.deepEqual(titles(), ['Second', 'Third'])

  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(60, { title: 'Second' })])], stale: true, message: KEPT, updatedAt: NOW + 1 }))
  assert.deepEqual(titles(), ['Second'])
  const warning = panel.find({ type: 'Text', text: KEPT })
  assert.equal(warning?.props.tone, 'warning')

  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(60, { title: 'Second' })])], message: 'Some pull requests were left out.', updatedAt: NOW + 2 }))
  const note = panel.find({ type: 'Text', text: 'Some pull requests were left out.' })
  assert.equal(note?.props.muted, true)
  assert.equal(note?.props.tone, undefined)
  assert.equal(panel.find({ type: 'Text', text: KEPT }), null)
})

test('prs.changed for another org is ignored', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'Mine' })])] }))
  await panel.post('prs.changed', snapshotOf({ org: 'fabrikam', sets: [setOf([prOf(90, { title: 'Theirs' })])] }))
  assert.deepEqual(titles(), ['Mine'])
})

test('Refresh asks for prs.refresh and shows the result; a failure shows its message', async () => {
  let refreshes = 0
  const host = await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'Before' })])] }), {
    'prs.refresh': () => {
      refreshes += 1
      if (refreshes > 1) throw hostError('action_failed', 'Azure DevOps is unreachable.')
      return snapshotOf({ sets: [setOf([prOf(55, { title: 'After' })])], updatedAt: NOW + 1 })
    }
  })
  await panel.press({ label: 'Refresh' })
  assert.deepEqual(inputsTo(host, 'prs.refresh'), [{ org: 'contoso' }])
  assert.deepEqual(titles(), ['After'])
  await panel.press({ label: 'Refresh' })
  assert.deepEqual(titles(), ['After'])
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
  assert.equal(panel.find({ label: 'Refresh' })?.disabled, false)
})

test('the header shows when the list was updated', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }))
  const updated = panel.find({ type: 'Text', text: /^Updated/ })
  assert.equal(updated?.props.muted, true)
  assert.ok(panel.find({ type: 'RelativeTime' }))
})

test('a failed first load shows the message and Try again loads again', async () => {
  let loads = 0
  await open(() => {
    loads += 1
    if (loads === 1) throw hostError('action_failed', 'Azure DevOps is unreachable.')
    return snapshotOf({ sets: [setOf([prOf(55, { title: 'Back' })])] })
  })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.deepEqual(titles(), ['Back'])
})

test('To review opens a PR in the browser on press', async () => {
  const toReview = [prOf(80, { title: 'Cache the lookups', repoName: 'api', createdBy: { id: 'u-grace', name: 'Grace Hopper' } }), prOf(81, { title: 'Fix the footer' })]
  const host = await open(snapshotOf({ toReview, toReviewCount: 2 }))
  assert.equal(panel.find({ type: 'ListItem' }), null)
  await panel.toggle({ type: 'Collapsible', label: 'To review (2)' })
  const items = panel.findAll({ type: 'ListItem' })
  assert.deepEqual(items.map(item => [item.label, item.props.description]), [
    ['Cache the lookups', 'Pull Request 80 · api · Grace Hopper'],
    ['Fix the footer', 'Pull Request 81 · web-app · Ada Lovelace']
  ])
  await panel.press({ type: 'ListItem', label: 'Cache the lookups' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: toReview[0].url }])
})

test('To review shows at most 50 pull requests and says how many there are', async () => {
  const toReview = Array.from({ length: 60 }, (_, index) => prOf(100 + index, { title: `Review ${index}` }))
  await open(snapshotOf({ toReview, toReviewCount: 75 }))
  await panel.toggle({ type: 'Collapsible' })
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 50)
  assert.ok(panel.find({ type: 'Collapsible', label: 'To review (75)' }))
  assert.equal(panel.find({ type: 'Text', text: 'Showing 50 of 75 pull requests.' })?.props.muted, true)
})

test('an empty To review list is not shown', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }))
  assert.equal(panel.find({ type: 'Collapsible' }), null)
})

test('no sets shows the empty state', async () => {
  await open(snapshotOf())
  const empty = panel.find({ type: 'EmptyState' })
  assert.equal(empty?.label, 'No open pull requests of yours')
  assert.equal(empty?.props.description, "Pull requests you create in this organization's code projects show up here.")
  assert.equal(panel.find({ type: 'Card' }), null)
  assert.equal(panel.find({ type: 'Text', text: /^Auto-complete uses/ }), null)
})

test('more than 30 sets shows the cap note', async () => {
  const sets = Array.from({ length: 45 }, (_, index) => setOf([prOf(200 + index, { title: `Set ${index}` })]))
  await open(snapshotOf({ sets }))
  assert.equal(titles().length, 30)
  assert.equal(titles()[29], 'Set 29')
  assert.equal(panel.find({ type: 'Text', text: 'Showing 30 of 45 sets.' })?.props.muted, true)
})

test('thirty sets show no cap note', async () => {
  await open(snapshotOf({ sets: Array.from({ length: 30 }, (_, index) => setOf([prOf(200 + index)])) }))
  assert.equal(titles().length, 30)
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
})

test('only the selected tab is drawn, so the tabs never add up past the node limit', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'Hidden title' })])] }))
  const drawn = (text: string) => JSON.stringify(panel.tree()).includes(text)
  assert.equal(drawn('Hidden title'), true)
  assert.equal(drawn('Coming in a later update'), false)
  await panel.select({ type: 'Tabs' }, 'work')
  assert.equal(drawn('Hidden title'), false)
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.equal(drawn('Hidden title'), true)
})

test('rows are capped so the render stays within the node limit', async () => {
  const everything: Partial<PrSummary> = {
    autoComplete: true,
    checks: { build: 'failed', policies: 'rejected' },
    isDraft: true,
    mergeStatus: 'conflicts',
    reviewers: [
      reviewerOf('Grace Hopper', 10),
      reviewerOf('Margaret Hamilton', -10),
      reviewerOf('Edsger Dijkstra', 0, { isRequired: true }),
      reviewerOf('Barbara Liskov', 0, { isRequired: true })
    ]
  }
  const sets = Array.from({ length: 30 }, (_, index) => setOf(Array.from({ length: 12 }, (_, row) => prOf(1000 + index * 100 + row, everything)), { key: `contoso:${index}` }))
  const toReview = Array.from({ length: 100 }, (_, index) => prOf(9000 + index))
  await open(snapshotOf({ sets, toReview, toReviewCount: 100 }))
  await panel.toggle({ type: 'Collapsible' })
  assert.deepEqual(panel.errors, [])
  assert.equal(titles().length, 12)
  assert.equal(panel.findAll({ type: 'Link' }).length, 144)
  assert.equal(panel.find({ type: 'Text', text: /^Showing 12/ })?.text, 'Showing 12 of 30 sets.')
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 50)
})

test('the first set is always shown, however many PRs it holds', async () => {
  const prs = Array.from({ length: 160 }, (_, index) => prOf(300 + index))
  await open(snapshotOf({ sets: [setOf(prs), setOf([prOf(900)])] }))
  assert.equal(titles().length, 1)
  assert.equal(panel.findAll({ type: 'Link' }).length, 160)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 1 of 2 sets.' })?.props.muted, true)
})

test('visibility changes call ui.visibility with surface prs', async () => {
  const host = await open(input => snapshotOf({ org: input.org }), {}, { orgs: [org('contoso'), org('fabrikam')] })
  const calls = () => inputsTo(host, 'ui.visibility').filter(input => (input as { surface: string }).surface === 'prs')
  assert.deepEqual(calls(), [{ surface: 'prs', org: 'contoso', visible: true }])

  await panel.rerender()
  assert.equal(calls().length, 1)

  await panel.setVisible(false)
  await panel.setVisible(false)
  assert.deepEqual(calls().slice(1), [{ surface: 'prs', org: 'contoso', visible: false }])

  await panel.setVisible(true)
  await panel.select({ type: 'Tabs' }, 'work')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.deepEqual(calls().slice(2), [
    { surface: 'prs', org: 'contoso', visible: true },
    { surface: 'prs', org: 'contoso', visible: false },
    { surface: 'prs', org: 'contoso', visible: true }
  ])

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(calls().slice(5), [
    { surface: 'prs', org: 'contoso', visible: false },
    { surface: 'prs', org: 'fabrikam', visible: true }
  ])
})

test('a panel that starts hidden loads and reports nothing until it is shown', async () => {
  const host = await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'Late' })])] }), {}, { visible: false })
  assert.deepEqual(requestsTo(host, 'ui.visibility'), [])
  assert.deepEqual(requestsTo(host, 'prs.snapshot'), [])
  await panel.setVisible(true)
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [{ surface: 'prs', org: 'contoso', visible: true }])
  assert.deepEqual(titles(), ['Late'])
})

test('the snapshot waits for the PRs tab and is asked for once', async () => {
  const host = await open(snapshotOf({ sets: [setOf([prOf(55)])] }), {}, { tab: 'work' })
  assert.deepEqual(requestsTo(host, 'prs.snapshot'), [])
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.deepEqual(inputsTo(host, 'prs.snapshot'), [{ org: 'contoso' }])
  await panel.select({ type: 'Tabs' }, 'work')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.equal(requestsTo(host, 'prs.snapshot').length, 1)
  assert.deepEqual(titles(), ['Change 55'])
})

test('settings hide the PRs surface and closing the panel does too', async () => {
  const host = await open(snapshotOf(), { 'ado.projects': [], 'ado.teams': [] })
  await panel.press({ label: 'Organization settings' })
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [
    { surface: 'prs', org: 'contoso', visible: true },
    { surface: 'prs', org: 'contoso', visible: false }
  ])
  await panel.press({ text: 'Back' })
  assert.equal(inputsTo(host, 'ui.visibility').length, 3)
  await panel.unmount()
  assert.deepEqual(inputsTo(host, 'ui.visibility').slice(3), [{ surface: 'prs', org: 'contoso', visible: false }])
})

test('switching organization loads that org and drops the other one\'s results', async () => {
  const host = await open(
    input => snapshotOf({ org: input.org, sets: [setOf([prOf(input.org === 'contoso' ? 55 : 90, { title: `${input.org} change` })])] }),
    { 'prs.approve': { results: [{ prId: 55, ok: true, message: 'Approved.' }] } },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  await panel.press({ type: 'Button', text: 'Approve all' })
  assert.equal(panel.findAll({ type: 'Text', text: /^Pull Request \d+: / }).length, 1)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(titles(), ['fabrikam change'])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(inputsTo(host, 'prs.snapshot'), [{ org: 'contoso' }, { org: 'fabrikam' }])
})
