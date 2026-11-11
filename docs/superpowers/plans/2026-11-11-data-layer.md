# Data layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the plugin's Azure DevOps requests by roughly an order of magnitude and make start-up and tab switches instant. Five parts:
- a per-org request governor
- a shared entity store
- work-item delta sync
- persisted last-known views
- budget-aware cadences

**Architecture:**
- Every request goes through a per-org governor. It holds back background work under pressure, merges duplicates, and always sends the user's own requests first. A pressure tracker feeds it by reading ADO's rate-limit headers on every response.
- The scheduler paces every org job by that pressure and by a quiet back-off. It runs each job in a `visible` or `hidden` lane, so the governor knows how urgent each request is.
- Features read and write one entity store, and views are projections of it.
- Work items sync by delta WIQL.
- PR chips reuse the PRs service's data.
- The last views persist to `orca.storage`, within a strict budget.

**Tech Stack:** TypeScript loaded build-less by Orca (`engines.orca >=1.4.248`), Node 24 worker, `orca/testing` (node:test), `node:async_hooks` `AsyncLocalStorage`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-data-layer-design.md`. Read it, and `docs/research/2026-11-11-request-inventory.md`, before starting. Section numbers below (§5.5 and so on) refer to the spec.

**Revision:** 2026-11-11. This revision applies an independent builder check and the lead's three provisional calls (spec §10, items 5–7). Tasks keep their numbers as stable ids, but **appear below in the order they run**.

## Global Constraints

**Comments**
- Code explains itself. The default is **zero comments**, including in code you copy from this plan.
- A single one-line comment is allowed only for a constraint the code cannot express.
- No narrative comments, no investigation history.
- JSDoc summaries are at most 2 lines.

**Structure and style.** Match the existing code:
- small modules
- dependency-injected `deps` objects
- `now: () => number` and `Clock` injected for all time
- fakes and fixtures in tests (`worker/test-support.ts`, `worker/boards/fake-ado.ts`, `worker/pipelines/fake-pipelines.ts`, `worker/prs/fake-prs.ts`)

**TDD.** Each task's tests are written first and seen failing. `orca plugin test .` runs every test file; there is no filter. Read the named test in the output.

**Green after every task.** Run `npm install` first if `node_modules` is missing. Then:
- `npm run typecheck` (exit 0)
- `orca plugin test . --json` (`"ok": true`)
- `orca plugin check . --json` (exit 0)
- `orca plugin validate . --json` (exit 0)

Every task lists the existing tests it breaks. Rewrite them in that task, so it ends green.

**Dependencies and Orca API**
- No new runtime dependencies. `AsyncLocalStorage` comes from `node:async_hooks`.
- No new manifest capabilities. `storage:own` is already granted, and `orca.storage` has `get`, `set`, `delete` and `keys`.

**Panel budgets.** Every view posted or answered still goes through the existing cap functions:
- `capSnapshot`, `capBoard`, `capPrSnapshot`, `capRunsSnapshot`
- `POST_BUDGET_BYTES` 240 KiB and `ANSWER_BUDGET_BYTES` 900 KiB from `worker/budget.ts`

**Your own writes.** `worker/boards/recent.ts` and its overlay stay. A user's move, comment, link, vote or approval must never be replaced by an older poll.

**Clicks always work.** The governor never fails or holds a request made in a `user` lane.

**Auth.** Saved data is served only to a connected org whose pinned `account.adoId` equals the saved `account`. `unauthorized` errors are never swallowed.

**Persisted cache budgets**
- Prefix `adoCache:v1:`.
- At most 160 KiB per value and 1.5 MiB in total.
- At most one write per key per 60 s, the index key included.

**Copy.** The saved-data message is exactly: `Showing what was saved last time. Refreshing…`

**Generic.** No org, project, team or account names outside test fixtures. Fixtures use `contoso` and `fabrikam`.

**Docs.** Code tasks do not edit `docs/`. Task 17 makes every docs change in one pass at the end.

**Shared fakes.** Only these tasks may edit a shared fake. Any other task uses the fake's existing overrides (`ado.on(match, respond)`).

| Shared fake or fixture | Tasks allowed to edit it |
| --- | --- |
| `worker/boards/fake-ado.ts` | 6, 7 |
| `worker/prs/fake-prs.ts` | 7, 10, 11 |
| `worker/pipelines/fake-pipelines.ts` | 10, 12 |
| `worker/test-support.ts` | 3, 8 |
| `worker/ado/fixtures/pull-request*.json` | 7 |

**Commits**
- One commit per task, with an imperative subject in the repo's style ("Keep hidden boards and serve them at once").
- Use the local git identity and end with the session's `Co-Authored-By` trailer.
- Never commit `node_modules/` or `.orca/`. Do not push.

## Review Focus

1. **A different account signs in after a restart.** Account A's saved Work view must never be shown to account B. *Tests: Task 8, `a saved view comes back for the same account and not for another` and `a saved Work snapshot from another account or another boards target is ignored`.*
2. **The laptop clock is minutes off from ADO's.** The delta watermark must come from ADO's `asOf`, never from the local clock. *Test: Task 6, `the next delta starts at the server's asOf, not the local clock`.*
3. **A delta tick reads an older `rev` from a lagging replica right after the user moved a card.** The card must stay where the user put it. *Tests: Task 5, `the rev rule keeps the newer record and never trades relations away`; Task 6, `items returns the record the store kept, not an older one it fetched` and `the user's move survives a delta that returns the older rev`.*
4. **`orca.storage` is already near its 5 MiB cliff from other plugin data.** The cache must evict, never grow. *Test: Task 8, `saving past 1.5 MiB evicts the least recently used entries first`.*
5. **ADO answers 429 with `Retry-After: 30` while the user presses Refresh.** The Refresh must still be sent, ahead of everything else. Background jobs must neither start nor send until the 30 s have passed. *Tests: Task 2, `while blocked, user requests are still sent first and background requests wait without holding a slot`; Task 3, `an org job waits out its org's resumeAt`.*

---

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `worker/data/rate-limit.ts` | Parse rate-limit headers; per-org pressure level, factor and `resumeAt`; `paceOf` | 1 |
| `worker/data/context.ts` | `AsyncLocalStorage` context: feature and lane; `fly` and `join`; request-name and job-key mapping; `withUserContext` | 2 |
| `worker/data/governor.ts` | Per-org queue: tiers, background slots, merging, holding while blocked, raising | 2 |
| `worker/data/metrics.ts` | Per-org request counts, endpoints, rate-limit headers; status lines | 14 |
| `worker/poll/scheduler.ts` | Pace by org, lanes, quiet back-off with cap, idle-when-hidden | 3 |
| `worker/boards/board-filters.ts` | Each board's remembered Me / Everyone choice | 15 |
| `worker/data/freshness.ts` | Every freshness window and table size in one place | 5 |
| `worker/data/records.ts` | `ItemRecord`, `PrRecord`, `CheckRecord`, `prKey`, `reviewersSignature` | 5 |
| `worker/data/entities.ts` | Per-org typed tables: guard, LRU, single-flight `read`, `watch` | 5 |
| `worker/boards/sync.ts` | Delta and audit sync of one view's membership | 6 |
| `worker/data/persist.ts` | Versioned, budgeted, debounced persistence of last-known views | 8 |
| `src/board/age.ts` | Relative age text for the board editor | 16 |
| `worker/data/heat.ts` | Hot and cold project rotation | 10 |
| `worker/prs/thread-cadence.ts` | Per-PR thread re-read back-off | 11 |

Tests sit beside their files as `*.test.ts`.

## Order, dependencies and parallel safety

"Files shared with" lists every other task that edits the same file, docs excluded (Task 17 owns all docs). Two tasks are **parallel-safe** only when neither depends on the other and their file sets are disjoint.

| # | Task | Depends on | Files shared with | Parallel-safe with |
| --- | --- | --- | --- | --- |
| 1 | Rate-limit signals and per-org pressure | — | 5 (`connections.ts`, `connections.test.ts`) | — |
| 2 | Request context and the governor | 1 | 3, 5, 8, 9, 14 (`main.ts`) | — |
| 14 | Request metrics in Connection status | 1, 2 | 2, 3, 5, 8, 9 (`main.ts`); 3 (`main.test.ts`) | — |
| 3 | Scheduler pacing, lanes, quiet back-off | 1, 2, 14 (files) | 4–13 (services, jobs) | — |
| 4 | Keep hidden boards; Work idles while hidden | 3 | 5–8, 15, 16 | — |
| 15 | Remember each board's filter | 4 | 5–8, 16 (`boards/service.ts`); 16 (`src/protocol.ts`, `src/board/board.ts`) | — |
| 5 | Entity store; move config, state, project and wiki caches | 2, 4, 15 (files) | 6–13 | — |
| 6 | Delta sync of work items | 4, 5 | 7, 8, 16 | 13 |
| 13 | Run view cadence | 3, 5 | 3, 5 (`run-views.ts`, both earlier); no later task | 6, 7, 8, 9, 10, 11, 16 |
| 7 | PR records and checks in the store; chips reuse them | 5, 6 | 8, 10, 11, 16 | 13 |
| 8 | Persist Work, board, meta and PR records | 6, 7 | 9, 16 | 13 |
| 16 | Board age in the editor | 8, 15 | 4, 6, 8, 15 (`board-views.ts`, `boards/service.ts`, `src/protocol.ts`, `src/board/*`, all earlier); no later task | 9, 13 |
| 9 | Persist the PRs and Pipelines views | 8 | 10, 11, 12 | 13, 16 |
| 10 | Hot and cold projects | 5, 9 (files) | 11, 12 | 13 |
| 11 | PRs cadence | 7, 10 | 3, 5, 7, 9, 10 (`prs/*`, all earlier); no later task | 12, 13 |
| 12 | Pipelines cadence | 5, 10, 13 | 3, 5, 9, 10 (`pipelines/load.ts`, `pipelines/service.ts`, all earlier); no later task | 11 |
| 17 | Docs pass | all | — | — |

**Waves.** Run these one after another. Inside a wave, the listed tasks are parallel-safe.

1. 1
2. 2
3. 14
4. 3
5. 4
6. 15
7. 5
8. 6 and 13 (13 may also overlap waves 9–12, as long as it finishes before 12)
9. 7
10. 8
11. 16 and 9
12. 10
13. 11 and 12
14. 17

Task 14 runs early on purpose: the status command then records a "before" baseline while tasks 3–13 land.

---

### Task 1: Rate-limit signals and per-org pressure

**Goal:** Every raw ADO response, including 429s that `http.ts` retries internally, reaches one per-org pressure tracker. Nothing acts on the tracker yet.

**Files:**
- Create: `worker/data/rate-limit.ts`, `worker/data/rate-limit.test.ts`
- Modify: `worker/ado/http.ts` (`AdoHttpDeps.observe`, called after every `send`), `worker/ado/http.test.ts`
- Modify: `worker/connections.ts` (`ConnectionsDeps.observe?`, passed to both `createAdoHttp` calls: `http.json` and `identify`), `worker/connections.test.ts`

**Interfaces**

`worker/ado/http.ts` exports `ResponseObserver`, and `AdoHttpDeps` gains `observe?: ResponseObserver` next to its existing fields:
```ts
export type ResponseObserver = (req: AdoRequest, status: number, headers: Headers) => void
```

`worker/data/rate-limit.ts`:
```ts
export interface RateLimitHeaders { resource?: string; retryAfterMs?: number; delayMs?: number; limit?: number; remaining?: number; resetAt?: number; cost?: number }
export type PressureLevel = 'normal' | 'near' | 'tight' | 'delayed' | 'blocked'
export interface PressureState { level: PressureLevel; factor: number; resumeAt: number; last: { at: number; status: number; headers: RateLimitHeaders } | null }
export interface Pressure { observe: ResponseObserver; state(org: string): PressureState; forget(org: string): void }
export interface Pace { factor(org: string): number; resumeAt(org: string): number }
export const PRESSURE_WINDOW_MS = 5 * 60_000
export const DEFAULT_BLOCK_MS = 60_000
export const PRESSURE_FACTORS: Record<PressureLevel, number> = { normal: 1, near: 2, tight: 4, delayed: 8, blocked: 8 }
export function readRateLimit(headers: Headers): RateLimitHeaders | null
export function createPressure(now: () => number): Pressure
export function paceOf(pressure: Pressure): Pace
```

**Rules (spec §5.2):**
- A **429** sets `resumeAt = max(resumeAt, now + (retryAfterMs ?? DEFAULT_BLOCK_MS))` and `delayedUntil = now + PRESSURE_WINDOW_MS`.
- **`Retry-After` on any status**, a 200 included, sets `resumeAt = max(resumeAt, now + retryAfterMs)` and `delayedUntil = now + PRESSURE_WINDOW_MS`.
- **`X-RateLimit-Delay`** sets `delayedUntil = now + PRESSURE_WINDOW_MS`.
- **`X-RateLimit-Limit` or `X-RateLimit-Remaining`** sets `nearUntil = now + PRESSURE_WINDOW_MS`. The level is *tight* while the last `remaining` is ≤ 25% of the last `limit`, or is 0.
- The **level** is the strongest of: `blocked` (now < resumeAt), `delayed`, `tight`, `near`, `normal`.
- `resumeAt` starts at 0.
- `last` keeps the most recent response that carried any rate-limit header, or was a 429.

