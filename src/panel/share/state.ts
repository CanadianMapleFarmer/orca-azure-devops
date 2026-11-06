import { atom, plugin, read, set, update } from 'orca'
import { messageOf } from '../../shared/messages'
import { MAX_SHARE_ITEMS, MAX_SHARE_PEOPLE } from '../../shared/share/limits'
import { buildMessage } from '../../shared/share/message'
import type { Channel, Person, ShareDestination, ShareItem, ShareKind, ShareMessage, SharePrefsView, ShareResult } from '../../shared/share/types'
import type { Identity } from '../../shared/types'
import { activeOrg, currentOrg, orgs } from '../state'
import { forgetSearches } from './people-search'

export interface ComposerItem {
  key: string
  label: string
  item: ShareItem
  checked: boolean
}

export type ShareHost = 'prs' | 'pipelines'

export interface ComposerInput {
  org: string
  kind: ShareKind
  host: ShareHost
  title: string
  items: ComposerItem[]
  suggestions: Identity[]
  reviewers: boolean
  email: boolean
  subject: string
  fallback: string
  vars: readonly string[]
}

export interface Choices {
  copy: boolean
  channels: string[]
  chat: boolean
  chatPeople: Person[]
  email: boolean
  emailPeople: Person[]
  reviewers: boolean
  reviewerPeople: Person[]
}

export interface Plan {
  message: ShareMessage
  warning?: string
  keys: string[]
  destinations: ShareDestination[]
  tooMany: boolean
  ready: boolean
}

export type LinkKind = 'chat' | 'email'

export const LINK_KINDS: readonly LinkKind[] = ['chat', 'email']

export interface LinkResult {
  ok: boolean
  text: string
  reason?: string
  retry?: string
  waiting?: boolean
}

export type Links = Partial<Record<LinkKind, LinkResult>>

type ShareView = 'none' | 'composer' | 'channels'
type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; message: string }

const MAX_CHANNELS_SHOWN = 20
const NO_CHOICES: Choices = { copy: false, channels: [], chat: false, chatPeople: [], email: false, emailPeople: [], reviewers: false, reviewerPeople: [] }

const view = atom<ShareView>('none')
const viewHost = atom<ShareHost | null>(null)
const backTo = atom<'none' | 'composer'>('none')
export const composer = atom<ComposerInput | null>(null)
export const checked = atom<string[]>([])
export const intro = atom('')
export const prefs = atom<Load<SharePrefsView>>({ status: 'loading' })
export const choices = atom<Choices>(NO_CHOICES)
export const sent = atom<{ results: ShareResult[]; error?: string } | null>(null)
export const links = atom<Links>({})
export const linkOpening = atom(false)
export const chatHint = atom(false)
const chatHintShown = atom(false)
const channelList = atom<Channel[]>([])

let opened = 0

export const currentRun = (): number => opened

export function shareView(host: ShareHost): ShareView {
  if (read(viewHost) !== host) return 'none'
  const shown = read(view)
  if (shown !== 'composer') return shown
  return read(composer)?.org === currentOrg(read(orgs), read(activeOrg))?.org ? 'composer' : 'none'
}

export function syncShare(org: string | null): void {
  void Promise.resolve().then(() => {
    const open = read(composer)
    if (open && open.org !== org) closeComposer()
  })
}

export function openComposer(input: ComposerInput): void {
  opened += 1
  set(composer, input)
  set(checked, input.items.filter(item => item.checked).map(item => item.key))
  set(intro, '')
  set(choices, NO_CHOICES)
  set(sent, null)
  set(links, {})
  set(linkOpening, false)
  set(chatHint, false)
  forgetSearches()
  set(viewHost, input.host)
  set(view, 'composer')
  void loadPrefs(input, opened)
}

export function closeComposer(): void {
  opened += 1
  set(composer, null)
  forgetSearches()
  set(sent, null)
  set(links, {})
  if (read(view) === 'composer') set(view, 'none')
  set(backTo, 'none')
}

export function showChannels(host: ShareHost): void {
  const open = read(composer)
  if (open && open.host !== host) closeComposer()
  set(backTo, read(view) === 'composer' ? 'composer' : 'none')
  set(viewHost, host)
  set(view, 'channels')
}

export function leaveChannels(): void {
  set(view, read(backTo))
  set(backTo, 'none')
}

export const shownChannels = (): Channel[] => read(channelList).slice(0, MAX_CHANNELS_SHOWN)

