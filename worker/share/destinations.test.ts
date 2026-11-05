import { assert, test } from 'orca/testing'
import type { PrKey } from '../../src/shared/prs'
import { toHtml, toPlain } from '../../src/shared/share/message'
import type { Person, ShareMessage } from '../../src/shared/share/types'
import { createAdoHttp } from '../ado/http'
import type { SecretsPort } from '../auth/pat'
import { fakeAdo, fixture, json, ORG, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import type { Clipboard } from '../sys/clipboard'
import { memoryStore } from '../test-support'
import { adaptiveCard, webhookPayload } from './card'
import { createChannelStore } from './channels'
import { channelDestination, copyDestination, reviewersDestination, type DestinationContext } from './destinations'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const SIG = 'wQ3vN8sXkP2mR7tY1uZ4aB6cD9eF0gH5iJ'
const WEBHOOK = `https://default0f0e0d0c.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const PR_4101 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101'
const PR_4104 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/api/pullrequest/4104'
const NO_PERMISSION = 'TF401027: You need the PullRequestContribute permission.'

const MESSAGE: ShareMessage = {
  intro: 'Ready for QA.',
  lines: [
    [{ text: 'Pull Request 4101', href: PR_4101 }, { text: ': Add vehicle search filters' }],
    [{ text: 'Pull Request 4104', href: PR_4104 }, { text: ': Fix pagination offset' }]
  ]
}
const PLAIN = `Ready for QA.\n\nPull Request 4101: Add vehicle search filters ${PR_4101}\nPull Request 4104: Fix pagination offset ${PR_4104}`

const GRACE: Person = { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', kind: 'user', required: false }
const NIA: Person = { id: 'e5f6a7b8-5555-4eaf-9fb1-3c4d5e6f7081', displayName: 'Nia Okafor', uniqueName: 'nia@contoso.example', kind: 'user', required: true }
const OMAR: Person = { id: 'f6a7b8c9-5555-4fb0-8ac2-4d5e6f708192', displayName: 'Omar Haddad', uniqueName: 'omar@contoso.example', kind: 'user', required: false }

const REVIEWERS = /^\/contoso\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/reviewers$/
const REVIEWER = /^\/contoso\/[^/]+\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/reviewers\/([^/]+)$/
const isListReviewers = (call: AdoCall) => call.method === 'GET' && REVIEWERS.test(call.path)
const isPutReviewer = (call: AdoCall) => call.method === 'PUT' && REVIEWER.test(call.path)
const prOf = (call: AdoCall) => Number((REVIEWERS.exec(call.path) ?? REVIEWER.exec(call.path))?.[1])

const key = (prId: number): PrKey => ({ projectId: PROJECT, repoId: REPO, prId })

function context(overrides: Partial<DestinationContext> = {}): DestinationContext {
  return { org: ORG, message: MESSAGE, prs: [key(4101), key(4102)], sharedBy: 'Alex Contoso', ...overrides }
}

function reviewersSetup() {
  const ado = fakeAdo()
  ado.on(isListReviewers, () => json(200, fixture('pull-request-reviewers')))
  ado.on(isPutReviewer, call => json(200, { id: REVIEWER.exec(call.path)?.[2], ...call.body }))
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const puts = () => ado.calls.filter(isPutReviewer).map(call => ({ prId: prOf(call), reviewer: REVIEWER.exec(call.path)?.[2], body: call.body }))
  return { ado, http, puts }
}

test('adding an existing reviewer never resets their vote', async () => {
  const { http, puts } = reviewersSetup()
  const results = await reviewersDestination(http).send(context(), { kind: 'reviewers', people: [GRACE, NIA] })
  assert.deepEqual(
    puts().sort((a, b) => a.prId - b.prId),
    [
      { prId: 4101, reviewer: NIA.id, body: { vote: 0, isRequired: true } },
      { prId: 4102, reviewer: NIA.id, body: { vote: 0, isRequired: true } }
    ]
  )
  assert.ok(puts().every(put => put.reviewer !== GRACE.id), "Grace's approval was overwritten")
  assert.deepEqual(results, [
    {
      destination: 'reviewers',
      ok: true,
      text: 'Added Nia Okafor to 2 pull requests. Grace Hopper is already on Pull Request 4101. Grace Hopper is already on Pull Request 4102.'
    }
  ])
})

test('a reviewer refusal on one pull request is reported per person and the others still get added', async () => {
  const { ado, http, puts } = reviewersSetup()
  ado.on(call => isPutReviewer(call) && prOf(call) === 4102, () => json(403, { message: NO_PERMISSION }))
  const results = await reviewersDestination(http).send(context({ prs: [key(4101), key(4102), key(4103)] }), { kind: 'reviewers', people: [NIA, OMAR] })
  assert.deepEqual(puts().map(put => put.prId).sort(), [4101, 4101, 4102, 4102, 4103, 4103])
  assert.deepEqual(results, [
    {
      destination: 'reviewers',
      ok: false,
      text: [
        'Added Nia Okafor, Omar Haddad to 2 pull requests.',
        `Couldn't add Nia Okafor to Pull Request 4102: ${NO_PERMISSION}`,
        `Couldn't add Omar Haddad to Pull Request 4102: ${NO_PERMISSION}`
      ].join(' ')
    }
  ])
})

