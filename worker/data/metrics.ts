import type { AdoRequest, ResponseObserver } from '../ado/http'
import { currentContext, type Feature } from './context'
import { readRateLimit, type PressureState, type RateLimitHeaders } from './rate-limit'

export interface MetricsReport {
  total: number; perMinute: number[]; byFeature: Partial<Record<Feature, number>>
  byEndpoint: { endpoint: string; count: number }[]; throttled: number; delayed: number
  cost: number | null; etags: string[]; last: { at: number; headers: RateLimitHeaders } | null
}
export interface Metrics { observe: ResponseObserver; report(org: string): MetricsReport; forget(org: string): void }

const MINUTE_MS = 60_000
const WINDOW_MINUTES = 5
const BUSIEST_SHOWN = 3
const SECONDS_SHOWN_BELOW_MS = 120_000
const DIGITS = /^\d+$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Bucket {
  total: number
  byFeature: Map<Feature, number>
  byEndpoint: Map<string, number>
  throttled: number
  delayed: number
  cost: number | null
  etags: Set<string>
}

interface OrgMetrics {
  buckets: Map<number, Bucket>
  last: MetricsReport['last']
}

export function endpointOf(req: AdoRequest): string {
  const segments = req.path.split('/')
  const path = segments
    .map((segment, index) => {
      if (index === 1 && segments[2] === '_apis') return '{team}'
      return DIGITS.test(segment) || GUID.test(segment) ? '{id}' : segment
    })
    .join('/')
  return `${req.method ?? 'GET'} ${req.host ? `${req.host} ` : ''}${path}`
}

export function createMetrics(now: () => number): Metrics {
  const orgs = new Map<string, OrgMetrics>()

  const observe: ResponseObserver = (req, status, headers) => {
    const at = now()
    const minute = minuteOf(at)
    const org = orgs.get(req.org) ?? { buckets: new Map(), last: null }
    for (const key of org.buckets.keys()) if (!inWindow(key, minute)) org.buckets.delete(key)
    const bucket = org.buckets.get(minute) ?? emptyBucket()
    const endpoint = endpointOf(req)
    const read = readRateLimit(headers)
    bucket.total += 1
    increment(bucket.byFeature, currentContext().feature)
    increment(bucket.byEndpoint, endpoint)
    if (status === 429) bucket.throttled += 1
    if ((read?.delayMs ?? 0) > 0) bucket.delayed += 1
    if (read?.cost !== undefined) bucket.cost = (bucket.cost ?? 0) + read.cost
    if (headers.has('etag')) bucket.etags.add(endpoint)
    if (read) org.last = { at, headers: read }
    org.buckets.set(minute, bucket)
    orgs.set(req.org, org)
  }

  function report(name: string): MetricsReport {
    const org = orgs.get(name)
    const current = minuteOf(now())
    const minutes = Array.from({ length: WINDOW_MINUTES }, (_, index) => current - WINDOW_MINUTES + 1 + index)
    const buckets = minutes.map(minute => org?.buckets.get(minute))
    const live = buckets.filter((bucket): bucket is Bucket => bucket !== undefined)
    const costs = live.map(bucket => bucket.cost).filter((cost): cost is number => cost !== null)
    return {
      total: sum(live.map(bucket => bucket.total)),
      perMinute: buckets.map(bucket => bucket?.total ?? 0),
      byFeature: Object.fromEntries(merged(live.map(bucket => bucket.byFeature))),
      byEndpoint: [...merged(live.map(bucket => bucket.byEndpoint))]
        .sort(byCountThenName)
        .map(([endpoint, count]) => ({ endpoint, count })),
      throttled: sum(live.map(bucket => bucket.throttled)),
      delayed: sum(live.map(bucket => bucket.delayed)),
      cost: costs.length === 0 ? null : sum(costs),
      etags: [...new Set(live.flatMap(bucket => [...bucket.etags]))].sort(),
      last: org?.last ?? null
    }
  }

  return { observe, report, forget: org => void orgs.delete(org) }
}

export function metricsLines(report: MetricsReport, pressure: PressureState, now: number): string[] {
  if (report.total === 0) return []
  const features = Object.entries(report.byFeature).sort(byCountThenName).map(([feature, count]) => `${feature} ${count}`)
  const busiest = report.byEndpoint.slice(0, BUSIEST_SHOWN).map(({ endpoint, count }) => `${endpoint} ${count}`)
  const lines = [
    `  Requests, last 5 min: ${report.total} (${features.join(', ')})`,
    `  Busiest: ${busiest.join(' · ')}`,
    `  Rate limit: ${rateLimitText(report.last, pressure, now)}`
  ]
  if (report.throttled > 0 || report.delayed > 0 || (report.cost ?? 0) > 0) {
    lines.push(`  Throttled ${report.throttled}, delayed ${report.delayed}, cost ${Number((report.cost ?? 0).toFixed(4))} TSTU`)
  }
  return lines
}

function rateLimitText(last: MetricsReport['last'], pressure: PressureState, now: number): string {
  if (!last && pressure.level === 'normal') return 'no pressure seen'
  const parts: string[] = [pressure.level]
  const { limit, remaining } = last?.headers ?? {}
  if (remaining !== undefined) parts.push(limit === undefined ? `${remaining} TSTU left` : `${remaining} of ${limit} TSTU left`)
  if (pressure.factor > 1) parts.push(`polling ×${pressure.factor}`)
  return last ? `${parts.join(', ')} (headers ${ageText(now - last.at)} ago)` : parts.join(', ')
}

function ageText(ms: number): string {
  const age = Math.max(0, ms)
  return age < SECONDS_SHOWN_BELOW_MS ? `${Math.round(age / 1000)} s` : `${Math.floor(age / MINUTE_MS)} min`
}

function minuteOf(at: number): number {
  return Math.floor(at / MINUTE_MS)
}

function inWindow(minute: number, current: number): boolean {
  return minute > current - WINDOW_MINUTES && minute <= current
}

function emptyBucket(): Bucket {
  return { total: 0, byFeature: new Map(), byEndpoint: new Map(), throttled: 0, delayed: 0, cost: null, etags: new Set() }
}

function increment<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function merged<K>(maps: Map<K, number>[]): Map<K, number> {
  const total = new Map<K, number>()
  for (const map of maps) for (const [key, count] of map) total.set(key, (total.get(key) ?? 0) + count)
  return total
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function byCountThenName([a, countA]: [string, number], [b, countB]: [string, number]): number {
  return countB - countA || a.localeCompare(b)
}
