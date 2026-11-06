import { once } from 'node:events'
import { type IncomingHttpHeaders, type OutgoingHttpHeaders, request } from 'node:http'
import { connect } from 'node:net'
import { assert, test } from 'orca/testing'
import { REDIRECT_PAGE } from '../messages'
import { drain } from '../test-support'
import { closeAllListeners, type Listener, listenForRedirect, MAX_REDIRECT_BODY_BYTES } from './loopback'

const STATE = 'Qm7vT2xLp9Kd4WzR8nYbHg'
const FORM = 'application/x-www-form-urlencoded'
const LEAKS = ['c1', 'c-ada-1', STATE, 'evil']

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

interface Send {
  method?: string
  path?: string
  host?: string
  type?: string
  body?: string
  chunked?: boolean
}

function send(port: number, s: Send = {}): Promise<Answer> {
  const body = s.body ?? ''
  const headers: OutgoingHttpHeaders = { host: s.host ?? `localhost:${port}` }
  if (s.type) headers['content-type'] = s.type
  if (s.chunked) headers['transfer-encoding'] = 'chunked'
  else headers['content-length'] = Buffer.byteLength(body)
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: s.method ?? 'POST', path: s.path ?? '/', headers, agent: false }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (s.chunked) {
      for (let at = 0; at < body.length; at += 8192) req.write(body.slice(at, at + 8192))
      req.end()
    } else {
      req.end(body)
    }
  })
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

function portOf(listener: Listener): number {
  return Number(new URL(listener.redirectUri).port)
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false
  promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  return () => settled
}

function connectError(host: string, port: number): Promise<string | null> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(null)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
  })
}

async function connectionMidRequest(port: number): Promise<{ closed: Promise<unknown> }> {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  let seen = ''
  const answered = new Promise<void>(resolve => {
    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (seen.includes('</html>')) resolve()
    })
  })
  socket.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`)
  await answered
  assert.ok(seen.startsWith('HTTP/1.1 404 '))
  socket.write(`POST / HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: ${FORM}\r\nContent-Length: 100\r\n\r\nstate=`)
  await drain()
  assert.equal(socket.readyState, 'open')
  return { closed }
}

function assertPage(answer: Answer, status: number, page: keyof typeof REDIRECT_PAGE): void {
  assert.equal(answer.status, status)
  assert.equal(answer.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(answer.headers['content-security-policy'], "default-src 'none'")
  assert.equal(answer.headers['cache-control'], 'no-store')
  assert.equal(answer.headers['referrer-policy'], 'no-referrer')
  assert.ok(answer.body.includes(REDIRECT_PAGE.title))
  assert.ok(answer.body.includes(REDIRECT_PAGE[page]))
  for (const leak of LEAKS) assert.equal(answer.body.includes(leak), false, `the page echoes ${leak}`)
}

function isRefused(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

test('binds 127.0.0.1 on a random port and names localhost in the redirect', async () => {
  const controller = new AbortController()
  const listener = await listenForRedirect({ state: STATE, signal: controller.signal })
  const port = portOf(listener)
  try {
    assert.ok(port > 0)
    assert.equal(listener.redirectUri, `http://localhost:${port}`)
    assert.equal(await connectError('127.0.0.1', port), null)
    assert.notEqual(await connectError('::1', port), null)
  } finally {
    controller.abort()
    await assert.rejects(listener.result)
  }
})

test('the redirect listener accepts only one form post with the right state and echoes nothing', async () => {
  const listener = await listenForRedirect({ state: STATE, signal: new AbortController().signal })
  const port = portOf(listener)
  const settled = settledFlag(listener.result)
  const right = { code: 'c1', state: STATE }
  const oversized = form({ ...right, pad: 'x'.repeat(70 * 1024) })

  const refusals: [Send, number, keyof typeof REDIRECT_PAGE][] = [
    [{ method: 'GET', path: `/?code=c1&state=${STATE}` }, 404, 'notHere'],
    [{ path: '/favicon.ico', type: FORM, body: form(right) }, 404, 'notHere'],
    [{ host: 'evil.example', type: FORM, body: form(right) }, 400, 'notHere'],
    [{ type: FORM, body: oversized }, 413, 'notHere'],
    [{ type: FORM, body: oversized, chunked: true }, 413, 'notHere'],
    [{ type: FORM, body: form({ code: 'c1', state: 'wrong' }) }, 400, 'stale'],
    [{ type: FORM, body: form({ code: 'c1' }) }, 400, 'stale'],
    [{ type: FORM, body: form({ state: STATE }) }, 400, 'stale'],
    [{ type: 'application/json', body: JSON.stringify(right) }, 404, 'notHere']
  ]
  for (const [sent, status, page] of refusals) {
    assertPage(await send(port, sent), status, page)
    await drain()
    assert.equal(settled(), false, `${JSON.stringify({ ...sent, body: sent.body?.slice(0, 40) })} settled the sign-in`)
  }

  const held = await connectionMidRequest(port)
  assertPage(await send(port, { type: FORM, body: form({ code: 'c-ada-1', state: STATE }) }), 200, 'done')
  assert.deepEqual(await listener.result, { code: 'c-ada-1' })
  await held.closed
  await assert.rejects(send(port, { type: FORM, body: form({ code: 'c-ada-2', state: STATE }) }), isRefused)
})