test('the added note counts each person by the pull requests they were added to', async () => {
  const { ado, http, puts } = reviewersSetup()
  const reviewers = fixture<{ value: unknown[] }>('pull-request-reviewers')
  ado.on(call => isListReviewers(call) && prOf(call) === 4102, () => json(200, { value: [...reviewers.value, { id: NIA.id, displayName: NIA.displayName, vote: 5 }] }))
  const results = await reviewersDestination(http).send(context(), { kind: 'reviewers', people: [NIA, OMAR] })
  assert.deepEqual(
    puts()
      .sort((a, b) => a.prId - b.prId)
      .map(put => [put.prId, put.reviewer]),
    [
      [4101, NIA.id],
      [4101, OMAR.id],
      [4102, OMAR.id]
    ]
  )
  assert.deepEqual(results, [
    {
      destination: 'reviewers',
      ok: true,
      text: 'Added Nia Okafor to 1 pull request. Added Omar Haddad to 2 pull requests. Nia Okafor is already on Pull Request 4102.'
    }
  ])
})

test('each person is added once, and adding nobody is refused', async () => {
  const { ado, http, puts } = reviewersSetup()
  const once = await reviewersDestination(http).send(context({ prs: [key(4101)] }), { kind: 'reviewers', people: [NIA, { ...NIA, id: NIA.id.toUpperCase() }] })
  assert.deepEqual(puts(), [{ prId: 4101, reviewer: NIA.id, body: { vote: 0, isRequired: true } }])
  assert.deepEqual(once, [{ destination: 'reviewers', ok: true, text: 'Added Nia Okafor to 1 pull request.' }])

  const calls = ado.calls.length
  const nobody = await reviewersDestination(http).send(context(), { kind: 'reviewers', people: [] })
  assert.deepEqual(nobody, [{ destination: 'reviewers', ok: false, text: 'Choose people to add as reviewers.' }])
  const nothing = await reviewersDestination(http).send(context({ prs: [] }), { kind: 'reviewers', people: [NIA] })
  assert.deepEqual(nothing, [{ destination: 'reviewers', ok: false, text: 'There are no pull requests to add reviewers to.' }])
  assert.equal(ado.calls.length, calls)
})

function clipboardThat(answer: () => Promise<'rich' | 'html'>): { writes: { html: string; plain: string }[]; clipboard: Clipboard } {
  const writes: { html: string; plain: string }[] = []
  return {
    writes,
    clipboard: {
      write: async content => {
        writes.push(content)
        return answer()
      }
    }
  }
}

test('copy writes HTML and plain text and says how it copied', async () => {
  const rich = clipboardThat(async () => 'rich')
  assert.deepEqual(await copyDestination(rich.clipboard).send(context(), { kind: 'copy' }), [{ destination: 'copy', ok: true, text: 'Copied as rich text.' }])
  assert.deepEqual(rich.writes, [{ html: toHtml(MESSAGE), plain: PLAIN }])

  const htmlOnly = clipboardThat(async () => 'html')
  assert.deepEqual(await copyDestination(htmlOnly.clipboard).send(context(), { kind: 'copy' }), [
    { destination: 'copy', ok: true, text: 'Copied as rich text (HTML only).' }
  ])
})

