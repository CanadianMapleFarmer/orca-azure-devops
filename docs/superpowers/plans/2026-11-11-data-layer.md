# Data layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the plugin's Azure DevOps requests by roughly an order of magnitude and make start-up and tab switches instant. Five parts:
- a per-org request governor
- a shared entity store
- work-item delta sync
- persisted last-known views
- budget-aware cadences

**Architecture:**
- Every request goes through a per-org governor. It caps concurrency, merges duplicates and favours user requests, and it is fed by a pressure tracker that reads ADO's rate-limit headers on every response.
- The scheduler paces every org job by that pressure and by a quiet back-off.
- Features read and write one entity store, and views are projections of it.
- Work items sync by delta WIQL.
- PR chips reuse the PRs service's data.
- The last views persist to `orca.storage`, within a strict budget.

**Tech Stack:** TypeScript loaded build-less by Orca (`engines.orca >=1.4.248`), Node 24 worker, `orca/testing` (node:test), `node:async_hooks` `AsyncLocalStorage`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-11-data-layer-design.md`. Read it, and `docs/research/2026-11-11-request-inventory.md`, before starting. Section numbers below (§5.5 and so on) refer to the spec.

## Global Constraints

**Comments**
- Code explains itself. The default is **zero comments**.
- A single one-line comment is allowed only for a constraint the code cannot express.
- No narrative comments, no investigation history.
- XML or JSDoc summaries are at most 2 lines.

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

**Dependencies and Orca API**
- No new runtime dependencies. `AsyncLocalStorage` comes from `node:async_hooks`.
- No new manifest capabilities. `storage:own` is already granted, and `orca.storage` has `get`, `set`, `delete` and `keys`.

**Panel budgets.** Every view posted or answered still goes through the existing cap functions:
- `capSnapshot`, `capBoard`, `capPrSnapshot`, `capRunsSnapshot`
- `POST_BUDGET_BYTES` 240 KiB and `ANSWER_BUDGET_BYTES` 900 KiB from `worker/budget.ts`

**Your own writes.** `worker/boards/recent.ts` and its overlay stay. A user's move, comment, link, vote or approval must never be replaced by an older poll.

**Auth.** Saved data is served only to a connected org whose pinned `account.adoId` equals the saved `account`. `unauthorized` errors are never swallowed.

**Persisted cache budgets**
- Prefix `adoCache:v1:`.
- At most 160 KiB per value and 1.5 MiB in total.
- At most one write per key per 60 s.

**Copy.** The saved-data message is exactly: `Showing what was saved last time. Refreshing…`

**Generic.** No org, project, team or account names outside test fixtures. Fixtures use `contoso` and `fabrikam`.

**Commits**
- One commit per task, with an imperative subject in the repo's style ("Keep hidden boards and serve them at once").
- Use the local git identity and end with the session's `Co-Authored-By` trailer.
- Never commit `node_modules/` or `.orca/`. Do not push.

**Docs.** When a task changes a cadence or cache that `docs/reference.md` describes (Polling, Status bar), update that bullet in the same commit.

## Review Focus

1. **A different account signs in after a restart.** Account A's saved Work view must never be shown to account B. *Test: Task 8, `a saved view comes back for the same account and not for another` and `a saved Work snapshot from another account or another boards target is ignored`.*
2. **The laptop clock is minutes off from ADO's.** The delta watermark must come from ADO's `asOf`, never from the local clock. *Test: Task 6, `the next delta starts at the server's asOf, not the local clock`.*
3. **A delta tick reads an older `rev` from a lagging replica right after the user moved a card.** The card must stay where the user put it. *Tests: Task 6, `a hydrate that returns an older rev never replaces a newer record` and `the user's move survives a delta that returns the older rev`.*
4. **`orca.storage` is already near its 5 MiB cliff from other plugin data.** The cache must evict, never grow. *Test: Task 8, `saving past 1.5 MiB evicts the least recently used entries first`.*
5. **ADO answers `Retry-After: 30` while the user presses Refresh.** The user request must fail within 10 s with the existing throttling message, and background jobs must not start until it passes. *Tests: Task 2, `while blocked for longer than 10 s, a user request fails with retryAfterMs`; Task 3, `an org job waits out its org's resumeAt`.*

---

## File map

| File | Responsibility | Task |
| --- | --- | --- |
| `worker/data/rate-limit.ts` | Parse rate-limit headers; per-org pressure level, factor and `resumeAt`; `paceOf` | 1 |
| `worker/data/context.ts` | `AsyncLocalStorage` request context (feature, priority); mapping from request names and job keys; `withUserContext` | 2 |
| `worker/data/governor.ts` | Per-org concurrency, merging of identical reads, user priority, blocked handling | 2 |
| `worker/poll/scheduler.ts` | Pace by org, quiet back-off, idle-when-hidden, background context | 3 |
| `worker/data/freshness.ts` | Every freshness window and table size in one place | 5 |
| `worker/data/records.ts` | `ItemRecord`, `PrRecord`, `CheckRecord`, `prKey` | 5 |
| `worker/data/entities.ts` | Per-org typed tables: guard, LRU, single-flight `read`, `subscribe` | 5 |
| `worker/boards/sync.ts` | Delta and audit sync of one view's membership | 6 |
| `worker/data/persist.ts` | Versioned, budgeted, debounced persistence of last-known views | 8 |
| `worker/data/heat.ts` | Hot and cold project rotation | 10 |
| `worker/prs/thread-cadence.ts` | Per-PR thread re-read back-off | 11 |
| `worker/data/metrics.ts` | Per-org request counts, endpoints, rate-limit headers; status lines | 14 |
| `worker/boards/board-filters.ts` | Each board's remembered Me / Everyone choice | 15 |

Tests sit beside their files as `*.test.ts`.

## Tasks, dependencies and parallel safety

"Shares files with" lists other tasks that edit the same files. Tasks that share files must run one after the other, or the later one rebases onto the earlier. Tasks marked ∥ can run at the same time in separate worktrees.

| # | Task | Depends on | Shares files with | Can run in parallel with |
| --- | --- | --- | --- | --- |
| 1 | Rate-limit signals and per-org pressure | — | 14 (`http.ts` observe only) | — |
| 2 | Request context and the governor | 1 | 3, 5, 8, 9, 14 (`main.ts`) | — |
| 3 | Scheduler pacing; retire `pipelines/pressure.ts` | 1, 2 | 4–13 (job definitions), `main.ts` | ∥ 14 |
| 4 | Keep hidden boards; Work idles while hidden | 3 | 5–8, 15 (`boards/service.ts`, `board-views.ts`) | ∥ 14 |
| 15 | Remember each board's filter | 4 | 5–8 (`boards/service.ts`) | ∥ 14 |
| 5 | Entity store; move config, state, project and wiki caches | 2, 4 and 15 (files) | 6–13 | ∥ 14 |
| 6 | Delta sync of work items | 4, 5 | 7, 8 (`boards/*`) | ∥ 13, ∥ 14 |
| 7 | PR records and checks in the store; chips reuse them | 5, 6 | 8, 10, 11 | ∥ 13, ∥ 14 |
| 8 | Persist Work, board, meta and PR records | 6, 7 | 9, 14 (`main.ts`) | ∥ 13 |
| 9 | Persist PRs and Pipelines views | 8 | 10, 11, 12 | ∥ 13 |
| 10 | Hot and cold projects | 5, 9 (files) | 11, 12 | ∥ 13 |
| 11 | PRs cadence | 7, 10 | — | ∥ 12, ∥ 13 |
| 12 | Pipelines cadence | 5, 10 | — | ∥ 11, ∥ 13 |
| 13 | Run view cadence | 3, 5 | — (only `run-views.ts`) | ∥ 6–12, ∥ 14 |
| 14 | Request metrics in Connection status | 1, 2 | 1, 3, 5, 8 (`main.ts`, wiring lines only) | ∥ 3–13, ∥ 15 |

Task 15 was added after the user settled decision 4. Its number is out of order so the other tasks keep theirs, but it runs right after Task 4.

Suggested waves:
1. 1
2. 2
3. 3 and 14
4. 4, then 15
5. 5
6. 6 and 13
7. 7
8. 8
9. 9
10. 10
11. 11 and 12

Task 14 has no real dependency past 2. Running it early records a "before" baseline in the status command.

---

### Task 1: Rate-limit signals and per-org pressure

**Goal:** Every raw ADO response, including 429s that `http.ts` retries internally, reaches one per-org pressure tracker. Nothing acts on the tracker yet.

**Files:**
- Create: `worker/data/rate-limit.ts`, `worker/data/rate-limit.test.ts`
- Modify: `worker/ado/http.ts` (`AdoHttpDeps.observe`, called after every `send`), `worker/ado/http.test.ts`
- Modify: `worker/connections.ts` (`ConnectionsDeps.observe?`, passed to both `createAdoHttp` calls: `http.json` and `identify`), `worker/connections.test.ts`

