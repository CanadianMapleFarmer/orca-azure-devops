import { afterEach, assert, hostError, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { ReleaseSet } from '../../shared/prs'
import type { Approver } from '../../shared/pipelines'
import { APPROVAL_TEMPLATE } from '../../shared/share/approval-items'
import { mailtoUrl } from '../../shared/share/email'
import { MAX_INTRO } from '../../shared/share/limits'
import { teamsChatUrl } from '../../shared/share/teams'
import { PR_TEMPLATE } from '../../shared/share/template'
import type { Channel, SharePrefsView, ShareRequest, ShareResult } from '../../shared/share/types'
import type { Identity, OrgStatus } from '../../shared/types'
import { approvalOf, runsSnapshotOf, waitingRun } from '../pipelines/fixtures'
import { NOW, prOf, reviewerOf, setOf, snapshotOf } from '../prs/fixtures'
import { closeCleanly, mountPanel, org, requestsTo, type TestHost } from '../test-support'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

const HINT = "Orca asks before opening Teams. Tick 'Always allow' to skip this next time."
const OPEN_UNAVAILABLE = "Orca couldn't ask to open the link. Bring its window to the front and try again."
const NOT_OPENED = "Teams chat wasn't opened."

const GRACE: Identity = { id: 'id-Grace Hopper', displayName: 'Grace Hopper', uniqueName: 'grace.hopper@contoso.com', kind: 'user' }
const LINUS: Identity = { id: 'id-linus', displayName: 'Linus Torvalds', uniqueName: 'linus@contoso.com', kind: 'user' }
const APPROVERS: Identity = { id: 'id-approvers', displayName: 'Release Approvers', uniqueName: '[Fabrikam Web]\\Release Approvers', kind: 'group' }
const RELEASES: Channel = { id: 'c-releases', name: 'Releases', service: 'teams', addedAt: 1 }
const QA: Channel = { id: 'c-qa', name: 'QA', service: 'teams', addedAt: 2 }
const COPIED: ShareResult = { destination: 'copy', ok: true, text: 'Copied as rich text.' }

const urlOf = (prId: number) => `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/${prId}`
const keyOf = (prId: number) => `pr:proj-web/repo-web/${prId}`
const lineOf = (prId: number) => `[Pull Request ${prId}](${urlOf(prId)}): Change ${prId}`
const plainOf = (prId: number) => `Pull Request ${prId}: Change ${prId} ${urlOf(prId)}`

const prefsOf = (over: Partial<SharePrefsView> = {}): SharePrefsView => ({
  template: PR_TEMPLATE,
  channels: [],
  prefs: { destinations: [{ kind: 'copy' }] },
  tenantId: null,
  ...over
})

const defaultSet = (): ReleaseSet =>
  setOf([
    prOf(55, { target: 'develop', reviewers: [reviewerOf('Grace Hopper', 0), reviewerOf('Release Approvers', 0, { isGroup: true })] }),
    prOf(56, { target: 'qa', reviewers: [reviewerOf('Grace Hopper', 10)] }),
    prOf(57, { target: 'main', status: 'completed', closedAt: NOW })
  ])

async function share(more: MockRequests = {}, options: { sets?: ReleaseSet[]; orgs?: OrgStatus[] } = {}): Promise<TestHost> {
  const sets = options.sets ?? [defaultSet()]
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    { 'prs.snapshot': input => snapshotOf({ org: input.org, sets }), ...more },
    { persisted: { workspace: { tab: 'prs' } } }
  )
  panel = mounted.panel
  await panel.press({ type: 'Button', text: 'Share…' })
  return mounted.host
}

const preview = () => panel.find({ type: 'Markdown' })?.props.content

const isChecked = (label: string) => panel.find({ type: 'Checkbox', label })?.props.checked

const itemBoxes = () =>
  panel
    .findAll({ type: 'Checkbox', label: /^Pull Request / })
    .map(box => [box.label, box.props.checked])

const sends = (host: TestHost) => requestsTo(host, 'share.send').map(call => call.input as ShareRequest)

const shareButton = () => panel.find({ type: 'Button', text: 'Share' })

const sharingButton = () => panel.find({ type: 'Button', text: 'Sharing…' })

const results = () =>
  panel.findAll({ type: 'Callout' }).map(callout => {
    const title = callout.props.title as string | undefined
    return [title, callout.props.tone, title ? callout.text.slice(title.length).trim() : callout.text]
  })

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const opens = (host: TestHost) => host.callsOf('shell.openExternal') as { url: string }[]

async function chooseChat(person = 'Grace Hopper'): Promise<void> {
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.press({ type: 'ListItem', label: person })
}

