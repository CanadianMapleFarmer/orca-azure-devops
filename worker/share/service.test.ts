import { assert, test } from 'orca/testing'
import type { AutoCompleteOptions, PrKey } from '../../src/shared/prs'
import { APPROVAL_4520, APPROVAL_ID, RUN_4520, RUN_URL } from '../../src/shared/share/approval-fixtures'
import { APPROVAL_TEMPLATE, approvalItemKey } from '../../src/shared/share/approval-items'
import { toHtml } from '../../src/shared/share/message'
import { prItemKey } from '../../src/shared/share/pr-items'
import { PR_TEMPLATE } from '../../src/shared/share/template'
import type { Person, ShareDestination, ShareMessage } from '../../src/shared/share/types'
import type { Identity, OrgStatus } from '../../src/shared/types'
import { AdoError, createAdoHttp } from '../ado/http'
import type { SecretsPort } from '../auth/pat'
import type { StorePort } from '../connections'
import { fixture, json, ORG, ORG_URL, PROJECT, REPO, type AdoCall } from '../boards/fake-ado'
import { createEntities } from '../data/entities'
import { createPersisted } from '../data/persist'
import { createSavedTables } from '../data/saved-tables'
import { createScheduler } from '../poll/scheduler'
import { fakePrs, isOnePr, isPrWorkItems, ME, NO_PR_NOTIFICATIONS } from '../prs/fake-prs'
import { approvalShareSource } from '../pipelines/share-source'
import { createPrsService } from '../prs/service'
import { prShareSource } from '../prs/share-source'
import type { Clipboard } from '../sys/clipboard'
import { fakeClock, memoryCache, memoryStore } from '../test-support'
import { adaptiveCard, webhookPayload } from './card'
import { createChannelStore } from './channels'
import { channelDestination, copyDestination, reviewersDestination, type DestinationContext, type WorkerDestination } from './destinations'
import { createShareService } from './service'

const T0 = Date.parse('2026-11-05T09:00:00Z')
const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
const API_REPO = '8e9f0a1b-3333-4d6e-9f7a-4b5c6d7e8f90'
const SIG = 'wQ3vN8sXkP2mR7tY1uZ4aB6cD9eF0gH5iJ'
const WEBHOOK = `https://default0f0e0d0c.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const PR_4101 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101'
const PR_4104 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/api/pullrequest/4104'
const AUTO: AutoCompleteOptions = { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false }
const NOT_CONNECTED = 'Connect this organization first.'
const NO_PERMISSION = 'TF401027: You need the PullRequestContribute permission.'
const FOOTER = 'Shared by Alex Contoso from Orca'
const COPIED_RESULT = { destination: 'copy', ok: true, text: 'Copied as rich text.' }

const PR_A: PrKey = { projectId: PROJECT, repoId: REPO, prId: 4101 }
const PR_B: PrKey = { projectId: PROJECT, repoId: API_REPO, prId: 4104 }
const KEY_A = prItemKey(PR_A)
const KEY_B = prItemKey(PR_B)

const MESSAGE: ShareMessage = {
  intro: 'Ready for QA.',
  lines: [
    [{ text: 'Pull Request 4101', href: PR_4101 }, { text: ': Add vehicle search filters' }],
    [{ text: 'Pull Request 4104', href: PR_4104 }, { text: ': Fix pagination offset' }]
  ]
}
const PLAIN = `Ready for QA.\n\nPull Request 4101: Add vehicle search filters ${PR_4101}\nPull Request 4104: Fix pagination offset ${PR_4104}`

const GRACE: Identity = { id: 'a1b2c3d4-5555-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example', kind: 'user' }
const DENNIS: Identity = { id: 'b2c3d4e5-5555-4b7c-9d8e-0f1a2b3c4d5e', displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example', kind: 'user' }
const WEB_TEAM: Identity = { id: 'c3d4e5f6-5555-4c8d-8e9f-1a2b3c4d5e6f', displayName: 'Fabrikam Web Team', uniqueName: '[Fabrikam Web]\\Fabrikam Web Team', kind: 'group' }
const NIA: Person = { id: 'e5f6a7b8-5555-4eaf-9fb1-3c4d5e6f7081', displayName: 'Nia Okafor', uniqueName: 'nia@contoso.example', kind: 'user', required: true }

const REVIEWER = /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/reviewers\/([^/]+)$/
const isPutReviewer = (call: AdoCall) => call.method === 'PUT' && REVIEWER.test(call.path)
const isSubjectQuery = (call: AdoCall) => call.method === 'POST' && call.path === `/${ORG}/_apis/graph/subjectquery`
const isIdentities = (call: AdoCall) => call.method === 'GET' && call.path === `/${ORG}/_apis/identities`

function status(org: string, tenantId: string | null): OrgStatus {
  return {
    org,
    url: `https://dev.azure.com/${org}`,
    method: 'pat',
    state: 'connected',
    account: { adoId: ME, uniqueName: 'alex@contoso.com', displayName: 'Alex Contoso', tenantId, objectId: null },
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