**Interfaces:**
- Produces:
```ts
// worker/ado/http.ts
export type ResponseObserver = (req: AdoRequest, status: number, headers: Headers) => void
export interface AdoHttpDeps { /* existing */ observe?: ResponseObserver }

// worker/data/rate-limit.ts
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
- `Retry-After` (numeric seconds, any status) sets `resumeAt = max(resumeAt, now + ms)` and `nearUntil = now + PRESSURE_WINDOW_MS`.
- A 429 without `Retry-After` sets `resumeAt = now + DEFAULT_BLOCK_MS`.
- `X-RateLimit-Delay` sets `delayedUntil = now + PRESSURE_WINDOW_MS`.
- `X-RateLimit-Limit` or `X-RateLimit-Remaining` sets `nearUntil = now + PRESSURE_WINDOW_MS`. The level is *tight* while the last `remaining` is ≤ 25% of the last `limit`, or is 0.
- The level is the strongest of: `blocked` (now < resumeAt), `delayed`, `tight`, `near`, `normal`.
- `last` keeps the most recent response that carried any rate-limit header.

- [ ] **Step 1: Write the failing tests** in `worker/data/rate-limit.test.ts`. Use `T0 = Date.parse('2026-11-11T10:00:00Z')`, a mutable clock, and `req = { org: 'contoso', path: '/_apis/wit/wiql' }`.
  - `readRateLimit reads every documented header and its units`:
    ```ts
    const headers = new Headers({ 'Retry-After': '7', 'X-RateLimit-Resource': 'ATCommonDb', 'X-RateLimit-Delay': '1.250', 'X-RateLimit-Limit': '200', 'X-RateLimit-Remaining': '30', 'X-RateLimit-Reset': '1762855200', 'X-RateLimit-Cost': '0.01234' })
    assert.deepEqual(readRateLimit(headers), { retryAfterMs: 7000, resource: 'ATCommonDb', delayMs: 1250, limit: 200, remaining: 30, resetAt: 1762855200000, cost: 0.01234 })
    ```
  - `readRateLimit returns null without rate-limit headers and ignores malformed values`. Use `content-type` only → `null`, and `Retry-After: soon` alone → `null`.
  - `Retry-After blocks the org until it passes, on a 200 as well as a 429, then leaves it near`:
    - 200 with `Retry-After: 7`: `state('contoso')` is `{ level: 'blocked', factor: 8, resumeAt: T0 + 7000 }` and `state('fabrikam').level` is `'normal'`.
    - At `T0 + 7000` the level is `'near'`. At `T0 + 300_000` it is `'normal'`.
  - `a 429 without Retry-After blocks for 60 seconds`: `resumeAt === T0 + 60_000`.
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
- [ ] **Step 3: Implement `readRateLimit`, `createPressure` and `paceOf`** in `worker/data/rate-limit.ts`. Header names are case-insensitive through `Headers`. Then call `deps.observe?.(req, res.status, res.headers)` in `http.ts` right after each `send` resolves, and add `observe?: ResponseObserver` to `ConnectionsDeps` and pass it into both `createAdoHttp` calls.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four Global Constraints commands.
- [ ] **Step 6: Commit.** `git add worker/data/rate-limit.ts worker/data/rate-limit.test.ts worker/ado/http.ts worker/ado/http.test.ts worker/connections.ts worker/connections.test.ts && git commit -m "Read Azure DevOps rate-limit headers on every response"`

---

### Task 2: Request context and the governor

**Goal:** Every service talks to ADO through one per-org governor.
- Panel requests run as `user` and scheduler runs as `background`, each tagged with its feature.
- Identical reads in flight share one request.
- A blocked org fails background requests at once.

**Files:**
- Create: `worker/data/context.ts`, `worker/data/context.test.ts`, `worker/data/governor.ts`, `worker/data/governor.test.ts`
- Modify `worker/main.ts`:
  1. Create `pressure = createPressure(Date.now)` before `createConnections` and pass `observe: pressure.observe`.
  2. Create `governor = createGovernor({ http: connections.http, pressure, now: Date.now })`.
  3. Replace `pressure.wrapByOrg(connections.http)` with `governor`, and give `pipelines` and `runViews` `http: governor` too. They keep their old slow-down until Task 3, imported as `import { createPressure as createSlowDown } from './pipelines/pressure'`.
  4. Register every handler through `const host = withUserContext(orca)`, passing `host` to `registerWorkspaceHandlers`, `registerOrgHandlers`, `registerWorkHandlers`, `registerPrHandlers`, `registerReviewHandlers`, `registerWikiHandlers`, `registerPipelineHandlers`, `registerShareHandlers`, `registerVisibilityHandler`, and `host.panels.handle('plugin.ping', …)`.

**Interfaces:**
- Consumes: `Pressure`, `PressureState` (Task 1).
- Produces:
```ts
// worker/data/context.ts
export type Feature = 'work' | 'board' | 'prs' | 'reviews' | 'pipelines' | 'run' | 'wiki' | 'share' | 'connect' | 'other'
export type Priority = 'user' | 'background'
export interface RequestContext { feature: Feature; priority: Priority }
export function inContext<T>(context: RequestContext, run: () => T): T
export function currentContext(): RequestContext
export function featureOfRequest(name: string): Feature
export function featureOfJob(key: string): Feature
export function withUserContext(orca: OrcaWorkerApi): OrcaWorkerApi

