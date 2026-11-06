import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TreeSnapshot } from 'orca/testing'
import type { RunActionResult, RunFilter, RunState, StepState } from '../../shared/pipelines'
import type { OrgStatus } from '../../shared/types'
import { closeCleanly, mountPanel, org, requestsTo, type TestHost } from '../test-support'
import { approvalOf, HOUR, MINUTE, NOW, runOf, runsSnapshotOf, stageOf, waitingRun } from './fixtures'
import { stageLine } from './run-card'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  visible?: boolean
  tab?: string
  filter?: string
}

async function open(snapshot: MockRequests['runs.snapshot'], more: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    { 'runs.snapshot': snapshot, ...more },
    { visible: options.visible, persisted: { workspace: { tab: options.tab ?? 'pipelines', ...(options.filter ? { pipelinesFilter: options.filter } : {}) } } }
  )
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const numberOf = (card: TestElement): number => Number(String(card.props.description).match(/^20261105\.(\d+)/)?.[1])

const ids = () => panel.findAll({ type: 'Card' }).map(numberOf)

const cardOf = (buildId: number): TestElement => {
  const card = panel.findAll({ type: 'Card' }).find(item => numberOf(item) === buildId)
  assert.ok(card, `run ${buildId} is drawn`)
  return card
}

const inside = (card: TestElement, query: Parameters<TestPanel['findAll']>[0]) => panel.findAll(query).filter(item => item.path.startsWith(`${card.path}/`))

const within = (buildId: number, query: Parameters<TestPanel['findAll']>[0]): TestElement => {
  const found = inside(cardOf(buildId), query)[0]
  assert.ok(found, `${JSON.stringify(query)} is drawn in run ${buildId}`)
  return found
}

const waitingBlocks = (buildId: number) => inside(cardOf(buildId), { type: 'Callout' }).filter(callout => callout.props.title === 'Waiting for approval')

const countNodes = (node: TreeSnapshot | string | null): number =>
  node === null ? 0 : typeof node === 'string' ? 1 : 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0)

const KEPT = 'Azure DevOps is unreachable. Showing the last results.'

const STATES: [RunState, string, string][] = [
  ['queued', 'queued', 'neutral'],
  ['running', '● running', 'accent'],
  ['waiting', '⏸ waiting for approval', 'warning'],
  ['cancelling', 'cancelling', 'neutral'],
  ['succeeded', '✓ succeeded', 'success'],
  ['warning', '! partially succeeded', 'warning'],
  ['failed', '✗ failed', 'danger'],
  ['canceled', 'canceled', 'neutral']
]

test('runs show their state, stage bar and stage line', async () => {
  const stages: [string, StepState][] = [
    ['Build', 'succeeded'],
    ['Image', 'failed'],
    ['Deploy production', 'skipped'],
    ['Test', 'warning'],
    ['Approve', 'waiting'],
    ['Smoke', 'running'],
    ['Lint', 'pending'],
    ['Docs', 'canceled']
  ]
  const finished = (state: RunState) => state === 'succeeded' || state === 'warning' || state === 'failed' || state === 'canceled'
  const runs = STATES.map(([state], index) =>
    runOf(100 + index, {
      state,
      queuedAt: NOW - (10 + index) * MINUTE,
      startedAt: state === 'queued' ? null : NOW - (9 + index) * MINUTE,
      finishedAt: finished(state) ? NOW - 5 * MINUTE : null,
      stages: index === 6 ? stages.map(([name, step]) => stageOf(name, step)) : null
    })
  )
  await open(runsSnapshotOf({ runs }))
  for (const [index, [state, text, tone]] of STATES.entries()) {
    const badge = within(100 + index, { type: 'Badge' })
    assert.equal(badge.text, text, state)
    assert.equal(badge.props.tone, tone, state)
  }
  assert.match(within(100, { type: 'Text', text: /^queued / }).text, /^queued /)
  assert.match(within(101, { type: 'Text', text: /^started / }).text, /^started /)
  assert.match(within(104, { type: 'Text', text: /^finished / }).text, /^finished /)
  assert.ok(within(100, { type: 'RelativeTime' }))

  const bar = inside(cardOf(106), { type: 'Box' }).filter(box => box.props.width === 14)
  assert.deepEqual(bar.map(box => box.props.background), ['success', 'danger', 'muted', 'warning', 'warning', 'accent', 'muted', 'muted'])
  assert.ok(bar.every(box => box.props.height === 6 && box.props.radius === 'full'))
  const line = within(106, { type: 'Text', text: /^Build ✓/ })
  assert.equal(line.text, 'Build ✓ · Image ✗ · Deploy production – · Test ! · Approve ⏸ · Smoke ● · Lint ○ · Docs ⊘')
  assert.equal(line.props.size, 'xs')
  assert.equal(line.props.muted, true)
  assert.equal(line.props.truncate, true)
  assert.equal(inside(cardOf(105), { type: 'Box' }).length, 0)
  assert.equal(inside(cardOf(105), { type: 'Text', text: /✓|✗/ }).length, 0)
})

