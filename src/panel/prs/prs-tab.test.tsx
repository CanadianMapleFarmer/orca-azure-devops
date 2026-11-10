import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import type { PrSnapshot, PrSummary, RowResult } from '../../shared/prs'
import type { OrgStatus } from '../../shared/types'
import { CHOOSE_ALL } from '../copy'
import { closeCleanly, countNodes, mountPanel, org, reloadPanel, requestsTo, type TestHost } from '../test-support'
import { largeSets, NOW, OPTIONS, prOf, reviewerOf, setOf, snapshotOf } from './fixtures'
import { REVIEW_KEY, reviewOf } from './review/fixtures'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  visible?: boolean
  tab?: string
  prefs?: Record<string, unknown>
}

async function open(snapshot: MockRequests['prs.snapshot'], more: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    { 'prs.snapshot': snapshot, ...more },
    { visible: options.visible, persisted: { plugin: options.prefs ? { prsPrefs: options.prefs } : {}, workspace: { tab: options.tab ?? 'prs' } } }
  )
  panel = mounted.panel
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const inside = (parent: TestElement, query: TestQuery) => panel.findAll(query).filter(item => item.path.startsWith(`${parent.path}/`))

const isCardBox = (props: Readonly<Record<string, unknown>> | undefined) => props?.background === 'card' && props.border === true

function cards(): TestElement[] {
  const keys: string[] = []
  walk(node => {
    if (node.type === 'Box' && isCardBox(node.props) && node.key) keys.push(node.key)
    return false
  })
  return keys.map(key => {
    const card = panel.find({ testId: key })
    assert.ok(card, `the card keyed ${key} is found`)
    return card
  })
}

const linesOf = (card: TestElement) => inside(card, { type: 'Text' })

const titleOf = (card: TestElement) => linesOf(card)[0]?.text

const titles = () => cards().map(titleOf)

const cardOf = (title: string): TestElement => {
  const card = cards().find(item => titleOf(item) === title)
  assert.ok(card, `${title} is drawn`)
  return card
}

const branchOf = (card: TestElement) => {
  const line = linesOf(card)[1]
  return [line?.text, line?.props.size, line?.props.muted]
}

const nextPath = (path: string) => path.replace(/\d+$/, digits => String(Number(digits) + 1))

const rowOf = (prId: number) => panel.find({ type: 'Row', text: new RegExp(`^!${prId} →`) })

const rowText = (prId: number) => {
  const row = rowOf(prId)
  if (!row) return undefined
  const waiting = panel.findAll({ type: 'Text', text: /^waiting for / }).find(line => line.path === nextPath(row.path))
  return waiting ? `${row.text} ${waiting.text}` : row.text
}

const badgesIn = (title: string) => inside(cardOf(title), { type: 'Badge' }).map(badge => [badge.text, badge.props.tone])

const linksIn = (title: string) => inside(cardOf(title), { type: 'Link' }).map(link => link.text)

const buttonsIn = (title: string) => inside(cardOf(title), { type: 'Button' }).map(button => [button.text, button.props.variant, button.props.tone, button.props.size])

const mineButton = () => panel.find({ type: 'Button', text: 'Mine' })

const reviewButton = () => panel.find({ type: 'Button', text: /^To review/ })

const showToReview = () => panel.press({ type: 'Button', text: /^To review/ })

const views = () => [mineButton()?.props.variant, reviewButton()?.props.variant]

const projectSelect = () => panel.find({ type: 'Select', label: 'Project' })

const repoSelect = () => panel.find({ type: 'Select', label: 'Repository' })

const resultLines = () => panel.findAll({ type: 'Text', text: /^Pull Request \d+: / })

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const urlOf = (prId: number) => `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${prId}`

const textOf = (node: TreeSnapshot | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))

function walk(visit: (node: TreeSnapshot, depth: number) => boolean): void {
  const step = (node: TreeSnapshot | string | null, depth: number): void => {
    if (node === null || typeof node === 'string') return
    const deeper = visit(node, depth) ? depth + 1 : depth
    node.children?.forEach(child => step(child, deeper))
  }
  step(panel.tree(), 0)
}

function outline(): string[] {
  const lines: string[] = []
  walk((node, depth) => {
    const indent = '  '.repeat(depth)
    if (node.type === 'Collapsible') lines.push(`${indent}${node.props?.title}${node.props?.description ? ` [${node.props.description}]` : ''}`)
    if (node.type === 'Box' && isCardBox(node.props) && node.children?.[0]) lines.push(`${indent}${textOf(node.children[0])}`)
    if (node.type === 'ListItem') lines.push(`${indent}- ${node.props?.title}`)
    return node.type === 'Collapsible'
  })
  return lines
}

function groups(): [unknown, unknown, unknown][] {
  const found: [unknown, unknown, unknown][] = []
  walk(node => {
    if (node.type === 'Collapsible') found.push([node.props?.title, node.props?.description, node.props?.open])
    return false
  })
  return found
}

const headers = () => groups().map(([title, description]) => [title, description])

const groupStates = () => groups().map(([title, , open]) => [title, open])

function withinLimits(): void {
  const nodes = countNodes(panel.tree())
  const bytes = new TextEncoder().encode(JSON.stringify(panel.tree())).length
  assert.ok(nodes < 4_000, `${nodes} nodes`)
  assert.ok(bytes < 450 * 1024, `${bytes} bytes`)
}

const KEPT = 'Azure DevOps is unreachable. Showing the last results.'

const OPEN_UNAVAILABLE = "Orca couldn't ask to open the link. Bring its window to the front and try again."

const optionsSentence = (strategy: string, source: 'deletes' | 'keeps', items: string) =>
  `Auto-complete uses ${strategy}, ${source} the source branch, ${items}. Change this in Settings → Azure DevOps.`

const WEB = { projectId: 'proj-web', projectName: 'Fabrikam Web' }
const TOOLS = { projectId: 'proj-tools', projectName: 'Contoso Tools' }
const BOARDS = { projectId: 'proj-boards', projectName: 'Fabrikam Boards' }
const WEB_APP = { repoId: 'repo-web', repoName: 'web-app' }
const WEB_API = { repoId: 'repo-api', repoName: 'fabrikam-api' }
const TOOLS_APP = { repoId: 'repo-tools-app', repoName: 'web-app' }
const BOARDS_APP = { repoId: 'repo-boards', repoName: 'boards-app' }

const prIn = (prId: number, project: typeof WEB, repo: typeof WEB_APP, over: Partial<PrSummary> = {}): PrSummary => prOf(prId, { ...project, ...repo, ...over })

const myVote = (vote: number) => reviewerOf('Ada Lovelace', vote, { id: 'u-contoso' })

const everywhere =
  (over: Partial<PrSnapshot>): MockRequests['prs.snapshot'] =>
  input =>
    snapshotOf({ ...over, org: input.org })

const maxChips: Partial<PrSummary> = {
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
      prOf(58, { target: 'develop', checks: { build: 'running', policies: 'pending' } }),
      prOf(59, { target: 'release', status: 'abandoned', closedAt: NOW - 60_000 })
    ],
    { title: 'Fix the sign-in redirect', sources: ['feature/login', 'feature/logout'] }
  )

