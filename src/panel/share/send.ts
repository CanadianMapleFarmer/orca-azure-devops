import { atom, plugin, read, set, shell, update } from 'orca'
import { messageOf, OPEN_LINK_UNAVAILABLE } from '../../shared/messages'
import { mailtoUrl } from '../../shared/share/email'
import { toPlain } from '../../shared/share/message'
import { teamsChatUrl } from '../../shared/share/teams'
import type { ShareResult } from '../../shared/share/types'
import type { Identity } from '../../shared/types'
import { LONG_WAIT } from '../state'
import { composer, currentRun, intro, LINK_KINDS, linkOpening, links, prefs, sent, sharePlan, type LinkKind, type LinkResult, type Links, type Plan } from './state'

type LinkUrls = Partial<Record<LinkKind, string | null>>

const TEXTS: Record<LinkKind, { opened: string; notOpened: string; tooLong: string }> = {
  chat: { opened: 'Opened a Teams chat.', notOpened: "Teams chat wasn't opened.", tooLong: 'Too long for a Teams chat link. Use Copy instead.' },
  email: { opened: 'Opened an email draft.', notOpened: "The email draft wasn't opened.", tooLong: 'Too long for an email link. Use Copy instead.' }
}

export const sending = atom(false)

const notOpened = (kind: LinkKind, url: string, reason?: string): LinkResult => ({ ok: false, text: TEXTS[kind].notOpened, retry: url, ...(reason ? { reason } : {}) })

function openLink(kind: LinkKind, url: string): Promise<LinkResult> {
  return shell.openExternal(url).then(
    result => (result.opened ? { ok: true, text: TEXTS[kind].opened } : notOpened(kind, url, result.reason === 'consent-unavailable' ? OPEN_LINK_UNAVAILABLE : undefined)),
    error => notOpened(kind, url, messageOf(error))
  )
}

const uniqueNames = (people: Identity[]): string[] => people.map(person => person.uniqueName)

function linkUrls(plan: Plan, subject: string, tenantId: string | null): LinkUrls {
  const body = toPlain(plan.message)
  const urls: LinkUrls = {}
  for (const destination of plan.destinations) {
    if (destination.kind === 'chat') urls.chat = teamsChatUrl({ users: uniqueNames(destination.people), text: body, tenantId })
    if (destination.kind === 'email') urls.email = mailtoUrl({ to: uniqueNames(destination.people), subject, body })
  }
  return urls
}

function startLinks(urls: LinkUrls): { held: Links; opening: Promise<Links> | null } {
  const held: Links = {}
  let opening: Promise<Links> | null = null
  let turn = true
  for (const kind of LINK_KINDS) {
    const url = urls[kind]
    if (url === undefined) continue
    if (url === null) held[kind] = { ok: false, text: TEXTS[kind].tooLong }
    else if (turn) {
      opening = openLink(kind, url).then(result => ({ [kind]: result }))
      turn = false
    } else held[kind] = { ...notOpened(kind, url), waiting: true }
  }
  return { held, opening }
}

export function share(): void {
  const input = read(composer)
  const loaded = read(prefs)
  const plan = sharePlan()
  if (!input || loaded.status !== 'ready' || !plan?.ready || read(sending)) return
  const { held, opening } = startLinks(linkUrls(plan, input.subject, loaded.value.tenantId))
  const request = plugin.request(
    'share.send',
    { org: input.org, kind: input.kind, keys: plan.keys, intro: read(intro), destinations: plan.destinations },
    LONG_WAIT
  )
  set(sending, true)
  set(sent, null)
  set(links, held)
  void settle(currentRun(), request, opening)
}

async function settle(run: number, request: Promise<{ results: ShareResult[] }>, opening: Promise<Links> | null): Promise<void> {
  const answered = request.then(
    ({ results }) => ({ results }),
    error => ({ results: [], error: messageOf(error) })
  )
  await Promise.all([
    answered.then(answer => {
      if (run === currentRun()) set(sent, answer)
    }),
    opening?.then(opened => {
      if (run === currentRun()) update(links, current => ({ ...current, ...opened }))
    })
  ])
  set(sending, false)
}

export function retryLink(kind: LinkKind): void {
  const url = read(links)[kind]?.retry
  if (!url || read(linkOpening) || read(sending)) return
  const run = currentRun()
  const opening = openLink(kind, url)
  set(linkOpening, true)
  void opening.then(result => {
    if (run !== currentRun()) return
    update(links, current => ({ ...current, [kind]: result }))
    set(linkOpening, false)
  })
}