test('a run card names the pipeline, run, branch, PR and requester, and links to Azure DevOps', async () => {
  const runs = [
    runOf(201, { pipeline: { id: 9, name: 'web-app-cd' }, branch: 'main' }),
    runOf(202, { prId: 77, requestedFor: { id: 'u-grace', name: 'Grace Hopper' } })
  ]
  await open(runsSnapshotOf({ runs }))
  assert.equal(cardOf(201).label, 'web-app-cd')
  assert.equal(cardOf(201).props.description, '20261105.201 · main · Ada Lovelace')
  assert.equal(cardOf(202).label, 'web-app-ci')
  assert.equal(cardOf(202).props.description, '20261105.202 · develop · PR 77 · Grace Hopper')
  assert.equal(within(201, { type: 'Link' }).text, 'Open in Azure DevOps')
  assert.equal(within(201, { type: 'Link' }).props.href, runs[0].url)
})

test('running runs come first, newest first', async () => {
  const runs = [
    runOf(301, { finishedAt: NOW - HOUR }),
    runOf(302, { state: 'running', queuedAt: NOW - 20 * MINUTE, finishedAt: null }),
    runOf(303, { finishedAt: NOW - MINUTE }),
    runOf(304, { state: 'running', queuedAt: NOW - 5 * MINUTE, finishedAt: null })
  ]
  await open(runsSnapshotOf({ runs }))
  assert.deepEqual(ids(), [304, 302, 303, 301])
})

test('stageLine writes each stage with its glyph and says how many more there are', () => {
  assert.equal(stageLine([stageOf('Build', 'succeeded'), stageOf('Image', 'failed'), stageOf('Deploy production', 'skipped')]), 'Build ✓ · Image ✗ · Deploy production –')
  assert.equal(stageLine([]), '')
  const many = Array.from({ length: 14 }, (_, index) => stageOf(`S${index + 1}`, 'succeeded'))
  assert.equal(stageLine(many), `${many.slice(0, 12).map(stage => `${stage.name} ✓`).join(' · ')} · +2 more`)
  assert.equal(stageLine(many.slice(0, 12)).includes('more'), false)
})

test('a run with an empty stage list draws no stage bar and no stage line', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1, { stages: [] }), runOf(2, { stages: [stageOf('Build', 'succeeded')] })] }))
  assert.equal(inside(cardOf(1), { type: 'Box' }).length, 0)
  assert.equal(inside(cardOf(1), { type: 'Text' }).filter(text => text.props.size === 'xs').length, 0)
  assert.equal(inside(cardOf(2), { type: 'Box' }).length, 1)
})

test('a stage bar draws at most twelve segments', async () => {
  const stages = Array.from({ length: 15 }, (_, index) => stageOf(`S${index + 1}`, 'succeeded'))
  await open(runsSnapshotOf({ runs: [runOf(1, { stages })] }))
  assert.equal(inside(cardOf(1), { type: 'Box' }).filter(box => box.props.width === 14).length, 12)
  assert.match(within(1, { type: 'Text', text: /^S1 ✓/ }).text, / · \+3 more$/)
})

const mixed = () => [
  runOf(1, { state: 'failed', finishedAt: NOW - 10 * MINUTE, branch: 'main' }),
  runOf(2, { state: 'running', mine: false, finishedAt: null }),
  waitingRun(3, [approvalOf('ap-3', 3)]),
  waitingRun(4, [approvalOf('ap-4', 4, { canApprove: true })], { mine: false })
]

test('filters switch the list and show the counts', async () => {
  await open(runsSnapshotOf({ runs: mixed() }))
  const filterButtons = () => panel.findAll({ type: 'Button' }).map(button => button.text).filter(text => /^(Mine|Running|Needs me|Failed)/.test(text))
  assert.deepEqual(filterButtons(), ['Mine', 'Running', 'Needs me · 2', 'Failed · 1'])
  const variantOf = (text: string) => panel.find({ type: 'Button', text })?.props.variant
  assert.equal(variantOf('Mine'), 'solid')
  assert.equal(variantOf('Running'), 'ghost')
  assert.deepEqual(ids(), [3, 1])

  await panel.press({ type: 'Button', text: 'Running' })
  assert.deepEqual(ids(), [4, 3, 2])
  assert.equal(variantOf('Running'), 'solid')
  assert.equal(variantOf('Mine'), 'ghost')

  await panel.press({ type: 'Button', text: 'Needs me · 2' })
  assert.deepEqual(ids(), [4, 3])
  assert.equal(panel.persisted.workspace.pipelinesFilter, 'needsMe')

  await panel.press({ type: 'Button', text: 'Failed · 1' })
  assert.deepEqual(ids(), [1])
  assert.equal(variantOf('Failed · 1'), 'solid')
})

