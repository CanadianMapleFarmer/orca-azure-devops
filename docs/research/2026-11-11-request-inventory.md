# Azure DevOps request inventory

Date: 2026-11-11 · Code: `39cd1c4` · Method: code reading only, nothing was run. · Used by: [`docs/superpowers/specs/2026-11-11-data-layer-design.md`](../superpowers/specs/2026-11-11-data-layer-design.md)

## Summary

The plugin has no request budget of its own. Each feature polls on its own timer, keeps its own in-memory caches, and re-downloads whole result sets every tick. Nothing is persisted, so every worker start begins cold.

The biggest costs, in order:

1. **PR chips on the team board.** One `GET pullrequests/{id}` per linked PR, plus policy evaluations for open ones. The cache is 2 minutes for open PRs and 60 minutes for merged ones. All merged chips are cached at the same moment, so they also expire together, as a burst of one request per merged PR every hour. A cold board with 400 linked PRs costs about 440 requests.
2. **Per-project fan-out in Pipelines and PRs.** 3 requests per code project per tick: every 30 s for pipelines and every 60 s for PRs while visible.
3. **Full re-hydration of work items.** Every tick sends the WIQL, then every item with `$expand=relations` (all fields, long HTML included), then missing parents, then child tasks. This happens even when nothing changed.
4. **The live run view.** 3 to 4 requests every 5 s, including while a run waits hours for an approval.
5. **Hiding a board throws its data away.** Showing it again refetches everything.

Throttling is only partly handled. `pipelines/pressure.ts` watches `Retry-After` and `X-RateLimit-Delay` on successful answers, but only pipeline jobs slow down. A 429 pauses only the job that hit it. `X-RateLimit-Remaining` and `X-RateLimit-Limit` are never read.

**Estimate for a typical session** (assumptions below): **about 480 to 760 requests per 5 minutes** in steady state. On top of that come about **560 at each worker start** and a **~370-request burst every hour** when the merged-PR chips expire. The Work tab and one team board alone account for about **240 per 5 minutes**.

---

## Shared infrastructure

Bare paths are under `worker/`.

- `ado/http.ts`: a single `AdoHttp.json()` client.
  - A throttle is a 429, or a 503 with `retry-after`. It retries at most twice, and only while the wait is ≤10 s; otherwise it throws `rate_limited` with `retryAfterMs` (http.ts:136-144).
  - No concurrency cap, no de-duplication, no `ETag`/`If-None-Match`.
  - Reads no `X-RateLimit-*` header.
  - Any 3xx counts as an auth failure (`redirect: 'manual'`, http.ts:170-171). A `304 Not Modified` would therefore be misread as "sign in again".
- `poll/scheduler.ts`: per-job timers with `visibleMs`/`backgroundMs`.
  - The first run fires at once (`lastRunAt` undefined).
  - `rate_limited` pauses only that job: 60 s by default, at most 15 min (scheduler.ts:24-25,45-48,103-104).
  - A run in flight is shared through `entry.inFlight`.
- `pipelines/pressure.ts`: an answer carrying `retry-after` or `x-ratelimit-delay` marks the org "slowed" for 5 min.
  - `main.ts:149-150` wraps the client given to boards, PRs, reviews, wiki and share with `pressure.wrapByOrg`.
  - Pipelines and run views wrap per org with `pressure.wrap` (pipelines/service.ts:92, run-views.ts:120).
  - Only pipelines and run views read `slowed()`. Boards and PRs never slow down.
  - It sees only successful answers: a thrown 429 never marks pressure.
- `org-loads.ts`, `ado/limit.ts` (`mapLimit`), `budget.ts`. `budget.ts` holds message byte budgets (`POST_BUDGET_BYTES` 240 KiB, `ANSWER_BUDGET_BYTES` 900 KiB), not request budgets.
- **Persistence.**
  - Orca storage (`StorePort` in connections.ts) holds org config, nudge rules and dismissals, the watch list, share channels and wiki draft records.
  - No Azure DevOps data is persisted. Every cache below is an in-memory `Map`, cold on every worker start.