interface RealDestinations {
  copy: WorkerDestination
  channel: WorkerDestination
  reviewers: WorkerDestination
}

function harness(pick: (real: RealDestinations) => WorkerDestination[] = real => [real.copy, real.channel, real.reviewers], seed: Record<string, unknown> = {}) {
  const ado = fakePrs()
  ado.on(isPutReviewer, call => json(200, { id: REVIEWER.exec(call.path)?.[2], ...call.body }))
  ado.on(isSubjectQuery, call => {
    const wantsGroups = (call.body.subjectKind as string[]).includes('Group')
    const subjects = fixture<{ value: { subjectKind: string }[] }>('subject-query').value
    return json(200, { value: subjects.filter(subject => wantsGroups || subject.subjectKind === 'user') })
  })
  ado.on(isIdentities, call => {
    const wanted = new Set((call.query.get('subjectDescriptors') ?? '').split(','))
    return json(200, { value: fixture<{ value: { subjectDescriptor: string }[] }>('identities').value.filter(identity => wanted.has(identity.subjectDescriptor)) })
  })
  const http = createAdoHttp({ fetch: ado.fetch, authHeader: async () => 'Bearer test-credential', sleep: async () => {} })
  const memory = memoryStore(seed)
  const storage = memory.data
  const failing = { prefs: false }
  const store: StorePort = {
    get: memory.store.get,
    set: async (key, value) => {
      if (failing.prefs && key.startsWith('share:prefs:')) throw new Error(`storage refused ${JSON.stringify(value)}`)
      await memory.store.set(key, value)
    }
  }
  const logs: string[] = []
  const log = (message: string) => void logs.push(message)
  const secretData: Record<string, string> = {}
  const secrets: SecretsPort = {
    get: async key => secretData[key] ?? null,
    set: async (key, value) => {
      secretData[key] = value
    },
    delete: async key => {
      delete secretData[key]
    }
  }
  let next = 0
  const channels = createChannelStore({ store, secrets, newId: () => `channel-${++next}`, now: () => T0, log })
  const posted: { url: string; body: any }[] = []
  const answer = { status: 202 }
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: answer.status })
  }) as typeof fetch
  const copies: { html: string; plain: string }[] = []
  const clipboard: Clipboard = {
    write: async content => {
      copies.push(content)
      return 'rich'
    }
  }
  const clock = fakeClock(T0)
  const orgs = [status(ORG, TENANT), status('fabrikam', null)]
  const entities = createEntities(clock.now)
  const persisted = createPersisted({ port: memoryCache().port, orgs: async () => [], now: clock.now, clock, log: () => {} })
  const prs = createPrsService({
    http,
    orgs: async () => structuredClone(orgs),
    scheduler: createScheduler(clock),
    autoComplete: () => AUTO,
    post: () => {},
    counts: () => {},
    now: clock.now,
    entities,
    persisted,
    savedTables: createSavedTables(entities, persisted),
    ...NO_PR_NOTIFICATIONS
  })
  const template = { value: PR_TEMPLATE }
  const approvalTemplate = { value: APPROVAL_TEMPLATE }
  const approvalReads: { org: string; key: { projectId: string; approvalId: string } }[] = []
  const pipelines = {
    approval: async (org: string, key: { projectId: string; approvalId: string }) => {
      approvalReads.push({ org, key })
      return key.approvalId === APPROVAL_ID ? { run: RUN_4520, approval: APPROVAL_4520 } : null
    }
  }
  const share = createShareService({
    http,
    store,
    channels,
    fetch: fetchFn,
    orgs: async () => structuredClone(orgs),
    sources: {
      pr: prShareSource(http, prs, { shareTemplate: () => template.value }),
      approval: approvalShareSource(pipelines, { approvalTemplate: () => approvalTemplate.value })
    },
    destinations: pick({ copy: copyDestination(clipboard), channel: channelDestination(channels, fetchFn), reviewers: reviewersDestination(http) }),
    log
  })
  const puts = () =>
    ado.calls
      .filter(isPutReviewer)
      .map(call => ({ prId: Number(REVIEWER.exec(call.path)?.[1]), reviewer: REVIEWER.exec(call.path)?.[2], body: call.body }))
      .sort((a, b) => a.prId - b.prId)
  return { ado, storage, failing, logs, channels, posted, answer, copies, prs, template, approvalTemplate, approvalReads, share, puts }
}

