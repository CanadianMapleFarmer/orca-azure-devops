import { ADO_RESOURCE } from '../ado/org'

export const CLIENT_ID = '6a1d3b5c-7e9f-4b2d-8c4a-1f3e5d7b9a20'
export const TENANT = '0f0e0d0c-0b0a-4908-8706-050403020100'
export const OID_ADA = '6f1c2e2a-0ada-4c3e-9a1b-0d4e8c7b6a51'
export const OID_GRACE = '2b7d9f10-9ace-4e21-8d3c-71a0b5e4c9f2'

const NOISE = 'for ada@contoso.com. <b>x</b>\r\nTrace ID: 5f0c4e1a-2b3c-4d5e-8f90-a1b2c3d4e5f6'

type Grant = 'authorization_code' | 'refresh_token'
type Reply = Response | Error

export function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.c2ln`
}

export function accessToken(p: { oid: string; upn: string; tid?: string }): string {
  return jwt({ aud: ADO_RESOURCE, appid: CLIENT_ID, oid: p.oid, tid: p.tid ?? TENANT, upn: p.upn })
}

export function tokenAnswer(p: {
  oid: string
  upn: string
  refresh?: string
  expiresIn?: number | string
  idToken?: boolean
  tid?: string
}): Response {
  const tid = p.tid ?? TENANT
  const body: Record<string, unknown> = {
    token_type: 'Bearer',
    expires_in: p.expiresIn ?? 3600,
    access_token: accessToken({ oid: p.oid, upn: p.upn, tid })
  }
  if (p.refresh !== undefined) body.refresh_token = p.refresh
  if (p.idToken !== false) body.id_token = jwt({ aud: CLIENT_ID, oid: p.oid, tid, preferred_username: p.upn })
  return json(body, 200)
}

export function entraErrorAnswer(p: { error: string; codes?: number[]; description?: string; status?: number }): Response {
  const prefix = p.codes?.length ? `AADSTS${p.codes[0]}: ` : ''
  const body: Record<string, unknown> = {
    error: p.error,
    error_description: p.description ?? `${prefix}Microsoft couldn't finish this request ${NOISE}`,
    trace_id: '5f0c4e1a-2b3c-4d5e-8f90-a1b2c3d4e5f6',
    correlation_id: '7d1e2f3a-4b5c-4d6e-9f80-1a2b3c4d5e6f'
  }
  if (p.codes) body.error_codes = p.codes
  return json(body, p.status ?? 400)
}

export function fakeEntra(): {
  fetch: typeof fetch
  calls: { url: string; form: URLSearchParams; headers: Headers }[]
  answer(grant: Grant, ...replies: Reply[]): void
} {
  const queues: Record<Grant, Reply[]> = { authorization_code: [], refresh_token: [] }
  const calls: { url: string; form: URLSearchParams; headers: Headers }[] = []

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted) throw signal.reason
    const request = new Request(input, init)
    const form = new URLSearchParams(await request.text())
    calls.push({ url: request.url, form, headers: request.headers })
    if (signal?.aborted) throw signal.reason
    const grant = form.get('grant_type')
    const reply = grant === 'authorization_code' || grant === 'refresh_token' ? queues[grant].shift() : undefined
    if (reply === undefined) return unanswered(signal)
    if (reply instanceof Error) throw reply
    return reply
  }

  return {
    fetch: fetchFn as typeof fetch,
    calls,
    answer(grant, ...replies) {
      queues[grant].push(...replies)
    }
  }
}

function unanswered(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
