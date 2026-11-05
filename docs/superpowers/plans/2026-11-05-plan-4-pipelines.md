# Plan 4: Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch pipeline runs live, get to the error fast, act on environment approvals, and hear about failures and waiting approvals whenever Orca is open.

The **Pipelines tab** shows:
- the runs that matter to the user, filtered as Mine, Running, Needs me or Failed, running ones first;
- per run: status, a mini stage-progress bar, Open run, Watch, Open in Azure DevOps;
- per waiting approval: where it waits, who can approve, how long it has waited, **Share for approval**, and **Approve…/Reject…** when the user can approve.

The **run tab** (a full-width custom editor) shows the stage strip, the steps of the selected stage with durations, the selected step's log tailing live (search, errors only, follow), an error summary with *Jump to line* and *Open in Orca*, and Rerun failed stage, Cancel run and Open in Azure DevOps.

**Always on:** desktop notifications when a run of the user's fails, a watched run finishes, or an approval that needs the user starts waiting; the status bar shows failed-run and approval counts beside Plan 3's review count.

**Architecture:** This builds on Plans 1–3.
- **ADO layer.** Pure modules under `worker/ado/` for builds, timelines, build logs, approvals, check suites and the two run writes (cancel, stage retry). Each takes `AdoHttp` from `connections.http`.
- **Pipelines service** (`worker/pipelines/`). One polling job per connected org (a full load while the Pipelines tab is visible, a lighter background load otherwise), a watch job while watched runs are unfinished, a watch list in storage, rate-pressure slow-down, and the `runs.*` handlers. It posts `runs.changed` and feeds the status bar and the notifier through one `RunSignals` hook.
- **Run views** (`worker/pipelines/run-views.ts`). Like Plan 2's board views: one job per visible run tab, polling the build, its timeline (with `changeId`) and its logs list, posting `runs.viewChanged`; the frame then asks for the view and new log lines.
- **Run tab** (`src/run/`). An isolated-frame custom editor bound to `.orca-ado/<org>.<buildId>.adorun`, written into the focused local workspace like Plan 2's board file. Pure modules (ANSI, log model, virtual window, selection) are tested in Node.
- **Sharing.** Plan 3's share module gains the `approval` kind, an approval `ShareSource`, an `email` destination (a `mailto:` link the panel opens), and a host per composer so the Pipelines and PRs tabs each show only their own composer.
- **Wiring.** `registerPipelineHandlers` in `worker/pipelines/handlers.ts`; `worker/main.ts` only composes. `ui.visibility` gains the `pipelines` and `run` surfaces in `worker/visibility-handler.ts`.

**Baseline:** `015ed0b` (Plan 3 through Task 11). Plan 3's Task 11 review, Task 12 and final fix wave are still running; Task 0 re-reads every signature cited below at the post-Plan-3 head before Task 1 starts.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`), Orca components runtime, an isolated-frame custom editor (plain DOM, no libraries), `orca/testing`, ADO REST `api-version=7.1` (check runs `7.1-preview.1`), `notifications.show`, `editor.open`, `mailto:` and Teams chat links.

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md` (§2, §3 pipelines, §4.1, §4.2 pipelines, §5.1, §5.3, §5.8 notification toggles, §5.9, §6 polling and notification set, §7 spikes). Roadmap row 4: `docs/superpowers/plans/2026-11-03-roadmap.md`. Plan 3: `docs/superpowers/plans/2026-11-05-plan-3-prs-sharing.md` and its ledger `.superpowers/sdd/2026-11-05-plan-3-prs-sharing/progress.md` (rulings R1–R29).

## Global Constraints

Everything in Plans 1–3's Global Constraints still binds: credentials and webhook secrecy, the generic rule, zero code comments (one line only for a constraint the code can't express), never approving on the user's behalf, never `orca plugin dev load|watch|reload`, `enable` or anything with `--approve`, never push, merge or change branches, never touch the real clipboard, nothing calls the network (ADO is faked). Commits end with a blank line and a `Co-Authored-By:` trailer for the model doing the work. Verification: `npm run typecheck`, `orca plugin test . --json` (TAP, `# fail 0`), `orca plugin validate . --json`, `orca plugin check . --json`. Additions:

- **One new capability: `notifications:show`** (`{ "kind": "notifications:show" }`, since 1.4.160). Orca asks the user to approve the new fingerprint at the next dev load; nobody approves it for them.
- **ADO endpoints** (base `https://dev.azure.com/{org}/{projectId}`, `api-version=7.1` unless stated):
  - my runs: `GET /_apis/build/builds?requestedFor={me}&minTime={ISO now−7 d}&queryOrder=queueTimeDescending&$top=50`
  - running: `GET /_apis/build/builds?statusFilter=inProgress&queryOrder=queueTimeDescending&$top=25`
  - by ids: `GET /_apis/build/builds?buildIds={csv, ≤100}`; one: `GET /_apis/build/builds/{buildId}`
  - timeline: `GET /_apis/build/builds/{buildId}/timeline`, plus `changeId={n}` once a timeline is held
  - logs: `GET /_apis/build/builds/{buildId}/logs`; lines: `GET /_apis/build/builds/{buildId}/logs/{logId}?startLine={a}&endLine={b}` (JSON `{ count, value: string[] }`)
  - cancel: `PATCH /_apis/build/builds/{buildId}` body `{ status: 'cancelling' }`
  - stage retry: `PATCH /_apis/build/builds/{buildId}/stages/{stageRefName}` body `{ state: 'retry', forceRetryAllJobs: false }`
  - pending approvals: `GET /_apis/pipelines/approvals?state=pending&$expand=steps,permissions&top=50` (on `bad_request`, once more with `$expand=steps`); by id: `?approvalIds={csv}&$expand=steps,permissions`
  - decide: `PATCH /_apis/pipelines/approvals` body `[{ approvalId, status: 'approved' | 'rejected', comment }]`
  - check suite: `GET /_apis/pipelines/checks/runs/{checkSuiteId}?$expand=resources` at `7.1-preview.1`
  - `{me}` is the pinned account's `adoId`. `stageRefName` is the timeline Stage record's `identifier`, never its display name.
- **Nothing about a pipeline is hard-coded.** Stage, job, step, environment, pipeline and branch names come from ADO. Error lines are found by generic patterns (`##[error]`, `error:`-style prefixes, `FAILED`), never by tool or stage name. Fixtures use `contoso`, `Fabrikam Web`, pipelines `web-app-ci`/`web-app-cd`/`api-ci`, branches `develop`/`main`, environment `production`, stages `Build`/`Image`/`Deploy production`.
- **Polling budget** (settled by Spike S2, pinned by Task 5 and Task 7 tests; P = code projects):
  - Pipelines tab visible: every 30 s, per project my runs + running + pending approvals (3P), at most one `buildIds` batch per project for approval and watched runs, and timelines for at most 8 active runs; completed runs' stage chips are read once (at most 8 per load) and cached by `buildId` + `finishTime` (LRU 100).
  - Background: every 5 min, my runs + pending approvals (2P) plus the batch. No running list, no chips. A new approval reads its run's timeline once and its check suite once (cached by approval id).
  - Watched: every 30 s while an unfinished watched run exists, one `buildIds` call per project holding one.
  - Run tab visible: every 5 s while the run is active (build + timeline, plus the logs list while a record is in progress, plus approvals by id while a stage waits); every 60 s once finished (build only, full reload if it changed). Log lines only when the frame asks.
  - **Pressure:** any response carrying `Retry-After` or `X-RateLimit-Delay` puts that org on the background cadence for 5 min (run tab 30 s, watch 120 s). `rate_limited` still pauses through the scheduler.
  - At most 4 requests in flight per org. A `forbidden` builds list pauses that org's runs for 10 min with a message; a `forbidden` approvals list turns approvals off for 10 min with a message while runs keep loading (Plan 3 R13).
- **Size caps.** A posted `RunsSnapshot` stays under `POST_BUDGET_BYTES` (≤ 100 runs, ≤ 12 stage chips each, else trimmed with a message). The panel renders ≤ 30 runs. A `RunView` answer ≤ 900 KiB (≤ 2,000 records, ≤ 10 issues per record, ≤ 2,000 characters per issue). A `LogChunk` ≤ 1,000 lines, ≤ 2,000 characters per line (cut with `…`), ≤ 900 KiB; the frame keeps ≤ 50,000 lines. Approval comments ≤ 1,000 characters. ≤ 20 watched runs per org. Notifications: title ≤ 120, body ≤ 1,000 characters, ≤ 3 per update plus one summary.
- **Settings added** (`contributes.settings`):
  - `notifyRunFailures`: boolean, default `true`, title "Notify when my pipeline runs fail".
  - `notifyApprovals`: boolean, default `true`, title "Notify when a run waits for approval", description "Your runs, and approvals you can give."
  - `notifyWatchedRuns`: boolean, default `true`, title "Notify when a watched run finishes".
  - `approvalShareTemplate` (Task 11): string, default `"Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}"`, title "Approval share line", description "One line per approval. [text]({url}) is the link. Also {stage}, {requestedBy}, {project}."
- **Writes are never auto-retried by the plugin and report their own truth.** Every write reads fresh first; a refusal is the row's message. Approve and Reject run only from a press on a confirm button.
- **Only messages reach the UI.** Worker strings live in `worker/messages.ts`; panel and frame copy lives with them; `messageOf(error)` everywhere. URLs come from `orgWebUrl` (`worker/ado/org.ts`) and the run URL helper (Task 1); `refs/heads/` is stripped only by `branchName` (`worker/ado/pr-links.ts`); post sizes use `byteLength` (`worker/budget.ts`).
- **Every load uses a linked abort signal** (`linkedAbort` from `worker/abort.ts` off the org entry's controller, released in `finally`), passed down with `withSignal`. No recurring timers outside the scheduler; the frame sets no timers at all (durations refresh with each view).
- **Paths from logs are untrusted.** Nothing opens a file outside a matched local workspace; candidates never contain `..`, and the real path must stay inside the workspace root.

## Review Focus

1. **A log line that points outside the repository** (`../../etc/passwd`, `/etc/hosts`, a symlink inside the workspace pointing out, `C:\Windows\win.ini`). Nothing opens; the result is a fixed message. *Test: Task 8, `openRunFile never opens a path outside the workspace`.*
2. **An approval that changes under the user's press** (someone else approved it, it timed out, it needs two approvers, the user isn't allowed, ADO answers 403). One fresh read, at most one PATCH, a result that claims nothing it didn't get, no retry. *Test: Task 6, `decide reads the approval fresh and reports what ADO did`.*
3. **Notification floods and repeats** (a worker restart, five failures in one poll, a retried stage that fails again, a run that is both mine and watched, failures from before Orca started). One notification per finish, at most three per update plus a summary, nothing for what finished before activation. *Test: Task 4, `notifications fire once per finish, cap at three plus a summary, and skip what happened before activation`.*
4. **Log text with markup and noise** (`<script>`, `&amp;`, ANSI colour and cursor codes, a 300 KB line, a 2 million-line log). It renders as text only, lines are cut, chunks and the frame buffer are capped. *Tests: Task 7, `runs.log cuts long lines and caps a chunk by lines and bytes`; Task 9, `ansiSpans strips every escape and never yields markup`.*
5. **A run that disappears or restarts while watched** (deleted run, 404, sign-out mid-poll, a finished run retried from the ADO website). The view says so and stops polling; nothing is posted after sign-out; a finished run that becomes active again resumes 5 s polling. *Tests: Task 7, `a run that disappears stops polling and says so`, `a finished run retried elsewhere resumes fast polling`, `nothing is posted after the org signs out`.*

---

## File map

| File | Responsibility |
|------|----------------|
| `src/shared/pipelines.ts` | Run, stage, approval, view and log types; log constants |
| `src/shared/runs.ts` | Pure ordering, filters and counts shared by worker and panel |
| `src/shared/file-ref.ts` | File references in log text; path candidates |
| `worker/ado/builds.ts`, `timeline.ts`, `build-logs.ts`, `approvals.ts`, `build-actions.ts` | ADO reads and writes for runs |
| `worker/ado/code-projects.ts` | `cachedCodeProjects`, moved out of `worker/prs/load.ts` |
| `worker/status-bar.ts` (modify) | `failedRuns` and `approvals` count kinds |
| `worker/pipelines/settings.ts`, `notify.ts`, `signals.ts` | Notification toggles, notifier, counts + notifications hook |
| `worker/pipelines/pressure.ts`, `watched.ts`, `load.ts`, `service.ts`, `handlers.ts`, `fake-pipelines.ts` | Rate pressure, watch list, per-org run source, service, handlers, test fake |
| `worker/pipelines/actions.ts` | Approve/reject, rerun stage, cancel |
| `worker/tab-files.ts` | `.orca-ado` folder writes, shared by board and run files |
| `worker/pipelines/run-file.ts`, `run-views.ts` | Run tab backing file; run view polling and log reads |
| `worker/pipelines/remote.ts`, `open-file.ts` | ADO git remotes; opening a failing file with `editor.open` |
| `worker/pipelines/share-source.ts` | The `approval` share source |
| `src/run/*` | Run tab frame |
| `src/panel/pipelines/*` | Pipelines tab |
| `src/shared/share/approval-items.ts`, `email.ts` | Approval share items and template; `mailto:` link |
| `src/panel/share/*` (modify) | Email destination, composer host |