function recording(kind: ShareDestination['kind'], seen: { ctx: DestinationContext; destination: ShareDestination }[]): WorkerDestination {
  return {
    kind,
    async send(ctx, destination) {
      seen.push({ ctx, destination })
      return [{ destination: kind, ok: true, text: `${kind} done` }]
    }
  }
}

function exploding(kind: ShareDestination['kind']): WorkerDestination {
  return {
    kind,
    async send() {
      throw new Error(`the ${kind} destination blew up`)
    }
  }
}

const notConnected = (error: unknown) => error instanceof AdoError && error.message === NOT_CONNECTED
const failsWith = (message: string) => (error: unknown) => error instanceof Error && error.message === message

test('send copies, posts and adds reviewers, one result per destination', async () => {
  const h = harness()
  const channel = await h.channels.add('Release train', WEBHOOK)
  const { results } = await h.share.send({
    org: ORG,
    kind: 'pr',
    keys: [KEY_A, KEY_B],
    intro: '  Ready for QA.\n',
    destinations: [
      { kind: 'copy' },
      { kind: 'channel', id: channel.id },
      { kind: 'chat', people: [GRACE] },
      { kind: 'reviewers', people: [NIA] },
      { kind: 'channel', id: channel.id }
    ]
  })
  assert.deepEqual(results, [
    { destination: 'copy', ok: true, text: 'Copied as rich text.' },
    { destination: 'channel:channel-1', ok: true, text: 'Sent to Release train (accepted).' },
    { destination: 'reviewers', ok: true, text: 'Added Nia Okafor to 2 pull requests.' }
  ])
  assert.deepEqual(h.copies, [{ html: toHtml(MESSAGE), plain: PLAIN }])
  assert.deepEqual(h.posted, [{ url: WEBHOOK, body: webhookPayload(adaptiveCard(MESSAGE, FOOTER)) }])
  assert.deepEqual(h.puts(), [
    { prId: 4101, reviewer: NIA.id, body: { vote: 0, isRequired: true } },
    { prId: 4104, reviewer: NIA.id, body: { vote: 0, isRequired: true } }
  ])
})