test('a set card shows the branch pattern and one row per pull request with its chips and who it waits for', async () => {
  await open(snapshotOf({ sets: [mixedSet()] }))
  assert.deepEqual(titles(), ['Fix the sign-in redirect'])
  const card = cardOf('Fix the sign-in redirect')
  assert.deepEqual([card.props.border, card.props.radius, card.props.background, card.props.padding, card.props.gap], [true, 'md', 'card', 'sm', 'xs'])
  assert.deepEqual([linesOf(card)[0]?.props.weight, linesOf(card)[0]?.props.size], ['semibold', 'sm'])
  assert.deepEqual(branchOf(card), ['feature/log*', 'xs', true])
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => [link.text, link.props.href]),
    [55, 56, 57, 58, 59].map(id => [`!${id}`, urlOf(id)])
  )
  assert.equal(rowText(55), '!55 → develop ✓ build · auto-complete waiting for Edsger Dijkstra')
  assert.equal(rowText(56), '!56 → qa draft · conflicts')
  assert.equal(rowText(57), '!57 → main merged')
  assert.equal(rowText(58), '!58 → develop ● build')
  assert.equal(rowText(59), '!59 → release abandoned')
  assert.deepEqual(badgesIn('Fix the sign-in redirect'), [
    ['✓ build · auto-complete', 'success'],
    ['draft · conflicts', 'danger'],
    ['merged', 'success'],
    ['● build', 'warning'],
    ['abandoned', 'neutral']
  ])
  const waiting = panel.findAll({ type: 'Text', text: /^waiting for/ })
  assert.deepEqual(
    waiting.map(line => [line.text, line.props.size, line.props.muted]),
    [['waiting for Edsger Dijkstra', 'xs', true]]
  )
})

test('a pull request row keeps its id, target and place chip together and its status chip apart, so neither breaks mid-word', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf(
          [
            prIn(70, WEB, WEB_APP, { target: 'release/2026.11-hotfix', checks: { build: 'failed', policies: 'none' } }),
            prIn(71, TOOLS, TOOLS_APP, { reviewers: [reviewerOf('Grace Hopper', 0, { isRequired: true })] })
          ],
          { title: 'Rename the tenant setting' }
        )
      ]
    })
  )
  const row = rowOf(70)
  assert.ok(row)
  assert.deepEqual([row.props.justify, row.props.align, row.props.gap, row.props.wrap], ['between', 'center', 'xs', true])
  const parts = (prId: number) => {
    const found = rowOf(prId)
    assert.ok(found, `!${prId} is drawn`)
    return inside(found, { type: 'Box' }).map(part => [part.text, part.props.direction, part.props.shrink])
  }
  assert.deepEqual(parts(70), [
    ['!70 → release/2026.11-hotfix Fabrikam Web / web-app', 'row', false],
    ['✗ build', 'row', false]
  ])
  const [left] = inside(row, { type: 'Box' })
  assert.deepEqual([left?.props.wrap, left?.props.maxWidth], [true, '100%'])
  assert.deepEqual(
    inside(row, { type: 'Text' }).map(text => [text.text, text.props.size]),
    [['→ release/2026.11-hotfix', 'sm']]
  )
  assert.deepEqual(parts(71), [['!71 → develop Contoso Tools / web-app', 'row', false]])
  assert.equal(rowText(71), '!71 → develop Contoso Tools / web-app waiting for Grace Hopper')
})

test('a set with no source branch draws no empty branch line', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)], { sources: [] })] }))
  assert.deepEqual(
    linesOf(cardOf('Change 55')).map(line => line.text),
    ['Change 55', '→ develop']
  )
})

test('only a required reviewer who has not voted and not declined counts as waited for', async () => {
  const pr = prOf(55, {
    reviewers: [
      reviewerOf('Ada Optional', 0),
      reviewerOf('Declined Required', 0, { isRequired: true, hasDeclined: true }),
      reviewerOf('Approved Required', 10, { isRequired: true }),
      reviewerOf('Rejected Required', -10, { isRequired: true }),
      reviewerOf('Pending Required', 0, { isRequired: true })
    ]
  })
  await open(snapshotOf({ sets: [setOf([pr])] }))
  assert.equal(rowText(55), '!55 → develop rejected waiting for Pending Required')
  assert.equal(panel.find({ type: 'Badge', text: 'rejected' })?.props.tone, 'danger')
})

test('several waited-for reviewers share one line', async () => {
  const pr = prOf(55, { reviewers: [reviewerOf('Edsger Dijkstra', 0, { isRequired: true }), reviewerOf('Barbara Liskov', 0, { isRequired: true })] })
  await open(snapshotOf({ sets: [setOf([pr])] }))
  assert.equal(rowText(55), '!55 → develop waiting for Edsger Dijkstra, Barbara Liskov')
  assert.equal(panel.findAll({ type: 'Text', text: /^waiting for/ }).length, 1)
})

test('a reviewer who voted Waiting for author shows a warning chip, required or not, and is not waited for', async () => {
  const pr = prOf(55, {
    reviewers: [
      reviewerOf('Author Required', -5, { isRequired: true }),
      reviewerOf('Author Optional', -5),
      reviewerOf('Pending Required', 0, { isRequired: true })
    ]
  })
  await open(snapshotOf({ sets: [setOf([pr, prOf(56, { reviewers: [reviewerOf('Solo Author', -5)] })])] }))
  assert.equal(rowText(55), '!55 → develop waiting for author waiting for Pending Required')
  assert.equal(rowText(56), '!56 → develop waiting for author')
  assert.deepEqual(
    panel.findAll({ type: 'Badge', text: 'waiting for author' }).map(badge => badge.props.tone),
    ['warning', 'warning']
  )
  assert.equal(panel.find({ type: 'Text', text: /^waiting for (Author|Solo)/ }), null)
})

test("Approve sends prs.approve with the set's active pull requests and shows each row's result", async () => {
  const results: RowResult[] = [
    { prId: 55, ok: true, message: 'Approved.' },
    { prId: 56, ok: true, warn: true, message: 'Already set to auto-complete. It will delete the source branch Pull Request 59 also uses.' },
    { prId: 59, ok: false, message: 'You need Contribute access to approve.' }
  ]
  const host = await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56), prOf(57, { status: 'completed', closedAt: NOW }), prOf(59, { isDraft: true })])] }), {
    'prs.approve': { results }
  })
  assert.equal(panel.find({ type: 'Callout' }), null)
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.deepEqual(inputsTo(host, 'prs.approve'), [{ org: 'contoso', prs: [55, 56, 59].map(prId => ({ projectId: 'proj-web', repoId: 'repo-web', prId })) }])
  assert.equal(requestsTo(host, 'prs.approve')[0]?.timeoutMs, 90000)
  assert.equal(requestsTo(host, 'prs.autoComplete').length, 0)
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'warning')
  assert.deepEqual(
    resultLines().map(row => [row.text, row.props.tone]),
    [
      ['Pull Request 55: Approved.', 'success'],
      ['Pull Request 56: Already set to auto-complete. It will delete the source branch Pull Request 59 also uses.', 'warning'],
      ['Pull Request 59: You need Contribute access to approve.', 'danger']
    ]
  )
})