test('the filter buttons wrap and carry no count at zero', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1)] }))
  assert.equal(panel.find({ type: 'Button', text: 'Needs me' })?.props.size, 'sm')
  assert.ok(panel.find({ type: 'Button', text: 'Failed' }))
  const row = panel.find({ type: 'Row', text: /^Mine/ })
  assert.equal(row?.props.wrap, true)
})

test('the chosen filter is remembered for the workspace', async () => {
  await open(runsSnapshotOf({ runs: mixed() }), {}, { filter: 'failed' })
  assert.deepEqual(ids(), [1])
  assert.equal(panel.find({ type: 'Button', text: 'Failed · 1' })?.props.variant, 'solid')
})

test('an unknown remembered filter falls back to Mine', async () => {
  await open(runsSnapshotOf({ runs: mixed() }), {}, { filter: 'everything' })
  assert.deepEqual(ids(), [3, 1])
  assert.equal(panel.find({ type: 'Button', text: 'Mine' })?.props.variant, 'solid')
  await panel.press({ type: 'Button', text: 'Failed · 1' })
  assert.deepEqual(ids(), [1])
  assert.equal(panel.persisted.workspace.pipelinesFilter, 'failed')
})

test('Needs me shows the approval with approvers and waiting time', async () => {
  const approval = approvalOf('ap-1', 5, {
    approvers: [
      { id: 'u-grace', name: 'Grace Hopper', uniqueName: 'grace@contoso.com', isGroup: false },
      { id: 'g-release', name: 'Release approvers', uniqueName: 'release', isGroup: true }
    ],
    minRequired: 2,
    instructions: 'Check the smoke tests first.',
    createdAt: NOW - 20 * MINUTE
  })
  await open(runsSnapshotOf({ runs: [waitingRun(5, [approval])] }), {}, { filter: 'needsMe' })
  assert.deepEqual(ids(), [5])
  const callout = within(5, { type: 'Callout' })
  assert.equal(callout.props.tone, 'warning')
  assert.equal(callout.props.title, 'Waiting for approval')
  assert.equal(within(5, { type: 'Text', text: /^production · waiting / }).props.size, 'sm')
  const waited = inside(cardOf(5), { type: 'RelativeTime' }).find(item => item.props.format === 'duration')
  assert.equal(waited?.props.at, approval.createdAt)
  assert.equal(within(5, { type: 'Text', text: 'Approvers: Grace Hopper, Release approvers (group) · needs 2' }).props.size, 'sm')
  assert.equal(within(5, { type: 'Text', text: 'Check the smoke tests first.' }).props.muted, true)
  assert.equal(inside(cardOf(5), { type: 'Button', text: /Approve|Reject/ }).length, 0)
})

test('an approval names its environment, else its stage, else a stage; one approver needs no count; no approvers, no line', async () => {
  const runs = [
    waitingRun(11, [approvalOf('a', 11, { environment: null, stage: 'Deploy production' })]),
    waitingRun(12, [approvalOf('b', 12, { environment: null, stage: null })]),
    waitingRun(13, [approvalOf('c', 13, { approvers: [], minRequired: 1 })])
  ]
  await open(runsSnapshotOf({ runs }))
  assert.match(within(11, { type: 'Text', text: /^Deploy production · waiting / }).text, /^Deploy production · waiting /)
  assert.match(within(12, { type: 'Text', text: /^A stage · waiting / }).text, /^A stage · waiting /)
  assert.equal(inside(cardOf(11), { type: 'Text', text: 'Approvers: Grace Hopper' }).length, 1)
  assert.equal(inside(cardOf(13), { type: 'Text', text: /^Approvers/ }).length, 0)
})

test('long instructions are cut at 500 characters with an ellipsis', async () => {
  const instructions = 'x'.repeat(600)
  await open(runsSnapshotOf({ runs: [waitingRun(5, [approvalOf('ap-1', 5, { instructions })])] }))
  const shown = within(5, { type: 'Text', text: /^x+/ }).text
  assert.equal(shown.length, 500)
  assert.equal(shown, `${'x'.repeat(499)}…`)
  await panel.post('runs.changed', runsSnapshotOf({ runs: [waitingRun(5, [approvalOf('ap-1', 5, { instructions: 'y'.repeat(500) })])] }))
  assert.equal(within(5, { type: 'Text', text: /^y+/ }).text, 'y'.repeat(500))
})

const approvable = () => runsSnapshotOf({ runs: [waitingRun(5, [approvalOf('ap-1', 5, { canApprove: true })])] })