test("Share opens the composer with the set's active PRs checked and the reference preview", async () => {
  const host = await share()
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
  assert.equal(panel.find({ type: 'Card' }), null)
  assert.deepEqual(requestsTo(host, 'share.prefs').map(call => call.input), [{ org: 'contoso', kind: 'pr' }])
  assert.deepEqual(itemBoxes(), [
    ['Pull Request 55 → develop', true],
    ['Pull Request 56 → qa', true],
    ['Pull Request 57 → main', false]
  ])
  assert.equal(preview(), `${lineOf(55)}\n\n${lineOf(56)}`)
  assert.equal(panel.find({ type: 'Textarea' })?.label, 'Intro (optional)')
  assert.equal(panel.find({ type: 'Textarea' })?.props.maxLength, MAX_INTRO)
  assert.equal(isChecked('Copy as rich text'), true)
  assert.equal(isChecked('Message in Teams'), false)
  assert.equal(isChecked('Add as reviewers'), false)
  assert.ok(panel.find({ type: 'Button', text: 'Manage channels' }))
  assert.equal(shareButton()?.disabled, false)
  assert.equal(panel.find({ type: 'Button', text: 'Back' })?.props.variant, 'ghost')
})

test('suggestions leave out the person sharing, whatever the case of their id', async () => {
  const mine = reviewerOf('Ada Lovelace', 10, { id: 'U-CONTOSO' })
  await share({}, { sets: [setOf([prOf(55, { reviewers: [mine, reviewerOf('Grace Hopper', 0)] }), prOf(56, { reviewers: [mine] })])] })
  const offered = () => panel.findAll({ type: 'ListItem' }).map(item => item.label)
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  assert.deepEqual(offered(), ['Grace Hopper'])
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  assert.deepEqual(offered(), ['Grace Hopper'])
})

test('unchecking a PR removes it from the preview and from share.send keys', async () => {
  const host = await share({ 'share.send': { results: [COPIED] } })
  await panel.toggle({ type: 'Checkbox', label: 'Pull Request 56 → qa' })
  assert.equal(preview(), lineOf(55))
  await panel.type({ label: 'Intro (optional)' }, 'Ready for QA')
  assert.equal(preview(), `Ready for QA\n\n${lineOf(55)}`)
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(sends(host), [{ org: 'contoso', kind: 'pr', keys: [keyOf(55)], intro: 'Ready for QA', destinations: [{ kind: 'copy' }] }])
  assert.equal(requestsTo(host, 'share.send')[0]?.timeoutMs, 90000)
  assert.deepEqual(results(), [['Copy as rich text', 'success', 'Copied as rich text.']])
})

test('with chat chosen, the Teams link opens before share.send', async () => {
  const host = await share({ 'share.prefs': prefsOf({ tenantId: 'tenant-1' }), 'share.send': { results: [COPIED] } })
  await chooseChat()
  assert.equal(panel.find({ type: 'Text', text: HINT })?.props.muted, true)
  await panel.press({ type: 'Button', text: 'Share' })
  const url = teamsChatUrl({ users: ['grace.hopper@contoso.com'], text: `${plainOf(55)}\n${plainOf(56)}`, tenantId: 'tenant-1' })
  assert.deepEqual(opens(host), [{ url }])
  assert.match(opens(host)[0].url, /&tenantId=tenant-1$/)
  const order = host.calls
    .map(call => (call.method === 'plugin.request' ? (call.params as { name: string }).name : call.method))
    .filter(name => name === 'shell.openExternal' || name === 'share.send')
  assert.deepEqual(order, ['shell.openExternal', 'share.send'])
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'copy' }, { kind: 'chat', people: [GRACE] }])
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Message in Teams', 'success', 'Opened a Teams chat.']
  ])
})

test("a chat link that's too long is refused without opening anything", async () => {
  const host = await share({ 'share.send': { results: [] } })
  await panel.toggle({ type: 'Checkbox', label: 'Copy as rich text' })
  await chooseChat()
  await panel.type({ label: 'Intro (optional)' }, 'x'.repeat(MAX_INTRO))
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(opens(host), [])
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'chat', people: [GRACE] }])
  assert.deepEqual(results(), [['Message in Teams', 'danger', 'Too long for a Teams chat link. Use Copy instead.']])
  assert.equal(panel.find({ type: 'Button', text: 'Open Teams chat' }), null)
})

test('Share sends copy, channels and reviewers and shows each result', async () => {
  const answer: ShareResult[] = [
    COPIED,
    { destination: 'channel:c-releases', ok: true, text: 'Sent to Releases (accepted).' },
    { destination: 'channel:c-qa', ok: false, text: "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL." },
    { destination: 'reviewers', ok: true, text: 'Added Release Approvers to 2 pull requests.' }
  ]
  const host = await share(
    { 'share.prefs': prefsOf({ channels: [RELEASES, QA] }), 'share.people': [APPROVERS], 'share.send': { results: answer } },
    { sets: [setOf([prOf(55), prOf(56)])] }
  )
  assert.equal(isChecked('Post to Releases'), false)
  assert.equal(isChecked('Post to QA'), false)
  await panel.toggle({ type: 'Checkbox', label: 'Post to Releases' })
  await panel.toggle({ type: 'Checkbox', label: 'Post to QA' })
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  await panel.type({ label: 'Find people or groups' }, 'release', { submit: true })
  await panel.press({ type: 'ListItem', label: 'Release Approvers' })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(sends(host), [
    {
      org: 'contoso',
      kind: 'pr',
      keys: [keyOf(55), keyOf(56)],
      intro: '',
      destinations: [
        { kind: 'copy' },
        { kind: 'channel', id: 'c-releases' },
        { kind: 'channel', id: 'c-qa' },
        { kind: 'reviewers', people: [{ ...APPROVERS, required: false }] }
      ]
    }
  ])
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Post to Releases', 'success', 'Sent to Releases (accepted).'],
    ['Post to QA', 'danger', "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL."],
    ['Add as reviewers', 'success', 'Added Release Approvers to 2 pull requests.']
  ])
  assert.equal(shareButton()?.disabled, false)
  assert.deepEqual(panel.persisted, { plugin: {}, workspace: { tab: 'prs' }, storage: {} })
})