test("a destination failure doesn't stop the others", async () => {
  const real = harness()
  const channel = await real.channels.add('Release train', WEBHOOK)
  real.answer.status = 404
  real.ado.on(isPutReviewer, () => json(403, { message: NO_PERMISSION }))
  const failed = await real.share.send({
    org: ORG,
    kind: 'pr',
    keys: [KEY_A],
    intro: '',
    destinations: [{ kind: 'channel', id: channel.id }, { kind: 'reviewers', people: [NIA] }, { kind: 'copy' }]
  })
  assert.deepEqual(failed.results, [
    { destination: 'channel:channel-1', ok: false, text: "Teams didn't accept the post (HTTP 404). If the workflow changed, replace its URL." },
    { destination: 'reviewers', ok: false, text: `Couldn't add Nia Okafor to Pull Request 4101: ${NO_PERMISSION}` },
    { destination: 'copy', ok: true, text: 'Copied as rich text.' }
  ])

  const stubbed = harness(destinations => [exploding('channel'), exploding('reviewers'), destinations.copy])
  const { results } = await stubbed.share.send({
    org: ORG,
    kind: 'pr',
    keys: [KEY_A],
    intro: '',
    destinations: [{ kind: 'channel', id: 'channel-7' }, { kind: 'copy' }, { kind: 'reviewers', people: [NIA] }]
  })
  assert.deepEqual(results, [
    { destination: 'channel:channel-7', ok: false, text: 'the channel destination blew up' },
    { destination: 'copy', ok: true, text: 'Copied as rich text.' },
    { destination: 'reviewers', ok: false, text: 'the reviewers destination blew up' }
  ])
})

test('items come from the PR source by key', async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const h = harness(() => [recording('copy', seen)])
  const send = (keys: string[]) => h.share.send({ org: ORG, kind: 'pr', keys, intro: '', destinations: [{ kind: 'copy' }] })

  await send([KEY_B, 'pr:not-a-key', KEY_A, KEY_B, '<b>Pull Request 1</b>'])
  assert.deepEqual(seen[0].ctx.message.lines, [MESSAGE.lines[1], MESSAGE.lines[0]])
  assert.deepEqual(seen[0].ctx.prs, [PR_B, PR_A])
  assert.deepEqual(h.ado.calls.filter(isOnePr).map(call => call.path.split('/').pop()), ['4104', '4101'], 'each pull request is read once, fresh')

  await h.prs.snapshot(ORG)
  const reads = h.ado.count(isOnePr)
  await send([KEY_A])
  assert.deepEqual(seen[1].ctx.message.lines, [MESSAGE.lines[0]])
  assert.equal(h.ado.count(isOnePr), reads, 'a loaded pull request comes from the cache')

  await assert.rejects(send(['pr:not-a-key']), (error: unknown) => error instanceof Error && error.message === 'Choose at least one item to share.')
  assert.equal(seen.length, 2)
})

test('send remembers destinations and people per org', async () => {
  const h = harness()
  const kept = await h.channels.add('Release train', WEBHOOK)
  const remembered: ShareDestination[] = [
    { kind: 'channel', id: kept.id },
    { kind: 'chat', people: [GRACE] },
    { kind: 'reviewers', people: [NIA] }
  ]
  await h.share.send({
    org: ORG,
    kind: 'pr',
    keys: [KEY_A],
    intro: '',
    destinations: [
      { kind: 'channel', id: kept.id },
      { kind: 'channel', id: 'channel-gone' },
      { kind: 'chat', people: [{ ...GRACE, vote: 10, url: WEBHOOK } as Identity] },
      { kind: 'reviewers', people: [NIA] }
    ]
  })
  assert.deepEqual(h.storage['share:prefs:contoso'], { destinations: remembered })
  assert.deepEqual((await h.share.prefs(ORG, 'pr')).prefs, { destinations: remembered })
  assert.deepEqual((await h.share.prefs('fabrikam', 'pr')).prefs, { destinations: [{ kind: 'copy' }] })
  assert.ok(!JSON.stringify(h.storage).includes(SIG), 'the webhook URL leaked into storage')

  await h.channels.remove(kept.id)
  assert.deepEqual((await h.share.prefs(ORG, 'pr')).prefs, { destinations: remembered.slice(1) })
})