test('Approve asks for a comment, sends runs.decide only on confirm, and shows the result', async () => {
  const host = await open(approvable(), { 'runs.decide': { ok: true, message: 'Approved.' } })
  assert.ok(within(5, { type: 'Button', text: 'Approve…' }))
  assert.ok(within(5, { type: 'Button', text: 'Reject…' }))
  assert.equal(panel.find({ type: 'Textarea' }), null)

  await panel.press({ type: 'Button', text: 'Approve…' })
  assert.deepEqual(requestsTo(host, 'runs.decide'), [])
  const comment = within(5, { type: 'Textarea', label: 'Comment (optional)' })
  assert.equal(comment.props.maxLength, 1000)
  assert.equal(inside(cardOf(5), { type: 'Button', text: 'Approve…' }).length, 0)
  assert.equal(inside(cardOf(5), { type: 'Button', text: 'Reject…' }).length, 0)
  assert.equal(within(5, { type: 'Button', text: 'Approve' }).props.tone, 'success')
  assert.equal(within(5, { type: 'Button', text: 'Cancel' }).props.variant, 'ghost')

  await panel.type({ type: 'Textarea', label: 'Comment (optional)' }, 'Ship it')
  assert.deepEqual(requestsTo(host, 'runs.decide'), [])
  await panel.press({ type: 'Button', text: 'Approve' })
  const calls = requestsTo(host, 'runs.decide')
  assert.deepEqual(calls.map(call => call.input), [{ org: 'contoso', projectId: 'proj-web', approvalId: 'ap-1', decision: 'approved', comment: 'Ship it' }])
  assert.equal(calls[0].timeoutMs, 90_000)
  const result = within(5, { type: 'Callout', text: 'Approved.' })
  assert.equal(result.props.tone, 'success')
  assert.equal(inside(cardOf(5), { type: 'Textarea' }).length, 0)
})

test('Reject sends the rejection with its comment, in danger tone', async () => {
  const host = await open(approvable(), { 'runs.decide': { ok: true, message: 'Rejected.' } })
  await panel.press({ type: 'Button', text: 'Reject…' })
  assert.equal(within(5, { type: 'Button', text: 'Reject' }).props.tone, 'danger')
  await panel.type({ type: 'Textarea', label: 'Comment (optional)' }, 'Not today')
  await panel.press({ type: 'Button', text: 'Reject' })
  assert.deepEqual(inputsTo(host, 'runs.decide'), [{ org: 'contoso', projectId: 'proj-web', approvalId: 'ap-1', decision: 'rejected', comment: 'Not today' }])
  assert.equal(within(5, { type: 'Callout', text: 'Rejected.' }).props.tone, 'success')
})

test('Cancel closes the comment box without sending and forgets the comment', async () => {
  const host = await open(approvable(), { 'runs.decide': { ok: true, message: 'Approved.' } })
  await panel.press({ type: 'Button', text: 'Approve…' })
  await panel.type({ type: 'Textarea', label: 'Comment (optional)' }, 'Maybe')
  await panel.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(requestsTo(host, 'runs.decide'), [])
  assert.equal(panel.find({ type: 'Textarea' }), null)
  await panel.press({ type: 'Button', text: 'Reject…' })
  assert.equal(panel.valueOf({ type: 'Textarea', label: 'Comment (optional)' }), '')
})

test('a warning result shows in warning tone and a refusal in danger tone', async () => {
  let answer: RunActionResult = { ok: true, warn: true, message: 'Approved. 1 more approval is still needed.' }
  await open(approvable(), { 'runs.decide': () => answer })
  await panel.press({ type: 'Button', text: 'Approve…' })
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(within(5, { type: 'Callout', text: 'Approved. 1 more approval is still needed.' }).props.tone, 'warning')

  answer = { ok: false, message: 'This approval is no longer pending.' }
  await panel.press({ type: 'Button', text: 'Approve…' })
  assert.equal(inside(cardOf(5), { type: 'Callout', text: /still needed/ }).length, 0)
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(within(5, { type: 'Callout', text: 'This approval is no longer pending.' }).props.tone, 'danger')
})

test('a failed decision shows the message in danger tone and frees the buttons', async () => {
  await open(approvable(), {
    'runs.decide': () => {
      throw hostError('action_failed', 'Keep the comment under 1,000 characters.')
    }
  })
  await panel.press({ type: 'Button', text: 'Approve…' })
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(within(5, { type: 'Callout', text: 'Keep the comment under 1,000 characters.' }).props.tone, 'danger')
  assert.equal(within(5, { type: 'Button', text: 'Approve…' }).disabled, false)
})