// worker/data/governor.ts
export const MAX_IN_FLIGHT = 6
export const MAX_BACKGROUND = 4
export const MAX_BACKGROUND_PRESSED = 1
export const MAX_USER_WAIT_MS = 10_000
export interface GovernorDeps { http: AdoHttp; pressure: Pick<Pressure, 'state'>; now: () => number; sleep?: (ms: number) => Promise<void> }
export function mergeKey(req: AdoRequest): string | null
export function createGovernor(deps: GovernorDeps): AdoHttp
```
- Mappings (spec §5.1):
  - `featureOfRequest`:

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
    | anything else | `other` |

  - `featureOfJob`:

    | Job key prefix | Feature |
    | --- | --- |
    | `mine:` | `work` |
    | `board:` | `board` |
    | `prs:` | `prs` |
    | `runs:`, `watch:` | `pipelines` |
    | `runview:` | `run` |
    | anything else | `other` |

  - `currentContext()` outside any context is `{ feature: 'other', priority: 'user' }`.
- `withUserContext` builds its result with `Object.create(orca, { panels: { value: Object.create(orca.panels, { handle: { value: wrapped } }) } })`, so every other member keeps working whether it is an own or a prototype property.
- `mergeKey`:
  - returns `null` for anything that isn't a GET or a POST whose path ends in `/_apis/wit/wiql` or `/_apis/wit/workitemsbatch`
  - otherwise returns org, host, project, path, query entries sorted by key, `apiVersion` and `JSON.stringify(body)`, joined
  - ignores `signal`

- [ ] **Step 1: Write the failing tests.**

  `worker/data/context.test.ts`:
  - `inContext is visible across awaits and timers inside the run`: after an `await` and a `setImmediate`, `currentContext()` deep-equals the context passed in.
  - `outside any context the default is a user request for other`.
  - `featureOfRequest maps request names to features`: table-driven over every row of the request table, including `ui.visibility` → `other`.
  - `featureOfJob maps job keys to features`: `mine:contoso`, `board:contoso:t:b`, `prs:contoso`, `runs:contoso`, `watch:contoso`, `runview:contoso:42`, and `arm-expiry` → `other`.
  - `withUserContext runs every handler as a user request for its feature, and leaves the rest of the API working`. Use a fake `orca` whose `panels` has `handle` and `post` on its prototype. A handler registered as `work.board` returns `currentContext()` → `{ feature: 'board', priority: 'user' }`, and `host.panels.post` still reaches the fake.

  `worker/data/governor.test.ts`. The fake inner `AdoHttp` records requests and answers through deferreds. The fake pressure returns a settable `PressureState`.
  - `identical GETs in flight share one request`: one inner call; both callers get the same `data`.
  - `wiql and workitemsbatch posts with the same body share one request, other writes never do`: wiql ×2 same body → 1 call; PATCH ×2 → 2 calls; wiql with different bodies → 2 calls.
  - `mergeKey ignores query order and the signal, and refuses writes`.
  - `a caller that aborts leaves the shared request running for the others`:
    - The aborted caller rejects with its own `signal.reason`.
    - The other caller resolves.
    - The inner request's signal is aborted only after both callers abort.
  - `no more than 6 requests run at once for an org, and other orgs are not held back`.
  - `background requests take at most 4 slots, leaving 2 for user requests`: under `inContext({ feature: 'board', priority: 'background' })`, 6 requests leave 4 running; a user request then starts at once.
  - `queued user requests start before queued background requests`.
  - `under delayed pressure background requests run one at a time`.
  - `while blocked, a background request fails at once with retryAfterMs`: `resumeAt = now + 30_000`; it rejects with `AdoError` `rate_limited` and `retryAfterMs === 30_000`; the inner client is not called.
  - `while blocked, a user request waits up to 10 s and then is sent`: `resumeAt = now + 5_000`; the stub `sleep` is called with `5_000`; then one inner call.
  - `while blocked for longer than 10 s, a user request fails with retryAfterMs`: `resumeAt = now + 30_000` → `rate_limited`, `retryAfterMs === 30_000`.
  - `errors pass through unchanged, including unauthorized`: the same `AdoError` instance is rejected.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement `context.ts`.** Use one module-level `AsyncLocalStorage<RequestContext>`.
- [ ] **Step 4: Implement `createGovernor`.**
  - Keep one queue per org.
  - A request's priority is `currentContext().priority` at call time.
  - The background slot limit is `MAX_BACKGROUND_PRESSED` while the org's level is `delayed` or `blocked`, otherwise `MAX_BACKGROUND`.
  - Merged requests run with an internal `AbortController`, aborted when the last joined caller aborts.
  - A queued user request joining an identical queued background request lifts it to user priority.
- [ ] **Step 5: Wire `main.ts`** as described under Files.
- [ ] **Step 6: Run the tests and see them pass.** Existing worker tests (`worker/main.test.ts`) must stay green.
- [ ] **Step 7: Verify** with the four commands.
- [ ] **Step 8: Commit.** `git commit -m "Send every Azure DevOps request through a per-org governor"`

---

### Task 3: Scheduler pacing, quiet back-off and idle-when-hidden

**Goal:** Every org job follows its org's pressure factor and `resumeAt`, backs off when nothing changed, and can idle while hidden. This replaces `pipelines/pressure.ts` and the per-job 429 pause.

**Files:**
- Modify: `worker/poll/scheduler.ts`, `worker/poll/scheduler.test.ts`
- Modify: `worker/pipelines/service.ts`, `worker/pipelines/service.test.ts`. Remove `pressure` from deps, `RUNS_SLOWED_MS` and `WATCH_SLOWED_MS`; add `org` to the `runs:` and `watch:` jobs.
- Modify: `worker/pipelines/run-views.ts`, `worker/pipelines/run-views.test.ts`. Remove `pressure` from deps and `SLOWED_MS`; add `org` to `runview:` jobs.
- Modify: `worker/boards/service.ts` and `worker/boards/board-views.ts` (`org` on `mine:` and `board:` jobs), `worker/prs/service.ts` (`org` on `prs:`).
- Modify: `worker/main.ts`. Use `createScheduler(realClock, paceOf(pressure))`, and remove the old slow-down import and the `pressure` deps.
- Delete: `worker/pipelines/pressure.ts`, `worker/pipelines/pressure.test.ts`.
- Modify: `docs/reference.md`. Replace the Polling "Slow-down" bullet with one that says:
  - when ADO signals rate-limit pressure for an organisation, all of its polling slows: ×2, ×4 or ×8 depending on how close it is
  - nothing polls until a `Retry-After` has passed
  - it returns to normal 5 minutes after the last signal

  Also delete the "polling pauses and the last data stays on screen" bullet's reference to pausing per job.

**Interfaces:**
- Consumes: `Pace`, `paceOf` (Task 1); `inContext`, `currentContext`, `featureOfJob` (Task 2).
- Produces:
```ts
export interface Job { key: string; org?: string; visibleMs: number; backgroundMs: number | null; quietMax?: number; run(signal: AbortSignal): Promise<void | 'unchanged'> }
export function createScheduler(clock: Clock, pace?: Pace): Scheduler
```
- Interval = (`visible ? visibleMs : backgroundMs`) × `pace.factor(org)` (1 without an org) × quiet factor.
- Quiet factor = `min(2 ** streak, quietMax ?? 1)`, where `streak` counts consecutive `'unchanged'` runs. It resets on a run that resolves anything else, on `setVisible(key, true)` and on `runNow`.
- Due = `max(lastRunAt + interval, pace.resumeAt(org))`.
- `backgroundMs: null` means no timer while not visible.
- Timer runs execute inside `inContext({ feature: featureOfJob(key), priority: 'background' }, …)`. `runNow` keeps the caller's context.
- Remove `pausedUntil`, `rateLimitPauseMs`, `DEFAULT_RATE_LIMIT_PAUSE_MS` and `MAX_RATE_LIMIT_PAUSE_MS`.

- [ ] **Step 1: Write the failing tests** in `scheduler.test.ts`. Use the existing `fakeClock`, `trackedJob` and `T0`.
  - `an org job waits out its org's resumeAt`: pace `resumeAt = T0 + 90_000` → first start at 90 s.
  - `an org job's interval is multiplied by its org's pace factor`: factor 4, `visibleMs: 1000`, visible → starts `[0, 4000, 8000]`.
  - `jobs without an org ignore the pace`.
  - `each unchanged run doubles the interval up to quietMax, and a changed run resets it`: `visibleMs: 1000`, `quietMax: 4`; runs resolve `'unchanged'`, `'unchanged'`, `'unchanged'`, `undefined`, … → starts `[0, 2000, 6000, 10000, 11000]`.
  - `becoming visible and runNow reset the quiet back-off`.
  - `a job with backgroundMs null idles while hidden and runs on becoming visible when due`.
  - `timer runs are background requests for the job's feature, and runNow keeps the caller's context`:
    - Key `mine:contoso`, timer run → `{ feature: 'work', priority: 'background' }`.
    - `runNow` called inside `inContext({ feature: 'work', priority: 'user' })` → `priority: 'user'`.
  - `a rate-limited run no longer pauses its job by itself`: a run throwing `rate_limited` with `retryAfterMs: 60_000` and no pace → next start at the normal 1000 ms.
  - Delete or rewrite the existing rate-limit pause tests to match.

  In `pipelines/service.test.ts`, replace `pressure moves the org to the background cadence for five minutes` with `a delayed org polls its runs at eight times the interval`. Build the scheduler with `createScheduler(clock, paceOf(pressure))`, observe `X-RateLimit-Delay` through `pressure.observe`, and assert the visible runs reads are 240 s apart.

  In `run-views.test.ts`, replace `pressure slows a run view to thirty seconds` with `a delayed org polls an active run view at forty seconds`, asserting reads at a 40 s spacing.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement the scheduler changes.** `assertValidIntervals` accepts `backgroundMs: null`. A timer that fires early re-checks the due time, as `fire()` already does.
- [ ] **Step 4: Remove the old slow-down** from pipelines and run views, add `org` to every ADO job, wire `paceOf(pressure)` in `main.ts`, and delete `pipelines/pressure.ts` and its test.
- [ ] **Step 5: Run the tests and see them pass.**
- [ ] **Step 6: Verify** with the four commands, and `grep -rn "pipelines/pressure\|slowed(" worker` → no matches.
- [ ] **Step 7: Commit.** `git commit -m "Pace every polling job by its org's rate-limit pressure"`

---

### Task 4: Keep hidden boards, idle the Work tab while hidden, serve held views at once

**Goal:** Hidden is not gone.
- A hidden board keeps its view and stops polling.
- Showing it again returns the view at once, and revalidates only past 30 s.
- The Work tab's job idles while hidden.
- Unchanged reloads report `'unchanged'`.

**Files:**
- Modify: `worker/boards/board-views.ts`, `worker/boards/service.ts`, `worker/boards/service.test.ts`
- Modify: `docs/reference.md`. In Polling, say that My work polls only while the Work tab is visible, and that a hidden board keeps its cards and refreshes on return if they are over 30 seconds old.

**Interfaces:**
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
    - when the view is older than `BOARD_MS.visibleMs`, it also starts `runNow(key)` without awaiting it
  - The board job's `run` resolves `'unchanged'` when the new result's JSON equals the old one, which the existing comparison in `reload` already computes.
  - The Work job's `run` resolves `'unchanged'` when the new snapshot equals the previous one apart from `updatedAt`. It still posts `work.changed` so "Updated" stays honest.

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
  - `an unchanged board reload backs off to 60 seconds`: after an unchanged reload the next WIQL comes 60 s later, not 30 s.
  - Update existing tests that expected a hidden board to be dropped.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** the `board-views.ts` and `service.ts` changes above. When adding a view beyond `MAX_HELD_VIEWS`, drop the least recently opened hidden view, through `drop(key)` so `recent.drop` still runs.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Verify** with the four commands.
- [ ] **Step 6: Commit.** `git commit -m "Keep hidden boards and serve them at once"`

---

### Task 5: Entity store; move config, type-state, code-project and wiki caches onto it

**Goal:** One per-org store with typed tables replaces the scattered caches. The tables are filled now so later tasks can use them: `workItems`, `prs`, `prChecks`, `prWorkItems`, `builds`, `timelines` and `runChips`. In this task the store replaces:
- `createBoardConfigCache`
- `ItemSource.stateCache`
- both `cachedCodeProjects` closures
- the wiki `listings` map

Board config loads become single-flight.

**Files:**
- Create: `worker/data/entities.ts`, `worker/data/entities.test.ts`, `worker/data/freshness.ts`, `worker/data/records.ts`
- Modify:
  - `worker/boards/service.ts`: `config()` becomes `tables.boardConfigs.read(boardConfigKey(args), FRESHNESS.boardConfig, () => loadBoardConfig(…))`
  - `worker/boards/snapshot.ts`: `createItemSource(http, org, orgUrl, now, tables)`, with `states` through `tables.typeStates.read`
  - `worker/ado/board-config.ts`: delete `BoardConfigCache`, `createBoardConfigCache` and `DEFAULT_TTL_MS`
  - `worker/ado/board-config.test.ts`: remove the cache tests
- Modify: `worker/ado/code-projects.ts`, which becomes `cachedCodeProjects(http, org, table: Table<NamedItem[]>)`; add `worker/ado/code-projects.test.ts`.
- Modify: `worker/prs/service.ts`, `worker/pipelines/service.ts`, `worker/wiki/service.ts`. Add `entities: Entities` to their deps and use the shared tables. Update their tests' setup to pass `createEntities(clock.now)`.
- Modify: `worker/pipelines/run-views.ts` and `worker/pipelines/run-views.test.ts`. Add `entities: Entities` to `RunViewsDeps` now, so Task 13 needs no `main.ts` change. It stays unused until then.
- Modify: `worker/main.ts`. Create `const entities = createEntities(Date.now)` and pass it to boards, PRs, pipelines, run views and wiki. Add an `entities.forget(org)` call where `onOrgs` sees an org disconnected or removed: in `main.ts`'s `post`, for orgs whose state is `disconnected` or that disappeared.