## Shared types

`src/shared/pipelines.ts` (Task 1; the frame imports it, so no Node APIs):

```ts
export type StepState = 'pending' | 'running' | 'waiting' | 'succeeded' | 'warning' | 'failed' | 'canceled' | 'skipped'
export type RunState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'succeeded' | 'warning' | 'failed' | 'canceled'
export type RunFilter = 'mine' | 'running' | 'needsMe' | 'failed'
export interface RunKey { projectId: string; buildId: number }
export interface StageChip { id: string; name: string; state: StepState }
export interface Approver { id: string; name: string; uniqueName: string; isGroup: boolean }
export interface ApprovalSummary extends RunKey {
  approvalId: string; stage: string | null; environment: string | null
  approvers: Approver[]; minRequired: number; instructions: string; createdAt: number; canApprove: boolean
}
export interface RunSummary extends RunKey {
  org: string; projectName: string; pipeline: { id: number; name: string }
  runNumber: string; url: string; branch: string; prId: number | null; reason: string
  repository: { id: string; name: string } | null                       // null unless an Azure Repos git repo
  requestedFor: { id: string; name: string }
  state: RunState; queuedAt: number; startedAt: number | null; finishedAt: number | null
  stages: StageChip[] | null                                             // null when no timeline was read
  approvals: ApprovalSummary[]                                           // pending only
  mine: boolean; watched: boolean
}
export interface RunCounts { failedRuns: number; approvals: number }
export interface RunsSnapshot { org: string; me: string | null; runs: RunSummary[]; counts: RunCounts; updatedAt: number; stale: boolean; message?: string }
export interface FileRef { path: string; line: number | null; column: number | null }
export interface Issue { type: 'error' | 'warning'; message: string; file: FileRef | null }
export interface StepView { id: string; name: string; state: StepState; startedAt: number | null; finishedAt: number | null; logId: number | null; logLines: number | null; errorCount: number; warningCount: number; issues: Issue[] }
export interface JobView { id: string; name: string; state: StepState; startedAt: number | null; finishedAt: number | null; steps: StepView[] }
export interface StageView { id: string; identifier: string | null; name: string; state: StepState; startedAt: number | null; finishedAt: number | null; attempt: number; jobs: JobView[]; canRetry: boolean; approvalId: string | null }
export interface Failure { stageId: string; jobId: string; stepId: string; path: string; issues: Issue[]; logId: number | null }
export interface RunView { org: string; run: RunSummary; stages: StageView[]; failures: Failure[]; canCancel: boolean; updatedAt: number; stale: boolean; message?: string }
export interface LogChunk { logId: number; first: number; lines: string[]; total: number }
export interface RunActionResult { ok: boolean; message: string; warn?: true }
export const LOG_FIRST_LINE = 1
export const MAX_LOG_LINES = 1000
export const MAX_LINE_CHARS = 2000
export const MAX_BUFFER_LINES = 50_000
```

Protocol additions in `src/protocol.ts` (each task adds what it registers):

```ts
'runs.snapshot': { input: { org: string }; output: RunsSnapshot }                                         // Task 5
'runs.refresh': { input: { org: string }; output: RunsSnapshot }                                          // Task 5
'runs.watch': { input: { org: string; projectId: string; buildId: number; watched: boolean }; output: RunsSnapshot } // Task 5
'runs.decide': { input: { org: string; projectId: string; approvalId: string; decision: 'approved' | 'rejected'; comment: string }; output: RunActionResult } // Task 6
'runs.retryStage': { input: { org: string; projectId: string; buildId: number; stageId: string }; output: RunActionResult } // Task 6
'runs.cancel': { input: { org: string; projectId: string; buildId: number }; output: RunActionResult }      // Task 6
'runs.open': { input: { org: string; projectId: string; buildId: number }; output: { opened: boolean; message?: string } } // Task 7
'runs.view': { input: { org: string; projectId: string; buildId: number }; output: RunView }              // Task 7
'runs.log': { input: { org: string; projectId: string; buildId: number; logId: number; first?: number }; output: LogChunk } // Task 7
'runs.openFile': { input: { org: string; projectId: string; buildId: number; path: string; line: number | null }; output: { opened: boolean; path?: string; line?: number | null; message?: string } } // Task 8
// 'ui.visibility' input.surface widens to 'work' | 'board' | 'prs' | 'pipelines' (Task 5) | 'run' (Task 7, with run?: RunKey)
// PluginPanelEvents
'runs.changed': RunsSnapshot                                                                               // Task 5
'runs.viewChanged': { org: string; buildId: number }                                                       // Task 7
```

Share types (`src/shared/share/types.ts`, Task 11): `ShareKind = 'pr' | 'approval'`; `ShareDestination` adds `{ kind: 'email'; people: Identity[] }` (opened by the panel; the worker only remembers it).

---

### Task 0: Spikes (offline halves) and baseline re-check

**Files:**
- Create: `docs/superpowers/spikes/2026-11-05-plan-4.md`, in Plan 3's spike-record shape: one table per spike, rows "Question · Method · Result · Decision", live rows marked **pending live** for Task 12. Throwaway probes stay outside the repository.