test('a failed copy shows the plain text to copy by hand', async () => {
  const plain = `${plainOf(55)}\n${plainOf(56)}`
  await share({ 'share.send': { results: [{ destination: 'copy', ok: false, text: "Couldn't copy to the clipboard.", plain }] } })
  await panel.press({ type: 'Button', text: 'Share' })
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  const code = panel.find({ type: 'CodeView' })
  assert.equal(code?.props.label, 'Copy this text instead')
  assert.equal(code?.props.code, plain)
  assert.ok(callout && code?.path.startsWith(callout.path), 'the text sits in the copy result')
})

test('people search adds a person, Required toggles, Remove removes', async () => {
  const host = await share(
    {
      'share.people': input => (input.query === 'gra' ? [GRACE, APPROVERS] : [LINUS]),
      'share.send': { results: [] }
    },
    { sets: [setOf([prOf(55)])] }
  )
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  assert.equal(panel.find({ label: 'Find people or groups' })?.props.placeholder, 'Name or email')
  await panel.type({ label: 'Find people or groups' }, 'gra', { submit: true })
  assert.deepEqual(
    panel.findAll({ type: 'ListItem' }).map(item => item.label),
    ['Grace Hopper', 'Release Approvers']
  )
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Release Approvers'])
  assert.equal(panel.find({ type: 'Switch', label: 'Required' })?.props.checked, false)

  await panel.type({ label: 'Find people or groups' }, 'lin', { replace: true })
  await panel.press({ label: 'Search' })
  await panel.press({ type: 'ListItem', label: 'Linus Torvalds' })
  assert.equal(panel.findAll({ type: 'Switch', label: 'Required' }).length, 2)
  await panel.toggle(panel.findAll({ type: 'Switch', label: 'Required' })[0])
  await panel.press({ label: 'Remove Linus Torvalds' })
  assert.equal(panel.find({ label: 'Remove Linus Torvalds' }), null)
  assert.ok(panel.find({ label: 'Remove Grace Hopper' }))

  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.type({ label: 'Find people' }, 'gra', { submit: true })
  assert.deepEqual(
    requestsTo(host, 'share.people').map(call => call.input),
    [
      { org: 'contoso', query: 'gra', groups: true },
      { org: 'contoso', query: 'lin', groups: true },
      { org: 'contoso', query: 'gra', groups: false }
    ]
  )
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'copy' }, { kind: 'reviewers', people: [{ ...GRACE, required: true }] }])
})

test('the chat picker offers users only', async () => {
  await share({ 'share.people': [GRACE, APPROVERS] })
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Grace Hopper'])
  assert.equal(panel.find({ type: 'Switch' }), null)
})

test('remembered destinations and people are preselected', async () => {
  const host = await share({
    'share.prefs': prefsOf({
      channels: [RELEASES, QA],
      prefs: {
        destinations: [
          { kind: 'channel', id: 'c-qa' },
          { kind: 'chat', people: [LINUS] },
          { kind: 'reviewers', people: [{ ...APPROVERS, required: true }] }
        ]
      }
    }),
    'share.send': { results: [] }
  })
  assert.equal(isChecked('Copy as rich text'), false)
  assert.equal(isChecked('Post to Releases'), false)
  assert.equal(isChecked('Post to QA'), true)
  assert.equal(isChecked('Message in Teams'), true)
  assert.equal(isChecked('Add as reviewers'), true)
  assert.ok(panel.find({ label: 'Remove Linus Torvalds' }))
  assert.ok(panel.find({ label: 'Remove Release Approvers' }))
  assert.deepEqual(panel.findAll({ type: 'Switch' }).map(toggle => toggle.props.checked), [true])
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(sends(host)[0]?.destinations, [
    { kind: 'channel', id: 'c-qa' },
    { kind: 'chat', people: [LINUS] },
    { kind: 'reviewers', people: [{ ...APPROVERS, required: true }] }
  ])
})

test('a template warning shows above the preview', async () => {
  const warning = 'Unknown placeholder {nope} in the share template.'
  await share({ 'share.prefs': prefsOf({ template: '[#{id}]({url}) {nope}', warning }) })
  const callout = panel.find({ type: 'Callout', text: warning })
  const markdown = panel.find({ type: 'Markdown' })
  assert.equal(callout?.props.tone, 'warning')
  assert.equal(preview(), `${lineOf(55)}\n\n${lineOf(56)}`)
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
  const index = (path: string) => Number(path.slice(path.lastIndexOf('#') + 1))
  assert.ok(callout && markdown)
  assert.equal(parent(callout.path), parent(markdown.path))
  assert.ok(index(callout.path) < index(markdown.path))
})