**Interfaces:**
- Produces:
```ts
// worker/data/records.ts
export type ItemRecord = RawWorkItem & { withRelations: boolean }
export interface PrRecord { projectId: string; repoId: string; prId: number; status: 'active' | 'completed' | 'abandoned'; target: string; sourceCommit: string | null; url: string }
export interface CheckRecord extends PrChecks { commit: string | null }
export function prKey(key: PrKey): string            // `${projectId}/${repoId}/${prId}`

// worker/data/freshness.ts
export const FRESHNESS = { boardConfig: 3_600_000, typeStates: 3_600_000, projects: 3_600_000, wikis: 600_000, prActive: 120_000, checksRunning: 120_000, checksIdle: 1_800_000, prWorkItems: 600_000, prWorkItemsClosed: 3_600_000, boardView: 30_000 } as const
export const MAX_ENTRIES = { workItems: 5000, prs: 2000, prChecks: 2000, prWorkItems: 2000, builds: 500, timelines: 100, runChips: 200, boardConfigs: 20, typeStates: 100, projects: 4, wikis: 1 } as const

// worker/data/entities.ts
export interface Stamped<T> { value: T; at: number }
export interface TableSpec<T> { maxEntries: number; newer?: (incoming: T, stored: T) => boolean }
export interface Table<T> {
  get(key: string): Stamped<T> | undefined
  fresh(key: string, maxAgeMs: number): T | undefined
  put(key: string, value: T, at?: number): boolean
  read(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T>
  drop(key: string): void
  entries(): [string, Stamped<T>][]
  subscribe(listener: (keys: string[]) => void): () => void
}
export interface OrgEntities {
  workItems: Table<ItemRecord>; prs: Table<PrRecord>; prChecks: Table<CheckRecord>; prWorkItems: Table<number[]>
  builds: Table<RawBuild>; timelines: Table<RawTimeline>; runChips: Table<StageChip[] | null>
  boardConfigs: Table<BoardConfig>; typeStates: Table<TypeState[]>; projects: Table<NamedItem[]>; wikis: Table<WikiRef[]>
}
export interface Entities { of(org: string): OrgEntities; forget(org: string): void }
export function createTable<T>(now: () => number, spec: TableSpec<T>): Table<T>
export function createEntities(now: () => number): Entities
```
- Guards: `workItems` keeps the higher `rev`; `timelines` keeps the higher `changeId`.
- `put` returns `false` when the guard kept the stored value.
- `get`, `fresh` and `read` hits count as a use for the LRU.
- `subscribe` listeners get each changed key once per microtask.

- [ ] **Step 1: Write the failing tests** in `worker/data/entities.test.ts`:
  - `fresh returns a value only within its age`.
  - `read loads once for concurrent callers and caches the result`.
  - `read does not cache a failed load, and the next read tries again`.
  - `a guarded put keeps the newer value`: rev 5 then rev 4 → `put` returns `false`; `get` gives rev 5.
  - `tables evict the least recently used entries past maxEntries`.
  - `subscribers hear the keys that changed, batched per microtask`: three puts, one listener call with three keys.
  - `put with an explicit at keeps it, so restored values age honestly`.
  - `forget drops every table of that org and leaves other orgs`.

  In `worker/ado/code-projects.test.ts`:
  - `PRs and pipelines share one code-project read per org`: two `cachedCodeProjects` on the same table → one `GET /_apis/git/repositories`.

  In `worker/boards/service.test.ts`:
  - `two boards opened at once load their shared board config once`: counts `backlogconfiguration` calls = 1.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `records.ts`, `freshness.ts` and `entities.ts`. LRU uses `Map` insertion order, re-inserting on use.
- [ ] **Step 4: Move the four caches** onto the store as described under Files. Delete what they replace.
- [ ] **Step 5: Run the tests and see them pass.**
- [ ] **Step 6: Verify** with the four commands, and `grep -rn "createBoardConfigCache\|stateCache\|listings = new Map" worker` → no matches.
- [ ] **Step 7: Commit.** `git commit -m "Share one entity store per org for configs, states, projects and wikis"`

---

### Task 6: Delta sync of work items

**Goal:** The Work tab and every open board ask ADO what changed, and hydrate only changed ids. A quiet tick is one WIQL request. Spec §5.5.

**Files:**
- Modify: `worker/ado/workitems.ts`, `worker/ado/workitems.test.ts`
- Create: `worker/boards/sync.ts`, `worker/boards/sync.test.ts`
- Modify: `worker/boards/snapshot.ts`, `worker/boards/snapshot.test.ts`
- Modify: `worker/boards/service.ts`, `worker/boards/board-views.ts`, `worker/boards/service.test.ts`
- Modify: `worker/boards/fake-ado.ts`. The WIQL route answers three query kinds, chosen by the posted text:
  - text containing `[System.ChangedDate] >=` → the delta query: `state.delta`
  - text containing `[System.Id] IN` without a change date → the still-in check: `state.wiql` ∩ the listed ids
  - otherwise → the membership query: `state.wiql`

  Every answer carries `asOf: state.asOf`. `workitemsbatch` with `fields: ['System.Id']` answers id and `rev`.
- Modify: `docs/development.md`. Add to Boards, under "Live checks still pending":
  - The delta query with `timePrecision=true` is accepted on the client organisation and returns only items changed since the watermark.
  - Adding a child task and linking a PR each bump the parent's `rev` and `ChangedDate`.
- Modify: `docs/reference.md` Polling. Say that My work and an open board ask only for what changed, and recheck everything every 15 minutes.

**Interfaces:**
- Consumes: `Table<ItemRecord>` and `ItemRecord` (Task 5); `'unchanged'` (Task 3); board views kept (Task 4).
- Produces in `worker/ado/workitems.ts`. Keep `wiqlMine` and `wiqlBoard` as `select(['[System.TeamProject] = @project', clause])`.
```ts
export function mineClause(allDoneStates: string[]): string
export function boardClause(cfg: BoardConfig, everyone: boolean): string
export function deltaWiql(clause: string, since: string, known: readonly number[]): string
export function stillInWiql(clause: string, ids: readonly number[]): string
export interface IdsAt { ids: number[]; asOf: string }
export function queryIdsAt(http: AdoHttp, org: string, projectId: string, teamId: string, wiql: string, timePrecision: boolean): Promise<IdsAt>
export function readRevs(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<Map<number, number>>
export const KEPT_FIELDS: ReadonlySet<string>
export function toRecord(raw: RawWorkItem, withRelations: boolean): ItemRecord
```
- `deltaWiql` produces exactly:

  ```
  SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.ChangedDate] >= <since> AND ((<clause>) OR [System.Id] IN (<known>)) ORDER BY [System.ChangedDate] DESC
  ```

  With no known ids, the `OR …` part is left out.
- `KEPT_FIELDS` holds: `System.Id`, `System.TeamProject`, `System.WorkItemType`, `System.Title`, `System.State`, `System.AssignedTo`, `System.Parent`, `System.ChangedDate`, `System.AreaPath`. `toRecord` also keeps any field matching `/^WEF_[0-9A-Fa-f]+_Kanban\./`, and only relations whose `rel` is `CHILD_LINK` or `ArtifactLink` with a `PR_ARTIFACT_PREFIX` URL.
- Produces in `worker/boards/sync.ts`:
```ts
export const OVERLAP_MS = 10_000
export const AUDIT_EVERY_MS = 15 * 60_000
export const DEEP_AUDIT_EVERY = 4
export const MAX_KNOWN_FOR_DELTA = 1500
export interface SyncState { members: number[]; watermark: string; auditedAt: number; audits: number; precision: 'time' | 'day' }
export interface SyncScope { org: string; projectId: string; teamId: string; clause: string }
export interface SyncResult { state: SyncState; members: number[]; stale: Set<number> }
export function syncView(http: AdoHttp, scope: SyncScope, previous: SyncState | null, known: readonly number[], revOf: (id: number) => number | undefined, now: () => number): Promise<SyncResult>
```
- Algorithm (spec §5.5):
  1. **Audit** when `previous` is null, `now() - auditedAt ≥ AUDIT_EVERY_MS`, or `known.length > MAX_KNOWN_FOR_DELTA`:
     - Run `queryIdsAt(select(project, clause), timePrecision: false)`.
     - `audits = (previous?.audits ?? 0) + 1`.
     - On a deep audit (`audits % DEEP_AUDIT_EVERY === 0`), `stale` = all members.
     - Otherwise, if any of `ids ∪ known` has `revOf` defined, run `readRevs(ids ∪ known)`; `stale` = the ids whose rev differs or is unknown.
     - Otherwise `stale` = `ids`.
     - `watermark = asOf`. `precision` keeps its previous value, or `'time'`.
  2. **Delta**, otherwise:
     - `since = new Date(Date.parse(previous.watermark) - OVERLAP_MS).toISOString()`.
     - With `precision: 'time'`, call `deltaWiql` with `since` wrapped in single quotes as a WIQL date literal, then run `queryIdsAt(…, true)`.
     - On an `AdoError` `bad_request`, set `precision = 'day'` and continue as below.
     - With `precision: 'day'`, run `queryIdsAt(deltaWiql(clause, '@Today - 1', known), false)`, then `readRevs` on the answer. `D` = only the ids whose rev differs or is unknown.
     - `D` empty → `{ members: previous.members, stale: ∅, state: { ...previous, watermark: asOf } }`.
     - Otherwise:
       - `fresh` = `D` − `known`.
       - `recheck` = `D` ∩ `previous.members`. When non-empty, run `queryIdsAt(stillInWiql(clause, recheck), false)` and drop the missing ones from the members.
       - `members` = (members − dropped) ∪ `fresh`.
       - `stale` = `D`.
     - An answer of `WIQL_TOP` ids sets `auditedAt = -Infinity`, so the next sync audits.
