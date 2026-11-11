import { assert, test } from 'orca/testing'
import { AdoError, type AdoHttp, type AdoRequest } from '../ado/http'
import { membershipWiql, stillInWiql } from '../ado/workitems'
import { AUDIT_EVERY_MS, syncView, type SyncScope, type SyncState } from './sync'

const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
const CLAUSE = '[System.AssignedTo] = @Me'
const SCOPE: SyncScope = { org: 'contoso', projectId: PROJECT, teamId: TEAM, clause: CLAUSE }
const WATERMARK = '2026-11-11T10:00:00.000Z'
const AS_OF = '2026-11-11T10:01:00.000Z'
const NOW = Date.parse('2026-11-11T10:01:00Z')
const MINUTE = 60_000
const PRECISION = 'You cannot supply a time with the date when running a query using date precision.'

function scripted(...answers: unknown[]) {
  const requests: AdoRequest[] = []
  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      requests.push(req)
      if (answers.length === 0) throw new Error(`no answer for request ${requests.length}`)
      const next = answers.shift()
      if (next instanceof Error) throw next
      return { data: next as T, headers: new Headers() }
    }
  }
  return { http, requests }
}

function wiql(ids: number[], asOf = AS_OF) {
  return { asOf, workItems: ids.map(id => ({ id })) }
}

function revs(pairs: [number, number | null][]) {
  return { value: pairs.map(([id, rev]) => (rev === null ? null : { id, rev, fields: { 'System.Id': id }, url: '' })) }
}

function revsOf(pairs: Record<number, number>) {
  return (id: number) => pairs[id]
}

function state(over: Partial<SyncState> = {}): SyncState {
  return { clause: CLAUSE, members: [1, 2, 3], watermark: WATERMARK, auditedAt: NOW - MINUTE, audits: 1, precision: 'time', ...over }
}

const queryOf = (req: AdoRequest) => (req.body as { query: string }).query
const unknown = () => undefined
const at = (time: number) => () => time

test('the first sync audits with one query and no revision read when the store is empty', async () => {
  const { http, requests } = scripted(wiql([1, 2, 3]))
  const result = await syncView(http, SCOPE, null, [], unknown, at(NOW))
  assert.equal(requests.length, 1)
  assert.equal(queryOf(requests[0]), membershipWiql(CLAUSE))
  assert.equal(requests[0].query?.timePrecision, undefined)
  assert.deepEqual(result, {
    members: [1, 2, 3],
    stale: new Set([1, 2, 3]),
    gone: [],
    state: { clause: CLAUSE, members: [1, 2, 3], watermark: AS_OF, auditedAt: NOW, audits: 1, precision: 'time' }
  })
})

test('an audit reads revisions over members and known ids and marks only changed or unknown ones stale', async () => {
  const { http, requests } = scripted(wiql([1, 2, 3]), revs([[1, 5], [2, 4], [3, 1], [50, 3]]))
  const result = await syncView(http, SCOPE, null, [1, 2, 50], revsOf({ 1: 5, 2: 3, 50: 2 }), at(NOW))
  assert.deepEqual(requests[1].body, { ids: [1, 2, 3, 50], fields: ['System.Id'], errorPolicy: 'omit' })
  assert.deepEqual(result.stale, new Set([2, 3, 50]))
  assert.deepEqual([result.members, result.gone], [[1, 2, 3], []])
})

test('an audit drops known ids that the revision read omits', async () => {
  const { http } = scripted(wiql([1, 2]), revs([[1, 5], [2, null], [50, null]]))
  const result = await syncView(http, SCOPE, null, [1, 2, 50], revsOf({ 1: 5, 2: 3, 50: 2 }), at(NOW))
  assert.deepEqual(result.gone, [2, 50])
  assert.deepEqual(result.members, [1])
  assert.deepEqual(result.state.members, [1])
  assert.deepEqual(result.stale, new Set())
})

test('a quiet delta costs one request and advances the watermark', async () => {
  const { http, requests } = scripted(wiql([]))
  const previous = state()
  const result = await syncView(http, SCOPE, previous, [1, 2, 3], revsOf({ 1: 1, 2: 1, 3: 1 }), at(NOW))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].query?.timePrecision, true)
  assert.ok(queryOf(requests[0]).includes("'2026-11-11T09:59:50.000Z'"), queryOf(requests[0]))
  assert.deepEqual(result, { members: [1, 2, 3], stale: new Set(), gone: [], state: { ...previous, watermark: AS_OF } })
})