- [ ] **Step 1: Write the failing tests** in `worker/data/rate-limit.test.ts`. Use `T0 = Date.parse('2026-11-11T10:00:00Z')`, a mutable clock, and `req = { org: 'contoso', path: '/_apis/wit/wiql' }`.
  - `readRateLimit reads every documented header and its units`:
    ```ts
    const headers = new Headers({ 'Retry-After': '7', 'X-RateLimit-Resource': 'ATCommonDb', 'X-RateLimit-Delay': '1.250', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '30', 'X-RateLimit-Reset': '1762855200', 'X-RateLimit-Cost': '0.01234' })
    assert.deepEqual(readRateLimit(headers), { retryAfterMs: 7000, resource: 'ATCommonDb', delayMs: 1250, limit: 200, remaining: 30, resetAt: 1762855200000, cost: 0.01234 })
    ```
  - `readRateLimit returns null without rate-limit headers and ignores malformed values`. Use `content-type` only → `null`, and `Retry-After: soon` alone → `null`.
  - `a 429 blocks the org until its Retry-After passes, then leaves it delayed`:
    - A 429 with `Retry-After: 7`: `state('contoso')` is `{ level: 'blocked', factor: 8, resumeAt: T0 + 7000 }`, and `state('fabrikam').level` is `'normal'`.
    - At `T0 + 7000` the level is `'delayed'`. At `T0 + 300_000` it is `'normal'`.
  - `a 429 without Retry-After blocks for 60 seconds`: `resumeAt === T0 + 60_000`.
  - `Retry-After on a 200 holds the org until it passes, then leaves it delayed`: a 200 with `Retry-After: 7` gives `level 'blocked'` and `resumeAt T0 + 7000`. At `T0 + 7000` the level is `'delayed'`. At `T0 + 300_000` it is `'normal'`.
  - `X-RateLimit-Delay marks the org delayed for five minutes from the last one seen`:
    - The level is `'delayed'` (factor 8).
    - Another delay at +4 min extends it.
    - 5 min after the last one, the level is `'normal'`.
  - `limit and remaining mark the org near, and tight at a quarter or less`: 150/200 → `near` (2); 50/200 → `tight` (4); 0/200 → `tight`.
  - `the strongest live signal wins`: delay plus limit headers → `'delayed'`.
  - `forget clears an org`.
  - `paceOf exposes factor and resumeAt`.

  In `worker/ado/http.test.ts`:
  - `observe hears every response, including throttled ones that are retried`: fake fetch answers 429 (`retry-after: 1`), then 200, and `sleep` is stubbed. `observe` receives statuses `[429, 200]` with the request's `org` and `path`.
  - `observe hears an error response before it is thrown`: a 404 is observed, then `not_found` is thrown.

  In `worker/connections.test.ts`, using the file's existing connected-org setup:
  - `the observer given to connections hears the org's responses`.
- [ ] **Step 2: Run the tests and see them fail.** `orca plugin test . --json`. Expected: the new tests fail (module not found / observe not called).
- [ ] **Step 3: Implement `readRateLimit`, `createPressure` and `paceOf`.** Header names are case-insensitive through `Headers`.
- [ ] **Step 4: Wire the observer.** In `http.ts`, call `deps.observe?.(req, res.status, res.headers)` right after each `send` resolves. Add `observe?: ResponseObserver` to `ConnectionsDeps` and pass it into both `createAdoHttp` calls.
- [ ] **Step 5: Run the tests and see them pass.**
- [ ] **Step 6: Verify** with the four Global Constraints commands.
- [ ] **Step 7: Commit.** `git commit -m "Read Azure DevOps rate-limit headers on every response"`

---

### Task 2: Request context and the governor

**Goal:** Every service talks to ADO through one per-org governor.
- Panel requests run in a `user` lane, tagged with their feature.
- Identical reads in flight share one request.
- Background requests are held while the org is blocked; user requests never are.

This task changes no behaviour except the concurrency cap. Until Task 3, timer runs inherit whatever context was active when they were scheduled, so most traffic still counts as `user`. Task 2 makes no claim about scheduler lanes.

**Files:**
- Create: `worker/data/context.ts`, `worker/data/context.test.ts`, `worker/data/governor.ts`, `worker/data/governor.test.ts`
- Modify `worker/main.ts`:
  1. Create `const pressure = createPressure(Date.now)` before `createConnections`, and pass `observe: pressure.observe`.
  2. Create `const governor = createGovernor({ http: connections.http, pressure, now: Date.now, clock: realClock })`.
  3. Rename the old import to `import { createPressure as createSlowDown } from './pipelines/pressure'` and create `const slowDown = createSlowDown(Date.now)`.
  4. Replace `pressure.wrapByOrg(connections.http)` with `slowDown.wrapByOrg(governor)`. This keeps the old cross-feature slow-down working until Task 3, so `main.test.ts`'s "a rate-limit header on a pull request answer slows the Pipelines tab of that org too" stays green.
  5. Give `pipelines` and `runViews` `http: governor` and `pressure: slowDown`.
  6. Register every handler through `const host = withUserContext(orca)`, passing `host` to `registerWorkspaceHandlers`, `registerOrgHandlers`, `registerWorkHandlers`, `registerPrHandlers`, `registerReviewHandlers`, `registerWikiHandlers`, `registerPipelineHandlers`, `registerShareHandlers`, `registerVisibilityHandler`, and `host.panels.handle('plugin.ping', …)`.

**Interfaces**

`worker/data/context.ts`:
```ts
export type Feature = 'work' | 'board' | 'prs' | 'reviews' | 'pipelines' | 'run' | 'wiki' | 'share' | 'connect' | 'other'
export type Priority = 'user' | 'visible' | 'hidden'
export interface Lane { readonly priority: Priority }
export interface RequestContext { readonly feature: Feature; readonly lane: Lane }
export interface Flight<T> { readonly promise: Promise<T>; readonly lane: Lane }
export function inLane<T>(feature: Feature, priority: Priority, run: () => T): T
export function runIn<T>(context: RequestContext, run: () => T): T
export function currentContext(): RequestContext
export function raise(lane: Lane): void
export function onRaise(listener: (lane: Lane) => void): () => void
export function fly<T>(run: () => Promise<T>): Flight<T>
export function join<T>(flight: Flight<T>): Promise<T>
export function featureOfRequest(name: string, input: unknown): Feature
export function featureOfJob(key: string): Feature
export function withUserContext(orca: OrcaWorkerApi): OrcaWorkerApi
```
- **Lanes and runs**
  - `inLane` runs `run` with the given feature in a new lane.
  - `runIn` runs `run` in an existing context.
  - `currentContext()` outside any context is `{ feature: 'other', lane: <a shared user lane> }`.
- **Raising**
  - `raise(lane)` sets the lane's priority to `'user'` when it isn't already, then calls every `onRaise` listener. Keep the priority in a private mutable field.
- **Shared work**
  - `fly(run)` starts `run` in a new lane with the current feature and priority, and returns the promise with that lane.
  - `join(flight)` raises `flight.lane` when the caller's lane is `'user'`, then returns `flight.promise`.
- **`featureOfRequest`** maps request names to features:

  | Request name | Feature |
  | --- | --- |
  | `work.board`, `work.boards`, `work.openBoard` | `board` |
  | other `work.*` | `work` |
  | `prs.*` | `prs` |
  | `reviews.*` | `reviews` |
  | `runs.view`, `runs.log`, `runs.openFile` | `run` |
  | other `runs.*` | `pipelines` |
  | `wiki.*` | `wiki` |
  | `share.*` | `share` |
  | `orgs.*`, `ado.*` | `connect` |
  | `ui.visibility` | by its input's `surface`: `work`, `board`, `prs`, `pipelines` or `run` |
  | anything else | `other` |

- **`featureOfJob`** maps job key prefixes to features:

  | Job key prefix | Feature |
  | --- | --- |
  | `mine:` | `work` |
  | `board:` | `board` |
  | `prs:` | `prs` |
  | `runs:`, `watch:` | `pipelines` |
  | `runview:` | `run` |
  | anything else | `other` |

- **`withUserContext`** wraps each handler in `inLane(featureOfRequest(name, input), 'user', …)`. Build the result with `Object.create(orca, { panels: { value: Object.create(orca.panels, { handle: { value: wrapped } }) } })`, so every other member keeps working whether it is an own or a prototype property.

`worker/data/governor.ts`:
```ts
export const MAX_IN_FLIGHT = 6
export const BACKGROUND_SLOTS: Record<PressureLevel, number> = { normal: 4, near: 3, tight: 2, delayed: 1, blocked: 0 }
export interface GovernorDeps { http: AdoHttp; pressure: Pick<Pressure, 'state'>; now: () => number; clock: Pick<Clock, 'setTimeout' | 'clearTimeout'> }
export function mergeKey(req: AdoRequest): string | null
export function createGovernor(deps: GovernorDeps): AdoHttp
```
- **`mergeKey`**
  - returns `null` for anything that isn't a GET or a POST whose path ends in `/_apis/wit/wiql` or `/_apis/wit/workitemsbatch`
  - otherwise returns org, host, project, path, query entries sorted by key, `apiVersion` and `JSON.stringify(body)`, joined
  - ignores `signal`
- **Queue.** One queue per org.
  - Each entry captures `currentContext()` when it is enqueued.
  - Dispatch order: lane priority (`user`, `visible`, `hidden`), then arrival.
  - The inner `http.json` runs inside `runIn(entry.context, …)`.
  - At most `MAX_IN_FLIGHT` in flight. `visible` and `hidden` entries together may hold at most `BACKGROUND_SLOTS[level]` slots.
- **Blocked.** While `now() < state.resumeAt`, a background entry is *held*.
  - A held entry is not in the queue and holds no slot.
  - It returns to the queue at `resumeAt` (one `clock.setTimeout` per org), when its lane is raised, or never, if it is aborted first.
  - User entries are never held.
- **Merging.**
  - Every mergeable request runs on an internal `AbortController`, even with a single caller, and is aborted when every joined caller has aborted.
  - Each caller rejects with its own `signal.reason` when it aborts.
  - A `user` caller joining a merged request raises that request's lane.
- **Aborts.** An aborted entry, queued or held, is removed at once and its caller rejects with `signal.reason`.
- **Raises.** On `onRaise`, held entries of that lane return to the queue and queued ones re-sort.
- **Behaviour change in this task.** Existing tests that count calls while a fake holds answers back may now see at most 6 in flight per org. If one does, adjust its gate, not the cap.

- [ ] **Step 1: Write the failing tests.**

  `worker/data/context.test.ts`:
  - `inLane is visible across awaits and timers inside the run`: after an `await` and a `setImmediate`, `currentContext()` has the feature and priority passed in.
  - `outside any context the default is a user request for other`.
  - `featureOfRequest maps request names to features`: table-driven over every row above, including `ui.visibility` with each `surface`.
  - `featureOfJob maps job keys to features`: `mine:contoso`, `board:contoso:t:b`, `prs:contoso`, `runs:contoso`, `watch:contoso`, `runview:contoso:42`, and `arm-expiry` → `other`.
  - `fly runs in its own lane; a user join raises it and a background join does not`.
  - `raise tells every onRaise listener once`.
  - `withUserContext runs every handler as a user request for its feature, and leaves the rest of the API working`. Use a fake `orca` whose `panels` has `handle` and `post` on its prototype. A handler registered as `work.board` sees `{ feature: 'board' }` with a `'user'` lane, and `host.panels.post` still reaches the fake.

  `worker/data/governor.test.ts`. The fake inner `AdoHttp` records each request with `currentContext()` at call time and answers through deferreds. The fake pressure returns a settable `PressureState`. Use `fakeClock`.
  - `identical GETs in flight share one request`: one inner call; both callers get the same `data`.
  - `wiql and workitemsbatch posts with the same body share one request, other writes never do`: wiql ×2 same body → 1 call; PATCH ×2 → 2 calls; wiql with different bodies → 2 calls.
  - `mergeKey ignores query order and the signal, and refuses writes`.
  - `a lone mergeable request runs on its own controller and aborts when its caller does`.
  - `a caller that aborts leaves the shared request running for the others`. The inner signal is aborted only after both callers abort.
  - `an aborted queued request leaves the queue and is never sent`.
  - `no more than 6 requests run at once for an org, and other orgs are not held back`.
  - `background requests take at most 4, 3, 2 and 1 slots as pressure rises, leaving the rest for user requests`.
  - `queued requests start user first, then visible, then hidden`.
  - `each queued request is sent in its own context, not the one that freed its slot`: a queued `board` request sent after a `prs` request finishes records feature `board`.
  - `while blocked, user requests are still sent first and background requests wait without holding a slot`:
    - With `resumeAt = now + 30_000` and one `hidden` request held, 6 `user` requests all start.
    - The held request is sent at 30 s, and not before.
  - `a held request that is aborted leaves at once`.
  - `raising a lane releases its held requests and moves its queued ones to the front`.
  - `errors pass through unchanged, including unauthorized`: the same `AdoError` instance is rejected.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement `context.ts`.** Use one module-level `AsyncLocalStorage<RequestContext>`.
