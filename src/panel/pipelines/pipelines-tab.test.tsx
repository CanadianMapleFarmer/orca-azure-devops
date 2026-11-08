import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TreeSnapshot } from 'orca/testing'
import type { RunActionResult, RunFilter, RunState, RunSummary, StepState } from '../../shared/pipelines'
import type { OrgStatus } from '../../shared/types'
import { CHOOSE_ALL } from '../copy'
import { closeCleanly, countNodes, mountPanel, org, reloadPanel, requestsTo, type TestHost } from '../test-support'
import { approvalLine } from './approval'
import { approvalOf, HOUR, largeRuns, MINUTE, NOW, runOf, runsSnapshotOf, stageOf, waitingRun } from './fixtures'
import { stageChips, STAGE_TONE } from './run-card'
import { runPlaces } from './state'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  visible?: boolean
  tab?: string
  filter?: string
  prefs?: Record<string, unknown>
}

async function open(snapshot: MockRequests['runs.snapshot'], more: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    { 'runs.snapshot': snapshot, ...more },
    {
      visible: options.visible,
      persisted: {
        plugin: options.prefs ? { runsPrefs: options.prefs } : {},
        workspace: { tab: options.tab ?? 'pipelines', ...(options.filter ? { pipelinesFilter: options.filter } : {}) }
      }
    }
  )
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const numberOf = (card: TestElement): number => Number(card.text.match(/20261105\.(\d+)/)?.[1])

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

const stageRow = (buildId: number): TestElement | undefined => inside(cardOf(buildId), { type: 'Row' }).find(row => row.props.gap === 'xs')

const stageBadges = (buildId: number): TestElement[] => {
  const row = stageRow(buildId)
  return row ? inside(row, { type: 'Badge' }) : []
}

const waitingLines = (buildId: number) => inside(cardOf(buildId), { type: 'Text' }).filter(line => line.props.tone === 'warning')

const textOf = (node: TreeSnapshot | string | undefined): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

function outline(): string[] {
  const lines: string[] = []
  const walk = (node: TreeSnapshot | string | null, depth: number): void => {
    if (node === null || typeof node === 'string') return
    let inner = depth
    if (node.type === 'Collapsible') {
      lines.push(`${'  '.repeat(depth)}${node.props?.title} [${node.props?.description}]`)
      inner += 1
    } else if (node.type === 'Card') {
      lines.push(`${'  '.repeat(depth)}#${/20261105\.(\d+)/.exec(textOf(node))?.[1]}`)
    }
    for (const child of node.children ?? []) walk(child, inner)
  }
  walk(panel.tree(), 0)
  return lines
}

const cardNode = (buildId: number): TreeSnapshot => {
  let found: TreeSnapshot | undefined
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string' || found) return
    if (node.type === 'Card' && textOf(node).includes(`20261105.${buildId}`)) found = node
    else node.children?.forEach(walk)
  }
  walk(panel.tree())
  assert.ok(found, `run ${buildId} is drawn`)
  return found
}

const WEB = { projectId: 'proj-web', projectName: 'Fabrikam Web' }
const TOOLS = { projectId: 'proj-tools', projectName: 'Contoso Tools' }
const BOARDS = { projectId: 'proj-boards', projectName: 'Fabrikam Boards' }
const WEB_APP = { id: 'repo-web-app', name: 'web-app' }
const WEB_API = { id: 'repo-api', name: 'fabrikam-api' }
const TOOLS_APP = { id: 'repo-tools-app', name: 'web-app' }

const runIn = (buildId: number, project: typeof WEB, repository: RunSummary['repository'], over: Partial<RunSummary> = {}): RunSummary =>
  runOf(buildId, { ...project, repository, ...over })

const everywhere =
  (runs: RunSummary[]): MockRequests['runs.snapshot'] =>
  input =>
    runsSnapshotOf({ org: input.org, runs })

const projectSelect = () => panel.find({ type: 'Select', label: 'Project' })
const repoSelect = () => panel.find({ type: 'Select', label: 'Repository' })
const optionsOf = (select: TestElement | null) => ((select?.props.options as { value: string; label: string }[] | undefined) ?? []).map(option => [option.value, option.label])

function groups(): { title: unknown; description: unknown; open: unknown }[] {
  const found: { title: unknown; description: unknown; open: unknown }[] = []
  const walk = (node: TreeSnapshot | string | null): void => {
    if (node === null || typeof node === 'string') return
    if (node.type === 'Collapsible') found.push({ title: node.props?.title, description: node.props?.description, open: node.props?.open })
    node.children?.forEach(walk)
  }
  walk(panel.tree())
  return found
}

const groupHeaders = () => groups().map(group => [group.title, group.description])
const groupStates = () => groups().map(group => [group.title, group.open])

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

