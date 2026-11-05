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
  NO_REVIEWERS_CHOSEN,
  reviewersNotAdded,
  sentTo,
  sharedBy
} from '../messages'
import type { Clipboard } from '../sys/clipboard'
import { adaptiveCard, webhookPayload } from './card'
import type { ChannelStore } from './channels'
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
  failure: string | null
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
  const url = await channels.url(id)
  if (!url) throw new Error(CHANNEL_URL_MISSING)
  await postToWebhook(fetchFn, url, webhookPayload(card))
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
      const outcomes = await mapLimit(prs, PRS_AT_A_TIME, key => addTo(http, org, key, people))
      return [summary(people, outcomes)]
    }
  }
}

async function addTo(http: AdoHttp, org: string, key: PrKey, people: Person[]): Promise<PrOutcome> {
  const outcome: PrOutcome = { prId: key.prId, added: [], already: [], failure: null }
  for (const person of people) {
    try {
      const result = await addReviewer(http, org, key, person.id, person.required)
      outcome[result].push(person)
    } catch (error) {
      outcome.failure ??= messageOf(error)
    }
  }
  return outcome
}

function summary(people: Person[], outcomes: PrOutcome[]): ShareResult {
  const added = people.filter(person => outcomes.some(outcome => outcome.added.includes(person)))
  const notes = [
    ...(added.length === 0 ? [] : [addedReviewers(added.map(person => person.displayName), outcomes.filter(outcome => outcome.added.length > 0).length)]),
    ...outcomes.flatMap(outcome => outcome.already.map(person => alreadyReviewer(person.displayName, outcome.prId))),
    ...outcomes.flatMap(outcome => (outcome.failure === null ? [] : [reviewersNotAdded(outcome.prId, outcome.failure)]))
  ]
  return { destination: 'reviewers', ok: outcomes.every(outcome => outcome.failure === null), text: notes.join(' ') }
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