## Work tab and board editor

### Work tab snapshot (`boards/service.ts` `build()`, `boards/snapshot.ts` `loadMine()`)

Job `mine:<org>`: `MINE_MS` = 60 s visible / 300 s background (service.ts:68). It runs at once at start, even when hidden.

Per tick, in order (sequential except where noted):

1. **Board config** (`ado/board-config.ts` `loadBoardConfig`).
   - In-memory cache, 60 min (`DEFAULT_TTL_MS`).
   - Cold, it costs 5–7 calls: backlogconfiguration and the team boards list (in parallel), then the board, with teamfieldvalues in parallel, then done states per requirement type.
   - Concurrent misses are not single-flighted (service.ts:108-115).
2. **WIQL.** `POST /{project}/{team}/_apis/wit/wiql?$top=500`, `[AssignedTo] = @Me`, state not done (ado/workitems.ts:23-29, 43-53). Every tick.
3. **Hydrate.** `POST /_apis/wit/workitemsbatch` with `$expand=relations`, in sequential batches of 200 (workitems.ts:67-90). Every tick, with the full payload (all fields, including HTML) for every item, whether or not anything changed.
4. **Type states** (`_apis/wit/workitemtypes/{type}/states`). Per-org `ItemSource.stateCache`, 60 min (snapshot.ts:37,77-84).
5. **Missing parents.** Another `workitemsbatch` with relations (snapshot.ts:286-290). Every tick.
6. **PR chips**, in parallel with 5.
   - Per distinct linked PR: `GET /_apis/git/pullrequests/{id}`, then for an open PR `GET /_apis/policy/evaluations` (ado/pr-links.ts:46-60, ado/policy.ts:23-31). `mapLimit` 6.
   - Cached per org in `ItemSource.chipCache`: 2 min open, 60 min merged or abandoned (pr-links.ts:18-19,42-44).
   - A 403 turns chips off for 10 min.
7. **Child tasks.** `workitemsbatch` with `TASK_FIELDS` for up to 1,000 child ids (snapshot.ts:296-318). Every tick.

Per visible tick: 1 WIQL + ⌈n/200⌉ + ⌈parents/200⌉ + ⌈children/200⌉ + chips (2 per open linked PR every other tick, plus every merged PR once an hour).

### Board editor (`boards/board-views.ts`, custom editor `src/board/board.ts`)

- The board opens with `everyone: true` (src/board/board.ts:174). Its WIQL selects the requirement types in the team's area paths that are not done, or were changed in the last 14 days, with `$top=500` (workitems.ts:31-41).
- One job per open board: `BOARD_MS` = 30 s visible / 300 s background (board-views.ts:31). Per tick:
  - the WIQL
  - hydrate: up to 3 batches of 200, with relations
  - missing parents
  - PR chips for every linked PR on the whole team board
- `reload` skips when the last load is under 30 s old (board-views.ts:49). It compares JSON and posts `work.boardChanged`. The editor then asks for `work.board` again (src/board/board.ts:207-210), which is served from the view cache while under 30 s old.
- **Hiding a board drops its view.** `setVisible(false)` with a board calls `drop(key)` (board-views.ts:133-135). On return, `visibilitychange` calls `load()` (board.ts:213-216) and everything is fetched again. The org-wide hide path (`board` undefined → `forget(org)`) exists, but no caller sends it today.
- Board config shares the 60-min config cache. Chips share the per-org chip cache with the Work tab.

### Start-up

- **Work tab.** `src/panel/work/state.ts` sets the snapshot to null and the status to `loading`, then calls `work.snapshot`. The worker returns a cached snapshot when one exists (service.ts:313-320); otherwise it runs a full `load()`. On a fresh start that is the whole cold chain before first paint: config, WIQL, batches, states, parents, chips, children.
- **Board editor.** Same pattern: nothing shows until the full chain finishes.

### Writes

- Move, comment and link-PR all write, then reload the item (`workitemsbatch` with 1 id) and restate it. The result is published into the Work snapshot and every open board view (service.ts:227-282).
- `recent.ts` overlays recent writes onto later loads while the poll still returns an older `rev` (recent.ts:24-40).