test('runs show their state and the age of when they were queued, started or finished', async () => {
  const finished = (state: RunState) => state === 'succeeded' || state === 'warning' || state === 'failed' || state === 'canceled'
  const runs = STATES.map(([state], index) =>
    runOf(100 + index, {
      state,
      queuedAt: NOW - (10 + index) * MINUTE,
      startedAt: state === 'queued' ? null : NOW - (9 + index) * MINUTE,
      finishedAt: finished(state) ? NOW - 5 * MINUTE : null
    })
  )
  await open(runsSnapshotOf({ runs }))
  for (const [index, [state, text, tone]] of STATES.entries()) {
    const badge = within(100 + index, { type: 'Badge' })
    assert.equal(badge.text, text, state)
    assert.equal(badge.props.tone, tone, state)
  }
  const age = (buildId: number) => within(buildId, { type: 'RelativeTime' })
  assert.equal(age(100).props.at, runs[0].queuedAt)
  assert.equal(age(101).props.at, runs[1].startedAt)
  assert.equal(age(104).props.at, runs[4].finishedAt)
  for (const buildId of [100, 101, 104]) {
    assert.equal(age(buildId).props.format, 'short', String(buildId))
    assert.equal(age(buildId).props.muted, true, String(buildId))
  }
  for (const text of [/^queued /, /^started /, /^finished /]) assert.equal(inside(cardOf(100), { type: 'Text', text }).length, 0)
  assert.equal(inside(cardOf(105), { type: 'Text', text: /✓|✗/ }).length, 0)
})

test("stage chips show each stage's name and mark in its tone", async () => {
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
  await open(runsSnapshotOf({ runs: [runOf(1, { state: 'failed', stages: stages.map(([name, step]) => stageOf(name, step)) })] }))
  assert.deepEqual(
    stageBadges(1).map(chip => [chip.text, chip.props.tone]),
    [
      ['Build ✓', 'success'],
      ['Image ✗', 'danger'],
      ['Deploy production –', 'neutral'],
      ['Test !', 'warning'],
      ['Approve ⏸', 'warning'],
      ['Smoke ●', 'accent'],
      ['Lint ○', 'neutral'],
      ['Docs ⊘', 'neutral']
    ]
  )
  assert.equal(inside(cardOf(1), { type: 'Box' }).filter(box => box.props.width === 14).length, 0)
  assert.deepEqual(inside(cardOf(1), { type: 'Box' }).map(box => box.props.grow), [true])
  assert.deepEqual(panel.summary().filter(line => line.startsWith('Box')), [])
  assert.equal(inside(cardOf(1), { type: 'Text', text: /^Build ✓/ }).length, 0)
})

test('a run card names the pipeline, run, branch, PR and requester, and links to Azure DevOps', async () => {
  const running = { state: 'running', finishedAt: null } as const
  const runs = [
    runOf(201, { ...running, pipeline: { id: 9, name: 'web-app-cd' }, branch: 'main' }),
    runOf(202, { ...running, prId: 77, requestedFor: { id: 'u-grace', name: 'Grace Hopper' } })
  ]
  await open(runsSnapshotOf({ runs }), {}, { filter: 'running' })
  assert.equal(within(201, { type: 'Text', text: 'web-app-cd' }).props.weight, 'semibold')
  assert.equal(within(202, { type: 'Text', text: 'web-app-ci' }).props.weight, 'semibold')
  assert.equal(within(201, { type: 'Text', text: /^20261105\.201 / }).text, '20261105.201 · main · Ada Lovelace')
  assert.equal(within(202, { type: 'Text', text: /^20261105\.202 / }).text, '20261105.202 · PR !77 · Grace Hopper')
  assert.equal(within(201, { type: 'Link' }).text, 'Open in Azure DevOps')
  assert.equal(within(201, { type: 'Link' }).props.href, runs[0].url)
})

test('a run card shows the state, pipeline and age first, then the run number with the branch or PR', async () => {
  const run = runOf(301, {
    state: 'failed',
    pipeline: { id: 9, name: 'web-app-cd' },
    branch: 'main',
    startedAt: NOW - 29 * MINUTE,
    finishedAt: NOW - 10 * MINUTE,
    stages: [stageOf('Build', 'succeeded')]
  })
  await open(runsSnapshotOf({ runs: [run, runOf(302, { prId: 77 })] }))
  const card = cardNode(301)
  assert.equal(card.props?.title, undefined)
  assert.equal(card.props?.description, undefined)
  const [first, meta, chips, ...rest] = card.children as TreeSnapshot[]
  assert.deepEqual(first.children?.map(child => (child as TreeSnapshot).type), ['Badge', 'Box', 'RelativeTime'])
  const [badge, title, age] = first.children as TreeSnapshot[]
  assert.equal(textOf(badge), '✗ failed')
  assert.equal(badge.props?.tone, 'danger')
  assert.equal(title.props?.grow, true)
  const name = title.children?.[0] as TreeSnapshot
  assert.deepEqual([name.type, name.props?.weight, name.props?.truncate, textOf(name)], ['Text', 'semibold', true, 'web-app-cd'])
  assert.deepEqual([age.props?.at, age.props?.format, age.props?.muted], [run.finishedAt, 'short', true])
  assert.deepEqual([meta.type, meta.props?.size, meta.props?.muted, textOf(meta)], ['Text', 'sm', true, '20261105.301 · main'])
  assert.deepEqual(chips.children?.map(child => textOf(child)), ['Build ✓'])
  assert.deepEqual(rest.map(child => child.type), ['Row'])
  assert.equal(textOf(cardNode(302).children?.[1]), '20261105.302 · PR !77')
})