- Produces in `worker/boards/snapshot.ts`:
```ts
export interface ItemSource {
  http: AdoHttp; org: string; orgUrl: string
  items(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  fields(projectId: string, ids: number[], stale: ReadonlySet<number>): Promise<RawWorkItem[]>
  revOf(id: number): number | undefined
  chips(refs: PrRef[]): Promise<PrChip[] | null>
  states(projectId: string, type: string): Promise<TypeState[]>
  withSignal(signal?: AbortSignal): ItemSource
}
export interface ViewIds { members: number[]; stale: ReadonlySet<number> }
export function loadMine(source: ItemSource, cfg: BoardConfig, me: Me | null, ids: ViewIds): Promise<Loaded & { families: WorkFamilies; message?: string; known: number[] }>
export function loadBoardItems(source: ItemSource, cfg: BoardConfig, ids: ViewIds): Promise<Loaded & { truncated: boolean; known: number[] }>
```
  - `items` reads, with relations, only ids that are in `stale`, missing from `workItems`, or held with `withRelations: false`. It `put`s `toRecord(raw, true)`.
  - `fields` reads `TASK_FIELDS` only for ids that are stale or missing, and `put`s `toRecord(raw, false)` (the guard keeps a newer record).
  - `known` is members ∪ parents ∪ child ids read for families. `truncated` is `members.length >= WIQL_TOP`.
  - `loadItem` (after a write) and `details` still hydrate directly, then `put` the record.
- Service wiring:
  - The Work entry and each `BoardView` hold `sync: SyncState | null` and `known: number[]`.
  - A tick runs `syncView` with the scope from `mineClause` or `boardClause`, then projects with `ViewIds`.
  - `refresh(org)` sets `sync.auditedAt = -Infinity` before running the job.
  - `publish()` also `put`s `toRecord(raw, true)`.

- [ ] **Step 1: Write the failing tests.**

  `worker/ado/workitems.test.ts`:
  - `deltaWiql puts the change-date clause first and lists the known ids`: exact string for clause `[System.AssignedTo] = @Me`, since `'2026-11-11T09:59:50.000Z'` (quoted), and the same with `@Today - 1`, known `[7, 9]`.
  - `queryIdsAt sends timePrecision only when asked and returns asOf`.
  - `toRecord keeps only the fields the views read and the child and PR links`.

  `worker/boards/sync.test.ts`. Use a scripted `AdoHttp` that records requests and answers in order.
  - `the first sync audits with one query and no revision read when the store is empty`: 1 request; `members [1,2,3]`; `stale {1,2,3}`; `watermark === asOf`.
  - `an audit reads revisions and marks only changed or unknown items stale`: `revOf` gives 1→5 and 2→3; `readRevs` answers 1→5, 2→4, 3→1 → `stale {2,3}`.
  - `a quiet delta costs one request and advances the watermark`: the request query has `timePrecision: true`, the body contains `'2026-11-11T09:59:50.000Z'`, `stale` is empty and `state.watermark` is the new `asOf`.
  - `a new id in the delta joins the view without another query`.
  - `a member that changed is re-checked and leaves the view when it no longer matches`: delta `[2, 9]`, still-in answers `[]` → members `[1,3,9]`, `stale {2,9}`, 2 requests.
  - `a changed child that is not a member is only marked stale`: no still-in query.
  - `a 400 on the time-precision query switches the view to day precision with a revision check`.
  - `an answer at $top makes the next sync an audit`.
  - `audits come every 15 minutes, and every fourth audit marks every member stale`.
  - `more than 1,500 known ids skips the delta and audits`.
  - `the next delta starts at the server's asOf, not the local clock`: local `now()` is 2 hours ahead; the delta still uses `asOf − 10 s`.

  `worker/boards/snapshot.test.ts`:
  - `items hydrates only stale, missing or relation-less records and serves the rest from the store`: store holds 1 (rel, rev 3) and 2 (no rel); `items([1,2,3], ∅)` → one `workitemsbatch` for `[2,3]` with `$expand: 'relations'`.
  - `a hydrate that returns an older rev never replaces a newer record`.
  - `loadMine with nothing stale makes no work-item request`.
  - Update the existing `loadMine` and `loadBoardItems` tests to pass `ViewIds`.

  `worker/boards/service.test.ts`:
  - `a quiet Work tick sends only the delta query`: after the first load, the next tick makes exactly 1 ADO call.
  - `a card moved by someone else appears after one delta and one hydrate`: set `state.delta = [1204]` and change its fields → 2 calls, then `work.changed` has the new column.
  - `the user's move survives a delta that returns the older rev`: move 1204 (rev 2→3); the next delta reads rev 2 → the posted item keeps the moved column.
  - `Refresh forces an audit`.
  - `a quiet board tick reports unchanged and backs off`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** the `workitems.ts` builders and readers.
- [ ] **Step 4: Implement `syncView`.**
- [ ] **Step 5: Make `ItemSource` store-backed**, and make `loadMine` and `loadBoardItems` take `ViewIds`.
- [ ] **Step 6: Wire sync state** into the Work entry and the board views, and extend `fake-ado.ts`.
- [ ] **Step 7: Run the tests and see them pass.**
- [ ] **Step 8: Update the two docs.**
- [ ] **Step 9: Verify** with the four commands.
- [ ] **Step 10: Commit.** `git commit -m "Sync work items by delta instead of re-reading every tick"`

---

### Task 7: PR records and checks in the store; chips reuse them

**Goal:**
- Merged and abandoned chips are final.
- Open chips refresh with one active-PR list per project.
- Policy evaluations are re-read only when due.
- The PRs tab and chips share one copy, and a change from either updates chips with no request.

Spec §5.6.

**Files:**
- Modify: `worker/ado/pullrequests.ts` and `worker/ado/pullrequests.test.ts`. Add `lastMergeSourceCommit?: { commitId?: string }` to `RawPullRequest`, and `toPrRecord`.
- Modify: `worker/ado/policy.ts` (`checksDue`, `readChecks`) and `worker/ado/policy.test.ts`.
- Modify: `worker/ado/pr-links.ts` and `worker/ado/pr-links.test.ts`. Rewrite `loadPrChips` and delete `PrChipCache`.
- Modify: `worker/prs/load.ts` and `worker/prs/load.test.ts`:
  - `createPrSource(http, org, now, tables)`
  - `list()` puts records
  - `checksOf` and `workItemsOf` use `prChecks` and `prWorkItems`
  - delete the `checks` and `workItems` `remember` caches, but keep the `completed` list cache for Task 10
- Modify: `worker/prs/service.ts` (pass tables).
- Modify: `worker/boards/snapshot.ts` (chips via the tables; `rechip`), `worker/boards/service.ts` (subscribe per org), `worker/boards/service.test.ts`.
- Modify: `docs/reference.md`. Rewrite the "PR chip status" bullet: merged or abandoned is final; open status is checked with one list per project every 2 minutes; build status re-reads while a build runs, after a push, or every 30 minutes.

**Interfaces:**
- Consumes: `PrRecord`, `CheckRecord`, `prKey`, `Table`, `OrgEntities`, `FRESHNESS` (Task 5); store-backed `ItemSource` (Task 6).
- Produces:
```ts
// worker/ado/pullrequests.ts
export function toPrRecord(raw: RawPullRequest, org: string): PrRecord
// worker/ado/policy.ts
export const MAX_CHECK_READS = 8
export function checksDue(pr: PrRecord, checks: Stamped<CheckRecord> | undefined, now: number): boolean
export function readChecks(http: AdoHttp, org: string, pr: PrRecord): Promise<CheckRecord>
// worker/ado/pr-links.ts
export const SWEEP_TOP = 500
export function chipOf(record: PrRecord, checks: CheckRecord | undefined): PrChip
export function loadPrChips(http: AdoHttp, org: string, refs: PrRef[], tables: Pick<OrgEntities, 'prs' | 'prChecks'>, now: () => number): Promise<PrChip[]>
// worker/boards/snapshot.ts
export function rechip(items: WorkItemSummary[], tables: Pick<OrgEntities, 'workItems' | 'prs' | 'prChecks'>): WorkItemSummary[]
```
- `checksDue` is true when the PR is `active` and any of these holds:
  - there are no checks yet
  - `checks.value.commit !== pr.sourceCommit`
  - `checks.value.build === 'running'` and age ≥ `FRESHNESS.checksRunning`
  - age ≥ `FRESHNESS.checksIdle`