## PRs

### One PR poll tick, one org

`poll` runs a `full` load when visible and a `reviews` load when hidden, then always runs `observe` (prs/service.ts:228-232). `statusOf` reads org config only and makes no ADO call (org-status.ts:19-31).

1. **Code projects.**
   - 1 `GET /_apis/git/repositories`, or the paged `/_apis/projects` on 404/400. Only when the setting is `all` (ado/pullrequests.ts:98-107).
   - In-memory closure cache, 60 min (ado/code-projects.ts:6-17). Pipelines keeps a separate copy.
2. **PR lists (full).** Per project, 3 × `GET /{project}/_apis/git/pullrequests`: my active, my completed, reviewer. Run through `mapLimit(…, 4)` (prs/load.ts:94-101). Only the completed list is cached: 5 min (load.ts:15,58-61).
3. **Enrichment (full only).** Per "mine" PR (active, plus completed in the last 14 days), `mapLimit` 4 (load.ts:103):
   - `GET …/pullRequests/{id}/workitems`: 10 min active, 60 min completed (load.ts:16-17,74-77).
   - `GET /{project}/_apis/policy/evaluations?artifactId=…`, active PRs only: 2 min (load.ts:18,79-86).
   - A 403 disables that enrichment for 10 min (load.ts:63-72).
4. **Reviews-only load (hidden).** N reviewer lists, uncached (load.ts:107-110).
5. **`observe`** (only when `notifyPrComments` is on, the default).
   - If the last full load is older than `FRESH_MS` (60 s), it lists my active PRs again: N calls (service.ts:251-253, load.ts:112-115). On hidden ticks it always does.
   - Then `GET …/threads` for up to 20 active PRs (`MAX_WATCHED_PRS`), `mapLimit` 4, no cache (notify.ts:19,47-52; load.ts:117-127).

Formula per tick. N projects, Pa my active, Pc my completed in 14 days, W = min(Pa, 20), C = 1 when comment notifications are on:

- Visible steady (every 60 s): 2N + N/5 + Pa/2 + Pa/10 + Pc/60 + C·W
- Visible cold: 1 + 3N + 2Pa + Pc + C·W
- Hidden (every 5 min): N + C·(N + W)

### PR loads outside the timer

- **Plugin start.** Every signed-in org polls at once, even when hidden.
- **Panel open / org switch.** `prs.snapshot` returns the cached snapshot when the last full load is under 60 s old, otherwise runs a blocking full load (service.ts:299-310).
- **Becoming visible.** A non-fresh snapshot triggers `loadInFull` → `runNow` (full + observe) (service.ts:221-227,336-342).
- **Refresh button.** A forced full load plus observe (service.ts:312-319).
- **`reloadFresh`.** An unconditional full load after Approve or Auto-complete (prs/actions.ts) and after review votes (main.ts:202).
- **Throttle and 403.** As in shared infrastructure. A 403 pauses PR loads for 10 min (service.ts:64-66, 212-213).

### In-flight de-duplication

- Partial. `entry.loading` shares one promise (service.ts:151-167), and the scheduler reuses a run in flight.
- The `remember` caches and the code-projects cache store only settled results, so concurrent misses each send a request (load.ts:46-52, code-projects.ts:12-17).

### Review view (`reviews/service.ts`)

- Each open sends 4 uncached requests: the PR, iterations, then changes (`$top=1000`) and threads in parallel (service.ts:184-192).
- Reopening fetches again. Vote, reply, status, comment and refresh each trigger a full reload.
- A file diff reads iteration and changes facts from an LRU of 5 PRs (a miss costs 2 requests). Per side it sends `GET blobs/{objectId}` plus `GET items?…`, unless the blob LRU (100 entries / 32 MiB) has it. Worst case 6 requests.
- A vote sends: GET the PR, PUT the vote, `reloadFresh`, then the 4-request review reload.

## Pipelines, run views and wiki

### Wiring