test('Share is disabled with no checked item or no destination', async () => {
  await share()
  await panel.toggle({ type: 'Checkbox', label: 'Copy as rich text' })
  assert.equal(shareButton()?.disabled, true)
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  assert.equal(shareButton()?.disabled, true)
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  assert.equal(shareButton()?.disabled, false)
  await panel.toggle({ type: 'Checkbox', label: 'Pull Request 55 → develop' })
  await panel.toggle({ type: 'Checkbox', label: 'Pull Request 56 → qa' })
  assert.equal(shareButton()?.disabled, true)
  assert.equal(preview(), '')
})

function held() {
  let release: (value: { results: ShareResult[] }) => void = () => {}
  const answer = new Promise<{ results: ShareResult[] }>(resolve => {
    release = resolve
  })
  return { answer, release: (results: ShareResult[]) => release({ results }) }
}

test('Share reads Sharing… and is disabled while share.send is pending, and a second press posts nothing', async () => {
  const pending = held()
  const host = await share({ 'share.send': () => pending.answer })
  const first = panel.press({ type: 'Button', text: 'Share' })
  await pause(10)
  assert.equal(shareButton(), null)
  assert.equal(sharingButton()?.disabled, true)
  await assert.rejects(panel.press({ type: 'Button', text: 'Sharing…' }), /disabled/)
  assert.equal(sends(host).length, 1)
  pending.release([COPIED])
  await first
  assert.equal(sends(host).length, 1)
  assert.deepEqual(results(), [['Copy as rich text', 'success', 'Copied as rich text.']])
  assert.equal(sharingButton(), null)
  assert.equal(shareButton()?.disabled, false)
})

test('Back and Share… while a share is pending cannot send it again; a new Share works once it settles', async () => {
  const pending = held()
  const host = await share({ 'share.send': () => pending.answer })
  const presses = [panel.press({ type: 'Button', text: 'Share' })]
  await pause(10)
  presses.push(panel.press({ type: 'Button', text: 'Back' }))
  await pause(10)
  presses.push(panel.press({ type: 'Button', text: 'Share…' }))
  await pause(10)
  try {
    assert.equal(shareButton(), null)
    assert.equal(sharingButton()?.disabled, true)
    assert.ok(panel.find({ type: 'Button', text: 'Back' }))
    await assert.rejects(panel.press({ type: 'Button', text: 'Sharing…' }), /disabled/)
    assert.equal(sends(host).length, 1)
  } finally {
    pending.release([COPIED])
  }
  await Promise.all(presses)
  assert.equal(sends(host).length, 1)
  assert.deepEqual(results(), [])
  assert.equal(sharingButton(), null)
  assert.equal(shareButton()?.disabled, false)
  await panel.press({ type: 'Button', text: 'Share' })
  assert.equal(sends(host).length, 2)
  assert.deepEqual(results(), [['Copy as rich text', 'success', 'Copied as rich text.']])
})

test('a second press before Share redraws as disabled posts nothing', async () => {
  const pending = held()
  const host = await share({ 'share.send': () => pending.answer })
  const button = shareButton() as NonNullable<ReturnType<typeof shareButton>>
  const presses = [panel.press(button), panel.press(button)]
  await pause(10)
  pending.release([COPIED])
  await Promise.all(presses)
  assert.equal(sends(host).length, 1)
})

test('an empty people picker says why Share is disabled', async () => {
  await share()
  const prompts = () => panel.findAll({ type: 'Text', text: 'Choose at least one person.' })
  assert.equal(prompts().length, 0)
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  assert.equal(isChecked('Copy as rich text'), true)
  assert.equal(shareButton()?.disabled, true)
  assert.equal(prompts().length, 1)
  assert.equal(prompts()[0]?.props.muted, true)
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  assert.equal(prompts().length, 0)
  assert.equal(shareButton()?.disabled, false)
  await panel.press({ label: 'Remove Grace Hopper' })
  assert.equal(prompts().length, 1)
  assert.equal(shareButton()?.disabled, true)
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  assert.equal(prompts().length, 2)
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  assert.equal(prompts().length, 1)
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  assert.equal(prompts().length, 0)
})

test('more than 50 checked pull requests disable Share with the shared message', async () => {
  await share({}, { sets: [setOf(Array.from({ length: 51 }, (_, index) => prOf(100 + index)))] })
  assert.equal(shareButton()?.disabled, true)
  assert.equal(panel.find({ type: 'Text', text: 'Share up to 50 items at a time.' })?.props.tone, 'warning')
  await panel.toggle({ type: 'Checkbox', label: 'Pull Request 150 → develop' })
  assert.equal(shareButton()?.disabled, false)
  assert.equal(panel.find({ type: 'Text', text: 'Share up to 50 items at a time.' }), null)
})