- `loadPrChips`:
  1. Terminal records answer at once.
  2. Active or unknown records older than `FRESHNESS.prActive` are grouped by `projectId`. Each group gets one `listPullRequests(http, org, projectId, { status: 'active', top: SWEEP_TOP })`, and every listed PR is `put`.
  3. A ref still unlisted after a list shorter than `SWEEP_TOP` is read once with the existing `fetchPullRequest`. So is any unlisted ref when the list was full.
  4. Due checks are read: oldest first, at most `MAX_CHECK_READS`.
  5. A 404 PR yields no chip, as today.
- `rechip` recomputes each item's `prs` from its record's PR refs (`toSummary(...).prRefs`) and the tables, through `foldChips`.
- The boards service subscribes to `tables.prs` and `tables.prChecks` per org. On change, it applies `rechip` to the Work snapshot and to each held board that references a changed key, then caps and posts when the JSON changed.

- [ ] **Step 1: Write the failing tests.**

  `pr-links.test.ts`:
  - `a merged or abandoned PR in the store is never fetched again`: 0 calls.
  - `stale active refs refresh with one active-list read per project`: 3 refs in project A and 2 in B → 2 calls, each with `searchCriteria.status=active` and `$top=500`.
  - `a ref missing from a short active list is read once by id and becomes final`.
  - `a full active list does not prove a missing ref closed, so it is read by id`.
  - `no more than 8 evaluation reads per load, oldest first`.

  `policy.test.ts`:
  - `checks are due when missing, after a push, while running for 2 minutes, or at 30 minutes`: table-driven, including not due for a completed PR.

  `prs/load.test.ts`:
  - `listed PRs and their checks land in the shared store`.
  - `checks read for a chip are reused by the PRs tab while fresh`: 0 evaluation calls.

  `boards/service.test.ts`:
  - `new checks from the PRs tab update board and Work chips without a request`: `put` into `prChecks` → after `drain()`, `work.changed` and `work.boardChanged` were posted and the ADO call count is unchanged.
  - `an hour later merged PR chips are not read again`: advance 61 min → 0 `GET …/pullrequests/{id}` for merged PRs.
  - Keep `a 403 turns chips off for 10 minutes` green.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `toPrRecord`, `checksDue`, `readChecks`, `chipOf` and `loadPrChips`.
- [ ] **Step 4: Point the PR source and the item source at the tables**, and delete `PrChipCache` and the two `remember` caches named above.
- [ ] **Step 5: Add `rechip` and the subscription** in the boards service. Re-project once per microtask batch.
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Verify** with the four commands, and `grep -rn "chipCache\|PrChipCache" worker` → no matches.
- [ ] **Step 8: Commit.** `git commit -m "Share PR status and checks between chips and the PRs tab"`

---

### Task 8: Persist last-known views: the module, the Work tab, boards, meta and PR records

**Goal:** Start-up paints the Work tab and boards at once from saved data, marked stale and showing its age, then revalidates. Saved configs, type states, code projects and PR records make the first revalidation cheap. Spec §5.7.

**Files:**
- Create: `worker/data/persist.ts`, `worker/data/persist.test.ts`
- Modify: `worker/test-support.ts`. Add `memoryCache(initial?)`, returning `{ data, port: CachePort }` with `delete` and `keys`.
- Modify: `worker/boards/snapshot.ts`. Add a `budget = POST_BUDGET_BYTES` parameter to `capSnapshot` and `budget = ANSWER_BUDGET_BYTES` to `capBoard`.
- Modify: `worker/boards/service.ts`, `worker/boards/board-views.ts`, `worker/boards/service.test.ts`
- Modify: `worker/messages.ts` (`SHOWING_SAVED`).
- Modify `worker/main.ts`:
  - Create `persisted` with the port `{ get: k => orca.storage.get(k), set: (k, v) => orca.storage.set(k, v as JsonValue), delete: k => orca.storage.delete(k), keys: () => orca.storage.keys() }` and call `void persisted.sweep()`.
  - In `post`, call `void persisted.retain(orgs)`.
  - Add `await persisted.flush()` to `deactivate` before `stopAllCommands`.
- Modify: `docs/reference.md`. Add a "Saved data" section saying:
  - What is kept, and where: the Work tab, up to 3 boards per organisation, PRs, runs, board settings and PR status, in Orca's plugin storage, at most 1.5 MiB.
  - That it shows as "Showing what was saved last time. Refreshing…" until refreshed.
  - That it is deleted on sign-out and on removing the organisation.

**Interfaces:**
- Consumes: `capSnapshot`, `capBoard` and the store tables (Tasks 5–7).
- Produces:
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
  retain(orgs: OrgStatus[]): Promise<void>
  sweep(): Promise<void>
  flush(): Promise<void>
}
export interface PersistedDeps { port: CachePort; now: () => number; clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>; log: (message: string) => void }
export function cacheKey(org: string, name: string): string
export function createPersisted(deps: PersistedDeps): Persisted
// worker/messages.ts
export const SHOWING_SAVED = 'Showing what was saved last time. Refreshing…'
```
- `cacheKey(org, name)` is `` `adoCache:v1:${org}:${name}` ``.
- Names: `work`, `board:<teamId>:<boardId>`, `meta`, `pr-records`. Task 9 adds `prs` and `runs`.
- `adoCache:v1:index` maps key → `{ bytes, usedAt }`.
- `save`:
  - debounced per key to one write per `WRITE_EVERY_MS`, skipped when the JSON is unchanged
  - a value over `VALUE_BUDGET_BYTES` is skipped and logged
  - before writing, evicts least-recently-used keys until the total fits `TOTAL_BUDGET_BYTES`, and keeps only the `MAX_SAVED_BOARDS` most recently used `board:` names per org
- `load` returns `null` for a missing value, a different `account`, or a wrong shape.
- `retain` forgets orgs that are absent or `disconnected`, and keeps `expired` ones.
- `sweep` deletes `adoCache:` keys not starting with `adoCache:v1:`.

**Boards service**
- `work.snapshot` with no in-memory snapshot:
  - `load(org, 'work', status.account.adoId)` is used only if it is connected and its `board.projectId` and `board.teamId` match `status.boards`
  - its value is set as the entry snapshot with `stale: true` and `message: SHOWING_SAVED`, keeping its `updatedAt`
  - `scheduler.runNow(mineKey(org))` starts without awaiting
- `BoardViews.open` with no held view uses `board:<teamId>:<boardId>` the same way, only when `everyone` matches the filter Task 15 resolved, then starts `runNow`.
- After each successful live projection: `save('work' | 'board:…', capSnapshot(view, VALUE_BUDGET_BYTES) | capBoard(view, truncated, VALUE_BUDGET_BYTES))`.
- `meta` is `{ configs: [key, BoardConfig, at][], states: [key, TypeState[], at][], projects: [key, NamedItem[], at][] }`. `pr-records` is `{ prs: [key, PrRecord, at][], checks: [key, CheckRecord, at][] }`, newest 600 by `at`.
  - Both are saved after a tick that changed those tables.
  - Both are restored with `put(key, value, at)` on the first request for an org.

- [ ] **Step 1: Write the failing tests.**

  `worker/data/persist.test.ts`. Use `memoryCache` and `fakeClock`.
  - `a saved view comes back for the same account and not for another`.
  - `writes are debounced to one per key per minute and skipped when unchanged`.
  - `a value over 160 KiB is not written and is logged`.
  - `saving past 1.5 MiB evicts the least recently used entries first`.
  - `at most 3 boards are kept per org`.
  - `sweep deletes keys from other cache versions and leaves other plugin data alone`: keys `orgs`, `adoCache:v0:contoso:work` and `adoCache:v1:contoso:work` → only the `v0` key is deleted.
  - `forget deletes every key of that org, and retain forgets removed or signed-out orgs but keeps expired ones`.
  - `flush writes pending values at once`.
  - `a wrongly shaped saved value is ignored`.

  `worker/boards/service.test.ts`:
  - `the Work tab paints a saved snapshot at once, marked stale with its age, then replaces it with a live one`: the first `snapshot()` answers with no ADO call, `stale: true`, `message: SHOWING_SAVED` and the saved `updatedAt`; then a `work.changed` with `stale: false`.
  - `a saved Work snapshot from another account or another boards target is ignored`.
  - `a saved snapshot is not served while the org is expired`: `snapshot()` rejects with the not-connected error.
  - `the board paints a saved view at once when no view is held`.
  - `saved board configs, type states and PR records seed the store with their original age`: the first tick after restore makes no config, type-state or merged-PR request.
  - `a cold start of a board with 400 linked PRs costs under 15 requests when PR records were saved`: fake with 30 open and 370 merged linked PRs.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement `persist.ts`.** The timer comes through `deps.clock`.
- [ ] **Step 4: Wire restore and save** into the boards service and board views, and add the budget parameters to `capSnapshot` and `capBoard`.
- [ ] **Step 5: Wire `main.ts`.**
- [ ] **Step 6: Run the tests and see them pass.**
- [ ] **Step 7: Update `docs/reference.md`.**
- [ ] **Step 8: Verify** with the four commands.
- [ ] **Step 9: Commit.** `git commit -m "Paint the Work tab and boards from saved data at start-up"`

---

### Task 9: Persist the PRs and Pipelines views

**Goal:** The PRs and Pipelines tabs paint at once from saved data and revalidate. Restored finished runs keep their stage chips without a timeline read.

**Files:**
- Modify: `worker/prs/service.ts`, `worker/prs/service.test.ts`. Add `persisted: Persisted` to deps; `capPrSnapshot(snapshot, budget = POST_BUDGET_BYTES)`.
- Modify: `worker/pipelines/service.ts`, `worker/pipelines/service.test.ts`. Add `persisted: Persisted` to deps; `capRunsSnapshot(snapshot, budget = POST_BUDGET_BYTES)`.
- Modify: `worker/pipelines/load.ts`. `RunSource.seed(runs: RunSummary[])` puts each finished run's `stages` into `runChips` under `buildId:finishedAt`. This task replaces `finishedChips` with `tables.runChips`.
- Modify: `worker/main.ts` (pass `persisted` to PRs and pipelines).
- Modify: `docs/reference.md` (extend Saved data).

**Interfaces:**
- Consumes: `Persisted`, `SHOWING_SAVED` (Task 8); `runChips` (Task 5).
- Produces:
  - Name `prs`: the last full `PrSnapshot`, capped to `VALUE_BUDGET_BYTES`. Name `runs`: the last full `RunsSnapshot`, capped the same way. Both are saved after each successful full load.
  - Restore runs in `snapshot(org)` when no entry has a snapshot. It publishes the saved value with `stale: true` and `message: SHOWING_SAVED`, then calls `void loadInFull(org)`. Pipelines also calls `source.seed(saved.runs)`.
  - A restored PR snapshot is never passed to `notifier.observe`, and does not set `baselined`.

- [ ] **Step 1: Write the failing tests.**
  - `the PRs tab paints saved PRs at once, stale, then live`.
  - `restored PRs never raise review or comment notifications`.
  - `saved PRs from another account are ignored`.
  - `the Pipelines tab paints saved runs at once, stale, then live`.
  - `finished runs restored from storage keep their stage chips without a timeline read`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** restore and save in both services, `seed`, and the move of `finishedChips` to `runChips`.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/reference.md`.**
