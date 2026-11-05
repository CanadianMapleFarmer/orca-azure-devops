import { atom, plugin, read, set, shell, update } from 'orca'
import { messageOf, OPEN_LINK_UNAVAILABLE } from '../../shared/messages'
import { MAX_SHARE_PEOPLE } from '../../shared/share/limits'
import { buildMessage, MAX_SHARE_ITEMS, toPlain } from '../../shared/share/message'
import { teamsChatUrl } from '../../shared/share/teams'
import type { Channel, Person, ShareDestination, ShareItem, ShareKind, ShareMessage, SharePrefsView, ShareResult } from '../../shared/share/types'
import type { Identity } from '../../shared/types'
import { activeOrg, currentOrg, LONG_WAIT, orgs } from '../state'

export interface ComposerItem {
  key: string
  label: string
  item: ShareItem
  checked: boolean
}

export interface ComposerInput {
  org: string
  kind: ShareKind
  title: string
  items: ComposerItem[]
  suggestions: Identity[]
  reviewers: boolean
  fallback: string
  vars: readonly string[]
}

export interface Choices {
  copy: boolean
  channels: string[]
  chat: boolean
  chatPeople: Person[]
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

export interface ChatResult {
  ok: boolean
  text: string
  reason?: string
  retry?: string
}

export interface PeopleSearch {
  query: string
  status: 'idle' | 'searching' | 'ready' | 'failed'
  results: Identity[]
  message?: string
  id: number
}

type ShareView = 'none' | 'composer' | 'channels'
type ChatDestination = Extract<ShareDestination, { kind: 'chat' }>
type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; message: string }

const MAX_CHANNELS_SHOWN = 20
const NO_CHOICES: Choices = { copy: false, channels: [], chat: false, chatPeople: [], reviewers: false, reviewerPeople: [] }
const NO_SEARCH: PeopleSearch = { query: '', status: 'idle', results: [], id: 0 }
const CHAT_OPENED: ChatResult = { ok: true, text: 'Opened a Teams chat.' }
const CHAT_TOO_LONG: ChatResult = { ok: false, text: 'Too long for a Teams chat link. Use Copy instead.' }
const CHAT_NOT_OPENED = "Teams chat wasn't opened."

const view = atom<ShareView>('none')
const backTo = atom<'none' | 'composer'>('none')
export const composer = atom<ComposerInput | null>(null)
export const checked = atom<string[]>([])
export const intro = atom('')
export const prefs = atom<Load<SharePrefsView>>({ status: 'loading' })
export const choices = atom<Choices>(NO_CHOICES)
export const sending = atom(false)
export const sent = atom<{ results: ShareResult[]; error?: string } | null>(null)
export const chat = atom<ChatResult | null>(null)
export const chatOpening = atom(false)
export const chatHint = atom(false)
const chatHintShown = atom(false)
const channelList = atom<Channel[]>([])
const searches = atom<Record<string, PeopleSearch>>({})

let opened = 0
let searchId = 0

export function shareView(): ShareView {
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
  set(chat, null)
  set(chatOpening, false)
  set(chatHint, false)
  set(searches, {})
  set(view, 'composer')
  void loadPrefs(input, opened)
}

export function closeComposer(): void {
  opened += 1
  set(composer, null)
  set(searches, {})
  set(sent, null)
  set(chat, null)
  if (read(view) === 'composer') set(view, 'none')
  set(backTo, 'none')
}

export function showChannels(): void {
  set(backTo, read(view) === 'composer' ? 'composer' : 'none')
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
      case 'reviewers':
        if (!input.reviewers) break
        next.reviewers = true
        next.reviewerPeople = destination.people.slice(0, MAX_SHARE_PEOPLE).map(person => ({ ...identityOf(person), required: person.required }))
        break
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
    ...(input.reviewers && chosen.reviewers ? [{ kind: 'reviewers' as const, people: chosen.reviewerPeople }] : [])
  ]
}

const everyoneChosen = (destinations: ShareDestination[]): boolean =>
  destinations.every(destination => (destination.kind === 'chat' || destination.kind === 'reviewers' ? destination.people.length > 0 : true))

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

const notOpened = (url: string, reason?: string): ChatResult => ({ ok: false, text: CHAT_NOT_OPENED, retry: url, ...(reason ? { reason } : {}) })

function openChat(url: string): Promise<ChatResult> {
  return shell.openExternal(url).then(
    result => (result.opened ? CHAT_OPENED : notOpened(url, result.reason === 'consent-unavailable' ? OPEN_LINK_UNAVAILABLE : undefined)),
    error => notOpened(url, messageOf(error))
  )
}

function startChat(destination: ChatDestination, message: ShareMessage, tenantId: string | null): Promise<ChatResult> {
  const url = teamsChatUrl({ users: destination.people.map(person => person.uniqueName), text: toPlain(message), tenantId })
  return url === null ? Promise.resolve(CHAT_TOO_LONG) : openChat(url)
}

export function share(): void {
  const input = read(composer)
  const loaded = read(prefs)
  const plan = sharePlan()
  if (!input || loaded.status !== 'ready' || !plan?.ready || read(sending)) return
  const chatTo = plan.destinations.find((destination): destination is ChatDestination => destination.kind === 'chat')
  const chatting = chatTo ? startChat(chatTo, plan.message, loaded.value.tenantId) : null
  const request = plugin.request(
    'share.send',
    { org: input.org, kind: input.kind, keys: plan.keys, intro: read(intro), destinations: plan.destinations },
    LONG_WAIT
  )
  set(sending, true)
  set(sent, null)
  set(chat, null)
  void settle(opened, request, chatting)
}

async function settle(run: number, request: Promise<{ results: ShareResult[] }>, chatting: Promise<ChatResult> | null): Promise<void> {
  const answered = request.then(
    ({ results }) => ({ results }),
    error => ({ results: [], error: messageOf(error) })
  )
  await Promise.all([
    answered.then(answer => {
      if (run === opened) set(sent, answer)
    }),
    chatting?.then(result => {
      if (run === opened) set(chat, result)
    })
  ])
  set(sending, false)
}

export function retryChat(): void {
  const url = read(chat)?.retry
  if (!url || read(chatOpening)) return
  const run = opened
  const opening = openChat(url)
  set(chatOpening, true)
  void opening.then(result => {
    if (run !== opened) return
    set(chat, result)
    set(chatOpening, false)
  })
}

export const searchOf = (label: string): PeopleSearch => read(searches)[label] ?? NO_SEARCH

export function setQuery(label: string, query: string): void {
  update(searches, all => ({ ...all, [label]: { ...(all[label] ?? NO_SEARCH), query } }))
}

function landSearch(label: string, id: number, patch: Partial<PeopleSearch>): void {
  update(searches, all => (all[label]?.id === id ? { ...all, [label]: { ...all[label], ...patch } } : all))
}

export async function findPeople(input: { org: string; label: string; groups: boolean; query: string }): Promise<void> {
  const query = input.query.trim()
  if (query === '') return
  const id = (searchId += 1)
  update(searches, all => ({ ...all, [input.label]: { ...(all[input.label] ?? NO_SEARCH), query: input.query, status: 'searching' as const, id } }))
  try {
    const results = await plugin.request('share.people', { org: input.org, query, groups: input.groups })
    landSearch(input.label, id, { status: 'ready', results, message: undefined })
  } catch (error) {
    landSearch(input.label, id, { status: 'failed', results: [], message: messageOf(error) })
  }
}