- [ ] **Step 4: Implement `createGovernor`** as specified above.
- [ ] **Step 5: Wire `main.ts`** as described under Files.
- [ ] **Step 6: Run the tests and see them pass.** Existing worker tests, including `worker/main.test.ts`, must stay green.
- [ ] **Step 7: Verify** with the four commands.
- [ ] **Step 8: Commit.** `git commit -m "Send every Azure DevOps request through a per-org governor"`

---

### Task 14: Request metrics in the Connection status command

**Goal:** For each connected org that had traffic in the last 5 minutes, `Azure DevOps: Connection status` shows:
- the requests by feature
- the busiest endpoints
- 429s and delays
- the summed `X-RateLimit-Cost`
- the rate-limit state

This runs before the behaviour tasks, so it records a baseline. Spec §5.9.

**Files:**
- Create: `worker/data/metrics.ts`, `worker/data/metrics.test.ts`
- Modify: `worker/status-bar.ts` and `worker/status-bar.test.ts`. `statusText(orgs, counts?, notes?, details?: (org: string) => string[])` puts each connected org's detail lines under its line.
- Modify `worker/main.ts`:
  - `observe` becomes `(req, status, headers) => { pressure.observe(req, status, headers); metrics.observe(req, status, headers) }`
  - the `status` command passes `org => metricsLines(metrics.report(org), pressure.state(org), Date.now())`
- Modify `worker/main.test.ts`. The connect test (`main.test.ts:223`) asserts the exact status text. After the PAT sign-in, the org has had `connect` traffic, so expect the first line followed by a `  Requests, last 5 min:` line.

**Interfaces**

`worker/data/metrics.ts`:
```ts
export interface MetricsReport {
  total: number; perMinute: number[]; byFeature: Partial<Record<Feature, number>>
  byEndpoint: { endpoint: string; count: number }[]; throttled: number; delayed: number
  cost: number | null; etags: string[]; last: { at: number; headers: RateLimitHeaders } | null
}
export interface Metrics { observe: ResponseObserver; report(org: string): MetricsReport; forget(org: string): void }
export function endpointOf(req: AdoRequest): string
export function createMetrics(now: () => number): Metrics
export function metricsLines(report: MetricsReport, pressure: PressureState, now: number): string[]
```
- **`endpointOf`** is `` `${method} ${host ? host + ' ' : ''}${path}` ``, with:
  - path segments that are all digits, or GUIDs, replaced by `{id}`
  - a first segment before `/_apis` replaced by `{team}`

  For example, `POST /6a7b…/_apis/wit/wiql` → `POST /{team}/_apis/wit/wiql`, and `GET /_apis/git/pullrequests/322` → `GET /_apis/git/pullrequests/{id}`.
- **Counting.** The feature comes from `currentContext().feature` at observe time. There are five 1-minute buckets per org, keyed by `Math.floor(now / 60_000)`. `perMinute` is oldest first; `byEndpoint` is sorted descending, with the top 3 shown.
- **`metricsLines`** returns `[]` when `report.total === 0`. Otherwise, exactly:
  ```
    Requests, last 5 min: 41 (board 18, work 9, prs 8, pipelines 6)
    Busiest: POST /{team}/_apis/wit/wiql 14 · GET /_apis/git/pullrequests 7 · POST /_apis/wit/workitemsbatch 5
    Rate limit: near, 152 of 200 TSTU left, polling ×2 (headers 40 s ago)
  ```
  - The third line reads `Rate limit: no pressure seen` when `last` is null.
  - A fourth line, `Throttled 2, delayed 3, cost 1.25 TSTU`, appears only when any of those is non-zero.

- [ ] **Step 1: Write the failing tests.**

  `metrics.test.ts`:
  - `requests are counted per minute for five minutes, by feature and endpoint`: observes inside `inLane('board', 'hidden', …)` and `inLane('work', 'user', …)`.
  - `endpoints replace ids, GUIDs and team segments with placeholders`.
  - `429s, delayed answers, the cost sum and ETag endpoints are tracked`.
  - `counts older than five minutes drop out`.
  - `metricsLines shows totals, the busiest endpoints and the rate-limit state`: the exact lines above.
  - `metricsLines shows nothing for an org with no traffic`.

  `status-bar.test.ts`:
  - `statusText adds each connected org's detail lines under it`.

  Update `main.test.ts`'s connect test as described under Files.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `metrics.ts`, then `statusText`'s `details`, then the `main.ts` wiring.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Show request counts and rate-limit state in Connection status"`

---

### Task 3: Scheduler pacing, lanes, quiet back-off and idle-when-hidden

**Goal:**
- Every org job follows its org's pressure factor and `resumeAt`.
- Jobs run in a `visible` or `hidden` lane.
- Jobs back off when nothing changed, never past 5 minutes for the notification jobs, and can idle while hidden.
- User calls that join background work raise it.

This replaces `pipelines/pressure.ts` and the per-job 429 pause.

**Files:**
- Modify: `worker/poll/scheduler.ts`, `worker/poll/scheduler.test.ts`
- Modify `worker/test-support.ts`: add `paced(clock: FakeClock): { pressure: Pressure; scheduler: Scheduler }`, built with `createScheduler(clock, paceOf(pressure))`.
- Modify `worker/boards/service.ts` and `worker/boards/board-views.ts`:
  - `org` on the `mine:` and `board:` jobs
  - `OrgWork.loading` becomes a `Flight<WorkSnapshot> | null`, started with `fly` and awaited with `join`
- Modify: `worker/prs/service.ts`. Add `org` and `quietCapMs: NOTIFY_CAP_MS` on `prs:`. `OrgPrs.loading` holds `{ kind, flight }`, and joiners use `join`.
- Modify `worker/pipelines/service.ts`:
  - remove `pressure` from deps, along with `RUNS_SLOWED_MS` and `WATCH_SLOWED_MS`
  - add `org` to `runs:` and `watch:`, and `quietCapMs: NOTIFY_CAP_MS` to `runs:`
  - `loading` and `watching` become flights
- Modify `worker/pipelines/run-views.ts`:
  - remove `pressure` from deps and `SLOWED_MS`
  - add `org` on `runview:` jobs, and call `scheduler.setVisible(key, true)` right after each `upsert` in `sync`, because a run view's job exists only while its tab shows
  - `Held.loading` becomes a flight
- Modify: `worker/main.ts`. Use `createScheduler(realClock, paceOf(pressure))`, use the governor directly as `http` (drop `slowDown.wrapByOrg`), and remove the old import and the `pressure` deps.
- Delete: `worker/pipelines/pressure.ts`, `worker/pipelines/pressure.test.ts`.
- Rewrite the tests this breaks:
  - `worker/pipelines/service.test.ts`: setup (line ~85) and `pressure moves the org to the background cadence for five minutes`
  - `worker/pipelines/run-views.test.ts`: setup (line ~67), `pressure slows a run view to thirty seconds`, and `a failed poll keeps the last view as stale, tells the tab once, recovers and pauses when throttled` (line ~496)
  - `worker/prs/notify.test.ts`: `a throttled thread read pauses the PRs job for the retry wait and logs nothing` (line ~431). The harness at line ~107 passes `observe: pressure.observe` to `createAdoHttp` and uses `paced(clock)`.
  - `worker/main.test.ts`: `a rate-limit header on a pull request answer slows the Pipelines tab of that org too` (line ~1397)

**Interfaces**
- Consumes: `Pace`, `paceOf`, `Pressure` (Task 1); `inLane`, `fly`, `join`, `raise`, `currentContext`, `featureOfJob`, `Flight` (Task 2).
- Produces in `worker/poll/scheduler.ts`:
```ts
export const NOTIFY_CAP_MS = 5 * 60_000
export interface Job { key: string; org?: string; visibleMs: number; backgroundMs: number | null; quietMax?: number; quietCapMs?: number; run(signal: AbortSignal): Promise<void | 'unchanged'> }
export function createScheduler(clock: Clock, pace?: Pace): Scheduler
```
- **Interval** = `Math.min(base * quiet, Math.max(base, quietCapMs ?? Infinity)) * factor`, where:
  - `base` is `visible ? visibleMs : backgroundMs`
  - `quiet` is `Math.min(2 ** streak, quietMax ?? 1)`
  - `factor` is `pace.factor(org)`, or 1 without an org
- **Due** = `max(lastRunAt + interval, pace.resumeAt(org))`.
- **Quiet streak.** `streak` counts consecutive `'unchanged'` runs. It resets on a run that resolves anything else, on `setVisible(key, true)` and on `runNow`. **`upsert` keeps it.**
- **`backgroundMs: null`** means no timer while not visible.
- **Lanes.** A timer run executes as `inLane(featureOfJob(key), visible ? 'visible' : 'hidden', () => fly(…))`, and the entry keeps that flight. `runNow` on an entry with a run in flight returns `join(entry.flight)`. Otherwise it starts a new run with `fly` in the caller's context.
- **Removed.** `pausedUntil`, `rateLimitPauseMs`, `DEFAULT_RATE_LIMIT_PAUSE_MS` and `MAX_RATE_LIMIT_PAUSE_MS`.

- [ ] **Step 1: Write the failing tests** in `scheduler.test.ts`. Use the existing `fakeClock`, `trackedJob` and `T0`.
  - `an org job waits out its org's resumeAt`: pace `resumeAt = T0 + 90_000` → first start at 90 s.
  - `an org job's interval is multiplied by its org's pace factor`: factor 4, `visibleMs: 1000`, visible → starts `[0, 4000, 8000]`.
  - `jobs without an org ignore the pace`.
  - `each unchanged run doubles the interval up to quietMax, and a changed run resets it`: `visibleMs: 1000`, `quietMax: 4`; runs resolve `'unchanged'`, `'unchanged'`, `'unchanged'`, `undefined` → starts `[0, 2000, 6000, 10000, 11000]`.
  - `quiet back-off never stretches an interval past quietCapMs`: `backgroundMs: 300_000`, `quietMax: 4`, `quietCapMs: 300_000`, hidden, always `'unchanged'` → starts every 300 s.
  - `upsert keeps the quiet streak`.
  - `becoming visible and runNow reset the quiet back-off`.
  - `a job with backgroundMs null idles while hidden and runs on becoming visible when due`.
  - `timer runs carry a visible or hidden lane for the job's feature`: key `mine:contoso` → feature `work`; priority `'visible'` after `setVisible(key, true)`, otherwise `'hidden'`.
  - `runNow from a user call raises a run already in flight`.
  - `a rate-limited run no longer pauses its job by itself`: a run throwing `rate_limited` with `retryAfterMs: 60_000` and no pace → next start at the normal 1000 ms.
  - Delete or rewrite the existing rate-limit pause tests to match.

  In `worker/boards/service.test.ts`:
  - `a Work snapshot request that joins a background load raises its lane`:
    - Gate the fake's first answer; capture `currentContext().lane.priority` per call with an `ado.on` override.
    - Calls after `snapshot()` joins are `'user'`.

  Rewrite the four broken tests listed under Files:
  - **PR notifications (notify.test.ts):** a 429 with `retry-after: 600` → no PR job run for 600 s, then one.
  - **Run view (run-views.test.ts):** a 429 pauses that org's run view until its `resumeAt`.
  - **Pipelines delay (`service.test.ts`):** rename it `a delayed org polls its runs at eight times the interval`. Feed `X-RateLimit-Delay` through `pressure.observe`; the visible runs reads are 240 s apart.
  - **main.test.ts:** after the first full load, no `isRunningRuns` read until 240 s, and one by 250 s.

  Also in `run-views.test.ts`, replace `pressure slows a run view to thirty seconds` with `a delayed org polls an active run view at forty seconds`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement the scheduler changes.** `assertValidIntervals` accepts `backgroundMs: null`. A timer that fires early re-checks the due time, as `fire()` already does.
- [ ] **Step 4: Convert the services' single-flights** to `fly`/`join`, add `org` and the caps to every ADO job, and add `setVisible` in run views.
- [ ] **Step 5: Remove the old slow-down,** wire `paceOf(pressure)` in `main.ts`, and delete `pipelines/pressure.ts` and its test.
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Verify** with the four commands, and `grep -rn "pipelines/pressure\|slowed(\|slowDown" worker` → no matches.
- [ ] **Step 8: Commit.** `git commit -m "Pace every polling job by its org's rate-limit pressure"`

---

### Task 4: Keep hidden boards, idle the Work tab while hidden, serve held views at once