test('on Mine the requester is left out; on the other filters it is shown', async () => {
  const runs = [
    waitingRun(1, [approvalOf('ap-1', 1)]),
    runOf(2, { state: 'failed', finishedAt: NOW - 10 * MINUTE, branch: 'main', pipeline: { id: 21, name: 'web-app-ci' } })
  ]
  await open(runsSnapshotOf({ runs }))
  const metaOf = (buildId: number) => within(buildId, { type: 'Text', text: new RegExp(`^20261105\\.${buildId} `) }).text
  assert.deepEqual([metaOf(1), metaOf(2)], ['20261105.1 · main', '20261105.2 · main'])
  for (const [label, buildId] of [['Running', 1], ['Needs me · 1', 1], ['Failed · 1', 2]] as const) {
    await panel.press({ type: 'Button', text: label })
    assert.equal(metaOf(buildId), `20261105.${buildId} · main · Ada Lovelace`, label)
  }
  await panel.press({ type: 'Button', text: 'Mine' })
  assert.equal(metaOf(1), '20261105.1 · main')
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

test('stageChips maps every step state to its mark and tone', () => {
  const expected: [StepState, string, string][] = [
    ['succeeded', '✓', 'success'],
    ['failed', '✗', 'danger'],
    ['waiting', '⏸', 'warning'],
    ['warning', '!', 'warning'],
    ['running', '●', 'accent'],
    ['pending', '○', 'neutral'],
    ['skipped', '–', 'neutral'],
    ['canceled', '⊘', 'neutral']
  ]
  for (const [state, mark, tone] of expected) assert.deepEqual(stageChips([stageOf('Deploy production', state)]), [{ tone, text: `Deploy production ${mark}` }], state)
  assert.deepEqual(Object.keys(STAGE_TONE).sort(), expected.map(([state]) => state).sort())
  assert.deepEqual(stageChips([]), [])
  const many = Array.from({ length: 15 }, (_, index) => stageOf(`S${index + 1}`, 'succeeded'))
  assert.deepEqual(stageChips(many).map(chip => chip.text), many.slice(0, 12).map(stage => `${stage.name} ✓`))
})

test('a run with no stages or an empty stage list draws no stage chips', async () => {
  await open(runsSnapshotOf({ runs: [runOf(1, { stages: null }), runOf(2, { stages: [] }), runOf(3, { stages: [stageOf('Build', 'succeeded')] })] }))
  for (const buildId of [1, 2]) {
    assert.equal(stageRow(buildId), undefined, `run ${buildId} has no chip row`)
    assert.equal(inside(cardOf(buildId), { type: 'Badge' }).length, 1, `run ${buildId} shows only its state`)
    assert.deepEqual(inside(cardOf(buildId), { type: 'Box' }).map(box => box.props.grow), [true], `run ${buildId} draws only the growing title box`)
  }
  assert.deepEqual(stageBadges(3).map(chip => chip.text), ['Build ✓'])
  assert.deepEqual(inside(cardOf(3), { type: 'Box' }).map(box => box.props.grow), [true])
})

test('twelve stages draw twelve chips and no overflow count', async () => {
  const stages = Array.from({ length: 12 }, (_, index) => stageOf(`S${index + 1}`, 'succeeded'))
  await open(runsSnapshotOf({ runs: [runOf(1, { stages })] }))
  assert.deepEqual(
    stageBadges(1).map(chip => chip.text),
    stages.map(stage => `${stage.name} ✓`)
  )
  assert.equal(inside(cardOf(1), { type: 'Badge', text: /more/ }).length, 0)
  assert.equal(inside(cardOf(1), { type: 'Text', text: /more/ }).length, 0)
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

const GRACE = { id: 'u-grace', name: 'Grace Hopper', uniqueName: 'grace@contoso.com', isGroup: false }
const RELEASE = { id: 'g-release', name: 'Release approvers', uniqueName: 'release', isGroup: true }

test('Needs me shows the approval with approvers and waiting time', async () => {
  const approval = approvalOf('ap-1', 5, {
    approvers: [GRACE, RELEASE],
    minRequired: 2,
    instructions: 'Check the smoke tests first.',
    createdAt: NOW - 20 * MINUTE
  })
  await open(runsSnapshotOf({ runs: [waitingRun(5, [approval])] }), {}, { filter: 'needsMe' })
  assert.deepEqual(ids(), [5])
  const [line, ...others] = waitingLines(5)
  assert.equal(others.length, 0)
  assert.match(line.text, /^production needs 2 of Grace Hopper, Release approvers \(group\) · waiting /)
  assert.equal(line.props.size, 'sm')
  const waited = inside(line, { type: 'RelativeTime' })[0]
  assert.equal(waited.props.format, 'duration')
  assert.equal(waited.props.at, approval.createdAt)
  assert.equal(inside(cardOf(5), { type: 'Callout' }).length, 0)
  assert.equal(inside(cardOf(5), { type: 'Text', text: /^Approvers/ }).length, 0)
  assert.equal(inside(cardOf(5), { type: 'Text', text: 'Check the smoke tests first.' }).length, 0)
  assert.equal(inside(cardOf(5), { type: 'Button', text: /Approve|Reject/ }).length, 0)
})

test('a waiting approval shows one line: where, who and how long', async () => {
  const forms = [
    approvalOf('a', 41, { approvers: [GRACE] }),
    approvalOf('b', 42, { approvers: [GRACE, RELEASE], minRequired: 2 }),
    approvalOf('c', 43, { approvers: [], minRequired: 1 })
  ]
  const expected = [
    'production needs Grace Hopper',
    'production needs 2 of Grace Hopper, Release approvers (group)',
    'production'
  ]
  assert.deepEqual(forms.map(approvalLine), expected)
  await open(runsSnapshotOf({ runs: forms.map((approval, index) => waitingRun(41 + index, [approval])) }))
  for (const [index, approval] of forms.entries()) {
    const buildId = 41 + index
    const [line, ...others] = waitingLines(buildId)
    assert.equal(others.length, 0, `run ${buildId} has one line`)
    assert.ok(line.text.startsWith(`${expected[index]} · waiting `), line.text)
    assert.deepEqual([line.props.tone, line.props.size], ['warning', 'sm'])
    const waited = inside(line, { type: 'RelativeTime' })
    assert.deepEqual(waited.map(item => [item.props.at, item.props.format]), [[approval.createdAt, 'duration']])
  }
})

test('an approval names its environment, else its stage, else a stage; one approver needs no count; no approvers leave the place alone', async () => {
  const runs = [
    waitingRun(11, [approvalOf('a', 11, { environment: null, stage: 'Deploy production' })]),
    waitingRun(12, [approvalOf('b', 12, { environment: null, stage: null })]),
    waitingRun(13, [approvalOf('c', 13, { approvers: [], minRequired: 1 })])
  ]
  await open(runsSnapshotOf({ runs }))
  assert.match(waitingLines(11)[0].text, /^Deploy production needs Grace Hopper · waiting /)
  assert.match(waitingLines(12)[0].text, /^A stage needs Grace Hopper · waiting /)
  assert.match(waitingLines(13)[0].text, /^production · waiting /)
  assert.equal(inside(cardOf(13), { type: 'Text', text: /needs/ }).length, 0)
  assert.equal(inside(cardOf(11), { type: 'Text', text: /Approvers/ }).length, 0)
})

test('long instructions are cut at 500 characters with an ellipsis', async () => {
  const instructions = 'x'.repeat(600)
  await open(runsSnapshotOf({ runs: [waitingRun(5, [approvalOf('ap-1', 5, { instructions, canApprove: true })])] }))
  const shown = within(5, { type: 'Text', text: /^x+/ }).text
  assert.equal(shown.length, 500)
  assert.equal(shown, `${'x'.repeat(499)}…`)
  await panel.post('runs.changed', runsSnapshotOf({ runs: [waitingRun(5, [approvalOf('ap-1', 5, { instructions: 'y'.repeat(500), canApprove: true })])] }))
  assert.equal(within(5, { type: 'Text', text: /^y+/ }).text, 'y'.repeat(500))
})

test('Approve and Reject show only for an approval the person can give, with its instructions', async () => {
  const mine = approvalOf('ap-1', 5, { canApprove: true, instructions: 'Check the smoke tests first.', environment: 'production' })
  const theirs = approvalOf('ap-2', 5, { canApprove: false, instructions: 'Only for the release managers.', environment: 'staging' })
  await open(runsSnapshotOf({ runs: [waitingRun(5, [mine, theirs])] }))
  const shape = () => {
    const parts: string[] = []
    const walk = (node: TreeSnapshot | string): void => {
      if (typeof node === 'string') return
      if (node.type === 'Text' || node.type === 'Button') parts.push(textOf(node))
      else node.children?.forEach(walk)
    }
    walk(cardNode(5))
    return parts.filter(part => /needs|Approve…|Reject…|smoke|managers/.test(part)).map(part => part.replace(/ · waiting.*$/, ''))
  }
  assert.deepEqual(shape(), ['production needs Grace Hopper', 'Check the smoke tests first.', 'Approve…', 'Reject…', 'staging needs Grace Hopper'])
  assert.equal(inside(cardOf(5), { type: 'Text', text: 'Check the smoke tests first.' })[0].props.muted, true)
  assert.equal(inside(cardOf(5), { type: 'Text', text: 'Only for the release managers.' }).length, 0)
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
  assert.equal(waitingLines(5).length, 2)
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
  assert.equal(waitingLines(5).length, 0)
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

test('thirty runs with approvals across projects and repositories, all open, stay under 2,000 nodes and 450 KiB', async () => {
  await open(runsSnapshotOf({ runs: largeRuns() }))
  assert.deepEqual(panel.errors, [])
  assert.equal(ids().length, 30)
  assert.deepEqual(
    groupStates(),
    [
      ['Contoso Tools · web-app', true],
      ['Fabrikam Boards · boards-app', true],
      ['Fabrikam Web · 2 repos', true],
      ['fabrikam-api', true],
      ['web-app', true]
    ]
  )
  const withinLimits = () => {
    const nodes = countNodes(panel.tree())
    const bytes = new TextEncoder().encode(JSON.stringify(panel.tree())).length
    assert.ok(nodes < 2_000, `${nodes} nodes`)
    assert.ok(bytes < 450 * 1024, `${bytes} bytes`)
  }
  withinLimits()
  await panel.press({ type: 'Button', text: 'Approve…' })
  withinLimits()
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
  assert.ok(within(2, { type: 'Text', text: 'fabrikam-ci' }))
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(inputsTo(host, 'runs.snapshot'), [{ org: 'contoso' }, { org: 'fabrikam' }])
})

test('Share for approval shows only on a waiting run and shares every waiting approval of that run', async () => {
  const runs = [
    waitingRun(21, [approvalOf('a', 21, { canApprove: true }), approvalOf('b', 21, { environment: 'staging' })]),
    waitingRun(22, [approvalOf('c', 22)]),
    runOf(23),
    runOf(24, { state: 'running', finishedAt: null }),
    runOf(25, { approvals: [approvalOf('d', 25)] })
  ]
  const host = await open(runsSnapshotOf({ runs }))
  const shares = (buildId: number) => inside(cardOf(buildId), { type: 'Button', text: 'Share for approval' })
  assert.deepEqual([21, 22, 23, 24, 25].map(buildId => shares(buildId).length), [1, 1, 0, 0, 0])
  assert.deepEqual([shares(21)[0].props.variant, shares(21)[0].props.size], ['outline', 'sm'])

  await panel.press(shares(21)[0])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share for approval')
  assert.deepEqual(inputsTo(host, 'share.prefs'), [{ org: 'contoso', kind: 'approval' }])
  assert.deepEqual(
    panel.findAll({ type: 'Checkbox', label: /→/ }).map(box => [box.label, box.props.checked]),
    [
      ['web-app-cd 20261105.21 → production', true],
      ['web-app-cd 20261105.21 → staging', true]
    ]
  )
  assert.equal(panel.find({ type: 'Card' }), null)
  await panel.press({ type: 'Button', text: 'Back' })
  assert.deepEqual(ids(), [24, 22, 21, 25, 23])
})

test('Share for approval opens the composer for that run only', async () => {
  const runs = [waitingRun(31, [approvalOf('a', 31, { environment: 'staging' })]), waitingRun(32, [approvalOf('b', 32, { environment: null, stage: 'Deploy production' })])]
  await open(runsSnapshotOf({ runs }))
  await panel.press(within(32, { type: 'Button', text: 'Share for approval' }))
  assert.deepEqual(
    panel.findAll({ type: 'Checkbox', label: /→/ }).map(box => [box.label, box.props.checked]),
    [['web-app-cd 20261105.32 → Deploy production', true]]
  )
})

test('Share for approval suggests the approvers who are people, once each, apart from you', async () => {
  const alan = { id: 'u-alan', name: 'Alan Turing', uniqueName: 'alan@contoso.com', isGroup: false }
  const nameless = { id: 'u-nameless', name: 'Alex Contoso', uniqueName: '', isGroup: false }
  const me = { id: 'U-CONTOSO', name: 'Ada Lovelace', uniqueName: 'ada@contoso.com', isGroup: false }
  const run = waitingRun(5, [approvalOf('a', 5, { approvers: [GRACE, RELEASE, me] }), approvalOf('b', 5, { approvers: [alan, GRACE, nameless] })])
  await open(runsSnapshotOf({ runs: [run] }))
  await panel.press({ type: 'Button', text: 'Share for approval' })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Grace Hopper', 'Alan Turing'])
})

test('the toolbar has a Teams channels button that opens the manager and Back returns to the runs', async () => {
  const host = await open(runsSnapshotOf({ runs: [runOf(41)] }), { 'share.channels': [] })
  const toolbar = panel.findAll({ type: 'IconButton' }).filter(button => !['Watch', 'Add organization', 'Organization settings'].includes(button.label ?? ''))
  assert.deepEqual(
    toolbar.map(button => [button.label, button.props.icon, button.props.variant, button.props.size]),
    [
      ['Collapse all', 'collapse', 'ghost', 'sm'],
      ['Expand all', 'expand', 'ghost', 'sm'],
      ['Refresh', 'refresh', 'ghost', 'sm'],
      ['Teams channels', 'settings', 'ghost', 'sm']
    ]
  )
  await panel.press({ label: 'Teams channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  assert.deepEqual(inputsTo(host, 'share.channels'), [{}])
  assert.equal(panel.find({ type: 'Card' }), null)
  await panel.press({ type: 'Button', text: 'Back' })
  assert.deepEqual(ids(), [41])
})

test('Refresh is disabled while it refreshes', async () => {
  let release: (value: ReturnType<typeof runsSnapshotOf>) => void = () => {}
  const held = new Promise<ReturnType<typeof runsSnapshotOf>>(resolve => {
    release = resolve
  })
  await open(runsSnapshotOf({ runs: [runOf(1)] }), { 'runs.refresh': () => held })
  const pressed = panel.press({ label: 'Refresh' })
  await pause(10)
  assert.equal(panel.find({ label: 'Refresh' })?.disabled, true)
  release(runsSnapshotOf({ runs: [runOf(2)], updatedAt: NOW + 1 }))
  await pressed
  assert.equal(panel.find({ label: 'Refresh' })?.disabled, false)
  assert.deepEqual(ids(), [2])
})

test('runPlaces gives each run its project and repository, or no repository', () => {
  assert.deepEqual(runPlaces(runIn(1, WEB, WEB_APP)), [{ projectId: 'proj-web', projectName: 'Fabrikam Web', repoId: 'repo-web-app', repoName: 'web-app' }])
  assert.deepEqual(runPlaces(runIn(2, TOOLS, null)), [{ projectId: 'proj-tools', projectName: 'Contoso Tools', repoId: null, repoName: null }])
})

test('runs group by project, and a project with runs from several repositories splits into repository groups', async () => {
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, WEB_APP), runIn(2, WEB, WEB_API), runIn(3, TOOLS, TOOLS_APP), runIn(4, WEB, WEB_APP)] }))
  assert.deepEqual(outline(), [
    'Contoso Tools · web-app [1 run]',
    '  #3',
    'Fabrikam Web · 2 repos [3 runs]',
    '  fabrikam-api [1 run]',
    '    #2',
    '  web-app [2 runs]',
    '    #4',
    '    #1'
  ])
})

test('a project whose runs share one repository stays flat and names it in the header', async () => {
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, WEB_APP), runIn(2, WEB, WEB_APP), runIn(3, TOOLS, null)] }))
  assert.deepEqual(outline(), ['Contoso Tools [1 run]', '  #3', 'Fabrikam Web · web-app [2 runs]', '  #2', '  #1'])
})