- [ ] **Step 6: Verify** with the four commands, and `grep -rn "finishedChips" worker` → no matches.
- [ ] **Step 7: Commit.** `git commit -m "Paint the PRs and Pipelines tabs from saved data at start-up"`

---

### Task 10: Hot and cold projects for PRs and pipelines

**Goal:**
- Projects where the user has had nothing for 24 hours are listed at most every 5 minutes while visible and every 15 in the background. Their last results are reused between reads.
- Refresh reads every project.
- This is decision 2 in the spec, accepted by the user on 2026-11-11.

**Files:**
- Create: `worker/data/heat.ts`, `worker/data/heat.test.ts`
- Modify: `worker/prs/load.ts`, `worker/prs/service.ts`, `worker/prs/load.test.ts`, `worker/prs/service.test.ts`
- Modify: `worker/pipelines/load.ts`, `worker/pipelines/service.ts`, `worker/pipelines/load.test.ts`, `worker/pipelines/service.test.ts`
- Modify: `docs/reference.md` (PRs tab and Pipelines tab bullets).

**Interfaces:**
- Consumes: `NamedItem[]` from `cachedCodeProjects` (Task 5).
- Produces:
```ts
export const HOT_FOR_MS = 24 * 60 * 60_000
export const COLD_EVERY_MS = { visible: 5 * 60_000, background: 15 * 60_000 }
export type HeatMode = 'visible' | 'background' | 'all'
export interface Heat { pick(projects: NamedItem[], mode: HeatMode): NamedItem[]; saw(projectId: string, found: boolean): void }
export function createHeat(now: () => number): Heat
```
- `pick` returns:
  - projects never read
  - hot projects (`found` true within `HOT_FOR_MS`)
  - cold projects whose last read is at least `COLD_EVERY_MS[mode]` old
  
  `'all'` returns every project.
- **PR source.**
  - `full(me, projects, signal, mode)`, `reviews(...)` and `active(...)` read only the picked projects.
  - Results are kept per project (`{ mine, completed, completedAt, review }`). The composed load covers every project from the latest kept results.
  - The completed list per project is re-read at most every 5 minutes. This replaces its `remember` cache.
  - `found` = any of mine, completed or review is non-empty.
- **Run source.** Lists are kept per project the same way. `found` = any of my runs, running runs or pending approvals is non-empty.
- **Mode.** The job tick uses `'visible'` when the tab is visible, otherwise `'background'`. `refresh` and `reloadFresh` use `'all'`.

- [ ] **Step 1: Write the failing tests.**

  `heat.test.ts`:
  - `a project never read is picked at once`.
  - `a hot project is picked every tick; a cold one at most every 5 minutes while visible and 15 in the background`.
  - `a project that found something stays hot for 24 hours`.
  - `'all' picks every project`.

  PRs:
  - `a visible PR tick lists only hot projects and keeps the cold projects' last results`.
  - `Refresh lists every project`.
  - `a review request in a cold project appears within 5 minutes`.
  - `the completed list of a project is read at most every 5 minutes`.

  Pipelines:
  - `a visible runs tick lists only hot projects and keeps the cold projects' last runs`.
  - `Refresh lists every project`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `heat.ts` and the per-project results in both sources.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/reference.md`.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "List quiet projects less often in the PRs and Pipelines tabs"`

---

### Task 11: PRs cadence: quiet back-off, thread back-off, stale-while-revalidate

**Goal:**
- An unchanged PR poll backs off to 120 s.
- Opening the tab shows the last load at once and revalidates it.
- Comment threads are re-read per PR, from 2 to 10 minutes. This is decision 3, accepted by the user on 2026-11-11.
- Hidden observes no longer list every project.

**Files:**
- Create: `worker/prs/thread-cadence.ts`, `worker/prs/thread-cadence.test.ts`
- Modify: `worker/prs/service.ts`, `worker/prs/load.ts`, `worker/prs/service.test.ts`
- Modify: `docs/reference.md`. Update the PRs tab bullet ("Opening the tab shows the last data at once and refreshes it if it is over a minute old") and the Comment notifications bullet.

**Interfaces:**
- Consumes: `Heat` (Task 10); the `'unchanged'` job result (Task 3).
- Produces:
```ts
export const THREADS_FIRST_MS = 2 * 60_000
export const THREADS_MAX_MS = 10 * 60_000
export interface ThreadCadence { due(prs: PrSummary[]): PrSummary[]; read(pr: PrKey, signature: string): void; forget(): void }
export function createThreadCadence(now: () => number): ThreadCadence
export function threadSignature(threads: readonly RawThread[]): string
```
- `threadSignature` = thread count, plus the maximum of every comment's `lastUpdatedDate` and `publishedDate`.
- A PR is due when it was never read, or `now - lastRead ≥ interval`.
- `read` doubles the interval up to `THREADS_MAX_MS` when the signature is unchanged, and resets it to `THREADS_FIRST_MS` when it changed.
- The `prs:` job is `{ org, visibleMs: 60_000, backgroundMs: 300_000, quietMax: 2 }`. `poll` resolves `'unchanged'` when the composed snapshot equals the previous one apart from `updatedAt`.
- `snapshot(org)` returns the last full snapshot at once whenever one exists. When it is older than the service's own `FRESH_MS` (60 s), it also starts `void loadInFull(org)`.
- `observe` reads threads only for `cadence.due(watchedPrs(mine))`, where `mine` is the last full load's list when it is under 10 minutes old, otherwise `source.active(me, heat.pick(projects, 'background'))`.

- [ ] **Step 1: Write the failing tests.**

  `thread-cadence.test.ts`:
  - `a PR whose threads didn't change is re-read after 2, then 4, 8 and 10 minutes`.
  - `a changed signature resets that PR to 2 minutes`.
  - `a PR never read is due at once`.

  `prs/service.test.ts`:
  - `an unchanged PR poll backs off to 120 seconds`.
  - `opening the PRs tab shows the last load at once, even when older than a minute, and refreshes it`.
  - `a new comment on a quiet PR notifies once within 10 minutes`.
  - `a hidden observe lists active PRs only in hot projects`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `thread-cadence.ts`, then the service changes.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/reference.md`.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "Back off PR polling and comment reads when nothing changes"`

---

### Task 12: Pipelines cadence: quiet back-off, shared timelines, watch dedupe

**Goal:**
- With nothing moving, the runs job backs off up to ×4.
- Stage chips read timelines with the stored `changeId`, skip a timeline a run view refreshed in the last 5 s, and never re-read a finished one.
- The watch job skips runs the list just read, and polls every 60 s while hidden.
- Opening the tab shows the last load at once.

**Files:**
- Modify: `worker/pipelines/load.ts`, `worker/pipelines/service.ts`, `worker/pipelines/load.test.ts`, `worker/pipelines/service.test.ts`
- Modify: `docs/reference.md` (Pipelines tab and Watched runs bullets).

**Interfaces:**
- Consumes: `timelines`, `builds` and `runChips` (Task 5); `mergeTimeline`, `getTimeline(…, changeId)` (existing).
- Produces:
  - `RUNS_MS = { visibleMs: 30_000, backgroundMs: 300_000 }` with `quietMax: 4`. `poll` resolves `'unchanged'` when the composed runs equal the previous ones apart from `updatedAt`.
  - `WATCH_MS = { visibleMs: 30_000, backgroundMs: 60_000 }`, plus `WATCH_SKIP_MS = 30_000`.
  - Timeline reads:
    - with `stored = tables.timelines.get(String(buildId))`, a stored timeline under 5 s old is used as is
    - otherwise read `getTimeline(http, org, projectId, buildId, stored?.value.changeId)`, merge with `mergeTimeline(stored?.value ?? null, answer)`, and `put` the result
  - Every listed build is `put` into `tables.builds`.
  - `watched()` skips keys whose `builds` entry is under `WATCH_SKIP_MS` old.
  - `snapshot(org)` returns the last full snapshot at once and starts `void loadInFull(org)` when it is older than the service's own `FRESH_MS` (30 s).