test('a second press on the confirm button before it redraws sends nothing more', async () => {
  let release: (value: RunActionResult) => void = () => {}
  const held = new Promise<RunActionResult>(resolve => {
    release = resolve
  })
  const host = await open(approvable(), { 'runs.decide': () => held })
  await panel.press({ type: 'Button', text: 'Approve…' })
  const confirm = panel.find({ type: 'Button', text: 'Approve' }) as TestElement
  const presses = [panel.press(confirm), panel.press(confirm)]
  await pause(10)
  release({ ok: true, message: 'Approved.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'runs.decide').length, 1)
})

test('only an approval the person can give shows Approve and Reject', async () => {
  const runs = [
    waitingRun(5, [approvalOf('ap-1', 5, { canApprove: true }), approvalOf('ap-2', 5, { canApprove: false })]),
    waitingRun(6, [approvalOf('ap-3', 6)])
  ]
  await open(runsSnapshotOf({ runs }))
  assert.equal(inside(cardOf(5), { type: 'Button', text: 'Approve…' }).length, 1)
  assert.equal(waitingBlocks(5).length, 2)
  assert.equal(inside(cardOf(6), { type: 'Button', text: 'Approve…' }).length, 0)
})

test('an open comment box and a result stay with their approval when the list reorders', async () => {
  const first = waitingRun(5, [approvalOf('ap-1', 5, { canApprove: true })], { queuedAt: NOW - 10 * MINUTE })
  const second = waitingRun(6, [approvalOf('ap-2', 6, { canApprove: true })], { queuedAt: NOW - 20 * MINUTE })
  await open(runsSnapshotOf({ runs: [first, second] }), { 'runs.decide': { ok: true, message: 'Approved.' } })
  assert.deepEqual(ids(), [5, 6])
  await panel.press(within(6, { type: 'Button', text: 'Approve…' }))
  await panel.type({ type: 'Textarea' }, 'For six')
  await panel.post('runs.changed', runsSnapshotOf({ runs: [{ ...second, queuedAt: NOW }, first], updatedAt: NOW + 1 }))
  assert.deepEqual(ids(), [6, 5])
  assert.equal(inside(cardOf(5), { type: 'Textarea' }).length, 0)
  assert.equal(panel.valueOf(within(6, { type: 'Textarea' })), 'For six')
  await panel.press(within(6, { type: 'Button', text: 'Approve' }))
  assert.equal(inside(cardOf(5), { type: 'Callout', text: 'Approved.' }).length, 0)
  await panel.post('runs.changed', runsSnapshotOf({ runs: [first, { ...second, queuedAt: NOW }], updatedAt: NOW + 2 }))
  assert.deepEqual(ids(), [6, 5])
  assert.equal(inside(cardOf(6), { type: 'Callout', text: 'Approved.' }).length, 1)
})

test('a result stays on the run after its approval leaves the snapshot', async () => {
  await open(approvable(), { 'runs.decide': { ok: true, message: 'Approved.' } })
  await panel.press({ type: 'Button', text: 'Approve…' })
  await panel.press({ type: 'Button', text: 'Approve' })
  await panel.post('runs.changed', runsSnapshotOf({ runs: [waitingRun(5, [], { state: 'running' })], updatedAt: NOW + 1 }))
  assert.equal(waitingBlocks(5).length, 0)
  assert.equal(within(5, { type: 'Callout', text: 'Approved.' }).props.tone, 'success')
})

test('Watch sends runs.watch and the bell follows the snapshot', async () => {
  let watched = false
  const host = await open(
    () => runsSnapshotOf({ runs: [runOf(7, { state: 'running', finishedAt: null, watched })] }),
    {
      'runs.watch': input => {
        watched = input.watched
        return runsSnapshotOf({ runs: [runOf(7, { state: 'running', finishedAt: null, watched })], updatedAt: NOW + 1 })
      }
    }
  )
  const bell = () => within(7, { type: 'IconButton' })
  assert.equal(bell().label, 'Watch')
  assert.equal(bell().props.icon, 'bell')
  assert.equal(bell().props.variant, 'ghost')
  await panel.press(bell())
  assert.deepEqual(inputsTo(host, 'runs.watch'), [{ org: 'contoso', projectId: 'proj-web', buildId: 7, watched: true }])
  assert.equal(bell().label, 'Stop watching')
  assert.equal(bell().props.variant, 'solid')
  await panel.press(bell())
  assert.deepEqual(inputsTo(host, 'runs.watch')[1], { org: 'contoso', projectId: 'proj-web', buildId: 7, watched: false })
  assert.equal(bell().label, 'Watch')
})

test('a finished run can be watched only while it is, and a failed watch shows its message under the run', async () => {
  const runs = [runOf(8, { finishedAt: NOW - HOUR }), runOf(9, { finishedAt: NOW - HOUR, watched: true }), runOf(10, { state: 'running', finishedAt: null })]
  await open(runsSnapshotOf({ runs }), {
    'runs.watch': () => {
      throw hostError('action_failed', 'You can watch up to 20 runs.')
    }
  })
  assert.equal(within(8, { type: 'IconButton' }).disabled, true)
  assert.equal(within(9, { type: 'IconButton' }).label, 'Stop watching')
  assert.equal(within(9, { type: 'IconButton' }).disabled, false)
  await panel.press(within(10, { type: 'IconButton' }))
  assert.equal(within(10, { type: 'Callout' }).text, 'You can watch up to 20 runs.')
  assert.equal(within(10, { type: 'Callout' }).props.tone, 'danger')
  assert.equal(inside(cardOf(8), { type: 'Callout' }).length, 0)
})

test('Open run sends runs.open and shows a refusal under that run', async () => {
  let answer: { opened: boolean; message?: string } = { opened: false, message: 'Focus a local workspace to open the run in.' }
  const host = await open(runsSnapshotOf({ runs: [runOf(1), runOf(2, { finishedAt: NOW - HOUR })] }), { 'runs.open': () => answer })
  await panel.press(within(2, { type: 'Button', text: 'Open run' }))
  const calls = requestsTo(host, 'runs.open')
  assert.deepEqual(calls.map(call => call.input), [{ org: 'contoso', projectId: 'proj-web', buildId: 2 }])
  assert.equal(calls[0].timeoutMs, 90_000)
  const refusal = within(2, { type: 'Callout' })
  assert.equal(refusal.props.tone, 'danger')
  assert.equal(refusal.text, 'Focus a local workspace to open the run in.')
  assert.equal(inside(cardOf(1), { type: 'Callout' }).length, 0)

  answer = { opened: true }
  await panel.press(within(2, { type: 'Button', text: 'Open run' }))
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a failed Open run shows the error message, and a refusal without words says so plainly', async () => {
  let answer: () => { opened: boolean; message?: string } = () => {
    throw hostError('action_failed', 'Orca could not open the run.')
  }
  await open(runsSnapshotOf({ runs: [runOf(1)] }), { 'runs.open': () => answer() })
  await panel.press({ type: 'Button', text: 'Open run' })
  assert.equal(within(1, { type: 'Callout' }).text, 'Orca could not open the run.')
  answer = () => ({ opened: false })
  await panel.press({ type: 'Button', text: 'Open run' })
  assert.equal(within(1, { type: 'Callout' }).text, 'Something went wrong.')
})

test('an open refusal stays with its run when the list reorders and clears when the org changes', async () => {
  const a = runOf(1, { state: 'running', queuedAt: NOW - 10 * MINUTE, finishedAt: null })
  const b = runOf(2, { state: 'running', queuedAt: NOW - 20 * MINUTE, finishedAt: null })
  await open(
    input => runsSnapshotOf({ org: input.org, runs: [a, b] }),
    { 'runs.open': { opened: false, message: 'Focus a local workspace to open the run in.' } },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  assert.deepEqual(ids(), [1, 2])
  await panel.press(within(2, { type: 'Button', text: 'Open run' }))
  await panel.post('runs.changed', runsSnapshotOf({ runs: [b, { ...a, queuedAt: NOW - 30 * MINUTE }], updatedAt: NOW + 1 }))
  assert.deepEqual(ids(), [2, 1])
  assert.equal(inside(cardOf(2), { type: 'Callout' }).length, 1)
  assert.equal(inside(cardOf(1), { type: 'Callout' }).length, 0)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('runs.changed replaces the list; a stale snapshot keeps it with the warning', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1)] }))
  assert.deepEqual(ids(), [1])
  await panel.post('runs.changed', runsSnapshotOf({ runs: [runOf(2), runOf(3, { finishedAt: NOW - HOUR })], updatedAt: NOW + 1 }))
  assert.deepEqual(ids(), [2, 3])

  await panel.post('runs.changed', runsSnapshotOf({ runs: [runOf(2)], stale: true, message: KEPT, updatedAt: NOW + 1 }))
  assert.deepEqual(ids(), [2])
  assert.equal(panel.find({ type: 'Text', text: KEPT })?.props.tone, 'warning')

  await panel.post('runs.changed', runsSnapshotOf({ runs: [runOf(2)], message: 'Some runs were left out.', updatedAt: NOW + 2 }))
  const note = panel.find({ type: 'Text', text: 'Some runs were left out.' })
  assert.equal(note?.props.muted, true)
  assert.equal(note?.props.tone, undefined)
  assert.equal(panel.find({ type: 'Text', text: KEPT }), null)
})

