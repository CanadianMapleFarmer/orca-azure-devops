import { messageOf } from '../../src/shared/messages'
import type { PrKey } from '../../src/shared/prs'
import { buildMessage, MAX_SHARE_ITEMS } from '../../src/shared/share/message'
import { parseTemplate } from '../../src/shared/share/template'
import type {
  Channel,
  Person,
  ShareDestination,
  ShareItem,
  ShareKind,
  SharePrefs,
  SharePrefsView,
  ShareRequest,
  ShareResult
} from '../../src/shared/share/types'
import type { Identity, OrgStatus, PinnedAccount } from '../../src/shared/types'
import { AdoError, type AdoHttp } from '../ado/http'
import { searchIdentities } from '../ado/identities'
import type { StorePort } from '../connections'
import {
  badRequest,
  CHANNEL_TEST_INTRO,
  CHANNEL_TEST_SENT,
  NOT_CONNECTED,
  NOTHING_TO_SHARE,
  SHARE_PREFS_NOT_SAVED,
  TOO_MANY_ITEMS,
  TOO_MANY_PEOPLE,
  UNKNOWN_SHARE_KIND
} from '../messages'
import { adaptiveCard } from './card'
import type { ChannelStore } from './channels'
import { destinationLabel, postToChannel, type DestinationContext, type WorkerDestination } from './destinations'

export interface ShareSource {
  kind: ShareKind
  template(): string
  fallback: string
  vars: readonly string[]
  items(org: string, keys: string[]): Promise<{ items: ShareItem[]; prs: PrKey[] }>
}

export interface ShareService {
  prefs(org: string, kind: ShareKind): Promise<SharePrefsView>
  send(request: ShareRequest): Promise<{ results: ShareResult[] }>
  people(input: { org: string; query: string; groups: boolean }): Promise<Identity[]>
  test(id: string): Promise<ShareResult>
  channels: ChannelStore
}

export interface ShareServiceDeps {
  http: AdoHttp
  store: StorePort
  channels: ChannelStore
  fetch: typeof fetch
  orgs: () => Promise<OrgStatus[]>
  sources: Record<ShareKind, ShareSource>
  destinations: WorkerDestination[]
  log: (message: string) => void
}

const DEFAULT_PREFS: SharePrefs = { destinations: [{ kind: 'copy' }] }
const MAX_PEOPLE = 20

