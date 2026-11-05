import { assert, test } from 'orca/testing'
import type { ShareMessage } from '../../src/shared/share/types'
import { byteLength } from '../budget'
import { adaptiveCard, MAX_CARD_BYTES, webhookPayload } from './card'

const PR_4101 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101'
const PR_4104 = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/api/pullrequest/4104'
const FOOTER = 'Shared by Alex Contoso from Orca'
const TOO_MUCH = 'Too much to post at once. Share fewer items.'
const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json'

test('each line is a RichTextBlock with an OpenUrl TextRun for the link', () => {
  const message: ShareMessage = {
    intro: 'Release 2026.11 is **ready** for [QA](https://attacker.example).\n\n  Please review _today_.',
    lines: [
      [{ text: 'Pull Request 4101', href: PR_4101 }, { text: ': [PROJ-55283] <script>alert(1)</script>](javascript:alert(1)) & 🚀' }],
      [{ text: 'Before ' }, { text: 'Pull Request 4104', href: PR_4104 }, { text: ': Fix pagination offset' }],
      [{ text: 'Pull Request 4105', href: 'javascript:alert(1)' }]
    ]
  }
  const run = (text: string, url?: string) => (url ? { type: 'TextRun', text, selectAction: { type: 'Action.OpenUrl', url } } : { type: 'TextRun', text })
  assert.deepEqual(adaptiveCard(message, FOOTER), {
    type: 'AdaptiveCard',
    $schema: SCHEMA,
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      { type: 'RichTextBlock', inlines: [run('Release 2026.11 is **ready** for [QA](https://attacker.example).')] },
      { type: 'RichTextBlock', inlines: [run('  Please review _today_.')] },
      {
        type: 'RichTextBlock',
        inlines: [run('Pull Request 4101', PR_4101), run(': [PROJ-55283] <script>alert(1)</script>](javascript:alert(1)) & 🚀')]
      },
      { type: 'RichTextBlock', inlines: [run('Before '), run('Pull Request 4104', PR_4104), run(': Fix pagination offset')] },
      { type: 'RichTextBlock', inlines: [run('Pull Request 4105')] },
      { type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: FOOTER, isSubtle: true, size: 'Small' }] }
    ]
  })

  assert.ok(!JSON.stringify(adaptiveCard(message, FOOTER)).includes('"TextBlock"'), 'no block that Teams reads as Markdown')
  const bare = adaptiveCard({ intro: '', lines: [[{ text: 'Pull Request 4101', href: PR_4101 }]] }, '')
  assert.deepEqual(bare.body, [{ type: 'RichTextBlock', inlines: [run('Pull Request 4101', PR_4101)] }], 'no intro or footer block when they are empty')
})

test('cards over 26,000 bytes are refused', () => {
  assert.equal(MAX_CARD_BYTES, 26_000)
  const withIntro = (intro: string) => adaptiveCard({ intro, lines: [[{ text: 'Pull Request 4101', href: PR_4101 }]] }, FOOTER)
  const tooMuch = (error: unknown) => error instanceof Error && error.message === TOO_MUCH
  const room = MAX_CARD_BYTES - (byteLength(webhookPayload(withIntro('x'))) - 1)
  assert.equal(byteLength(webhookPayload(withIntro('x'.repeat(room)))), MAX_CARD_BYTES)
  assert.throws(() => webhookPayload(withIntro('x'.repeat(room + 1))), tooMuch)
  assert.throws(() => webhookPayload(withIntro('é'.repeat(Math.ceil(room / 2) + 1))), tooMuch)

  const lines = Array.from({ length: 50 }, (_, index) => [{ text: `Pull Request ${4000 + index}`, href: PR_4101 }, { text: `: ${'Long title '.repeat(40)}` }])
  assert.throws(() => webhookPayload(adaptiveCard({ intro: '', lines }, FOOTER)), tooMuch)
})