test('pipelines named alike in different projects each sit under their own project', async () => {
  const alike = { pipeline: { id: 8, name: 'Build Pipeline' } }
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, null, alike), runIn(2, TOOLS, null, alike), runIn(3, BOARDS, null, alike)] }))
  assert.deepEqual(outline(), ['Contoso Tools [1 run]', '  #2', 'Fabrikam Boards [1 run]', '  #3', 'Fabrikam Web [1 run]', '  #1'])
  assert.equal(panel.findAll({ type: 'Text', text: 'Build Pipeline' }).length, 3)
})

test('runs without a repository sit under their project before its repository groups', async () => {
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, null), runIn(2, WEB, WEB_APP), runIn(3, WEB, WEB_API), runIn(4, WEB, null)] }))
  assert.deepEqual(outline(), ['Fabrikam Web · 2 repos [4 runs]', '  #4', '  #1', '  fabrikam-api [1 run]', '    #3', '  web-app [1 run]', '    #2'])
})

test('the project picker filters the runs, and the repository picker appears for a project with several repositories', async () => {
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, WEB_APP), runIn(2, WEB, WEB_API), runIn(3, TOOLS, TOOLS_APP)] }))
  assert.equal(projectSelect()?.props.labelHidden, true)
  assert.deepEqual(optionsOf(projectSelect()), [
    ['*', 'All projects'],
    ['proj-tools', 'Contoso Tools'],
    ['proj-web', 'Fabrikam Web']
  ])
  assert.equal(projectSelect()?.props.value, '*')
  assert.equal(repoSelect(), null)

  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.deepEqual(outline(), ['Contoso Tools · web-app [1 run]', '  #3'])
  assert.equal(repoSelect(), null)
  assert.deepEqual(panel.persisted.plugin.runsPrefs, { contoso: { project: 'proj-tools', repo: null } })

  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  assert.equal(repoSelect()?.props.labelHidden, true)
  assert.deepEqual(optionsOf(repoSelect()), [
    ['*', 'All repos'],
    ['repo-api', 'fabrikam-api'],
    ['repo-web-app', 'web-app']
  ])
  assert.equal(repoSelect()?.props.value, '*')
  assert.deepEqual(outline(), ['Fabrikam Web · 2 repos [2 runs]', '  fabrikam-api [1 run]', '    #2', '  web-app [1 run]', '    #1'])

  await panel.select({ type: 'Select', label: 'Repository' }, 'repo-api')
  assert.equal(repoSelect()?.props.value, 'repo-api')
  assert.deepEqual(outline(), ['Fabrikam Web · fabrikam-api [1 run]', '  #2'])
  assert.deepEqual(panel.persisted.plugin.runsPrefs, { contoso: { project: 'proj-web', repo: 'repo-api' } })

  await panel.select({ type: 'Select', label: 'Repository' }, '*')
  assert.deepEqual(panel.persisted.plugin.runsPrefs, { contoso: { project: 'proj-web', repo: null } })
  await panel.select({ type: 'Select', label: 'Project' }, '*')
  assert.equal(repoSelect(), null)
  assert.deepEqual(outline().filter(line => !line.startsWith(' ')), ['Contoso Tools · web-app [1 run]', 'Fabrikam Web · 2 repos [2 runs]'])
})

