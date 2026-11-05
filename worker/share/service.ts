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
import { badRequest, CHANNEL_TEST_INTRO, CHANNEL_TEST_SENT, NOT_CONNECTED, NOTHING_TO_SHARE, UNKNOWN_SHARE_KIND } from '../messages'
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
}

const DEFAULT_PREFS: SharePrefs = { destinations: [{ kind: 'copy' }] }

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
    const stored = await deps.store.get<Partial<SharePrefs>>(prefsKey(org))
    return Array.isArray(stored?.destinations) ? { destinations: rememberable(stored.destinations, known) } : DEFAULT_PREFS
  }

  async function remember(org: string, destinations: ShareDestination[]): Promise<void> {
    const known = await channels.list()
    await deps.store.set(prefsKey(org), { destinations: rememberable(destinations, known) })
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
      const keys = [...new Set(request.keys)].slice(0, MAX_SHARE_ITEMS)
      const { items, prs } = await source.items(request.org, keys)
      if (items.length === 0) throw badRequest(NOTHING_TO_SHARE)
      const { message } = buildMessage({ template: source.template(), fallback: source.fallback, vars: source.vars, intro: request.intro, items })
      const ctx: DestinationContext = { org: request.org, message, prs, sharedBy: account.displayName }
      const destinations = firstOfEach(request.destinations)
      const results = (await Promise.all(destinations.map(destination => dispatch(destination, ctx)))).flat()
      await remember(request.org, destinations).catch(() => {})
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

function firstOfEach(destinations: ShareDestination[]): ShareDestination[] {
  const byLabel = new Map<string, ShareDestination>()
  for (const destination of destinations) if (!byLabel.has(destinationLabel(destination))) byLabel.set(destinationLabel(destination), destination)
  return [...byLabel.values()]
}

function rememberable(destinations: ShareDestination[], known: Channel[]): ShareDestination[] {
  return destinations.flatMap((destination): ShareDestination[] => {
    switch (destination.kind) {
      case 'copy':
        return [{ kind: 'copy' }]
      case 'channel':
        return known.some(channel => channel.id === destination.id) ? [{ kind: 'channel', id: destination.id }] : []
      case 'chat':
        return [{ kind: 'chat', people: destination.people.map(identityOf) }]
      case 'reviewers':
        return [{ kind: 'reviewers', people: destination.people.map(person => ({ ...identityOf(person), required: person.required === true })) }]
      default:
        return []
    }
  })
}

function identityOf({ id, displayName, uniqueName, kind }: Identity | Person): Identity {
  return { id, displayName, uniqueName, kind }
}
