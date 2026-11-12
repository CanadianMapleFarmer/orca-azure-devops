import type { ResponseObserver } from '../ado/http'

export interface RateLimitHeaders { resource?: string; retryAfterMs?: number; delayMs?: number; limit?: number; remaining?: number; resetAt?: number; cost?: number }
export type PressureLevel = 'normal' | 'near' | 'tight' | 'delayed' | 'blocked'
export interface PressureState { level: PressureLevel; factor: number; resumeAt: number; calmAt: number; last: { at: number; status: number; headers: RateLimitHeaders } | null }
export interface Pressure { observe: ResponseObserver; state(org: string): PressureState; forget(org: string): void }
export interface Pace { factor(org: string): number; resumeAt(org: string): number; calmAt(org: string): number }

export const PRESSURE_WINDOW_MS = 5 * 60_000
export const DEFAULT_BLOCK_MS = 60_000
export const PRESSURE_FACTORS: Record<PressureLevel, number> = { normal: 1, near: 2, tight: 4, delayed: 8, blocked: 8 }

const TIGHT_SHARE = 0.25
const DECIMAL = /^\d+(\.\d+)?$/

interface OrgPressure {
  resumeAt: number
  delayedUntil: number
  nearUntil: number
  limit?: number
  remaining?: number
  last: PressureState['last']
}

export function readRateLimit(headers: Headers): RateLimitHeaders | null {
  const number = (name: string) => {
    const value = headers.get(name)?.trim()
    return value && DECIMAL.test(value) ? Number(value) : undefined
  }
  const ms = (seconds: number | undefined) => (seconds === undefined ? undefined : Math.round(seconds * 1000))
  const read: RateLimitHeaders = {
    resource: headers.get('x-ratelimit-resource')?.trim() || undefined,
    retryAfterMs: ms(number('retry-after')),
    delayMs: ms(number('x-ratelimit-delay')),
    limit: number('x-ratelimit-limit'),
    remaining: number('x-ratelimit-remaining'),
    resetAt: ms(number('x-ratelimit-reset')),
    cost: number('x-ratelimit-cost')
  }
  const present = Object.entries(read).filter(([, value]) => value !== undefined)
  return present.length === 0 ? null : (Object.fromEntries(present) as RateLimitHeaders)
}

export function createPressure(now: () => number): Pressure {
  const orgs = new Map<string, OrgPressure>()

  const observe: ResponseObserver = (req, status, headers) => {
    const read = readRateLimit(headers)
    if (!read && status !== 429) return
    const at = now()
    const org = orgs.get(req.org) ?? { resumeAt: 0, delayedUntil: 0, nearUntil: 0, last: null }
    const headersRead = read ?? {}
    if (status === 429 || headersRead.retryAfterMs !== undefined) {
      org.resumeAt = Math.max(org.resumeAt, at + (headersRead.retryAfterMs ?? DEFAULT_BLOCK_MS))
      org.delayedUntil = at + PRESSURE_WINDOW_MS
    }
    if ((headersRead.delayMs ?? 0) > 0) org.delayedUntil = at + PRESSURE_WINDOW_MS
    if (headersRead.limit !== undefined || headersRead.remaining !== undefined) {
      org.nearUntil = at + PRESSURE_WINDOW_MS
      org.limit = headersRead.limit ?? org.limit
      org.remaining = headersRead.remaining ?? org.remaining
    }
    org.last = { at, status, headers: headersRead }
    orgs.set(req.org, org)
  }

  function levelOf(org: OrgPressure, at: number): PressureLevel {
    if (at < org.resumeAt) return 'blocked'
    if (at < org.delayedUntil) return 'delayed'
    if (at >= org.nearUntil) return 'normal'
    return isTight(org) ? 'tight' : 'near'
  }

  function state(name: string): PressureState {
    const org = orgs.get(name)
    if (!org) return { level: 'normal', factor: PRESSURE_FACTORS.normal, resumeAt: 0, calmAt: 0, last: null }
    const level = levelOf(org, now())
    return { level, factor: PRESSURE_FACTORS[level], resumeAt: org.resumeAt, calmAt: calmAtOf(org, level), last: org.last }
  }

  return { observe, state, forget: org => void orgs.delete(org) }
}

export function paceOf(pressure: Pressure): Pace {
  return {
    factor: org => pressure.state(org).factor,
    resumeAt: org => pressure.state(org).resumeAt,
    calmAt: org => pressure.state(org).calmAt
  }
}

function calmAtOf(org: OrgPressure, level: PressureLevel): number {
  switch (level) {
    case 'blocked': return org.resumeAt
    case 'delayed': return org.delayedUntil
    case 'normal': return 0
    default: return org.nearUntil
  }
}

function isTight({ limit, remaining }: OrgPressure): boolean {
  if (remaining === undefined) return false
  return remaining === 0 || (limit !== undefined && remaining <= limit * TIGHT_SHARE)
}
