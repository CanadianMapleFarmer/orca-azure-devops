import type { AdoHttp, AdoRequest } from '../ado/http'

export const PRESSURE_MS = 5 * 60_000

const PRESSURE_HEADERS = ['retry-after', 'x-ratelimit-delay']

export interface Pressure {
  wrap(http: AdoHttp, org: string): AdoHttp
  wrapByOrg(http: AdoHttp): AdoHttp
  slowed(org: string): boolean
}

export function createPressure(now: () => number): Pressure {
  const slowedUntil = new Map<string, number>()
  async function observed<T>(http: AdoHttp, org: string, req: AdoRequest) {
    const answer = await http.json<T>(req)
    if (PRESSURE_HEADERS.some(name => answer.headers.has(name))) slowedUntil.set(org, now() + PRESSURE_MS)
    return answer
  }
  return {
    wrap: (http, org) => ({ json: <T>(req: AdoRequest) => observed<T>(http, org, req) }),
    wrapByOrg: http => ({ json: <T>(req: AdoRequest) => observed<T>(http, req.org, req) }),
    slowed: org => now() < (slowedUntil.get(org) ?? -Infinity)
  }
}