test('a new id in the delta joins the view without another query', async () => {
  const { http, requests } = scripted(wiql([9]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3], unknown, at(NOW))
  assert.equal(requests.length, 1)
  assert.deepEqual(result.members, [1, 2, 3, 9])
  assert.deepEqual(result.stale, new Set([9]))
  assert.deepEqual(result.state.members, [1, 2, 3, 9])
})

test('a member that changed is re-checked and leaves the view when it no longer matches', async () => {
  const { http, requests } = scripted(wiql([2, 9]), wiql([]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3], unknown, at(NOW))
  assert.equal(requests.length, 2)
  assert.equal(queryOf(requests[1]), stillInWiql(CLAUSE, [2]))
  assert.ok(queryOf(requests[1]).includes('[System.TeamProject] = @project'))
  assert.equal(requests[1].query?.timePrecision, undefined)
  assert.deepEqual(result.members, [1, 3, 9])
  assert.deepEqual(result.stale, new Set([2, 9]))
  assert.deepEqual(result.state, { ...state(), members: [1, 3, 9], watermark: AS_OF })
})

test('a member that changed and still matches stays in the view', async () => {
  const { http } = scripted(wiql([2]), wiql([2]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3], unknown, at(NOW))
  assert.deepEqual(result.members, [1, 2, 3])
  assert.deepEqual(result.stale, new Set([2]))
})

test("a known non-member that changes but still doesn't match stays out", async () => {
  const { http, requests } = scripted(wiql([40]), wiql([]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3, 40], unknown, at(NOW))
  assert.equal(requests.length, 2)
  assert.equal(queryOf(requests[1]), stillInWiql(CLAUSE, [40]))
  assert.deepEqual(result.members, [1, 2, 3])
  assert.deepEqual(result.stale, new Set([40]))
})

test('one re-check lets a known non-member that now matches join and a member that no longer matches leave', async () => {
  const { http, requests } = scripted(wiql([40, 2, 9]), wiql([40]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3, 40, 41], unknown, at(NOW))
  assert.equal(requests.length, 2)
  assert.equal(queryOf(requests[1]), stillInWiql(CLAUSE, [40, 2]))
  assert.deepEqual(result.members, [1, 3, 40, 9])
  assert.deepEqual(result.state.members, [1, 3, 40, 9])
  assert.deepEqual(result.stale, new Set([40, 2, 9]))
})

test('a day-precision delta re-checks a known non-member whose revision changed', async () => {
  const { http, requests } = scripted(wiql([40, 41]), revs([[40, 2], [41, 5]]), wiql([40]))
  const result = await syncView(http, SCOPE, state({ precision: 'day' }), [1, 2, 3, 40, 41], revsOf({ 40: 1, 41: 5 }), at(NOW))
  assert.equal(requests.length, 3)
  assert.equal(queryOf(requests[2]), stillInWiql(CLAUSE, [40]))
  assert.deepEqual(result.members, [1, 2, 3, 40])
  assert.deepEqual(result.stale, new Set([40]))
})

test('a date-precision 400 switches the view to day precision with a revision check', async () => {
  const { http, requests } = scripted(new AdoError('bad_request', 400, PRECISION), wiql([2, 3]), revs([[2, 4], [3, 1]]), wiql([2]))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3], revsOf({ 1: 1, 2: 3, 3: 1 }), at(NOW))
  assert.equal(requests.length, 4)
  assert.equal(requests[0].query?.timePrecision, true)
  assert.ok(queryOf(requests[1]).includes('[System.ChangedDate] >= @Today - 1 AND'), queryOf(requests[1]))
  assert.equal(requests[1].query?.timePrecision, undefined)
  assert.deepEqual(requests[2].body, { ids: [2, 3], fields: ['System.Id'], errorPolicy: 'omit' })
  assert.equal(queryOf(requests[3]), stillInWiql(CLAUSE, [2]))
  assert.deepEqual(result.stale, new Set([2]))
  assert.deepEqual(result.members, [1, 2, 3])
  assert.equal(result.state.precision, 'day')
  assert.equal(result.state.watermark, AS_OF)

  const next = scripted(wiql([]))
  const quiet = await syncView(next.http, SCOPE, result.state, [1, 2, 3], revsOf({ 1: 1, 2: 4, 3: 1 }), at(NOW + MINUTE))
  assert.equal(next.requests.length, 1, 'an empty day answer needs no revision read')
  assert.ok(queryOf(next.requests[0]).includes('@Today - 1'))
  assert.equal(next.requests[0].query?.timePrecision, undefined)
  assert.equal(quiet.state.precision, 'day')
})

