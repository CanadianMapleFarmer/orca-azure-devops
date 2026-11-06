import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { REDIRECT_PAGE } from '../messages'

export type Redirect = { code: string } | { error: string; errorCode: string | null }

export interface Listener {
  redirectUri: string
  result: Promise<Redirect>
}

export type Listen = (opts: { state: string; signal: AbortSignal }) => Promise<Listener>

export const MAX_REDIRECT_BODY_BYTES = 64 * 1024

type Page = Exclude<keyof typeof REDIRECT_PAGE, 'title'>

const LOOPBACK = '127.0.0.1'
const FORM = 'application/x-www-form-urlencoded'
const AADSTS = /AADSTS\d+/
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer'
}
const PAGES: Record<Page, Buffer> = {
  done: html(REDIRECT_PAGE.done),
  failed: html(REDIRECT_PAGE.failed),
  stale: html(REDIRECT_PAGE.stale),
  notHere: html(REDIRECT_PAGE.notHere)
}

const closers = new Set<(reason: unknown) => void>()

export function closeAllListeners(): void {
  const reason = new DOMException('This operation was aborted', 'AbortError')
  for (const close of [...closers]) close(reason)
}

export const listenForRedirect: Listen = ({ state, signal }) => {
  if (signal.aborted) return Promise.reject(signal.reason)
  const expected = Buffer.from(state)
  const server = createServer()
  let bound = false
  let over = false
  let resolveListener: (listener: Listener) => void = () => {}
  let rejectListener: (reason: unknown) => void = () => {}
  let resolveResult: (redirect: Redirect) => void = () => {}
  let rejectResult: (reason: unknown) => void = () => {}
  const listening = new Promise<Listener>((resolve, reject) => {
    resolveListener = resolve
    rejectListener = reject
  })
  const result = new Promise<Redirect>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const stop = () => {
    over = true
    closers.delete(close)
    signal.removeEventListener('abort', onAbort)
    server.close()
  }
  const close = (reason: unknown) => {
    if (over) return
    stop()
    server.closeAllConnections()
    if (bound) rejectResult(reason)
    else rejectListener(reason)
  }
  const onAbort = () => close(signal.reason)
  const accept = (res: ServerResponse, redirect: Redirect) => {
    stop()
    resolveResult(redirect)
    res.once('close', () => server.closeAllConnections())
    answer(res, 200, 'code' in redirect ? 'done' : 'failed')
  }

  closers.add(close)
  signal.addEventListener('abort', onAbort, { once: true })
  server.on('error', close)
  server.listen(0, LOOPBACK, () => {
    bound = true
    const { port } = server.address() as AddressInfo
    const hosts = [`localhost:${port}`, `${LOOPBACK}:${port}`]
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const refused = headerRefusal(req, hosts)
      if (refused) return answer(res, refused, 'notHere')
      readForm(req, form => {
        if (!form) return answer(res, 413, 'notHere')
        const redirect = over ? null : redirectFrom(form, expected)
        if (!redirect) return answer(res, 400, 'stale')
        accept(res, redirect)
      })
    })
    resolveListener({ redirectUri: `http://localhost:${port}`, result })
  })
  return listening
}

function headerRefusal(req: IncomingMessage, hosts: string[]): number | null {
  if (req.method !== 'POST' || req.url !== '/') return 404
  if (!hosts.includes(req.headers.host ?? '')) return 400
  if (mediaType(req.headers['content-type']) !== FORM) return 404
  return null
}

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase()
}

function readForm(req: IncomingMessage, then: (form: URLSearchParams | null) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= MAX_REDIRECT_BODY_BYTES) chunks.push(chunk)
    else chunks.length = 0
  })
  req.on('end', () => then(size <= MAX_REDIRECT_BODY_BYTES ? new URLSearchParams(Buffer.concat(chunks).toString('utf8')) : null))
}

function redirectFrom(form: URLSearchParams, expected: Buffer): Redirect | null {
  if (!sameState(form.get('state'), expected)) return null
  const error = form.get('error')
  if (error) return { error, errorCode: form.get('error_description')?.match(AADSTS)?.[0] ?? null }
  const code = form.get('code')
  return code ? { code } : null
}

function sameState(given: string | null, expected: Buffer): boolean {
  if (given === null) return false
  const bytes = Buffer.from(given)
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

function answer(res: ServerResponse, status: number, page: Page): void {
  const body = PAGES[page]
  res.writeHead(status, { ...PAGE_HEADERS, 'content-length': body.length }).end(body)
}

function html(text: string): Buffer {
  return Buffer.from(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${REDIRECT_PAGE.title}</title></head><body><p>${text}</p></body></html>`
  )
}