test('a people picker holds at most 20 people', async () => {
  const people = Array.from({ length: 21 }, (_, index): Identity => ({
    id: `id-${index}`,
    displayName: `Person ${index}`,
    uniqueName: `person${index}@contoso.com`,
    kind: 'user'
  }))
  await share({ 'share.people': people }, { sets: [setOf([prOf(55)])] })
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  await panel.type({ label: 'Find people or groups' }, 'person', { submit: true })
  assert.equal(panel.find({ type: 'Text', text: 'Choose up to 20 people.' }), null)
  for (let index = 0; index < 20; index += 1) await panel.press({ type: 'ListItem', label: `Person ${index}` })
  assert.equal(panel.find({ type: 'ListItem', label: 'Person 20' })?.disabled, true)
  assert.equal(panel.find({ type: 'Text', text: 'Choose up to 20 people.' })?.props.muted, true)
  assert.equal(panel.findAll({ type: 'Switch' }).length, 20)
})

test('the composer stays within the node limit at its caps', async () => {
  const many = (prefix: string, count: number, kind: Identity['kind'] = 'user') =>
    Array.from({ length: count }, (_, index): Identity => ({ id: `${prefix}-${index}`, displayName: `${prefix} ${index}`, uniqueName: `${prefix}${index}@contoso.com`, kind }))
  const channels = Array.from({ length: 25 }, (_, index): Channel => ({ id: `c-${index}`, name: `Channel ${index}`, service: 'teams', addedAt: index }))
  const title = 'T'.repeat(400)
  const prs = Array.from({ length: 300 }, (_, index) =>
    prOf(1000 + index, { title, reviewers: [reviewerOf(`Reviewer ${index}`, 0)], ...(index < 50 ? {} : { status: 'completed' as const, closedAt: NOW }) })
  )
  const answer: ShareResult[] = [
    { destination: 'copy', ok: false, text: "Couldn't copy to the clipboard.", plain: `${plainOf(1000)}\n`.repeat(50) },
    ...channels.slice(0, 20).map(channel => ({ destination: `channel:${channel.id}`, ok: true, text: `Sent to ${channel.name} (accepted).` })),
    { destination: 'reviewers', ok: false, text: 'x'.repeat(100_000) }
  ]
  const host = await share(
    {
      'share.prefs': prefsOf({
        channels,
        prefs: {
          destinations: [
            { kind: 'copy' },
            ...channels.map(channel => ({ kind: 'channel' as const, id: channel.id })),
            { kind: 'chat', people: many('chat', 25) },
            { kind: 'reviewers', people: many('reviewer', 25).map(person => ({ ...person, required: true })) }
          ]
        }
      }),
      'share.people': input => many(input.groups ? 'found' : 'user', 40, input.groups ? 'group' : 'user'),
      'share.send': { results: answer }
    },
    { sets: [setOf(prs)] }
  )
  await panel.type({ label: 'Find people' }, 'a', { submit: true })
  await panel.type({ label: 'Find people or groups' }, 'a', { submit: true })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(panel.errors, [])
  assert.equal(panel.findAll({ type: 'Checkbox', label: /^Post to / }).length, 20)
  assert.equal(panel.findAll({ type: 'Switch' }).length, 20)
  assert.equal(panel.findAll({ label: /^Remove / }).length, 40)
  assert.equal(panel.findAll({ type: 'Checkbox', label: /^Pull Request / }).length, 300)
  const offers = panel.findAll({ type: 'ListItem' })
  assert.equal(offers.length, 60)
  assert.ok(offers.every(offer => offer.disabled))
  assert.equal(opens(host).length, 0)
  assert.equal(results().length, 23)
  assert.equal(results()[22]?.[2], 'Too long for a Teams chat link. Use Copy instead.')
})

test('a refused Teams link offers Open Teams chat, which opens only the link', async () => {
  const host = await share({ 'share.send': { results: [COPIED] } })
  host.respond('shell.openExternal', () => {
    throw hostError('rate_limited', 'Too many links opened. Try again in a few seconds.')
  })
  await chooseChat()
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Message in Teams', 'danger', `${NOT_OPENED} Too many links opened. Try again in a few seconds. Open Teams chat`]
  ])
  host.respond('shell.openExternal', { opened: true })
  await panel.press({ type: 'Button', text: 'Open Teams chat' })
  assert.equal(opens(host).length, 2)
  assert.equal(opens(host)[1]?.url, opens(host)[0]?.url)
  assert.equal(sends(host).length, 1)
  assert.deepEqual(results()[1], ['Message in Teams', 'success', 'Opened a Teams chat.'])
  assert.equal(panel.find({ type: 'Button', text: 'Open Teams chat' }), null)
})

test("a Teams link Orca couldn't ask about says so; a cancelled one adds no reason", async () => {
  const host = await share({ 'share.send': { results: [] } })
  host.respond('shell.openExternal', { opened: false, reason: 'consent-unavailable' })
  await chooseChat()
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(results(), [['Message in Teams', 'danger', `${NOT_OPENED} ${OPEN_UNAVAILABLE} Open Teams chat`]])
  host.respond('shell.openExternal', { opened: false, reason: 'cancelled' })
  await panel.press({ type: 'Button', text: 'Open Teams chat' })
  assert.deepEqual(results(), [['Message in Teams', 'danger', `${NOT_OPENED} Open Teams chat`]])
  assert.equal(sends(host).length, 1)
})