- [ ] **Step 1: Baseline re-check.** At the branch head (after Plan 3's final fix wave), re-read every signature this plan cites under "Consumes" (Tasks 1–11) and the exported names in `src/panel/share/state.ts`, `src/panel/share/channels.tsx`, `worker/share/service.ts`, `worker/status-bar.ts`, `worker/prs/load.ts`, `worker/boards/board-file.ts`, `worker/visibility-handler.ts`. Record each drift as a row ("cited · actual · tasks affected"). Any drift that changes a task's interface goes back to the controller before Task 1.
- [ ] **Step 2: S1 timeline change detection, offline.** Record from the recon (§"Pipelines: how to watch a live run"): `GET …/timeline` takes `changeId`; the timeline and each record carry `changeId`; whether the answer is incremental is undocumented. Decision: always send the held `changeId`; `mergeTimeline` replaces records by `id`, keeps absent ones, ignores an answer whose `changeId` is lower than the held one, and treats a `204`/empty body as "no change" — correct whether or not ADO filters. Write the fixtures Task 2 uses: `timeline-4520.json` (`changeId` 41) and `timeline-4520-delta.json` (`changeId` 44, two changed records).
- [ ] **Step 3: S2 log tail cost, offline.** Write the budget as formulas (Global Constraints, Polling budget) and evaluate them for P = 2: visible tab ≤ 6 lists + 2 batches + 8 timelines per 30 s; background 4 lists + 2 batches per 5 min; run tab ≤ 4 reads per 5 s plus log reads on growth. Record the tail design: the frame asks for lines only when the logs list shows the selected log grew; first read is the last `MAX_LOG_LINES`; `startLine` base is `LOG_FIRST_LINE` = 1 and `endLine` inclusive (both assumed). Record the pressure rule. Record that the running-step live feed (`TaskApi.getLines`, 7.2-preview, undocumented) is not used.
- [ ] **Step 4: S3 approvals and environments, offline.** Record the assumed shapes the fixtures pin: an approval's `pipeline.owner.id` is the build id; a waiting stage has a `Checkpoint` child whose `id` is the check suite id, with a `Checkpoint.Approval` child whose `id` equals the approval id; the check suite with `$expand=resources` lists `{ type: 'environment', name }`; approval `permissions` bit 2 (`APPROVAL_UPDATE_PERMISSION`) means the caller may approve. Write `approvals-pending.json`, `approval-decided.json`, `check-suite-4520.json`.
- [ ] **Step 5: S4 notifications, offline.**
  - (a) Host API: `notifications.show(params: { title: string; body?: string }) => { delivered: boolean }`, capability `notifications:show`; recon: title ≤ 120, body ≤ 1,000.
  - (b) A `python3 -I` read-only search of `/Applications/Orca.app/Contents/Resources/app.asar` for the notification service's `dispatchPlugin` implementation: record any rate limit, whether it is suppressed while Orca is focused, and whether a click does anything.
  - (c) A throwaway `mountWorker` test in a `mktemp -d` folder: a worker calling `notifications.show` records the call in `host.callsOf('notifications.show')`; without the capability it is refused with `capability_denied`.
  - Decision: add the capability; dedupe per finish; cap 3 per update plus a summary; a click opens nothing (no callback exists).
- [ ] **Step 6: List the live halves as pending rows:** S1 whether `changeId` answers are incremental and whether an unchanged timeline is `204`; S2 whether a running step's log grows under build logs before it finishes, the `startLine` base, `X-RateLimit-*` and `Retry-After` during a 10-minute watched run with the tab and the run tab open; S3 every shape in Step 4, `$expand=steps,permissions` accepted, the permissions bit for a group-assigned approver, a two-approver approval, the "requester can't approve" refusal text; S4 the notification on macOS, focused and unfocused; `requestedFor` with an id; who `requestedFor` is on a CI run started by PR auto-complete; stage retry on the implicit `__default` stage; Docker and Helm error lines matched; Linux and Windows agent paths resolved; a run tab whose file was pruned; the run tab and the Pipelines tab at 360 px in both themes.
- [ ] **Step 7: Commit** "Record the Plan 4 spikes".

### Task 1: Run read layer and shared run rules

**Files:**
- Create: `src/shared/pipelines.ts` (types above), `src/shared/runs.ts`, `worker/ado/builds.ts`, fixtures `worker/ado/fixtures/builds-mine.json` (4512 `web-app-ci` PR 4101 validation, failed, mine; 4520 `web-app-cd` on `main`, in progress, mine; 4498 `api-ci` `develop` succeeded, mine; 4490 `web-app-ci` `develop` failed 2 days ago and 4505 the same pipeline and branch succeeded later, both mine), `builds-running.json` (4520, and 4531 `web-app-cd` `main` in progress, requested for Grace), `build-4520.json`.
- Modify: `worker/messages.ts` (`MALFORMED.build` "Azure DevOps returned an unexpected pipeline run response.").
- Test: `worker/ado/builds.test.ts`, `src/shared/runs.test.ts`.

**Interfaces:**
- Consumes: `AdoHttp.json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }>`, `withSignal(http, signal?)` (`worker/ado/http.ts`); `shaped(build, message)`, `expectList`, `expectText` (`worker/ado/shape.ts`); `orgWebUrl(org)` (`worker/ado/org.ts`); `branchName(ref)` (`worker/ado/pr-links.ts`); `MALFORMED` (`worker/messages.ts`).
- Produces:

```ts
// src/shared/runs.ts
export const FAILED_WINDOW_MS = 24 * 60 * 60_000
export function isActive(run: RunSummary): boolean                       // queued | running | waiting | cancelling
export function orderRuns(runs: readonly RunSummary[]): RunSummary[]     // active first by queuedAt desc, then by (finishedAt ?? queuedAt) desc, ties by buildId desc
export function needsMe(run: RunSummary): boolean                        // a pending approval I can approve, or any pending approval on my run
export function approvalsNeedingMe(runs: readonly RunSummary[]): ApprovalSummary[]
export function failedRuns(runs: readonly RunSummary[], now: number): RunSummary[]
export function runsFor(filter: RunFilter, runs: readonly RunSummary[], now: number): RunSummary[]
export function runCounts(runs: readonly RunSummary[], now: number): RunCounts
export const STEP_GLYPH: Record<StepState, string>   // succeeded ✓, failed ✗, running ●, waiting ⏸, warning !, canceled ⊘, skipped –, pending ○
// worker/ado/builds.ts
export interface RawBuild { id: number; buildNumber: string; status: string; result?: string; queueTime?: string; startTime?: string; finishTime?: string; sourceBranch: string; reason?: string; definition: { id: number; name: string }; project: { id: string; name: string }; requestedFor?: { id: string; displayName: string }; repository?: { id: string; name: string; type?: string }; triggerInfo?: Record<string, string>; _links?: { web?: { href?: string } } }
export interface BuildCriteria { requestedFor?: string; statusFilter?: 'inProgress'; minTime?: number; top: number }
export function listBuilds(http: AdoHttp, org: string, projectId: string, criteria: BuildCriteria, signal?: AbortSignal): Promise<RawBuild[]>
export function buildsByIds(http: AdoHttp, org: string, projectId: string, ids: number[], signal?: AbortSignal): Promise<RawBuild[]>   // [] without a call for no ids; ≤ 100 ids
export function getBuild(http: AdoHttp, org: string, projectId: string, buildId: number, signal?: AbortSignal): Promise<RawBuild>
export function runWebUrl(org: string, projectName: string, buildId: number): string
export function runStateOf(raw: Pick<RawBuild, 'status' | 'result'>): RunState
export function toRunSummary(raw: RawBuild, org: string, me: string): RunSummary   // stages null, approvals [], watched false
```

**Rules:**
- `runStateOf`: `notStarted`/`postponed` → queued; `inProgress` → running; `cancelling` → cancelling; `completed` + `succeeded` → succeeded, `partiallySucceeded` → warning, `failed` → failed, `canceled` → canceled, anything else → warning. Never `waiting`: the service sets it from approvals.
- `branch`: `branchName(triggerInfo['pr.sourceBranch'] ?? sourceBranch)`; `prId`: `Number(triggerInfo['pr.number'])` when an integer, else from `refs/pull/<n>/merge`, else null.
- `url`: `_links.web.href` normalised through `new URL(…).href` (Plan 3 R21), else `runWebUrl` = `${orgWebUrl(org)}/${encodeURIComponent(projectName)}/_build/results?buildId=${buildId}`.
- `repository` only when `type === 'TfsGit'`. `mine` compares `requestedFor.id` with `me` case-insensitively. Bad dates → null (`queuedAt` 0), as Plan 3.
- `needsMe(run)`: `isActive(run) && run.approvals.some(a => a.canApprove || run.mine)`.
- `failedRuns`: runs that are `mine || watched`, `failed`, finished within `FAILED_WINDOW_MS`, with no newer run (by `queuedAt`) of the same `pipeline.id` and `branch` that is active, succeeded or warning.
- `runsFor`: `mine` → `run.mine`; `running` → `isActive`; `needsMe` → `needsMe`; `failed` → `failedRuns`; each in `orderRuns` order. `runCounts` = `{ failedRuns: failedRuns(…).length, approvals: approvalsNeedingMe(…).length }`.
- Malformed answers go through `shaped(…, MALFORMED.build)`.

- [ ] **Step 1: Write the failing tests.**
  - `toRunSummary maps a PR validation run`: 4512 → `branch` `feature/1204-vehicle-search`, `prId` 4101, `state` failed, `mine` true, `url` from `_links.web.href`.
  - `toRunSummary builds the web URL from names when the link is missing`: `https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4520`.
  - `runStateOf maps every status and result`.
  - `listBuilds sends the criteria`: mine query has `requestedFor=<ME>`, `minTime` = ISO of the given time, `queryOrder=queueTimeDescending`, `$top=50`; running query has `statusFilter=inProgress`, `$top=25`.
  - `buildsByIds sends one comma list and makes no call for none`.
  - `getBuild reads one run`; `a malformed run list becomes the fixed error`.
  - runs: `orderRuns puts active runs first, newest first`; `needsMe counts approvals I can give and approvals on my runs`; `failedRuns drops runs replaced by a newer run of the same pipeline and branch` (4490 replaced by 4505; 4512 kept); `failedRuns ignores failures older than 24 hours and other people's unwatched runs`; `runsFor filters and runCounts counts`.
- [ ] **Step 2: Run.** `orca plugin test . --json`. Expected: the new tests FAIL (modules missing); existing tests pass.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Read pipeline runs".

### Task 2: Timelines, logs and file references

**Files:**
- Create: `worker/ado/timeline.ts`, `worker/ado/build-logs.ts`, `src/shared/file-ref.ts`, fixtures `timeline-4512.json` (Stage `Build` succeeded; Stage `Image` failed → Phase → Job `Build image` → Task `Build and push image` failed with `log.id` 9 and an error issue whose `data.sourcepath` is `/home/vsts/work/1/s/src/Api/Program.cs`, `linenumber` 42; Stage `Deploy production` skipped), `logs-4512.json`, `log-4512-9.json` (lines with ISO timestamps, `##[section]`, `##[command]`, an `ERROR: failed to solve: …` Docker line, a `/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002: ; expected` line and `##[error]Bash exited with code '1'.`), plus Task 0's `timeline-4520*.json`.
- Modify: `worker/messages.ts` (`MALFORMED.timeline` "Azure DevOps returned an unexpected run timeline.", `MALFORMED.log` "Azure DevOps returned an unexpected log response.").
- Test: `worker/ado/timeline.test.ts`, `worker/ado/build-logs.test.ts`, `src/shared/file-ref.test.ts`.

**Interfaces:**
- Consumes: Task 1 types; `AdoHttp`, `withSignal`, `shaped`.
- Produces:

```ts
// worker/ado/timeline.ts
export interface RawIssue { type?: string; message?: string; data?: Record<string, string> }
export interface RawRecord { id: string; parentId?: string | null; type: string; name: string; identifier?: string | null; order?: number; state?: string; result?: string | null; startTime?: string | null; finishTime?: string | null; log?: { id: number } | null; errorCount?: number; warningCount?: number; issues?: RawIssue[] | null; attempt?: number; changeId?: number }
export interface RawTimeline { changeId: number; records: RawRecord[] }
export function getTimeline(http: AdoHttp, org: string, projectId: string, buildId: number, changeId?: number, signal?: AbortSignal): Promise<RawTimeline | null>   // null = no change
export function mergeTimeline(previous: RawTimeline | null, next: RawTimeline | null): RawTimeline
export function stepStateOf(record: RawRecord, children?: readonly RawRecord[]): StepState
export function stageChips(timeline: RawTimeline): StageChip[]
export function runStages(timeline: RawTimeline, logLines: ReadonlyMap<number, number>, runActive: boolean): StageView[]
export function failuresOf(stages: readonly StageView[]): Failure[]
export function approvalPlaceOf(timeline: RawTimeline, approvalId: string): { stageId: string; stage: string; checkSuiteId: string | null } | null
// worker/ado/build-logs.ts
export function listLogs(http: AdoHttp, org: string, projectId: string, buildId: number, signal?: AbortSignal): Promise<Map<number, number>>   // logId → lineCount
export function getLogLines(http: AdoHttp, org: string, projectId: string, buildId: number, logId: number, first: number, last: number, signal?: AbortSignal): Promise<string[]>
// src/shared/file-ref.ts
export function fileRefOf(text: string): FileRef | null
```

**Rules:**
- **Hierarchy.** Stage → (Phase) → Job → Task; Checkpoint records sit under their Stage. Children sort by `order`, then name. A timeline with no Stage records gets one synthetic stage `{ id: '__run', identifier: null, name: 'All jobs' }` holding every job.
- **`stepStateOf`:** `pending` → pending; `inProgress` → running; `completed` + `succeeded` → succeeded, `succeededWithIssues` → warning, `failed` → failed, `canceled`/`abandoned` → canceled, `skipped` → skipped. A Stage that isn't completed and has an in-progress `Checkpoint.Approval` descendant → waiting.
- **`canRetry`:** `!runActive`, stage failed or canceled, and `identifier` present.
- **Issues:** `error`/`warning` only, ≤ 10 per record, messages cut at 2,000 characters; `file` from `data.sourcepath` (+ `linenumber`, `columnnumber`), else `fileRefOf(message)`.
- **`failuresOf`:** each failed step, in timeline order; a failed job with no failed step counts as one failure with `stepId` = the job id. `path` = `"<stage> › <job> › <step>"`.
- **`mergeTimeline`:** see Task 0 S1. Records keep the merged order by `order`.
- **`getTimeline`:** sends `changeId` only when given; an empty or `204` answer → null.
- **`approvalPlaceOf`:** the `Checkpoint.Approval` record with `id === approvalId`, its `Checkpoint` parent (`checkSuiteId`) and that parent's Stage.
- **`getLogLines`:** `startLine=first&endLine=last`; returns `value`; each line cut at `MAX_LINE_CHARS` with `…`.
- **`fileRefOf`:** strips an ISO timestamp prefix and a `##[...]` marker, ignores `http(s)://` text, then tries in order: `path(line[,col]): error|warning`; `path:line[:col]` where the basename has an extension or starts with `Dockerfile`; Python `File "path", line N`. `path` keeps the text's spelling (backslashes included).

- [ ] **Step 1: Write the failing tests.**
  - `runStages builds stages, jobs and steps in order with durations and log line counts`: 4512 → stages `Build`/`Image`/`Deploy production`; `Image` failed with one job `Build image` whose step `Build and push image` has `logId` 9 and `logLines` 240.
  - `a waiting approval makes its stage waiting and approvalPlaceOf finds it`: 4520 → `Deploy production` waiting, place `{ stage: 'Deploy production', checkSuiteId: <fixture id> }`.
  - `a timeline without stages gets one synthetic stage`.
  - `canRetry only for a failed or canceled stage with an identifier on a finished run`.
  - `issues carry a file from sourcepath or from the message`; `issues are capped at ten and cut at 2,000 characters`.
  - `failuresOf lists the failing step with its path`, and `a failed job without a failed step is its own failure`.
  - `stageChips follows the stages`.
  - S1: `mergeTimeline applies an incremental answer`, `mergeTimeline gives the same result when ADO ignores changeId`, `mergeTimeline keeps the held timeline for a null or older answer`; `getTimeline sends changeId only when held and maps 204 to null`.
  - `listLogs maps ids to line counts`; `getLogLines asks for an inclusive range and cuts long lines`.
  - file-ref: `fileRefOf finds MSBuild, tsc, Go, Python, Docker and Helm template references` (`/home/vsts/work/1/s/src/Api/Program.cs(42,17): error CS1002` → `{ path: '/home/vsts/work/1/s/src/Api/Program.cs', line: 42, column: 17 }`; `src/app.ts(3,5): error TS2322`; `./cmd/main.go:12:3: undefined: x`; `File "app/main.py", line 7`; `Dockerfile:14`; `Error: template: chart/templates/deployment.yaml:23:20: executing …`); `fileRefOf ignores URLs and plain text`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Read run timelines and logs".

### Task 3: Approvals, check suites and run writes

**Files:**
- Create: `worker/ado/approvals.ts`, `worker/ado/build-actions.ts`, plus Task 0's approval fixtures. `approvals-pending.json` holds two approvals: one on 4520 (my run) assigned to the group `[Fabrikam Web]\Release Approvers`, `permissions` 1, `minRequiredApprovers` 1; one on 4531 (Grace's run) assigned to me directly, `permissions` 3, with `instructions`.
- Modify: `worker/messages.ts` (`MALFORMED.approval` "Azure DevOps returned an unexpected approval response.").
- Test: `worker/ado/approvals.test.ts`, `worker/ado/build-actions.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2; `AdoError` (`worker/ado/http.ts`).
- Produces:

```ts
// worker/ado/approvals.ts
export const APPROVAL_UPDATE_PERMISSION = 2
export interface RawApprover { id: string; displayName: string; uniqueName?: string; isContainer?: boolean }
export interface RawApprovalStep { assignedApprover: RawApprover; status?: string; actualApprover?: RawApprover | null; comment?: string }
export interface RawApproval { id: string; status: string; createdOn?: string; instructions?: string; minRequiredApprovers?: number; permissions?: number; steps?: RawApprovalStep[]; pipeline?: { id?: number | string; name?: string; owner?: { id: number; name?: string } } }
export function listPendingApprovals(http: AdoHttp, org: string, projectId: string, signal?: AbortSignal): Promise<RawApproval[]>
export function getApprovals(http: AdoHttp, org: string, projectId: string, ids: string[], signal?: AbortSignal): Promise<RawApproval[]>
export function decideApproval(http: AdoHttp, org: string, projectId: string, approvalId: string, status: 'approved' | 'rejected', comment: string): Promise<RawApproval>
export function runIdOf(raw: RawApproval): number
export function toApprovalSummary(raw: RawApproval, input: { projectId: string; me: string; stage: string | null; environment: string | null }): ApprovalSummary
export function checkSuiteEnvironment(http: AdoHttp, org: string, projectId: string, checkSuiteId: string, signal?: AbortSignal): Promise<string | null>
// worker/ado/build-actions.ts
export function cancelBuild(http: AdoHttp, org: string, projectId: string, buildId: number): Promise<void>
export function retryStage(http: AdoHttp, org: string, projectId: string, buildId: number, stageRef: string): Promise<void>
```

**Rules:**
- `canApprove` = `(permissions & APPROVAL_UPDATE_PERMISSION) !== 0`, or a pending step whose `assignedApprover.id` equals `me` (case-insensitive).
- `approvers`: distinct `assignedApprover`s in step order; `isGroup` from `isContainer`. `uniqueName` falls back to `''`. `instructions` falls back to `''`. `minRequired` defaults to 1.
- `runIdOf` reads `pipeline.owner.id`; a missing one is malformed (`MALFORMED.approval`).
- `listPendingApprovals` and `getApprovals` send `$expand=steps,permissions`; a `bad_request` answer is retried once with `$expand=steps` (reads only). `getApprovals` makes no call for no ids.
- `decideApproval` sends a one-element array and returns the matching element of the answer's `value`.
- `checkSuiteEnvironment` returns the first `resources[]` entry with `type === 'environment'`'s `name`, else null; at `7.1-preview.1`.
- `retryStage` encodes `stageRef` and sends `{ state: 'retry', forceRetryAllJobs: false }`; `cancelBuild` sends `{ status: 'cancelling' }`. Neither retries anything.

- [ ] **Step 1: Write the failing tests.**
  - `toApprovalSummary maps approvers, groups, instructions and the waiting time`.
  - `canApprove from the permissions bit or a direct assignment`: the 4520 approval → false; the 4531 approval → true; a group-assigned approval with `permissions` 3 → true.
  - `listPendingApprovals asks for pending approvals with steps and permissions, and falls back to steps on a refusal`.
  - `getApprovals asks by id and makes no call for none`.
  - `decideApproval sends one decision with the comment`: exact body.
  - `runIdOf reads the owner id and refuses an approval without one`.
  - `checkSuiteEnvironment finds the environment resource`.
  - `retryStage patches the stage by its identifier`: path `…/stages/Deploy_production`; `cancelBuild sets cancelling`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Read approvals and write run actions".

### Task 4: Always-on signals: status-bar counts and notifications

**Files:**
- Create: `worker/pipelines/settings.ts`, `worker/pipelines/notify.ts`, `worker/pipelines/signals.ts`.
- Modify: `worker/status-bar.ts`, `orca-plugin.json` (the `notifications:show` capability; `notifyRunFailures`, `notifyApprovals`, `notifyWatchedRuns`), `worker/messages.ts` (copy below).
- Test: `worker/status-bar.test.ts` (existing cases stay green), `worker/pipelines/notify.test.ts`, `worker/pipelines/signals.test.ts`, `worker/pipelines/settings.test.ts`.

**Interfaces:**
- Consumes: today's `CountKind = 'toReview'`, `OrgCounts`, `StatusBar { setOrgs; setCount(org, kind, count | null); counts() }`, `statusBarFor(orgs, counts?)`, `statusText(orgs, counts?)`, `createStatusBar(update)` (`worker/status-bar.ts`); `watchSettings(settings, log): Promise<() => Record<string, unknown>>` (`worker/settings-watcher.ts`); Task 1 `runCounts`, `isActive`.
- Produces:

```ts
// worker/status-bar.ts
export type CountKind = 'toReview' | 'failedRuns' | 'approvals'
// worker/pipelines/settings.ts
export interface NotifyPrefs { failures: boolean; approvals: boolean; watched: boolean }
export interface PipelineSettings { notify(): NotifyPrefs }                                      // Task 11 adds approvalTemplate()
export function watchPipelineSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PipelineSettings>
// worker/pipelines/notify.ts
export const MAX_NOTIFICATIONS_PER_UPDATE = 3
export interface RunNotification { key: string; title: string; body: string }
export function notificationsFor(input: { org: string; runs: readonly RunSummary[]; prefs: NotifyPrefs; since: number; notified: ReadonlySet<string> }): RunNotification[]
export interface Notifier { observe(org: string, runs: readonly RunSummary[]): void }
export function createNotifier(deps: { show: (n: { title: string; body: string }) => Promise<unknown>; prefs: () => NotifyPrefs; since: number; log: (message: string) => void }): Notifier
// worker/pipelines/signals.ts
export interface RunSignals { update(org: string, runs: readonly RunSummary[] | null): void }
export function createRunSignals(deps: { bar: Pick<StatusBar, 'setCount'>; notifier: Notifier; now: () => number }): RunSignals
```

**Status bar** (one item, as today):
- Text: `ADO`, then the non-zero parts joined with ` · `: `<n> failed`, `<n> approval` / `<n> approvals`, `<n> to review`. Example: `ADO · 1 failed · 2 approvals · 3 to review`.
- Tone: worst of the connection tone and `danger` (failed), `warning` (approvals), `accent` (to review).
- Tooltip and `statusText`: today's lines, then `<n> failed pipeline run(s): contoso 1`, `<n> approval(s) waiting: contoso 2`, then the review line. Singular "1 failed pipeline run", "1 approval waiting".
- Counts still come only from `connected` orgs.

**Notifications** (`notificationsFor` is pure; `createNotifier` owns the bounded `notified` set (500, oldest dropped) and calls `show` without awaiting each in turn):
- **Finish** (key `done:<org>:<buildId>:<finishedAt>`): a run that is not active and has `finishedAt ≥ since`:
  - failed and `mine || watched`, with `prefs.failures` (or `prefs.watched` for a watched run) → title `runFailedTitle(pipeline)` = `"<pipeline> failed"`, body `runBody(org, runNumber, branch, failedAt(stage))` with the first failed chip's name when chips are loaded;
  - watched and not failed, with `prefs.watched` → title `runFinishedTitle(pipeline, state)`: `"<pipeline> succeeded"`, `"<pipeline> finished with warnings"`, `"<pipeline> was canceled"`.
- **Approval** (key `approval:<org>:<approvalId>`): each approval from `approvalsNeedingMe` with `createdAt ≥ since`, with `prefs.approvals` → title `approvalTitle(pipeline)` = `"<pipeline> is waiting for approval"`, body `runBody(org, runNumber, branch, waitingAt(environment ?? stage))` plus ` · You can approve it.` when `canApprove`.
- `runBody(org, runNumber, branch, detail?)` = `"<org> · <runNumber> on <branch>"` + (detail ? ` · <detail>` : ''). `failedAt(stage)` = `"failed at <stage>"`, `waitingAt(place)` = `"waiting at <place>"`.
- A watched run that finished before activation still notifies (the user asked to watch it); a mine-only one does not.
- More than `MAX_NOTIFICATIONS_PER_UPDATE` → the first three, then title `moreRunUpdates(n)` = `"<n> more pipeline updates"`, body `MORE_UPDATES_BODY` = "Open the Pipelines tab in the Azure DevOps panel to see them." Every key is marked notified either way.
- Titles cut at 120 characters and bodies at 1,000, with `…`.
- A `show` rejection logs `NOTIFY_FAILED` "Couldn't show a desktop notification." once per update; the keys stay notified (never retried).

**Signals:** `update(org, runs)` sets both counts from `runCounts(runs, now())` and calls `notifier.observe(org, runs)`; `update(org, null)` clears both counts and observes nothing.

**Settings:** a missing or non-boolean toggle reads as `true`; a read failure keeps the previous values (shared `watchSettings`).

- [ ] **Step 1: Write the failing tests.**
  - status bar: `failed runs, approvals and reviews show in order with the worst tone`; `one of each uses the singular`; `counts of orgs that aren't connected are ignored` (extended to the new kinds); `statusText adds the run and approval lines`.
  - notify (**Review Focus 3**): `notifications fire once per finish, cap at three plus a summary, and skip what happened before activation`: five failures after `since` → 3 + summary; the same runs again → none; a failure before `since` → none; the same build failing again with a new `finishedAt` (a retried stage) → one more.
  - `a run that is mine and watched notifies once`; `a watched run that succeeded notifies its completion`; `approvals notify only when they need me and say when I can approve`; `each toggle turns its kind off`; `long titles and bodies are cut`; `a failed show logs once and is not retried` (no second call on the next observe).
  - signals: `update sets both counts and observes; null clears them`.
  - settings: `toggles default to on and keep the last good read`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `orca-plugin.json` gains the capability and the three settings exactly as in Global Constraints.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and `orca plugin validate . --json` pass.