test('the chosen project and repository survive a reload, per organisation', async () => {
  const orgs = [org('contoso'), org('fabrikam')]
  const runs = [runIn(1, WEB, WEB_APP), runIn(2, WEB, WEB_API), runIn(3, TOOLS, TOOLS_APP)]
  await open(everywhere(runs), {}, { orgs })
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  await panel.select({ type: 'Select', label: 'Repository' }, 'repo-api')

  const reloaded = await reloadPanel(panel, orgs, { 'runs.snapshot': everywhere(runs) })
  panel = reloaded.panel
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-web', 'repo-api'])
  assert.deepEqual(outline(), ['Fabrikam Web · fabrikam-api [1 run]', '  #2'])

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual([projectSelect()?.props.value, repoSelect()], ['*', null])
  assert.equal(outline().filter(line => !line.startsWith(' ')).length, 2)
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')

  await panel.select({ label: 'Organization' }, 'contoso')
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-web', 'repo-api'])
  assert.deepEqual(panel.persisted.plugin.runsPrefs, {
    contoso: { project: 'proj-web', repo: 'repo-api' },
    fabrikam: { project: 'proj-tools', repo: null }
  })
})

test('a remembered project with nothing in it now shows All projects', async () => {
  const remembered = { contoso: { project: 'proj-gone', repo: 'repo-gone' } }
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, WEB_APP), runIn(2, TOOLS, TOOLS_APP)] }), {}, { prefs: remembered })
  assert.equal(projectSelect()?.props.value, '*')
  assert.equal(repoSelect(), null)
  assert.deepEqual(outline(), ['Contoso Tools · web-app [1 run]', '  #2', 'Fabrikam Web · web-app [1 run]', '  #1'])
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.deepEqual(panel.persisted.plugin.runsPrefs, remembered)

  const archive = { projectId: 'proj-gone', projectName: 'Contoso Archive' }
  const back = [runIn(1, WEB, WEB_APP), runIn(3, archive, { id: 'repo-gone', name: 'legacy-app' }), runIn(4, archive, { id: 'repo-other', name: 'legacy-api' })]
  await panel.post('runs.changed', runsSnapshotOf({ runs: back, updatedAt: NOW + 1 }))
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-gone', 'repo-gone'])
  assert.deepEqual(outline(), ['Contoso Archive · legacy-app [1 run]', '  #3'])
})