test('Auto-complete sends prs.autoComplete; its tooltip reflects the snapshot', async () => {
  const options = { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: true } as const
  const host = await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56)])], autoComplete: options }), {
    'prs.autoComplete': {
      results: [
        { prId: 55, ok: true, message: 'Auto-complete set.' },
        { prId: 56, ok: true, message: 'Auto-complete set. Source branch kept: Pull Request 55 also uses it.' }
      ]
    }
  })
  const tooltip = () => panel.find({ type: 'Button', text: 'Auto-complete' })?.props.tooltip
  assert.equal(tooltip(), optionsSentence('Squash commit', 'deletes', 'completes linked work items'))
  await panel.press({ type: 'Button', text: 'Auto-complete' })
  assert.deepEqual(inputsTo(host, 'prs.autoComplete'), [{ org: 'contoso', prs: [55, 56].map(prId => ({ projectId: 'proj-web', repoId: 'repo-web', prId })) }])
  assert.equal(requestsTo(host, 'prs.autoComplete')[0]?.timeoutMs, 90000)
  assert.equal(requestsTo(host, 'prs.approve').length, 0)
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'success')
  assert.equal(resultLines().length, 2)

  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(55), prOf(56)])], autoComplete: { ...OPTIONS, mergeStrategy: 'rebaseMerge' } }))
  assert.equal(tooltip(), optionsSentence('Semi-linear merge', 'keeps', 'leaves work items alone'))
})

test("the auto-complete settings sentence is the Auto-complete button's tooltip, not a line in the list", async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)], { title: 'Open' }), setOf([prOf(56, { autoComplete: true })], { title: 'Already set' })] }))
  const sentence = optionsSentence('Merge (no fast-forward)', 'keeps', 'leaves work items alone')
  assert.equal(panel.find({ type: 'Text', text: /^Auto-complete uses/ }), null)
  assert.deepEqual(
    panel.findAll({ type: 'Button', text: 'Auto-complete' }).map(button => [button.props.tooltip, button.path.startsWith(`${cardOf('Open').path}/`)]),
    [[sentence, true]]
  )
  assert.equal(JSON.stringify(panel.tree()).split('Auto-complete uses').length - 1, 1)
})

test('the Auto-complete tooltip names each merge type', async () => {
  const labels = { noFastForward: 'Merge (no fast-forward)', squash: 'Squash commit', rebase: 'Rebase and fast-forward', rebaseMerge: 'Semi-linear merge' } as const
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }))
  for (const [strategy, label] of Object.entries(labels)) {
    await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(55)])], autoComplete: { ...OPTIONS, mergeStrategy: strategy as keyof typeof labels } }))
    assert.equal(panel.find({ type: 'Button', text: 'Auto-complete' })?.props.tooltip, optionsSentence(label, 'keeps', 'leaves work items alone'), strategy)
  }
})

test('a failed action shows the message and frees the buttons', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }), {
    'prs.approve': () => {
      throw hostError('action_failed', 'Azure DevOps refused the request.')
    }
  })
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps refused the request.')
  assert.equal(panel.find({ type: 'Button', text: 'Approve' })?.disabled, false)
})

test('both buttons are disabled while an action runs and absent when no pull request needs them', async () => {
  let release: (value: { results: RowResult[] }) => void = () => {}
  const held = new Promise<{ results: RowResult[] }>(resolve => {
    release = resolve
  })
  await open(
    snapshotOf({
      sets: [setOf([prOf(55)], { title: 'First' }), setOf([prOf(60)], { title: 'Second' }), setOf([prOf(70, { status: 'completed', closedAt: NOW })], { title: 'Merged' })]
    }),
    { 'prs.approve': () => held }
  )
  const buttons = (text: string) => panel.findAll({ type: 'Button', text }).map(button => button.disabled)
  assert.deepEqual(buttons('Approve'), [false, false])
  assert.deepEqual(buttons('Auto-complete'), [false, false])
  assert.deepEqual(buttonsIn('Merged'), [['Share…', 'solid', 'accent', 'xs']])
  const pending = panel.press(panel.findAll({ type: 'Button', text: 'Approve' })[0])
  await pause(10)
  assert.deepEqual(buttons('Approve'), [true, false])
  assert.deepEqual(buttons('Auto-complete'), [true, false])
  release({ results: [{ prId: 55, ok: true, message: 'Approved.' }] })
  await pending
  assert.deepEqual(buttons('Approve'), [false, false])
})

test('an action result stays with its PRs when the set key changes and is never persisted', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55), prOf(56)], { key: 'contoso:55' })] }), {
    'prs.approve': { results: [{ prId: 55, ok: true, message: 'Approved.' }, { prId: 56, ok: true, message: 'Approved.' }] }
  })
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(resultLines().length, 2)
  await panel.post('prs.changed', snapshotOf({ sets: [setOf([prOf(56), prOf(57)], { key: 'contoso:56' })], updatedAt: NOW + 1 }))
  assert.equal(resultLines().length, 2)
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