**Goal:** Hidden is not gone.
- A hidden board keeps its view and stops polling.
- Showing it again returns the view at once, and revalidates only past 30 s.
- The Work tab's job idles while hidden.
- Unchanged reloads report `'unchanged'`.

**Files:**
- Modify: `worker/boards/board-views.ts`, `worker/boards/service.ts`, `worker/boards/service.test.ts`
- Rewrite the tests this breaks:
  - every test that expected a hidden board to be dropped (six of them)
  - `the board loads every 30 s while a board is visible` (`service.test.ts:702`): quiet back-off now moves the third load from 60 s to 90 s

**Interfaces**
- Consumes: `Job` with `org`, `backgroundMs: null`, `quietMax`, `'unchanged'` (Task 3).
- Produces:
  - `BOARD_MS = { visibleMs: 30_000, backgroundMs: null }`, with `quietMax: 2` on board jobs.
  - `MINE_MS = { visibleMs: 60_000, backgroundMs: null }`, with `quietMax: 2`.
  - `MAX_HELD_VIEWS = 4` per org.
  - `BoardViews.setVisible(org, false, board)`:
    - adds the key to `hiddenViews` and removes its job; the view stays
    - with no `board`, removes every job of the org; views stay
    - `forget(org)` is still called only from `onOrgs` on disconnect
  - `BoardViews.open()`:
    - returns a held view with the same `everyone` at once
    - when the view is older than `BOARD_MS.visibleMs`, it also starts `void runNow(key)`
  - The board job's `run` resolves `'unchanged'` when the new result's JSON equals the old one, which `reload` already compares.
  - The Work job's `run` resolves `'unchanged'` when the new snapshot equals the previous one apart from `updatedAt`. It still posts `work.changed`, so "Updated" stays honest.

- [ ] **Step 1: Write the failing tests** in `worker/boards/service.test.ts`, using its `fakeAdo`, `fakeClock` and real scheduler.
  - `hiding a board keeps its view and stops its polling`:
    - After `setVisible(false)`, advancing 10 min makes zero ADO calls.
    - A second `boards.board(...)` returns the same items with zero calls.
  - `showing a held board older than 30 s returns it at once and revalidates in the background`:
    - Gate the fake's WIQL answer. `board()` resolves before the gate opens.
    - After the gate opens and the fake's data changed, `postBoard` receives the change.
  - `a held board under 30 s old is served without any request`.
  - `at most 4 board views are held per org, and the oldest hidden one goes first`.
  - `the Work job idles while the Work tab is hidden`: visible → hidden, then advance 15 min → zero calls.
  - `the board loads at 30 s, backs off to 60 s while unchanged, and returns to 30 s after a change`: replaces the test at line 702.
  - Update the six existing tests that expected a hidden board to be dropped.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** the `board-views.ts` and `service.ts` changes above. When adding a view beyond `MAX_HELD_VIEWS`, drop the least recently opened hidden view through `drop(key)`, so `recent.drop` still runs.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Keep hidden boards and serve them at once"`

---

### Task 15: Remember each board's filter

**Goal:** A board opens on the Me / Everyone choice last made for it, or *Everyone* the first time. Only a button press stores a choice. This is decision 4, settled by the user on 2026-11-11 (spec §5.10).

**Files:**
- Create: `worker/boards/board-filters.ts`, `worker/boards/board-filters.test.ts`
- Modify: `src/protocol.ts`. `work.board`'s input gains `everyone?: boolean` (no longer required) and `remember?: boolean`; its output gains `everyone: boolean`.
- Modify: `worker/boards/service.ts` (`board()`) and `worker/boards/service.test.ts`. The service builds its `BoardFilters` from its existing `deps.store`, so `main.ts` doesn't change.
- Modify `src/board/board.ts`:
  - The state's `everyone` becomes `boolean | null`, and `openRef` sets it to `null`.
  - `load(options?: { remember?: true })` sends `everyone` only when it isn't `null`, plus `remember: true` when asked. Every answer sets `everyone` from `result.everyone`.
  - The toolbar's `everyone(value)` handler sets the state and calls `load({ remember: true })`. Every other `load()` call stays as it is.
- Modify `src/board/render.ts`: the toolbar's `update` takes `everyone: boolean | null`, and `null` sets `aria-pressed="false"` on both buttons. Add a test in `src/board/render.test.ts`.

**Interfaces**
- Consumes: `StorePort` (existing); held board views (Task 4).
- Produces in `worker/boards/board-filters.ts`:
```ts
export const MAX_REMEMBERED_BOARDS = 50
export interface BoardFilters {
  everyone(org: string, teamId: string, boardId: string): Promise<boolean>
  remember(org: string, teamId: string, boardId: string, everyone: boolean): Promise<void>
}
export function createBoardFilters(store: StorePort): BoardFilters
```
- In `worker/boards/service.ts`, `BoardsService.board` becomes:
```ts
board(input: BoardArgs & { everyone?: boolean; remember?: boolean }): Promise<BoardResult & { everyone: boolean }>
```
- **Storage.** The key is `boardFilters:<org>`. Its value is `Record<string, boolean>` keyed `<teamId>/<boardId>`, in order of last change.
  - `remember` deletes and re-adds the entry, drops the first entries beyond `MAX_REMEMBERED_BOARDS`, and writes only when the value changed.
  - A malformed stored value reads as empty.
- **`board()`** resolves `config(args)` first, so `boardId` is known. Then:
  - `filter = input.everyone ?? await filters.everyone(org, teamId, boardId)`
  - it calls `remember` only when `input.remember === true` and `input.everyone !== undefined`
  - it returns `{ ...(await boardViews.open(org, args, boardId, filter)), everyone: filter }`

- [ ] **Step 1: Write the failing tests.**

  `board-filters.test.ts`, using `memoryStore`:
  - `a board never opened uses Everyone`.
  - `a remembered filter comes back after a restart`: a new `createBoardFilters` on the same store.
  - `filters are kept per board and per org`.
  - `at most 50 boards are remembered per org, the oldest go first`.
  - `remembering the same choice writes nothing`.
  - `a malformed stored value is ignored`.

  `worker/boards/service.test.ts`:
  - `opening a board without a filter uses the remembered one and says which`: remember *Me* for the fake board; `board({ … })` without `everyone` → `everyone: false`, and the WIQL contains `[System.AssignedTo] = @Me`.
  - `choosing a filter remembers it for that board only`.
  - `a load that re-sends the current filter does not overwrite a remembered choice`: remember *Me*, then `board({ everyone: true })` without `remember` → the stored choice is still *Me*.

  `src/board/render.test.ts`:
  - `the toolbar presses neither filter until the board's filter is known`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `board-filters.ts`, the protocol change, `board()`, then the editor and toolbar changes.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Remember each board's Me or Everyone filter"`

---

### Task 5: Entity store; move config, type-state, code-project and wiki caches onto it

**Goal:** One per-org store with typed tables replaces the scattered caches.
- In this task the store replaces:
  - `createBoardConfigCache`
  - `ItemSource.stateCache`
  - both `cachedCodeProjects` closures
  - the wiki `listings` map
- Board config loads become single-flight.
- An explicit sign-out or removal of an org drops its entities.

The remaining tables (`workItems`, `prs`, `prChecks`, `prWorkItems`, `builds`, `timelines`, `runChips`) are created now for later tasks.

**Files:**
- Create: `worker/data/entities.ts`, `worker/data/entities.test.ts`, `worker/data/freshness.ts`, `worker/data/records.ts`
- Modify:
  - `worker/boards/service.ts`: `config(args, signal)` becomes `tables.boardConfigs.read(boardConfigKey(args), FRESHNESS.boardConfig, s => loadBoardConfig(withSignal(http, s), args), signal)`
  - `worker/boards/snapshot.ts`: `createItemSource(http, org, orgUrl, now, tables)`, with `states` through `tables.typeStates.read`
  - `worker/ado/board-config.ts`: delete `BoardConfigCache`, `createBoardConfigCache` and `DEFAULT_TTL_MS`
  - `worker/ado/board-config.test.ts`: remove the cache tests
- Modify: `worker/ado/code-projects.ts`, which becomes `cachedCodeProjects(http, org, table: Table<NamedItem[]>)`; add `worker/ado/code-projects.test.ts`.
- Modify: `worker/prs/service.ts`, `worker/pipelines/service.ts`, `worker/wiki/service.ts`, `worker/pipelines/run-views.ts`. Add `entities: Entities` to their deps. Run views keep it unused until Task 13, so that task needs no `main.ts` change. Update their tests' setup to pass `createEntities(clock.now)`.
- Modify: `worker/connections.ts` and `worker/connections.test.ts`. Add `ConnectionsDeps.forgotten?: (org: string) => void`, called after a successful `signOut(org)` and after a successful `remove(org)`, and nowhere else.
- Modify: `worker/main.ts`. Create `const entities = createEntities(Date.now)` and pass it to boards, PRs, pipelines, run views and wiki. Pass `forgotten: org => entities.forget(org)` to `createConnections`. The connections deps object is built before `entities` exists, so declare `entities` first.

**Interfaces**

`worker/data/records.ts`:
```ts
export type ItemRecord = RawWorkItem & { withRelations: boolean }
export interface PrRecord { projectId: string; repoId: string; prId: number; status: 'active' | 'completed' | 'abandoned'; target: string; sourceCommit: string | null; reviewers: string; url: string }
export interface CheckRecord extends PrChecks { commit: string | null; reviewers: string }
export function prKey(key: PrKey): string
export function reviewersSignature(reviewers: readonly { id: string; vote?: number }[] | undefined): string
```
- `prKey` returns `` `${projectId}/${repoId}/${prId}` ``.
- `reviewersSignature` returns the reviewers as `` `${id}:${vote ?? 0}` ``, sorted and joined with `,`.

`worker/data/freshness.ts`:
```ts
export const FRESHNESS = { boardConfig: 3_600_000, typeStates: 3_600_000, projects: 3_600_000, wikis: 600_000, prActive: 120_000, checksRunning: 120_000, checksIdle: 1_800_000, prWorkItems: 600_000, prWorkItemsClosed: 3_600_000, boardView: 30_000 } as const
export const MAX_ENTRIES = { workItems: 5000, prs: 2000, prChecks: 2000, prWorkItems: 2000, builds: 500, timelines: 100, runChips: 200, boardConfigs: 20, typeStates: 100, projects: 4, wikis: 1 } as const
```
`checksIdle` is the lead's call, pending the user's confirmation (spec §10 item 6).

`worker/data/entities.ts`:
```ts
export interface Stamped<T> { value: T; at: number }
export interface TableSpec<T> { maxEntries: number; replaces?: (incoming: T, stored: T) => boolean }
export interface Table<T> {
  get(key: string): Stamped<T> | undefined
  fresh(key: string, maxAgeMs: number): T | undefined
  put(key: string, value: T, at?: number): T
  read(key: string, maxAgeMs: number, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  drop(key: string): void
  entries(): [string, Stamped<T>][]
}
export interface OrgEntities {
  workItems: Table<ItemRecord>; prs: Table<PrRecord>; prChecks: Table<CheckRecord>; prWorkItems: Table<number[]>
  builds: Table<RawBuild>; timelines: Table<RawTimeline>; runChips: Table<StageChip[] | null>
  boardConfigs: Table<BoardConfig>; typeStates: Table<TypeState[]>; projects: Table<NamedItem[]>; wikis: Table<WikiRef[]>
}
export type TableName = keyof OrgEntities
export interface Entities {
  of(org: string): OrgEntities
  forget(org: string): void
  watch(table: TableName, listener: (org: string, keys: string[]) => void): () => void
}
export function createTable<T>(now: () => number, spec: TableSpec<T>): Table<T>
export function createEntities(now: () => number): Entities
```
- **`put`** returns the value the table holds afterwards: the incoming value, or the stored one when `replaces` said no.
- **`workItems.replaces`** is `incoming.rev > stored.rev || (incoming.rev === stored.rev && (incoming.withRelations || !stored.withRelations))`.
- **`timelines.replaces`** is `incoming.changeId >= stored.changeId`.
- **`read`**
  - A fresh value answers at once.
  - Otherwise the load runs once per key, via `fly`, on an internal `AbortController` that aborts only when every joined caller's `signal` has aborted. A caller without a signal never aborts it.
  - A caller whose own signal aborts rejects with its reason.
  - A `user` caller joining raises the load's lane through `join`.
  - A failed load is not cached.
- **LRU and watching**
  - `get`, `fresh` and `read` hits count as a use for the LRU, which uses `Map` insertion order.
  - `watch` listeners hear each changed key once per microtask, for every org. A listener registered once keeps hearing an org after `forget(org)` creates fresh tables.