test('a chosen project stays chosen across filters and shows Nothing here when the filter is empty', async () => {
  const runs = [runIn(1, WEB, WEB_APP), runIn(2, TOOLS, TOOLS_APP, { mine: false, state: 'running', finishedAt: null })]
  await open(runsSnapshotOf({ runs }))
  const projects = optionsOf(projectSelect())
  assert.deepEqual(
    projects.map(([value]) => value),
    ['*', 'proj-tools', 'proj-web']
  )
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  const nothing = () => [panel.find({ type: 'EmptyState' })?.label, panel.find({ type: 'EmptyState' })?.props.description, panel.find({ type: 'Card' })]
  assert.deepEqual(nothing(), ['Nothing here for Contoso Tools', CHOOSE_ALL, null])

  await panel.press({ type: 'Button', text: 'Running' })
  assert.deepEqual(outline(), ['Contoso Tools · web-app [1 run · 1 running]', '  #2'])
  for (const label of ['Needs me', 'Failed']) {
    await panel.press({ type: 'Button', text: label })
    assert.deepEqual(nothing(), ['Nothing here for Contoso Tools', CHOOSE_ALL, null], label)
    assert.deepEqual(optionsOf(projectSelect()), projects, label)
    assert.equal(projectSelect()?.props.value, 'proj-tools', label)
  }
  await panel.select({ type: 'Select', label: 'Project' }, '*')
  assert.equal(panel.find({ type: 'EmptyState' })?.label, EMPTY.failed[0])
})