test('the toolbar holds the pickers, Mine and To review, then Collapse all, Expand all, Refresh and Teams channels', async () => {
  const host = await open(snapshotOf({ sets: [setOf([prOf(55, { title: 'Back again' })])] }), { 'share.channels': [] })
  const toolbar = panel.findAll({ type: 'IconButton' }).filter(button => !['Add organization', 'Organization settings'].includes(button.label ?? ''))
  assert.deepEqual(
    toolbar.map(button => [button.label, button.props.icon, button.props.variant, button.props.size]),
    [
      ['Collapse all', 'collapse', 'ghost', 'xs'],
      ['Expand all', 'expand', 'ghost', 'xs'],
      ['Refresh', 'refresh', 'ghost', 'xs'],
      ['Teams channels', 'settings', 'ghost', 'xs']
    ]
  )
  assert.equal(projectSelect()?.props.labelHidden, true)
  assert.deepEqual(
    [mineButton(), reviewButton()].map(button => [button?.text, button?.props.size, button?.props.variant]),
    [
      ['Mine', 'xs', 'outline'],
      ['To review', 'xs', 'ghost']
    ]
  )
  await panel.press({ label: 'Teams channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  assert.deepEqual(inputsTo(host, 'share.channels'), [{}])
  await panel.press({ type: 'Button', text: 'Back' })
  assert.deepEqual(titles(), ['Back again'])
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

test('To review opens the review in the panel on press', async () => {
  const grace = { id: 'u-grace', name: 'Grace Hopper' }
  const toReview = [
    prOf(4110, { title: 'Harden the login redirect', source: 'hotfix/1211-login-redirect', target: 'main', createdBy: grace, createdAt: NOW - 3_600_000 }),
    prOf(81, { title: 'Fix the footer' })
  ]
  const host = await open(snapshotOf({ toReview, toReviewCount: 2 }), { 'reviews.open': input => reviewOf({ key: input, pr: toReview[0] }) })
  assert.equal(panel.find({ type: 'ListItem' }), null)
  await showToReview()
  const items = panel.findAll({ type: 'ListItem' })
  assert.deepEqual(items.map(item => [item.label, item.props.description]), [
    ['Harden the login redirect', '!4110 · Grace Hopper'],
    ['Fix the footer', '!81 · Ada Lovelace']
  ])
  await panel.press({ type: 'ListItem', label: 'Harden the login redirect' })
  assert.deepEqual(inputsTo(host, 'reviews.open'), [REVIEW_KEY])
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Harden the login redirect')
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  assert.equal(
    panel.find({ type: 'Text', text: /^Pull Request 4110 ·/ })?.text,
    'Pull Request 4110 · web-app · hotfix/1211-login-redirect → main'
  )
  assert.match(panel.find({ type: 'Text', text: /^Grace Hopper · opened / })?.text ?? '', /^Grace Hopper · opened .+ · loaded .+$/)
  assert.deepEqual(
    panel.findAll({ type: 'RelativeTime' }).map(time => time.props.at),
    [NOW - 3_600_000, NOW]
  )
  assert.deepEqual(panel.persisted.workspace.openReview, { ...REVIEW_KEY, title: 'Harden the login redirect' })
})

test('Reviewed by you lists the PRs I voted on with my vote', async () => {
  const grace = { id: 'u-grace', name: 'Grace Hopper' }
  const reviewed = [
    prIn(90, WEB, WEB_API, { title: 'Add the health endpoint', createdBy: grace, reviewers: [myVote(5)] }),
    prOf(91, { title: 'Rework the cache', createdBy: grace, reviewers: [reviewerOf('Dennis Ritchie', 10), myVote(-5)] }),
    prOf(92, { title: 'Drop the legacy route', createdBy: grace, reviewers: [myVote(-10)] }),
    prIn(93, TOOLS, TOOLS_APP, { title: 'Pin the base image', createdBy: grace, reviewers: [myVote(10)] })
  ]
  const host = await open(snapshotOf({ reviewed, toReview: [prOf(80, { title: 'Cache the lookups' })], toReviewCount: 1 }), {
    'reviews.open': input => reviewOf({ key: input, pr: reviewed[0] })
  })
  await showToReview()
  assert.deepEqual(headers().at(-1), ['Reviewed by you · 4 pull requests', undefined])
  const rowsOf = (label: string) => {
    const list = panel.find({ type: 'List', label })
    assert.ok(list, `${label} is drawn`)
    return panel.findAll({ type: 'ListItem' }).filter(item => item.path.startsWith(`${list.path}/`)).map(item => [item.label, item.props.description])
  }
  assert.deepEqual(rowsOf('To review in Fabrikam Web · web-app'), [['Cache the lookups', '!80 · Ada Lovelace']])
  assert.deepEqual(rowsOf('Reviewed by you'), [
    ['Add the health endpoint', '!90 · Fabrikam Web / fabrikam-api · Grace Hopper · you: Approved with suggestions'],
    ['Rework the cache', '!91 · Fabrikam Web / web-app · Grace Hopper · you: Waiting for author'],
    ['Drop the legacy route', '!92 · Fabrikam Web / web-app · Grace Hopper · you: Rejected'],
    ['Pin the base image', '!93 · Contoso Tools / web-app · Grace Hopper · you: Approved']
  ])
  await panel.press({ type: 'ListItem', label: 'Add the health endpoint' })
  assert.deepEqual(inputsTo(host, 'reviews.open'), [{ ...REVIEW_KEY, repoId: 'repo-api', prId: 90 }])
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Add the health endpoint')
  assert.deepEqual(host.callsOf('shell.openExternal'), [])
})

test('To review shows reviewed pull requests alone, and its switch reads just To review', async () => {
  const reviewed = [prOf(90, { title: 'Add the health endpoint', reviewers: [myVote(10)] })]
  await open(snapshotOf({ reviewed }))
  assert.equal(reviewButton()?.text, 'To review')
  await showToReview()
  assert.equal(panel.find({ type: 'List', label: /^To review/ }), null)
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Add the health endpoint'])
})

test('Reviewed by you shows at most 50 pull requests and is absent when empty', async () => {
  const reviewed = Array.from({ length: 60 }, (_, index) => prOf(100 + index, { title: `Voted ${index}` }))
  await open(snapshotOf({ reviewed, toReview: [prOf(80)], toReviewCount: 1 }))
  await showToReview()
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 51)
  await panel.post('prs.changed', snapshotOf({ toReview: [prOf(80)], toReviewCount: 1, updatedAt: NOW + 1 }))
  assert.equal(panel.find({ type: 'Collapsible', label: /^Reviewed by you/ }), null)
  assert.equal(panel.find({ type: 'List', label: 'Reviewed by you' }), null)
})

test('a long title and a long name are cut to the label limit', async () => {
  const title = '界'.repeat(400)
  await open(snapshotOf({ toReview: [prOf(80, { title, projectName: 'P'.repeat(2_000), createdBy: { id: 'u-grace', name: 'G'.repeat(2_000) } })], toReviewCount: 1 }))
  await showToReview()
  const [item] = panel.findAll({ type: 'ListItem' })
  assert.ok(item.label && item.label.endsWith('…') && new TextEncoder().encode(item.label).length <= 1024)
  assert.ok(String(item.props.description).endsWith('…') && new TextEncoder().encode(String(item.props.description)).length <= 1024)
  const [list] = panel.findAll({ type: 'List' })
  assert.ok(list.label?.startsWith('To review in PPP') && list.label.endsWith('…') && new TextEncoder().encode(list.label).length <= 1024)
})

test("each To review group's list is named after its project and repository, and Reviewed by you keeps its name", async () => {
  await open(
    snapshotOf({
      toReview: [
        prIn(80, WEB, WEB_API, { title: 'Api review' }),
        prIn(81, WEB, WEB_APP, { title: 'Web review' }),
        prIn(82, TOOLS, TOOLS_APP, { title: 'Tools review' }),
        prIn(83, TOOLS, TOOLS_APP, { title: 'Tools follow-up' })
      ],
      toReviewCount: 4,
      reviewed: [prIn(90, WEB, WEB_APP, { title: 'Voted', reviewers: [myVote(10)] })]
    })
  )
  await showToReview()
  assert.deepEqual(
    panel.findAll({ type: 'List' }).map(list => [list.label, inside(list, { type: 'ListItem' }).map(item => item.label)]),
    [
      ['To review in Contoso Tools · web-app', ['Tools review', 'Tools follow-up']],
      ['To review in Fabrikam Web · fabrikam-api', ['Api review']],
      ['To review in Fabrikam Web · web-app', ['Web review']],
      ['Reviewed by you', ['Voted']]
    ]
  )
})

test('To review shows at most 50 pull requests and says how many there are', async () => {
  const toReview = Array.from({ length: 60 }, (_, index) => prOf(100 + index, { title: `Review ${index}` }))
  await open(snapshotOf({ toReview, toReviewCount: 75 }))
  assert.equal(reviewButton()?.text, 'To review · 75')
  await showToReview()
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 50)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 50 of 75 pull requests.' })?.props.muted, true)
})

test('To review with nothing waiting shows its empty state', async () => {
  await open(snapshotOf({ sets: [setOf([prOf(55)])] }))
  assert.equal(reviewButton()?.text, 'To review')
  await showToReview()
  const empty = panel.find({ type: 'EmptyState' })
  assert.deepEqual(
    [empty?.label, empty?.props.description],
    ['Nothing to review', 'Pull requests that name you as a reviewer show up here until you vote.']
  )
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  assert.deepEqual(cards(), [])
})

test('no sets shows the empty state', async () => {
  await open(snapshotOf())
  const empty = panel.find({ type: 'EmptyState' })
  assert.equal(empty?.label, 'No open pull requests of yours')
  assert.equal(empty?.props.description, "Pull requests you create in this organization's code projects show up here.")
  assert.deepEqual(cards(), [])
  assert.equal(panel.find({ type: 'Text', text: /^Auto-complete uses/ }), null)
})

test('a chosen project with nothing in the shown view says Nothing here and points to All projects', async () => {
  await open(snapshotOf({ sets: [setOf([prIn(55, WEB, WEB_APP)])], toReview: [prIn(80, TOOLS, TOOLS_APP, { title: 'Tools review' })], toReviewCount: 1 }))
  const empty = () => [panel.find({ type: 'EmptyState' })?.label, panel.find({ type: 'EmptyState' })?.props.description]
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.deepEqual(empty(), ['Nothing here for Contoso Tools', CHOOSE_ALL])
  assert.deepEqual(cards(), [])

  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  await showToReview()
  assert.equal(reviewButton()?.text, 'To review · 0 of 1')
  assert.deepEqual(empty(), ['Nothing here for Fabrikam Web', CHOOSE_ALL])

  await panel.select({ type: 'Select', label: 'Project' }, '*')
  assert.deepEqual(outline(), ['Contoso Tools · web-app · 1 pull request', '  - Tools review'])
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

test('cut lists keep their notes: Showing n of N sets. and Showing n of N pull requests.', async () => {
  const sets = [
    ...Array.from({ length: 40 }, (_, index) => setOf([prIn(200 + index, WEB, WEB_APP)], { title: `Web ${index}` })),
    ...Array.from({ length: 5 }, (_, index) => setOf([prIn(300 + index, TOOLS, TOOLS_APP)], { title: `Tools ${index}` }))
  ]
  const toReview = [
    ...Array.from({ length: 55 }, (_, index) => prIn(400 + index, WEB, WEB_APP, { title: `Web review ${index}` })),
    ...Array.from({ length: 5 }, (_, index) => prIn(500 + index, TOOLS, TOOLS_APP, { title: `Tools review ${index}` }))
  ]
  await open(snapshotOf({ sets, toReview, toReviewCount: 75 }))
  const note = () => panel.find({ type: 'Text', text: /^Showing/ })
  const underTheGroups = () => {
    const found = note()
    assert.ok(found)
    assert.ok(panel.findAll({ type: 'Collapsible' }).every(group => !found.path.startsWith(`${group.path}/`)), 'the note sits under the groups')
    return [found.text, found.props.muted]
  }
  assert.deepEqual(underTheGroups(), ['Showing 30 of 45 sets.', true])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  assert.deepEqual(underTheGroups(), ['Showing 30 of 40 sets.', true])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.equal(note(), null)

  await panel.select({ type: 'Select', label: 'Project' }, '*')
  await showToReview()
  assert.deepEqual(underTheGroups(), ['Showing 50 of 75 pull requests.', true])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  assert.equal(reviewButton()?.text, 'To review · 55 of 75')
  assert.deepEqual(underTheGroups(), ['Showing 50 of 55 pull requests.', true])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.equal(note(), null)
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
  const sets = Array.from({ length: 30 }, (_, index) => setOf(Array.from({ length: 12 }, (_, row) => prOf(1000 + index * 100 + row, maxChips)), { key: `contoso:${index}` }))
  const toReview = Array.from({ length: 100 }, (_, index) => prOf(9000 + index))
  await open(snapshotOf({ sets, toReview, toReviewCount: 100 }))
  assert.deepEqual(panel.errors, [])
  assert.equal(titles().length, 12)
  assert.equal(panel.findAll({ type: 'Link' }).length, 144)
  assert.equal(panel.find({ type: 'Text', text: /^Showing 12/ })?.text, 'Showing 12 of 30 sets.')
  await showToReview()
  assert.deepEqual(panel.errors, [])
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 50)
})

test('one set of 300 PRs shows 150 rows, says so, and still acts on every active PR', async () => {
  const prs = Array.from({ length: 300 }, (_, index) => prOf(300 + index, index === 0 ? { ...maxChips, isDraft: false } : maxChips))
  const host = await open(snapshotOf({ sets: [setOf(prs), setOf([prOf(900)])] }), {
    'prs.approve': { results: prs.map(pr => ({ prId: pr.prId, ok: true, message: 'Approved.' })) }
  })
  assert.deepEqual(panel.errors, [])
  assert.equal(titles().length, 1)
  assert.equal(panel.findAll({ type: 'Link' }).length, 150)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 150 of 300 pull requests in this set.' })?.props.muted, true)
  assert.equal(panel.find({ type: 'Text', text: 'Showing 1 of 2 sets.' })?.props.muted, true)
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.deepEqual(panel.errors, [])
  assert.equal((inputsTo(host, 'prs.approve')[0] as { prs: unknown[] }).prs.length, 300)
  assert.equal(resultLines().length, 300)
})

test('a set that fits shows no pull request note', async () => {
  await open(snapshotOf({ sets: [setOf(Array.from({ length: 150 }, (_, index) => prOf(300 + index)))] }))
  assert.equal(panel.findAll({ type: 'Link' }).length, 150)
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
})

function assertInReviewHeader(callout: { path: string } | null): void {
  const link = panel.find({ type: 'Link', text: 'Open in Azure DevOps' })
  assert.ok(callout && link, 'the notice and the header link are drawn')
  const slash = link.path.lastIndexOf('/')
  const next = Number(link.path.slice(slash + 2)) + 1
  assert.equal(callout.path, `${link.path.slice(0, slash)}/#${next}`, 'the notice is the first thing after the header link')
}

async function pressReview(answer: unknown) {
  const row = prOf(80, { title: 'Cache the lookups' })
  const host = await open(snapshotOf({ toReview: [row], toReviewCount: 1 }), {
    'reviews.open': input => reviewOf({ key: input, pr: row })
  })
  host.respond('shell.openExternal', answer)
  await showToReview()
  await panel.press({ type: 'ListItem', label: 'Cache the lookups' })
  await panel.press({ type: 'Link', text: 'Open in Azure DevOps' })
  return host
}

test('a link Orca refuses to open shows the error message and the next press clears it', async () => {
  const host = await pressReview(() => {
    throw hostError('action_failed', 'Orca could not open the link.')
  })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Orca could not open the link.')
  assertInReviewHeader(panel.find({ type: 'Callout' }))
  host.respond('shell.openExternal', { opened: true })
  await panel.press({ type: 'Link', text: 'Open in Azure DevOps' })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(host.callsOf('shell.openExternal').length, 2)
  assert.deepEqual(host.callsOf('shell.openExternal')[0], { url: prOf(80).url })
})

test('a link Orca could not ask about shows a fixed message', async () => {
  await pressReview({ opened: false, reason: 'consent-unavailable' })
  assert.equal(panel.find({ type: 'Callout' })?.props.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, OPEN_UNAVAILABLE)
  assertInReviewHeader(panel.find({ type: 'Callout' }))
})

test('a link the person declined to open stays silent', async () => {
  const host = await pressReview({ opened: false, reason: 'cancelled' })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(host.callsOf('shell.openExternal').length, 1)
})

test('To review stays chosen when the tab is left and shown again', async () => {
  await open(snapshotOf({ toReview: [prOf(80, { title: 'Cache the lookups' })], toReviewCount: 1 }))
  await showToReview()
  assert.ok(panel.find({ type: 'ListItem' }))
  await panel.select({ type: 'Tabs' }, 'work')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.ok(panel.find({ type: 'ListItem' }))
  assert.deepEqual(views(), ['ghost', 'outline'])
})

test('a second press before the buttons redraw sends nothing', async () => {
  let release: (value: { results: RowResult[] }) => void = () => {}
  const held = new Promise<{ results: RowResult[] }>(resolve => {
    release = resolve
  })
  const host = await open(snapshotOf({ sets: [setOf([prOf(55)])] }), { 'prs.approve': () => held, 'prs.autoComplete': () => held })
  const approve = panel.find({ type: 'Button', text: 'Approve' })
  const complete = panel.find({ type: 'Button', text: 'Auto-complete' })
  const presses = [panel.press(approve as NonNullable<typeof approve>), panel.press(approve as NonNullable<typeof approve>), panel.press(complete as NonNullable<typeof complete>)]
  await pause(10)
  release({ results: [{ prId: 55, ok: true, message: 'Approved.' }] })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'prs.approve').length, 1)
  assert.equal(requestsTo(host, 'prs.autoComplete').length, 0)
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

test("switching organization loads that org and drops the other one's results", async () => {
  const host = await open(
    input =>
      snapshotOf({
        org: input.org,
        sets: [setOf([prOf(input.org === 'contoso' ? 55 : 90, { title: `${input.org} change` })])],
        toReview: [prOf(input.org === 'contoso' ? 80 : 95)],
        toReviewCount: 1
      }),
    { 'prs.approve': { results: [{ prId: 55, ok: true, message: 'Approved.' }] } },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  await panel.press({ type: 'Button', text: 'Approve' })
  assert.equal(resultLines().length, 1)
  await showToReview()
  assert.deepEqual(views(), ['ghost', 'outline'])
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.deepEqual(titles(), ['fabrikam change'])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(inputsTo(host, 'prs.snapshot'), [{ org: 'contoso' }, { org: 'fabrikam' }])
  await panel.select({ label: 'Organization' }, 'contoso')
  assert.deepEqual(views(), ['ghost', 'outline'])
  await panel.press({ type: 'Button', text: 'Mine' })
  assert.deepEqual(titles(), ['contoso change'])
  assert.equal(resultLines().length, 0)
})

test('release sets group by project, flat with the repository named for a one-repo project', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf([prIn(55, WEB, WEB_APP)], { title: 'Fix the sign-in redirect' }),
        setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Add CSV export' }),
        setOf([prIn(61, WEB, WEB_APP), prIn(62, WEB, WEB_APP)], { title: 'Cache the lookups', sources: ['feature/cache', 'feature/cache-keys'] })
      ]
    })
  )
  assert.deepEqual(outline(), [
    'Contoso Tools · web-app · 1 set',
    '  Add CSV export',
    'Fabrikam Web · web-app · 2 sets',
    '  Fix the sign-in redirect',
    '  Cache the lookups'
  ])
  assert.deepEqual(
    cards().map(card => branchOf(card)[0]),
    ['feature/login', 'feature/login', 'feature/cache*']
  )
  assert.equal(rowText(55), '!55 → develop')
  assert.equal(rowText(60), '!60 → develop')
})