- [ ] **Step 1: Write the failing tests** in `worker/data/entities.test.ts`:
  - `fresh returns a value only within its age`.
  - `read loads once for concurrent callers and caches the result`.
  - `read does not cache a failed load, and the next read tries again`.
  - `read runs its load on its own signal: one caller aborting leaves the load running for the others`.
  - `a user caller joining a read raises its lane`.
  - `the rev rule keeps the newer record and never trades relations away`. Each case asserts what `put` returns:
    - rev 5 then rev 4 → rev 5
    - rev 5 without relations then rev 5 with → with
    - rev 5 with relations then rev 5 without → with
    - rev 5 then rev 6 without relations → rev 6
  - `tables evict the least recently used entries past maxEntries`.
  - `watchers hear changed keys per org, batched per microtask, and still hear them after forget`.
  - `put with an explicit at keeps it, so restored values age honestly`.
  - `forget drops every table of that org and leaves other orgs`.

  In `worker/ado/code-projects.test.ts`:
  - `PRs and pipelines share one code-project read per org`: two `cachedCodeProjects` on the same table → one `GET /_apis/git/repositories`.

  In `worker/boards/service.test.ts`:
  - `two boards opened at once load their shared board config once`: counts `backlogconfiguration` calls = 1.

  In `worker/connections.test.ts`:
  - `forgotten is called on sign-out and removal, and not on an interrupted sign-in`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `records.ts`, `freshness.ts` and `entities.ts`.
- [ ] **Step 4: Move the four caches** onto the store as described under Files, and delete what they replace.
- [ ] **Step 5: Add the `forgotten` hook** to connections and wire it in `main.ts`.
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Verify** with the four commands, and `grep -rn "createBoardConfigCache\|stateCache\|listings = new Map" worker` → no matches.
- [ ] **Step 8: Commit.** `git commit -m "Share one entity store per org for configs, states, projects and wikis"`

---

### Task 6: Delta sync of work items

**Goal:** The Work tab and every open board ask ADO what changed, and hydrate only changed ids. A quiet tick is one WIQL request. Spec §5.5.

**Files:**
- Modify: `worker/ado/workitems.ts`, `worker/ado/workitems.test.ts`
- Create: `worker/boards/sync.ts`, `worker/boards/sync.test.ts`
- Modify: `worker/boards/snapshot.ts`, `worker/boards/snapshot.test.ts`
- Modify: `worker/boards/service.ts`, `worker/boards/board-views.ts`, `worker/boards/service.test.ts`
- Modify `worker/boards/fake-ado.ts`:
  - `fakeAdo(options?: { now?: () => number })`, where `now` defaults to `Date.now`. Every WIQL answer carries `asOf: new Date(now()).toISOString()`. This also fixes `main.test.ts`, which shares the fake: without `asOf`, `queryIdsAt` now fails as malformed.
  - `ado.change(id, patch?: { rev?: number; fields?: Record<string, unknown> })` applies the patch, bumps `rev` by 1 unless given, and records the item as changed at `now()`.
  - `ado.setMembers(ids)` sets `state.wiql`, and records every id added or removed as changed at `now()`.
  - `ado.remove(id)` deletes the item, so a revision read omits it.
  - The WIQL route answers by query text:
    - text containing `[System.ChangedDate] >=` → the delta query. It answers the ids changed at or after the quoted ISO literal (any change for `@Today - 1`) that are in `state.wiql` or in the query's `[System.Id] IN (…)` list.
    - text containing `[System.Id] IN` without a change date → the still-in check: `state.wiql` ∩ the listed ids.
    - otherwise → the membership query: `state.wiql`.
  - `workitemsbatch` with `fields` exactly `['System.Id']` is a revision read. It answers id and `rev` per id, and `null` for removed ids.
  - Add `isRevRead`, and narrow `isFieldsBatch` to exclude revision reads, so the 10 existing `isFieldsBatch` counts in `service.test.ts` keep their meaning.
- Rewrite the tests this breaks in `worker/boards/service.test.ts`. Find every test that changes the fake between ticks and expects the next tick to see it: `ado.items.get(id)!.rev = …`, item field edits, or `state.wiql = …` after the first load (around lines 546, 692–720, 949, 970 and 1311–1394). Make those changes through `ado.change` or `ado.setMembers`. Build the harness's fake with `fakeAdo({ now: clock.now })`.

**Interfaces**
- Consumes: `Table<ItemRecord>`, `ItemRecord` (Task 5); `'unchanged'` (Task 3); held board views and the board filter (Tasks 4, 15).
- Produces in `worker/ado/workitems.ts`. Keep `wiqlMine` and `wiqlBoard` as `select(['[System.TeamProject] = @project', clause])`.
```ts
export function mineClause(allDoneStates: string[]): string
export function boardClause(cfg: BoardConfig, everyone: boolean): string
export function deltaWiql(clause: string, since: string, known: readonly number[]): string
export function stillInWiql(clause: string, ids: readonly number[]): string
export interface IdsAt { ids: number[]; asOf: string }
export function queryIdsAt(http: AdoHttp, org: string, projectId: string, teamId: string, wiql: string, timePrecision: boolean): Promise<IdsAt>
export function readRevs(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<Map<number, number>>
export function isDatePrecisionError(error: unknown): boolean
export const KEPT_FIELDS: ReadonlySet<string>
export function toRecord(raw: RawWorkItem, withRelations: boolean): ItemRecord
```
- **`deltaWiql`** produces exactly the following, where `<since>` is either a quoted ISO literal or `@Today - 1`. With no known ids, the `OR …` part is left out.
  ```
  SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= <since> AND (([System.TeamProject] = @project AND (<clause>)) OR [System.Id] IN (<known>)) ORDER BY [System.ChangedDate] DESC
  ```
- **`stillInWiql`** produces:
  ```
  SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (<clause>) AND [System.Id] IN (<ids>)
  ```
- **`queryIdsAt`** throws the existing `MALFORMED.workItem` error when `asOf` is missing or `Date.parse(asOf)` is `NaN`.
- **`readRevs`** sends `fields: ['System.Id']` and `errorPolicy: 'omit'`. Ids it can't read are absent from the map.
- **`isDatePrecisionError`** is true for an `AdoError` with code `bad_request` whose message matches `/date precision/i`.
- **`KEPT_FIELDS`** holds `System.Id`, `System.TeamProject`, `System.WorkItemType`, `System.Title`, `System.State`, `System.AssignedTo`, `System.Parent`, `System.ChangedDate` and `System.AreaPath`. `toRecord` also keeps any field matching `/^WEF_[0-9A-Fa-f]+_Kanban\./`, and keeps only relations whose `rel` is `CHILD_LINK`, or `ArtifactLink` with a `PR_ARTIFACT_PREFIX` URL.

Produces in `worker/boards/sync.ts`:
```ts
export const OVERLAP_MS = 10_000
export const AUDIT_EVERY_MS = 15 * 60_000
export const DEEP_AUDIT_EVERY = 4
export const MAX_KNOWN_FOR_DELTA = 1500
export interface SyncState { clause: string; members: number[]; watermark: string; auditedAt: number; audits: number; precision: 'time' | 'day' }
export interface SyncScope { org: string; projectId: string; teamId: string; clause: string }
export interface SyncResult { state: SyncState; members: number[]; stale: Set<number>; gone: number[] }
export function syncView(http: AdoHttp, scope: SyncScope, previous: SyncState | null, known: readonly number[], revOf: (id: number) => number | undefined, now: () => number): Promise<SyncResult>
```

**Algorithm (spec §5.5).**
1. **Audit** when `previous` is null, `previous.clause !== scope.clause`, `now() - auditedAt ≥ AUDIT_EVERY_MS`, or `known.length > MAX_KNOWN_FOR_DELTA`:
   - Run `queryIdsAt(select([project, clause]), false)`.
   - Set `audits = (previous && previous.clause === scope.clause ? previous.audits : 0) + 1`.
   - Let `all = ids ∪ known`. When any id in `all` has `revOf` defined, run `readRevs(all)`:
     - `gone` = the known ids absent from the answer.
     - `stale` = the ids in `all`, minus `gone`, whose rev differs from `revOf` or is unknown.
   - Otherwise `stale` = `ids`.
   - On a deep audit (`audits % DEEP_AUDIT_EVERY === 0`), add every member to `stale`.
   - `watermark = asOf`, and `precision` is `'time'` unless the previous state with the same clause was `'day'`.
2. **Delta**, otherwise:
   - `since` = `new Date(Date.parse(previous.watermark) - OVERLAP_MS).toISOString()`, wrapped in single quotes.
   - With `precision: 'time'`, run `queryIdsAt(deltaWiql(clause, since, known), true)`. When the error satisfies `isDatePrecisionError`, set `precision = 'day'` and continue as below. Any other error rejects.
   - With `precision: 'day'`, run `queryIdsAt(deltaWiql(clause, '@Today - 1', known), false)`, then `readRevs` on the answer. `D` = the answered ids whose rev differs or is unknown, and `gone` = the known answered ids that `readRevs` omitted.
   - If `D` is empty, return `{ members: previous.members, stale: ∅, gone, state: { ...previous, watermark: asOf } }`.
   - Otherwise:
     - `fresh` = `D` − `known`
     - `recheck` = `D` ∩ `previous.members`. When it is non-empty, run `queryIdsAt(stillInWiql(clause, recheck), false)` and drop the missing ones from the members.
     - `members` = (members − dropped) ∪ `fresh`
     - `stale` = `D`
   - An answer of `WIQL_TOP` ids sets `auditedAt = -Infinity`, so the next sync audits.

Produces in `worker/boards/snapshot.ts`:
```ts
export interface ItemSource {
  http: AdoHttp; org: string; orgUrl: string
  items(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  fields(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  revOf(id: number): number | undefined
  forget(ids: readonly number[]): void
  chips(refs: PrRef[]): Promise<PrChip[] | null>
  states(projectId: string, type: string): Promise<TypeState[]>
  withSignal(signal?: AbortSignal): ItemSource
}
export interface ViewIds { members: number[]; stale: ReadonlySet<number> }
export function loadMine(source: ItemSource, cfg: BoardConfig, me: Me | null, ids: ViewIds): Promise<Loaded & { families: WorkFamilies; message?: string; known: number[] }>
export function loadBoardItems(source: ItemSource, cfg: BoardConfig, ids: ViewIds): Promise<Loaded & { truncated: boolean; known: number[] }>
```
- **`items`** reads, with relations, only ids that are in `stale`, missing from `workItems`, or held with `withRelations: false`. It `put`s `toRecord(raw, true)` and **returns, for every requested id, the record the table holds after `put`**.
- **`fields`** reads `TASK_FIELDS` only for ids that are stale or missing, `put`s `toRecord(raw, false)`, and returns the held records.
- **`forget(ids)`** drops those ids from `workItems`.
- **Parents** (`missingParents`) are read through `items()`.
- `known` is members ∪ parents ∪ the child ids read for families. `truncated` is `members.length >= WIQL_TOP`.
- `loadItem` (after a write) and `details` still hydrate directly, then `put` the record and use what `put` returns.

**Service wiring**
- The Work entry and each `BoardView` hold `sync: SyncState | null` and `known: number[]`.
- A tick runs `syncView` with the scope from `mineClause` or `boardClause`, calls `source.forget(gone)`, then projects with `{ members, stale }`.
- A board config with `requirementTypes.length === 0` skips `syncView`, and projects `{ members: [], stale: ∅ }`.
- `refresh(org)` sets `sync.auditedAt = -Infinity` before running the job.
- `publish()` also `put`s `toRecord(raw, true)`.

