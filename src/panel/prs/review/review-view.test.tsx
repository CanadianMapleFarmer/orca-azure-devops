import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import { BAD_LINE } from '../../../shared/messages'
import {
  VOTE_BUTTON,
  VOTE_VALUE,
  type ChangedFile,
  type CheckoutResult,
  type FileDiff,
  type PrReview,
  type ReviewResult,
  type ReviewThread
} from '../../../shared/reviews'
import type { OrgStatus } from '../../../shared/types'
import { closeCleanly, countNodes, mountPanel, org, requestsTo, type TestHost } from '../../test-support'
import { NOW, prOf, reviewerOf, snapshotOf } from '../fixtures'
import { diffOf, OPEN_REVIEW, REDIRECT_DIFF, REVIEW_KEY, REVIEW_THREADS, REVIEW_TITLE, reviewOf, threadOf } from './fixtures'
import { ReviewView } from './review-view'
import { closeReview, refreshReview, reloadReview, showReview } from './state'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  persisted?: Record<string, unknown>
}

async function open(requests: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(options.orgs ?? [org('contoso')], requests, {
    persisted: { workspace: { tab: 'prs', openReview: OPEN_REVIEW, ...options.persisted } }
  })
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const heading = () => panel.find({ type: 'Heading' })?.text

const button = (text: string) => panel.find({ type: 'Button', text })

const callouts = () => panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text])

const inside = (scope: TestElement, query: TestQuery) => panel.findAll(query).filter(item => item.path.startsWith(`${scope.path}/`))

const labelOf = (node: TreeSnapshot | string | undefined) => (typeof node === 'object' ? node.props?.label : undefined)

function nodeWhere(match: (node: TreeSnapshot) => boolean): TreeSnapshot | undefined {
  const visit = (node: TreeSnapshot | string | null): TreeSnapshot | undefined => {
    if (node === null || typeof node === 'string') return undefined
    if (match(node)) return node
    for (const child of node.children ?? []) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  return visit(panel.tree())
}

const showToReview = () => panel.press({ type: 'Button', text: /^To review/ })

function held<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release: (value: T) => release(value) }
}

const VOTES = Object.values(VOTE_BUTTON)

function sectionLabels(): (string | undefined)[] {
  const tabs = panel.find({ type: 'Tabs', label: 'Pull request' })
  assert.ok(tabs)
  return panel.findAll({ type: 'Tab' }).filter(item => item.path.startsWith(`${tabs.path}/`)).map(item => item.label)
}

test('the header shows Back, Refresh and Open in Azure DevOps, the title, both lines and the badges', async () => {
  await open({
    'reviews.open': input =>
      reviewOf({
        key: input,
        myVote: 5,
        pr: prOf(4110, {
          title: REVIEW_TITLE,
          source: 'hotfix/1211-login-redirect',
          target: 'main',
          isDraft: true,
          mergeStatus: 'conflicts',
          createdBy: { id: 'u-grace', name: 'Grace Hopper' },
          createdAt: NOW - 3_600_000
        })
      })
  })
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(panel.find({ type: 'Heading' })?.props.level, 2)
  const lines = panel.findAll({ type: 'Text', text: /^(Pull Request|Grace Hopper)/ })
  assert.deepEqual(
    lines.map(line => [line.props.muted, line.props.size]),
    [[true, 'xs'], [true, 'xs']]
  )
  assert.equal(lines[0].text, 'Pull Request 4110 · web-app · hotfix/1211-login-redirect → main')
  assert.match(lines[1].text, /^Grace Hopper · opened .+ · loaded .+$/)
  assert.deepEqual(
    panel.findAll({ type: 'RelativeTime' }).map(time => time.props.at),
    [NOW - 3_600_000, NOW]
  )
  assert.deepEqual(
    panel.findAll({ type: 'Badge' }).map(badge => [badge.text, badge.props.tone]),
    [['Connected', 'success'], ['draft', 'neutral'], ['conflicts', 'danger'], ['You: Approved with suggestions', 'success']]
  )
  const top = nodeWhere(node => node.type === 'Row' && labelOf(node.children?.[0]) === 'Back')
  assert.ok(top, 'Back is the first thing in the header row')
  assert.deepEqual([top.props?.justify, top.props?.align], ['between', 'center'])
  const shape = (node: TreeSnapshot | string): unknown => (typeof node === 'string' ? node : node.type === 'IconButton' ? labelOf(node) : [node.type, ...(node.children ?? []).map(shape)])
  assert.deepEqual(shape(top), ['Row', 'Back', ['Row', 'Refresh', 'Open in Azure DevOps']])
  assert.deepEqual(
    ['Back', 'Refresh', 'Open in Azure DevOps'].map(label => panel.find({ type: 'IconButton', label })).map(item => [item?.props.icon, item?.props.variant, item?.props.size]),
    [
      ['close', 'ghost', 'xs'],
      ['refresh', 'ghost', 'xs'],
      ['open-external', 'ghost', 'xs']
    ]
  )
  assert.equal(panel.find({ type: 'Link' }), null)
})

test('Open in Azure DevOps opens the pull request', async () => {
  const host = await open()
  host.respond('shell.openExternal', { opened: true })
  await panel.press({ type: 'IconButton', label: 'Open in Azure DevOps' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: reviewOf().pr.url }])
  assert.deepEqual(callouts(), [])
})

test('the vote badge is success from 5 up, warning at -5 and danger at -10, and absent without a vote', async () => {
  let myVote = 0
  await open({ 'reviews.open': input => reviewOf({ key: input, myVote }) })
  const youBadge = () => panel.find({ type: 'Badge', text: /^You: / })
  assert.equal(youBadge(), null)
  for (const [vote, tone, text] of [
    [10, 'success', 'You: Approved'],
    [5, 'success', 'You: Approved with suggestions'],
    [-5, 'warning', 'You: Waiting for author'],
    [-10, 'danger', 'You: Rejected']
  ] as const) {
    myVote = vote
    await panel.press({ type: 'IconButton', label: 'Refresh' })
    assert.deepEqual([youBadge()?.text, youBadge()?.props.tone], [text, tone], String(vote))
  }
})

test('Back returns to the list', async () => {
  const host = await open({ 'prs.snapshot': snapshotOf({ toReview: [prOf(4110, { title: REVIEW_TITLE })], toReviewCount: 1 }) })
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  await panel.press({ type: 'IconButton', label: 'Back' })
  assert.equal(heading(), undefined)
  assert.ok(panel.find({ type: 'Button', text: 'To review · 1' }))
  assert.equal(panel.persisted.workspace.openReview ?? null, null)
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
})

test('the sections name their counts, and only the selected one is drawn', async () => {
  await open({ 'reviews.open': input => reviewOf({ key: input, moreFiles: true }) })
  const tabs = panel.find({ type: 'Tabs', label: 'Pull request' })
  assert.ok(tabs)
  assert.equal(panel.valueOf({ type: 'Tabs', label: 'Pull request' }), 'overview')
  assert.deepEqual(sectionLabels(), ['Overview', 'Files (5+)', 'Comments (3)'])
  assert.ok(panel.find({ type: 'Textarea', label: 'Add a comment' }))
  await panel.select({ type: 'Tabs', label: 'Pull request' }, 'files')
  assert.equal(panel.find({ type: 'Textarea', label: 'Add a comment' }), null)
  assert.equal(panel.persisted.workspace.reviewSection, 'files')
  await panel.select({ type: 'Tabs', label: 'Pull request' }, 'comments')
  assert.equal(panel.persisted.workspace.reviewSection, 'comments')
  await panel.select({ type: 'Tabs', label: 'Pull request' }, 'overview')
  assert.ok(panel.find({ type: 'Textarea', label: 'Add a comment' }))
})

test('the files tab drops the plus when every file is listed', async () => {
  await open()
  assert.deepEqual(sectionLabels(), ['Overview', 'Files (5)', 'Comments (3)'])
})

test('the overview shows the description and the reviewers with their votes', async () => {
  await open()
  const markdown = panel.find({ type: 'Markdown' })
  assert.equal(markdown?.props.content, reviewOf().description)
  assert.equal(panel.find({ type: 'Text', text: 'No description.' }), null)
  assert.equal(panel.find({ type: 'Text', text: 'Reviewers' })?.props.weight, 'semibold')
  assert.deepEqual(
    panel.findAll({ type: 'ListItem' }).map(item => [item.label, item.props.description]),
    [
      ['Alex Contoso', 'No vote'],
      ['Dennis Ritchie (required)', 'Approved']
    ]
  )
  assert.ok(panel.find({ type: 'List', label: 'Reviewers' }))
})