test('a project with sets from several repositories gets one group per repository and an Across repos group first, whose rows carry a repository chip', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf([prIn(55, WEB, WEB_APP)], { title: 'App only' }),
        setOf([prIn(56, WEB, WEB_API)], { title: 'Api only' }),
        setOf([prIn(57, WEB, WEB_APP, { checks: { build: 'succeeded', policies: 'none' } }), prIn(58, WEB, WEB_API)], { title: 'Both repos' }),
        setOf([prIn(59, WEB, WEB_APP)], { title: 'App again' })
      ]
    })
  )
  assert.deepEqual(outline(), [
    'Fabrikam Web · 2 repos · 4 sets',
    '  Across repos · 1 set',
    '    Both repos',
    '  fabrikam-api · 1 set',
    '    Api only',
    '  web-app · 2 sets',
    '    App only',
    '    App again'
  ])
  assert.deepEqual(badgesIn('Both repos'), [
    ['web-app', 'neutral'],
    ['✓ build', 'success'],
    ['fabrikam-api', 'neutral']
  ])
  assert.equal(rowText(57), '!57 → develop web-app ✓ build')
  assert.equal(rowText(58), '!58 → develop fabrikam-api')
  assert.deepEqual(badgesIn('App only'), [])
  assert.deepEqual(badgesIn('Api only'), [])
})