test('prefs reports a template warning and the tenant', async () => {
  const h = harness()
  const channel = await h.channels.add('Release train', WEBHOOK)
  h.template.value = '[Pull Request {id}]({url}): {title} by {owner}'
  assert.deepEqual(await h.share.prefs(ORG, 'pr'), {
    template: '[Pull Request {id}]({url}): {title} by {owner}',
    warning: 'Unknown placeholder {owner} in the share template.',
    channels: [channel],
    prefs: { destinations: [{ kind: 'copy' }] },
    tenantId: TENANT
  })
  await h.share.send({ org: ORG, kind: 'pr', keys: [KEY_A, KEY_B], intro: 'Ready for QA.', destinations: [{ kind: 'copy' }] })
  assert.equal(h.copies[0].plain, PLAIN, 'an invalid template falls back to the default line')

  h.template.value = '{title}: {url}'
  assert.deepEqual(await h.share.prefs('fabrikam', 'pr'), {
    template: '{title}: {url}',
    channels: [channel],
    prefs: { destinations: [{ kind: 'copy' }] },
    tenantId: null
  })
  await assert.rejects(h.share.prefs('northwind', 'pr'), notConnected)
})

test('destinations dispatch by kind', async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const h = harness(() => [recording('reviewers', seen), recording('copy', seen)])
  const { results } = await h.share.send({
    org: ORG,
    kind: 'pr',
    keys: [KEY_A, KEY_B],
    intro: 'Ready for QA.',
    destinations: [
      { kind: 'copy' },
      { kind: 'chat', people: [GRACE] },
      { kind: 'channel', id: 'channel-1' },
      { kind: 'reviewers', people: [NIA] },
      { kind: 'copy' },
      { kind: 'reviewers', people: [] }
    ]
  })
  assert.deepEqual(results, [
    { destination: 'copy', ok: true, text: 'copy done' },
    { destination: 'reviewers', ok: true, text: 'reviewers done' }
  ])
  const ctx: DestinationContext = { org: ORG, message: MESSAGE, prs: [PR_A, PR_B], sharedBy: 'Alex Contoso' }
  assert.deepEqual(seen, [
    { ctx, destination: { kind: 'copy' } },
    { ctx, destination: { kind: 'reviewers', people: [NIA] } }
  ])
})

test("send refuses an org that isn't connected and remembers nothing", async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const h = harness(() => [recording('copy', seen)])
  await assert.rejects(h.share.send({ org: 'northwind', kind: 'pr', keys: [KEY_A], intro: '', destinations: [{ kind: 'copy' }] }), notConnected)
  assert.deepEqual(seen, [])
  assert.deepEqual(h.storage, {})
  assert.equal(h.ado.calls.length, 0)
})

test('people proxies searchIdentities', async () => {
  const h = harness()
  assert.deepEqual(await h.share.people({ org: ORG, query: ' ho ', groups: false }), [GRACE, DENNIS])
  assert.deepEqual(await h.share.people({ org: ORG, query: 'fab', groups: true }), [GRACE, DENNIS, WEB_TEAM])
  assert.deepEqual(h.ado.calls.filter(isSubjectQuery).map(call => call.body), [
    { query: 'ho', subjectKind: ['User'] },
    { query: 'fab', subjectKind: ['User', 'Group'] }
  ])
  assert.deepEqual(await h.share.people({ org: ORG, query: 'a', groups: true }), [])
})