test('a failed copy returns the plain text to copy by hand', async () => {
  assert.equal(toPlain(MESSAGE), PLAIN)
  for (const message of ["Couldn't copy to the clipboard.", 'Copying needs wl-clipboard or xclip.']) {
    const { clipboard } = clipboardThat(async () => {
      throw new Error(message)
    })
    assert.deepEqual(await copyDestination(clipboard).send(context(), { kind: 'copy' }), [{ destination: 'copy', ok: false, text: message, plain: PLAIN }])
  }
})

function channelSetup(seed: Record<string, unknown> = {}, secretSeed: Record<string, string> = {}) {
  const { store } = memoryStore(seed)
  const secretData: Record<string, string> = { ...secretSeed }
  const logs: string[] = []
  const secrets: SecretsPort = {
    get: async key => secretData[key] ?? null,
    set: async (key, value) => {
      secretData[key] = value
    },
    delete: async key => {
      delete secretData[key]
    }
  }
  const channels = createChannelStore({ store, secrets, newId: () => 'channel-1', now: () => T0, log: message => logs.push(message) })
  const posted: { url: string; body: unknown }[] = []
  const answer = { status: 202 }
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: answer.status })
  }) as typeof fetch
  return { channels, posted, answer, logs, destination: channelDestination(channels, fetchFn) }
}

test('a channel post carries the card and the sharer and says sent (accepted)', async () => {
  const { channels, posted, destination } = channelSetup()
  const added = await channels.add('Release train', WEBHOOK)
  assert.deepEqual(await destination.send(context(), { kind: 'channel', id: added.id }), [
    { destination: 'channel:channel-1', ok: true, text: 'Sent to Release train (accepted).' }
  ])
  assert.deepEqual(posted, [{ url: WEBHOOK, body: webhookPayload(adaptiveCard(MESSAGE, 'Shared by Alex Contoso from Orca')) }])
})

test('a channel with a missing secret says to replace it', async () => {
  const { posted, answer, destination, channels } = channelSetup({
    'share:channels': [{ id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0 }]
  })
  assert.deepEqual(await destination.send(context(), { kind: 'channel', id: 'channel-1' }), [
    { destination: 'channel:channel-1', ok: false, text: "This channel's webhook URL is missing. Replace it." }
  ])
  assert.deepEqual(await destination.send(context(), { kind: 'channel', id: 'channel-9' }), [
    { destination: 'channel:channel-9', ok: false, text: 'That channel no longer exists.' }
  ])
  assert.deepEqual(posted, [])

  await channels.replace('channel-1', WEBHOOK)
  answer.status = 404
  assert.deepEqual(await destination.send(context(), { kind: 'channel', id: 'channel-1' }), [
    { destination: 'channel:channel-1', ok: false, text: "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL." }
  ])
  const huge: ShareMessage = { intro: 'x'.repeat(30_000), lines: [] }
  assert.deepEqual(await destination.send(context({ message: huge }), { kind: 'channel', id: 'channel-1' }), [
    { destination: 'channel:channel-1', ok: false, text: 'Too much to post at once. Share fewer items.' }
  ])
  assert.equal(posted.length, 1)
})

test('a stored URL that is not https is never posted', async () => {
  const stored = [
    WEBHOOK.replace('https:', 'http:'),
    WEBHOOK.replace('https://', 'https://ada:hunter2@'),
    `javascript:fetch('${WEBHOOK}')`,
    'not a url'
  ]
  for (const url of stored) {
    const { posted, logs, destination } = channelSetup(
      { 'share:channels': [{ id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0 }] },
      { 'teams-webhook:channel-1': url }
    )
    const results = await destination.send(context(), { kind: 'channel', id: 'channel-1' })
    assert.deepEqual(results, [{ destination: 'channel:channel-1', ok: false, text: "That isn't a valid https webhook URL." }], url)
    assert.deepEqual(posted, [], url)
    assert.ok(!JSON.stringify([results, logs]).includes(SIG), url)
  }
})