test('runs.changed for another org is ignored', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1)] }))
  await panel.post('runs.changed', runsSnapshotOf({ org: 'fabrikam', runs: [runOf(9)] }))
  assert.deepEqual(ids(), [1])
})

test('Refresh asks for runs.refresh and shows the result; a failure shows its message', async () => {
  let refreshes = 0
  const host = await open(runsSnapshotOf({ runs: [runOf(1)] }), {
    'runs.refresh': () => {
      refreshes += 1
      if (refreshes > 1) throw hostError('action_failed', 'Azure DevOps is unreachable.')
      return runsSnapshotOf({ runs: [runOf(2)], updatedAt: NOW + 1 })
    }
  })
  await panel.press({ label: 'Refresh' })
  assert.deepEqual(inputsTo(host, 'runs.refresh'), [{ org: 'contoso' }])
  assert.deepEqual(ids(), [2])
  await panel.press({ label: 'Refresh' })
  assert.deepEqual(ids(), [2])
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
  assert.equal(panel.find({ label: 'Refresh' })?.disabled, false)
})

test('the header shows when the list was updated', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1)] }))
  const updated = panel.find({ type: 'Text', text: /^Updated/ })
  assert.equal(updated?.props.muted, true)
  assert.ok(inside(updated as TestElement, { type: 'RelativeTime' })[0])
})