test('test posts the test card and says sent (accepted)', async () => {
  const h = harness()
  const channel = await h.channels.add('Release train', WEBHOOK)
  assert.deepEqual(await h.share.test(channel.id), {
    destination: 'channel:channel-1',
    ok: true,
    text: "Sent (accepted). Teams doesn't confirm delivery; check the channel."
  })
  assert.equal(h.posted.length, 1)
  assert.equal(h.posted[0].url, WEBHOOK)
  assert.deepEqual(h.posted[0].body.attachments[0].content.body, [
    { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: 'Azure DevOps for Orca can post to this channel.' }] }
  ])

  h.answer.status = 429
  assert.deepEqual(await h.share.test(channel.id), { destination: 'channel:channel-1', ok: false, text: 'Teams is throttling posts. Try again in a minute.' })
  assert.deepEqual(await h.share.test('channel-9'), { destination: 'channel:channel-9', ok: false, text: 'That channel no longer exists.' })
  assert.equal(h.posted.length, 2)
  assert.equal(h.share.channels, h.channels)
})

test('a failed prefs write is logged and never fails the send', async () => {
  const h = harness()
  const channel = await h.channels.add('Release train', WEBHOOK)
  h.failing.prefs = true
  const { results } = await h.share.send({ org: ORG, kind: 'pr', keys: [KEY_A], intro: '', destinations: [{ kind: 'channel', id: channel.id }] })
  assert.deepEqual(results, [{ destination: 'channel:channel-1', ok: true, text: 'Sent to Release train (accepted).' }])
  assert.deepEqual(h.logs, ["Couldn't save the share choices."])
  assert.equal(h.storage['share:prefs:contoso'], undefined)
})

test('uncached pull requests are read without their work items', async () => {
  const h = harness()
  h.ado.on(isPrWorkItems, () => json(500, { message: 'TF400733: the work item service is unavailable.' }))
  const { results } = await h.share.send({ org: ORG, kind: 'pr', keys: [KEY_A, KEY_B], intro: 'Ready for QA.', destinations: [{ kind: 'copy' }] })
  assert.deepEqual(results, [{ destination: 'copy', ok: true, text: 'Copied as rich text.' }])
  assert.equal(h.copies[0].plain, PLAIN)
  assert.equal(h.ado.count(isOnePr), 2)
  assert.equal(h.ado.count(isPrWorkItems), 0)
})

test('a send over 50 items or 20 people is refused before anything happens', async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const h = harness(() => [recording('copy', seen), recording('reviewers', seen)])
  const people = (count: number): Person[] => Array.from({ length: count }, (_, index) => ({ ...NIA, id: `person-${index}`, displayName: `Person ${index}` }))
  const many = Array.from({ length: 51 }, (_, index) => prItemKey({ ...PR_A, prId: 5000 + index }))
  const send = (keys: string[], destinations: ShareDestination[]) => h.share.send({ org: ORG, kind: 'pr', keys, intro: '', destinations })

  await assert.rejects(send(many, [{ kind: 'copy' }]), failsWith('Share up to 50 items at a time.'))
  await assert.rejects(send([KEY_A], [{ kind: 'copy' }, { kind: 'reviewers', people: people(21) }]), failsWith('Choose up to 20 people.'))
  await assert.rejects(send([KEY_A], [{ kind: 'copy' }, { kind: 'chat', people: people(21) }]), failsWith('Choose up to 20 people.'))
  assert.deepEqual([seen, h.storage, h.ado.calls.length], [[], {}, 0])

  const { results } = await send([KEY_A], [{ kind: 'chat', people: people(20) }, { kind: 'reviewers', people: people(20) }])
  assert.deepEqual(results, [{ destination: 'reviewers', ok: true, text: 'reviewers done' }])
  assert.equal((await h.share.prefs(ORG, 'pr')).prefs.destinations.length, 2)
})