test('a form post of exactly MAX_REDIRECT_BODY_BYTES counts and one byte more does not', async () => {
  const listener = await listenForRedirect({ state: STATE, signal: new AbortController().signal })
  const port = portOf(listener)
  const settled = settledFlag(listener.result)
  const padded = (bytes: number) => {
    const bare = form({ code: 'c-ada-1', pad: '', state: STATE })
    return form({ code: 'c-ada-1', pad: 'x'.repeat(bytes - bare.length), state: STATE })
  }
  assert.equal(padded(MAX_REDIRECT_BODY_BYTES).length, MAX_REDIRECT_BODY_BYTES)

  for (const chunked of [false, true]) {
    assertPage(await send(port, { type: FORM, body: padded(MAX_REDIRECT_BODY_BYTES + 1), chunked }), 413, 'notHere')
    await drain()
    assert.equal(settled(), false)
  }
  assertPage(await send(port, { type: FORM, body: padded(MAX_REDIRECT_BODY_BYTES), chunked: true }), 200, 'done')
  assert.deepEqual(await listener.result, { code: 'c-ada-1' })
})

test("an error post resolves with Entra's code and shows no markup", async () => {
  const listener = await listenForRedirect({ state: STATE, signal: new AbortController().signal })
  const answer = await send(portOf(listener), {
    type: FORM,
    body: form({
      error: 'consent_required',
      error_description: '<script>x</script> AADSTS65001: The user or administrator has not consented to use the application.',
      state: STATE
    })
  })
  assertPage(answer, 200, 'failed')
  for (const markup of ['<script', 'AADSTS', 'consent', 'administrator']) assert.equal(answer.body.includes(markup), false)
  assert.deepEqual(await listener.result, { error: 'consent_required', errorCode: 'AADSTS65001' })

  const plain = await listenForRedirect({ state: STATE, signal: new AbortController().signal })
  assertPage(await send(portOf(plain), { type: FORM, body: form({ state: STATE, error: 'access_denied', code: 'c1' }) }), 200, 'failed')
  assert.deepEqual(await plain.result, { error: 'access_denied', errorCode: null })
})

test('the form content type counts with a charset parameter and in any letter case', async () => {
  const listener = await listenForRedirect({ state: STATE, signal: new AbortController().signal })
  const type = 'Application/X-WWW-Form-URLEncoded; charset=UTF-8'
  assertPage(await send(portOf(listener), { type, body: form({ code: 'c-ada-1', state: STATE }) }), 200, 'done')
  assert.deepEqual(await listener.result, { code: 'c-ada-1' })
})

test('abort closes the port and rejects with the reason', async () => {
  const reason = new Error('cancelled')
  await assert.rejects(listenForRedirect({ state: STATE, signal: AbortSignal.abort(reason) }), error => error === reason)

  const controller = new AbortController()
  const listener = await listenForRedirect({ state: STATE, signal: controller.signal })
  const port = portOf(listener)
  const held = await connectionMidRequest(port)
  controller.abort(reason)
  await assert.rejects(listener.result, error => error === reason)
  await held.closed
  assert.equal(await connectError('127.0.0.1', port), 'ECONNREFUSED')

  const binding = new AbortController()
  const pending = listenForRedirect({ state: STATE, signal: binding.signal })
  binding.abort(reason)
  await assert.rejects(pending, error => error === reason)
})

test('closeAllListeners closes every open listener', async () => {
  const signal = new AbortController().signal
  const first = await listenForRedirect({ state: STATE, signal })
  const second = await listenForRedirect({ state: 'another-state', signal })
  const held = await connectionMidRequest(portOf(second))
  const binding = listenForRedirect({ state: STATE, signal })
  closeAllListeners()
  await assert.rejects(first.result, isAbortError)
  await assert.rejects(second.result, isAbortError)
  await assert.rejects(binding, isAbortError)
  await held.closed
  assert.equal(await connectError('127.0.0.1', portOf(first)), 'ECONNREFUSED')
  assert.equal(await connectError('127.0.0.1', portOf(second)), 'ECONNREFUSED')

  const after = await listenForRedirect({ state: STATE, signal })
  assertPage(await send(portOf(after), { type: FORM, body: form({ code: 'c-ada-1', state: STATE }) }), 200, 'done')
  assert.deepEqual(await after.result, { code: 'c-ada-1' })
})