- [ ] **Step 5: Commit** "Count failed runs and approvals, and notify about them".

### Task 5: Pipelines service, polling and handlers

**Files:**
- Create: `worker/ado/code-projects.ts`, `worker/pipelines/pressure.ts`, `worker/pipelines/watched.ts`, `worker/pipelines/load.ts`, `worker/pipelines/service.ts`, `worker/pipelines/handlers.ts`, `worker/pipelines/fake-pipelines.ts`. The fake is `fakePipelines()`: `fakeAdo()` (`worker/boards/fake-ado.ts`) plus the build, timeline, logs, approvals and check-suite routes from the fixtures, with exported matchers (`isMineRuns`, `isRunningRuns`, `isBuildsByIds`, `isOneBuild`, `isTimeline`, `isLogs`, `isLogLines`, `isApprovals`, `isApprovalPatch`, `isStagePatch`, `isBuildPatch`, `isCheckSuite`) and a `runs` handle whose `builds`, `timelines` and `approvals` maps tests mutate to move a run on. It reuses `ME` from `worker/prs/fake-prs.ts`. Never call `clear()`.
- Modify:
  - `worker/prs/load.ts`: `cachedCodeProjects` and `CodeProjects` move to `worker/ado/code-projects.ts`; `worker/prs/service.ts` imports them from there (behaviour unchanged).
  - `src/protocol.ts`: `runs.snapshot`, `runs.refresh`, `runs.watch`, `runs.changed`; `ui.visibility` surface adds `'pipelines'`.
  - `worker/visibility-handler.ts`: deps gain `pipelines`; `surface === 'pipelines'` → `pipelines.visibility(input)`.
  - `worker/messages.ts`: `RUNS_TRIMMED` "Showing the newest runs only.", `RUNS_NEED_BUILD_READ` "Pipelines need Build (Read) access.", `RUNS_LOAD_FAILED` "Couldn't load pipeline runs.", `APPROVALS_NEED_ACCESS` "Pending approvals need more access, so Needs me may be incomplete.", `TOO_MANY_WATCHED` "You can watch up to 20 runs.", `RUN_ALREADY_FINISHED` "This run has already finished."
  - `worker/main.ts`: settings, notifier (`show: n => orca.host.call('notifications.show', n)`, `since` = activation time), signals (`bar`), pressure, watch list, the service, `pipelines.onOrgs` in the connections `post`, `registerPipelineHandlers`, `registerVisibilityHandler` with `pipelines`, `stopPolling` disposes it.
- Test: `worker/pipelines/load.test.ts`, `worker/pipelines/service.test.ts`, `worker/pipelines/pressure.test.ts`, `worker/pipelines/watched.test.ts`, `worker/main.test.ts`; `worker/prs/*.test.ts` stay green.

**Interfaces:**
- Consumes: Tasks 1–4; `createScheduler(clock)`, `Scheduler { upsert; remove; setVisible; runNow; dispose }`, `Job { key; visibleMs; backgroundMs; run(signal) }` (intervals ≥ 1,000 ms) (`worker/poll/scheduler.ts`); `linkedAbort(parent)` (`worker/abort.ts`); `POST_BUDGET_BYTES`, `byteLength`, `newestThatFit(items, budget, at, maxItems?)` (`worker/budget.ts`); `mapLimit` (`worker/ado/limit.ts`); `NamedItem` (`worker/ado/core.ts`); `StorePort` (`worker/connections.ts`); `NOT_CONNECTED`, `joinMessages`, `badRequest`, `failureMessage(error, fallback)` (`worker/messages.ts`); `registerVisibilityHandler(orca, { boards, prs })`; test helpers `drain`, `fakeClock`, `memoryStore`, `withWorker` (`worker/test-support.ts`), `fakeAdo` (`on`, `hold`, `hang`, `count`, `calls`) and `json` (`worker/boards/fake-ado.ts`).
- Produces:

```ts
// worker/ado/code-projects.ts
export type CodeProjects = (setting: OrgStatus['codeProjects'], signal?: AbortSignal) => Promise<NamedItem[]>
export function cachedCodeProjects(http: AdoHttp, org: string, now: () => number): CodeProjects
// worker/pipelines/pressure.ts
export const PRESSURE_MS = 5 * 60_000
export interface Pressure { wrap(http: AdoHttp, org: string): AdoHttp; slowed(org: string): boolean }
export function createPressure(now: () => number): Pressure
// worker/pipelines/watched.ts
export const MAX_WATCHED = 20
export interface WatchList { list(org: string): Promise<RunKey[]>; set(org: string, key: RunKey, watched: boolean): Promise<RunKey[]>; drop(org: string, keys: RunKey[]): Promise<void> }
export function createWatchList(store: StorePort): WatchList       // storage key `pipelines:watched:<org>`
// worker/pipelines/load.ts
export interface RunsLoad { runs: RunSummary[]; off: { approvals: boolean } }
export interface RunSource {
  full(me: string, projects: NamedItem[], watched: RunKey[], signal?: AbortSignal): Promise<RunsLoad>
  background(me: string, projects: NamedItem[], watched: RunKey[], signal?: AbortSignal): Promise<RunsLoad>
  watched(me: string, keys: RunKey[], signal?: AbortSignal): Promise<RunSummary[]>
  approval(me: string, key: { projectId: string; approvalId: string }): Promise<{ run: RunSummary; approval: ApprovalSummary } | null>
}
export function createRunSource(http: AdoHttp, org: string, now: () => number): RunSource
// worker/pipelines/service.ts
export interface PipelinesServiceDeps { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; scheduler: Scheduler; watchList: WatchList; pressure: Pressure; signals: RunSignals; post: (snapshot: RunsSnapshot) => void; now: () => number }
export interface PipelinesService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<RunsSnapshot>
  refresh(org: string): Promise<RunsSnapshot>
  watch(input: { org: string; projectId: string; buildId: number; watched: boolean }): Promise<RunsSnapshot>
  visibility(input: { org: string; visible: boolean }): { ok: true }
  cachedRun(org: string, buildId: number): RunSummary | null
  isWatched(org: string, buildId: number): boolean
  approval(org: string, key: { projectId: string; approvalId: string }): Promise<{ run: RunSummary; approval: ApprovalSummary } | null>   // cached pair, else a fresh read
  me(org: string): Promise<string>
  dispose(): void
}
export function createPipelinesService(deps: PipelinesServiceDeps): PipelinesService
// worker/pipelines/handlers.ts
export interface PipelineHandlerDeps { pipelines: PipelinesService }                 // Task 6 adds actions, Task 7 views, Task 8 openFile
export function registerPipelineHandlers(orca: OrcaWorkerApi, deps: PipelineHandlerDeps): void
// worker/visibility-handler.ts (changed)
export function registerVisibilityHandler(orca: OrcaWorkerApi, deps: { boards: BoardsService; prs: PrsService; pipelines: PipelinesService }): void
```