test('corrupt stored prefs are dropped entry by entry, never thrown', async () => {
  const crowd = Array.from({ length: 25 }, (_, index) => ({ ...GRACE, id: `person-${index}` }))
  const h = harness(undefined, {
    'share:channels': [{ id: 'channel-1', name: 'Release train', service: 'teams', addedAt: T0 }],
    'share:prefs:contoso': {
      destinations: [
        null,
        'copy',
        42,
        { kind: 'chat' },
        { kind: 'chat', people: 'Grace Hopper' },
        { kind: 'reviewers', people: [null, { id: 7 }, { displayName: 'No id' }, { ...NIA, vote: 10 }] },
        { kind: 'channel' },
        { kind: 'channel', id: 'channel-1', url: WEBHOOK },
        { kind: 'email', people: [GRACE] },
        { kind: 'copy', extra: true },
        { kind: 'chat', people: crowd }
      ]
    },
    'share:prefs:fabrikam': { destinations: 'copy' }
  })
  assert.deepEqual((await h.share.prefs(ORG, 'pr')).prefs, {
    destinations: [
      { kind: 'reviewers', people: [NIA] },
      { kind: 'channel', id: 'channel-1' },
      { kind: 'email', people: [GRACE] },
      { kind: 'copy' },
      { kind: 'chat', people: crowd.slice(0, 20) }
    ]
  })
  assert.deepEqual((await h.share.prefs('fabrikam', 'pr')).prefs, { destinations: [{ kind: 'copy' }] })
})

const APPROVAL_KEY = approvalItemKey(APPROVAL_4520)
const APPROVAL_PLAIN = `Approval needed for production: web-app-cd 20261105.3 on main ${RUN_URL}`

test('send shares an approval from the approval source by key', async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const stubbed = harness(() => [recording('copy', seen)])
  const send = (keys: string[]) => stubbed.share.send({ org: ORG, kind: 'approval', keys, intro: '', destinations: [{ kind: 'copy' }] })

  await send([APPROVAL_KEY, 'approval:proj-web/gone-approval', 'not-a-key', APPROVAL_KEY, '<b>approval</b>'])
  assert.deepEqual(seen[0].ctx.message.lines, [
    [{ text: 'Approval needed for production: ' }, { text: 'web-app-cd 20261105.3', href: RUN_URL }, { text: ' on main' }]
  ])
  assert.deepEqual(seen[0].ctx.prs, [])
  assert.deepEqual(stubbed.approvalReads, [
    { org: ORG, key: { projectId: 'proj-web', approvalId: APPROVAL_ID } },
    { org: ORG, key: { projectId: 'proj-web', approvalId: 'gone-approval' } }
  ])
  assert.equal(stubbed.ado.calls.length, 0)
  await assert.rejects(send(['approval:proj-web/gone-approval']), failsWith('Choose at least one item to share.'))
  assert.equal(seen.length, 1)

  const real = harness()
  const { results } = await real.share.send({ org: ORG, kind: 'approval', keys: [APPROVAL_KEY], intro: 'Please approve.', destinations: [{ kind: 'copy' }] })
  assert.deepEqual(results, [COPIED_RESULT])
  assert.equal(real.copies[0].plain, `Please approve.\n\n${APPROVAL_PLAIN}`)
  assert.equal(real.copies[0].html, `<div>Please approve.</div><div>Approval needed for production: <a href="${RUN_URL}">web-app-cd 20261105.3</a> on main</div>`)
})