- [ ] **Step 1: Write the failing tests.**

  `worker/ado/workitems.test.ts`:
  - `deltaWiql puts the change-date clause first, scopes the clause to the project and lists known ids outside it`: exact string for clause `[System.AssignedTo] = @Me`, since `'2026-11-11T09:59:50.000Z'` and known `[7, 9]`, and again with `@Today - 1`.
  - `queryIdsAt sends timePrecision only when asked and returns asOf`.
  - `queryIdsAt treats a missing or unparsable asOf as malformed`.
  - `isDatePrecisionError matches only the date-precision 400`.
  - `toRecord keeps only the fields the views read and the child and PR links`.

  `worker/boards/sync.test.ts`. Use a scripted `AdoHttp` that records requests and answers in order.
  - `the first sync audits with one query and no revision read when the store is empty`: 1 request; `members [1,2,3]`; `stale {1,2,3}`; `watermark === asOf`.
  - `an audit reads revisions over members and known ids and marks only changed or unknown ones stale`: known `[1, 2, 50]`; `revOf` gives 1→5, 2→3 and 50→2; WIQL `[1,2,3]`; `readRevs` answers 1→5, 2→4, 3→1, 50→3 → `stale {2,3,50}`.
  - `an audit drops known ids that the revision read omits`: `gone` lists them.
  - `a quiet delta costs one request and advances the watermark`: the request query has `timePrecision: true`, the body contains `'2026-11-11T09:59:50.000Z'`, `stale` is empty and `state.watermark` is the new `asOf`.
  - `a new id in the delta joins the view without another query`.
  - `a member that changed is re-checked and leaves the view when it no longer matches`: delta `[2, 9]`, still-in answers `[]` → members `[1,3,9]`, `stale {2,9}`, 2 requests. The still-in query contains `[System.TeamProject] = @project`.
  - `a changed child that is not a member is only marked stale`: no still-in query.
  - `a date-precision 400 switches the view to day precision with a revision check`.
  - `any other 400 fails the sync and keeps time precision`.
  - `a changed clause resets the state and audits`.
  - `an answer at $top makes the next sync an audit`.
  - `audits come every 15 minutes, and every fourth audit marks every member stale`.
  - `more than 1,500 known ids skips the delta and audits`.
  - `the next delta starts at the server's asOf, not the local clock`: local `now()` is 2 hours ahead; the delta still uses `asOf − 10 s`.

  `worker/boards/snapshot.test.ts`:
  - `items hydrates only stale, missing or relation-less records and serves the rest from the store`: store holds 1 (rel, rev 3) and 2 (no rel); `items([1,2,3], ∅)` → one `workitemsbatch` for `[2,3]` with `$expand: 'relations'`.
  - `items returns the record the store kept, not an older one it fetched`: store holds 1 at rev 5; the fake answers rev 4 → `items` returns rev 5.
  - `a task-fields read never replaces a record that has relations`.
  - `loadMine with nothing stale makes no work-item request`, and that includes parents.
  - Update the existing `loadMine` and `loadBoardItems` tests to pass `ViewIds`.

  `worker/boards/service.test.ts`:
  - `a quiet Work tick sends only the delta query`: after the first load, the next tick makes exactly 1 ADO call.
  - `a card moved by someone else appears after one delta and one hydrate`: `ado.change(1204, { fields: { [WEF + '.Column']: 'Testing' } })` → 2 calls, then `work.changed` shows the new column.
  - `the user's move survives a delta that returns the older rev`: move 1204 (rev 2→3); an `ado.on` override answers the next hydrate with rev 2 → the posted item keeps the moved column.
  - `a deleted item leaves the board at the next audit`: `ado.remove(1205)`, then advance 15 min.
  - `a board with no requirement types never builds an empty IN list`.
  - `Refresh forces an audit`.
  - `a quiet board tick reports unchanged and backs off`.
  - Rewrite the existing tests listed under Files.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** the `workitems.ts` builders and readers.
- [ ] **Step 4: Implement `syncView`.**
- [ ] **Step 5: Make `ItemSource` store-backed**, and make `loadMine` and `loadBoardItems` take `ViewIds`.
- [ ] **Step 6: Extend `fake-ado.ts`**, wire sync state into the Work entry and the board views, and rewrite the broken tests.
- [ ] **Step 7: Run the tests and see them pass.**
- [ ] **Step 8: Verify** with the four commands.
- [ ] **Step 9: Commit.** `git commit -m "Sync work items by delta instead of re-reading every tick"`

---

### Task 13: Run view cadence

**Goal:**
- A running build's tab reads its timeline every 5 s, its logs every 2nd tick and the build every 4th, and backs off to 10 and then 20 s while nothing changes.
- A queued run, or one waiting on an approval, polls every 30 s.
- Timelines go into the shared table, where the runs list (Task 12) picks them up.

**Files:**
- Modify: `worker/pipelines/run-views.ts`, `worker/pipelines/run-views.test.ts`. Do not edit `fake-pipelines.ts`; use `ado.on` overrides.

**Interfaces**
- Consumes: `timelines` and `entities` in `RunViewsDeps` (Task 5); `quietMax`, `'unchanged'` and the visible lane (Task 3).
- Produces:
  - Intervals:
    - `RUNNING_MS = { visibleMs: 5_000, backgroundMs: 5_000 }` with `quietMax: 4`
    - `WAITING_MS = { visibleMs: 30_000, backgroundMs: 30_000 }` with `quietMax: 2`
    - `FINISHED_MS = { visibleMs: 60_000, backgroundMs: 60_000 }` with `quietMax: 4`
  - *Running* means a timeline record is `inProgress`. *Waiting* means the build is not finished, and either no record is `inProgress` or a stage waits on an approval.
  - `Held` gains `ticks: number`.
  - `read()` reads the build when any of these holds:
    - `ticks % 4 === 0`
    - there is no previous read
    - no timeline record is pending or `inProgress`

    Otherwise it reuses `previous.build`. It lists logs when `ticks % 2 === 0`, or when the timeline's `changeId` advanced; otherwise it reuses `previous.logLines`.
  - Each merged timeline is `put` into `entities.of(org).timelines` under `String(buildId)`.
  - `poll` resolves `'unchanged'` when `comparable(view)` didn't change.

- [ ] **Step 1: Write the failing tests.**
  - `a running build reads its timeline every tick, its logs every second tick and the build every fourth`: request counts over 8 ticks are 8 timeline, 4 logs and 2 builds.
  - `the build is read at once when the timeline shows every record completed`.
  - `a run waiting on an approval polls every 30 seconds`.
  - `a run whose timeline stopped changing backs off to 10 and 20 seconds, and a change brings it back to 5`.
  - `the run view's timeline is shared with the runs list`: after a run-view read, `entities.of(ORG).timelines.get(String(id))` holds it.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Poll a run tab only as fast as the run moves"`

---

### Task 7: PR records and checks in the store; chips reuse them

**Goal:**
- Merged and abandoned chips are final.
- Open chips refresh with one active-PR list per project, which stores only the PRs it was asked about.
- Policy evaluations are re-read on a push, on a reviewer or vote change, every 2 minutes while a build runs, and otherwise every 30 minutes.
- The PRs tab and chips share one copy, and a change from either updates chips and nudges with no request.

Spec §5.6.

**Files:**
- Modify: `worker/ado/pullrequests.ts` and `worker/ado/pullrequests.test.ts`. `RawPullRequest` gains `lastMergeSourceCommit?: { commitId?: string }`; add `toPrRecord`.
- Modify the fixtures:
  - add `lastMergeSourceCommit` to every PR in `worker/ado/fixtures/pull-requests-mine.json`, `pull-requests-review.json` and `pull-requests-completed.json`
  - add `lastMergeSourceCommit` and `reviewers` (with `vote`) to `pull-request-active.json` and `pull-request-completed.json`
- Modify: `worker/ado/policy.ts` (`checksDue`, `readChecks`) and `worker/ado/policy.test.ts`.
- Modify: `worker/ado/pr-links.ts` and `worker/ado/pr-links.test.ts`. Rewrite `loadPrChips` and delete `PrChipCache`.
- Modify `worker/prs/load.ts` and `worker/prs/load.test.ts`:
  - `createPrSource(http, org, now, tables)`
  - `list()` puts records
  - `checksOf` and `workItemsOf` use `prChecks` and `prWorkItems`
  - delete the `checks` and `workItems` `remember` caches; the `completed` list cache stays until Task 10
  - rewrite `caches expire on the polling budget` (line ~48), which asserts checks last 2 minutes: at +2 min only PRs whose build is running or queued are re-read; at +30 min all active ones are; a vote change or a new source commit re-reads that PR at once
- Modify: `worker/prs/service.ts` (pass tables).
- Modify: `worker/boards/snapshot.ts` (chips via the tables; `rechip`), `worker/boards/service.ts` (`entities.watch` on `prs` and `prChecks`), `worker/boards/service.test.ts`.
- Modify: `worker/boards/fake-ado.ts`. Add an active-list route for the sweep (`GET …/_apis/git/pullrequests` with `searchCriteria.status=active`) that answers the fake's open PRs.

**Interfaces**
- Consumes: `PrRecord`, `CheckRecord`, `prKey`, `reviewersSignature`, `Table`, `OrgEntities`, `Entities.watch`, `FRESHNESS` (Task 5); store-backed `ItemSource` (Task 6).
- Produces:

`worker/ado/pullrequests.ts`:
```ts
export function toPrRecord(raw: RawPullRequest, org: string): PrRecord
```
`worker/ado/policy.ts`:
```ts
export const MAX_CHECK_READS = 8
export function checksDue(pr: PrRecord, checks: Stamped<CheckRecord> | undefined, now: number): boolean
export function readChecks(http: AdoHttp, org: string, pr: PrRecord): Promise<CheckRecord>
```
`worker/ado/pr-links.ts`:
```ts
export const SWEEP_TOP = 500
export function chipOf(record: PrRecord, checks: CheckRecord | undefined): PrChip
export function loadPrChips(http: AdoHttp, org: string, refs: PrRef[], tables: Pick<OrgEntities, 'prs' | 'prChecks'>, now: () => number): Promise<PrChip[]>
```
`worker/boards/snapshot.ts`:
```ts
export function rechip(items: WorkItemSummary[], tables: Pick<OrgEntities, 'workItems' | 'prs' | 'prChecks'>): WorkItemSummary[]
```
- **`checksDue`** is true when the PR is `active` and any of these holds:
  - there are no checks yet
  - `checks.value.commit !== pr.sourceCommit`
  - `checks.value.reviewers !== pr.reviewers`
  - `checks.value.build` is `'running'` and its age is ≥ `FRESHNESS.checksRunning`
  - its age is ≥ `FRESHNESS.checksIdle`
- **`readChecks`** stores `commit: pr.sourceCommit` and `reviewers: pr.reviewers` with the evaluated `build` and `policies`.
- **`loadPrChips`:**
  1. Terminal records answer at once.
  2. Active or unknown records older than `FRESHNESS.prActive` are grouped by `projectId`. Each group gets one `listPullRequests(http, org, projectId, { status: 'active', top: SWEEP_TOP })`. **Only listed PRs whose key is among the requested refs are `put`.**
  3. A ref still unlisted after a list shorter than `SWEEP_TOP` is read once with the existing `fetchPullRequest`. So is any unlisted ref when the list was full.
  4. Due checks are read, oldest first, at most `MAX_CHECK_READS`.
  5. A 404 PR yields no chip, as today.
- **`rechip`** recomputes each item's `prs` from its record's PR refs (`toSummary(...).prRefs`) and the tables, through `foldChips`.
- **The boards service watches** `prs` and `prChecks` once, through `entities.watch`. On change, it applies `rechip` to the Work snapshot and to each held board that references a changed key. For the Work snapshot it also recomputes `nudges` with `findNudges(board, mine, rules, dismissed)`, because nudges read `item.prs`. It then caps and posts when the JSON changed, once per microtask batch.

- [ ] **Step 1: Write the failing tests.**

  `pr-links.test.ts`:
  - `a merged or abandoned PR in the store is never fetched again`: 0 calls.
  - `stale active refs refresh with one active-list read per project`: 3 refs in project A and 2 in B → 2 calls, each with `searchCriteria.status=active` and `$top=500`.
  - `the sweep stores only the PRs it was asked about`: a list of 10 active PRs for 2 refs → the `prs` table holds 2 entries.
  - `a ref missing from a short active list is read once by id and becomes final`.
  - `a full active list does not prove a missing ref closed, so it is read by id`.
  - `no more than 8 evaluation reads per load, oldest first`.

  `policy.test.ts`:
  - `checks are due when missing, after a push, after a reviewer or vote change, while running for 2 minutes, or at 30 minutes`: table-driven, including not due for a completed PR.

  `pullrequests.test.ts`:
  - `toPrRecord reads the source commit and a reviewer signature`.

  `prs/load.test.ts`:
  - `listed PRs and their checks land in the shared store`.
  - `checks read for a chip are reused by the PRs tab while fresh`: 0 evaluation calls.
  - The rewrite of `caches expire on the polling budget`.

  `boards/service.test.ts`:
  - `new checks from the PRs tab update board and Work chips without a request`: `put` into `prChecks` → after `drain()`, `work.changed` and `work.boardChanged` were posted and the ADO call count is unchanged.
  - `a PR that merges updates the Work tab's nudges without a request`.
  - `an hour later merged PR chips are not read again`: advance 61 min → 0 `GET …/pullrequests/{id}` for merged PRs.
  - Keep `a 403 turns chips off for 10 minutes` green.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `toPrRecord`, `checksDue`, `readChecks`, `chipOf` and `loadPrChips`.
- [ ] **Step 4: Point the PR source and the item source at the tables**, and delete `PrChipCache` and the two `remember` caches named above.
- [ ] **Step 5: Add `rechip` and the watcher** in the boards service.
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Verify** with the four commands, and `grep -rn "chipCache\|PrChipCache" worker` → no matches.
- [ ] **Step 8: Commit.** `git commit -m "Share PR status and checks between chips and the PRs tab"`

---

### Task 8: Persist last-known views: the module, the Work tab, boards, meta and PR records

**Goal:** Start-up paints the Work tab and boards at once from saved data, marked stale and showing its age, then revalidates. Saved configs, type states, code projects and PR records make the first revalidation cheap. Spec §5.7.

