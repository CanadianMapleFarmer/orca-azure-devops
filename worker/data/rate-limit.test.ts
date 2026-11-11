import { assert, test } from 'orca/testing'
import type { AdoRequest } from '../ado/http'
import { createPressure, DEFAULT_BLOCK_MS, paceOf, PRESSURE_FACTORS, PRESSURE_WINDOW_MS, readRateLimit, type Pressure } from './rate-limit'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const req: AdoRequest = { org: 'contoso', path: '/_apis/wit/wiql' }

function tracker() {
  const clock = { now: T0 }
  const pressure = createPressure(() => clock.now)
  const answer = (status: number, headers: Record<string, string> = {}) => pressure.observe(req, status, new Headers(headers))
  return { clock, pressure, answer }
}

function summary(pressure: Pressure, org = 'contoso') {
  const { level, factor, resumeAt } = pressure.state(org)
  return { level, factor, resumeAt }
}

test('readRateLimit reads every documented header and its units', () => {
  const headers = new Headers({ 'Retry-After': '7', 'X-RateLimit-Resource': 'ATCommonDb', 'X-RateLimit-Delay': '1.250', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '30', 'X-RateLimit-Reset': '1762855200', 'X-RateLimit-Cost': '0.01234' })
  assert.deepEqual(readRateLimit(headers), { retryAfterMs: 7000, resource: 'ATCommonDb', delayMs: 1250, limit: 200, remaining: 30, resetAt: 1762855200000, cost: 0.01234 })
})

test('readRateLimit returns null without rate-limit headers and ignores malformed values', () => {
  assert.equal(readRateLimit(new Headers({ 'content-type': 'application/json' })), null)
  assert.equal(readRateLimit(new Headers({ 'Retry-After': 'soon' })), null)
  assert.deepEqual(readRateLimit(new Headers({ 'Retry-After': 'soon', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '' })), { limit: 200 })
})

test('a 429 blocks the org until its Retry-After passes, then leaves it delayed', () => {
  const { clock, pressure, answer } = tracker()
  answer(429, { 'Retry-After': '7' })
  assert.deepEqual(summary(pressure), { level: 'blocked', factor: 8, resumeAt: T0 + 7000 })
  assert.equal(pressure.state('fabrikam').level, 'normal')

  clock.now = T0 + 7000
  assert.equal(pressure.state('contoso').level, 'delayed')
  clock.now = T0 + 300_000
  assert.equal(pressure.state('contoso').level, 'normal')
})

test('a 429 without Retry-After blocks for 60 seconds', () => {
  const { pressure, answer } = tracker()
  answer(429)
  assert.equal(pressure.state('contoso').resumeAt, T0 + 60_000)
  assert.equal(pressure.state('contoso').resumeAt, T0 + DEFAULT_BLOCK_MS)
  assert.deepEqual(pressure.state('contoso').last, { at: T0, status: 429, headers: {} })
})

test('Retry-After on a 200 holds the org until it passes, then leaves it delayed', () => {
  const { clock, pressure, answer } = tracker()
  answer(200, { 'Retry-After': '7' })
  assert.deepEqual(summary(pressure), { level: 'blocked', factor: 8, resumeAt: T0 + 7000 })

  clock.now = T0 + 7000
  assert.equal(pressure.state('contoso').level, 'delayed')
  clock.now = T0 + 300_000
  assert.equal(pressure.state('contoso').level, 'normal')
})

test('a shorter Retry-After never pulls resumeAt earlier', () => {
  const { clock, pressure, answer } = tracker()
  answer(429, { 'Retry-After': '30' })
  clock.now = T0 + 1000
  answer(200, { 'Retry-After': '2' })
  assert.equal(pressure.state('contoso').resumeAt, T0 + 30_000)
})

test('X-RateLimit-Delay marks the org delayed for five minutes from the last one seen', () => {
  const { clock, pressure, answer } = tracker()
  answer(200, { 'X-RateLimit-Delay': '0.5' })
  assert.deepEqual(summary(pressure), { level: 'delayed', factor: 8, resumeAt: 0 })

  clock.now = T0 + 4 * MINUTE
  answer(200, { 'X-RateLimit-Delay': '0.5' })
  clock.now = T0 + 5 * MINUTE
  assert.equal(pressure.state('contoso').level, 'delayed')
  clock.now = T0 + 9 * MINUTE - 1
  assert.equal(pressure.state('contoso').level, 'delayed')
  clock.now = T0 + 9 * MINUTE
  assert.equal(pressure.state('contoso').level, 'normal')
})