test('an empty description says so', async () => {
  await open({ 'reviews.open': input => reviewOf({ key: input, description: '' }) })
  assert.equal(panel.find({ type: 'Markdown' }), null)
  assert.equal(panel.find({ type: 'Text', text: 'No description.' })?.props.muted, true)
})

test('the reviewers list is capped and says how many there are', async () => {
  const reviewers = Array.from({ length: 150 }, (_, index) => reviewerOf(`Reviewer ${index}`, index % 2 === 0 ? 10 : 0))
  await open({ 'reviews.open': input => reviewOf({ key: input, pr: prOf(4110, { reviewers }) }) })
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 100)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 100 of 150 reviewers.' })?.props.muted, true)
})

test('votes send reviews.vote, mark the current vote and show the result', async () => {
  let myVote = 0
  const host = await open({
    'reviews.open': input => reviewOf({ key: input, myVote }),
    'reviews.vote': input => {
      myVote = VOTE_VALUE[input.vote]
      return { ok: true, message: 'Voted: Approved with suggestions.' }
    }
  })
  const buttons = () => VOTES.map(button)
  const looks = [
    ['solid', 'accent', 'xs', false],
    ['outline', undefined, 'xs', false],
    ['outline', undefined, 'xs', false],
    ['outline', 'danger', 'xs', false]
  ]
  assert.deepEqual(
    buttons().map(item => [item?.props.variant, item?.props.tone, item?.props.size, item?.disabled]),
    looks
  )
  assert.deepEqual(
    buttons().map(item => item?.props.icon),
    [undefined, undefined, undefined, undefined]
  )
  const row = panel.find({ type: 'Row', text: VOTES.join(' ') })
  assert.deepEqual([row?.props.gap, row?.props.wrap], ['xs', true])
  assert.deepEqual(callouts(), [])

  await panel.press({ type: 'Button', text: 'Approve with suggestions' })
  assert.deepEqual(inputsTo(host, 'reviews.vote'), [{ ...REVIEW_KEY, vote: 'suggestions' }])
  assert.equal(requestsTo(host, 'reviews.vote')[0]?.timeoutMs, 90000)
  assert.deepEqual(
    buttons().map(item => item?.props.icon),
    [undefined, 'check', undefined, undefined]
  )
  assert.deepEqual(
    buttons().map(item => [item?.props.variant, item?.props.tone, item?.props.size, item?.disabled]),
    looks
  )
  assert.deepEqual(callouts(), [['success', 'Voted: Approved with suggestions.']])
  assert.equal(panel.find({ type: 'Badge', text: 'You: Approved with suggestions' })?.props.tone, 'success')
})

test('a vote shows a warning, a refusal and a thrown error each in their own tone', async () => {
  let answer: () => ReviewResult = () => ({ ok: true, warn: true, message: 'Azure DevOps recorded Waiting for author instead.' })
  const host = await open({ 'reviews.vote': () => answer() })
  await panel.press({ type: 'Button', text: 'Reject' })
  assert.deepEqual(callouts(), [['warning', 'Azure DevOps recorded Waiting for author instead.']])

  answer = () => ({ ok: false, message: 'This pull request is not active any more.' })
  await panel.press({ type: 'Button', text: 'Reject' })
  assert.deepEqual(callouts(), [['danger', 'This pull request is not active any more.']])

  answer = () => {
    throw hostError('action_failed', 'Azure DevOps is unreachable.')
  }
  await panel.press({ type: 'Button', text: 'Reject' })
  assert.deepEqual(callouts(), [['danger', 'Azure DevOps is unreachable.']])
  assert.equal(requestsTo(host, 'reviews.vote').length, 3)
  assert.equal(button('Reject')?.disabled, false)
})

test('the review reloads after a vote and stays on screen while it does', async () => {
  let reads = 0
  const reload = held<PrReview>()
  const host = await open({
    'reviews.open': input => {
      reads += 1
      return reads === 1 ? reviewOf({ key: input }) : reload.promise
    },
    'reviews.vote': { ok: true, message: 'Voted: Approved.' }
  })
  const pending = panel.press({ type: 'Button', text: 'Approve' })
  await pause(10)
  assert.equal(reads, 2)
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.equal(heading(), REVIEW_TITLE)
  assert.deepEqual(
    VOTES.map(text => button(text)?.disabled),
    [true, true, true, true]
  )
  reload.release(reviewOf({ myVote: 10 }))
  await pending
  assert.equal(panel.find({ type: 'Badge', text: 'You: Approved' })?.props.tone, 'success')
  assert.deepEqual(
    VOTES.map(text => button(text)?.props.icon),
    ['check', undefined, undefined, undefined]
  )
  assert.deepEqual(
    VOTES.map(text => button(text)?.disabled),
    [false, false, false, false]
  )
  assert.equal(requestsTo(host, 'reviews.open').length, 2)
  assert.deepEqual(callouts(), [['success', 'Voted: Approved.']])
})