test('the Teams hint shows only in the first composer of a session, and Back returns to the sets', async () => {
  await share()
  assert.equal(panel.find({ type: 'Text', text: HINT })?.props.muted, true)
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.equal(panel.findAll({ type: 'Card' }).length, 1)
  await panel.press({ type: 'Button', text: 'Share…' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
  assert.equal(panel.find({ type: 'Text', text: HINT }), null)
})

test('the composer closes when the active org changes', async () => {
  await share({}, { orgs: [org('contoso'), org('fabrikam')] })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
  await panel.select({ label: 'Organization' }, 'fabrikam')
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.equal(panel.findAll({ type: 'Card' }).length, 1)
  await panel.select({ label: 'Organization' }, 'contoso')
  assert.equal(panel.find({ type: 'Heading' }), null)
})

test('a failed send shows its message and frees Share', async () => {
  await share({
    'share.send': () => {
      throw hostError('action_failed', 'Connect this organization first.')
    }
  })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(results(), [[undefined, 'danger', 'Connect this organization first.']])
  assert.equal(shareButton()?.disabled, false)
})

test('a failed prefs load shows the message and Try again loads again', async () => {
  let loads = 0
  await share({
    'share.prefs': () => {
      loads += 1
      if (loads === 1) throw hostError('action_failed', 'Connect this organization first.')
      return prefsOf()
    }
  })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Connect this organization first.')
  assert.equal(panel.find({ type: 'Markdown' }), null)
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(preview(), `${lineOf(55)}\n\n${lineOf(56)}`)
})

const INTRO_BETWEEN_THE_LIMITS = 1730
const NOT_OPENED_EMAIL = "The email draft wasn't opened."
const RUN_5 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=5'
const APPROVAL_LINE = `Approval needed for production: [web-app-cd 20261105.5](${RUN_5}) on main`
const APPROVAL_PLAIN = `Approval needed for production: web-app-cd 20261105.5 on main ${RUN_5}`
const APPROVAL_SUBJECT = 'Approval needed: web-app-cd 20261105.5'

const APPROVER_GRACE: Approver = { id: 'u-grace', name: 'Grace Hopper', uniqueName: 'grace@contoso.com', isGroup: false }
const APPROVER_LINUS: Approver = { id: 'u-linus', name: 'Linus Torvalds', uniqueName: 'linus@contoso.com', isGroup: false }
const APPROVER_TEAM: Approver = { id: 'g-approvers', name: 'Release Approvers', uniqueName: '[Fabrikam Web]\\Release Approvers', isGroup: true }
const PERSON_GRACE: Identity = { id: 'u-grace', displayName: 'Grace Hopper', uniqueName: 'grace@contoso.com', kind: 'user' }
const PERSON_LINUS: Identity = { id: 'u-linus', displayName: 'Linus Torvalds', uniqueName: 'linus@contoso.com', kind: 'user' }

const approvalPrefs = (over: Partial<SharePrefsView> = {}): SharePrefsView => prefsOf({ template: APPROVAL_TEMPLATE, ...over })

const mailTo = (to: string[]): string => mailtoUrl({ to, subject: APPROVAL_SUBJECT, body: APPROVAL_PLAIN }) ?? ''

const approvalRuns = () => [waitingRun(5, [approvalOf('ap-1', 5, { approvers: [APPROVER_GRACE, APPROVER_TEAM, APPROVER_LINUS] })])]

async function pipelinesWith(more: MockRequests = {}, orgs: OrgStatus[] = [org('contoso')]): Promise<TestHost> {
  const runs = approvalRuns()
  const mounted = await mountPanel(orgs, { 'runs.snapshot': runsSnapshotOf({ runs }), ...more }, { persisted: { workspace: { tab: 'pipelines' } } })
  panel = mounted.panel
  return mounted.host
}

async function approve(more: MockRequests = {}): Promise<TestHost> {
  const host = await pipelinesWith(more)
  await panel.press({ type: 'Button', text: 'Share for approval' })
  return host
}

const approvalBoxes = () => panel.findAll({ type: 'Checkbox', label: /→/ }).map(box => [box.label, box.props.checked])

const orderOfLinksAndSends = (host: TestHost) =>
  host.calls
    .map(call => (call.method === 'plugin.request' ? (call.params as { name: string }).name : call.method))
    .filter(name => name === 'shell.openExternal' || name === 'share.send')

test('Share for approval opens the composer with the approval and its approvers', async () => {
  const host = await approve()
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share for approval')
  assert.equal(panel.find({ type: 'Card' }), null)
  assert.deepEqual(requestsTo(host, 'share.prefs').map(call => call.input), [{ org: 'contoso', kind: 'approval' }])
  assert.deepEqual(approvalBoxes(), [['web-app-cd 20261105.5 → production', true]])
  assert.equal(preview(), APPROVAL_LINE)
  assert.equal(isChecked('Copy as rich text'), true)
  assert.equal(isChecked('Message in Teams'), false)
  assert.equal(isChecked('Email'), false)
  assert.equal(panel.find({ type: 'Checkbox', label: 'Add as reviewers' }), null)
  assert.equal(panel.find({ label: 'Find people to email' }), null)
  assert.equal(panel.find({ type: 'Button', text: 'Back' })?.props.variant, 'ghost')

  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  assert.equal(panel.find({ label: 'Find people to email' })?.props.placeholder, 'Name or email')
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Grace Hopper', 'Linus Torvalds'])
  assert.equal(panel.find({ type: 'Switch' }), null)
  assert.equal(shareButton()?.disabled, true)
  assert.equal(panel.findAll({ type: 'Text', text: 'Choose at least one person.' }).length, 1)
})

test("the approval composer doesn't suggest the signed-in approver to themselves", async () => {
  await approve({ 'runs.snapshot': runsSnapshotOf({ runs: approvalRuns(), me: 'U-LINUS' }) })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), ['Grace Hopper'])
})