export function createShareService(deps: ShareServiceDeps): ShareService {
  const { channels } = deps
  const registry = new Map(deps.destinations.map(destination => [destination.kind, destination]))

  async function accountOf(org: string): Promise<PinnedAccount> {
    const status = (await deps.orgs()).find(item => item.org === org)
    if (!status || status.state !== 'connected' || !status.account) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return status.account
  }

  function sourceOf(kind: ShareKind): ShareSource {
    if (!Object.hasOwn(deps.sources, kind)) throw badRequest(UNKNOWN_SHARE_KIND)
    return deps.sources[kind]
  }

  async function storedPrefs(org: string, known: Channel[]): Promise<SharePrefs> {
    const stored = await deps.store.get<unknown>(prefsKey(org))
    return isRecord(stored) && Array.isArray(stored.destinations) ? { destinations: rememberable(stored.destinations, known) } : DEFAULT_PREFS
  }

  async function remember(org: string, destinations: ShareDestination[]): Promise<void> {
    try {
      await deps.store.set(prefsKey(org), { destinations: rememberable(destinations, await channels.list()) })
    } catch {
      deps.log(SHARE_PREFS_NOT_SAVED)
    }
  }

  async function dispatch(destination: ShareDestination, ctx: DestinationContext): Promise<ShareResult[]> {
    const handler = registry.get(destination.kind)
    if (!handler) return []
    try {
      return await handler.send(ctx, destination)
    } catch (error) {
      return [{ destination: destinationLabel(destination), ok: false, text: messageOf(error) }]
    }
  }

  return {
    channels,

    async prefs(org, kind) {
      const account = await accountOf(org)
      const source = sourceOf(kind)
      const template = source.template()
      const parsed = parseTemplate(template, source.vars)
      const known = await channels.list()
      return {
        template,
        ...('error' in parsed ? { warning: parsed.error } : {}),
        channels: known,
        prefs: await storedPrefs(org, known),
        tenantId: account.tenantId
      }
    },

    async send(request) {
      const account = await accountOf(request.org)
      const source = sourceOf(request.kind)
      const keys = [...new Set(request.keys)]
      if (keys.length > MAX_SHARE_ITEMS) throw badRequest(TOO_MANY_ITEMS)
      const destinations = firstOfEach(request.destinations)
      if (destinations.some(destination => peopleOf(destination).length > MAX_PEOPLE)) throw badRequest(TOO_MANY_PEOPLE)
      const { items, prs } = await source.items(request.org, keys)
      if (items.length === 0) throw badRequest(NOTHING_TO_SHARE)
      const { message } = buildMessage({ template: source.template(), fallback: source.fallback, vars: source.vars, intro: request.intro, items })
      const ctx: DestinationContext = { org: request.org, message, prs, sharedBy: account.displayName }
      const results = (await Promise.all(destinations.map(destination => dispatch(destination, ctx)))).flat()
      await remember(request.org, destinations)
      return { results }
    },

    people({ org, query, groups }) {
      return searchIdentities(deps.http, org, query, groups)
    },

    async test(id) {
      const destination = destinationLabel({ kind: 'channel', id })
      try {
        await postToChannel(channels, deps.fetch, id, adaptiveCard({ intro: CHANNEL_TEST_INTRO, lines: [] }, ''))
        return { destination, ok: true, text: CHANNEL_TEST_SENT }
      } catch (error) {
        return { destination, ok: false, text: messageOf(error) }
      }
    }
  }
}

function prefsKey(org: string): string {
  return `share:prefs:${org}`
}

function peopleOf(destination: ShareDestination): unknown[] {
  return (destination.kind === 'chat' || destination.kind === 'reviewers') && Array.isArray(destination.people) ? destination.people : []
}

function firstOfEach(destinations: ShareDestination[]): ShareDestination[] {
  const byLabel = new Map<string, ShareDestination>()
  for (const destination of destinations) if (!byLabel.has(destinationLabel(destination))) byLabel.set(destinationLabel(destination), destination)
  return [...byLabel.values()]
}

function rememberable(destinations: unknown[], known: Channel[]): ShareDestination[] {
  return firstOfEach(destinations.flatMap(value => destinationOf(value, known)))
}

function destinationOf(value: unknown, known: Channel[]): ShareDestination[] {
  if (!isRecord(value)) return []
  const { kind, id, people } = value
  if (kind === 'copy') return [{ kind: 'copy' }]
  if (kind === 'channel') return typeof id === 'string' && known.some(channel => channel.id === id) ? [{ kind: 'channel', id }] : []
  if (!Array.isArray(people)) return []
  if (kind === 'chat') return [{ kind: 'chat', people: people.flatMap(identityOf).slice(0, MAX_PEOPLE) }]
  if (kind === 'reviewers') return [{ kind: 'reviewers', people: people.flatMap(personOf).slice(0, MAX_PEOPLE) }]
  return []
}

function identityOf(value: unknown): Identity[] {
  if (!isRecord(value)) return []
  const { id, displayName, uniqueName, kind } = value
  if (typeof id !== 'string' || typeof displayName !== 'string' || typeof uniqueName !== 'string') return []
  return [{ id, displayName, uniqueName, kind: kind === 'group' ? 'group' : 'user' }]
}

function personOf(value: unknown): Person[] {
  return identityOf(value).map(identity => ({ ...identity, required: isRecord(value) && value.required === true }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
