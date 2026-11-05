import { afterEach, assert, hostError, test, type MockRequests, type TestPanel } from 'orca/testing'
import { PR_TEMPLATE } from '../../shared/share/template'
import type { Channel, ShareRequest } from '../../shared/share/types'
import { prOf, setOf, snapshotOf } from '../prs/fixtures'
import { closeCleanly, mountPanel, org, requestsTo, type TestHost } from '../test-support'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

const HELP =
  'In Teams, open the channel\'s ⋯ menu → Workflows → "Send webhook alerts to a channel", then paste the URL it gives you. Posts come from the Workflows bot.'
const SENT = "Sent (accepted). Teams doesn't confirm delivery; check the channel."
const SECRET = 'https://contoso.webhook.office.com/workflows/abc?sig=SECRET-SIG-1'
const ROTATED = 'https://contoso.webhook.office.com/workflows/abc?sig=SECRET-SIG-2'

const RELEASES: Channel = { id: 'c-releases', name: 'Releases', service: 'teams', addedAt: 1 }
const QA: Channel = { id: 'c-qa', name: 'QA', service: 'teams', addedAt: 2 }

async function mountPrs(more: MockRequests = {}): Promise<TestHost> {
  const mounted = await mountPanel(
    [org('contoso')],
    { 'prs.snapshot': snapshotOf({ sets: [setOf([prOf(55)])] }), 'share.channels': [RELEASES, QA], ...more },
    { persisted: { workspace: { tab: 'prs' } } }
  )
  panel = mounted.panel
  return mounted.host
}

async function openChannels(more: MockRequests = {}): Promise<TestHost> {
  const host = await mountPrs(more)
  await panel.press({ label: 'Teams channels' })
  return host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const leaks = (secret: string) => JSON.stringify(panel.tree()).includes(secret) || JSON.stringify(panel.persisted).includes(secret)

const channelNames = () => panel.findAll({ type: 'Text', text: /^(Releases|QA|Builds)$/ }).map(text => text.text)

test('the header opens the channel manager with the setup help', async () => {
  const host = await openChannels()
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  assert.equal(panel.find({ type: 'Text', text: HELP })?.props.muted, true)
  assert.deepEqual(inputsTo(host, 'share.channels'), [{}])
  assert.deepEqual(channelNames(), ['Releases', 'QA'])
  assert.equal(panel.findAll({ type: 'Button', text: 'Test' }).length, 2)
  assert.equal(panel.find({ label: 'Webhook URL' })?.props.type, 'password')
})

test('adding a channel clears the URL field and the URL never shows in the tree', async () => {
  const host = await openChannels({
    'share.addChannel': input => ({ id: 'c-builds', name: input.name.trim(), service: 'teams', addedAt: 3 })
  })
  assert.equal(panel.find({ type: 'Button', text: 'Add channel' })?.disabled, true)
  await panel.type({ label: 'Channel name' }, 'Builds')
  await panel.type({ label: 'Webhook URL' }, SECRET)
  assert.equal(panel.valueOf({ label: 'Webhook URL' }), SECRET)
  await panel.press({ type: 'Button', text: 'Add channel' })
  assert.deepEqual(inputsTo(host, 'share.addChannel'), [{ name: 'Builds', url: SECRET }])
  assert.equal(panel.valueOf({ label: 'Webhook URL' }), '')
  assert.equal(panel.valueOf({ label: 'Channel name' }), '')
  assert.deepEqual(channelNames(), ['Releases', 'QA', 'Builds'])
  assert.equal(leaks('SECRET-SIG'), false)
  assert.deepEqual(panel.persisted, { plugin: {}, workspace: { tab: 'prs' }, storage: {} })
})

test('a failed add keeps the name, clears the URL and shows the message', async () => {
  await openChannels({
    'share.addChannel': () => {
      throw hostError('action_failed', 'You already have a channel with that name.')
    }
  })
  await panel.type({ label: 'Channel name' }, 'Releases')
  await panel.type({ label: 'Webhook URL' }, SECRET)
  await panel.press({ type: 'Button', text: 'Add channel' })
  assert.equal(panel.valueOf({ label: 'Webhook URL' }), '')
  assert.equal(panel.valueOf({ label: 'Channel name' }), 'Releases')
  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props.tone, 'danger')
  assert.equal(callout?.text, 'You already have a channel with that name.')
  assert.equal(leaks('SECRET-SIG'), false)
})

test("a channel name over 100 characters can't be added", async () => {
  const host = await openChannels()
  assert.equal(panel.find({ label: 'Channel name' })?.props.maxLength, 100)
  await panel.type({ label: 'Channel name' }, 'Q'.repeat(101))
  await panel.type({ label: 'Webhook URL' }, SECRET)
  assert.equal(panel.find({ type: 'Button', text: 'Add channel' })?.disabled, true)
  assert.equal(panel.find({ type: 'Text', text: 'Keep the channel name to 100 characters or fewer.' })?.props.tone, 'danger')
  await panel.submit({ label: 'Webhook URL' })
  assert.deepEqual(inputsTo(host, 'share.addChannel'), [])
  await panel.press({ type: 'Button', text: 'Back' })
})

