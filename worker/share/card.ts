import { isWebUrl } from '../../src/shared/share/template'
import type { Segment, ShareMessage } from '../../src/shared/share/types'
import { byteLength } from '../budget'
import { CARD_TOO_LARGE } from '../messages'

export const MAX_CARD_BYTES = 26_000

export function adaptiveCard(message: ShareMessage, footer: string): Record<string, unknown> {
  const introLines = message.intro.split('\n').filter(line => line.trim() !== '')
  const body = [
    ...introLines.map(line => richText([{ type: 'TextRun', text: line }])),
    ...message.lines.map(line => richText(line.map(textRun))),
    ...(footer === '' ? [] : [richText([{ type: 'TextRun', text: footer, isSubtle: true, size: 'Small' }])])
  ]
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', msteams: { width: 'Full' }, body }
}

export function webhookPayload(card: Record<string, unknown>): Record<string, unknown> {
  const payload = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] }
  if (byteLength(payload) > MAX_CARD_BYTES) throw new Error(CARD_TOO_LARGE)
  return payload
}

function richText(inlines: Record<string, unknown>[]): Record<string, unknown> {
  return { type: 'RichTextBlock', inlines }
}

function textRun(segment: Segment): Record<string, unknown> {
  const run = { type: 'TextRun', text: segment.text }
  return segment.href !== undefined && isWebUrl(segment.href) ? { ...run, selectAction: { type: 'Action.OpenUrl', url: segment.href } } : run
}