Pipelines and run views get the raw `connections.http` (main.ts:179,189) and wrap it per org with `pressure.wrap`. One shared pressure instance (main.ts:149) means headers seen on boards, PRs or wiki also slow that org's pipeline jobs.

### Runs job (pipelines/service.ts; `full` when visible, `background` when hidden)

`RUNS_MS` 30 s visible / 300 s background, 300/300 s when slowed (service.ts:70-71).

1. **Code projects.** As for PRs, with a separate 60-min closure.
2. **Per project**, `mapLimit` 4 (load.ts:77-83):
   - `GET {p}/_apis/build/builds?requestedFor=me&minTime=7d&$top=50`
   - full only: `GET …builds?statusFilter=inProgress&$top=25`
   - `GET {p}/_apis/pipelines/approvals?state=pending&top=50&$expand=steps,permissions` (a 403 skips approvals for 10 min, load.ts:20,63-74)
3. **Watched or pending runs missing from the lists.** `GET builds?buildIds=…` per project (load.ts:91-101).
4. **Timelines (full only).**
   - `GET {p}/_apis/build/builds/{id}/timeline` with **no `changeId`** (load.ts:103-106), `mapLimit` 4.
   - Up to 8 active runs are re-read every tick.
   - Up to 8 finished runs are read once and cached in `finishedChips` (max 100, key `buildId:finishedAt`, load.ts:17-19,125-149).
5. **Unplaced pending approvals.** Timeline (when not fetched this tick) plus `GET {p}/_apis/pipelines/checks/runs/{suite}?$expand=resources` (load.ts:112-123, 229-245).

### Watch job (service.ts)

`WATCH_MS` = 30 s visible **and hidden**; 120 s when slowed (service.ts:72-73). It exists while the watch list is non-empty. One `GET builds?buildIds=…` per distinct project (load.ts:200-204).

### Run-view job, per open run tab (run-views.ts)

`ACTIVE_MS` 5 s (30 s when slowed), `FINISHED_MS` 60 s (run-views.ts:93-95). It runs while the tab's document is visible. Skipped when loaded under 5 s ago. Per tick:

- `GET {p}/_apis/build/builds/{id}`: for an already-read finished run, this is the only call, every 60 s.
- `GET …/timeline?changeId={prev}`: a delta read, merged by `mergeTimeline` (timeline.ts:82-91). A 204 or empty answer keeps the previous timeline.
- `GET …/builds/{id}/logs`: skipped only when nothing in the old or new timeline is in progress (run-views.ts:267).
- **Waiting on an approval:** `GET approvals?approvalIds=…` every tick, plus `checks/runs` per unplaced approval (run-views.ts:272-294). At 5 s this runs for as long as the approval waits.

### Per-tick formulas, one org

- Visible runs tick (30 s): `[≤1/hr projects] + 3N + Pm + min(A,8) + min(Fnew,8) + 2·Qnew`
- Background runs tick (300 s): `2N + Pm + 2·Qnew` (−N if approvals are off)
- Watch tick (30 s): `Wp` (distinct projects among watched runs, ≤20)
- Active run view (5 s): `3 + a_v`. A first load or `refreshNow` reads the whole timeline with no `changeId`.

### Pipeline loads outside the timer

- **Job start fires at once:** at activation (background load), on `onOrgs`, and when a run view opens.
- **Panel open.** `runs.snapshot` runs a full load unless the last full load is under 30 s old (service.ts:322-333).
- **Refresh.** Runs the job now, then a full load if that run wasn't full.
- **Becoming visible.** `loadInFull` if not fresh.
- **Actions** (actions.ts).
  - Decide: approvals GET + PATCH. Cancel: build GET + PATCH. Retry: build + full timeline + PATCH.
  - Then `reloadFresh` and `refreshNow`, which clears cached reads and re-reads everything.

### In-flight de-duplication

- Single-flight per org for the runs job and the watch job. Each run view is single-flight with a generation counter.
- No coalescing across services: the runs list and a run view fetch the same timeline separately.

### Wiki (no polling)