test('a second vote press before the buttons redraw sends nothing', async () => {
  const answer = held<{ ok: boolean; message: string }>()
  const host = await open({ 'reviews.vote': () => answer.promise })
  const approve = button('Approve')
  const reject = button('Reject')
  assert.ok(approve && reject)
  const presses = [panel.press(approve), panel.press(approve), panel.press(reject)]
  await pause(10)
  answer.release({ ok: true, message: 'Voted: Approved.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'reviews.vote').length, 1)
})

test('Check out in Orca shows the armed instructions and Cancel disarms', async () => {
  const armed = 'Create a new workspace in Orca for web-app now. Orca checks out hotfix/1211-login-redirect.'
  const host = await open({
    'reviews.checkout': { status: 'armed', message: armed, armedUntil: Date.now() + 600_000 },
    'work.cancelWorkspace': { ok: true }
  })
  const checkout = button('Check out in Orca')
  assert.deepEqual([checkout?.props.variant, checkout?.props.size, checkout?.props.icon], ['outline', 'xs', 'branch'])
  assert.equal(panel.find({ type: 'Callout', label: 'Create the workspace in Orca' }), null)

  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  assert.deepEqual(inputsTo(host, 'reviews.checkout'), [REVIEW_KEY])
  assert.equal(requestsTo(host, 'reviews.checkout')[0]?.timeoutMs, 90000)
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'accent')
  assert.equal(callout?.props.title, 'Create the workspace in Orca')
  assert.ok(panel.find({ type: 'Text', text: armed }))
  assert.equal(
    panel.find({ type: 'Text', text: 'This applies to the next workspace you create in the next 10 minutes.' })?.props.muted,
    true
  )
  assert.equal(button('Cancel')?.props.variant, 'ghost')

  await panel.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(inputsTo(host, 'work.cancelWorkspace'), [{ org: 'contoso', prId: 4110 }])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(button('Cancel'), null)
})

test('a failed Cancel keeps the instructions and says so', async () => {
  await open({
    'reviews.checkout': { status: 'armed', message: 'Create a workspace.', armedUntil: Date.now() + 600_000 },
    'work.cancelWorkspace': () => {
      throw hostError('action_failed', 'The plugin worker is not running.')
    }
  })
  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  await panel.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(callouts(), [
    ['accent', 'Create the workspace in Orca Create a workspace. This applies to the next workspace you create in the next 10 minutes. Cancel'],
    ['danger', 'The plugin worker is not running.']
  ])
})

test('the armed instructions belong to their review', async () => {
  const other = prOf(4111, { title: 'Add the health endpoint' })
  await open(
    {
      'prs.snapshot': snapshotOf({ toReview: [other], toReviewCount: 1 }),
      'reviews.checkout': { status: 'armed', message: 'Create a workspace.', armedUntil: Date.now() + 600_000 },
      'reviews.open': input => reviewOf({ key: input, pr: input.prId === 4111 ? other : reviewOf().pr })
    }
  )
  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  assert.equal(panel.find({ type: 'Callout' })?.props.title, 'Create the workspace in Orca')
  await panel.press({ type: 'IconButton', label: 'Back' })
  await showToReview()
  await panel.press({ type: 'ListItem', label: 'Add the health endpoint' })
  assert.equal(heading(), 'Add the health endpoint')
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('the armed instructions show only while the posted arm is this pull request, through Back and reopening', async () => {
  const other = prOf(4111, { title: 'Add the health endpoint' })
  await open({
    'prs.snapshot': snapshotOf({ toReview: [prOf(4110, { title: REVIEW_TITLE }), other], toReviewCount: 2 }),
    'reviews.checkout': { status: 'armed', message: 'Create a workspace.', armedUntil: Date.now() + 600_000 },
    'reviews.open': input => reviewOf({ key: input, pr: input.prId === 4111 ? other : reviewOf().pr })
  })
  const shown = () => panel.findAll({ type: 'Callout' }).some(callout => callout.props.title === 'Create the workspace in Orca')
  const reopen = async (title: string) => {
    await panel.press({ type: 'IconButton', label: 'Back' })
    await showToReview()
    await panel.press({ type: 'ListItem', label: title })
    assert.equal(heading(), title)
  }

  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  await panel.post('workspace.armChanged', { org: 'contoso', prId: 4110 })
  assert.equal(shown(), true, 'the worker posted this pull request')
  await reopen('Add the health endpoint')
  assert.equal(shown(), false, 'another pull request')
  await reopen(REVIEW_TITLE)
  assert.equal(shown(), true, 'reopened while still armed')

  await panel.post('workspace.armChanged', { org: 'contoso', itemId: 101 })
  assert.equal(shown(), false, 'a work item replaced the arm')
  await panel.post('workspace.armChanged', { org: 'contoso', prId: 4110 })
  assert.equal(shown(), true)
  await panel.post('workspace.armChanged', { org: 'fabrikam', prId: 4110 })
  assert.equal(shown(), false, 'the same id in another organization')
  await panel.post('workspace.armChanged', { org: 'contoso', prId: 4110 })
  await panel.post('workspace.armChanged', null)
  assert.equal(shown(), false, 'taken by a new workspace, or expired')
  await reopen('Add the health endpoint')
  await reopen(REVIEW_TITLE)
  assert.equal(shown(), false, 'reopened after the arm ended')
  assert.equal(button('Cancel'), null)
})

test('an opened or refused checkout shows its message', async () => {
  let answer: () => CheckoutResult = () => ({ status: 'opened', message: 'Opened web-app, which is already on hotfix/1211-login-redirect.' })
  const host = await open({ 'reviews.checkout': () => answer() })
  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  assert.deepEqual(callouts(), [['success', 'Opened web-app, which is already on hotfix/1211-login-redirect.']])

  answer = () => ({ status: 'refused', message: "This pull request comes from a fork, which Orca can't check out." })
  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  assert.deepEqual(callouts(), [['danger', "This pull request comes from a fork, which Orca can't check out."]])

  answer = () => {
    throw hostError('action_failed', 'Orca could not open the workspace.')
  }
  await panel.press({ type: 'Button', text: 'Check out in Orca' })
  assert.deepEqual(callouts(), [['danger', 'Orca could not open the workspace.']])
  assert.equal(requestsTo(host, 'reviews.checkout').length, 3)
  assert.equal(button('Check out in Orca')?.disabled, false)
})

test('a general comment sends reviews.comment and clears the box', async () => {
  const host = await open({ 'reviews.comment': { ok: true, message: 'Commented.' } })
  const box = { type: 'Textarea', label: 'Add a comment' }
  assert.deepEqual(
    [panel.find(box)?.props.rows, panel.find(box)?.props.maxLength],
    [3, 10_000]
  )
  await panel.type(box, 'Looks good, one nit on the test name.')
  assert.equal(panel.valueOf(box), 'Looks good, one nit on the test name.')
  await panel.press({ type: 'Button', text: 'Comment' })
  assert.deepEqual(inputsTo(host, 'reviews.comment'), [{ ...REVIEW_KEY, text: 'Looks good, one nit on the test name.' }])
  assert.equal(requestsTo(host, 'reviews.comment')[0]?.timeoutMs, 90000)
  assert.equal(panel.valueOf(box), '')
  assert.deepEqual(callouts(), [['success', 'Commented.']])
  assert.equal(requestsTo(host, 'reviews.open').length, 2, 'the review reloads')
  assert.equal(button('Comment')?.disabled, false)
})

test('a refused comment keeps the text and does not reload', async () => {
  const host = await open({ 'reviews.comment': { ok: false, message: 'This pull request is not active any more.' } })
  const box = { type: 'Textarea', label: 'Add a comment' }
  await panel.type(box, 'Too late?')
  await panel.press({ type: 'Button', text: 'Comment' })
  assert.equal(panel.valueOf(box), 'Too late?')
  assert.deepEqual(callouts(), [['danger', 'This pull request is not active any more.']])
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
})

test('a second Comment press before the buttons redraw sends nothing', async () => {
  const answer = held<{ ok: boolean; message: string }>()
  const host = await open({ 'reviews.comment': () => answer.promise })
  await panel.type({ type: 'Textarea', label: 'Add a comment' }, 'Once only.')
  const comment = button('Comment')
  assert.ok(comment)
  const presses = [panel.press(comment), panel.press(comment)]
  await pause(10)
  assert.equal(button('Comment')?.disabled, true)
  answer.release({ ok: true, message: 'Commented.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'reviews.comment').length, 1)
})

test('text typed while a comment is being sent is not cleared', async () => {
  const answer = held<{ ok: boolean; message: string }>()
  await open({ 'reviews.comment': () => answer.promise })
  const box = { type: 'Textarea', label: 'Add a comment' }
  await panel.type(box, 'First.')
  const sending = panel.press({ type: 'Button', text: 'Comment' })
  await pause(10)
  const typing = panel.type(box, ' And more.')
  await pause(10)
  answer.release({ ok: true, message: 'Commented.' })
  await Promise.all([sending, typing])
  assert.equal(panel.valueOf(box), 'First. And more.')
})

test('a review that fails to load shows the message with Try again and Back', async () => {
  let reads = 0
  await open({
    'prs.snapshot': snapshotOf({ toReview: [prOf(4110)], toReviewCount: 1 }),
    'reviews.open': input => {
      reads += 1
      if (reads === 1) throw hostError('action_failed', "That pull request no longer exists, or you can't see it.")
      return reviewOf({ key: input })
    }
  })
  assert.deepEqual(callouts(), [['danger', "That pull request no longer exists, or you can't see it."]])
  assert.equal(heading(), REVIEW_TITLE)
  assert.ok(panel.find({ type: 'IconButton', label: 'Back' }))
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.equal(panel.find({ type: 'Tabs', label: 'Pull request' }), null)

  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(heading(), REVIEW_TITLE)
  assert.ok(panel.find({ type: 'Tabs', label: 'Pull request' }))
  assert.equal(panel.find({ type: 'Button', text: 'Try again' }), null)
})

test('Back leaves a review that failed to load', async () => {
  await open({
    'prs.snapshot': snapshotOf({ toReview: [prOf(4110)], toReviewCount: 1 }),
    'reviews.open': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await panel.press({ type: 'IconButton', label: 'Back' })
  assert.ok(panel.find({ type: 'Button', text: 'To review · 1' }))
  assert.equal(panel.persisted.workspace.openReview ?? null, null)
})

test('the review shows its title and a skeleton while it loads', async () => {
  const loading = held<PrReview>()
  await open({
    'prs.snapshot': snapshotOf({ toReview: [prOf(4110, { title: REVIEW_TITLE })], toReviewCount: 1 }),
    'reviews.open': () => loading.promise
  }, { persisted: { openReview: null } })
  await showToReview()
  const pressing = panel.press({ type: 'ListItem', label: REVIEW_TITLE })
  await pause(10)
  assert.ok(panel.find({ type: 'Skeleton', label: 'Loading the pull request' }))
  assert.equal(panel.find({ type: 'Skeleton' })?.props.lines, 4)
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(panel.find({ type: 'Heading' })?.props.level, 2)
  const back = panel.find({ type: 'IconButton', label: 'Back' })
  assert.deepEqual([back?.props.icon, back?.props.variant, back?.props.size], ['close', 'ghost', 'xs'])
  assert.equal(panel.find({ type: 'Tabs', label: 'Pull request' }), null)
  loading.release(reviewOf())
  await pressing
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.ok(panel.find({ type: 'Tabs', label: 'Pull request' }))
})

test('Refresh loads again; a failed refresh keeps the review and shows the message', async () => {
  let reads = 0
  const host = await open({
    'reviews.open': input => {
      reads += 1
      if (reads === 3) throw hostError('action_failed', 'Azure DevOps is unreachable.')
      return reviewOf({ key: input, loadedAt: NOW + reads })
    }
  })
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.deepEqual(inputsTo(host, 'reviews.open'), [REVIEW_KEY, REVIEW_KEY])
  assert.equal(panel.findAll({ type: 'RelativeTime' })[1]?.props.at, NOW + 2)
  assert.deepEqual(callouts(), [])

  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(heading(), REVIEW_TITLE)
  assert.deepEqual(callouts(), [['danger', 'Azure DevOps is unreachable.']])
  assert.equal(panel.find({ type: 'IconButton', label: 'Refresh' })?.disabled, false)
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.deepEqual(callouts(), [])
})

test('the review message shows under the header', async () => {
  await open({ 'reviews.open': input => reviewOf({ key: input, message: 'Some comments were left out to keep this view small.' }) })
  const note = panel.find({ type: 'Text', text: 'Some comments were left out to keep this view small.' })
  assert.equal(note?.props.muted, true)
})

test('an answer for another pull request is dropped', async () => {
  const first = held<PrReview>()
  const a = prOf(4110, { title: 'Harden the login redirect' })
  const b = prOf(4111, { title: 'Add the health endpoint' })
  await open({ 'reviews.open': input => (input.prId === 4110 ? first.promise : reviewOf({ key: input, pr: b })) }, { persisted: { openReview: null } })
  showReview('contoso', a)
  await pause(10)
  closeReview()
  showReview('contoso', b)
  await pause(10)
  first.release(reviewOf({ pr: a }))
  await pause(10)
  await panel.rerender()
  assert.equal(heading(), 'Add the health endpoint')
  assert.deepEqual(panel.persisted.workspace.openReview, { ...REVIEW_KEY, prId: 4111, title: 'Add the health endpoint' })
})

test('a slower, older load does not replace a newer one', async () => {
  const older = held<PrReview>()
  let reads = 0
  await open({
    'reviews.open': input => {
      reads += 1
      return reads === 2 ? older.promise : reviewOf({ key: input, loadedAt: NOW + reads })
    }
  })
  void reloadReview()
  await pause(10)
  void reloadReview()
  await pause(10)
  older.release(reviewOf({ loadedAt: NOW - 1 }))
  await pause(10)
  await panel.rerender()
  assert.equal(panel.findAll({ type: 'RelativeTime' })[1]?.props.at, NOW + 3)
})

test('switching org closes the review', async () => {
  const host = await open(
    { 'prs.snapshot': input => snapshotOf({ org: input.org, toReview: [prOf(4110, { org: input.org })], toReviewCount: 1 }) },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  assert.equal(heading(), REVIEW_TITLE)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(heading(), undefined)
  assert.ok(panel.find({ type: 'Button', text: 'To review · 1' }))
  assert.equal(panel.persisted.workspace.openReview ?? null, null)
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
})

test('the open review survives leaving the PRs tab and a panel reload', async () => {
  const host = await open()
  assert.deepEqual(panel.persisted.workspace, { tab: 'prs', openReview: OPEN_REVIEW })
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  assert.equal(panel.find({ type: 'Card' }), null)

  await panel.select({ type: 'Tabs', label: 'Azure DevOps' }, 'work')
  assert.equal(heading(), undefined)
  await panel.select({ type: 'Tabs', label: 'Azure DevOps' }, 'prs')
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(requestsTo(host, 'reviews.open').length, 1, 'leaving the tab does not load it again')

  const saved = panel.persisted.workspace
  await closeCleanly(panel)
  const mounted = await mountPanel([org('contoso')], {}, { persisted: { workspace: saved } })
  panel = mounted.panel
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  assert.deepEqual(inputsTo(mounted.host, 'reviews.open'), [REVIEW_KEY])
})

test('a panel that starts on another tab does not load the review until the PRs tab is shown', async () => {
  const host = await open({}, { persisted: { tab: 'work' } })
  assert.deepEqual(requestsTo(host, 'reviews.open'), [])
  await panel.select({ type: 'Tabs', label: 'Azure DevOps' }, 'prs')
  assert.equal(heading(), REVIEW_TITLE)
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
})

test('a render for another organization does not load the open review', async () => {
  const host = await open({}, { persisted: { tab: 'work' } })
  assert.equal(ReviewView({ org: org('fabrikam') }), null)
  await pause(10)
  assert.deepEqual(requestsTo(host, 'reviews.open'), [])
})

test('an organization that is not connected keeps the persisted review', async () => {
  await open({}, { orgs: [org('contoso', { state: 'expired', message: 'Sign in again.' })] })
  assert.equal(heading(), undefined)
  assert.deepEqual(panel.persisted.workspace.openReview, OPEN_REVIEW)
  assert.equal(panel.persisted.workspace.reviewSection ?? 'overview', 'overview')
})

test('a review for another organization is closed once the list is ready', async () => {
  await open({}, { persisted: { openReview: { ...OPEN_REVIEW, org: 'fabrikam' } } })
  assert.equal(heading(), undefined)
  assert.equal(panel.persisted.workspace.openReview ?? null, null)
})

test('the largest overview stays within the panel limits', async () => {
  const reviewers = Array.from({ length: 150 }, (_, index) => reviewerOf(`Reviewer ${index}`, 10, { isRequired: true }))
  await open({
    'reviews.open': input => reviewOf({ key: input, description: 'x'.repeat(59_000), pr: prOf(4110, { title: 'T'.repeat(400), reviewers }), message: 'm'.repeat(1_000) })
  })
  assert.ok(countNodes(panel.tree()) < 1_000, `${countNodes(panel.tree())} nodes`)
  assert.ok(new TextEncoder().encode(JSON.stringify(panel.tree())).length < 450 * 1024)
})

const FILES = { type: 'Table', label: 'Changed files' }
const REDIRECT = '/src/auth/redirect.ts'
const REDIRECT_TEST = '/src/auth/redirect.test.ts'
const REMOVED = '/src/auth/legacy-return.ts'
const NEW_HINT = 'Line numbers refer to the new version: the second number on each diff line.'
const OLD_HINT = 'Line numbers refer to the old version: the first number on each diff line.'
const LINE = { type: 'Input', label: 'Line (optional)' }
const FILE_BOX = { type: 'Textarea', label: 'Comment on this file' }

const showSection = (value: 'files' | 'comments') => panel.select({ type: 'Tabs', label: 'Pull request' }, value)


const threadIdOf = (card: TestElement) => Number(card.path.slice(card.path.lastIndexOf('.') + 1))

function cardOf(id: number): TestElement {
  const card = panel.findAll({ type: 'Card' }).find(item => threadIdOf(item) === id)
  assert.ok(card, `thread ${id} is drawn`)
  return card
}

function inCard(id: number, query: TestQuery): TestElement {
  const found = inside(cardOf(id), query)[0]
  assert.ok(found, `${JSON.stringify(query)} is drawn in thread ${id}`)
  return found
}

const cardIds = () => panel.findAll({ type: 'Card' }).map(threadIdOf)

const cardCallouts = (id: number) => inside(cardOf(id), { type: 'Callout' }).map(callout => [callout.props.tone, callout.text])

const tableRows = () => (panel.find(FILES)?.props.rows ?? []) as { key: string; cells: Record<string, unknown> }[]

const treeBytes = () => new TextEncoder().encode(JSON.stringify(panel.tree())).length

const commentsOf = (count: number, content: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => ({ id: index + 1, author: 'Grace Hopper', at: NOW + index, content: content(index) }))

async function openFiles(requests: MockRequests = {}) {
  const host = await open({ 'reviews.diff': input => diffOf(input.path), ...requests })
  await showSection('files')
  return host
}

test('Files lists the changes and selecting one shows its diff', async () => {
  const host = await openFiles()
  const filter = panel.find({ type: 'Input', label: 'Filter files' })
  assert.deepEqual([filter?.props.type, filter?.props.labelHidden, filter?.props.placeholder], ['search', true, 'Filter files'])
  const table = panel.find(FILES)
  assert.deepEqual([table?.props.selectionMode, table?.props.maxHeight, table?.props.emptyText], ['single', 'md', 'No files match.'])
  assert.deepEqual(table?.props.columns, [
    { key: 'change', label: 'Change', width: 'sm' },
    { key: 'path', label: 'File' }
  ])
  assert.deepEqual(panel.rowsOf(FILES), [REDIRECT, REDIRECT_TEST, REMOVED, '/docs/auth.md', '/assets/lock.png'])
  assert.deepEqual(
    tableRows().map(row => [row.cells.change, row.cells.path]),
    [
      ['edited', REDIRECT],
      ['added', REDIRECT_TEST],
      ['deleted', REMOVED],
      ['renamed', '/docs/auth.md'],
      ['added', '/assets/lock.png']
    ]
  )
  assert.deepEqual(panel.valueOf(FILES), [])
  assert.equal(panel.find({ type: 'CodeView' }), null)
  assert.equal(panel.find(FILE_BOX), null)
  assert.deepEqual(requestsTo(host, 'reviews.diff'), [])

  await panel.selectRows(FILES, [REDIRECT])
  assert.deepEqual(inputsTo(host, 'reviews.diff'), [{ ...REVIEW_KEY, path: REDIRECT }])
  assert.equal(requestsTo(host, 'reviews.diff')[0]?.timeoutMs, 90000)
  assert.deepEqual(panel.valueOf(FILES), [REDIRECT])
  const title = panel.find({ type: 'Text', text: REDIRECT })
  assert.deepEqual([title?.props.weight, title?.props.truncate], ['semibold', true])
  const code = panel.find({ type: 'CodeView' })
  assert.deepEqual(
    [code?.props.language, code?.props.label, code?.props.lineNumbers, code?.props.maxHeight, code?.props.code],
    ['diff', `Diff of ${REDIRECT}`, false, 'lg', REDIRECT_DIFF]
  )
  assert.equal(panel.find({ type: 'Text', text: NEW_HINT })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: OLD_HINT }), null)
  assert.deepEqual(cardIds(), [102], 'the threads on this file')
  assert.equal(cardOf(102).label, '/src/auth/redirect.ts, line 12')
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
  const line = panel.find(LINE)
  assert.deepEqual([line?.props.placeholder, line?.props.maxLength], ['42', 7])
  assert.deepEqual([panel.find(FILE_BOX)?.props.rows, panel.find(FILE_BOX)?.props.maxLength], [3, 10_000])
  assert.equal(button('Comment on file')?.disabled, false)

  await panel.type({ type: 'Input', label: 'Filter files' }, 'TEST')
  assert.deepEqual(panel.rowsOf(FILES), [REDIRECT_TEST])
  assert.ok(panel.find({ type: 'CodeView', label: `Diff of ${REDIRECT}` }), 'the selected file stays open while filtered out')
  await panel.type({ type: 'Input', label: 'Filter files' }, 'nothing', { replace: true })
  assert.deepEqual(panel.rowsOf(FILES), [])
  await panel.type({ type: 'Input', label: 'Filter files' }, '', { replace: true })

  await panel.selectRows(FILES, [REMOVED])
  assert.deepEqual(
    inputsTo(host, 'reviews.diff').map(input => (input as { path: string }).path),
    [REDIRECT, REMOVED]
  )
  assert.equal(panel.find({ type: 'CodeView' })?.props.label, `Diff of ${REMOVED}`)
  assert.equal(panel.find({ type: 'Text', text: OLD_HINT })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: NEW_HINT }), null)
  assert.deepEqual(cardIds(), [103])
  assert.equal(cardOf(103).label, REMOVED)
})

test('the diff shows a skeleton while it loads and a failure with Try again', async () => {
  const loading = held<FileDiff>()
  let reads = 0
  await openFiles({
    'reviews.diff': input => {
      reads += 1
      if (reads === 1) return loading.promise
      if (reads === 2) throw hostError('action_failed', "That file isn't part of this pull request any more.")
      return diffOf(input.path)
    }
  })
  const pending = panel.selectRows(FILES, [REDIRECT])
  await pause(10)
  const skeleton = panel.find({ type: 'Skeleton' })
  assert.deepEqual([skeleton?.props.lines, skeleton?.props.label], [6, 'Loading the diff'])
  assert.equal(panel.find({ type: 'CodeView' }), null)
  assert.ok(panel.find(FILE_BOX), 'the comment box does not wait for the diff')
  loading.release(diffOf(REDIRECT))
  await pending
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.ok(panel.find({ type: 'CodeView' }))

  await panel.selectRows(FILES, [REDIRECT_TEST])
  assert.deepEqual(callouts(), [['danger', "That file isn't part of this pull request any more."]])
  assert.equal(panel.find({ type: 'CodeView' }), null)
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.deepEqual(callouts(), [])
  assert.equal(panel.find({ type: 'CodeView' })?.props.label, `Diff of ${REDIRECT_TEST}`)
})

test('a binary or too-large file shows the message instead of a diff', async () => {
  const answers: Record<string, FileDiff> = {
    '/assets/lock.png': diffOf('/assets/lock.png', { text: null, message: "Binary file; it isn't shown here.", lines: { old: null, new: 'unknown' } }),
    [REDIRECT]: diffOf(REDIRECT, { text: null, message: 'This file is too large to show here. Check out the branch in Orca to see it.' }),
    '/docs/auth.md': diffOf('/docs/auth.md', { message: 'Renamed from /docs/login.md.' })
  }
  await openFiles({ 'reviews.diff': input => answers[input.path] })
  await panel.selectRows(FILES, ['/assets/lock.png'])
  assert.equal(panel.find({ type: 'CodeView' }), null)
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.equal(panel.find({ type: 'Text', text: "Binary file; it isn't shown here." })?.props.muted, true)
  assert.ok(panel.find({ type: 'Text', text: '/assets/lock.png' }))

  await panel.selectRows(FILES, [REDIRECT])
  assert.equal(panel.find({ type: 'CodeView' }), null)
  assert.equal(panel.find({ type: 'Text', text: 'This file is too large to show here. Check out the branch in Orca to see it.' })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: "Binary file; it isn't shown here." }), null)

  await panel.selectRows(FILES, ['/docs/auth.md'])
  assert.equal(panel.find({ type: 'Text', text: 'Renamed from /docs/login.md.' })?.props.muted, true)
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, REDIRECT_DIFF)
})

test('threads on a renamed file show under it, on its new path or its original one', async () => {
  const renamedThreads = [
    threadOf(201, { anchor: { path: '/docs/login.md', line: 4, side: 'old' } }),
    threadOf(202, { anchor: { path: '/docs/auth.md', line: 6, side: 'new' } }),
    threadOf(203, { anchor: { path: '/docs/login.md', line: null, side: 'new' } })
  ]
  const threads = [...REVIEW_THREADS, ...renamedThreads]
  await openFiles({
    'reviews.open': input => reviewOf({ key: input, threads, threadCount: threads.length }),
    'reviews.diff': input => diffOf(input.path, { message: 'Renamed from /docs/login.md.' })
  })
  await panel.selectRows(FILES, ['/docs/auth.md'])
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, REDIRECT_DIFF, 'an edited rename')
  assert.deepEqual(cardIds(), [201, 202, 203])
  await panel.selectRows(FILES, [REDIRECT])
  assert.deepEqual(cardIds(), [102])
})