test('limit and remaining mark the org near, and tight at a quarter or less', () => {
  const { clock, pressure, answer } = tracker()
  answer(200, { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150' })
  assert.deepEqual(summary(pressure), { level: 'near', factor: 2, resumeAt: 0 })
  answer(200, { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '50' })
  assert.deepEqual(summary(pressure), { level: 'tight', factor: 4, resumeAt: 0 })
  answer(200, { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0' })
  assert.equal(pressure.state('contoso').level, 'tight')
  answer(200, { 'X-RateLimit-Remaining': '0' })
  assert.equal(pressure.state('contoso').level, 'tight')

  clock.now = T0 + PRESSURE_WINDOW_MS
  assert.equal(pressure.state('contoso').level, 'normal')
})

test('X-RateLimit-Delay of zero is not pressure', () => {
  const { pressure, answer } = tracker()
  answer(200, { 'X-RateLimit-Delay': '0' })
  assert.deepEqual(summary(pressure), { level: 'normal', factor: 1, resumeAt: 0 })
})

test('calmAt is when the level next drops', () => {
  const { clock, pressure, answer } = tracker()
  assert.equal(pressure.state('contoso').calmAt, 0)

  answer(429, { 'Retry-After': '30', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150' })
  assert.equal(pressure.state('contoso').calmAt, T0 + 30_000)
  clock.now = T0 + 30_000
  assert.equal(pressure.state('contoso').calmAt, T0 + PRESSURE_WINDOW_MS)

  clock.now = T0 + MINUTE
  answer(200, { 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '150' })
  clock.now = T0 + PRESSURE_WINDOW_MS
  assert.equal(pressure.state('contoso').level, 'near')
  assert.equal(pressure.state('contoso').calmAt, T0 + MINUTE + PRESSURE_WINDOW_MS)
  clock.now = T0 + MINUTE + PRESSURE_WINDOW_MS
  assert.equal(pressure.state('contoso').calmAt, 0)
})

test('the strongest live signal wins', () => {
  const { pressure, answer } = tracker()
  answer(200, { 'X-RateLimit-Delay': '2', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '0' })
  assert.equal(pressure.state('contoso').level, 'delayed')
  assert.deepEqual(pressure.state('contoso').last, { at: T0, status: 200, headers: { delayMs: 2000, limit: 200, remaining: 0 } })
})

test('a response without rate-limit headers leaves the org untouched', () => {
  const { pressure, answer } = tracker()
  answer(200, { 'content-type': 'application/json' })
  answer(404)
  assert.deepEqual(pressure.state('contoso'), { level: 'normal', factor: 1, resumeAt: 0, calmAt: 0, last: null })
})

test('forget clears an org', () => {
  const { pressure, answer } = tracker()
  answer(429, { 'Retry-After': '7' })
  pressure.observe({ org: 'fabrikam', path: '/_apis/projects' }, 429, new Headers())
  pressure.forget('contoso')
  assert.deepEqual(pressure.state('contoso'), { level: 'normal', factor: 1, resumeAt: 0, calmAt: 0, last: null })
  assert.equal(pressure.state('fabrikam').level, 'blocked')
})

test('paceOf exposes factor, resumeAt and calmAt', () => {
  const { clock, pressure, answer } = tracker()
  const pace = paceOf(pressure)
  assert.equal(pace.factor('contoso'), 1)
  assert.equal(pace.resumeAt('contoso'), 0)
  assert.equal(pace.calmAt('contoso'), 0)

  answer(429, { 'Retry-After': '7' })
  assert.equal(pace.factor('contoso'), PRESSURE_FACTORS.blocked)
  assert.equal(pace.resumeAt('contoso'), T0 + 7000)
  assert.equal(pace.calmAt('contoso'), T0 + 7000)
  clock.now = T0 + 7000
  assert.equal(pace.factor('contoso'), PRESSURE_FACTORS.delayed)
  assert.equal(pace.calmAt('contoso'), T0 + PRESSURE_WINDOW_MS)
  assert.equal(pace.factor('fabrikam'), PRESSURE_FACTORS.normal)
})