- **Wiki list.** In-memory, 10 min (`WIKIS_TTL_MS`, wiki/service.ts:44). A miss costs `GET /_apis/wiki/wikis` plus the paged `GET /_apis/projects`, in parallel. Concurrent misses each list again.
- **Tree level.** 1 uncached `pages?path&recursionLevel=oneLevel`.
- **Page open.** The wiki list if not cached, plus 1 uncached `pages?includeContent=true`.
- **Search.** The wiki list if not cached, plus 1 POST to almsearch.
- **Drafts and publish.** Each `fresh()` is 1 uncached page read.

`status-bar.ts`, `signals.ts` and `notify.ts` make no ADO requests.

---

## Estimate: requests per 5 minutes for a typical session

Requests are not TSTUs. Microsoft does not publish a per-request cost; the `X-RateLimit-Cost` header is the only measure, and the plugin does not read it today. WIQL queries and wide work-item reads are the costly kinds ("Using queries and individual *get work item* calls is the top way to get rate limits enforced", [integration best practices](https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/integration-bestpractices?view=azure-devops)). So request counts understate how much of the budget the Work tab and the board use.

### Assumptions

| Area | Assumption |
| --- | --- |
| Org | 1 org, N = 10 code projects |
| Work tab | 25 open items assigned to me, 8 parents not in the list, 60 child task ids. Linked PRs: 6 open and 30 merged or abandoned, all also on the team board |
| Team board (everyone) | 300 items (2 hydrate batches), 40 parents not on the board. Linked PRs: 30 open and 370 merged or abandoned |
| PRs | Pa = 6 active mine, Pc = 10 completed in 14 days, W = 6, comment notifications on |
| Pipelines | A = 2 active runs listed, about 1 newly finished run per 5 ticks, 1 watched run, no pending approvals |
| Run view | 1 run tab open on a running build |

### Per surface

| Surface | State | Requests / 5 min | Working |
| --- | --- | ---: | --- |
| Work tab | visible, board not open | ~52 | 5 ticks × 4 (WIQL, hydrate, parents, children) + open chips 6×2 every 2 min (30) + merged chips 30/h (2.5) |
| Work tab | visible, board open | ~20 | chips are shared with the board's cache |
| Work tab | hidden | 4–18 | 1 tick of 4, plus expired chips when no board keeps them warm |
| Team board | visible | ~221 | 10 ticks × 4 (40) + open chips 30×2 every 2 min (150) + merged chips 370/h (31, arriving as one burst each hour) |
| Team board | cold open | ~440 | config ~6 + WIQL + 2 hydrate + parents + 400 PR GETs + 30 evaluations |
| PRs | visible | ~159 | per minute: 22 lists + 3 checks + 0.8 work items + 6 threads |
| PRs | hidden | ~26 | 10 reviewer lists + 10 active lists + 6 thread reads |
| Pipelines | visible | ~322 | per 30 s: 30 lists + 2 timelines + 0.2 finished timelines |
| Pipelines | hidden | ~20 | 20 lists |
| Watch job | any | ~10 | 1 per 30 s, visible or not |
| Run view | running | ~180 | 3 per 5 s |
| Run view | waiting for approval | ~240 | 4 per 5 s, for as long as the approval waits |

### Session totals (one org, per 5 minutes)

| Session | Total | Made up of |
| --- | ---: | --- |
| Sidebar on Work, board and run tab visible side by side | **~477** | Work 20 + board 221 + PRs hidden 26 + Pipelines hidden 20 + watch 10 + run view 180 |
| Sidebar on PRs, board and run tab visible | **~594** | Work hidden 4 + board 221 + PRs 159 + Pipelines hidden 20 + watch 10 + run view 180 |
| Sidebar on Pipelines, board and run tab visible | **~763** | Work hidden 4 + board 221 + PRs hidden 26 + Pipelines 322 + watch 10 + run view 180 |
| Worker start (cold), same session | **~560 in the first minute** | board ~440 + Work ~30 + PRs cold ~59 + Pipelines cold ~35 |
| Hourly | **+~370 in one tick** | the merged-PR chips all expire together |

Work tab and one team board, steady: **~241 per 5 minutes** (20 + 221).