test('a quick second selection drops the first answer', async () => {
  const first = held<FileDiff>()
  const host = await openFiles({ 'reviews.diff': input => (input.path === REDIRECT ? first.promise : diffOf(input.path, { text: '+   1 │ second' })) })
  const firstPick = panel.selectRows(FILES, [REDIRECT])
  await pause(10)
  const secondPick = panel.selectRows(FILES, [REDIRECT_TEST])
  await pause(10)
  first.release(diffOf(REDIRECT, { text: '+   1 │ first' }))
  await Promise.all([firstPick, secondPick])
  await panel.rerender()
  assert.equal(requestsTo(host, 'reviews.diff').length, 2)
  assert.deepEqual(panel.valueOf(FILES), [REDIRECT_TEST])
  assert.ok(panel.find({ type: 'Text', text: REDIRECT_TEST }))
  const code = panel.findAll({ type: 'CodeView' })
  assert.deepEqual(
    code.map(view => [view.props.label, view.props.code]),
    [[`Diff of ${REDIRECT_TEST}`, '+   1 │ second']]
  )
})

test('the Files section says when the worker left comment threads out', async () => {
  await openFiles({ 'reviews.open': input => reviewOf({ key: input, threadCount: 150 }) })
  await panel.selectRows(FILES, [REDIRECT])
  assert.deepEqual(cardIds(), [102])
  const note = panel.find({ type: 'Text', text: /^Showing/ })
  assert.equal(note?.text, 'Showing 3 of 150 comment threads. Open the pull request in Azure DevOps for the rest.')
  assert.equal(note?.props.muted, true)
})