test('the cap applies after the project is chosen', async () => {
  const web = Array.from({ length: 35 }, (_, index) => runIn(1000 + index, WEB, null, { finishedAt: NOW - (index + 1) * MINUTE }))
  await open(runsSnapshotOf({ runs: [...web, runIn(2000, TOOLS, null), runIn(2001, TOOLS, null)] }))
  assert.equal(panel.find({ type: 'Text', text: 'Showing 30 of 37 runs.' })?.props.muted, true)
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.deepEqual(ids(), [2001, 2000])
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  assert.equal(ids().length, 30)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 30 of 35 runs.' })?.props.muted, true)
})

test('a group header counts its runs and says when one needs you, else failed, else running', async () => {
  const failed = (buildId: number, project: typeof WEB, over: Partial<RunSummary> = {}) =>
    runIn(buildId, project, null, { state: 'failed', finishedAt: NOW - 10 * MINUTE, pipeline: { id: 100 + buildId, name: 'web-app-ci' }, ...over })
  const running = (buildId: number, project: typeof WEB) =>
    runIn(buildId, project, null, { state: 'running', finishedAt: null, pipeline: { id: 100 + buildId, name: 'web-app-ci' } })
  const DATA = { projectId: 'proj-data', projectName: 'Fabrikam Data' }
  const runs = [
    waitingRun(1, [approvalOf('ap-1', 1)], { pipeline: { id: 101, name: 'web-app-cd' } }),
    failed(2, WEB),
    running(3, WEB),
    failed(4, TOOLS),
    failed(5, TOOLS),
    running(6, TOOLS),
    runIn(7, TOOLS, null, { pipeline: { id: 107, name: 'web-app-ci' } }),
    running(8, BOARDS),
    runIn(9, BOARDS, null, { pipeline: { id: 109, name: 'web-app-ci' } }),
    failed(10, DATA, { finishedAt: NOW - 3 * 24 * HOUR }),
    runIn(11, DATA, null, { pipeline: { id: 111, name: 'web-app-ci' } }),
    failed(13, DATA),
    runIn(14, DATA, null, { mine: false, pipeline: { id: 113, name: 'web-app-ci' }, queuedAt: NOW }),
    runIn(12, { projectId: 'proj-solo', projectName: 'Fabrikam Solo' }, null, { pipeline: { id: 112, name: 'web-app-ci' } })
  ]
  await open(runsSnapshotOf({ runs }))
  assert.deepEqual(groupHeaders(), [
    ['Contoso Tools', '4 runs · 2 failed'],
    ['Fabrikam Boards', '2 runs · 1 running'],
    ['Fabrikam Data', '3 runs'],
    ['Fabrikam Solo', '1 run'],
    ['Fabrikam Web', '3 runs · 1 needs you']
  ])
})