test('a set spanning projects shows once, in Across projects at the top, with project / repo chips, and under a project filter when any of its pull requests is there', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf([prIn(70, WEB, WEB_APP), prIn(71, TOOLS, TOOLS_APP, { checks: { build: 'failed', policies: 'none' } })], { title: 'Rename the tenant setting' }),
        setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }),
        setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Tools set' }),
        setOf([prIn(80, BOARDS, BOARDS_APP)], { title: 'Boards set' })
      ]
    })
  )
  assert.deepEqual(outline(), [
    'Across projects · 1 set [1 needs you]',
    '  Rename the tenant setting',
    'Contoso Tools · web-app · 1 set',
    '  Tools set',
    'Fabrikam Boards · boards-app · 1 set',
    '  Boards set',
    'Fabrikam Web · web-app · 1 set',
    '  Web set'
  ])
  assert.equal(titles().filter(title => title === 'Rename the tenant setting').length, 1)
  assert.equal(rowText(70), '!70 → develop Fabrikam Web / web-app')
  assert.equal(rowText(71), '!71 → develop Contoso Tools / web-app ✗ build')
  assert.deepEqual(badgesIn('Rename the tenant setting')[0], ['Fabrikam Web / web-app', 'neutral'])

  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.deepEqual(outline(), ['Across projects · 1 set [1 needs you]', '  Rename the tenant setting', 'Contoso Tools · web-app · 1 set', '  Tools set'])
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-boards')
  assert.deepEqual(outline(), ['Fabrikam Boards · boards-app · 1 set', '  Boards set'])
})

test('merged rows after the first two fold behind + N merged · show', async () => {
  const merged = (prId: number) => prOf(prId, { status: 'completed', closedAt: NOW })
  const first = setOf([prOf(55), merged(56), merged(57), merged(58), prOf(59), merged(60)], { key: 'contoso:first', title: 'First' })
  const second = setOf([prOf(70), merged(71), merged(72), merged(73)], { key: 'contoso:second', title: 'Second' })
  await open(snapshotOf({ sets: [first, second] }))
  const folded = ['!55', '!56', '!57', '!59', '+ 2 merged · show']
  assert.deepEqual(linksIn('First'), folded)
  assert.deepEqual(linksIn('Second'), ['!70', '!71', '!72', '+ 1 merged · show'])

  assert.equal(panel.findAll({ type: 'Row', text: '+ 2 merged · show' }).length, 1, 'the fold link sits left in its own row')
  await panel.press({ type: 'Link', text: '+ 2 merged · show' })
  const unfolded = ['!55', '!56', '!57', '!58', '!59', '!60', 'Hide merged']
  assert.deepEqual(linksIn('First'), unfolded)
  assert.deepEqual(linksIn('Second'), ['!70', '!71', '!72', '+ 1 merged · show'])

  await panel.post('prs.changed', snapshotOf({ sets: [second, first], updatedAt: NOW + 1 }))
  assert.deepEqual(linksIn('First'), unfolded)
  assert.deepEqual(panel.persisted.plugin, {})

  await panel.press({ type: 'Link', text: 'Hide merged' })
  assert.deepEqual(linksIn('First'), folded)
})

