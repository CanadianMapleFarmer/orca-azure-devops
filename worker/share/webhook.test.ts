import { assert, test } from 'orca/testing'
import { adaptiveCard, webhookPayload } from './card'
import { postToWebhook } from './webhook'

const SIG = 'wQ3vN8sXkP2mR7tY1uZ4aB6cD9eF0gH5iJ'
const WEBHOOK = `https://default0f0e0d0c.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/5d1c2b3a/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`
const PR_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101'
const UNREACHABLE = "Couldn't reach Teams."
const THROTTLED = 'Teams is throttling posts. Try again in a minute.'
const refused = (status: number) => `Teams didn't accept the post (HTTP ${status}). If the workflow changed, replace its URL.`

interface Posted {
  url: string
  init: RequestInit
}

function answering(respond: (url: string, init: RequestInit) => Response | Promise<Response>): { posted: Posted[]; fetch: typeof fetch } {
  const posted: Posted[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), init: init ?? {} })
    return respond(String(input), init ?? {})
  }) as typeof fetch
  return { posted, fetch: fetchFn }
}

const PAYLOAD = webhookPayload(adaptiveCard({ intro: 'Ready for QA.', lines: [[{ text: 'Pull Request 4101', href: PR_URL }]] }, 'Shared by Alex Contoso from Orca'))

test('post sends the Adaptive Card payload and treats 202 as accepted', async () => {
  const { posted, fetch } = answering(() => new Response(null, { status: 202 }))
  assert.equal(await postToWebhook(fetch, WEBHOOK, PAYLOAD), undefined)
  assert.equal(posted.length, 1)
  const [{ url, init }] = posted
  assert.equal(url, WEBHOOK)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error', 'a redirect is never followed with the card')
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
  assert.ok(init.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(String(init.body)), PAYLOAD)
  assert.deepEqual(Object.keys(PAYLOAD), ['type', 'attachments'])
  assert.equal(PAYLOAD.type, 'message')
  assert.deepEqual((PAYLOAD.attachments as { contentType: string; contentUrl: null }[]).map(({ contentType, contentUrl }) => ({ contentType, contentUrl })), [
    { contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null }
  ])

  for (const status of [200, 201, 204]) {
    await postToWebhook(answering(() => new Response(null, { status })).fetch, WEBHOOK, PAYLOAD)
  }
})

test('failures become fixed messages that never mention the URL', async () => {
  const leaky = (status: number) => () => new Response(JSON.stringify({ error: { message: `No workflow at ${WEBHOOK}` } }), { status })
  const cases: [string, (url: string) => Response | Promise<Response>, string][] = [
    ['429', leaky(429), THROTTLED],
    ['404', leaky(404), refused(404)],
    ['400', leaky(400), refused(400)],
    ['500', leaky(500), refused(500)],
    ['302', () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } }), refused(302)],
    ['dns', url => Promise.reject(new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url}`, { cause: new Error(url) })), UNREACHABLE],
    ['redirect refused', url => Promise.reject(new TypeError(`unexpected redirect from ${url}`)), UNREACHABLE]
  ]
  for (const [name, respond, message] of cases) {
    const error = await postToWebhook(answering(respond).fetch, WEBHOOK, PAYLOAD).then(
      () => assert.fail(`${name}: expected the post to fail`),
      (caught: unknown) => caught
    )
    assert.ok(error instanceof Error, name)
    assert.equal(error.message, message, name)
    assert.equal(error.cause, undefined, name)
    assert.ok(!JSON.stringify([error.message, String(error.stack)]).includes(SIG), `${name}: the URL leaked`)
  }
})

test('a post that takes longer than the timeout is abandoned as unreachable', async () => {
  const { posted, fetch } = answering(
    (url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException(`The operation timed out: ${url}`, 'TimeoutError')), { once: true })
      })
  )
  const started = Date.now()
  await assert.rejects(postToWebhook(fetch, WEBHOOK, PAYLOAD, 20), (error: unknown) => error instanceof Error && error.message === UNREACHABLE)
  assert.ok(Date.now() - started < 2_000)
  assert.equal(posted[0].init.signal?.aborted, true)
})