test('a failed first load shows the message and Try again loads again', async () => {
  let loads = 0
  await open(() => {
    loads += 1
    if (loads === 1) throw hostError('action_failed', 'Azure DevOps is unreachable.')
    return runsSnapshotOf({ runs: [runOf(1)] })
  })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is unreachable.')
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.deepEqual(ids(), [1])
})

const EMPTY: Record<RunFilter, [string, string]> = {
  mine: ['No runs of yours in the last 7 days', "Runs you queue or trigger in this organization's code projects show up here."],
  running: ['Nothing is running', 'Runs in progress in your code projects show up here.'],
  needsMe: ['Nothing needs you', "Approvals you can give, and your runs waiting for someone else's, show up here."],
  failed: ['No failed runs', 'Your runs that failed in the last 24 hours show up here until a newer run replaces them.']
}

test("each filter's empty state", async () => {
  await open(runsSnapshotOf())
  for (const [filter, label] of [['mine', 'Mine'], ['running', 'Running'], ['needsMe', 'Needs me'], ['failed', 'Failed']] as const) {
    await panel.press({ type: 'Button', text: label })
    const empty = panel.find({ type: 'EmptyState' })
    assert.equal(empty?.label, EMPTY[filter][0], filter)
    assert.equal(empty?.props.description, EMPTY[filter][1], filter)
    assert.equal(panel.find({ type: 'Card' }), null, filter)
  }
})

test('runs of others leave Mine empty while Running still lists them', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1, { mine: false, state: 'running', finishedAt: null })] }))
  assert.equal(panel.find({ type: 'EmptyState' })?.label, EMPTY.mine[0])
  await panel.press({ type: 'Button', text: 'Running' })
  assert.deepEqual(ids(), [1])
})

test('more than 30 runs shows the cap note', async () => {
  const runs = Array.from({ length: 45 }, (_, index) => runOf(1000 + index, { finishedAt: NOW - (index + 1) * MINUTE }))
  await open(runsSnapshotOf({ runs }))
  assert.equal(ids().length, 30)
  assert.equal(ids()[0], 1000)
  assert.equal(ids()[29], 1029)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 30 of 45 runs.' })?.props.muted, true)
})

test('thirty runs show no cap note', async () => {
  await open(runsSnapshotOf({ runs: Array.from({ length: 30 }, (_, index) => runOf(1000 + index)) }))
  assert.equal(ids().length, 30)
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
})

test('thirty runs with twelve stages and an approval each stay under 2,000 nodes', async () => {
  const stages = Array.from({ length: 12 }, (_, index) => stageOf(`Stage number ${index + 1}`, index < 8 ? 'succeeded' : 'waiting'))
  const runs = Array.from({ length: 30 }, (_, index) =>
    waitingRun(
      2000 + index,
      [
        approvalOf(`ap-${index}`, 2000 + index, {
          canApprove: true,
          instructions: 'z'.repeat(600),
          minRequired: 2,
          approvers: Array.from({ length: 3 }, (_, who) => ({ id: `u-${who}`, name: `Approver ${who}`, uniqueName: `a${who}@contoso.com`, isGroup: who === 2 }))
        })
      ],
      { stages, watched: index % 2 === 0 }
    )
  )
  await open(runsSnapshotOf({ runs }))
  assert.deepEqual(panel.errors, [])
  assert.equal(ids().length, 30)
  const nodes = countNodes(panel.tree())
  assert.ok(nodes < 2000, `${nodes} nodes`)
  await panel.press({ type: 'Button', text: 'Approve…' })
  assert.ok(countNodes(panel.tree()) < 2000)
})

test('only the selected tab is drawn, so the tabs never add up past the node limit', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1, { pipeline: { id: 8, name: 'Hidden pipeline' } })] }))
  const drawn = (text: string) => JSON.stringify(panel.tree()).includes(text)
  assert.equal(drawn('Hidden pipeline'), true)
  await panel.select({ type: 'Tabs' }, 'work')
  assert.equal(drawn('Hidden pipeline'), false)
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.equal(drawn('Hidden pipeline'), true)
})

test('visibility changes call ui.visibility with surface pipelines', async () => {
  const host = await open(input => runsSnapshotOf({ org: input.org }), {}, { orgs: [org('contoso'), org('fabrikam')] })
  const calls = () => inputsTo(host, 'ui.visibility').filter(input => (input as { surface: string }).surface === 'pipelines')
  assert.deepEqual(calls(), [{ surface: 'pipelines', org: 'contoso', visible: true }])

  await panel.rerender()
  assert.equal(calls().length, 1)

  await panel.setVisible(false)
  await panel.setVisible(false)
  assert.deepEqual(calls().slice(1), [{ surface: 'pipelines', org: 'contoso', visible: false }])

  await panel.setVisible(true)
  await panel.select({ type: 'Tabs' }, 'work')
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.deepEqual(calls().slice(2), [
    { surface: 'pipelines', org: 'contoso', visible: true },
    { surface: 'pipelines', org: 'contoso', visible: false },
    { surface: 'pipelines', org: 'contoso', visible: true }
  ])

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(calls().slice(5), [
    { surface: 'pipelines', org: 'contoso', visible: false },
    { surface: 'pipelines', org: 'fabrikam', visible: true }
  ])
})