test('day precision drops the known ids the revision read omits and skips unchanged revisions', async () => {
  const { http } = scripted(wiql([2, 3, 8]), revs([[2, 3], [3, null], [8, null]]))
  const result = await syncView(http, SCOPE, state({ precision: 'day' }), [1, 2, 3], revsOf({ 1: 1, 2: 3, 3: 1 }), at(NOW))
  assert.deepEqual(result.gone, [3])
  assert.deepEqual(result.members, [1, 2])
  assert.deepEqual(result.stale, new Set())
})

test('any other 400 fails the sync and keeps time precision', async () => {
  const refused = new AdoError('bad_request', 400, 'TF51005: The query references a field that does not exist.')
  const { http, requests } = scripted(refused)
  const previous = state()
  await assert.rejects(syncView(http, SCOPE, previous, [1, 2, 3], unknown, at(NOW)), refused)
  assert.equal(requests.length, 1)
  assert.deepEqual(previous, state())

  const next = scripted(wiql([]))
  await syncView(next.http, SCOPE, previous, [1, 2, 3], unknown, at(NOW))
  assert.equal(next.requests[0].query?.timePrecision, true)
})

test('a changed clause resets the state and audits', async () => {
  const clause = "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed')"
  const { http, requests } = scripted(wiql([4, 5]))
  const result = await syncView(http, { ...SCOPE, clause }, state({ audits: 3, precision: 'day', auditedAt: NOW }), [], unknown, at(NOW))
  assert.equal(queryOf(requests[0]), membershipWiql(clause))
  assert.deepEqual(result.state, { clause, members: [4, 5], watermark: AS_OF, auditedAt: NOW, audits: 1, precision: 'time' })
})

test('an answer at $top makes the next sync an audit', async () => {
  const many = Array.from({ length: 500 }, (_, index) => 1000 + index)
  const { http } = scripted(wiql(many))
  const result = await syncView(http, SCOPE, state(), [1, 2, 3], unknown, at(NOW))
  assert.equal(result.state.auditedAt, -Infinity)
  assert.equal(result.members.length, 503)

  const next = scripted(wiql([1, 2]))
  await syncView(next.http, SCOPE, result.state, result.members, unknown, at(NOW + MINUTE))
  assert.equal(queryOf(next.requests[0]), membershipWiql(CLAUSE))
})

test('audits come every 15 minutes, and every fourth audit marks every member stale', async () => {
  const same = revsOf({ 1: 1, 2: 1, 3: 1 })
  const unchanged = () => revs([[1, 1], [2, 1], [3, 1]])

  const early = scripted(wiql([]))
  await syncView(early.http, SCOPE, state({ audits: 2, auditedAt: NOW - AUDIT_EVERY_MS + 1 }), [1, 2, 3], same, at(NOW))
  assert.equal(early.requests[0].query?.timePrecision, true, 'a delta before 15 minutes')

  const due = scripted(wiql([1, 2, 3]), unchanged())
  const third = await syncView(due.http, SCOPE, state({ audits: 2, auditedAt: NOW - AUDIT_EVERY_MS }), [1, 2, 3], same, at(NOW))
  assert.equal(queryOf(due.requests[0]), membershipWiql(CLAUSE))
  assert.deepEqual([third.state.audits, third.state.auditedAt, third.stale], [3, NOW, new Set()])

  const deep = scripted(wiql([1, 2, 3]), unchanged())
  const fourth = await syncView(deep.http, SCOPE, { ...third.state, auditedAt: NOW - AUDIT_EVERY_MS }, [1, 2, 3], same, at(NOW))
  assert.equal(fourth.state.audits, 4)
  assert.deepEqual(fourth.stale, new Set([1, 2, 3]))
})

test('more than 1,500 known ids skips the delta and audits', async () => {
  const known = Array.from({ length: 1501 }, (_, index) => 5000 + index)
  const { http, requests } = scripted(wiql([1, 2, 3]))
  await syncView(http, SCOPE, state({ auditedAt: NOW }), known, unknown, at(NOW))
  assert.equal(requests.length, 1)
  assert.equal(queryOf(requests[0]), membershipWiql(CLAUSE))
})

test("the next delta starts at the server's asOf, not the local clock", async () => {
  const local = at(Date.parse('2026-11-11T12:00:00Z'))
  const first = scripted(wiql([1], '2026-11-11T10:00:00.000Z'))
  const audited = await syncView(first.http, SCOPE, null, [], unknown, local)
  assert.equal(audited.state.watermark, '2026-11-11T10:00:00.000Z')

  const next = scripted(wiql([]))
  await syncView(next.http, SCOPE, audited.state, [1], unknown, local)
  assert.equal(next.requests[0].query?.timePrecision, true)
  assert.ok(queryOf(next.requests[0]).includes("[System.ChangedDate] >= '2026-11-11T09:59:50.000Z' AND"), queryOf(next.requests[0]))
})