test('Refresh reloads the open diff and keeps the old one on screen until the new one lands', async () => {
  const next = held<FileDiff>()
  let reads = 0
  const host = await openFiles({
    'reviews.diff': input => {
      reads += 1
      return reads === 2 ? next.promise : diffOf(input.path, { text: reads === 1 ? REDIRECT_DIFF : '+   1 │ after the push' })
    }
  })
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.deepEqual(requestsTo(host, 'reviews.diff'), [], 'no file is open yet')

  await panel.selectRows(FILES, [REDIRECT])
  const refreshing = panel.press({ type: 'IconButton', label: 'Refresh' })
  await pause(10)
  assert.deepEqual(inputsTo(host, 'reviews.diff'), [{ ...REVIEW_KEY, path: REDIRECT }, { ...REVIEW_KEY, path: REDIRECT }])
  assert.equal(requestsTo(host, 'reviews.open').length, 3)
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, REDIRECT_DIFF, 'the old diff stays until the new one lands')
  next.release(diffOf(REDIRECT, { text: '+   1 │ the pushed change' }))
  await refreshing
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, '+   1 │ the pushed change')

  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, '+   1 │ after the push')
  assert.equal(requestsTo(host, 'reviews.diff').length, 3)
})

test('a refreshed diff reads the latest iteration', async () => {
  let pushed = 2
  let kept = 2
  const host = await openFiles({
    'reviews.open': async input => {
      const latest = pushed
      await pause(5)
      kept = latest
      return reviewOf({ key: input })
    },
    'reviews.diff': input => diffOf(input.path, { text: `+   1 │ iteration ${kept}` })
  })
  await panel.selectRows(FILES, [REDIRECT])
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, '+   1 │ iteration 2')

  pushed = 99
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, '+   1 │ iteration 99')
  const names = (host.callsOf('plugin.request') as { name: string }[]).map(call => call.name)
  assert.deepEqual(names.slice(-2), ['reviews.open', 'reviews.diff'], 'the diff is asked for once the review has loaded')
})

