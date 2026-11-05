import type { Channel } from '../../src/shared/share/types'
import type { SecretsPort } from '../auth/pat'
import type { StorePort } from '../connections'
import {
  CHANNEL_GONE,
  CHANNEL_LIMIT,
  CHANNEL_NAME_EMPTY,
  CHANNEL_NAME_TAKEN,
  CHANNEL_NAME_TOO_LONG,
  CHANNEL_SECRET_LEFT,
  SECRETS_UNAVAILABLE,
  WEBHOOK_URL_EMPTY,
  WEBHOOK_URL_INVALID
} from '../messages'

export interface ChannelStore {
  list(): Promise<Channel[]>
  add(name: string, url: string): Promise<Channel>
  replace(id: string, url: string): Promise<Channel>
  remove(id: string): Promise<void>
  url(id: string): Promise<string | null>
}

export interface ChannelStoreDeps {
  store: StorePort
  secrets: SecretsPort
  newId: () => string
  now: () => number
  log: (message: string) => void
}

const CHANNELS_KEY = 'share:channels'
const MAX_CHANNELS = 20
const MAX_URL_LENGTH = 4096
const MAX_NAME_LENGTH = 100

export function checkWebhookUrl(input: string): string {
  const text = input.trim()
  if (text === '') throw new Error(WEBHOOK_URL_EMPTY)
  const url = text.length > MAX_URL_LENGTH ? null : URL.parse(text)
  if (!url || url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error(WEBHOOK_URL_INVALID)
  return text
}

export function createChannelStore({ store, secrets, newId, now, log }: ChannelStoreDeps): ChannelStore {
  let queue: Promise<unknown> = Promise.resolve()

  function serially<T>(change: () => Promise<T>): Promise<T> {
    const run = queue.then(change)
    queue = run.catch(() => {})
    return run
  }

  async function list(): Promise<Channel[]> {
    const stored = await store.get<unknown>(CHANNELS_KEY)
    return Array.isArray(stored) ? stored.flatMap(channelOf) : []
  }

  async function saveSecret(id: string, url: string): Promise<void> {
    try {
      await secrets.set(secretKey(id), url)
    } catch {
      throw new Error(SECRETS_UNAVAILABLE)
    }
  }

  return {
    list,

    add: (name, url) =>
      serially(async () => {
        const label = name.trim()
        if (label === '') throw new Error(CHANNEL_NAME_EMPTY)
        if (label.length > MAX_NAME_LENGTH) throw new Error(CHANNEL_NAME_TOO_LONG)
        const checked = checkWebhookUrl(url)
        const channels = await list()
        if (channels.some(channel => channel.name.toLowerCase() === label.toLowerCase())) throw new Error(CHANNEL_NAME_TAKEN)
        if (channels.length >= MAX_CHANNELS) throw new Error(CHANNEL_LIMIT)
        const channel: Channel = { id: newId(), name: label, service: 'teams', addedAt: now() }
        await saveSecret(channel.id, checked)
        try {
          await store.set(CHANNELS_KEY, [...channels, channel])
        } catch (error) {
          await secrets.delete(secretKey(channel.id)).catch(() => log(CHANNEL_SECRET_LEFT))
          throw error
        }
        return channel
      }),

    replace: (id, url) =>
      serially(async () => {
        const checked = checkWebhookUrl(url)
        const channel = (await list()).find(item => item.id === id)
        if (!channel) throw new Error(CHANNEL_GONE)
        await saveSecret(id, checked)
        return channel
      }),

    remove: id =>
      serially(async () => {
        await secrets.delete(secretKey(id))
        await store.set(CHANNELS_KEY, (await list()).filter(channel => channel.id !== id))
      }),

    url: id => secrets.get(secretKey(id))
  }
}

function secretKey(id: string): string {
  return `teams-webhook:${id}`
}

function channelOf(value: unknown): Channel[] {
  if (typeof value !== 'object' || value === null) return []
  const { id, name, service, addedAt } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || service !== 'teams' || typeof addedAt !== 'number') return []
  return [{ id, name, service, addedAt }]
}
