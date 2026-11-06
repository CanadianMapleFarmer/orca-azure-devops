import { orgSearchUrl, orgVsspsUrl, orgWebUrl } from './org'

export type AdoErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_failed'
  | 'rate_limited' | 'bad_request' | 'server' | 'network'

export class AdoError extends Error {
  readonly code: AdoErrorCode
  readonly status: number
  readonly retryAfterMs?: number

  constructor(code: AdoErrorCode, status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'AdoError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export interface AdoRequest {
  org: string
  host?: 'vssps' | 'almsearch'
  project?: string
  path: string
  query?: Record<string, string | number | boolean | undefined>
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  contentType?: 'application/json' | 'application/json-patch+json'
  apiVersion?: string
  ifMatch?: string
  signal?: AbortSignal
}

export interface AdoHttp {
  json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }>
}

export interface AdoHttpDeps {
  fetch: typeof fetch
  authHeader: (org: string) => Promise<string>
  onUnauthorized?: (org: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

const DEFAULT_API_VERSION = '7.1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_AFTER_MS = 1000
const MAX_THROTTLE_RETRIES = 2
const MAX_RETRY_WAIT_MS = 10_000
const PREVIEW_VERSION_EXCEPTION = 'VssInvalidPreviewVersionException'
const HOST_URL: Record<NonNullable<AdoRequest['host']>, (org: string) => string> = {
  vssps: orgVsspsUrl,
  almsearch: orgSearchUrl
}

const FIXED_MESSAGE: Record<AdoErrorCode, string> = {
  unauthorized: 'Azure DevOps rejected the credentials.',
  forbidden: 'You do not have permission to do that in Azure DevOps.',
  not_found: 'Azure DevOps could not find that resource.',
  conflict: 'Azure DevOps reported a conflict with the current state.',
  precondition_failed: 'The item changed in Azure DevOps since it was loaded.',
  rate_limited: 'Azure DevOps is throttling requests. Try again shortly.',
  bad_request: 'Azure DevOps rejected the request.',
  server: 'Azure DevOps had a server error.',
  network: 'Could not reach Azure DevOps.'
}
const TIMEOUT_MESSAGE = 'Azure DevOps did not respond in time.'
const NOT_JSON_MESSAGE = 'Azure DevOps returned a response that was not valid JSON.'

interface RawResponse {
  status: number
  headers: Headers
  text: string
}

export function withSignal(http: AdoHttp, signal?: AbortSignal): AdoHttp {
  return signal ? { json: req => http.json({ ...req, signal: req.signal ?? signal }) } : http
}

export function createAdoHttp(deps: AdoHttpDeps): AdoHttp {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(req: AdoRequest, apiVersion: string): Promise<RawResponse> {
    req.signal?.throwIfAborted()
    const auth = await deps.authHeader(req.org)
    const headers: Record<string, string> = { Authorization: auth, Accept: 'application/json' }
    if (req.body !== undefined) headers['Content-Type'] = req.contentType ?? 'application/json'
    if (req.ifMatch) headers['If-Match'] = req.ifMatch
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, deadline.signal]) : deadline.signal
    try {
      const res = await deps.fetch(buildUrl(req, apiVersion), {
        method: req.method ?? 'GET',
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'manual',
        signal
      })
      return { status: res.status, headers: res.headers, text: await res.text() }
    } catch {
      if (req.signal?.aborted) throw req.signal.reason
      throw new AdoError('network', 0, deadline.signal.aborted ? TIMEOUT_MESSAGE : FIXED_MESSAGE.network)
    } finally {
      clearTimeout(timer)
    }
  }

  async function json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }> {
    let apiVersion = req.apiVersion ?? DEFAULT_API_VERSION
    let throttleRetries = 0
    let refreshed = false
    let previewRetried = false
    for (;;) {
      const res = await send(req, apiVersion)
      if (isSuccess(res)) return { data: parseSuccess<T>(res), headers: res.headers }

      const problem = readProblem(res.text)
      if (isAuthFailure(res)) {
        if (!refreshed && (await deps.onUnauthorized?.(req.org))) {
          refreshed = true
          continue
        }
        throw adoError('unauthorized', res, problem.message)
      }
      if (
        res.status === 400 && !previewRetried && problem.typeKey === PREVIEW_VERSION_EXCEPTION &&
        !apiVersion.includes('-preview')
      ) {
        previewRetried = true
        apiVersion = `${apiVersion}-preview`
        continue
      }
      if (isThrottle(res)) {
        const retryAfterMs = parseRetryAfter(res.headers)
        const waitMs = retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
        if (throttleRetries >= MAX_THROTTLE_RETRIES || waitMs > MAX_RETRY_WAIT_MS)
          throw adoError('rate_limited', res, problem.message, retryAfterMs)
        throttleRetries += 1
        await sleep(waitMs)
        continue
      }
      throw adoError(codeFor(res.status), res, problem.message)
    }
  }

  return { json }
}

function buildUrl(req: AdoRequest, apiVersion: string): string {
  const project = req.project ? `/${encodeURIComponent(req.project)}` : ''
  const pairs = Object.entries(req.query ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeQuery(key)}=${encodeQuery(String(value))}`)
  pairs.push(`api-version=${encodeQuery(apiVersion)}`)
  const base = req.host ? HOST_URL[req.host](req.org) : orgWebUrl(req.org)
  return `${base}${project}${req.path}?${pairs.join('&')}`
}

function encodeQuery(text: string): string {
  return encodeURIComponent(text).replaceAll('%24', '$')
}

function isSuccess(res: RawResponse): boolean {
  return res.status >= 200 && res.status < 300 && !isAuthFailure(res)
}

function isAuthFailure(res: RawResponse): boolean {
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) return true
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  if (res.status >= 200 && res.status < 300 && contentType.includes('text/html')) return true
  return res.status === 203 && !contentType.includes('json')
}

function isThrottle(res: RawResponse): boolean {
  return res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim()
  return value && /^\d+$/.test(value) ? Number(value) * 1000 : undefined
}

function parseSuccess<T>(res: RawResponse): T {
  if (res.status === 204 || res.text.trim() === '') return undefined as T
  try {
    return JSON.parse(res.text) as T
  } catch {
    throw new AdoError('server', res.status, NOT_JSON_MESSAGE)
  }
}

function readProblem(text: string): { message?: string; typeKey?: string } {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null) return {}
    const { message, typeKey } = body as Record<string, unknown>
    return {
      message: typeof message === 'string' && message.trim() !== '' ? message : undefined,
      typeKey: typeof typeKey === 'string' ? typeKey : undefined
    }
  } catch {
    return {}
  }
}

function codeFor(status: number): AdoErrorCode {
  switch (status) {
    case 403: return 'forbidden'
    case 404: return 'not_found'
    case 409: return 'conflict'
    case 412: return 'precondition_failed'
    default: return status >= 500 ? 'server' : 'bad_request'
  }
}

function adoError(code: AdoErrorCode, res: RawResponse, message?: string, retryAfterMs?: number): AdoError {
  return new AdoError(code, res.status, message ?? FIXED_MESSAGE[code], retryAfterMs)
}