test('Test shows sent (accepted)', async () => {
  const host = await openChannels({
    'share.testChannel': input =>
      input.id === 'c-releases'
        ? { destination: 'channel:c-releases', ok: true, text: SENT }
        : { destination: 'channel:c-qa', ok: false, text: "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL." }
  })
  await panel.press(panel.findAll({ type: 'Button', text: 'Test' })[0])
  assert.deepEqual(inputsTo(host, 'share.testChannel'), [{ id: 'c-releases' }])
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['success', SENT]]
  )
  await panel.press(panel.findAll({ type: 'Button', text: 'Test' })[1])
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['danger', "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL."]]
  )
})

test('Replace URL reveals a password field, saves the new URL and clears it', async () => {
  let saves = 0
  const host = await openChannels({
    'share.replaceChannel': input => {
      saves += 1
      if (saves > 1) throw hostError('action_failed', "That isn't a valid https webhook URL.")
      return { ...RELEASES, id: input.id }
    }
  })
  assert.equal(panel.find({ label: 'New webhook URL' }), null)
  await panel.press(panel.findAll({ type: 'Button', text: 'Replace URL' })[0])
  assert.equal(panel.find({ label: 'New webhook URL' })?.props.type, 'password')
  await panel.type({ label: 'New webhook URL' }, ROTATED)
  await panel.press({ type: 'Button', text: 'Save' })
  assert.deepEqual(inputsTo(host, 'share.replaceChannel'), [{ id: 'c-releases', url: ROTATED }])
  assert.equal(panel.find({ label: 'New webhook URL' }), null)
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['success', 'Webhook URL replaced.']]
  )
  assert.equal(leaks('SECRET-SIG'), false)

  await panel.press(panel.findAll({ type: 'Button', text: 'Replace URL' })[0])
  await panel.type({ label: 'New webhook URL' }, ROTATED)
  await panel.press({ type: 'Button', text: 'Save' })
  assert.equal(panel.valueOf({ label: 'New webhook URL' }), '')
  assert.equal(panel.find({ type: 'Callout' })?.text, "That isn't a valid https webhook URL.")
  assert.equal(leaks('SECRET-SIG'), false)
})

test('Remove asks to confirm', async () => {
  const host = await openChannels({ 'share.removeChannel': { ok: true } })
  await panel.press(panel.findAll({ type: 'Button', text: 'Remove' })[0])
  assert.deepEqual(inputsTo(host, 'share.removeChannel'), [])
  const confirm = panel.find({ type: 'Button', text: 'Confirm remove' })
  assert.equal(confirm?.props.tone, 'danger')
  assert.equal(panel.findAll({ type: 'Button', text: 'Remove' }).length, 1)
  await panel.press({ type: 'Button', text: 'Confirm remove' })
  assert.deepEqual(inputsTo(host, 'share.removeChannel'), [{ id: 'c-releases' }])
  assert.deepEqual(channelNames(), ['QA'])
})

test('Back returns to the composer when it was open, else the list', async () => {
  const host = await mountPrs({
    'share.prefs': { template: PR_TEMPLATE, channels: [RELEASES, QA], prefs: { destinations: [{ kind: 'copy' }, { kind: 'channel', id: 'c-qa' }] }, tenantId: null },
    'share.removeChannel': { ok: true },
    'share.addChannel': input => ({ id: 'c-builds', name: input.name, service: 'teams', addedAt: 3 }),
    'share.send': { results: [] }
  })
  await panel.press({ type: 'Button', text: 'Share…' })
  assert.equal(panel.find({ type: 'Checkbox', label: 'Post to QA' })?.props.checked, true)
  await panel.press({ type: 'Button', text: 'Manage channels' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Teams channels')
  await panel.press(panel.findAll({ type: 'Button', text: 'Remove' })[1])
  await panel.press({ type: 'Button', text: 'Confirm remove' })
  await panel.type({ label: 'Channel name' }, 'Builds')
  await panel.type({ label: 'Webhook URL' }, SECRET)
  await panel.press({ type: 'Button', text: 'Add channel' })
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' })?.text, 'Share pull requests')
  assert.deepEqual(
    panel.findAll({ type: 'Checkbox', label: /^Post to / }).map(box => [box.label, box.props.checked]),
    [
      ['Post to Releases', false],
      ['Post to Builds', false]
    ]
  )
  await panel.press({ type: 'Button', text: 'Share' })
  assert.deepEqual((requestsTo(host, 'share.send')[0]?.input as ShareRequest).destinations, [{ kind: 'copy' }])

  await panel.press({ type: 'Button', text: 'Back' })
  await panel.press({ label: 'Teams channels' })
  await panel.press({ type: 'Button', text: 'Back' })
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.equal(panel.findAll({ type: 'Card' }).length, 1)
})

test('a failed channel list shows the message and Try again loads again', async () => {
  let loads = 0
  await openChannels({
    'share.channels': () => {
      loads += 1
      if (loads === 1) throw hostError('action_failed', "Orca can't store secrets on this system, so Teams channels are unavailable.")
      return [RELEASES]
    }
  })
  assert.equal(panel.find({ type: 'Callout' })?.text, "Orca can't store secrets on this system, so Teams channels are unavailable.")
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.deepEqual(channelNames(), ['Releases'])
})