**Files:**
- Create: `worker/data/persist.ts`, `worker/data/persist.test.ts`
- Modify `worker/test-support.ts`: add `memoryCache(initial?)`, returning `{ data, port: CachePort }` with `delete` and `keys`.
- Modify `worker/boards/snapshot.ts`: add a `budget = POST_BUDGET_BYTES` parameter to `capSnapshot` and `budget = ANSWER_BUDGET_BYTES` to `capBoard`.
- Modify: `worker/boards/service.ts`, `worker/boards/board-views.ts`, `worker/boards/service.test.ts`
- Modify: `worker/messages.ts` (`SHOWING_SAVED`).
- Modify `worker/main.ts`:
  - Create `persisted` with the port `{ get: k => orca.storage.get(k), set: (k, v) => orca.storage.set(k, v as JsonValue), delete: k => orca.storage.delete(k), keys: () => orca.storage.keys() }` and `orgs: () => connections.list()`, then call `void persisted.sweep()`.
  - The `forgotten` hook becomes `org => { entities.forget(org); void persisted.forget(org) }`.
  - Add `await persisted.flush()` to `deactivate`, before `stopAllCommands`.

**Interfaces**
- Consumes: `capSnapshot`, `capBoard`, the store tables and the `forgotten` hook (Tasks 5–7); the board filter (Task 15).
- Produces in `worker/data/persist.ts`:
```ts
export const CACHE_PREFIX = 'adoCache:'
export const CACHE_VERSION = 'v1'
export const VALUE_BUDGET_BYTES = 160 * 1024
export const TOTAL_BUDGET_BYTES = 1536 * 1024
export const WRITE_EVERY_MS = 60_000
export const MAX_SAVED_BOARDS = 3
export interface CachePort { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; keys(): Promise<string[]> }
export interface Saved<T> { account: string; savedAt: number; value: T }
export interface Persisted {
  load<T>(org: string, name: string, account: string): Promise<Saved<T> | null>
  save(org: string, name: string, account: string, value: unknown): void
  forget(org: string): Promise<void>
  sweep(): Promise<void>
  flush(): Promise<void>
}
export interface PersistedDeps { port: CachePort; orgs: () => Promise<OrgStatus[]>; now: () => number; clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>; log: (message: string) => void }
export function cacheKey(org: string, name: string): string
export function createPersisted(deps: PersistedDeps): Persisted
```
- Produces in `worker/messages.ts`: `export const SHOWING_SAVED = 'Showing what was saved last time. Refreshing…'`.
- **Keys.** `cacheKey(org, name)` is `` `adoCache:v1:${org}:${name}` ``. Names: `work`, `board:<teamId>:<boardId>`, `meta`, `pr-records`; Task 9 adds `prs` and `runs`. `adoCache:v1:index` maps key → `{ bytes, usedAt }`.
- **`save`**
  - Debounced per key to one write per `WRITE_EVERY_MS`, skipped when the JSON is unchanged. The index key is debounced the same way.
  - At flush time, a pending value is dropped unless `deps.orgs()` shows its org `connected` with `account.adoId === account`.
  - A value over `VALUE_BUDGET_BYTES` is skipped and logged.
  - Before writing, it evicts least-recently-used keys until the total fits `TOTAL_BUDGET_BYTES`, and keeps only the `MAX_SAVED_BOARDS` most recently used `board:` names per org.
- **`load`** returns `null` for a missing value, a different `account`, or a wrong shape.
- **`forget`** cancels the org's pending writes, then deletes its keys.
- **`sweep`** deletes `adoCache:` keys not starting with `adoCache:v1:`.

**Boards service**
- **Restore the Work tab.** `work.snapshot` with no in-memory snapshot:
  - uses `load(org, 'work', status.account.adoId)` only if the org is connected, and the saved `board.projectId` and `board.teamId` match `status.boards`
  - sets the value as the entry snapshot with `stale: true` and `message: SHOWING_SAVED`, keeping its `updatedAt`
  - starts `void scheduler.runNow(mineKey(org))`
- **Restore a board.** `BoardViews.open` with no held view uses `board:<teamId>:<boardId>` the same way, only when the saved `everyone` equals the filter Task 15 resolved. The restored view's `at` is the saved `savedAt`, so `reload` doesn't skip the revalidation. Then it starts `void runNow(key)`.
- **Save views.** After each successful live projection:
  - Work: `save('work', capSnapshot(view, VALUE_BUDGET_BYTES))`
  - boards: `save('board:…', { result: capBoard(view, truncated, VALUE_BUDGET_BYTES), everyone })`
- **Save and restore the store.**
  - `meta` is `{ configs: [key, BoardConfig, at][], states: [key, TypeState[], at][], projects: [key, NamedItem[], at][] }`.
  - `pr-records` is `{ prs: [key, PrRecord, at][], checks: [key, CheckRecord, at][] }`, the newest 600 by `at`.
  - Both are saved after a tick that changed those tables, and restored with `put(key, value, at)` on the first request for an org.

- [ ] **Step 1: Write the failing tests.**

  `worker/data/persist.test.ts`. Use `memoryCache`, `fakeClock` and a settable org list.
  - `a saved view comes back for the same account and not for another`.
  - `writes, including the index, are debounced to one per key per minute and skipped when unchanged`.
  - `a pending write is dropped when its org is no longer connected or its account changed`.
  - `a value over 160 KiB is not written and is logged`.
  - `saving past 1.5 MiB evicts the least recently used entries first`.
  - `at most 3 boards are kept per org`.
  - `sweep deletes keys from other cache versions and leaves other plugin data alone`: keys `orgs`, `adoCache:v0:contoso:work` and `adoCache:v1:contoso:work` → only the `v0` key is deleted.
  - `forget cancels pending writes and deletes every key of that org`.
  - `flush writes pending values at once`.
  - `a wrongly shaped saved value is ignored`.

  `worker/boards/service.test.ts`:
  - `the Work tab paints a saved snapshot at once, marked stale with its age, then replaces it with a live one`: the first `snapshot()` answers with no ADO call, `stale: true`, `message: SHOWING_SAVED` and the saved `updatedAt`; then a `work.changed` with `stale: false`.
  - `a saved Work snapshot from another account or another boards target is ignored`.
  - `a saved snapshot is not served while the org is expired`: `snapshot()` rejects with the not-connected error.
  - `a sign-in interrupted by a restart keeps the saved data`: the org comes back `disconnected` with the interrupted message, and the keys remain.
  - `the board paints a saved view at once when no view is held, and revalidates it`.
  - `saved board configs, type states and PR records seed the store with their original age`: the first tick after restore makes no config, type-state or merged-PR request.
  - `a cold start of a board with 400 linked PRs costs under 15 requests when PR records were saved`: fake with 30 open and 370 merged linked PRs.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement `persist.ts`.** The timer comes through `deps.clock`.
- [ ] **Step 4: Wire restore and save** into the boards service and board views, and add the budget parameters to `capSnapshot` and `capBoard`.
- [ ] **Step 5: Wire `main.ts`.**
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Verify** with the four commands.
- [ ] **Step 8: Commit.** `git commit -m "Paint the Work tab and boards from saved data at start-up"`

---

### Task 16: Board age in the editor

**Goal:** While a board view is stale, the editor's note shows *"Updated ‹relative time› · refreshing…"*, and a live result clears it. This is the lead's call, pending the user's confirmation (spec §10 item 7, §5.11). It runs right after Task 8, in parallel with Task 9.

**Files:**
- Modify: `src/protocol.ts`. `work.board`'s output gains `updatedAt: number`.
- Modify: `worker/boards/board-views.ts` (`BoardResult.updatedAt`), `worker/boards/service.ts`, `worker/boards/service.test.ts`.
  - `loadBoard` sets `updatedAt: now()`.
  - A restored view keeps the saved `savedAt` as `updatedAt`, and no longer sets `SHOWING_SAVED` as its message, since the editor's line says "refreshing…".
  - `failed()` keeps the last `updatedAt`.
- Create: `src/board/age.ts`, `src/board/age.test.ts`.
- Modify: `src/board/board.ts` (`paint` uses `noteText`; a 60 s interval repaints while the stale note shows) and `src/board/render.ts` (`noteText`), plus `src/board/render.test.ts`.

**Interfaces**

`src/board/age.ts`:
```ts
export function ageText(at: number, now: number, locale: string): string
```
- `ageText` formats `Math.floor((now - at) / 1000)` seconds with `new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })`, in the largest whole unit among second, minute, hour and day.

`src/board/render.ts`:
```ts
export function noteText(view: { stale: boolean; updatedAt: number | null; message: string | undefined; empty: boolean }, now: number, locale: string): string
```
- **Stale with a known `updatedAt`:**
  - with no message: `` `Updated ${ageText(updatedAt, now, locale)} · refreshing…` ``
  - with a message: `` `Updated ${ageText(updatedAt, now, locale)} · ${message}` ``
- **Otherwise:** today's note: the message, or "No work items match." when the view is empty.

- [ ] **Step 1: Write the failing tests.**

  `age.test.ts`:
  - `ageText uses the largest whole unit`: in `'en'`, 0 s → `now`, 90 s → `1 minute ago`, 2 h → `2 hours ago`, 26 h → `yesterday`.

  `render.test.ts`:
  - `a stale board shows its age and that it is refreshing`.
  - `a stale board with a failure shows its age and the failure`.
  - `a live board shows today's note`.

  `service.test.ts`:
  - `a board result carries when it was loaded, and a restored one carries when it was saved`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `ageText` and `noteText`, then wire `paint` in `board.ts` with `orca.locale`.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Show a board's age in the editor while it refreshes"`

---

### Task 9: Persist the PRs and Pipelines views

**Goal:**
- The PRs and Pipelines tabs paint at once from saved data and revalidate.
- Restored finished runs keep their stage chips without a timeline read.
- Restored data is never acted on as if it were live.

**Files:**
- Modify: `worker/prs/service.ts`, `worker/prs/service.test.ts`. Add `persisted: Persisted` to deps; `capPrSnapshot(snapshot, budget = POST_BUDGET_BYTES)`.
- Modify: `worker/pipelines/service.ts`, `worker/pipelines/service.test.ts`. Add `persisted: Persisted` to deps; `capRunsSnapshot(snapshot, budget = POST_BUDGET_BYTES)`.
- Modify: `worker/pipelines/load.ts` and `worker/pipelines/load.test.ts`. `RunSource.seed(runs: RunSummary[])` puts each finished run's `stages` into `runChips` under `buildId:finishedAt`. This task replaces `finishedChips` with `tables.runChips`.
- Modify: `worker/main.ts` (pass `persisted` to PRs and pipelines).

**Interfaces**
- Consumes: `Persisted`, `SHOWING_SAVED` (Task 8); `runChips` (Task 5).
- Produces:
  - **Saved views.** Name `prs`: the last full `PrSnapshot`, capped to `VALUE_BUDGET_BYTES`. Name `runs`: the last full `RunsSnapshot`, capped the same way. Both are saved after each successful full load.
  - **Restore.** It runs in `snapshot(org)` when no entry has a snapshot:
    - publish the saved value with `stale: true` and `message: SHOWING_SAVED`
    - set `entry.restored = true`
    - call `void loadInFull(org)`
    - for Pipelines, also call `source.seed(saved.runs)`
    
    A live full load clears `restored`.
  - **Restored data is a miss.** While `entry.restored`:
    - `prs.cached(org, key)` returns `null`
    - `pipelines.cachedRun(org, buildId)` returns `null`
    - `pipelines.approval(org, key)` skips its `base` lookup and reads ADO
    - `pipelines.watch(...)` reads the run with `readRun`
  - A restored PR snapshot is never passed to `notifier.observe`, and does not set `baselined`.

- [ ] **Step 1: Write the failing tests.**
  - `the PRs tab paints saved PRs at once, stale, then live`.
  - `restored PRs never raise review or comment notifications`.
  - `saved PRs from another account are ignored`.
  - `a share of a restored PR reads it from Azure DevOps first`: `cached()` returns `null` while restored.
  - `the Pipelines tab paints saved runs at once, stale, then live`.
  - `an approval in restored runs is read from Azure DevOps before it is shared`.
  - `watching a run in restored runs reads it first`.
  - `finished runs restored from storage keep their stage chips without a timeline read`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** restore and save in both services, the `restored` checks, `seed`, and the move of `finishedChips` to `runChips`.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands, and `grep -rn "finishedChips" worker` → no matches.
- [ ] **Step 6: Commit.** `git commit -m "Paint the PRs and Pipelines tabs from saved data at start-up"`

---

### Task 10: Hot and cold projects for PRs and pipelines

**Goal:**
- While a tab is visible, projects where the user has had nothing for 24 hours are listed at most every 5 minutes, and their last results are reused between reads.
- Hidden polls run every 5 minutes, so they read every project, which keeps notifications within about 5 minutes (spec §10 items 2 and 5).
- Refresh reads every project.

**Files:**
- Create: `worker/data/heat.ts`, `worker/data/heat.test.ts`
- Modify: `worker/prs/load.ts`, `worker/prs/service.ts`, `worker/prs/load.test.ts`, `worker/prs/service.test.ts`
- Modify: `worker/pipelines/load.ts`, `worker/pipelines/service.ts`, `worker/pipelines/load.test.ts`, `worker/pipelines/service.test.ts`