test('with chat and email chosen, the Teams link opens first and email waits for its own button', async () => {
  const host = await approve({
    'share.prefs': approvalPrefs({
      tenantId: 'tenant-1',
      prefs: { destinations: [{ kind: 'copy' }, { kind: 'chat', people: [PERSON_GRACE] }, { kind: 'email', people: [PERSON_LINUS] }] }
    }),
    'share.send': { results: [COPIED] }
  })
  assert.equal(isChecked('Message in Teams'), true)
  assert.equal(isChecked('Email'), true)
  assert.ok(panel.find({ label: 'Remove Linus Torvalds' }))
  await panel.press({ type: 'Button', text: 'Share' })

  const teams = teamsChatUrl({ users: ['grace@contoso.com'], text: APPROVAL_PLAIN, tenantId: 'tenant-1' })
  assert.deepEqual(opens(host), [{ url: teams }])
  assert.deepEqual(orderOfLinksAndSends(host), ['shell.openExternal', 'share.send'])
  assert.deepEqual(sends(host), [
    {
      org: 'contoso',
      kind: 'approval',
      keys: ['approval:proj-web/ap-1'],
      intro: '',
      destinations: [{ kind: 'copy' }, { kind: 'chat', people: [PERSON_GRACE] }, { kind: 'email', people: [PERSON_LINUS] }]
    }
  ])
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Message in Teams', 'success', 'Opened a Teams chat.'],
    ['Email', 'neutral', `${NOT_OPENED_EMAIL} Open email`]
  ])
  assert.equal(panel.find({ type: 'Button', text: 'Open Teams chat' }), null)

  await panel.press({ type: 'Button', text: 'Open email' })
  assert.deepEqual(opens(host), [{ url: teams }, { url: mailTo(['linus@contoso.com']) }])
  assert.equal(sends(host).length, 1)
  assert.deepEqual(results()[2], ['Email', 'success', 'Opened an email draft.'])
  assert.equal(panel.find({ type: 'Button', text: 'Open email' }), null)
})

test("a chat link that's too long leaves the turn to email", async () => {
  const people = [PERSON_GRACE, PERSON_LINUS]
  const host = await approve({
    'share.prefs': approvalPrefs({
      tenantId: 'tenant-1',
      prefs: { destinations: [{ kind: 'chat', people }, { kind: 'email', people: [PERSON_LINUS] }] }
    }),
    'share.send': { results: [] }
  })
  const intro = 'x'.repeat(INTRO_BETWEEN_THE_LIMITS)
  await panel.type({ label: 'Intro (optional)' }, intro)
  const body = `${intro}\n\n${APPROVAL_PLAIN}`
  const mail = mailtoUrl({ to: ['linus@contoso.com'], subject: APPROVAL_SUBJECT, body })
  assert.equal(teamsChatUrl({ users: people.map(person => person.uniqueName), text: body, tenantId: 'tenant-1' }), null)
  assert.ok(mail, 'the email link fits where the chat link does not')

  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(opens(host), [{ url: mail }])
  assert.deepEqual(results(), [
    ['Message in Teams', 'danger', 'Too long for a Teams chat link. Use Copy instead.'],
    ['Email', 'success', 'Opened an email draft.']
  ])
  assert.equal(panel.find({ type: 'Button', text: 'Open email' }), null)
})

test('email alone opens the mailto link before share.send', async () => {
  const host = await approve({ 'share.send': { results: [COPIED] } })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  await panel.press({ type: 'ListItem', label: 'Linus Torvalds' })
  assert.equal(shareButton()?.disabled, false)
  await panel.press({ type: 'Button', text: 'Share' })

  const url = mailTo(['linus@contoso.com'])
  assert.match(url, /^mailto:linus%40contoso\.com\?subject=Approval%20needed%3A%20web-app-cd%2020261105\.5&body=/)
  assert.deepEqual(opens(host), [{ url }])
  assert.deepEqual(orderOfLinksAndSends(host), ['shell.openExternal', 'share.send'])
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'copy' }, { kind: 'email', people: [PERSON_LINUS] }])
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Email', 'success', 'Opened an email draft.']
  ])
  assert.equal(panel.find({ type: 'Button', text: 'Open email' }), null)
})

