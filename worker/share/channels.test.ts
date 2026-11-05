import { assert, test } from 'orca/testing'
import type { SecretsPort } from '../auth/pat'
import { memoryStore } from '../test-support'
import { checkWebhookUrl, createChannelStore } from './channels'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const SIG = 'wQ3vN8sXkP2mR7tY1uZ4aB6cD9eF0gH5iJ'
const WEBHOOK = `https://default0f0e0d0c.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const ROTATED = 'https://prod-07.westeurope.logic.azure.com/workflows/9a8b7c6d/triggers/manual/paths/invoke?api-version=2016-06-01&sig=Rk2pL9qWz4'
const EMPTY_URL = 'Paste the webhook URL from Teams Workflows.'
const INVALID_URL = "That isn't a valid https webhook URL."
const UNAVAILABLE = "Orca can't store secrets on this system, so Teams channels are unavailable."
const GONE = 'That channel no longer exists.'

const failsWith = (message: string) => (error: unknown) => error instanceof Error && error.message === message

function refusalOf(input: string): string {
  try {
    return `accepted ${checkWebhookUrl(input)}`
  } catch (error) {
    return (error as Error).message
  }
}

function setup() {
  const { data: storage, store } = memoryStore()
  const secretData: Record<string, string> = {}
  const failing = { set: false, delete: false }
  const secrets: SecretsPort = {
    get: async key => secretData[key] ?? null,
    set: async (key, value) => {
      if (failing.set) throw new Error(`the keyring refused ${value}`)
      secretData[key] = value
    },
    delete: async key => {
      if (failing.delete) throw new Error('the keyring is locked')
      delete secretData[key]
    }
  }
  let next = 0
  const channels = createChannelStore({ store, secrets, newId: () => `channel-${++next}`, now: () => T0 })
  return { storage, secretData, failing, channels }
}

test('add keeps the URL only in secrets and returns metadata', async () => {
  const { storage, secretData, channels } = setup()
  const added = await channels.add('  Release train ', `  ${WEBHOOK}\n`)
  assert.deepEqual(added, { id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0 })
  assert.deepEqual(storage, { 'share:channels': [added] })
  assert.deepEqual(secretData, { 'teams-webhook:channel-1': WEBHOOK })
  assert.ok(!JSON.stringify(storage).includes(SIG), 'the webhook URL leaked into storage')
  assert.deepEqual(await channels.list(), [added])
  assert.equal(await channels.url('channel-1'), WEBHOOK)
  assert.equal(await channels.url('channel-9'), null)
})

test('invalid URLs and names are refused with the fixed messages', async () => {
  for (const input of ['', '   \n']) assert.equal(refusalOf(input), EMPTY_URL)
  const invalid = [
    'prod-07.westeurope.logic.azure.com/workflows/1',
    'http://prod-07.westeurope.logic.azure.com/workflows/1',
    'ftp://prod-07.westeurope.logic.azure.com/workflows/1',
    'javascript:alert(1)',
    'https://ada@prod-07.westeurope.logic.azure.com/workflows/1',
    'https://ada:hunter2@prod-07.westeurope.logic.azure.com/workflows/1',
    `https://hooks.contoso.com/${'a'.repeat(4096 - 'https://hooks.contoso.com/'.length + 1)}`
  ]
  for (const input of invalid) assert.equal(refusalOf(input), INVALID_URL, input)
  const longest = `https://hooks.contoso.com/${'a'.repeat(4096 - 'https://hooks.contoso.com/'.length)}`
  assert.equal(checkWebhookUrl(longest), longest)
  assert.equal(checkWebhookUrl(` ${ROTATED} `), ROTATED, 'any https host is accepted')

  const { storage, secretData, channels } = setup()
  await assert.rejects(channels.add(' ', WEBHOOK), failsWith('Name the channel.'))
  await assert.rejects(channels.add('Release train', ''), failsWith(EMPTY_URL))
  await assert.rejects(channels.add('Release train', WEBHOOK.replace('https:', 'http:')), failsWith(INVALID_URL))
  const added = await channels.add('Release train', WEBHOOK)
  await assert.rejects(channels.add(' release TRAIN ', ROTATED), failsWith('You already have a channel with that name.'))
  assert.deepEqual(storage, { 'share:channels': [added] })
  assert.deepEqual(Object.keys(secretData), ['teams-webhook:channel-1'])
})

test('a store holds at most 20 channels', async () => {
  const { storage, secretData, channels } = setup()
  for (let index = 1; index <= 20; index += 1) await channels.add(`Channel ${index}`, WEBHOOK)
  await assert.rejects(channels.add('Channel 21', WEBHOOK), failsWith('You can add up to 20 channels.'))
  assert.equal((storage['share:channels'] as unknown[]).length, 20)
  assert.equal(Object.keys(secretData).length, 20)
})

test('replace and remove', async () => {
  const { storage, secretData, failing, channels } = setup()
  const first = await channels.add('Release train', WEBHOOK)
  const second = await channels.add('QA', ROTATED)

  assert.deepEqual(await channels.replace(first.id, ` ${ROTATED} `), first)
  assert.equal(secretData['teams-webhook:channel-1'], ROTATED)
  assert.deepEqual(storage['share:channels'], [first, second])
  await assert.rejects(channels.replace(first.id, 'http://prod-07.westeurope.logic.azure.com/x'), failsWith(INVALID_URL))
  await assert.rejects(channels.replace('channel-9', WEBHOOK), failsWith(GONE))
  assert.equal(secretData['teams-webhook:channel-1'], ROTATED)
  assert.ok(!('teams-webhook:channel-9' in secretData), 'replacing an unknown channel stores nothing')

  failing.delete = true
  await assert.rejects(channels.remove(first.id), failsWith('the keyring is locked'))
  assert.deepEqual(storage['share:channels'], [first, second], 'the metadata stays until its secret is gone')
  failing.delete = false
  await channels.remove(first.id)
  assert.deepEqual(storage['share:channels'], [second])
  assert.deepEqual(Object.keys(secretData), ['teams-webhook:channel-2'])
  assert.equal(await channels.url(first.id), null)
  await channels.remove(first.id)
  assert.deepEqual(await channels.list(), [second])
})

test('a secrets failure gives the unavailable message', async () => {
  const { storage, secretData, failing, channels } = setup()
  failing.set = true
  const refused = (error: unknown) => failsWith(UNAVAILABLE)(error) && !(error as Error).message.includes(SIG)
  await assert.rejects(channels.add('Release train', WEBHOOK), refused)
  assert.deepEqual(storage, {}, 'no metadata without its secret')

  failing.set = false
  const added = await channels.add('Release train', WEBHOOK)
  failing.set = true
  await assert.rejects(channels.replace(added.id, ROTATED), refused)
  assert.equal(secretData[`teams-webhook:${added.id}`], WEBHOOK)
})

test('list returns only channel metadata, whatever storage holds', async () => {
  const { store } = memoryStore({
    'share:channels': [
      { id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0, url: WEBHOOK },
      { id: 42, name: 'Broken' },
      'not a channel'
    ]
  })
  const secrets: SecretsPort = { get: async () => null, set: async () => {}, delete: async () => {} }
  const channels = createChannelStore({ store, secrets, newId: () => 'unused', now: () => T0 })
  assert.deepEqual(await channels.list(), [{ id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0 }])
})