export const setChannels = (list: Channel[]): void => set(channelList, list)

export const addToChannels = (channel: Channel): void => update(channelList, list => [...list, channel])

export function dropChannel(id: string): void {
  update(channelList, list => list.filter(channel => channel.id !== id))
  chooseChannel(id, false)
}

async function loadPrefs(input: ComposerInput, run: number): Promise<void> {
  set(prefs, { status: 'loading' })
  try {
    const value = await plugin.request('share.prefs', { org: input.org, kind: input.kind })
    if (run !== opened) return
    set(channelList, value.channels)
    set(choices, remembered(value, input))
    set(chatHint, !read(chatHintShown))
    set(chatHintShown, true)
    set(prefs, { status: 'ready', value })
  } catch (error) {
    if (run === opened) set(prefs, { status: 'failed', message: messageOf(error) })
  }
}

export function retryPrefs(): void {
  const input = read(composer)
  if (input) void loadPrefs(input, opened)
}

const identityOf = ({ id, displayName, uniqueName, kind }: Identity): Identity => ({ id, displayName, uniqueName, kind })

function remembered(stored: SharePrefsView, input: ComposerInput): Choices {
  const next: Choices = { ...NO_CHOICES }
  for (const destination of stored.prefs.destinations) {
    switch (destination.kind) {
      case 'copy':
        next.copy = true
        break
      case 'channel':
        if (stored.channels.some(channel => channel.id === destination.id)) next.channels = [...next.channels, destination.id]
        break
      case 'chat':
        next.chat = true
        next.chatPeople = destination.people.slice(0, MAX_SHARE_PEOPLE).map(person => ({ ...identityOf(person), required: false }))
        break
      case 'email':
        if (!input.email) break
        next.email = true
        next.emailPeople = destination.people.slice(0, MAX_SHARE_PEOPLE).map(person => ({ ...identityOf(person), required: false }))
        break
      case 'reviewers':
        if (!input.reviewers) break
        next.reviewers = true
        next.reviewerPeople = destination.people.slice(0, MAX_SHARE_PEOPLE).map(person => ({ ...identityOf(person), required: person.required }))
        break
      default:
        destination satisfies never
    }
  }
  return next
}

export const choose = (patch: Partial<Choices>): void => update(choices, current => ({ ...current, ...patch }))

const toggled = (list: string[], value: string, on: boolean): string[] => [...list.filter(other => other !== value), ...(on ? [value] : [])]

export const chooseChannel = (id: string, on: boolean): void => update(choices, current => ({ ...current, channels: toggled(current.channels, id, on) }))

export const checkItem = (key: string, on: boolean): void => update(checked, keys => toggled(keys, key, on))

export const setIntro = (text: string): void => set(intro, text)

function destinationsOf(input: ComposerInput, chosen: Choices): ShareDestination[] {
  return [
    ...(chosen.copy ? [{ kind: 'copy' as const }] : []),
    ...shownChannels()
      .filter(channel => chosen.channels.includes(channel.id))
      .map(channel => ({ kind: 'channel' as const, id: channel.id })),
    ...(chosen.chat ? [{ kind: 'chat' as const, people: chosen.chatPeople.map(identityOf) }] : []),
    ...(input.email && chosen.email ? [{ kind: 'email' as const, people: chosen.emailPeople.map(identityOf) }] : []),
    ...(input.reviewers && chosen.reviewers ? [{ kind: 'reviewers' as const, people: chosen.reviewerPeople }] : [])
  ]
}

const everyoneChosen = (destinations: ShareDestination[]): boolean =>
  destinations.every(destination => destination.kind === 'copy' || destination.kind === 'channel' || destination.people.length > 0)

export function sharePlan(): Plan | null {
  const input = read(composer)
  const loaded = read(prefs)
  if (!input || loaded.status !== 'ready') return null
  const keys = read(checked)
  const items = input.items.filter(item => keys.includes(item.key))
  const built = buildMessage({
    template: loaded.value.template,
    fallback: input.fallback,
    vars: input.vars,
    intro: read(intro),
    items: items.map(item => item.item)
  })
  const destinations = destinationsOf(input, read(choices))
  const tooMany = items.length > MAX_SHARE_ITEMS
  const ready = items.length > 0 && !tooMany && destinations.length > 0 && everyoneChosen(destinations)
  return { ...built, keys: items.map(item => item.key), destinations, tooMany, ready }
}