test('a refreshed diff that fails shows the failure instead of the old diff', async () => {
  let reads = 0
  await openFiles({
    'reviews.diff': input => {
      reads += 1
      if (reads === 2) throw hostError('action_failed', 'Azure DevOps is unreachable.')
      return diffOf(input.path)
    }
  })
  await panel.selectRows(FILES, [REDIRECT])
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(panel.find({ type: 'CodeView' }), null)
  assert.deepEqual(callouts(), [['danger', 'Azure DevOps is unreachable.']])
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, REDIRECT_DIFF)
  assert.deepEqual(callouts(), [])
})

test('a refresh answer for a file that is no longer open is dropped', async () => {
  const slow = held<FileDiff>()
  let reads = 0
  await openFiles({
    'reviews.diff': input => {
      reads += 1
      if (reads === 2) return slow.promise
      return diffOf(input.path, { text: input.path === REDIRECT ? REDIRECT_DIFF : '+   1 │ the test file' })
    }
  })
  await panel.selectRows(FILES, [REDIRECT])
  const refreshing = refreshReview()
  await pause(10)
  const switching = panel.selectRows(FILES, [REDIRECT_TEST])
  await pause(10)
  slow.release(diffOf(REDIRECT, { text: '+   1 │ stale for this file' }))
  await Promise.all([refreshing, switching])
  await panel.rerender()
  assert.deepEqual(
    panel.findAll({ type: 'CodeView' }).map(view => [view.props.label, view.props.code]),
    [[`Diff of ${REDIRECT_TEST}`, '+   1 │ the test file']]
  )
})

test('a file comment sends the path and line; a bad line is refused in the panel', async () => {
  const host = await openFiles({ 'reviews.comment': input => ({ ok: true, message: `Commented on ${input.path}.` }) })
  await panel.selectRows(FILES, [REDIRECT])
  await panel.type(LINE, '12')
  await panel.type(FILE_BOX, 'Decode once, here.')
  await panel.press({ type: 'Button', text: 'Comment on file' })
  assert.deepEqual(inputsTo(host, 'reviews.comment'), [{ ...REVIEW_KEY, text: 'Decode once, here.', path: REDIRECT, line: 12 }])
  assert.equal(requestsTo(host, 'reviews.comment')[0]?.timeoutMs, 90000)
  assert.deepEqual(callouts(), [['success', `Commented on ${REDIRECT}.`]])
  assert.deepEqual([panel.valueOf(LINE), panel.valueOf(FILE_BOX)], ['', ''])
  assert.equal(requestsTo(host, 'reviews.open').length, 2, 'the review reloads')
  assert.equal(panel.find({ type: 'CodeView' })?.props.label, `Diff of ${REDIRECT}`, 'the file stays open after the reload')

  await panel.type(FILE_BOX, 'About the whole file.')
  await panel.press({ type: 'Button', text: 'Comment on file' })
  assert.deepEqual(inputsTo(host, 'reviews.comment')[1], { ...REVIEW_KEY, text: 'About the whole file.', path: REDIRECT })

  for (const bad of ['4.5', '0', 'twelve']) {
    await panel.type(LINE, bad, { replace: true })
    await panel.type(FILE_BOX, 'Which line?', { replace: true })
    await panel.press({ type: 'Button', text: 'Comment on file' })
    assert.equal(requestsTo(host, 'reviews.comment').length, 2, bad)
    assert.deepEqual(callouts(), [['danger', BAD_LINE]], bad)
    assert.deepEqual([panel.valueOf(LINE), panel.valueOf(FILE_BOX)], [bad, 'Which line?'])
  }
  assert.equal(requestsTo(host, 'reviews.open').length, 3)
  assert.equal(button('Comment on file')?.disabled, false)
})

test('a refused file comment keeps the text and stays with its file', async () => {
  const host = await openFiles({ 'reviews.comment': { ok: false, message: 'Line 99 is past the end of the file, which has 41 lines.' } })
  await panel.selectRows(FILES, [REDIRECT])
  await panel.type(LINE, '99')
  await panel.type(FILE_BOX, 'Past the end.')
  await panel.press({ type: 'Button', text: 'Comment on file' })
  assert.deepEqual(callouts(), [['danger', 'Line 99 is past the end of the file, which has 41 lines.']])
  assert.deepEqual([panel.valueOf(LINE), panel.valueOf(FILE_BOX)], ['99', 'Past the end.'])
  assert.equal(requestsTo(host, 'reviews.open').length, 1)

  await panel.selectRows(FILES, [REDIRECT_TEST])
  assert.deepEqual(callouts(), [], 'the result belongs to the other file')
  assert.deepEqual([panel.valueOf(LINE), panel.valueOf(FILE_BOX)], ['', ''])
  await panel.selectRows(FILES, [REDIRECT])
  assert.deepEqual(callouts(), [['danger', 'Line 99 is past the end of the file, which has 41 lines.']])
  assert.deepEqual([panel.valueOf(LINE), panel.valueOf(FILE_BOX)], ['99', 'Past the end.'])
})

test('Comments shows threads unresolved first with status, and Reply sends reviews.reply', async () => {
  const host = await open({ 'reviews.reply': { ok: true, message: 'Reply posted.' } })
  await showSection('comments')
  assert.deepEqual(cardIds(), [101, 103, 102])
  assert.deepEqual(
    panel.findAll({ type: 'Card' }).map(card => [card.label, card.props.description]),
    [
      ['General', 'Active'],
      [REMOVED, 'Pending'],
      ['/src/auth/redirect.ts, line 12', 'Resolved']
    ]
  )
  const bylines = inside(cardOf(101), { type: 'Text', text: /^(Grace Hopper|Alex Contoso) · / })
  assert.deepEqual(
    bylines.map(line => [line.props.size, line.props.weight]),
    [['sm', 'medium'], ['sm', 'medium']]
  )
  assert.deepEqual(
    inside(cardOf(101), { type: 'RelativeTime' }).map(time => time.props.at),
    REVIEW_THREADS[0].comments.map(comment => comment.at)
  )
  assert.deepEqual(
    inside(cardOf(101), { type: 'Markdown' }).map(markdown => markdown.props.content),
    REVIEW_THREADS[0].comments.map(comment => comment.content)
  )
  assert.deepEqual(
    [101, 103, 102].map(id => inside(cardOf(id), { type: 'Button' }).map(item => [item.text, item.props.size, item.props.variant ?? 'solid'])),
    [
      [['Reply', 'sm', 'solid'], ['Resolve', 'sm', 'outline']],
      [['Reply', 'sm', 'solid'], ['Resolve', 'sm', 'outline']],
      [['Reply', 'sm', 'solid'], ['Reactivate', 'sm', 'outline']]
    ]
  )
  const box = inCard(101, { type: 'Textarea', label: 'Reply' })
  assert.deepEqual([box.props.rows, box.props.maxLength], [2, 10_000])
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)

  await panel.type(box, 'Decoding happens once now.')
  await panel.press(inCard(101, { type: 'Button', text: 'Reply' }))
  assert.deepEqual(inputsTo(host, 'reviews.reply'), [{ ...REVIEW_KEY, threadId: 101, text: 'Decoding happens once now.' }])
  assert.equal(requestsTo(host, 'reviews.reply')[0]?.timeoutMs, 90000)
  assert.deepEqual(cardCallouts(101), [['success', 'Reply posted.']])
  assert.deepEqual(cardCallouts(103), [])
  assert.equal(panel.valueOf(inCard(101, { type: 'Textarea', label: 'Reply' })), '')
  assert.equal(requestsTo(host, 'reviews.open').length, 2, 'the review reloads')
})