test('Share… comes first, and Approve and Auto-complete show only when some pull request needs them', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf([prOf(55)], { title: 'Both' }),
        setOf([prOf(60, { reviewers: [myVote(10)], autoComplete: true })], { title: 'Neither' }),
        setOf([prOf(65, { isDraft: true }), prOf(66, { status: 'completed', closedAt: NOW })], { title: 'Draft and merged' }),
        setOf([prOf(70, { autoComplete: true })], { title: 'Approve only' }),
        setOf([prOf(75, { reviewers: [myVote(10)] })], { title: 'Auto-complete only' })
      ]
    })
  )
  const share = ['Share…', 'solid', 'accent', 'xs']
  const approve = ['Approve', 'outline', undefined, 'xs']
  const autoComplete = ['Auto-complete', 'outline', undefined, 'xs']
  assert.deepEqual(buttonsIn('Both'), [share, approve, autoComplete])
  assert.deepEqual(buttonsIn('Neither'), [share])
  assert.deepEqual(buttonsIn('Draft and merged'), [share])
  assert.deepEqual(buttonsIn('Approve only'), [share, approve])
  assert.deepEqual(buttonsIn('Auto-complete only'), [share, autoComplete])
  const actions = inside(cardOf('Both'), { type: 'Row' }).find(row => row.text === 'Share… Approve Auto-complete')
  assert.deepEqual([actions?.props.gap, actions?.props.wrap], ['xs', true])
})

test('Mine and To review switch the list; To review groups its rows by project and keeps Reviewed by you', async () => {
  const toReview = [
    ...[1, 2, 3].map(n => prIn(100 + n, TOOLS, TOOLS_APP, { title: `Tools review ${n}` })),
    ...[1, 2, 3, 4, 5].map(n => prIn(110 + n, WEB, WEB_APP, { title: `Web review ${n}` })),
    ...[1, 2, 3, 4].map(n => prIn(120 + n, WEB, WEB_API, { title: `Api review ${n}` }))
  ]
  const reviewed = [
    prIn(130, WEB, WEB_API, { title: 'Voted on the API', reviewers: [myVote(10)] }),
    prIn(131, TOOLS, TOOLS_APP, { title: 'Voted on the tools', reviewers: [myVote(-5)] })
  ]
  const sets = [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }), setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Tools set' })]
  await open(snapshotOf({ sets, toReview, toReviewCount: 12, reviewed }))
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.equal(reviewButton()?.text, 'To review · 12')
  assert.deepEqual(titles(), ['Tools set', 'Web set'])
  assert.equal(panel.find({ type: 'ListItem' }), null)

  await showToReview()
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.deepEqual(cards(), [])
  assert.deepEqual(outline(), [
    'Contoso Tools · web-app · 3 pull requests',
    '  - Tools review 1',
    '  - Tools review 2',
    '  - Tools review 3',
    'Fabrikam Web · 2 repos · 9 pull requests',
    '  fabrikam-api · 4 pull requests',
    '    - Api review 1',
    '    - Api review 2',
    '    - Api review 3',
    '    - Api review 4',
    '  web-app · 5 pull requests',
    '    - Web review 1',
    '    - Web review 2',
    '    - Web review 3',
    '    - Web review 4',
    '    - Web review 5',
    'Reviewed by you · 2 pull requests',
    '  - Voted on the API',
    '  - Voted on the tools'
  ])
  assert.deepEqual(panel.persisted.plugin.prsPrefs, { contoso: { view: 'review' } })

  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')
  assert.equal(reviewButton()?.text, 'To review · 3 of 12')
  assert.deepEqual(outline(), [
    'Contoso Tools · web-app · 3 pull requests',
    '  - Tools review 1',
    '  - Tools review 2',
    '  - Tools review 3',
    'Reviewed by you · 1 pull request',
    '  - Voted on the tools'
  ])

  await panel.press({ type: 'Button', text: 'Mine' })
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.deepEqual(outline(), ['Contoso Tools · web-app · 1 set', '  Tools set'])
  assert.deepEqual(panel.persisted.plugin.prsPrefs, { contoso: { view: 'mine', project: 'proj-tools', repo: null } })
})

test('the pickers come from sets, To review and Reviewed by you whatever the view, and the repository picker filters the shown view', async () => {
  await open(
    snapshotOf({
      sets: [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' })],
      toReview: [prIn(80, WEB, WEB_API, { title: 'Api review' }), prIn(81, WEB, WEB_APP, { title: 'Web review' })],
      toReviewCount: 2,
      reviewed: [prIn(90, BOARDS, BOARDS_APP, { title: 'Boards vote', reviewers: [myVote(10)] })]
    })
  )
  const options = (select: TestElement | null) => ((select?.props.options as { value: string; label: string }[] | undefined) ?? []).map(option => [option.value, option.label])
  const projects = [
    ['*', 'All projects'],
    ['proj-boards', 'Fabrikam Boards'],
    ['proj-web', 'Fabrikam Web']
  ]
  assert.deepEqual(options(projectSelect()), projects)
  assert.equal(repoSelect(), null)
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  assert.deepEqual(options(repoSelect()), [
    ['*', 'All repos'],
    ['repo-api', 'fabrikam-api'],
    ['repo-web', 'web-app']
  ])
  await panel.select({ type: 'Select', label: 'Repository' }, 'repo-api')
  assert.deepEqual(panel.find({ type: 'EmptyState' })?.label, 'Nothing here for Fabrikam Web')
  await showToReview()
  assert.deepEqual(options(projectSelect()), projects)
  assert.deepEqual(outline(), ['Fabrikam Web · fabrikam-api · 1 pull request', '  - Api review'])
  await panel.select({ type: 'Select', label: 'Repository' }, 'repo-web')
  assert.deepEqual(outline(), ['Fabrikam Web · web-app · 1 pull request', '  - Web review'])
})

test('the chosen view, project and repository survive a reload, per organisation', async () => {
  const orgs = [org('contoso'), org('fabrikam')]
  const data = everywhere({
    sets: [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }), setOf([prIn(56, WEB, WEB_API)], { title: 'Api set' }), setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Tools set' })],
    toReview: [prIn(80, WEB, WEB_API, { title: 'Api review' }), prIn(81, WEB, WEB_APP, { title: 'Web review' }), prIn(82, TOOLS, TOOLS_APP, { title: 'Tools review' })],
    toReviewCount: 3
  })
  await open(data, {}, { orgs })
  await showToReview()
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-web')
  await panel.select({ type: 'Select', label: 'Repository' }, 'repo-api')
  const apiOnly = ['Fabrikam Web · fabrikam-api · 1 pull request', '  - Api review']
  assert.deepEqual(outline(), apiOnly)

  const reloaded = await reloadPanel(panel, orgs, { 'prs.snapshot': data })
  panel = reloaded.panel
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-web', 'repo-api'])
  assert.deepEqual(outline(), apiOnly)

  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.deepEqual(views(), ['outline', 'ghost'])
  assert.deepEqual([projectSelect()?.props.value, repoSelect()], ['*', null])
  assert.equal(titles().length, 3)
  await panel.select({ type: 'Select', label: 'Project' }, 'proj-tools')

  await panel.select({ label: 'Organization' }, 'contoso')
  assert.deepEqual(views(), ['ghost', 'outline'])
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-web', 'repo-api'])
  assert.deepEqual(panel.persisted.plugin.prsPrefs, {
    contoso: { view: 'review', project: 'proj-web', repo: 'repo-api' },
    fabrikam: { project: 'proj-tools', repo: null }
  })
})