test('a panel that starts hidden loads and reports nothing until it is shown', async () => {
  const host = await open(runsSnapshotOf({ runs: [runOf(1)] }), {}, { visible: false })
  assert.deepEqual(requestsTo(host, 'ui.visibility'), [])
  assert.deepEqual(requestsTo(host, 'runs.snapshot'), [])
  await panel.setVisible(true)
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [{ surface: 'pipelines', org: 'contoso', visible: true }])
  assert.deepEqual(ids(), [1])
})

test('the snapshot waits for the Pipelines tab and is asked for once', async () => {
  const host = await open(runsSnapshotOf({ runs: [runOf(1)] }), {}, { tab: 'work' })
  assert.deepEqual(requestsTo(host, 'runs.snapshot'), [])
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.deepEqual(inputsTo(host, 'runs.snapshot'), [{ org: 'contoso' }])
  await panel.select({ type: 'Tabs' }, 'work')
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.equal(requestsTo(host, 'runs.snapshot').length, 1)
  assert.deepEqual(ids(), [1])
})

test('settings hide the Pipelines surface and closing the panel does too', async () => {
  const host = await open(runsSnapshotOf(), { 'ado.projects': [], 'ado.teams': [] })
  await panel.press({ label: 'Organization settings' })
  assert.deepEqual(inputsTo(host, 'ui.visibility'), [
    { surface: 'pipelines', org: 'contoso', visible: true },
    { surface: 'pipelines', org: 'contoso', visible: false }
  ])
  await panel.press({ text: 'Back' })
  assert.equal(inputsTo(host, 'ui.visibility').length, 3)
  await panel.unmount()
  assert.deepEqual(inputsTo(host, 'ui.visibility').slice(3), [{ surface: 'pipelines', org: 'contoso', visible: false }])
})

test("switching organization loads that org and drops the other one's results", async () => {
  const host = await open(
    input => runsSnapshotOf({ org: input.org, runs: [runOf(input.org === 'contoso' ? 1 : 2, { pipeline: { id: 8, name: `${input.org}-ci` } })] }),
    { 'runs.open': { opened: false, message: 'Focus a local workspace to open the run in.' } },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  await panel.press({ type: 'Button', text: 'Open run' })
  assert.equal(panel.findAll({ type: 'Callout' }).length, 1)
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(cardOf(2).label, 'fabrikam-ci')
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(inputsTo(host, 'runs.snapshot'), [{ org: 'contoso' }, { org: 'fabrikam' }])
})

test('every waiting approval offers Share for approval, whether or not the person can approve it', async () => {
  const runs = [
    waitingRun(21, [approvalOf('a', 21, { canApprove: true }), approvalOf('b', 21)]),
    waitingRun(22, [approvalOf('c', 22)]),
    runOf(23)
  ]
  await open(runsSnapshotOf({ runs }))
  assert.equal(inside(cardOf(21), { type: 'Button', text: 'Share for approval' }).length, 2)
  assert.equal(inside(cardOf(22), { type: 'Button', text: 'Share for approval' }).length, 1)
  assert.equal(inside(cardOf(23), { type: 'Button', text: 'Share for approval' }).length, 0)
  assert.equal(within(22, { type: 'Button', text: 'Share for approval' }).props.variant, 'outline')
})

test('Share for approval opens the composer for that approval only', async () => {
  const runs = [waitingRun(31, [approvalOf('a', 31, { environment: 'staging' })]), waitingRun(32, [approvalOf('b', 32, { environment: null, stage: 'Deploy production' })])]
  const host = await open(runsSnapshotOf({ runs }))
  await panel.press(within(32, { type: 'Button', text: 'Share for approval' }))
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share for approval')
  assert.deepEqual(inputsTo(host, 'share.prefs'), [{ org: 'contoso', kind: 'approval' }])
  assert.deepEqual(
    panel.findAll({ type: 'Checkbox', label: /→/ }).map(box => [box.label, box.props.checked]),
    [['web-app-cd 20261105.32 → Deploy production', true]]
  )
  assert.equal(panel.find({ type: 'Card' }), null)
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.findAll({ type: 'Card' }).length, 2)
})

test('the header has a Teams channels button that opens the manager and Back returns to the runs', async () => {
  const host = await open(runsSnapshotOf({ runs: [runOf(41)] }), { 'share.channels': [] })
  const settings = panel.find({ label: 'Teams channels' })
  assert.equal(settings?.props.variant, 'ghost')
  await panel.press({ label: 'Teams channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  assert.deepEqual(inputsTo(host, 'share.channels'), [{}])
  assert.equal(panel.find({ type: 'Card' }), null)
  await panel.press({ type: 'Button', text: 'Back' })
  assert.deepEqual(ids(), [41])
})