test('a refused reply keeps the text and does not reload', async () => {
  const host = await open({ 'reviews.reply': { ok: false, message: 'That comment thread no longer exists.' } })
  await showSection('comments')
  await panel.type(inCard(103, { type: 'Textarea', label: 'Reply' }), 'Nothing else called it.')
  await panel.press(inCard(103, { type: 'Button', text: 'Reply' }))
  assert.deepEqual(cardCallouts(103), [['danger', 'That comment thread no longer exists.']])
  assert.equal(panel.valueOf(inCard(103, { type: 'Textarea', label: 'Reply' })), 'Nothing else called it.')
  assert.equal(panel.valueOf(inCard(101, { type: 'Textarea', label: 'Reply' })), '', 'each thread keeps its own reply')
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
})

test('Resolve and Reactivate send reviews.setStatus', async () => {
  const host = await open({ 'reviews.setStatus': input => ({ ok: true, message: input.status === 'fixed' ? 'Resolved.' : 'Reactivated.' }) })
  await showSection('comments')
  await panel.press(inCard(101, { type: 'Button', text: 'Resolve' }))
  assert.deepEqual(inputsTo(host, 'reviews.setStatus'), [{ ...REVIEW_KEY, threadId: 101, status: 'fixed' }])
  assert.equal(requestsTo(host, 'reviews.setStatus')[0]?.timeoutMs, 90000)
  assert.deepEqual(cardCallouts(101), [['success', 'Resolved.']])
  assert.equal(requestsTo(host, 'reviews.open').length, 2)

  await panel.press(inCard(102, { type: 'Button', text: 'Reactivate' }))
  assert.deepEqual(inputsTo(host, 'reviews.setStatus')[1], { ...REVIEW_KEY, threadId: 102, status: 'active' })
  assert.deepEqual(cardCallouts(102), [['success', 'Reactivated.']])
  assert.equal(requestsTo(host, 'reviews.open').length, 3)
})

test('a thread action that throws shows the message in its card', async () => {
  const host = await open({
    'reviews.setStatus': () => {
      throw hostError('action_failed', 'Azure DevOps is unreachable.')
    }
  })
  await showSection('comments')
  await panel.press(inCard(102, { type: 'Button', text: 'Reactivate' }))
  assert.deepEqual(cardCallouts(102), [['danger', 'Azure DevOps is unreachable.']])
  assert.equal(requestsTo(host, 'reviews.open').length, 1)
  assert.equal(inCard(102, { type: 'Button', text: 'Reactivate' }).disabled, false)
})

test('a result stays with its thread after a reload reorders the threads', async () => {
  let reads = 0
  const [general, removed, redirect] = REVIEW_THREADS
  const reordered: ReviewThread[] = [{ ...redirect, status: 'active' }, removed, { ...general, status: 'fixed' }]
  await open({
    'reviews.open': input => {
      reads += 1
      return reviewOf({ key: input, threads: reads === 1 ? REVIEW_THREADS : reordered })
    },
    'reviews.setStatus': { ok: true, message: 'Resolved.' }
  })
  await showSection('comments')
  await panel.press(inCard(101, { type: 'Button', text: 'Resolve' }))
  assert.deepEqual(cardIds(), [102, 103, 101])
  assert.deepEqual(cardCallouts(101), [['success', 'Resolved.']])
  assert.deepEqual(cardCallouts(102), [])
  assert.deepEqual(cardCallouts(103), [])
  assert.ok(inCard(101, { type: 'Button', text: 'Reactivate' }))
  assert.ok(inCard(102, { type: 'Button', text: 'Resolve' }))
})

test('a second Reply or Comment on file press before the buttons redraw sends nothing', async () => {
  const replied = held<ReviewResult>()
  const commented = held<ReviewResult>()
  const host = await openFiles({ 'reviews.reply': () => replied.promise, 'reviews.comment': () => commented.promise, 'reviews.setStatus': { ok: true, message: 'Resolved.' } })
  await panel.selectRows(FILES, [REDIRECT])
  await panel.type(inCard(102, { type: 'Textarea', label: 'Reply' }), 'Once only.')
  const reply = inCard(102, { type: 'Button', text: 'Reply' })
  const reactivate = inCard(102, { type: 'Button', text: 'Reactivate' })
  const replies = [panel.press(reply), panel.press(reply), panel.press(reactivate)]
  await pause(10)
  assert.deepEqual(
    [inCard(102, { type: 'Button', text: 'Reply' }).disabled, inCard(102, { type: 'Button', text: 'Reactivate' }).disabled, inCard(102, { type: 'Textarea', label: 'Reply' }).disabled],
    [true, true, true]
  )
  replied.release({ ok: true, message: 'Reply posted.' })
  await Promise.all(replies)
  assert.equal(requestsTo(host, 'reviews.reply').length, 1)
  assert.equal(requestsTo(host, 'reviews.setStatus').length, 0)

  await panel.type(FILE_BOX, 'Once only.')
  const commentOnFile = button('Comment on file')
  assert.ok(commentOnFile)
  const comments = [panel.press(commentOnFile), panel.press(commentOnFile)]
  await pause(10)
  assert.equal(button('Comment on file')?.disabled, true)
  commented.release({ ok: true, message: 'Commented.' })
  await Promise.all(comments)
  assert.equal(requestsTo(host, 'reviews.comment').length, 1)
  assert.equal(button('Comment on file')?.disabled, false)
})

test('the Comments footer counts the threads the worker left out', async () => {
  const threads = Array.from({ length: 100 }, (_, index) => threadOf(index + 1))
  await open({ 'reviews.open': input => reviewOf({ key: input, threads, threadCount: 150 }) })
  assert.deepEqual(sectionLabels(), ['Overview', 'Files (5)', 'Comments (150)'])
  await showSection('comments')
  assert.deepEqual(cardIds(), threads.slice(0, 30).map(thread => thread.id))
  const footer = panel.find({ type: 'Text', text: /^Showing/ })
  assert.equal(footer?.text, 'Showing 30 of 150 comment threads. Open the pull request in Azure DevOps for the rest.')
  assert.equal(footer?.props.muted, true)
})

test('no threads shows an empty state, and dropped replies are counted', async () => {
  let threads: ReviewThread[] = []
  await open({ 'reviews.open': input => reviewOf({ key: input, threads, threadCount: threads.length }) })
  await showSection('comments')
  const empty = panel.find({ type: 'EmptyState' })
  assert.deepEqual([empty?.label, empty?.props.description], ['No comments yet', 'Comments on this pull request show up here.'])
  assert.equal(panel.find({ type: 'Card' }), null)

  threads = [
    threadOf(1, { comments: commentsOf(12, index => `Note ${index}.`) }),
    threadOf(2, { hidden: 1 }),
    threadOf(3, { comments: commentsOf(20, index => `Note ${index}.`), hidden: 3 })
  ]
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.deepEqual(
    [1, 2, 3].map(id => inside(cardOf(id), { type: 'Text', text: /more repl(y is|ies are) in Azure DevOps\.$/ }).map(note => [note.text, note.props.muted])),
    [
      [['2 more replies are in Azure DevOps.', true]],
      [['1 more reply is in Azure DevOps.', true]],
      [['13 more replies are in Azure DevOps.', true]]
    ]
  )
  assert.equal(inside(cardOf(1), { type: 'Markdown' }).length, 10)
  assert.deepEqual(
    inside(cardOf(1), { type: 'Markdown' }).map(markdown => markdown.props.content),
    ['Note 0.', ...Array.from({ length: 9 }, (_, index) => `Note ${index + 3}.`)]
  )
})