test('email destinations are remembered with their people and capped', async () => {
  const seen: { ctx: DestinationContext; destination: ShareDestination }[] = []
  const h = harness()
  const send = (destinations: ShareDestination[], from = h) => from.share.send({ org: ORG, kind: 'approval', keys: [APPROVAL_KEY], intro: '', destinations })
  const dennis = { ...DENNIS, vote: 10, url: WEBHOOK } as Identity

  const { results } = await send([{ kind: 'copy' }, { kind: 'email', people: [GRACE, WEB_TEAM, dennis] }, { kind: 'email', people: [DENNIS] }])
  assert.deepEqual(results, [COPIED_RESULT], 'the worker never sends an email')
  const remembered: ShareDestination[] = [{ kind: 'copy' }, { kind: 'email', people: [GRACE, DENNIS] }]
  assert.deepEqual(h.storage['share:prefs:contoso:approval'], { destinations: remembered })
  assert.equal(h.storage['share:prefs:contoso'], undefined)
  assert.deepEqual((await h.share.prefs(ORG, 'approval')).prefs, { destinations: remembered })
  assert.deepEqual((await h.share.prefs('fabrikam', 'approval')).prefs, { destinations: [{ kind: 'copy' }] })
  assert.ok(!JSON.stringify(h.storage).includes(SIG), 'the webhook URL leaked into storage')

  const people = (count: number): Identity[] => Array.from({ length: count }, (_, index) => ({ ...GRACE, id: `person-${index}`, displayName: `Person ${index}` }))
  const capped = harness(() => [recording('copy', seen)])
  await assert.rejects(send([{ kind: 'copy' }, { kind: 'email', people: people(21) }], capped), failsWith('Choose up to 20 people.'))
  assert.deepEqual([seen, capped.storage], [[], {}])
  await send([{ kind: 'email', people: people(20) }], capped)
  assert.equal((await capped.share.prefs(ORG, 'approval')).prefs.destinations.length, 1)
})

test('a PR share and an approval share each remember their own destinations and people', async () => {
  const h = harness()
  const prDestinations: ShareDestination[] = [{ kind: 'copy' }, { kind: 'chat', people: [GRACE] }, { kind: 'reviewers', people: [NIA] }]
  const approvalDestinations: ShareDestination[] = [{ kind: 'copy' }, { kind: 'email', people: [DENNIS] }]
  await h.share.send({ org: ORG, kind: 'pr', keys: [KEY_A], intro: '', destinations: prDestinations })
  await h.share.send({ org: ORG, kind: 'approval', keys: [APPROVAL_KEY], intro: '', destinations: approvalDestinations })

  assert.deepEqual((await h.share.prefs(ORG, 'pr')).prefs, { destinations: prDestinations })
  assert.deepEqual((await h.share.prefs(ORG, 'approval')).prefs, { destinations: approvalDestinations })
  assert.deepEqual(h.storage['share:prefs:contoso'], { destinations: prDestinations })
  assert.deepEqual(h.storage['share:prefs:contoso:approval'], { destinations: approvalDestinations })
  assert.deepEqual((await h.share.prefs('fabrikam', 'approval')).prefs, { destinations: [{ kind: 'copy' }] })
})

test('prefs for approvals use the approval template and report its warning', async () => {
  const h = harness()
  assert.deepEqual(await h.share.prefs(ORG, 'approval'), { template: APPROVAL_TEMPLATE, channels: [], prefs: { destinations: [{ kind: 'copy' }] }, tenantId: TENANT })

  h.approvalTemplate.value = 'Needs you: [{pipeline} {run}]({url}) {owner}'
  assert.deepEqual(await h.share.prefs(ORG, 'approval'), {
    template: 'Needs you: [{pipeline} {run}]({url}) {owner}',
    warning: 'Unknown placeholder {owner} in the share template.',
    channels: [],
    prefs: { destinations: [{ kind: 'copy' }] },
    tenantId: TENANT
  })
  await h.share.send({ org: ORG, kind: 'approval', keys: [APPROVAL_KEY], intro: '', destinations: [{ kind: 'copy' }] })
  assert.equal(h.copies[0].plain, APPROVAL_PLAIN, 'an invalid template falls back to the default line')

  h.approvalTemplate.value = '[]({url}) on {branch}'
  assert.equal((await h.share.prefs(ORG, 'approval')).warning, 'The link in the share template needs text, like [text]({url}).')
  h.approvalTemplate.value = '[Pull Request {id}]({url})'
  assert.equal((await h.share.prefs(ORG, 'approval')).warning, 'Unknown placeholder {id} in the share template.')
  assert.equal((await h.share.prefs(ORG, 'pr')).template, PR_TEMPLATE)
  assert.equal((await h.share.prefs(ORG, 'pr')).warning, undefined)
})