- [ ] **Step 1: Write the failing tests.**
  - `a runs tick with nothing moving backs off to two minutes`.
  - `the runs list reads an active run's timeline with the stored changeId and merges it`: the second read's query has `changeId` equal to the first answer's.
  - `the runs list skips a timeline a run view read in the last 5 seconds`.
  - `a finished run's timeline is never read again`.
  - `the watch job skips runs the runs list read in the last 30 seconds`.
  - `the watch job polls every 60 seconds while hidden`.
  - `opening the Pipelines tab shows the last load at once and refreshes it when older than 30 seconds`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/reference.md`.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "Share run timelines and back off pipeline polling when nothing moves"`

---

### Task 13: Run view cadence

**Goal:**
- A running build's tab reads its timeline every 5 s, its logs every 2nd tick and the build every 4th, and backs off to 10 and then 20 s while nothing changes.
- A queued run, or one waiting on an approval, polls every 30 s.
- Timelines go into the shared table.

**Files:**
- Modify: `worker/pipelines/run-views.ts`, `worker/pipelines/run-views.test.ts`
- Modify: `docs/reference.md` (the open run tab bullet).

**Interfaces:**
- Consumes: `timelines` (Task 5); `quietMax`, `'unchanged'` (Task 3).
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
  - Each merged timeline is `put` into `tables.timelines`.
  - `poll` resolves `'unchanged'` when `comparable(view)` didn't change.

- [ ] **Step 1: Write the failing tests.**
  - `a running build reads its timeline every tick, its logs every second tick and the build every fourth`: request counts over 8 ticks are 8 timeline, 4 logs and 2 builds.
  - `the build is read at once when the timeline shows every record completed`.
  - `a run waiting on an approval polls every 30 seconds`.
  - `a run whose timeline stopped changing backs off to 10 and 20 seconds, and a change brings it back to 5`.
  - `the run view's timeline is shared with the runs list`: after a run-view read, `tables.timelines.get(id)` holds it.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/reference.md`.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "Poll a run tab only as fast as the run moves"`

---

### Task 14: Request metrics in the Connection status command

**Goal:** `Azure DevOps: Connection status` shows, for each connected org:
- the requests of the last 5 minutes, by feature
- the busiest endpoints
- 429s and delays
- the summed `X-RateLimit-Cost`
- the rate-limit state

The effect of this plan, and any regression, can then be read off in numbers. Spec §5.9.

**Files:**
- Create: `worker/data/metrics.ts`, `worker/data/metrics.test.ts`
- Modify: `worker/status-bar.ts` and `worker/status-bar.test.ts`. `statusText(orgs, counts?, notes?, details?: (org: string) => string[])` puts each connected org's detail lines under its line.
- Modify: `worker/main.ts`:
  - `observe` fans out to `pressure.observe` and `metrics.observe`
  - the `status` command passes `org => metricsLines(metrics.report(org), pressure.state(org), Date.now())`
- Modify: `docs/reference.md` (Status bar section: what the command shows) and `docs/development.md`. Add a live check: "On the client organisation, read **Connection status** after 10 minutes with the Work tab and a board open, and record the totals and the `X-RateLimit-*` line."

**Interfaces:**
- Consumes: `ResponseObserver` (Task 1); `currentContext`, `Feature` (Task 2); `PressureState`, `readRateLimit` (Task 1).
- Produces:
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
- `endpointOf` = `` `${method} ${host ? host + ' ' : ''}${path}` ``, with:
  - path segments that are all digits, or GUIDs, replaced by `{id}`
  - a first segment before `/_apis` replaced by `{team}`

  For example, `POST /6a7b…/_apis/wit/wiql` → `POST /{team}/_apis/wit/wiql`, and `GET /_apis/git/pullrequests/322` → `GET /_apis/git/pullrequests/{id}`.
- Five 1-minute buckets per org, keyed by `Math.floor(now / 60_000)`.
- `perMinute` is oldest first. `byEndpoint` is sorted descending, with the top 3 shown.
- `metricsLines` output, exactly:
  ```
    Requests, last 5 min: 41 (board 18, work 9, prs 8, pipelines 6)
    Busiest: POST /{team}/_apis/wit/wiql 14 · GET /_apis/git/pullrequests 7 · POST /_apis/wit/workitemsbatch 5
    Rate limit: near, 152 of 200 TSTU left, polling ×2 (headers 40 s ago)
  ```
  - The third line reads `Rate limit: no pressure seen` when `last` is null.
  - A fourth line, `Throttled 2, delayed 3, cost 1.25 TSTU`, appears only when any of those is non-zero.

- [ ] **Step 1: Write the failing tests.**

  `metrics.test.ts`:
  - `requests are counted per minute for five minutes, by feature and endpoint`: observes inside `inContext({ feature: 'board', priority: 'background' })` and `'work'`.
  - `endpoints replace ids, GUIDs and team segments with placeholders`.
  - `429s, delayed answers, the cost sum and ETag endpoints are tracked`.
  - `counts older than five minutes drop out`.
  - `metricsLines shows totals, the busiest endpoints and the rate-limit state`: the exact lines above.

  `status-bar.test.ts`:
  - `statusText adds each connected org's detail lines under it`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `metrics.ts`, then `statusText`'s `details`, then the `main.ts` wiring.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update the two docs.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "Show request counts and rate-limit state in Connection status"`

---

### Task 15: Remember each board's filter

**Goal:** A board opens on the Me / Everyone choice last used for it, or *Everyone* the first time. This is decision 4, settled by the user on 2026-11-11 (spec §5.10). It runs right after Task 4.

**Files:**
- Create: `worker/boards/board-filters.ts`, `worker/boards/board-filters.test.ts`
- Modify: `src/protocol.ts`. `work.board`'s input becomes `everyone?: boolean`, and its output gains `everyone: boolean`.
- Modify: `worker/boards/service.ts` (`board()`) and `worker/boards/service.test.ts`. The service builds its `BoardFilters` from its existing `deps.store`, so `main.ts` doesn't change.
- Modify: `src/board/board.ts`. The state's `everyone` becomes `boolean | null`. `openRef` sets it to `null`, `load()` sends `everyone` only when it isn't `null`, and every answer sets it from `result.everyone`.
- Modify: `src/board/render.ts`. The toolbar's `update` takes `everyone: boolean | null`, and `null` sets `aria-pressed="false"` on both buttons. Add a test in `src/board/render.test.ts`.
- Modify: `docs/work.md`. The **Me** and **Everyone** line gains: "Each board remembers your choice."

**Interfaces:**
- Consumes: `StorePort` (existing); held board views (Task 4).
- Produces:
```ts
export const MAX_REMEMBERED_BOARDS = 50
export interface BoardFilters {
  everyone(org: string, teamId: string, boardId: string): Promise<boolean>
  remember(org: string, teamId: string, boardId: string, everyone: boolean): Promise<void>
}
export function createBoardFilters(store: StorePort): BoardFilters
// worker/boards/service.ts
board(input: BoardArgs & { everyone?: boolean }): Promise<BoardResult & { everyone: boolean }>
```
- **Storage.** The key is `boardFilters:<org>`. Its value is `Record<string, boolean>` keyed `<teamId>/<boardId>`, in order of last change.
  - `remember` deletes and re-adds the entry, drops the first entries beyond `MAX_REMEMBERED_BOARDS`, and writes only when the value changed.
  - A malformed stored value reads as empty.
- **`board()`** resolves `config(args)` first, so `boardId` is known. Then:
  - `filter = input.everyone ?? await filters.everyone(org, teamId, boardId)`
  - when `input.everyone` was given, it calls `remember`
  - it returns `{ ...(await boardViews.open(org, args, boardId, filter)), everyone: filter }`

  Task 8's saved-board restore compares against this resolved `filter`.

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

  `src/board/render.test.ts`:
  - `the toolbar presses neither filter until the board's filter is known`.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement** `board-filters.ts`, the protocol change, `board()`, then the editor and toolbar changes.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: Update `docs/work.md`.**
- [ ] **Step 6: Verify** with the four commands.
- [ ] **Step 7: Commit.** `git commit -m "Remember each board's Me or Everyone filter"`

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| §5.1 Request context | 2, 3 |
| §5.2 Pressure, governor | 1, 2 |
| §5.3 Scheduler pacing | 3 |
| §5.4 Entity store | 5, plus 7, 9, 12 and 13 for the PR, run-chip and timeline tables |
| §5.5 Delta sync | 6 |
| §5.6 PR chips from the store | 7 |
| §5.7 Persistence | 8, 9 |
| §5.8 Visibility and cadence | 4, 10, 11, 12, 13 |
| §5.9 Metrics | 14 |
| §5.10 Board filter memory | 15 |
| §3.9 Live checks | 6, 14 (`docs/development.md`) |
| Decision 1: `orca.storage` (settled 2026-11-11) | 8 |
| Decisions 2 and 3: cold projects every 5 min; comment back-off 2–10 min (settled 2026-11-11) | 10, 11 |
| Decision 4: remember each board's filter (settled 2026-11-11) | 15 |