test('long paths are cut to the label limit and still select the file', async () => {
  const long = `/src/${'deep/'.repeat(300)}file.ts`
  const twin = `/src/${'deep/'.repeat(300)}other.ts`
  const files: ChangedFile[] = [
    { path: long, originalPath: null, kind: 'edited' },
    { path: twin, originalPath: null, kind: 'added' }
  ]
  const host = await openFiles({
    'reviews.open': input =>
      reviewOf({ key: input, files, threads: [threadOf(9, { anchor: { path: long, line: 3, side: 'old' } })], threadCount: 1 })
  })
  const keys = panel.rowsOf(FILES)
  assert.equal(keys.length, 2)
  assert.equal(new Set(keys).size, 2)
  for (const key of keys) assert.ok(new TextEncoder().encode(key).length <= 1024)
  for (const row of tableRows()) assert.ok(new TextEncoder().encode(String(row.cells.path)).length <= 1024)

  await panel.selectRows(FILES, [keys[0]])
  assert.deepEqual(inputsTo(host, 'reviews.diff'), [{ ...REVIEW_KEY, path: long }])
  assert.deepEqual(panel.valueOf(FILES), [keys[0]])
  assert.ok(new TextEncoder().encode(String(panel.find({ type: 'CodeView' })?.props.label)).length <= 1024)
  assert.ok(new TextEncoder().encode(cardOf(9).label ?? '').length <= 1024)
  assert.match(cardOf(9).label ?? '', /^\/src\/deep\/.*…$/)
  await panel.selectRows(FILES, [keys[1]])
  assert.deepEqual(inputsTo(host, 'reviews.diff')[1], { ...REVIEW_KEY, path: twin })
})

test('closing the review forgets the selected file and the drafts', async () => {
  await openFiles({ 'prs.snapshot': snapshotOf({ toReview: [prOf(4110, { title: REVIEW_TITLE })], toReviewCount: 1 }) })
  await panel.selectRows(FILES, [REDIRECT])
  await panel.type(FILE_BOX, 'Draft.')
  await panel.type({ type: 'Input', label: 'Filter files' }, 'redirect')
  await panel.press({ type: 'IconButton', label: 'Back' })
  await showToReview()
  await panel.press({ type: 'ListItem', label: REVIEW_TITLE })
  await showSection('files')
  assert.equal(panel.valueOf({ type: 'Input', label: 'Filter files' }), '')
  assert.deepEqual(panel.valueOf(FILES), [])
  assert.equal(panel.find(FILE_BOX), null)
  await panel.selectRows(FILES, [REDIRECT])
  assert.equal(panel.valueOf(FILE_BOX), '')
})

const DIFF_ROW = '+ 1234 │ export const value = "a generated line that fills the diff to its byte limit"\n'
const LARGE_DIFF = DIFF_ROW.repeat(Math.floor((60 * 1024) / DIFF_ROW.length))

const heavyThreads = (target: string) =>
  Array.from({ length: 100 }, (_, index) =>
    threadOf(index + 1, { anchor: { path: target, line: index + 1, side: 'new' }, comments: commentsOf(20, () => 'w'.repeat(8_000)) })
  )

const generatedFiles = (count: number, directory: string): ChangedFile[] =>
  Array.from({ length: count }, (_, index) => ({ path: `${directory}/file-${String(index).padStart(4, '0')}.generated.ts`, originalPath: null, kind: 'edited' }))

function openLargest(files: ChangedFile[]) {
  return open({
    'reviews.open': input => reviewOf({ key: input, files, threads: heavyThreads(files[0].path), threadCount: 100 }),
    'reviews.diff': input => diffOf(input.path, { text: LARGE_DIFF })
  })
}

function measureTree(section: string) {
  const nodes = countNodes(panel.tree())
  const bytes = treeBytes()
  assert.ok(nodes < 4_000, `${section}: ${nodes} nodes`)
  assert.ok(bytes < 450 * 1024, `${section}: ${bytes} bytes`)
}

const FILES_NOTE = { type: 'Text', text: /^Showing \d+ of \d+ files\./ }

test('the largest review stays under 4,000 nodes and 450 KiB in every section', async () => {
  const files = Array.from({ length: 1_000 }, (_, index) => ({
    path: `/src/generated/module-${index}/component-${index}.generated.ts`,
    originalPath: null,
    kind: 'edited' as const
  }))
  const target = files[0].path
  await openLargest(files)
  measureTree('overview')

  await showSection('files')
  await panel.selectRows(FILES, [target])
  assert.equal(panel.rowsOf(FILES).length, 1_000)
  assert.equal(panel.find(FILES_NOTE), null)
  assert.equal(panel.find({ type: 'CodeView' })?.props.code, LARGE_DIFF)
  assert.deepEqual(cardIds(), [1])
  assert.equal(inside(cardOf(1), { type: 'Markdown' }).length, 10)
  assert.equal(
    panel.find({ type: 'Text', text: /^Showing/ })?.text,
    'Showing 1 of 100 comment threads on this file. Open the pull request in Azure DevOps for the rest.'
  )
  measureTree('files')

  await showSection('comments')
  assert.deepEqual(cardIds(), [1, 2, 3])
  assert.equal(
    panel.find({ type: 'Text', text: /^Showing/ })?.text,
    'Showing 3 of 100 comment threads. Open the pull request in Azure DevOps for the rest.'
  )
  measureTree('comments')
})

test('1,000 long paths cap the Files rows by bytes, say so, and the filter reaches the rest', async () => {
  const files = generatedFiles(1_000, `/src/${'nested-module/'.repeat(17)}`.slice(0, -1))
  const host = await openLargest(files)
  await showSection('files')
  await panel.selectRows(FILES, [files[0].path])
  const shown = panel.rowsOf(FILES).length
  assert.ok(shown > 100 && shown < 1_000, `${shown} rows`)
  assert.deepEqual(panel.rowsOf(FILES), files.slice(0, shown).map(file => file.path))
  const note = panel.find(FILES_NOTE)
  assert.equal(note?.text, `Showing ${shown} of 1000 files. Filter to narrow the list.`)
  assert.equal(note?.props.muted, true)
  assert.ok(panel.find({ type: 'CodeView' }))
  assert.deepEqual(cardIds(), [1])
  measureTree('files')

  const last = files[999].path
  await panel.type({ type: 'Input', label: 'Filter files' }, 'file-0999')
  assert.deepEqual(panel.rowsOf(FILES), [last])
  assert.equal(panel.find(FILES_NOTE), null)
  await panel.selectRows(FILES, [last])
  assert.deepEqual(inputsTo(host, 'reviews.diff').at(-1), { ...REVIEW_KEY, path: last })
  measureTree('filtered files')
})

test('more files than the row limit say how many are shown', async () => {
  const files = generatedFiles(1_500, '/src/generated')
  await open({ 'reviews.open': input => reviewOf({ key: input, files }) })
  await showSection('files')
  assert.equal(panel.rowsOf(FILES).length, 1_000)
  assert.equal(panel.find(FILES_NOTE)?.text, 'Showing 1000 of 1500 files. Filter to narrow the list.')
  await panel.type({ type: 'Input', label: 'Filter files' }, 'file-149')
  assert.equal(panel.rowsOf(FILES).length, 10)
  assert.equal(panel.find(FILES_NOTE), null)
})

test('thirty threads of ten short comments stay under 4,000 nodes in Files and Comments', async () => {
  const threads = Array.from({ length: 100 }, (_, index) =>
    threadOf(index + 1, { anchor: { path: REDIRECT, line: index + 1, side: 'new' }, comments: commentsOf(20, at => `Reply ${at}.`), hidden: 4 })
  )
  await openFiles({ 'reviews.open': input => reviewOf({ key: input, threads, threadCount: 150 }) })
  await panel.selectRows(FILES, [REDIRECT])
  assert.equal(cardIds().length, 30)
  assert.ok(countNodes(panel.tree()) < 4_000, `files: ${countNodes(panel.tree())} nodes`)
  await showSection('comments')
  assert.equal(cardIds().length, 30)
  assert.ok(countNodes(panel.tree()) < 4_000, `comments: ${countNodes(panel.tree())} nodes`)
})