test('Collapse all and Expand all close and open every project and repository group', async () => {
  await open(runsSnapshotOf({ runs: [runIn(1, WEB, WEB_APP), runIn(2, WEB, WEB_API), runIn(3, TOOLS, TOOLS_APP)] }))
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app', true],
    ['Fabrikam Web · 2 repos', true],
    ['fabrikam-api', true],
    ['web-app', true]
  ])

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app', false],
    ['Fabrikam Web · 2 repos', false]
  ])
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|pipelines'], { all: 'closed', open: [], closed: [] })
  assert.equal(panel.find({ type: 'Card' }), null)

  await panel.toggle({ type: 'Collapsible', label: 'Fabrikam Web · 2 repos' })
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app', false],
    ['Fabrikam Web · 2 repos', true],
    ['fabrikam-api', false],
    ['web-app', false]
  ])
  assert.deepEqual((panel.persisted.plugin.folds as Record<string, unknown>)['contoso|pipelines'], { all: 'closed', open: ['project:proj-web'], closed: [] })

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(
    groupStates().map(([, open]) => open),
    [true, true, true, true]
  )
  assert.equal(panel.findAll({ type: 'Card' }).length, 3)
})

test('a project name over 1 KiB is cut in the picker, the group header and the empty state', async () => {
  const huge = { projectId: 'proj-huge', projectName: `${'Ωmega '.repeat(300)}`.trim() }
  await open(runsSnapshotOf({ runs: [runIn(1, huge, null, { mine: false, state: 'running', finishedAt: null })] }))
  const bytes = (text: unknown) => new TextEncoder().encode(String(text)).length
  await panel.press({ type: 'Button', text: 'Running' })
  assert.ok(bytes(groupHeaders()[0][0]) <= 1024)
  assert.ok(bytes(optionsOf(projectSelect())[1][1]) <= 1024)
  await panel.press({ type: 'Button', text: 'Mine' })
  assert.equal(panel.find({ type: 'EmptyState' })?.label, EMPTY.mine[0])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-huge')
  assert.ok(bytes(panel.find({ type: 'EmptyState' })?.label) <= 1024)
})
