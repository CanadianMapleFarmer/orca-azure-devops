import { messageOf } from '../../src/shared/messages'
import type { PrKey } from '../../src/shared/prs'
import { toHtml, toPlain } from '../../src/shared/share/message'
import type { Channel, Person, ShareDestination, ShareMessage, ShareResult } from '../../src/shared/share/types'
import type { AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { addReviewer } from '../ado/pr-actions'
import {
  addedReviewers,
  alreadyReviewer,
  CHANNEL_GONE,
  CHANNEL_URL_MISSING,
  COPIED_HTML,
  COPIED_RICH,
  NO_PULL_REQUESTS_FOR_REVIEWERS,
  NO_REVIEWERS_CHOSEN,
  reviewerNotAdded,
  sentTo,
  sharedBy
} from '../messages'
import type { Clipboard } from '../sys/clipboard'
import { adaptiveCard, webhookPayload } from './card'
import { checkWebhookUrl, type ChannelStore } from './channels'
import { postToWebhook } from './webhook'

export interface DestinationContext {
  org: string
  message: ShareMessage
  prs: PrKey[]
  sharedBy: string
}

export interface WorkerDestination {
  kind: ShareDestination['kind']
  send(ctx: DestinationContext, destination: ShareDestination): Promise<ShareResult[]>
}

interface PrOutcome {
  prId: number
  added: Person[]
  already: Person[]
  failures: { person: Person; reason: string }[]
}

const PRS_AT_A_TIME = 3

export function destinationLabel(destination: ShareDestination): string {
  return destination.kind === 'channel' ? `channel:${destination.id}` : destination.kind
}

export function copyDestination(clipboard: Clipboard): WorkerDestination {
  return {
    kind: 'copy',
    async send({ message }) {
      const plain = toPlain(message)
      try {
        const copied = await clipboard.write({ html: toHtml(message), plain })
        return [{ destination: 'copy', ok: true, text: copied === 'html' ? COPIED_HTML : COPIED_RICH }]
      } catch (error) {
        return [{ destination: 'copy', ok: false, text: messageOf(error), plain }]
      }
    }
  }
}

export async function postToChannel(channels: ChannelStore, fetchFn: typeof fetch, id: string, card: Record<string, unknown>): Promise<Channel> {
  const channel = (await channels.list()).find(item => item.id === id)
  if (!channel) throw new Error(CHANNEL_GONE)
  const stored = await channels.url(id)
  if (!stored) throw new Error(CHANNEL_URL_MISSING)
  await postToWebhook(fetchFn, checkWebhookUrl(stored), webhookPayload(card))
  return channel
}

export function channelDestination(channels: ChannelStore, fetchFn: typeof fetch): WorkerDestination {
  return {
    kind: 'channel',
    async send(ctx, destination) {
      const label = destinationLabel(destination)
      if (destination.kind !== 'channel') return []
      try {
        const channel = await postToChannel(channels, fetchFn, destination.id, adaptiveCard(ctx.message, sharedBy(ctx.sharedBy)))
        return [{ destination: label, ok: true, text: sentTo(channel.name) }]
      } catch (error) {
        return [{ destination: label, ok: false, text: messageOf(error) }]
      }
    }
  }
}

export function reviewersDestination(http: AdoHttp): WorkerDestination {
  return {
    kind: 'reviewers',
    async send({ org, prs }, destination) {
      if (destination.kind !== 'reviewers') return []
      const people = distinctPeople(destination.people)
      if (people.length === 0) return [{ destination: 'reviewers', ok: false, text: NO_REVIEWERS_CHOSEN }]
      if (prs.length === 0) return [{ destination: 'reviewers', ok: false, text: NO_PULL_REQUESTS_FOR_REVIEWERS }]
      const outcomes = await mapLimit(prs, PRS_AT_A_TIME, key => addTo(http, org, key, people))
      return [summary(people, outcomes)]
    }
  }
}

async function addTo(http: AdoHttp, org: string, key: PrKey, people: Person[]): Promise<PrOutcome> {
  const outcome: PrOutcome = { prId: key.prId, added: [], already: [], failures: [] }
  for (const person of people) {
    try {
      const result = await addReviewer(http, org, key, person.id, person.required)
      outcome[result].push(person)
    } catch (error) {
      outcome.failures.push({ person, reason: messageOf(error) })
    }
  }
  return outcome
}

function summary(people: Person[], outcomes: PrOutcome[]): ShareResult {
  const namesByCount = new Map<number, string[]>()
  for (const person of people) {
    const count = outcomes.filter(outcome => outcome.added.includes(person)).length
    if (count > 0) namesByCount.set(count, [...(namesByCount.get(count) ?? []), person.displayName])
  }
  const notes = [
    ...[...namesByCount].map(([count, names]) => addedReviewers(names, count)),
    ...outcomes.flatMap(outcome => outcome.already.map(person => alreadyReviewer(person.displayName, outcome.prId))),
    ...outcomes.flatMap(outcome => outcome.failures.map(({ person, reason }) => reviewerNotAdded(person.displayName, outcome.prId, reason)))
  ]
  return { destination: 'reviewers', ok: outcomes.every(outcome => outcome.failures.length === 0), text: notes.join(' ') }
}

function distinctPeople(people: Person[]): Person[] {
  const seen = new Set<string>()
  return people.filter(person => {
    const id = person.id.toLowerCase()
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