**Behaviour:**
- **Pressure.** `wrap` returns an `AdoHttp` that, after each answer, marks the org slowed for `PRESSURE_MS` when the headers carry `retry-after` or `x-ratelimit-delay`. The service wraps once per org entry.
- **Full load** (per code project, `mapLimit(…, 4)`): my runs, running runs, pending approvals; then one `buildsByIds` per project for approval runs and watched runs not already listed; approvals placed with `approvalPlaceOf` on the run's timeline and named with `checkSuiteEnvironment` (both cached by approval id); chips for up to 8 active runs every load and up to 8 newly finished runs (cache by `buildId:finishTime`, LRU 100). An active run with pending approvals becomes `waiting`. Union by `buildId`, `orderRuns`, `watched` from the list.
- **Background load:** my runs + approvals + the batch; chips carried over from the last full load for runs whose `status` and `finishTime` are unchanged.
- **Jobs.** `runs:<org>` (`visibleMs` 30,000, `backgroundMs` 300,000; both 300,000 while slowed): full when the org's tab is visible, else background. `watch:<org>` (30,000 both; 120,000 while slowed) exists only while a watched run is unfinished; its run calls `source.watched` and merges the answers. After each run the job is upserted again with the current intervals.
- **Every successful load** calls `signals.update(org, runs)`; then finished watched runs are dropped from the watch list. Orgs that leave `connected` abort their entry, lose both jobs and get `signals.update(org, null)`; a load finishing afterwards posts and signals nothing.
- **Snapshot:** `counts = runCounts(runs, now())`; over `POST_BUDGET_BYTES` keep `newestThatFit(runs, …, run => isActive(run) ? Infinity : run.queuedAt, 100)` with `RUNS_TRIMMED`; chips past 12 per run are dropped before measuring. Posted as `runs.changed` once a full load exists (as Plan 3's PRs).
- **Failures:** the last snapshot stays, `stale: true`, `failureMessage(error, RUNS_LOAD_FAILED)`; an aborted load posts nothing. A `forbidden` builds list pauses that org 10 min with `RUNS_NEED_BUILD_READ`; a `forbidden` approvals list turns approvals off 10 min with `APPROVALS_NEED_ACCESS` in `message` while runs keep loading. Unknown or signed-out org → `AdoError('unauthorized', 401, NOT_CONNECTED)`.
- **`snapshot`** returns a full snapshot younger than 30 s, else loads one; **`refresh`** runs the job now and returns or throws; **`visibility`** as Plan 3's PRs service.
- **`watch`:** watching a finished run → `badRequest(RUN_ALREADY_FINISHED)`; a 21st → `badRequest(TOO_MANY_WATCHED)`; then the snapshot is recomputed (watched flags) and posted, and `watch:<org>` starts or stops.
- **`approval`:** the pair from the last snapshot, else `source.approval` (fresh `getApprovals` + `getBuild` + placement); null when gone.

- [ ] **Step 1: Write the failing tests** (`fakePipelines()`, the real scheduler with `fakeClock()`; mounted tests inside `withWorker`).
  - S2 budget: `a visible load reads each project's lists once and caps timelines`: P = 2 → 6 list calls, at most 2 batch calls, at most 8 timelines; 30 s later the same lists and timelines only for active runs; total call count asserted.
  - `a background load reads my runs and approvals only and keeps the chips`.
  - `a waiting run carries its approval with the stage and environment`; `Needs me and Failed come from the shared rules` (`counts` = `{ failedRuns: 1, approvals: 2 }` on the fixtures).
  - `every load updates the signals; an org that leaves clears them`.
  - `watching starts the watch job, a finished watched run is dropped and the job stops`; `watching a finished run or a 21st run is refused`; `the watch list survives a restart` (memoryStore).
  - `pressure moves the org to the background cadence for five minutes` (a `retry-after` header on a 200 → next `runs:<org>` run 300 s later; after 5 min back to 30 s).
  - `a forbidden builds list pauses the org; a forbidden approvals list only turns approvals off`.
  - `a failed refresh keeps the last snapshot as stale`; `a snapshot over the post budget is trimmed with the message`.
  - `a removed job aborts its requests and nothing is posted after sign-out` (`fake.hang(isMineRuns)`).
  - `approval returns the cached pair, else reads it fresh`.
  - code projects: the existing PR service tests stay green after the move.
  - main: `runs.snapshot answers through the handler`, `the status command reports failed runs and approvals`, `ui.visibility routes pipelines to the pipelines service and the rest as before`, `a failed run after activation shows a desktop notification with no refusals` (`w.host.callsOf('notifications.show')` length 1).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, validate and check pass.
- [ ] **Step 5: Commit** "Poll pipeline runs with counts, watching and notifications".

### Task 6: Approve, reject, rerun a stage and cancel

**Files:**
- Create: `worker/pipelines/actions.ts`.
- Modify: `src/protocol.ts` (`runs.decide`, `runs.retryStage`, `runs.cancel`), `worker/pipelines/handlers.ts` (`PipelineHandlerDeps` gains `actions`), `worker/messages.ts`, `worker/main.ts` (`after` refreshes the org's runs; Task 7 adds the run view).
- Test: `worker/pipelines/actions.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: Task 2 `getTimeline`, `runStages`; Task 3 `getApprovals`, `decideApproval`, `runIdOf`, `retryStage`, `cancelBuild`; Task 1 `getBuild`, `runStateOf`; Task 5 `PipelinesService.me`, `registerPipelineHandlers`; `messageOf` (`src/shared/messages.ts`).
- Produces:

```ts
export const MAX_COMMENT = 1000
export interface RunActions {
  decide(input: { org: string; projectId: string; approvalId: string; decision: 'approved' | 'rejected'; comment: string }): Promise<RunActionResult>
  retryStage(input: { org: string; projectId: string; buildId: number; stageId: string }): Promise<RunActionResult>
  cancel(input: { org: string; projectId: string; buildId: number }): Promise<RunActionResult>
}
export function createRunActions(deps: { http: AdoHttp; me: (org: string) => Promise<string>; after: (org: string, buildId: number) => void }): RunActions
```

**Rules** (one fresh read, at most one write, never retried; `after` runs unawaited after every attempt that reached ADO):
- **decide:** comment trimmed; over `MAX_COMMENT` → `badRequest(COMMENT_TOO_LONG)` "Keep the comment under 1,000 characters." Fresh `getApprovals([id])`: missing or not `pending` → `{ ok: false, message: APPROVAL_NOT_PENDING }` "This approval is no longer pending." Then `decideApproval`. Answer status equals the decision → `APPROVED` "Approved." / `REJECTED` "Rejected."; still `pending` after an approval → `{ ok: true, warn: true, message: approvedNeedsMore(n) }` = "Approved. It still needs <n> more approval(s)." (n = `minRequired` − approved steps); a refusal → `{ ok: false, message: messageOf(error) }`.
- **retryStage:** fresh build and full timeline (no `changeId`); the stage (by record id) missing → `STAGE_GONE` "That stage isn't in this run any more."; not `canRetry` → `STAGE_NOT_RETRYABLE` "Only a failed or canceled stage of a finished run can be rerun."; else `retryStage(identifier)` → `rerunning(name)` = "Rerunning <stage>."
- **cancel:** fresh build: completed → `RUN_ALREADY_FINISHED`; cancelling → `RUN_ALREADY_CANCELLING` "The run is already cancelling."; else `cancelBuild` → `RUN_CANCELLING` "Cancelling the run."

- [ ] **Step 1: Write the failing tests.**
  - (**Review Focus 2**) `decide reads the approval fresh and reports what ADO did`: pending → one PATCH → "Approved."; already approved by someone → no PATCH, `ok: false`, "This approval is no longer pending."; two required approvers → `warn`, "Approved. It still needs 1 more approval."; a 403 → `ok: false` with ADO's message and exactly one PATCH.
  - `reject sends the comment`; `a long comment is refused before any call`.
  - `retryStage reruns a failed stage by its identifier`, `refuses a stage that isn't failed or a run still in progress`, `reports a stage that is gone`.
  - `cancel cancels a running run and leaves finished or cancelling ones alone`.
  - `every attempt that reached ADO triggers after, unawaited`.
  - main: `runs.decide answers through the handler and refreshes the runs`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Approve, reject, rerun a stage and cancel a run".

### Task 7: Run tab, worker side

**Files:**
- Create: `worker/tab-files.ts`, `worker/pipelines/run-file.ts`, `worker/pipelines/run-views.ts`.
- Modify:
  - `worker/boards/board-file.ts`: `writeBoardFile` and `openBoard` use `writeTabFile`/`openTabFile`; `BoardFileFs` becomes an alias of `TabFileFs`. Its exports and messages are unchanged and `worker/boards/board-file.test.ts` stays green unedited.
  - `src/protocol.ts`: `runs.open`, `runs.view`, `runs.log`, `runs.viewChanged`; `ui.visibility` surface adds `'run'` with `run?: RunKey`.
  - `worker/visibility-handler.ts`: deps gain `runViews`; `'run'` → `runViews.setVisible(input)`.
  - `worker/pipelines/handlers.ts`: deps gain `views` and `openRun`.
  - `worker/messages.ts`: `RUN_GONE` "That run no longer exists, or you can't see it.", `BAD_RUN` "That run can't be opened.", `NO_LOCAL_WORKSPACE_RUN` "Open a local workspace first; runs open in a tab there.", `RUN_TRIMMED` "Some issue details were left out to keep this run view small."
  - `worker/main.ts`: run views (`changed` posts `runs.viewChanged`), `onOrgs`, the Task 6 `after` also calls `views.refreshNow`.
- Test: `worker/tab-files.test.ts`, `worker/pipelines/run-file.test.ts`, `worker/pipelines/run-views.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–6 (`PipelinesService.isWatched` feeds `watched`); `focusedWorkspace(call, listed?)`, `HostCall` (`worker/workspace/focused.ts`); `isValidOrgName` (`worker/ado/org.ts`); `writeBoardFile(fs, workspacePath, content)`, `openBoard(deps, org)` (`worker/boards/board-file.ts`); `NO_BOARDS` (`src/shared/messages.ts`).
- Produces:

```ts
// worker/tab-files.ts
export const TAB_FOLDER = '.orca-ado'
export type TabFileFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>
export function writeTabFile(fs: TabFileFs, workspacePath: string, name: string, text: string): Promise<string>   // creates the folder and its `*` .gitignore, rewrites only on change
export function openTabFile(deps: { call: HostCall; fs: TabFileFs }, name: string, text: string, noWorkspace: string): Promise<{ opened: boolean; message?: string }>
// worker/pipelines/run-file.ts
export const RUN_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
export type RunFileFs = TabFileFs & Pick<typeof import('node:fs/promises'), 'readdir' | 'stat' | 'unlink'>
export function runFileName(org: string, buildId: number): string                 // `${org}.${buildId}.adorun`; BAD_RUN when invalid
export function openRun(deps: { call: HostCall; fs: RunFileFs; now: () => number }, input: { org: string; projectId: string; buildId: number }): Promise<{ opened: boolean; message?: string }>
// worker/pipelines/run-views.ts
export interface RunViewsDeps { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; scheduler: Scheduler; pressure: Pressure; watched: (org: string, buildId: number) => boolean; changed: (change: { org: string; buildId: number }) => void; now: () => number }
export interface RunViews {
  onOrgs(orgs: OrgStatus[]): void
  view(input: { org: string; projectId: string; buildId: number }): Promise<RunView>
  log(input: { org: string; projectId: string; buildId: number; logId: number; first?: number }): Promise<LogChunk>
  setVisible(input: { org: string; visible: boolean; run?: RunKey }): { ok: true }
  refreshNow(org: string, buildId: number): void
}
export function createRunViews(deps: RunViewsDeps): RunViews
```

**Behaviour:**
- **Run file:** content `{ org, projectId, buildId }` (pretty JSON). `openRun` writes it through `openTabFile` with `NO_LOCAL_WORKSPACE_RUN`, then deletes `.adorun` files in `TAB_FOLDER` whose `mtime` is older than `RUN_FILE_MAX_AGE_MS` (at most 50, never the one just written; a failed delete is skipped).
- **`view`:** a view younger than 5 s is returned; otherwise build + `getTimeline(changeId of the held one)` merged + `listLogs` (first load, or while a record is in progress) + `getApprovals` for waiting checkpoints (placed and named as in Task 5) → `RunView` with `run` (from `toRunSummary`, approvals, chips, `watched`), `stages` (`runStages`), `failures` (`failuresOf`), `canCancel` (queued, running or waiting). A `not_found` → `AdoError('not_found', 404, RUN_GONE)` and the job is removed. Over 900 KiB → issues trimmed to 3 per record and `RUN_TRIMMED`.
- **Jobs:** a visible run gets `runview:<org>:<buildId>`: while active `visibleMs`/`backgroundMs` 5,000 (30,000 when slowed); once finished 60,000, and that run reads only the build, reloading fully when its `status` or `finishTime` changed (which is how a retry from elsewhere resumes 5 s polling). A changed view (JSON without `updatedAt`) calls `changed`. Hidden → job removed (the view stays cached, LRU 10).
- **`log`:** without `first`, the tail: `total` from the view's log line count (else `listLogs`), `first = max(LOG_FIRST_LINE, total − MAX_LOG_LINES + 1)`. With `first`, lines `[first, first + MAX_LOG_LINES − 1]`, clipped to `total`. Lines cut at `MAX_LINE_CHARS`; a chunk over 900 KiB drops lines from its start for a tail read, from its end for an earlier read, adjusting `first`.
- Every load uses `linkedAbort` off the org's controller; `onOrgs` aborts and forgets orgs that leave `connected`; nothing is posted for them afterwards.

- [ ] **Step 1: Write the failing tests.**
  - tab files: `writeTabFile creates the folder and its gitignore once and rewrites only on change`; the board-file tests stay green unedited.
  - run file: `openRun writes the run file into the focused local workspace and opens it` (`editor.open` path `.orca-ado/contoso.4512.adorun`); `openRun refuses without a focused local workspace`; `old run files are pruned, the new one never`; `an invalid org or build id is refused`.
  - views: `view builds stages, failures and the waiting approval`; `a visible active run polls every five seconds and posts viewChanged only on change`; S1 `the second read sends the held changeId and merges the delta`; `a finished run polls the build every minute`; (**Review Focus 5**) `a finished run retried elsewhere resumes fast polling`, `a run that disappears stops polling and says so`, `nothing is posted after the org signs out`; `a hidden view stops polling`; `pressure slows a run view to thirty seconds`.
  - log (**Review Focus 4**): `runs.log reads the tail by default and earlier lines on request`; `runs.log cuts long lines and caps a chunk by lines and bytes` (a 300 KB line → 2,000 characters; 1,000 lines of 1,500 bytes → under 900 KiB).
  - main: `runs.open and runs.view answer through the handlers`; `ui.visibility routes run to the run views`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Serve live run views and their logs".

### Task 8: Open the failing file

**Files:**
- Create: `worker/pipelines/remote.ts`, `worker/pipelines/open-file.ts`.
- Modify: `src/shared/file-ref.ts` (`pathCandidates`), `src/protocol.ts` (`runs.openFile`), `worker/pipelines/handlers.ts` (deps gain `openFile`), `worker/messages.ts` (`noRepoWorkspace(repo)` "Open a local workspace of <repo> first.", `fileNotFound(path, repo)` "Couldn't find <path> in your local workspaces of <repo>.", `NOT_A_FILE_PATH` "That isn't a file path Orca can open."), `worker/main.ts` (git found with `findExecutable('git', { pathEnv: process.env.PATH })`).
- Test: `worker/pipelines/remote.test.ts`, `worker/pipelines/open-file.test.ts`, `src/shared/file-ref.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: `listWorkspaces(call)`, `focusedWorkspace(call, listed?)`, `WorkspaceEntry` (`worker/workspace/focused.ts`); `runCommand(file, args, { timeoutMs, signal })` and `RunResult` (`worker/sys/run.ts`); `findExecutable` (`worker/sys/find-executable.ts`); Task 5 `PipelinesService.cachedRun`; Task 7 `RunViews.view`.
- Produces:

```ts
// src/shared/file-ref.ts
export const MAX_CANDIDATES = 12
export function pathCandidates(path: string, max?: number): string[]
// worker/pipelines/remote.ts
export interface AdoRemote { org: string; project: string; repo: string }
export function parseAdoRemote(url: string): AdoRemote | null
export function remotesOf(gitRemoteVerbose: string): AdoRemote[]
// worker/pipelines/open-file.ts
export interface OpenFileDeps { call: HostCall; remotes: (workspacePath: string) => Promise<AdoRemote[]>; isFileInside: (root: string, relative: string) => Promise<boolean> }
export function openRunFile(deps: OpenFileDeps, input: { run: RunSummary; path: string; line: number | null }): Promise<{ opened: boolean; path?: string; line?: number | null; message?: string }>
export function gitRemotes(run: RunCommand, gitPath: string | null, now: () => number): (workspacePath: string) => Promise<AdoRemote[]>   // `git -C <path> remote -v`, 5 s timeout, cached per path 10 min; [] without git
export function fileInside(fs: Pick<typeof import('node:fs/promises'), 'realpath' | 'stat'>): (root: string, relative: string) => Promise<boolean>
```

**Rules:**
- `parseAdoRemote` accepts `https://[user@]dev.azure.com/{org}/{project}/_git/{repo}`, `https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}`, `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}` and `{org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}`; segments are percent-decoded; comparisons are case-insensitive.
- `pathCandidates`: `\` → `/`; a drive letter and a leading `./` are dropped; a path with an empty or `..` segment gives `[]`; otherwise its suffixes, longest first, at most `max`.
- `fileInside`: `realpath(root)` and `realpath(join(root, relative))`; true only when the second starts with the first plus a separator and is a regular file. Any error → false.
- `openRunFile`: input path over 1,000 characters or no candidates → `{ opened: false, message: NOT_A_FILE_PATH }`. Candidate workspaces are local ones (`hostId === null`) whose remotes match `run.org` and `run.repository.name` (and `run.projectName` when the remote names a project), ordered: branch equal to `run.branch`, then the focused workspace, then the rest. A run without an Azure Repos repository uses the focused local workspace only. The first candidate path inside a workspace wins → `editor.open({ workspaceId, path })` → `{ opened: true, path, line }`. No matching workspace → `noRepoWorkspace(repo)`; no file → `fileNotFound(basename, repo)`.
- Handler `runs.openFile`: the run from `cachedRun`, else `views.view(…).run`.

- [ ] **Step 1: Write the failing tests.**
  - `parseAdoRemote reads every Azure DevOps remote form` and `ignores GitHub and other hosts`; `remotesOf reads git remote -v output`.
  - `pathCandidates gives suffixes longest first for Linux and Windows agent paths` (`/home/vsts/work/1/s/src/Api/Program.cs`, `D:\a\1\s\src\Api\Program.cs` → `…`, `src/Api/Program.cs`, `Api/Program.cs`, `Program.cs`).
  - (**Review Focus 1**) `openRunFile never opens a path outside the workspace`: `../../etc/passwd`, `/etc/hosts` (no `etc/hosts` inside), `C:\Windows\win.ini`, a symlink `src/link → /etc` in a `mktemp` workspace → `opened: false`, no `editor.open` call.
  - `openRunFile opens the deepest existing match in the workspace of the run's repository, preferring its branch`; `a run's repository without a local workspace says so`; `a missing file says so`; `without git the focused workspace is used`.
  - main: `runs.openFile answers through the handler`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Open a failing file from a run in Orca".

### Task 9: Run tab frame

**Files:**
- Create: `src/run/run.html` (styles from Orca's theme variables, as `src/board/board.html`), `src/run/run.ts` (DOM glue), `src/run/ref.ts`, `src/run/ansi.ts`, `src/run/log-model.ts`, `src/run/virtual.ts`, `src/run/view-state.ts`, `src/run/render.ts`.
- Modify: `orca-plugin.json` (`customEditors` gains `{ "id": "run", "title": "Azure DevOps run", "extensions": [".adorun"], "entry": "src/run/run.html", "priority": "default", "frame": "isolated" }`).
- Test: `src/run/ref.test.ts`, `src/run/ansi.test.ts`, `src/run/log-model.test.ts`, `src/run/virtual.test.ts`, `src/run/view-state.test.ts`.

**Interfaces:**
- Consumes: `runs.view`, `runs.log`, `runs.decide`, `runs.retryStage`, `runs.cancel`, `runs.watch`, `runs.openFile`, `runs.viewChanged`, `ui.visibility` `'run'` (Tasks 5–8); `fileRefOf` (Task 2); `LOG_FIRST_LINE`, `MAX_LOG_LINES`, `MAX_BUFFER_LINES` (shared types); `messageOf`, `OPEN_LINK_UNAVAILABLE` (`src/shared/messages.ts`); the board frame's pattern: `orca.document` (`get`, `onDidChange`), `orca.plugin.request`/`on`, `orca.on('theme')`, `visibilitychange`/`pagehide`/`pageshow` visibility reports (`src/board/board.ts`).
- Produces (frame-internal, tested):

```ts
// ref.ts
export interface RunRef { org: string; projectId: string; buildId: number }
export function parseRunRef(text: string): RunRef | null
// ansi.ts
export interface Span { text: string; classes: string[] }
export function ansiSpans(line: string): Span[]
// log-model.ts
export type LineKind = 'error' | 'warning' | 'section' | 'command' | 'group' | 'endgroup' | 'debug' | 'plain'
export interface LogLine { n: number; text: string; kind: LineKind; time: string | null }
export interface LogBuffer { logId: number; first: number; lines: LogLine[]; total: number }
export function parseLine(n: number, raw: string): LogLine
export function isErrorText(text: string): boolean
export function appendChunk(buffer: LogBuffer | null, chunk: LogChunk, cap?: number): LogBuffer
export function visibleIndexes(buffer: LogBuffer, errorsOnly: boolean): number[]
export function searchHits(buffer: LogBuffer, query: string): number[]
export function errorLines(buffer: LogBuffer, max?: number): LogLine[]
// virtual.ts
export function windowOf(input: { scrollTop: number; viewport: number; rowHeight: number; count: number; overscan?: number }): { start: number; end: number; offset: number }
export function scrollTopFor(index: number, rowHeight: number, viewport: number): number
// view-state.ts
export function defaultSelection(view: RunView): { stageId: string | null; stepId: string | null }
export function durationText(startedAt: number | null, finishedAt: number | null, now: number): string
```

Glyphs come from `STEP_GLYPH` (Task 1), the same map the Pipelines tab uses.

**Rules:**
- `parseLine`: strips a leading ISO timestamp into `time` and a `##[error|warning|section|command|group|endgroup|debug]` marker into `kind`; otherwise `kind` is `error` when `isErrorText`, else `plain`.
- `isErrorText` (generic): `##[error]`; `(^|\s)(error|ERROR|Error)(\s+[A-Za-z]*\d+)?\s*:`; `\bFAILED\b`; `^fatal:`. Matches `ERROR: failed to solve: …`, `Error: UPGRADE FAILED: …` and `error CS1002:`; not `0 Error(s)` or `errors.go`.
- `ansiSpans`: SGR 0, 1, 2, 3, 4, 22–24, 30–37, 90–97, 39, 40–47, 100–107, 49 become classes (`b`, `dim`, `i`, `u`, `fg-<n>`, `bg-<n>`); 38/48 extended colours are consumed and ignored; every other escape sequence is removed. Span texts concatenate to the line without escapes. The DOM sets only `textContent` and `className`.
- `appendChunk`: appends a tail chunk that continues the buffer, prepends an earlier chunk, replaces the buffer when the chunk doesn't touch it or the log id changed; keeps at most `cap` (`MAX_BUFFER_LINES`) lines, dropping the oldest.
- `searchHits`: literal, smart-case (case-sensitive only when the query has a capital).
- `defaultSelection`: the first failed stage and its first failed step; else the waiting or running stage and its running step; else the last stage and its last step.
- `windowOf`: rows `[start, end)` with `overscan` (default 20) on both sides; `offset = start * rowHeight`.
- **Screen** (copy exact):
  - Toolbar: `<pipeline> <runNumber>`, `<branch> · <requestedFor>`, the state; buttons "Watch"/"Stop watching", "Rerun failed stage" (the selected stage when it `canRetry`, else the first that does; hidden when none), "Cancel run" → "Confirm cancel" (when `canCancel`), "Open in Azure DevOps" (`orca.shell.openExternal(run.url)`; `consent-unavailable` → `OPEN_LINK_UNAVAILABLE`). Results show in the banner.
  - Stage strip: one button per stage: glyph, name, duration; `aria-pressed` on the selected one.
  - Steps of the selected stage grouped by job: glyph, name, duration, error/warning counts.
  - Approval banner on a waiting stage: "Waiting for approval at <environment or stage> for <duration>. Approvers: <names, groups marked (group)>." with "Approve…" / "Reject…" when `canApprove` (a comment field, then "Approve" / "Reject" and "Cancel"), and "To ask someone, use Share for approval in the Pipelines tab."
  - Error summary ("Errors", when `failures` exist): per failure its path and issues, then the first 20 `errorLines` of its loaded log as "Line <n>: <text>" with "Jump to line" and, when `fileRefOf` finds a file (or the issue has one), "Open in Orca" → `runs.openFile`; the answer shows "Opened <path>, line <n>." or its message.
  - Log: search input "Search the log" (Enter next, Shift+Enter previous, "<i> of <n>"), "Errors only", "Follow", "Load earlier" (when `first > LOG_FIRST_LINE`), "Lines <first>–<last> of <total>". Rows virtualised at a fixed height, line numbers, ANSI classes, error rows tinted with `--orca-destructive`. A step with no log: "Azure DevOps hasn't published this step's log yet. It shows here as soon as it does."; a pending step: "This step hasn't started."
- **Data flow:** open → `runs.view` → select → `runs.log` (tail). `runs.viewChanged` for this run → `runs.view` again; when the selected step's `logLines` exceeds the buffer's end → `runs.log({ first: end + 1 })`; with Follow on, scroll to the end. Visibility reports `ui.visibility` `{ surface: 'run', org, visible, run }`. No timers.

- [ ] **Step 1: Write the failing tests.**
  - `parseRunRef accepts a run file and refuses anything else`.
  - (**Review Focus 4**) `ansiSpans strips every escape and never yields markup`: `\x1b[31m<script>\x1b[0m &amp;` → spans text `<script> &amp;` with `fg-1` on the first; cursor-move and OSC sequences removed; an unterminated escape removed.
  - `parseLine reads timestamps and ADO markers`; `isErrorText finds Docker, Helm, MSBuild and generic errors but not error counts or file names`.
  - `appendChunk tails, prepends, resets on a gap and caps the buffer`.
  - `visibleIndexes keeps only error lines when asked`; `searchHits is smart-case and literal`; `errorLines returns the first error lines`.
  - `windowOf and scrollTopFor place the rows`.
  - `defaultSelection picks the failing step, else the running one, else the last`; `durationText formats seconds, minutes and hours`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the pure modules, then `render.ts`, `run.ts` and `run.html`; add the editor contribution.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, `orca plugin validate . --json` and `orca plugin check . --json` (syntax, files and imports of the new editor) pass.
- [ ] **Step 5: Commit** "Add the live run tab".

### Task 10: Pipelines tab

**Files:**
- Create: `src/panel/pipelines/state.ts`, `src/panel/pipelines/pipelines-tab.tsx`, `src/panel/pipelines/run-card.tsx`, `src/panel/pipelines/approval.tsx`, `src/panel/pipelines/fixtures.ts`.
- Modify: `src/panel/panel.tsx` (`TabBody` renders `PipelinesTab` for `pipelines`; `setup` subscribes to `runs.changed`; cleanup calls `hidePipelines`; `Panel` calls `syncPipelines`), `src/panel/visibility.ts` (`surfaceVisibility` accepts `'pipelines'`), `src/panel/test-support.ts` (default `runs.snapshot` answer), `src/panel/panel.check.ts` (a `pipelines` scenario with a failed, a running and a waiting run).
- Test: `src/panel/pipelines/pipelines-tab.test.tsx`.

**Interfaces:**
- Consumes: `runs.snapshot`, `runs.refresh`, `runs.watch`, `runs.changed`, `runs.decide`, `runs.open` (Tasks 5–7); `runsFor`, `runCounts`, `isActive` (Task 1); `surfaceVisibility`, `hostIsVisible` (`src/panel/visibility.ts`); `LONG_WAIT`, `tab`, `messageOf` (`src/panel/state.ts`); `SnapshotMessage`, `LoadFailure` (`src/panel/snapshot-parts.tsx`); the PRs tab's state pattern (`syncPrs`, `acceptPrs`, `align`, `openPr` with R28 handling in `src/panel/prs/state.ts`); test helpers `mountPanel`, `closeCleanly`, `requestsTo`, `org` (`src/panel/test-support.ts`).
- Produces:

```ts
// state.ts
export const runFilter: Atom<RunFilter>                         // key 'pipelinesFilter', persist 'workspace', default 'mine'
export function syncPipelines(org: OrgStatus | null, onScreen: boolean): void
export function acceptRuns(next: RunsSnapshot): void
export const hidePipelines: () => void
// pipelines-tab.tsx
export function PipelinesTab({ org }: { org: OrgStatus }): OrcaNode
// run-card.tsx
export function RunCard({ org, run }: { org: string; run: RunSummary }): OrcaNode
export function stageLine(stages: readonly StageChip[]): string
// approval.tsx
export function ApprovalBlock({ org, run, approval }: { org: string; run: RunSummary; approval: ApprovalSummary }): OrcaNode
```

**UI** (copy exact):
- **Header:** muted "Updated <RelativeTime>"; `IconButton` refresh "Refresh"; `SnapshotMessage`.
- **Filters:** a wrapping `Row` of small `Button`s, `solid` for the selected one and `ghost` otherwise: "Mine", "Running", "Needs me", "Failed"; the last two add ` · <n>` from `counts` when above 0.
- **Runs** (`runsFor(filter, runs, Date.now())`, ≤ 30, then muted "Showing 30 of <n> runs."): a `Card` per run, title = pipeline name, description `<runNumber> · <branch>` + ` · PR <prId>` when set + ` · <requestedFor>`.
  - A `Badge`: queued "queued" neutral, running "● running" accent, waiting "⏸ waiting for approval" warning, cancelling "cancelling" neutral, succeeded "✓ succeeded" success, warning "! partially succeeded" warning, failed "✗ failed" danger, canceled "canceled" neutral. Muted time: "queued <RelativeTime>", "started <RelativeTime>" or "finished <RelativeTime>".
  - Stage bar when `stages` is set: a `Row gap="xs"` of `Box width={14} height={6} radius="full"` with `background` success / danger / warning (waiting, warning) / accent (running) / muted (pending, skipped, canceled), at most 12; then `Text size="xs" muted truncate` with `stageLine` (`"Build ✓ · Image ✗ · Deploy production –"`, glyphs from `STEP_GLYPH`, then `+<n> more`).
  - `Button` "Open run" → `runs.open` (`LONG_WAIT`); a refusal shows its message in a danger `Callout` under the card. `IconButton` bell "Watch" / "Stop watching" (solid when watched; disabled for a finished unwatched run). `Link href={run.url}` "Open in Azure DevOps".
  - One `ApprovalBlock` per pending approval: `Callout tone="warning" title="Waiting for approval"` with "<environment or stage or 'A stage'> · waiting <RelativeTime format='duration'>", "Approvers: <names, groups suffixed ' (group)'>" plus " · needs <n>" when `minRequired > 1`, the instructions muted (≤ 500 characters with `…`); when `canApprove`, "Approve…" and "Reject…" reveal `Textarea` "Comment (optional)" (`maxLength` 1000) with "Approve" (success) or "Reject" (danger) and ghost "Cancel"; the result shows as a `Callout` (success, warning for `warn`, danger for `ok: false`). Task 11 adds "Share for approval".
- **Empty states** per filter: Mine "No runs of yours in the last 7 days" / "Runs you queue or trigger in this organization's code projects show up here."; Running "Nothing is running" / "Runs in progress in your code projects show up here."; Needs me "Nothing needs you" / "Approvals you can give, and your runs waiting for someone else's, show up here."; Failed "No failed runs" / "Your runs that failed in the last 24 hours show up here until a newer run replaces them."
- Per-run panel state (results, confirm, open errors) is keyed by `buildId` or `approvalId`, never by list position (Plan 3 R11).

- [ ] **Step 1: Write the failing tests.**
  - `runs show their state, stage bar and stage line`; `filters switch the list and show the counts`.
  - `Needs me shows the approval with approvers and waiting time`.
  - `Approve asks for a comment, sends runs.decide only on confirm, and shows the result`; `a warning result shows in warning tone`.
  - `Watch sends runs.watch and the bell follows the snapshot`.
  - `Open run sends runs.open and shows a refusal`.
  - `runs.changed replaces the list; a stale snapshot keeps it with the warning`.
  - `visibility changes call ui.visibility with surface pipelines`.
  - `each filter's empty state`; `more than 30 runs shows the cap note`.
  - `thirty runs with twelve stages and an approval each stay under 2,000 nodes` (count the nodes of `panel.tree()`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `orca plugin check . --json` exits 0 with the `pipelines` scenario.
- [ ] **Step 5: Commit** "Add the Pipelines tab".

### Task 11: Share for approval

**Files:**
- Create: `src/shared/share/approval-items.ts`, `src/shared/share/email.ts`, `worker/pipelines/share-source.ts`.
- Modify:
  - `src/shared/share/types.ts`: `ShareKind = 'pr' | 'approval'`; `ShareDestination` adds `{ kind: 'email'; people: Identity[] }`.
  - `src/shared/share/template.ts`: `TEMPLATE_EMPTY_LINK` becomes source-neutral (Plan 3 R27): "The link in the share template needs text, like [text]({url})." (update its one assertion).
  - `worker/share/service.ts`: remembered prefs accept `email` (users only, ≤ `MAX_SHARE_PEOPLE`); the people cap covers `email`; `sources` gains `approval`.
  - `worker/pipelines/settings.ts`: `approvalTemplate()` (`APPROVAL_TEMPLATE` when empty or not a string).
  - `orca-plugin.json`: `approvalShareTemplate`.
  - `worker/main.ts`: `sources: { pr: …, approval: approvalShareSource(pipelines, pipelineSettings) }`.
  - `src/panel/share/state.ts`, `composer.tsx`, `channels.tsx`: `ComposerInput` gains `host`, `email`, `subject`; `shareView(host)`; `openChannels(host)`; `Choices` gains `email` and `emailPeople`; link results generalise from chat to chat and email.
  - `src/panel/prs/release-set.tsx`, `src/panel/prs/prs-tab.tsx`: pass `host: 'prs', email: false, subject: ''`; use `shareView('prs')` and `openChannels('prs')`.
  - `src/panel/pipelines/pipelines-tab.tsx`, `approval.tsx`: "Share for approval", an `IconButton` settings "Teams channels", and `Composer`/`Channels` when `shareView('pipelines')` says so.
  - `src/panel/test-support.ts`: the default `share.prefs` answer follows `kind`.
- Test: `src/shared/share/approval-items.test.ts`, `src/shared/share/email.test.ts`, `worker/share/service.test.ts`, `worker/pipelines/settings.test.ts`, `src/panel/share/composer.test.tsx`, `src/panel/pipelines/pipelines-tab.test.tsx`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: `ShareSource { kind; template(); fallback; vars; items(org, keys): Promise<{ items: ShareItem[]; prs: PrKey[] }> }`, `createShareService(deps)` with `sources: Record<ShareKind, ShareSource>` (`worker/share/service.ts`); `buildMessage`, `toPlain`, `MAX_SHARE_ITEMS` (`src/shared/share/message.ts`); `MAX_SHARE_PEOPLE` (`src/shared/share/limits.ts`); `isWebUrl` (`src/shared/share/template.ts`); `ComposerInput`, `openComposer(input)`, `closeComposer()`, `shareView()`, `showChannels()`, `leaveChannels()` (`src/panel/share/state.ts`), `openChannels`, `Channels` (`src/panel/share/channels.tsx`), `Composer` (`src/panel/share/composer.tsx`); Task 5 `PipelinesService.approval`.
- Produces:

```ts
// src/shared/share/approval-items.ts
export const APPROVAL_TEMPLATE = 'Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}'
export const APPROVAL_VARS = ['pipeline', 'run', 'url', 'environment', 'stage', 'branch', 'requestedBy', 'project'] as const
export function approvalItemKey(key: { projectId: string; approvalId: string }): string      // `approval:${projectId}/${approvalId}`
export function parseApprovalItemKey(key: string): { projectId: string; approvalId: string } | null
export function approvalShareItem(run: RunSummary, approval: ApprovalSummary): ShareItem      // environment = environment ?? stage ?? ''
// src/shared/share/email.ts
export const MAX_MAIL_URL = 2000
export function mailtoUrl(input: { to: string[]; subject: string; body: string }): string | null   // null with no recipients or past the cap
// worker/pipelines/share-source.ts
export function approvalShareSource(pipelines: Pick<PipelinesService, 'approval'>, settings: Pick<PipelineSettings, 'approvalTemplate'>): ShareSource
// src/panel/share/state.ts (changed)
export type ShareHost = 'prs' | 'pipelines'
export interface ComposerInput { org: string; kind: ShareKind; host: ShareHost; title: string; items: ComposerItem[]; suggestions: Identity[]; reviewers: boolean; email: boolean; subject: string; fallback: string; vars: readonly string[] }
export function shareView(host: ShareHost): 'none' | 'composer' | 'channels'
// src/panel/share/channels.tsx (changed)
export function openChannels(host: ShareHost): void
```

**Rules:**
- The approval source reads each key with `pipelines.approval(org, key)` (never panel text), skips ones that are gone and returns `prs: []`.
- `mailtoUrl`: `mailto:` + addresses `encodeURIComponent`ed and comma-joined + `?subject=` + `&body=` (lone surrogates replaced, as `teamsChatUrl`). Users only; groups are never offered for email.
- **Composer** for approvals: "Share for approval" opens it with title "Share for approval", one checked item labelled `<pipeline> <runNumber> → <environment or stage>`, suggestions = the approval's user approvers, `reviewers: false`, `email: true`, subject `Approval needed: <pipeline> <runNumber>`.
- "Send to" gains `Checkbox` "Email" with a `PeoplePicker` (users only, label "Find people") when `input.email`.
- **Press order:** one external link per press (Plan 3 S2: a second open in one press is refused). Build the message; if chat is chosen open the Teams link, else if email is chosen open the `mailto:` link, before any await; then `share.send` with every chosen destination (chat and email included so they're remembered). The link not opened on this press shows in the results with a button, "Open Teams chat" or "Open email". Email results: "Opened an email draft.", "The email draft wasn't opened.", "Too long for an email link. Use Copy instead." (`mailto:` skips Orca's consent dialog, S2.)
- `shareView(host)` is `'composer'`/`'channels'` only for the host that opened it, so a composer opened from Pipelines never appears on the PRs tab, and Back from channels returns to that host.

- [ ] **Step 1: Write the failing tests.**
  - items: `the default approval template gives the reference-style line`: `Approval needed for production: [web-app-cd 20261105.3](https://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4520) on main` in HTML, plain and Markdown; `approvalItemKey round-trips`; `the environment falls back to the stage`.
  - email: `mailtoUrl encodes recipients, subject and body, and refuses past 2,000 characters or with nobody`.
  - service: `send shares an approval from the approval source by key`, `email destinations are remembered with their people and capped`, `prefs for approvals use the approval template and report its warning`.
  - settings: `approvalTemplate falls back to the default when empty or not a string`.
  - composer: `Share for approval opens the composer with the approval and its approvers`; `with chat and email chosen, the Teams link opens first and email waits for its own button`; `email alone opens the mailto link before share.send`; `a composer opened from Pipelines doesn't show on the PRs tab`; the Plan 3 composer tests stay green with `host: 'prs'`.
  - main: `share.send with kind approval copies the approval line` (fake clipboard).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, validate and check pass.
- [ ] **Step 5: Commit** "Share approvals by Teams, channel, email or copy".

### Task 12: Verification, README and live checks

- [ ] **Step 1: Run the full offline suite.** `orca plugin validate . --json`, `npm run typecheck`, `orca plugin test . --json` (`# fail 0`) and `orca plugin check . --json` all pass.
- [ ] **Step 2: Update the README.**
  - Move "Pipelines" to "Works now".
  - **Pipelines tab:** which runs show, what each filter means, watching, stage bar, approvals (who can approve, Approve/Reject), Share for approval and its destinations, the approval template and placeholders.
  - **Run tab:** where its file lives (`.orca-ado/`, git-ignored, pruned after 7 days), live log tail and its limits (a step's log appears when ADO publishes it), search, errors only, error summary, Open in Orca (no line argument; the line is shown), rerun and cancel.
  - **Notifications:** what notifies, the three toggles, the new `notifications:show` permission Orca asks for once.
  - **Polling:** the pipeline cadences and the pressure slow-down.
  - **Settings:** the four new keys. **PAT scopes:** add Build (Read & execute) (`vso.build_execute`) for runs, logs, rerun, cancel and approvals. Hedge it like the existing list.
  - Status bar: `ADO · N failed · N approvals · N to review`.
- [ ] **Step 3: Live checks with the user** (deferred until the user is present and the sandbox org exists; fill the pending rows of `docs/superpowers/spikes/2026-11-05-plan-4.md`):
  - (a) A multi-stage sandbox run: the tab follows stages and steps live; record whether a running step's log grows before the step ends and how `changeId` behaves.
  - (b) A failing Docker-style step and a failing Helm-style step: errors only, the error summary, Jump to line, Open in Orca on a file in the local workspace.
  - (c) Rerun the failed stage and cancel a run.
  - (d) An environment approval: Needs me, approvers and waiting time, environment name, Approve and Reject with a comment, a two-approver check.
  - (e) Share for approval to a Teams chat, the test channel, email and copy.
  - (f) Notifications for a failure, a watched run and an approval; what a click does.
  - (g) Read-only on the client org: `X-RateLimit-*` with the tab and a run tab open for 10 minutes; `requestedFor` results.
  - (h) The Pipelines tab at 360 px and the run tab in both themes; the status bar counts.
- [ ] **Step 4: Commit and report** which spikes were settled and which live rows remain.

---

## Pre-flight scan

Baseline `015ed0b`. "Fixed" means the plan text above already carries the fix.

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T0 → T2, T3, T5, T7, T12 | S1–S4 fixtures, constants and budget → tests that pin them; pending rows → T12 | OK: T0 writes the shared fixtures (`timeline-4520*`, approvals, check suite); T2/T3 add theirs. |
| T0 ↔ Plan 3 tail | Baseline re-check of cited signatures | **Risk, handled.** Plan 3's Task 11 review and final fix wave run in parallel; T0 Step 1 records drift before T1. |
| T1 → T2–T11 | `src/shared/pipelines.ts` types, `src/shared/runs.ts` rules | OK: types only plus pure rules; panel and frame import them. |
| T1 ↔ Plan 3 helpers | `orgWebUrl`, `branchName`, `MALFORMED`, R21 URL normalising → `toRunSummary` | OK: reused, not restated. |
| T1 → T4 | `runCounts`, `approvalsNeedingMe`, `isActive` → signals, notifier | OK: one copy of "needs me" and "failed" for list, count and notification. |
| T1 → T9, T10 | `STEP_GLYPH` → frame stage strip and steps, panel `stageLine` | Fixed in self-review: the frame and the panel each had a glyph table; one map now lives in `src/shared/runs.ts`. |
| T2 → T5, T6, T7 | `getTimeline`, `mergeTimeline`, `runStages`, `stageChips`, `failuresOf`, `approvalPlaceOf`, `listLogs`, `getLogLines` | OK. |
| T2 → T8, T9 | `fileRefOf` in `src/shared/file-ref.ts`; T8 adds `pathCandidates` to the same file | OK: one file and one test file; T2 creates both, T8 extends them. |
| T3 → T5, T6, T7 | `listPendingApprovals`, `getApprovals`, `toApprovalSummary`, `checkSuiteEnvironment`, `runIdOf` → load, actions, views; `retryStage`, `cancelBuild` → actions | OK. |
| T4 ↔ Plan 3 `status-bar.ts` | `CountKind` widened; text, tone, tooltip extended | OK: signatures unchanged; Plan 3's cases stay green (the review count still renders `N to review`). |
| T4 → T5 | `RunSignals`, `Notifier`, `PipelineSettings` → service deps and main wiring | **Ordering, fixed.** Signals come before the service so T5 wires real counts and notifications; no placeholder deps. |
| T4 ↔ manifest | `notifications:show` capability | **Approval change.** New fingerprint; Orca asks the user at the next dev load. Tests using explicit capability lists (`worker/main.test.ts` `CAPABILITIES`) add it where a notification is expected. |
| T5 ↔ Plan 3 `worker/prs/load.ts` | `cachedCodeProjects`, `CodeProjects` | **Conflict, fixed.** Pipelines would have imported from the PRs feature; both move to `worker/ado/code-projects.ts` and the PR service imports from there. |
| T5 ↔ Plan 3 `visibility-handler.ts` | `ui.visibility` router | OK: one registration; T5 adds `pipelines`, T7 adds `run`. |
| T5 ↔ Plan 3 tests | `fakeAdo()` (`on`, `hang`, `count`, never `clear`), `fakeClock`, `withWorker`, `ME` | OK: `fakePipelines()` layers routes on `fakeAdo()` like `fakePrs()`. |
| T5 → T6, T7, T8, T11 | `PipelinesService.me`, `cachedRun`, `isWatched`, `approval`, `registerPipelineHandlers` | OK: one per-feature registrar; each task adds its deps to `PipelineHandlerDeps`. |
| T5 → T7 | `Pressure` → run-view intervals | OK: one pressure instance per worker, shared. |
| T6 → T7 | `after` hook → `views.refreshNow` | OK: T6 wires the runs refresh; T7 adds the view refresh to the same callback in `main.ts`. |
| T7 ↔ Plan 2 `board-file.ts` | `.orca-ado` folder and `.gitignore` writes | **Conflict, fixed.** A copy for run files would duplicate the folder logic; both use `worker/tab-files.ts`, `board-file.test.ts` unedited. |
| T7 → T8 | `RunViews.view` → `runs.openFile` run lookup | OK. |
| T7 → T9 | `runs.open/view/log/viewChanged`, visibility `'run'` | OK. |
| T7 ↔ T9 manifest | `.adorun` files exist before the editor contribution | OK: until T9 they open as text; T9 adds `customEditors.run`. |
| T6, T7, T8 → T9 | `runs.decide/retryStage/cancel/openFile` → frame buttons | OK. |
| T5, T6, T7 → T10 | `runs.snapshot/refresh/watch/changed/decide/open` → panel | OK. |
| T10 ↔ Plan 3 `visibility.ts` | `surfaceVisibility(surface)` | OK: the union widens to `'pipelines'`. |
| T10 → T11 | `approval.tsx`, `pipelines-tab.tsx` → Share button and composer hosting | OK: T10 leaves the slot; T11 fills it. |
| T11 ↔ Plan 3 share module | `ShareKind`, `ShareDestination`, `ComposerInput`, `shareView()`, `openChannels()` | **Conflict, fixed.** With two tabs hosting the composer, a global `shareView()` would show it on both. `ComposerInput.host`, `shareView(host)` and `openChannels(host)` scope it; the PRs call sites pass `'prs'`. |
| T11 ↔ Plan 3 S2 | One `shell.openExternal` per press | **Conflict, fixed.** Chat and email in one press would refuse the second; the second link becomes its own button. |
| T11 ↔ Plan 3 R27 | `TEMPLATE_EMPTY_LINK` mentions pull requests | Fixed: made source-neutral, one assertion updated. |
| T4, T5, T6, T7, T8, T11 | `worker/messages.ts`, `src/protocol.ts`, `worker/main.ts`, `orca-plugin.json` | OK: distinct entries, edited in task order. |
| T12 ↔ all | README sections, spike record | OK. |

### Each task against itself

| Task | Tests ↔ code; created ↔ later touched | Finding |
|---|---|---|
| T0 | Commits only the spike record and fixtures; probes uncommitted | OK. |
| T1 | Every produced function has a test; `runStateOf` all branches | OK. |
| T2 | `approvalPlaceOf` (used by T5/T7) | OK: tested on the waiting fixture. |
| T3 | Fallback without `permissions` | OK: tested; it is a read. |
| T4 | Notifier, signals, settings, status bar each tested; manifest validated | OK. |
| T5 | `load.ts`, `pressure.ts`, `watched.ts`, `fake-pipelines.ts` created | OK: each has cases; the fake is exercised through service tests. |
| T6 | Every rule row has a case, including Review Focus 2 | OK. |
| T7 | Board-file refactor guarded by its unedited tests; Review Focus 4 and 5 | OK. |
| T8 | Review Focus 1 uses a real `mktemp` workspace with a symlink | OK. |
| T9 | DOM glue untested in Node; pure modules carry the logic; `plugin check` guards the editor | OK (Plan 2's board pattern). |
| T10 | Node budget asserted | OK. |
| T11 | Plan 3 composer tests updated only for the new `host`/`email`/`subject` fields | OK. |
| T12 | Verification only | OK. |
