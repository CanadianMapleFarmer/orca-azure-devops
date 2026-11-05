import { atom, plugin, read, set, shell } from 'orca'
import { messageOf, OPEN_LINK_UNAVAILABLE } from '../../shared/messages'
import { toPlain } from '../../shared/share/message'
import { teamsChatUrl } from '../../shared/share/teams'
import type { ShareDestination, ShareMessage, ShareResult } from '../../shared/share/types'
import { LONG_WAIT } from '../state'
import { chat, chatOpening, composer, currentRun, intro, prefs, sent, sharePlan, type ChatResult } from './state'

type ChatDestination = Extract<ShareDestination, { kind: 'chat' }>

const CHAT_OPENED: ChatResult = { ok: true, text: 'Opened a Teams chat.' }
const CHAT_TOO_LONG: ChatResult = { ok: false, text: 'Too long for a Teams chat link. Use Copy instead.' }
const CHAT_NOT_OPENED = "Teams chat wasn't opened."

export const sending = atom(false)

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
  void settle(currentRun(), request, chatting)
}

async function settle(run: number, request: Promise<{ results: ShareResult[] }>, chatting: Promise<ChatResult> | null): Promise<void> {
  const answered = request.then(
    ({ results }) => ({ results }),
    error => ({ results: [], error: messageOf(error) })
  )
  await Promise.all([
    answered.then(answer => {
      if (run === currentRun()) set(sent, answer)
    }),
    chatting?.then(result => {
      if (run === currentRun()) set(chat, result)
    })
  ])
  set(sending, false)
}

export function retryChat(): void {
  const url = read(chat)?.retry
  if (!url || read(chatOpening)) return
  const run = currentRun()
  const opening = openChat(url)
  set(chatOpening, true)
  void opening.then(result => {
    if (run !== currentRun()) return
    set(chat, result)
    set(chatOpening, false)
  })
}