test('a refused email link offers Open email, which opens only the link', async () => {
  const host = await approve({ 'share.send': { results: [COPIED] } })
  host.respond('shell.openExternal', () => {
    throw hostError('rate_limited', 'Too many links opened. Try again in a few seconds.')
  })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(results(), [
    ['Copy as rich text', 'success', 'Copied as rich text.'],
    ['Email', 'danger', `${NOT_OPENED_EMAIL} Too many links opened. Try again in a few seconds. Open email`]
  ])
  host.respond('shell.openExternal', { opened: true })
  await panel.press({ type: 'Button', text: 'Open email' })
  assert.equal(opens(host).length, 2)
  assert.equal(opens(host)[1]?.url, opens(host)[0]?.url)
  assert.equal(sends(host).length, 1)
  assert.deepEqual(results()[1], ['Email', 'success', 'Opened an email draft.'])
})

test("an email link that's too long is refused without opening anything", async () => {
  const host = await approve({ 'share.send': { results: [] } })
  await panel.toggle({ type: 'Checkbox', label: 'Copy as rich text' })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  await panel.type({ label: 'Intro (optional)' }, 'x'.repeat(MAX_INTRO))
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(opens(host), [])
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'email', people: [PERSON_GRACE] }])
  assert.deepEqual(results(), [['Email', 'danger', 'Too long for an email link. Use Copy instead.']])
  assert.equal(panel.find({ type: 'Button', text: 'Open email' }), null)
})

test("an email link Orca couldn't ask about says so", async () => {
  const host = await approve({ 'share.send': { results: [] } })
  host.respond('shell.openExternal', { opened: false, reason: 'consent-unavailable' })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  await panel.press({ type: 'ListItem', label: 'Grace Hopper' })
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(results(), [['Email', 'danger', `${NOT_OPENED_EMAIL} ${OPEN_UNAVAILABLE} Open email`]])
})

test('a remembered email destination preselects its people where email is offered, and is ignored where it is not', async () => {
  const remembered = { destinations: [{ kind: 'copy' as const }, { kind: 'email' as const, people: [PERSON_LINUS] }] }
  await approve({ 'share.prefs': approvalPrefs({ prefs: remembered }) })
  assert.equal(isChecked('Email'), true)
  assert.ok(panel.find({ label: 'Remove Linus Torvalds' }))
  await closeCleanly(panel)

  const host = await share({ 'share.prefs': prefsOf({ prefs: remembered }), 'share.send': { results: [COPIED] } })
  assert.equal(panel.find({ type: 'Checkbox', label: 'Email' }), null)
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual(sends(host)[0]?.destinations, [{ kind: 'copy' }])
  assert.deepEqual(opens(host), [])
})

test("a composer opened from Pipelines doesn't show on the PRs tab, and one from the PRs tab doesn't show on Pipelines", async () => {
  await approve()
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.equal(panel.find({ type: 'Checkbox', label: 'Email' }), null)
  assert.ok(panel.find({ label: 'Teams channels' }), 'the PRs tab shows its own view')
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share for approval')
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' }), null)
  await closeCleanly(panel)

  await share()
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.ok(panel.find({ type: 'Button', text: 'Mine' }), 'the Pipelines tab shows its own view')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
})

test('the channel manager belongs to the tab that opened it, and Back returns there', async () => {
  await pipelinesWith({ 'share.channels': [RELEASES] })
  await panel.press({ label: 'Teams channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  await panel.select({ type: 'Tabs' }, 'prs')
  assert.equal(panel.find({ type: 'Heading' }), null)
  await panel.select({ type: 'Tabs' }, 'pipelines')
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.ok(panel.find({ type: 'Button', text: 'Mine' }))
  await panel.press({ type: 'Button', text: 'Share for approval' })
  await panel.press({ type: 'Button', text: 'Manage channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share for approval')
})

test('the chat, email and reviewer pickers keep separate queries', async () => {
  const found = (query: string): Identity[] => (query === 'gra' ? [GRACE] : [LINUS])
  const host = await approve({ 'share.people': input => found(input.query) })
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.toggle({ type: 'Checkbox', label: 'Email' })
  await panel.type({ label: 'Find people' }, 'gra', { submit: true })
  await panel.type({ label: 'Find people to email' }, 'lin', { submit: true })
  assert.equal(panel.valueOf({ label: 'Find people' }), 'gra')
  assert.equal(panel.valueOf({ label: 'Find people to email' }), 'lin')
  assert.equal(panel.find({ label: 'Find people or groups' }), null)
  assert.deepEqual(
    requestsTo(host, 'share.people').map(call => call.input),
    [
      { org: 'contoso', query: 'gra', groups: false },
      { org: 'contoso', query: 'lin', groups: false }
    ]
  )
  await closeCleanly(panel)

  await share({ 'share.people': input => found(input.query) })
  await panel.toggle({ type: 'Checkbox', label: 'Message in Teams' })
  await panel.toggle({ type: 'Checkbox', label: 'Add as reviewers' })
  await panel.type({ label: 'Find people' }, 'gra', { submit: true })
  await panel.type({ label: 'Find people or groups' }, 'lin', { submit: true })
  assert.equal(panel.valueOf({ label: 'Find people' }), 'gra')
  assert.equal(panel.valueOf({ label: 'Find people or groups' }), 'lin')
  assert.equal(panel.find({ label: 'Find people to email' }), null)
})