**Interfaces**
- Consumes: `NamedItem[]` from `cachedCodeProjects` (Task 5).
- Produces in `worker/data/heat.ts`:
```ts
export const HOT_FOR_MS = 24 * 60 * 60_000
export const COLD_EVERY_MS = 5 * 60_000
export interface Heat { pick(projects: NamedItem[], all: boolean): NamedItem[]; saw(projectId: string, found: boolean): void }
export function createHeat(now: () => number): Heat
```
`COLD_EVERY_MS` is the lead's call, pending the user's confirmation (spec §10 item 5).

- **`pick`** returns, unless `all` is set:
  - projects never read
  - hot projects (`found` true within `HOT_FOR_MS`)
  - cold projects whose last read is at least `COLD_EVERY_MS` old
  
  With `all`, it returns every project.
- **PR source**
  - `full`, `reviews` and `active` take `all: boolean` and read only the picked projects.
  - Results are kept per project (`{ mine, completed, completedAt, review }`). The composed load covers every project from the latest kept results.
  - The completed list per project is re-read at most every 5 minutes. This replaces its `remember` cache.
  - `found` = any of mine, completed or review is non-empty.
- **Run source.** Lists are kept per project the same way. `found` = any of my runs, running runs or pending approvals is non-empty.
- **Which reads use `all`.** `refresh` and `reloadFresh` pass `all: true`; job ticks pass `false`.

- [ ] **Step 1: Write the failing tests.**

  `heat.test.ts`:
  - `a project never read is picked at once`.
  - `a hot project is picked every tick, and a cold one at most every 5 minutes`.
  - `a project that found something stays hot for 24 hours`.
  - `all picks every project`.

  PRs:
  - `a visible PR tick lists only hot projects and keeps the cold projects' last results`.
  - `a hidden PR tick reads every project`, since ticks come every 5 minutes.
  - `Refresh lists every project`.
  - `a review request in a cold project appears within 5 minutes, visible or hidden`.
  - `the completed list of a project is read at most every 5 minutes`.

  Pipelines:
  - `a visible runs tick lists only hot projects and keeps the cold projects' last runs`.
  - `Refresh lists every project`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `heat.ts` and the per-project results in both sources.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "List quiet projects less often in the PRs and Pipelines tabs"`

---

### Task 11: PRs cadence: quiet back-off, thread back-off, stale-while-revalidate

**Goal:**
- An unchanged PR poll backs off to 120 s visible, and never past 5 minutes.
- Opening the tab shows the last load at once and revalidates it.
- Comment threads are re-read per PR, from 2 to 10 minutes (decision 3).
- Hidden observes no longer list every project.

**Files:**
- Create: `worker/prs/thread-cadence.ts`, `worker/prs/thread-cadence.test.ts`
- Modify: `worker/prs/service.ts`, `worker/prs/load.ts`, `worker/prs/service.test.ts`

**Interfaces**
- Consumes: `Heat` (Task 10); `NOTIFY_CAP_MS` and the `'unchanged'` job result (Task 3).
- Produces in `worker/prs/thread-cadence.ts`:
```ts
export const THREADS_FIRST_MS = 2 * 60_000
export const THREADS_MAX_MS = 10 * 60_000
export interface ThreadCadence { due(watched: PrSummary[]): PrSummary[]; read(pr: PrKey, signature: string): void; forget(): void }
export function createThreadCadence(now: () => number): ThreadCadence
export function threadSignature(threads: readonly RawThread[]): string
```
- **`threadSignature`** = the thread count, plus the maximum of every comment's `lastUpdatedDate` and `publishedDate`.
- **`due(watched)`**
  - first drops cadence entries for PRs not in `watched`
  - then returns the PRs never read, or whose interval has passed since their last read
- **`read`** doubles the interval up to `THREADS_MAX_MS` when the signature is unchanged, and resets it to `THREADS_FIRST_MS` when it changed.
- **The `prs:` job** is `{ org, visibleMs: 60_000, backgroundMs: 300_000, quietMax: 2, quietCapMs: NOTIFY_CAP_MS }`. `poll` resolves `'unchanged'` when the composed snapshot equals the previous one apart from `updatedAt`.
- **`snapshot(org)`** returns the last full snapshot at once whenever one exists. When it is older than the service's own `FRESH_MS` (60 s), it also starts `void loadInFull(org)`.
- **`observe`** reads threads only for `cadence.due(watchedPrs(mine))`. `mine` is the last full load's list when it is under 10 minutes old, otherwise `source.active(me, projects, false)`, which reads the hot projects.

- [ ] **Step 1: Write the failing tests.**

  `thread-cadence.test.ts`:
  - `a PR whose threads didn't change is re-read after 2, then 4, 8 and 10 minutes`.
  - `a changed signature resets that PR to 2 minutes`.
  - `a PR never read is due at once`.
  - `PRs no longer watched are dropped from the cadence`.

  `prs/service.test.ts`:
  - `an unchanged PR poll backs off to 120 seconds`.
  - `a hidden PR poll never backs off past 5 minutes`.
  - `opening the PRs tab shows the last load at once, even when older than a minute, and refreshes it`.
  - `a new comment on a quiet PR notifies once within 10 minutes`.
  - `a hidden observe lists active PRs only in hot projects`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `thread-cadence.ts`, then the service changes.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Back off PR polling and comment reads when nothing changes"`

---

### Task 12: Pipelines cadence: quiet back-off, shared timelines, watch dedupe

**Goal:**
- With nothing moving, the runs job backs off up to ×4, and never past 5 minutes.
- Stage chips read timelines with the stored `changeId`, skip a timeline a run view refreshed in the last 5 s (written by Task 13), and never re-read a finished one.
- The watch job skips runs the list just read, and polls every 60 s while hidden.
- Opening the tab shows the last load at once.

**Files:**
- Modify: `worker/pipelines/load.ts`, `worker/pipelines/service.ts`, `worker/pipelines/load.test.ts`, `worker/pipelines/service.test.ts`

**Interfaces**
- Consumes: `timelines`, `builds` and `runChips` (Task 5); timelines written by run views (Task 13); `NOTIFY_CAP_MS` (Task 3); `mergeTimeline` and `getTimeline(…, changeId)` (existing).
- Produces:
  - `RUNS_MS = { visibleMs: 30_000, backgroundMs: 300_000 }` with `quietMax: 4` and `quietCapMs: NOTIFY_CAP_MS`. `poll` resolves `'unchanged'` when the composed runs equal the previous ones apart from `updatedAt`.
  - `WATCH_MS = { visibleMs: 30_000, backgroundMs: 60_000 }`, plus `WATCH_SKIP_MS = 30_000`.
  - **Timeline reads.** With `stored = tables.timelines.get(String(buildId))`:
    - a stored timeline under 5 s old, or of a finished run, is used as is
    - otherwise read `getTimeline(http, org, projectId, buildId, stored?.value.changeId)`, merge it with `mergeTimeline(stored?.value ?? null, answer)`, and `put` the result
  - Every listed build is `put` into `tables.builds`.
  - `watched()` skips keys whose `builds` entry is under `WATCH_SKIP_MS` old.
  - `snapshot(org)` returns the last full snapshot at once, and starts `void loadInFull(org)` when it is older than the service's own `FRESH_MS` (30 s).

- [ ] **Step 1: Write the failing tests.**
  - `a runs tick with nothing moving backs off to two minutes`.
  - `a hidden runs tick never backs off past 5 minutes`.
  - `the runs list reads an active run's timeline with the stored changeId and merges it`: the second read's query has `changeId` equal to the first answer's.
  - `the runs list skips a timeline a run view read in the last 5 seconds`: seed `timelines` directly.
  - `a finished run's timeline is never read again`.
  - `the watch job skips runs the runs list read in the last 30 seconds`.
  - `the watch job polls every 60 seconds while hidden`.
  - `opening the Pipelines tab shows the last load at once and refreshes it when older than 30 seconds`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Share run timelines and back off pipeline polling when nothing moves"`

---

### Task 17: Docs pass

**Goal:** One pass brings the user docs in line with everything that landed. No code changes.

**Files:**
- Modify: `docs/reference.md`, `docs/work.md`, `docs/development.md`

**Changes**

`docs/reference.md`, Polling:
- **My work** polls only while the Work tab is visible, asks only for what changed, and rechecks everything every 15 minutes.
- **An open board** polls every 30 seconds while visible, asks only for what changed, and keeps its cards when hidden. It refreshes on return if they are over 30 seconds old, and slows to every minute while nothing changes.
- **PR chip status:** merged or abandoned is final. Open status is checked with one list per project every 2 minutes. Build and policy status is re-read on a push, on a reviewer or vote change, every 2 minutes while a build runs, and otherwise every 30 minutes.
- **PRs tab**
  - every 60 seconds while visible, slowing to 2 minutes while nothing changes
  - projects without your pull requests are listed every 5 minutes
  - every 5 minutes otherwise, reading every project
  - opening the tab shows the last data at once and refreshes it if it is over a minute old
- **Comment notifications:** each active pull request's threads are re-read every 2 minutes, slowing to every 10 while nothing changes.
- **PRs tab caches:** replace "build and policy status for 2 minutes" with the chip rule above.
- **Pipelines tab**
  - every 30 seconds while visible, slowing to 2 minutes while nothing moves
  - quiet projects are listed every 5 minutes
  - timelines are read only for what changed and shared with an open run tab
  - opening the tab shows the last data at once
- **Watched runs:** every 30 seconds while the Pipelines tab is visible, every minute otherwise.
- **An open run tab:** every 5 seconds while a step runs (the run every 20 seconds, its logs every 10), every 30 seconds while queued or waiting for an approval, every minute once finished. It slows down while nothing changes.
- **Slow-down**, replacing the existing bullet: when Azure DevOps signals rate-limit pressure for an organisation, all of its background polling slows by ×2, ×4 or ×8 depending on how close it is. After a 429 or a `Retry-After`, nothing polls in the background until the wait has passed. Your own clicks are never held back. It returns to normal 5 minutes after the last signal.
- Remove the per-job "polling pauses" wording.

`docs/reference.md`, Status bar: **Connection status** also shows, for each organisation with traffic in the last 5 minutes:
- requests by feature
- the busiest endpoints
- the rate-limit state
- throttling and `X-RateLimit-Cost` when present

`docs/reference.md`, a new "Saved data" section:
- **What is kept:** the Work tab, up to 3 boards per organisation, PRs, runs, board settings and PR status.
- **Where:** Orca's plugin storage, at most 1.5 MiB.
- **How it shows:** as "Showing what was saved last time. Refreshing…", or on a board as "Updated ‹time› · refreshing…", until refreshed.
- **When it is deleted:** on sign-out and on removing the organisation.

`docs/work.md`:
- The **Me** and **Everyone** line gains: "Each board remembers your choice."
- Add one line saying a board shows "Updated ‹time› · refreshing…" while it refreshes saved or older data.

`docs/development.md`, add to "Live checks still pending":
- **Boards:**
  - The delta query with `timePrecision=true` is accepted on the client organisation and returns only items changed since the watermark.
  - Adding a child task and linking a PR each bump the parent's `rev` and `ChangedDate`.
- **General:** on the client organisation, read **Connection status** after 10 minutes with the Work tab and a board open, and record the totals, the `X-RateLimit-*` line, and which endpoints sent an `ETag`.

- [ ] **Step 1: Make the changes above.** Check each sentence against the code that landed.
- [ ] **Step 2: Verify** with the four commands, which must be unchanged.
- [ ] **Step 3: Commit.** `git commit -m "Describe the new polling, saved data and request counts"`

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| §5.1 Request context and lanes | 2, 3 |
| §5.2 Pressure, governor | 1, 2 |
| §5.3 Scheduler pacing | 3 |
| §5.4 Entity store | 5, plus 7, 9, 12 and 13 for the PR, run-chip and timeline tables |
| §5.5 Delta sync | 6 |
| §5.6 PR chips from the store | 7 |
| §5.7 Persistence | 8, 9 |
| §5.8 Visibility and cadence | 4, 10, 11, 12, 13 |
| §5.9 Metrics | 14 |
| §5.10 Board filter memory | 15 |
| §5.11 Board age in the editor | 16 |
| §3.9 Live checks | 17 (`docs/development.md`) |
| Decision 1: `orca.storage` (settled) | 8 |
| Decisions 2 and 3: cold projects every 5 min; comment back-off 2–10 min (settled) | 10, 11 |
| Decision 4: remember each board's filter (settled) | 15 |
| Item 5, notification latency (lead's call, pending): `COLD_EVERY_MS`, `NOTIFY_CAP_MS` | 3, 10, 11, 12 |
| Item 6, PR policy lag (lead's call, pending): `FRESHNESS.checksIdle`, the reviewer rule | 5, 7 |
| Item 7, board age (lead's call, pending): drop Task 16 to flip | 16 |
