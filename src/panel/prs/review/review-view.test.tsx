import { afterEach, assert, hostError, test, type MockRequests, type TestPanel, type TreeSnapshot } from 'orca/testing'
import { VOTE_BUTTON, VOTE_VALUE, type CheckoutResult, type PrReview, type ReviewResult } from '../../../shared/reviews'
import type { OrgStatus } from '../../../shared/types'
import { closeCleanly, mountPanel, org, requestsTo, type TestHost } from '../../test-support'
import { NOW, prOf, reviewerOf, snapshotOf } from '../fixtures'
import { OPEN_REVIEW, REVIEW_KEY, REVIEW_TITLE, reviewOf } from './fixtures'
import { closeReview, reloadReview, showReview } from './state'

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

const countNodes = (node: TreeSnapshot | string | null): number =>
  node === null ? 0 : typeof node === 'string' ? 1 : 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0)

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

test('the header shows the title, both lines, the badges and the link', async () => {
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
  assert.equal(panel.find({ type: 'Heading' })?.props.level, 3)
  const lines = panel.findAll({ type: 'Text', text: /^(Pull Request|Grace Hopper)/ })
  assert.deepEqual(
    lines.map(line => [line.props.muted, line.props.size]),
    [[true, 'sm'], [true, 'sm']]
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
  assert.ok(panel.find({ type: 'IconButton', label: 'Back' }))
  assert.ok(panel.find({ type: 'IconButton', label: 'Refresh' }))
  assert.ok(panel.find({ type: 'Link', text: 'Open in Azure DevOps' }))
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
  assert.ok(panel.find({ type: 'Collapsible', label: 'To review (1)' }))
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
  assert.deepEqual(
    buttons().map(item => [item?.props.variant, item?.props.tone, item?.props.size, item?.disabled]),
    [
      ['outline', 'success', 'sm', false],
      ['outline', 'success', 'sm', false],
      ['outline', 'warning', 'sm', false],
      ['outline', 'danger', 'sm', false]
    ]
  )
  assert.deepEqual(callouts(), [])

  await panel.press({ type: 'Button', text: 'Approve with suggestions' })
  assert.deepEqual(inputsTo(host, 'reviews.vote'), [{ ...REVIEW_KEY, vote: 'suggestions' }])
  assert.equal(requestsTo(host, 'reviews.vote')[0]?.timeoutMs, 90000)
  assert.deepEqual(
    buttons().map(item => item?.props.variant),
    ['outline', 'solid', 'outline', 'outline']
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
  assert.equal(button('Approve')?.props.variant, 'solid')
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
  assert.deepEqual([checkout?.props.variant, checkout?.props.size, checkout?.props.icon], ['outline', 'sm', 'branch'])
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
  assert.deepEqual(inputsTo(host, 'work.cancelWorkspace'), [{}])
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
  await panel.toggle({ type: 'Collapsible' })
  await panel.press({ type: 'ListItem', label: 'Add the health endpoint' })
  assert.equal(heading(), 'Add the health endpoint')
  assert.equal(panel.find({ type: 'Callout' }), null)
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
  assert.ok(panel.find({ type: 'Collapsible', label: 'To review (1)' }))
  assert.equal(panel.persisted.workspace.openReview ?? null, null)
})

test('the review shows its title and a skeleton while it loads', async () => {
  const loading = held<PrReview>()
  await open({
    'prs.snapshot': snapshotOf({ toReview: [prOf(4110, { title: REVIEW_TITLE })], toReviewCount: 1 }),
    'reviews.open': () => loading.promise
  }, { persisted: { openReview: null } })
  await panel.toggle({ type: 'Collapsible' })
  const pressing = panel.press({ type: 'ListItem', label: REVIEW_TITLE })
  await pause(10)
  assert.ok(panel.find({ type: 'Skeleton', label: 'Loading the pull request' }))
  assert.equal(panel.find({ type: 'Skeleton' })?.props.lines, 4)
  assert.equal(heading(), REVIEW_TITLE)
  assert.ok(panel.find({ type: 'IconButton', label: 'Back' }))
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
  assert.ok(panel.find({ type: 'Collapsible', label: 'To review (1)' }))
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
  assert.ok(JSON.stringify(panel.tree()).length < 450 * 1024)
})