test('a remembered project with nothing in it now shows All projects', async () => {
  const remembered = { contoso: { project: 'proj-gone', repo: 'repo-gone', view: 'mine' } }
  await open(snapshotOf({ sets: [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }), setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Tools set' })] }), {}, { prefs: remembered })
  assert.equal(projectSelect()?.props.value, '*')
  assert.equal(repoSelect(), null)
  assert.deepEqual(outline(), ['Contoso Tools · web-app · 1 set', '  Tools set', 'Fabrikam Web · web-app · 1 set', '  Web set'])
  assert.equal(panel.find({ type: 'EmptyState' }), null)
  assert.deepEqual(panel.persisted.plugin.prsPrefs, remembered)

  const archive = { projectId: 'proj-gone', projectName: 'Contoso Archive' }
  await panel.post(
    'prs.changed',
    snapshotOf({
      sets: [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }), setOf([prIn(61, archive, { repoId: 'repo-gone', repoName: 'legacy-app' })], { title: 'Archive set' })],
      toReview: [prIn(62, archive, { repoId: 'repo-other', repoName: 'legacy-api' })],
      toReviewCount: 1,
      updatedAt: NOW + 1
    })
  )
  assert.deepEqual([projectSelect()?.props.value, repoSelect()?.props.value], ['proj-gone', 'repo-gone'])
  assert.deepEqual(outline(), ['Contoso Archive · legacy-app · 1 set', '  Archive set'])
})

test('a project header says how many sets need you', async () => {
  await open(
    snapshotOf({
      sets: [
        setOf([prIn(1, WEB, WEB_APP, { mergeStatus: 'conflicts' })]),
        setOf([prIn(2, WEB, WEB_APP, { checks: { build: 'failed', policies: 'none' } })]),
        setOf([prIn(3, WEB, WEB_APP, { checks: { build: 'none', policies: 'rejected' } })]),
        setOf([prIn(4, WEB, WEB_APP, { reviewers: [reviewerOf('Grace Hopper', -10)] })]),
        setOf([prIn(5, WEB, WEB_APP, { reviewers: [reviewerOf('Grace Hopper', -5)] })]),
        setOf([prIn(6, WEB, WEB_APP, { isDraft: true, checks: { build: 'running', policies: 'pending' } })]),
        setOf([prIn(7, WEB, WEB_APP, { status: 'completed', closedAt: NOW, mergeStatus: 'conflicts' }), prIn(8, WEB, WEB_APP)]),
        setOf([prIn(9, WEB, WEB_API, { mergeStatus: 'conflicts' })]),
        setOf([prIn(10, TOOLS, TOOLS_APP, { checks: { build: 'failed', policies: 'none' } })]),
        setOf([prIn(20, BOARDS, BOARDS_APP)])
      ]
    })
  )
  assert.deepEqual(headers(), [
    ['Contoso Tools · web-app · 1 set', '1 needs you'],
    ['Fabrikam Boards · boards-app · 1 set', undefined],
    ['Fabrikam Web · 2 repos · 8 sets', '6 need you'],
    ['fabrikam-api · 1 set', '1 needs you'],
    ['web-app · 7 sets', '5 need you']
  ])
})

test('Collapse all and Expand all close and open every group in both views', async () => {
  await open(
    snapshotOf({
      sets: [setOf([prIn(55, WEB, WEB_APP)], { title: 'Web set' }), setOf([prIn(56, WEB, WEB_API)], { title: 'Api set' }), setOf([prIn(60, TOOLS, TOOLS_APP)], { title: 'Tools set' })],
      toReview: [prIn(80, WEB, WEB_APP), prIn(82, TOOLS, TOOLS_APP)],
      toReviewCount: 2,
      reviewed: [prIn(90, WEB, WEB_APP, { reviewers: [myVote(10)] })]
    })
  )
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app · 1 set', true],
    ['Fabrikam Web · 2 repos · 2 sets', true],
    ['fabrikam-api · 1 set', true],
    ['web-app · 1 set', true]
  ])
  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app · 1 set', false],
    ['Fabrikam Web · 2 repos · 2 sets', false]
  ])
  assert.deepEqual(cards(), [])
  await panel.toggle({ type: 'Collapsible', label: 'Fabrikam Web · 2 repos · 2 sets' })
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app · 1 set', false],
    ['Fabrikam Web · 2 repos · 2 sets', true],
    ['fabrikam-api · 1 set', false],
    ['web-app · 1 set', false]
  ])

  await showToReview()
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app · 1 pull request', false],
    ['Fabrikam Web · web-app · 1 pull request', false],
    ['Reviewed by you · 1 pull request', false]
  ])
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(groupStates(), [
    ['Contoso Tools · web-app · 1 pull request', true],
    ['Fabrikam Web · web-app · 1 pull request', true],
    ['Reviewed by you · 1 pull request', true]
  ])
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 3)
  await panel.press({ type: 'Button', text: 'Mine' })
  assert.equal(cards().length, 3)
})

test("fifty pull requests in sets across projects, with To review full, stay within Orca's limits in both views", async () => {
  const snapshot = largeSets()
  assert.equal(snapshot.sets.length, 20)
  assert.equal(snapshot.sets.flatMap(set => set.prs).length, 50)
  assert.equal(new Set(snapshot.sets.flatMap(set => set.prs.map(pr => pr.projectId))).size, 4)
  assert.deepEqual([snapshot.toReview.length, snapshot.reviewed.length], [50, 50])
  await open(snapshot)
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  for (let link = panel.find({ type: 'Link', text: /^\+ \d+ merged · show$/ }); link; link = panel.find({ type: 'Link', text: /^\+ \d+ merged · show$/ })) {
    await panel.press(link)
  }
  assert.deepEqual(panel.errors, [])
  assert.equal(titles().length, 20)
  assert.equal(panel.findAll({ type: 'Link', text: /^!\d+$/ }).length, 50)
  const top = outline().filter(line => !line.startsWith('  ') && line.includes('['))
  assert.equal(top[0], 'Across projects · 1 set [1 needs you]')
  assert.ok(outline().some(line => line.startsWith('  Across repos · ')))
  assert.ok(groupStates().every(([, open]) => open === true))
  withinLimits()

  await showToReview()
  assert.equal(panel.findAll({ type: 'ListItem' }).length, 100)
  assert.ok(groupStates().every(([, open]) => open === true))
  withinLimits()
})
