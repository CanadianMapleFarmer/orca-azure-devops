# Plan 3: PRs and Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PRs tab that groups the user's pull requests into release sets and acts on a whole set (approve all, auto-complete all with saved options), a share composer that sends the reference-format lines to several destinations, a reusable `share` module, and a "to review" count on the status bar.

The **PRs tab** shows:
- the user's pull requests grouped into release sets, one row per PR (number, target branch, build and policy status, votes, auto-complete);
- per set: **Approve all**, **Auto-complete all**, **Share…**;
- a collapsed "To review" list with links.

The **share composer** builds one line per included PR from a template (default `[Pull Request {id}]({url}): {title}`), with an optional intro. It sends to any of: rich-text copy, Teams channels (Workflows webhooks), a Teams chat deep link, and ADO reviewers. Choices are remembered.

**Architecture:** This builds on Plans 1 and 2.
- **ADO layer.** New pure modules under `worker/ado/` for PR lists, single PRs, PR work items, votes, auto-complete, reviewers and people search. Each takes `AdoHttp` from `connections.http`. Policy evaluations and `mapLimit` move out of `pr-links.ts` into shared modules.
- **PRs service** (`worker/prs/`). It owns the PR caches, one polling job per connected org (full load while the PRs tab is visible, a review-count load in the background), release-set grouping, the group actions and the `prs.*` handlers. It posts `prs.changed` and feeds the status bar's "to review" count.
- **Share module.** Pure core in `src/shared/share/` (template, message, HTML/plain/Markdown renderers, Teams chat link), shared by worker and panel. Worker side in `worker/share/` (Teams channels in `orca.secrets`, webhook post, Adaptive Card, reviewers, `share.*` handlers) and `worker/sys/clipboard.ts` (OS clipboard). Panel side in `src/panel/share/` (composer, people picker, channel manager). Plan 4 reuses all three layers for pipeline approvals.
- **Status bar.** `worker/status-bar.ts` becomes a small aggregator of org states and per-org counts; Plan 4 adds its own count kinds.
- **Wiring.** As in Plan 2's final fix wave, each feature registers its own handlers (`registerPrHandlers` in `worker/prs/handlers.ts`, `registerShareHandlers` in `worker/share/handlers.ts`) and `worker/main.ts` only composes them. `ui.visibility`, shared by the Work, board and PRs surfaces, moves to one router.

**Baseline:** the checkout at `dec2c87` (Plan 2 with its final fix wave). Every path and signature cited below was read at that commit.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`), the Orca components runtime, `orca/testing`, ADO REST `api-version=7.1` (policy evaluations `7.1-preview.1`, Graph subject query `7.1-preview.1`), Teams Workflows webhooks (Adaptive Card 1.4), Teams chat deep links, `osascript`/PowerShell/`wl-copy`/`xclip`.

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md` (§3 reference workflow, §4.1, §4.2, §4.4, §4.5, §5.1, §5.3 share reuse, §5.4, §5.8, §6, §7). **Plans 1 and 2** (merged): `docs/superpowers/plans/2026-11-03-plan-1-foundation.md`, `docs/superpowers/plans/2026-11-04-plan-2-boards.md`, with their rulings in `docs/superpowers/plans/2026-11-03-plan-1-foundation.rulings.md` and `.superpowers/sdd/2026-11-04-plan-2-boards/progress.md`.

## Global Constraints

Everything in Plans 1 and 2's Global Constraints still binds: credentials, the generic rule, repo hygiene, zero code comments, never approving on the user's behalf, never running `orca plugin dev load|watch|reload`, `enable` or `--approve`. Additions:

- **No new capabilities.** `shell.openExternal` needs none; `secrets:own` and `settings:own` exist. Users are not re-prompted.
- **ADO endpoints** (base `https://dev.azure.com/{org}`, `api-version=7.1` unless stated; `{project}` is the project id):
  - repositories (org-wide): `GET /_apis/git/repositories`
  - my PRs: `GET /{project}/_apis/git/pullrequests?searchCriteria.creatorId={me}&searchCriteria.status=active&$top=100`
  - my recently completed PRs: `GET /{project}/_apis/git/pullrequests?searchCriteria.creatorId={me}&searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime={ISO now−14 d}&$top=50`
  - to review: `GET /{project}/_apis/git/pullrequests?searchCriteria.reviewerId={me}&searchCriteria.status=active&$top=100`
  - one PR: `GET /{project}/_apis/git/repositories/{repoId}/pullrequests/{prId}`
  - PR work items: `GET /{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/workitems`
  - policy evaluations (existing): `GET /{project}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` at `7.1-preview.1`
  - vote: `PUT /{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{me}` body `{ vote: 10, isRequired }`
  - reviewers: `GET …/pullRequests/{prId}/reviewers`; add one: `PUT …/pullRequests/{prId}/reviewers/{id}` body `{ vote: 0, isRequired }`
  - auto-complete: `PATCH /{project}/_apis/git/repositories/{repoId}/pullrequests/{prId}` body `{ autoCompleteSetBy: { id: me }, completionOptions: { mergeStrategy, deleteSourceBranch, transitionWorkItems, bypassPolicy: false } }`
  - people (base `https://vssps.dev.azure.com/{org}`): `POST /_apis/graph/subjectquery` at `7.1-preview.1` body `{ query, subjectKind: ['User', 'Group'] }`, then `GET /_apis/identities?subjectDescriptors={csv}&queryMembership=None`
  - `{me}` is the pinned account's `adoId` (`connectionData.authenticatedUser.id`), never a profile id.
- **Teams.**
  - Webhook POST body: `{ "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": null, "content": <card> }] }`. A 2xx means **accepted**; copy says "sent (accepted)", never "delivered".
  - Chat link: `https://teams.microsoft.com/l/chat/0/0?users=<UPN,UPN>&message=<plain text>` plus `&tenantId=<tid>` when the pinned account has one. Plain text only, https only (no `msteams://`).
- **Secrets.** A webhook URL lives only in `orca.secrets` under `teams-webhook:<channelId>`. It is write-only from the panel: no handler returns it, and it never appears in `orca.log`, `orca.storage`, posts, panel atoms that persist, thrown messages or test output.
- **Nothing about a process is hard-coded.** Branch names, repos, projects, merge types and Teams destinations come from ADO or settings. Fixtures use `contoso`, `Fabrikam Web`, repos `web-app`/`api`, branches `develop`/`qa`/`main`.
- **Polling budget** (settled by Spike S3, pinned by Task 5's tests):
  - PRs tab visible: a full load every 60 s (my active PRs + to review, per code project).
  - Background: every 5 min, the to-review list only (one call per code project).
  - Completed PRs: 5 min cache. PR work items: 10 min (completed PRs 1 h). Policy evaluations: active PRs only, 2 min. Repositories: 1 h.
  - At most 4 requests in flight per org. `rate_limited` pauses through the scheduler. A `forbidden` list pauses PR loads for that org for 10 min.
- **Size caps.** A posted `PrSnapshot` stays under 240 KiB (≤ 50 sets, ≤ 100 to-review PRs, else trimmed with a message). The panel renders ≤ 30 sets and ≤ 50 to-review rows. A share has ≤ 50 items, an intro ≤ 2,000 characters, a card ≤ 26,000 bytes of JSON and a chat link ≤ 2,000 characters.
- **Settings added** (all in `contributes.settings`):
  - `autoCompleteMergeStrategy`: string, `enum ["noFastForward","squash","rebase","rebaseMerge"]`, `enumLabels ["Merge (no fast-forward)","Squash commit","Rebase and fast-forward","Semi-linear merge"]`, default `"noFastForward"`, title "Auto-complete merge type".
  - `autoCompleteDeleteSourceBranch`: boolean, default `false`, title "Auto-complete: delete the source branch".
  - `autoCompleteTransitionWorkItems`: boolean, default `false`, title "Auto-complete: complete linked work items".
  - `shareTemplate`: string, default `"[Pull Request {id}]({url}): {title}"`, title "Pull request share line", description "One line per pull request. [text]({url}) is the link. Also {repo}, {project}, {source}, {target}, {author}."
- **Errors reach the UI as messages only.** Orca maps thrown codes to `action_failed`; the panel shows `messageOf(error)` and never branches on codes.
- **One copy of each worker message and helper** (Plan 2 fix wave, `f126388`):
  - Every user-facing string the worker throws, returns or logs lives in `worker/messages.ts`, as a constant or a small function; tasks add theirs there. Existing ones to reuse: `NOT_CONNECTED`, `SETTINGS_READ_FAILED`, `MALFORMED.pullRequest`, `joinMessages`, `badRequest(message)`, `failureMessage(error)`.
  - ADO hosts come only from `worker/ado/org.ts`: `orgWebUrl(org)` (`https://dev.azure.com/<org>`), plus `orgVsspsUrl(org)` added by Task 2.
  - `refs/heads/` is stripped only by `branchName(ref)` (`worker/ado/pr-links.ts`).
  - Post-size math uses one `byteLength` (moved to `worker/budget.ts` by Task 5).
- **Polling jobs pass their `AbortSignal` down** through `withSignal(http, signal)` (`worker/ado/http.ts`), so a removed or disposed job aborts its requests.
- **Worker tests that mount the worker use `withWorker(module, options, run)`** (`worker/test-support.ts`), which always deactivates.
- **No recurring timers** outside the scheduler. A one-shot timeout for a single request or child process is fine.

## Review Focus

1. **A release set whose PRs share one source branch, with "delete the source branch" on.** The first PR to merge must not delete the branch the other PRs still need. While another active PR uses the same repo and source branch, auto-complete sends `deleteSourceBranch: false` for it and says so. *Test: Task 6, `autoCompleteAll keeps the source branch while another active PR uses it`.*
2. **One PR in a set fails or doesn't apply** (a draft, a completed PR, a 403, a policy refusal, already approved). Each row reports its own result; the others still go through; no row claims success it didn't get. *Test: Task 6, `approveAll reports per-row results and continues past a failure`.*
3. **A webhook URL that is wrong, rotated or deleted** (404, 400, 429, DNS failure, timeout). The result is a fixed message; the URL and its `sig` never appear in results, thrown messages, logs, posts or storage. *Test: Task 9, `webhook failures never mention the URL`.*
4. **PR titles with markup** (`[PROJ-55283]`, `<script>`, `](javascript:alert(1))`, `&`, emoji, 400 characters). The reference line is exact in HTML, plain text, Markdown and the card; a title can never add a link or a tag. *Test: Task 7, `titles can never add links or markup`.*
5. **Adding a reviewer who is already on the PR, possibly with a vote.** A PUT with `vote: 0` would reset their vote. Existing reviewers are skipped with a note, from a fresh reviewers read. *Test: Task 9, `adding an existing reviewer never resets their vote`.*

---

## File map

| File | Responsibility |
|------|----------------|
| `src/shared/prs.ts` | PR, release-set and snapshot types shared by worker and panel |
| `src/shared/types.ts` (modify) | `Identity` |
| `worker/ado/pullrequests.ts` | PR lists, one PR, PR work items, code-project resolution, `toPrSummary` |
| `worker/ado/policy.ts`, `worker/ado/limit.ts` | Policy evaluations and `mapLimit`, moved out of `pr-links.ts` |
| `worker/ado/pr-actions.ts` | Vote, auto-complete, reviewers |
| `worker/ado/identities.ts` | People and group search (Graph + identities) |
| `worker/ado/http.ts`, `worker/ado/org.ts` (modify) | `host: 'vssps'`; `orgVsspsUrl` |
| `worker/messages.ts` (modify) | Every new worker message |
| `worker/budget.ts` | `byteLength` and `newestThatFit`, moved out of `worker/boards/snapshot.ts` |
| `worker/visibility-handler.ts` | `ui.visibility` router (moved out of `worker/boards/handlers.ts`) |
| `worker/prs/release-sets.ts` | Pure grouping into release sets; to-review filter |
| `worker/prs/load.ts` | Per-org PR source: fan-out, caches, enrichment |
| `worker/prs/service.ts`, `worker/prs/actions.ts`, `worker/prs/settings.ts`, `worker/prs/handlers.ts` | Polling, snapshots, counts; group actions; settings; `prs.*` handlers |
| `worker/prs/fake-prs.ts` | Test fake: `fakeAdo()` plus PR routes |
| `worker/status-bar.ts` (modify) | Org states + per-org counts → one status bar item |
| `src/shared/share/*.ts` | Share types, template, message renderers, Teams chat link, PR share items |
| `worker/sys/clipboard.ts` | Rich clipboard per OS |
| `worker/share/channels.ts`, `webhook.ts`, `card.ts`, `destinations.ts`, `service.ts`, `handlers.ts` | Teams channels, webhook post, Adaptive Card, the destination registry, `share.*` handlers |
| `src/panel/prs/*.tsx` | PRs tab |
| `src/panel/share/*.tsx` | Composer, people picker, channel manager |

## Shared types

`src/shared/prs.ts` (Task 1):

```ts
export interface PrKey { projectId: string; repoId: string; prId: number }   // same shape as workitems.ts PrRef
export interface PrReviewer { id: string; name: string; uniqueName: string; vote: number; isRequired: boolean; isGroup: boolean; hasDeclined: boolean }
export interface PrChecks { build: 'none' | 'running' | 'succeeded' | 'failed'; policies: 'none' | 'pending' | 'approved' | 'rejected' }
export interface PrSummary extends PrKey {
  org: string; projectName: string; repoName: string
  title: string; url: string; source: string; target: string            // refs/heads/ stripped
  status: 'active' | 'completed' | 'abandoned'; isDraft: boolean
  mergeStatus: 'ok' | 'pending' | 'conflicts' | 'failed'
  createdBy: { id: string; name: string }; createdAt: number; closedAt: number | null
  reviewers: PrReviewer[]; autoComplete: boolean
  workItemIds: number[]; checks: PrChecks | null                         // filled by the PR source; null when not loaded
}
export type MergeStrategy = 'noFastForward' | 'squash' | 'rebase' | 'rebaseMerge'
export interface AutoCompleteOptions { mergeStrategy: MergeStrategy; deleteSourceBranch: boolean; transitionWorkItems: boolean }
export interface ReleaseSet { key: string; title: string; sources: string[]; workItemIds: number[]; prs: PrSummary[] }
export interface PrSnapshot {
  org: string; me: string | null; sets: ReleaseSet[]; toReview: PrSummary[]; toReviewCount: number
  autoComplete: AutoCompleteOptions; updatedAt: number; stale: boolean; message?: string
}
export interface RowResult { prId: number; ok: boolean; message: string }
```

`src/shared/types.ts` (Task 2): `export interface Identity { id: string; displayName: string; uniqueName: string; kind: 'user' | 'group' }`.

`src/shared/share/types.ts` (Task 7):

```ts
export type ShareKind = 'pr'                                              // Plan 4 adds 'approval'
export interface Segment { text: string; href?: string }
export interface ShareItem { key: string; vars: Record<string, string> }
export interface ShareMessage { intro: string; lines: Segment[][] }
export interface Channel { id: string; name: string; service: 'teams'; addedAt: number }          // a later Slack or generic webhook adds a service
export type Person = Identity & { required: boolean }
export type ShareDestination =                                            // the pluggable list (spec §5.4); Plan 4 adds { kind: 'email'; people: Identity[] }
  | { kind: 'copy' }
  | { kind: 'channel'; id: string }
  | { kind: 'chat'; people: Identity[] }                                  // opened by the panel; the worker only remembers it
  | { kind: 'reviewers'; people: Person[] }
export interface SharePrefs { destinations: ShareDestination[] }          // remembered per org, people included
export interface SharePrefsView { template: string; warning?: string; channels: Channel[]; prefs: SharePrefs; tenantId: string | null }
export interface ShareRequest { org: string; kind: ShareKind; keys: string[]; intro: string; destinations: ShareDestination[] }
export interface ShareResult { destination: string; ok: boolean; text: string; plain?: string }   // destination: 'copy' | 'chat' | 'reviewers' | `channel:${id}`
```

Protocol additions in `src/protocol.ts` (each task adds the entries it registers):

```ts
'prs.snapshot': { input: { org: string }; output: PrSnapshot }                              // Task 5
'prs.refresh': { input: { org: string }; output: PrSnapshot }                               // Task 5
'prs.approve': { input: { org: string; prs: PrKey[] }; output: { results: RowResult[] } }   // Task 6
'prs.autoComplete': { input: { org: string; prs: PrKey[] }; output: { results: RowResult[] } } // Task 6
'share.prefs': { input: { org: string; kind: ShareKind }; output: SharePrefsView }          // Task 9
'share.send': { input: ShareRequest; output: { results: ShareResult[] } }                   // Task 9
'share.people': { input: { org: string; query: string; groups: boolean }; output: Identity[] } // Task 9
'share.channels': { input: {}; output: Channel[] }                                          // Task 9
'share.addChannel': { input: { name: string; url: string }; output: Channel }              // Task 9
'share.replaceChannel': { input: { id: string; url: string }; output: Channel }            // Task 9
'share.removeChannel': { input: { id: string }; output: { ok: true } }                      // Task 9
'share.testChannel': { input: { id: string }; output: ShareResult }                         // Task 9
// 'ui.visibility' input.surface widens to 'work' | 'board' | 'prs'                         // Task 5
// PluginPanelEvents
'prs.changed': PrSnapshot                                                                   // Task 5
```

---

### Task 0: Spikes (offline halves)

**Files:**
- Create: `docs/superpowers/spikes/2026-11-05-plan-3.md` (the spike record: one table per spike, each row "question · method · result · decision", with the live rows marked **pending live** for Task 12).

**Why:** Spec §7 and the roadmap name three unknowns for this plan. Their offline halves are settled here, before code depends on them. Throwaway probes are not committed.

- [ ] **Step 1: S1 rich clipboard, offline.**
  - (a) Confirm there is no clipboard method: `for f in .orca/types/*/index.d.ts; do rtk proxy grep -ci clipboard "$f"; done`. Expected: 0 for every file (checked on 1.4.248).
  - (b) Read the installed Orca's worker environment allowlist: a `python3 -I - <<'EOF'` script that loads `/Applications/Orca.app/Contents/Resources/app.asar`, finds the bytes `` `SYSTEMROOT` `` inside the array passed to the plugin worker's `fork(…, { env: … })` (1.4.248: the array before `function QJr(`), and prints 300 bytes around it. Expected (1.4.248): `PATH, HOME, USERPROFILE, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR, TEMP, TMP, SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC, PATHEXT, PROCESSOR_ARCHITECTURE, NUMBER_OF_PROCESSORS`, with no `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. Record that Linux must derive its display environment (Task 8).
  - (c) On this Mac, save the clipboard's plain text, then write HTML and plain text through JXA under the worker's environment: `env -i PATH=/usr/bin:/bin HOME="$HOME" TMPDIR="$TMPDIR" osascript -l JavaScript -e '<script>'` with the content on stdin, where the script sets `public.html` and `public.utf8-plain-text` on `$.NSPasteboard.generalPasteboard` after `clearContents`. Check `osascript -e 'clipboard info'` lists `«class HTML»` and `«class utf8»`. Restore the saved plain text. Expected: both types present.
  - Decision to record: the worker shells out per OS (Task 8); the isolated-frame `navigator.clipboard` route is not used because the composer lives in a components panel, which has no DOM.
- [ ] **Step 2: S2 deep link, offline.**
  - (a) A throwaway components test: a `Button` whose `onPress` awaits a mocked `plugin.request`, then calls `shell.openExternal`. Record whether `mockHost` refuses it (`panel.refusals`). The design calls `openExternal` before any await either way.
  - (b) Record from the recon: `shell.openExternal` is panel-only, needs a press on a control settled for about 500 ms, allows 3 calls per 10 s, asks once per new host, and accepts only http/https/mailto. Decision: one chat link per press, built synchronously in the panel, opened before the worker request; on refusal the results offer a separate "Open Teams chat" button so channel posts are never repeated.
- [ ] **Step 3: S3 PR fan-out, offline.** Write the call budget as formulas for P code projects and N active PRs of mine:
  - visible full load: `2P` lists every 60 s, plus `P` completed lists per 5 min, `N` work-item reads per 10 min, `N` evaluation reads per 2 min, 1 repositories call per hour;
  - background: `P` lists per 5 min.
  Task 5's test pins these counts for P = 2.
- [ ] **Step 4: List the live halves as pending rows:** clipboard paste into Teams/Outlook/Slack per OS; chat link landing (desktop vs browser page), prefill with newlines, tenantId account choice, consent frequency, length limit; card `TextRun` links clickable in Teams; `X-RateLimit-*` headroom after a visible refresh; whether `searchCriteria.reviewerId` also returns PRs assigned to the user's groups; whether org-wide `GET /_apis/git/repositories` works.
- [ ] **Step 5: Commit** "Record the Plan 3 spikes".

### Task 1: PR read layer

**Files:**
- Create: `src/shared/prs.ts` (types above), `worker/ado/pullrequests.ts`, `worker/ado/policy.ts`, `worker/ado/limit.ts`.
- Modify: `worker/ado/pr-links.ts`. Only the private `fetchEvaluations`, `buildState`, `isBuildPolicy`, `stateOf`, `BUILD_POLICY_TYPE`, `BUILD_SEVERITY` and `mapLimit` move out; it then imports `loadEvaluations`, `buildStateOf` and `mapLimit`. The chip cache stays exactly as the fix wave left it (`48cd10b`): `PrChipCache`, `ttlOf` with 2 min for open chips and `TERMINAL_TTL_MS` 1 h for merged or abandoned ones, 404s cached as `chip: null`, `MAX_CONCURRENT` 6, `fetchPullRequest`, `pullRequestWebUrl`, `HEADS_PREFIX` and `branchName`. `loadPrChips`' signature and caching are unchanged; the PR service keeps its own caches and never shares `PrChipCache`.
- Create fixtures in `worker/ado/fixtures/`: `pull-requests-mine.json` (three active PRs from `feature/1204-vehicle-search` in `web-app` into `develop`, `qa`, `main`; one active PR from `bugfix/1205-pagination-offset` in `api` linked to the same work item; one draft), `pull-requests-completed.json`, `pull-requests-review.json`, `pull-request-workitems.json`, `repositories.json`. Shape them like the real API (`value`, `count`, `repository.project`, `reviewers[]`, `autoCompleteSetBy`, `creationDate`, `closedDate`).
- Test: `worker/ado/pullrequests.test.ts`, `worker/ado/policy.test.ts`; all 21 `worker/ado/pr-links.test.ts` cases stay green unedited, including `loadPrChips caches a merged or abandoned pull request for an hour` and `loadPrChips runs at most six pull request lookups at once`.

**Interfaces:**
- Consumes (at `dec2c87`): `AdoHttp.json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }>` and `AdoError(code, status, message, retryAfterMs?)` (`worker/ado/http.ts`); `expectText`, `expectList`, `malformed`, `shaped` (`worker/ado/shape.ts`); `listProjects(http, org): Promise<NamedItem[]>` (`worker/ado/core.ts`); `orgWebUrl(org: string): string` (`worker/ado/org.ts`); `branchName(ref: string): string` (`worker/ado/pr-links.ts`); `MALFORMED.pullRequest` (`worker/messages.ts`); `OrgStatus['codeProjects']` = `'all' | { id: string; name: string }[]`.
- Produces:

```ts
// worker/ado/limit.ts
export function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]>
// worker/ado/policy.ts
export interface RawEvaluation { status: string; configuration?: { isBlocking?: boolean; isEnabled?: boolean; type?: { displayName?: string }; settings?: { buildDefinitionId?: unknown } } }
export function loadEvaluations(http: AdoHttp, org: string, key: PrKey): Promise<RawEvaluation[]>
export function buildStateOf(evaluations: RawEvaluation[]): PrChecks['build']
export function policyStateOf(evaluations: RawEvaluation[]): PrChecks['policies']   // non-build, blocking, enabled; notApplicable ignored; rejected > pending (queued/running) > approved; none when empty
// worker/ado/pullrequests.ts
export interface RawReviewer { id: string; displayName: string; uniqueName?: string; vote?: number; isRequired?: boolean; isContainer?: boolean; hasDeclined?: boolean }
export interface RawPullRequest { pullRequestId: number; status: string; title: string; sourceRefName: string; targetRefName: string; isDraft?: boolean; mergeStatus?: string; createdBy: { id: string; displayName: string }; creationDate: string; closedDate?: string; repository: { id: string; name: string; webUrl?: string; project: { id: string; name: string } }; reviewers?: RawReviewer[]; autoCompleteSetBy?: { id: string } }
export function toReviewer(raw: RawReviewer): PrReviewer
export interface PrCriteria { creatorId?: string; reviewerId?: string; status: 'active' | 'completed'; closedSince?: number; top: number }
export function listPullRequests(http: AdoHttp, org: string, projectId: string, criteria: PrCriteria, signal?: AbortSignal): Promise<RawPullRequest[]>
export function getPullRequest(http: AdoHttp, org: string, key: PrKey): Promise<RawPullRequest>
export function pullRequestWorkItems(http: AdoHttp, org: string, key: PrKey): Promise<number[]>
export function codeProjects(http: AdoHttp, org: string, setting: OrgStatus['codeProjects']): Promise<{ id: string; name: string }[]>
export function toPrSummary(raw: RawPullRequest, org: string): PrSummary   // workItemIds [], checks null
```

**Behaviour:**
- `source` and `target` go through `branchName`.
- `mergeStatus`: `succeeded` → ok, `conflicts` → conflicts, `failure`/`rejectedByPolicy` → failed, anything else → pending.
- `url` is `repository.webUrl + '/pullrequest/' + id` when `webUrl` is present, else `${orgWebUrl(org)}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`.
- `reviewers[].isContainer` → `isGroup`; a missing `vote` is 0.
- `codeProjects('all')` reads the org-wide repositories list once and returns the distinct projects that hold a repository, sorted by name. When that call answers `not_found` or `bad_request`, it falls back to `listProjects`. A list setting is returned as given.
- PR work item ids arrive as strings (`value[].id`); non-numeric ids are dropped.
- Malformed responses go through `shaped(build, MALFORMED.pullRequest)`.

- [ ] **Step 1: Write the failing tests.**
  - `toPrSummary maps status, branches, reviewers, merge status and auto-complete` (fixture: `source` = `feature/1204-vehicle-search`, `target` = `develop`, `autoComplete` true when `autoCompleteSetBy` is set, a group reviewer has `isGroup` true).
  - `toPrSummary builds the web URL from names when webUrl is missing`: `https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4101`.
  - `listPullRequests sends the search criteria`: the active call's query has `searchCriteria.creatorId=u1`, `searchCriteria.status=active`, `$top=100`; the completed call adds `searchCriteria.queryTimeRangeType=closed` and `searchCriteria.minTime` equal to the ISO string of `closedSince`.
  - `getPullRequest reads one PR through its repository path`: `/{project}/_apis/git/repositories/{repoId}/pullrequests/{prId}`.
  - `pullRequestWorkItems returns numeric ids`.
  - `codeProjects lists projects that hold repositories and falls back to every project when the org-wide list is refused`.
  - `policyStateOf: rejected wins, then pending, then approved; non-blocking, disabled and notApplicable are ignored`.
  - `buildStateOf keeps pr-links' worst-build rule` (the moved logic, same cases as before).
  - `malformed responses become the fixed error`.
- [ ] **Step 2: Run.** `orca plugin test . --json`. Expected: the new tests FAIL (modules missing); existing tests pass.
- [ ] **Step 3: Implement.** Move the evaluation fetch, build severity and `mapLimit` out of `pr-links.ts`; its exports and its chip TTLs stay as they are.
- [ ] **Step 4: Run.** Expected: PASS, including the 21 `pr-links.test.ts` cases unedited. `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Read pull requests and policy status".

### Task 2: PR write layer and people search

**Files:**
- Modify:
  - `worker/ado/org.ts`: add `orgVsspsUrl`; `discoverTenant` uses it instead of its inline `https://vssps.dev.azure.com/${org}`.
  - `worker/ado/http.ts`: `AdoRequest.host?: 'vssps'`; `buildUrl` picks `orgVsspsUrl(req.org)` for it, else today's `orgWebUrl(req.org)`.
  - `worker/messages.ts`: add `FIND_PEOPLE_NEEDS_ACCESS` and `MALFORMED.identity` ("Azure DevOps returned an unexpected identity response.").
  - `src/shared/types.ts`: `Identity`.
- Create: `worker/ado/pr-actions.ts`, `worker/ado/identities.ts`, fixtures `subject-query.json`, `identities.json`, `pull-request-reviewers.json`.
- Test: `worker/ado/org.test.ts` and `worker/ado/http.test.ts` (one case each), `worker/ado/pr-actions.test.ts`, `worker/ado/identities.test.ts`.

**Interfaces:**
- Consumes: Task 1's `PrKey`, `PrReviewer`, `AutoCompleteOptions`, `toReviewer`; `AdoHttp`, `AdoRequest` (`worker/ado/http.ts`); `orgWebUrl` (`worker/ado/org.ts`); `MALFORMED` (`worker/messages.ts`).
- Produces:

```ts
// worker/ado/org.ts
export function orgVsspsUrl(org: string): string     // `https://vssps.dev.azure.com/${encodeURIComponent(org)}`
// worker/ado/pr-actions.ts
export function castVote(http: AdoHttp, org: string, key: PrKey, me: string, isRequired: boolean): Promise<void>        // vote 10
export function setAutoComplete(http: AdoHttp, org: string, key: PrKey, me: string, options: AutoCompleteOptions): Promise<void>
export function listReviewers(http: AdoHttp, org: string, key: PrKey): Promise<PrReviewer[]>
export function addReviewer(http: AdoHttp, org: string, key: PrKey, id: string, isRequired: boolean): Promise<void>   // vote 0; callers skip existing reviewers
// worker/ado/identities.ts
export function searchIdentities(http: AdoHttp, org: string, query: string, groups: boolean): Promise<Identity[]>
```

**Behaviour:**
- `searchIdentities` trims the query and returns `[]` under 2 characters. It runs the subject query (`subjectKind` `['User']`, plus `'Group'` when `groups`), keeps the first 20 subjects, then resolves their descriptors to ids with one identities call. Subjects without an id are dropped. `uniqueName` is `principalName`, else `mailAddress`.
- A `forbidden` from either call becomes `AdoError('forbidden', 403, FIND_PEOPLE_NEEDS_ACCESS)`, where `FIND_PEOPLE_NEEDS_ACCESS` = "Finding people needs Graph (Read) and Identity (Read) access." Malformed answers go through `shaped(build, MALFORMED.identity)`.
- `setAutoComplete` always sends `bypassPolicy: false` and never a `mergeCommitMessage`.
- `listReviewers` maps with `toReviewer` and malformed answers use `MALFORMED.pullRequest`.

- [ ] **Step 1: Write the failing tests.**
  - `host vssps builds the vssps URL`: `https://vssps.dev.azure.com/contoso/_apis/graph/subjectquery?api-version=7.1-preview.1`; a request without `host` still builds `https://dev.azure.com/contoso/…`.
  - `discoverTenant asks the vssps host from orgVsspsUrl` (the existing discovery tests stay green).
  - `castVote puts vote 10 on my reviewer entry and keeps the required flag`: path `…/pullRequests/4101/reviewers/u1`, body `{ vote: 10, isRequired: true }`.
  - `setAutoComplete sends the options and me`: exact body.
  - `addReviewer puts vote 0 and the required flag`.
  - `listReviewers maps groups and votes`.
  - `searchIdentities queries subjects, resolves ids and skips short queries`: users only when `groups` is false; no call for `'a'`.
  - `a forbidden search gives the access message`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Vote, set auto-complete, add reviewers and find people".

### Task 3: Release sets

**Files:**
- Create: `worker/prs/release-sets.ts`.
- Test: `worker/prs/release-sets.test.ts`.

**Interfaces:**
- Consumes: `PrSummary`, `ReleaseSet` (Task 1).
- Produces:

```ts
export const COMPLETED_WINDOW_MS = 14 * 24 * 60 * 60_000
export function releaseSets(prs: PrSummary[], now: number): ReleaseSet[]
export function toReviewOf(prs: PrSummary[], me: string): PrSummary[]
```

**Rules** (spec §6: "PRs with the same source branch, or sharing a linked work item, form one set"):
- Inputs are the user's own PRs. Abandoned PRs and PRs completed before `now − COMPLETED_WINDOW_MS` are ignored.
- Two PRs are in one set when they share `repoId` + `source`, or share any `workItemIds` entry; the relation is transitive (union-find).
- A set without an active PR is dropped.
- `prs` are ordered by `prId` ascending. `key` is `${org}:${lowest prId}`. `title` is the lowest PR's title. `sources` lists distinct source branches in PR order; `workItemIds` is the sorted union.
- Sets are ordered by their newest `createdAt`, newest first.
- `toReviewOf` keeps active, non-draft PRs not created by `me` where `me` is a reviewer with `vote === 0` and `hasDeclined === false`, newest first.

- [ ] **Step 1: Write the failing tests.**
  - `PRs from one source branch form one set, one row per target, ordered by id`.
  - `a shared linked work item joins PRs across repos and branches`.
  - `completed PRs join their set only within 14 days, and a set with no active PR is dropped`.
  - `abandoned PRs never appear`.
  - `the set key stays the same when a later PR joins`.
  - `title is the lowest PR's title and sources lists distinct branches`.
  - `sets are ordered newest first`.
  - `toReviewOf skips drafts, my own PRs, PRs I voted on and PRs I declined`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Group pull requests into release sets".

### Task 4: Status bar counts

**Files:**
- Modify: `worker/status-bar.ts`, `worker/main.ts` (at `dec2c87` it still holds `showStatus` and registers the `status` command itself; replace `showStatus` with the aggregator and pass the counts to `statusText`).
- Test: `worker/status-bar.test.ts` (existing cases stay green), `worker/main.test.ts` (one case).

**Interfaces:**
- Consumes: today's `statusBarFor(orgs: OrgStatus[]): StatusBarState` and `statusText(orgs: OrgStatus[]): string`; `StatusBarState { text; tone; tooltip }`.
- Produces:

```ts
export type CountKind = 'toReview'                                   // Plan 4 adds 'failedRuns' | 'approvals'
export type OrgCounts = ReadonlyMap<string, Partial<Record<CountKind, number>>>
export interface StatusBarState { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip: string }
export function statusBarFor(orgs: OrgStatus[], counts?: OrgCounts): StatusBarState
export function statusText(orgs: OrgStatus[], counts?: OrgCounts): string
export interface StatusBar { setOrgs(orgs: OrgStatus[]): void; setCount(org: string, kind: CountKind, count: number | null): void; counts(): OrgCounts }
export function createStatusBar(update: (state: StatusBarState) => void): StatusBar
```

**How it composes with the existing item:** there is still one item, `id: "status"`. Its connection text and tone are unchanged. Counts only come from orgs whose state is `connected`; others are ignored.
- Text: `ADO` with no counts; `ADO · <n> to review` when the summed count is above 0.
- Tone: the worst of the connection tone and the count tone, in the order `danger > warning > accent > success > neutral`. A to-review count is `accent`.
- Tooltip: today's lines, then `<n> pull requests to review: contoso 2, fabrikam 1` (orgs with 0 left out).
- `statusText` adds the same review line.
- `createStatusBar` recomputes on `setOrgs`/`setCount`, and calls `update` only when the state's JSON changed. `setCount(org, kind, null)` clears it. `setOrgs` drops counts of orgs that are gone.
- `main.ts`: `const bar = createStatusBar(state => void orca.host.call('statusBar.update', { id: 'status', ...state }).catch(() => {}))`; the connections `post` calls `bar.setOrgs(orgs)`; activate ends with `bar.setOrgs(orgs)`.

- [ ] **Step 1: Write the failing tests.**
  - `a to-review count shows in the text and tooltip and lifts the tone to accent`.
  - `danger and warning connection tones win over the count`.
  - `counts of orgs that aren't connected are ignored, and an org that is gone loses its count`.
  - `createStatusBar calls update only when the state changes, and null clears a count`.
  - `statusText adds the review line`.
  - main, inside `withWorker(worker, { host }, async w => …)`: `the status bar item still follows org changes` (today's behaviour through the aggregator; assert on `host.callsOf('statusBar.update')`). Task 5 adds the end-to-end count case.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Show review counts on the status bar".

### Task 5: PRs service, polling and handlers

**Files:**
- Create: `worker/prs/load.ts`, `worker/prs/service.ts`, `worker/prs/handlers.ts`, `worker/prs/settings.ts`, `worker/budget.ts`, `worker/visibility-handler.ts`, `worker/prs/fake-prs.ts`. The fake is `fakePrs()`: it calls `fakeAdo()` from `worker/boards/fake-ado.ts` and installs the PR routes (Task 1–2 fixtures) with its `on(match, respond)`. It returns the same object, so `calls`, `count`, `hold`, `hang` and the recorded `signal` all work, and one fetch serves both boards and PRs in `main.test.ts`. Never call its `clear()`.
- Modify:
  - `orca-plugin.json`: the three `autoComplete*` settings.
  - `src/protocol.ts`: `prs.snapshot`, `prs.refresh`, `prs.changed`; `ui.visibility` surface `'work' | 'board' | 'prs'`.
  - `worker/messages.ts`: `PRS_TRIMMED` "Showing the newest pull requests only.", `PRS_NEED_CODE_READ` "Pull requests need Code (Read) access.", `PRS_LOAD_FAILED` "Couldn't load pull requests."; `failureMessage(error, fallback = LOAD_FAILED)` gains the optional fallback.
  - `worker/boards/snapshot.ts`: import `byteLength` and `newestThatFit` from `worker/budget.ts` (`capSnapshot` and `capBoard` behave the same).
  - `worker/boards/handlers.ts`: drop its `ui.visibility` line.
  - `worker/main.ts`: settings watcher, the service, `prs.onOrgs` in the connections `post`, `registerPrHandlers`, `registerVisibilityHandler`.
  - `worker/test-support.ts`: gains `fakeClock()`, moved from the copies in `worker/poll/scheduler.test.ts` and `worker/boards/service.test.ts`, which now import it.
- Test: `worker/prs/load.test.ts`, `worker/prs/service.test.ts`, `worker/prs/settings.test.ts`, `worker/budget.test.ts`, `worker/main.test.ts`; `worker/boards/snapshot.test.ts`, `worker/boards/service.test.ts` and `worker/poll/scheduler.test.ts` stay green.

**Interfaces:**
- Consumes (at `dec2c87`):
  - Tasks 1–4.
  - `createScheduler(clock: Clock): Scheduler`, `Scheduler.upsert/remove/setVisible/runNow` and `Job { key; visibleMs; backgroundMs; run(signal: AbortSignal): Promise<void> }` (`worker/poll/scheduler.ts`). Intervals ≥ 1 000 ms or `upsert` throws; `setVisible` on an unknown key is ignored.
  - `withSignal(http: AdoHttp, signal?: AbortSignal): AdoHttp` (`worker/ado/http.ts`).
  - `Connections.list(): Promise<OrgStatus[]>`; `StatusBar.setCount` (Task 4).
  - `watchWorkspaceSettings(settings, log)` as the pattern (`worker/workspace/settings.ts`); `SETTINGS_READ_FAILED`, `NOT_CONNECTED`, `joinMessages`, `failureMessage` (`worker/messages.ts`).
  - `registerWorkHandlers(orca, { boards, http, call }: WorkHandlerDeps)` (`worker/boards/handlers.ts`); `BoardsService.visibility(input: { surface: 'work' | 'board'; org; visible; board? })`.
  - Test helpers: `drain()`, `memoryStore()`, `withWorker(module, options, run)` (`worker/test-support.ts`); `fakeAdo()` with `on`, `hang`, `count` and `json(status, body, headers)` (`worker/boards/fake-ado.ts`).
- Produces:

```ts
// worker/budget.ts
export function byteLength(value: unknown): number
export function newestThatFit<T>(items: T[], budget: number, at: (item: T) => number, maxItems?: number): Set<T>
// worker/visibility-handler.ts
export function registerVisibilityHandler(orca: OrcaWorkerApi, deps: { boards: BoardsService; prs: PrsService }): void   // 'prs' → prs.visibility, else boards.visibility
// worker/prs/settings.ts
export interface PrSettings { autoComplete(): AutoCompleteOptions }                              // Task 9 adds shareTemplate()
export function watchPrSettings(settings: OrcaWorkerApi['settings'], log: (message: string) => void): Promise<PrSettings>
// worker/prs/load.ts
export interface PrSource {
  full(me: string, projects: { id: string; name: string }[], signal?: AbortSignal): Promise<{ mine: PrSummary[]; review: PrSummary[] }>
  reviews(me: string, projects: { id: string; name: string }[], signal?: AbortSignal): Promise<PrSummary[]>
  one(key: PrKey): Promise<PrSummary>                       // uncached GET, enriched with work items
}
export function createPrSource(http: AdoHttp, org: string, now: () => number): PrSource   // each call uses withSignal(http, signal)
// worker/prs/service.ts
export interface PrsServiceDeps { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; scheduler: Scheduler; autoComplete: () => AutoCompleteOptions; post: (snapshot: PrSnapshot) => void; counts: (org: string, toReview: number | null) => void; now: () => number }
export interface PrsService {
  onOrgs(orgs: OrgStatus[]): void
  snapshot(org: string): Promise<PrSnapshot>
  refresh(org: string): Promise<PrSnapshot>
  cached(org: string, key: PrKey): PrSummary | null
  activeMine(org: string): PrSummary[]
  source(org: string): Promise<PrSource>
  visibility(input: { org: string; visible: boolean }): { ok: true }
}
export function createPrsService(deps: PrsServiceDeps): PrsService
// worker/prs/handlers.ts
export interface PrHandlerDeps { prs: PrsService }                                               // Task 6 adds actions
export function registerPrHandlers(orca: OrcaWorkerApi, deps: PrHandlerDeps): void
```

**Behaviour:**
- **Settings.** An unknown `autoCompleteMergeStrategy` falls back to `noFastForward`. A read failure keeps the previous values and logs `SETTINGS_READ_FAILED`.
- **Loads are single-flight per org**, as the boards service's `load`.
- **Jobs.** One job per connected org whose account is pinned: key `prs:<org>`, `visibleMs` 60 000, `backgroundMs` 300 000, `run: signal => …` passing `signal` down to the `PrSource` calls (as the boards `mine:<org>` job does since `baf1322`). Its run does a **full** load when the org's PRs tab is visible, else a **reviews** load. Orgs that leave `connected` lose their job (which aborts its requests) and their count (`counts(org, null)`), and a load finishing after that posts nothing (guard with the entry identity, as Plan 2's R21). An unknown org throws `AdoError('unauthorized', 401, NOT_CONNECTED)`.
- **Full load.** Per code project (`codeProjects`, 1 h cache), with `mapLimit(…, 4)`: my active list (`top` 100), my completed list (`closedSince = now − COMPLETED_WINDOW_MS`, `top` 50, 5 min cache) and the review list (`top` 100). Enrichment for my PRs in the window: work items (10 min; 1 h when completed) and, for active PRs, policy evaluations (2 min) into `checks`.
- **Snapshot.** `sets = releaseSets(mine, now)`, `toReview = toReviewOf(review, me)`, `toReviewCount` = its length, `autoComplete` from settings, `me` = `account.adoId`. Over 240 KiB (measured with `byteLength`): keep `newestThatFit(sets, …, set => newest createdAt, 50)`, then `newestThatFit(toReview, …, pr => pr.createdAt, 100)` in what's left, and set `message` to `joinMessages(message, PRS_TRIMMED)`. Posted as `prs.changed` and returned.
- **Reviews load.** Updates `toReviewCount` and `toReview` on the last snapshot (creating a sets-empty one if none) and calls `counts`. It doesn't post a snapshot whose sets were never loaded.
- **Failures.** The last snapshot stays, with `stale: true` and `failureMessage(error, PRS_LOAD_FAILED)`, and is posted; an aborted run (its signal fired) posts nothing. A `forbidden` pauses that org's PR loads for 10 minutes with `message` `PRS_NEED_CODE_READ`.
- **`snapshot(org)`** returns the last full snapshot younger than 60 s, else loads one. **`refresh`** runs the job now (`runNow`) and returns the snapshot or throws the failure.
- **`visibility`** records the org's PRs-tab visibility, calls `setVisible`, and runs the job now when becoming visible with no full snapshot younger than 60 s.
- **`ui.visibility`.** At `dec2c87`, `registerWorkHandlers` registers it straight to `boards.visibility`. A second `orca.panels.handle('ui.visibility', …)` would clash, so this task moves it into `registerVisibilityHandler`, which routes `surface === 'prs'` to `prs.visibility(input)` and the rest to `boards.visibility(input)` unchanged. `main.ts` calls `registerWorkHandlers`, `registerPrHandlers` and `registerVisibilityHandler`, each once.

- [ ] **Step 1: Write the failing tests** (`fakePrs()`, the real scheduler with `fakeClock()` from `worker/test-support.ts`; mounted-worker tests use `withWorker`).
  - `a visible load fans out once per code project and caches the rest`: 2 code projects → first run 2 active + 2 completed + 2 review lists, 1 repositories call, one work-items call per in-window PR, one evaluations call per active PR of mine; a second run 60 s later → 2 active + 2 review lists only (S3 budget).
  - `a background run asks only for reviews and updates the count`: 2 review-list calls, `counts('contoso', 1)`, no `prs.changed` before any full load.
  - `a code-project list limits the fan-out`.
  - `the snapshot holds release sets, to-review PRs and the saved auto-complete options`.
  - `a failed refresh keeps the last snapshot as stale`.
  - `a forbidden list pauses PR loads for 10 minutes with the scope message`.
  - `jobs and counts follow org status`: disconnect → job removed, `counts(org, null)`.
  - `a load finishing after sign-out posts nothing`.
  - `a snapshot over the post budget is trimmed with the message`.
  - `becoming visible runs a full load when the last one is stale`.
  - `a removed job aborts its in-flight PR requests`: `fake.hang(isPrList)`, disconnect the org → every hung call's `signal.aborted` is true and nothing is posted.
  - load: `one reads a PR with its work items` and `a signal reaches every request of a full load`.
  - budget: `newestThatFit keeps the newest items within the budget and the cap`.
  - settings: `settings fall back on unknown values and keep the last good read` (logs `SETTINGS_READ_FAILED`).
  - main, each inside `withWorker`: `prs.snapshot answers through the handler`, `the status command reports review counts`, `ui.visibility routes prs to the PRs service and work/board as before` (the existing two `ui.visibility` cases stay green).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, `orca plugin validate . --json` (with the new settings) and `orca plugin check . --json` pass.
- [ ] **Step 5: Commit** "Load pull requests into release sets with polling and review counts".

### Task 6: Approve all and auto-complete all

**Files:**
- Create: `worker/prs/actions.ts`.
- Modify: `src/protocol.ts` (`prs.approve`, `prs.autoComplete`), `worker/prs/handlers.ts` (`PrHandlerDeps` gains `actions`; `registerPrHandlers` registers the two new requests), `worker/messages.ts` (the row messages below, as constants plus `keptBranch(prId: number): string`), `worker/main.ts` (passes `actions`).
- Test: `worker/prs/actions.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: Task 2 `castVote`, `setAutoComplete`; Task 5 `PrsService.source`, `activeMine`, `refresh`, `PrSettings.autoComplete` and `registerPrHandlers(orca, deps: PrHandlerDeps)`; `messageOf(error)` (`src/shared/messages.ts`).
- Produces:

```ts
// worker/prs/actions.ts
export interface PrActions {
  approveAll(input: { org: string; prs: PrKey[] }): Promise<{ results: RowResult[] }>
  autoCompleteAll(input: { org: string; prs: PrKey[] }): Promise<{ results: RowResult[] }>
}
export function createPrActions(deps: { http: AdoHttp; prs: PrsService; orgs: () => Promise<OrgStatus[]>; settings: PrSettings }): PrActions
// worker/prs/handlers.ts (changed)
export interface PrHandlerDeps { prs: PrsService; actions: PrActions }
```

**Rules** (each PR is read fresh with `PrSource.one` first; at most 3 at a time; one PR's failure never stops the others; afterwards `prs.refresh(org)` runs without being awaited):
- Skips, each `ok: true`: completed → "Skipped: it's completed."; abandoned → "Skipped: it's abandoned."; draft → "Skipped: it's a draft. Publish it first."
- **Approve:** my vote already 10 → "Already approved."; otherwise `castVote` keeping my current `isRequired` (false when I'm not a reviewer) → "Approved."
- **Auto-complete:** already on → "Already set to auto-complete."; otherwise `setAutoComplete` with the saved options → "Auto-complete set."
  - `deleteSourceBranch` is forced to `false` when another active PR of mine (from `activeMine(org)` plus the PRs read in this call) has the same `repoId` and `source`. The message is then "Auto-complete set. Source branch kept: Pull Request <id> also uses it."
- A failure → `{ ok: false, message: messageOf(error) }`.

- [ ] **Step 1: Write the failing tests.**
  - `approveAll reports per-row results and continues past a failure` (**Review Focus 2**): four PRs → approved, already approved, draft skipped, 403 → `ok: false` with ADO's message; three PUTs at most, none for the draft.
  - `approve keeps my required flag`.
  - `autoCompleteAll sends the saved options`: exact PATCH body for `squash`, delete on, transition on.
  - `autoCompleteAll keeps the source branch while another active PR uses it` (**Review Focus 1**): two PRs from one branch → both PATCHes carry `deleteSourceBranch: false` and the kept-branch message; a PR alone on its branch keeps `true`.
  - `autoCompleteAll skips PRs already set, completed or abandoned`.
  - main, inside `withWorker`: `prs.approve answers through the handler`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Approve and auto-complete a release set".

### Task 7: Share core

**Files:**
- Create: `src/shared/share/types.ts` (above), `src/shared/share/template.ts`, `src/shared/share/message.ts`, `src/shared/share/teams.ts`, `src/shared/share/pr-items.ts`.
- Test: `src/shared/share/template.test.ts`, `src/shared/share/message.test.ts`, `src/shared/share/teams.test.ts`.

**Interfaces:**
- Consumes: `PrSummary`, `PrKey` (Task 1). No Node APIs (the panel imports these).
- Produces:

```ts
// template.ts
export const PR_TEMPLATE = '[Pull Request {id}]({url}): {title}'
export const PR_VARS = ['id', 'title', 'url', 'repo', 'project', 'source', 'target', 'author'] as const
export type ParsedTemplate = { readonly kind: 'parsed'; readonly parts: readonly unknown[] }
export function parseTemplate(template: string, vars: readonly string[]): ParsedTemplate | { error: string }
export function fillLine(template: ParsedTemplate, values: Record<string, string>): Segment[]
// message.ts
export const MAX_SHARE_ITEMS = 50
export const MAX_INTRO = 2000
export function buildMessage(input: { template: string; fallback: string; vars: readonly string[]; intro: string; items: ShareItem[] }): { message: ShareMessage; warning?: string }
export function toHtml(message: ShareMessage): string
export function toPlain(message: ShareMessage): string
export function toMarkdown(message: ShareMessage): string
// teams.ts
export const MAX_CHAT_URL = 2000
export function teamsChatUrl(input: { users: string[]; text: string; tenantId: string | null }): string | null   // null when over MAX_CHAT_URL or no users
// pr-items.ts
export function prItemKey(key: PrKey): string                 // `pr:${projectId}/${repoId}/${prId}`
export function parsePrItemKey(key: string): PrKey | null
export function prShareItem(pr: PrSummary): ShareItem          // vars: id, title, url, repo, project, source, target, author
```

**Rules:**
- **Template.** `{name}` placeholders from `vars`, and at most one link span `[text](target)`; everything else is literal text. Errors (exact): "The share template can have only one link.", "Unknown placeholder {<name>} in the share template.", "The share template is empty." They are exported from `template.ts`, not `worker/messages.ts`, because the panel shows them too and can't import the worker. `buildMessage` falls back to `fallback` and returns the error as `warning`.
- **Fill after parsing.** Values are inserted into already-parsed segments, so a value can never create a link or markup. A link whose filled target isn't an `http:`/`https:` URL renders as plain text.
- **Intro.** Trimmed and cut to `MAX_INTRO`; `items` cut to `MAX_SHARE_ITEMS`.
- **HTML.** `<div>` per intro line (`<br>` for an empty one), then one `<div>` per item line; link → `<a href="…">…</a>`. Text and attributes escape `& < > " '` (`&#39;`).
- **Plain.** Intro, a blank line, then one line per item: the line's text with the link's URL appended after a space.
- **Markdown** (the panel preview). Intro and lines as paragraphs; text escapes ``\ ` * _ [ ] ( ) < > # | ~``; link → `[text](url)`.
- **Chat link.** `users` comma-joined after `encodeURIComponent` of each; `message` = `encodeURIComponent(text)`; `tenantId` appended when present.

- [ ] **Step 1: Write the failing tests.**
  - `the default template reproduces the reference line`: item `{ id: '123396', title: "[PROJ-55283] Reserve a buyer's line and flag missed calls on the lead", url: 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396' }` →
    - HTML `<div><a href="https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396">Pull Request 123396</a>: [PROJ-55283] Reserve a buyer&#39;s line and flag missed calls on the lead</div>`;
    - plain `Pull Request 123396: [PROJ-55283] Reserve a buyer's line and flag missed calls on the lead https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396`;
    - Markdown `[Pull Request 123396](https://…/123396): \[PROJ-55283\] Reserve a buyer's line and flag missed calls on the lead`.
  - `titles can never add links or markup` (**Review Focus 4**): titles `](javascript:alert(1))`, `<script>x</script>`, `[a](https://evil.example)`, `&amp; 🚀` and a 400-character title → each output has exactly one link (the PR URL), no `<script`, and the text survives verbatim in plain.
  - `a template with an unknown placeholder or two links falls back with a warning`.
  - `a link target that isn't http(s) renders as plain text`.
  - `intro text is escaped, keeps its line breaks and is cut to 2,000 characters; items are cut to 50`.
  - `a custom template uses repo and target`: `{repo} → {target}: [#{id}]({url})`.
  - `teamsChatUrl encodes users, message and tenant, and refuses past 2000 characters`.
  - `prItemKey round-trips and prShareItem fills the variables`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Add the share template and renderers".

### Task 8: Rich clipboard

**Files:**
- Create: `worker/sys/clipboard.ts`.
- Modify: `worker/messages.ts` (`COPY_NEEDS_TOOL`, `COPY_FAILED`).
- Test: `worker/sys/clipboard.test.ts`, `worker/sys/clipboard.live.test.ts` (skipped unless `ORCA_ADO_LIVE_CLIPBOARD=1`; macOS only; saves and restores the plain text).

**Interfaces:**
- Consumes: `findExecutable(name: string, opts: { override?; pathEnv?; extraDirs?; isExecutable? }): string | null` (`worker/sys/find-executable.ts`); spike S1 results. It does not use `runCommand` or `stopAllCommands` (`worker/sys/run.ts`): `deactivate` stops every registered group, and that would kill the `wl-copy`/`xclip` process that serves the clipboard.
- Produces:

```ts
export type SpawnWithInput = (file: string, args: string[], opts: { input: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ code: number }>
export const spawnWithInput: SpawnWithInput   // stdio ['pipe','ignore','ignore']; settles on the child's 'exit'; SIGKILLs the child on timeout; never registered with stopAllCommands
export function cfHtml(fragment: string): string
export function linuxDisplayEnv(deps: { uid: number; home: string; exists: (path: string) => boolean; list: (dir: string) => string[] }): { kind: 'wayland' | 'x11'; env: Record<string, string> } | null
export interface ClipboardDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; find: (name: string) => string | null; spawn: SpawnWithInput; uid: number; home: string; exists: (path: string) => boolean; list: (dir: string) => string[] }
export interface Clipboard { write(content: { html: string; plain: string }): Promise<'rich' | 'html'> }
export function createClipboard(deps: ClipboardDeps): Clipboard
```

**Per OS** (content always on stdin as JSON `{ html, plain }`; 10 s timeout):
- **macOS:** `/usr/bin/osascript -l JavaScript -e <script>`. The script reads stdin through `NSFileHandle.fileHandleWithStandardInput`, `clearContents`, then sets `public.html` and `public.utf8-plain-text`. → `'rich'`.
- **Windows:** `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand <base64 UTF-16LE script>`. The script reads stdin, builds a `System.Windows.Forms.DataObject` with `'HTML Format'` = the `cfHtml` string (built in Node and passed in the JSON) and `UnicodeText` = plain, then `[System.Windows.Forms.Clipboard]::SetDataObject($o, $true)`. → `'rich'`.
- **Linux:** the worker environment has no display variables (S1), so `linuxDisplayEnv` derives them. Wayland: `XDG_RUNTIME_DIR=/run/user/<uid>` and the first `wayland-<n>` socket there → `wl-copy --type text/html`. Else X11: `DISPLAY=:0`, plus `XAUTHORITY=<home>/.Xauthority` when it exists → `xclip -selection clipboard -t text/html`. → `'html'` (one MIME type per tool).
- `cfHtml`: header `Version:0.9`, `StartHTML`, `EndHTML`, `StartFragment`, `EndFragment` as 10-digit zero-padded **UTF-8 byte** offsets, around `<html><body><!--StartFragment-->…<!--EndFragment--></body></html>`.
- Errors (exact, as `worker/messages.ts` constants): `COPY_NEEDS_TOOL` "Copying needs wl-clipboard or xclip." when no tool is found; `COPY_FAILED` "Couldn't copy to the clipboard." for any other failure, non-zero exit or timeout.

- [ ] **Step 1: Write the failing tests.**
  - `macOS writes html and plain through osascript stdin` (fake spawn: file, `-l JavaScript`, stdin JSON).
  - `cfHtml offsets are UTF-8 byte offsets`: for a fragment with `é` and `—`, slicing the UTF-8 bytes at `StartFragment..EndFragment` gives the fragment back, and `StartHTML..EndHTML` the whole document.
  - `Windows runs powershell -STA with an encoded command`: decoding the argument shows `SetDataObject` and `HTML Format`.
  - `Linux finds a Wayland socket and uses wl-copy`; `Linux falls back to xclip on :0 with XAUTHORITY`; `Linux without either tool gives the install message`.
  - `a non-zero exit or a timeout gives the fixed failure message`.
  - `spawnWithInput settles when the child exits even if a forked process keeps running`: real `sh -c 'cat >/dev/null; (sleep 30.731 &); exit 0'` settles within 2 s; `pkill -f 'sleep 30.731'` in `finally`.
  - `spawnWithInput kills a child that outlives the timeout`: `sh -c 'sleep 30.732'` with 200 ms → rejects, and `pgrep` finds nothing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run the live test once on this Mac: `ORCA_ADO_LIVE_CLIPBOARD=1 orca plugin test . --json` → the read-back shows HTML and plain text, and the old plain text is restored.
- [ ] **Step 5: Commit** "Copy rich text to the clipboard on each OS".

### Task 9: Share service, Teams channels and destinations

**Files:**
- Create: `worker/share/channels.ts`, `worker/share/webhook.ts`, `worker/share/card.ts`, `worker/share/destinations.ts`, `worker/share/service.ts`, `worker/share/handlers.ts`.
- Modify:
  - `orca-plugin.json`: the `shareTemplate` setting.
  - `worker/prs/settings.ts`: `PrSettings.shareTemplate()`, the default when empty.
  - `worker/messages.ts`: every channel, webhook, card, copy-result, reviewers and test-post message below. Fixed ones are constants; `sentTo(name)`, `httpRefused(status)`, `addedReviewers(names, count)` and `alreadyReviewer(name, prId)` are functions.
  - `src/protocol.ts`: `share.*`.
  - `worker/main.ts`: create the store, clipboard, destinations and service; the `pr` source; `registerShareHandlers`.
- Test: `worker/share/channels.test.ts`, `worker/share/webhook.test.ts`, `worker/share/card.test.ts`, `worker/share/destinations.test.ts`, `worker/share/service.test.ts`, `worker/prs/settings.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: Task 7 (all), Task 8 `Clipboard`, Task 2 `listReviewers`, `addReviewer`, `searchIdentities`, Task 5 `PrsService.cached`/`source`, `PrSettings` and `byteLength` (`worker/budget.ts`); `StorePort` (`worker/connections.ts`); `SecretsPort { get; set; delete }` (`worker/auth/pat.ts`); `messageOf` (`src/shared/messages.ts`); `withWorker` and `memoryStore` (`worker/test-support.ts`).
- Produces (the reusable module; Plan 4 adds an `approval` source, and any new destination is one more `WorkerDestination`):

```ts
// channels.ts
export interface ChannelStore { list(): Promise<Channel[]>; add(name: string, url: string): Promise<Channel>; replace(id: string, url: string): Promise<Channel>; remove(id: string): Promise<void>; url(id: string): Promise<string | null> }
export function createChannelStore(deps: { store: StorePort; secrets: SecretsPort; newId: () => string; now: () => number }): ChannelStore
export function checkWebhookUrl(input: string): string
// webhook.ts
export function postToWebhook(fetchFn: typeof fetch, url: string, payload: unknown, timeoutMs?: number): Promise<void>   // default 15 000
// card.ts
export const MAX_CARD_BYTES = 26_000
export function adaptiveCard(message: ShareMessage, footer: string): Record<string, unknown>
export function webhookPayload(card: Record<string, unknown>): Record<string, unknown>
// destinations.ts
export interface DestinationContext { org: string; message: ShareMessage; prs: PrKey[]; sharedBy: string }
export interface WorkerDestination { kind: ShareDestination['kind']; send(ctx: DestinationContext, destination: ShareDestination): Promise<ShareResult[]> }
export function copyDestination(clipboard: Clipboard): WorkerDestination
export function channelDestination(channels: ChannelStore, fetchFn: typeof fetch): WorkerDestination
export function reviewersDestination(http: AdoHttp): WorkerDestination
// service.ts
export interface ShareSource { kind: ShareKind; template(): string; fallback: string; vars: readonly string[]; items(org: string, keys: string[]): Promise<{ items: ShareItem[]; prs: PrKey[] }> }
export interface ShareService {
  prefs(org: string, kind: ShareKind): Promise<SharePrefsView>
  send(request: ShareRequest): Promise<{ results: ShareResult[] }>
  people(input: { org: string; query: string; groups: boolean }): Promise<Identity[]>
  test(id: string): Promise<ShareResult>
  channels: ChannelStore
}
export function createShareService(deps: { http: AdoHttp; store: StorePort; channels: ChannelStore; fetch: typeof fetch; orgs: () => Promise<OrgStatus[]>; sources: Record<ShareKind, ShareSource>; destinations: WorkerDestination[] }): ShareService
// handlers.ts
export function registerShareHandlers(orca: OrcaWorkerApi, share: ShareService): void
```

**Channels:**
- Metadata `Channel[]` in storage `share:channels` (≤ 20); the URL in secrets `teams-webhook:<id>` (`newId` = `crypto.randomUUID`).
- `checkWebhookUrl` (exact messages): empty → "Paste the webhook URL from Teams Workflows."; not a URL, not `https:`, with a user name or password, or over 4,096 characters → "That isn't a valid https webhook URL." Any host is accepted (the recon warns hosts change).
- `add`: empty name → "Name the channel."; a duplicate name (case-insensitive) → "You already have a channel with that name."
- A `secrets.set` failure → "Orca can't store secrets on this system, so Teams channels are unavailable."
- `remove` deletes the secret, then the metadata. `replace` overwrites the secret only.

**Webhook:**
- POST JSON with `redirect: 'error'` and a 15 s timeout. Any 2xx → resolve.
- Errors (exact; never the URL, never `error.cause`): 429 → "Teams is throttling posts. Try again in a minute."; other HTTP → "Teams didn't accept the post (HTTP <status>). If the workflow changed, replace its URL."; network or timeout → "Couldn't reach Teams."

**Card:**
- `{ type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', msteams: { width: 'Full' }, body }`.
- `body`: a wrapping `TextBlock` for the intro (when present); one `RichTextBlock` per line, each segment a `TextRun` (the link's run has `selectAction: { type: 'Action.OpenUrl', url }`); a final subtle small `TextBlock` with the footer `Shared by <displayName> from Orca`.
- The payload's `byteLength` over `MAX_CARD_BYTES` → "Too much to post at once. Share fewer pull requests."

**Send:** builds `items` from the source by `keys` (never from panel text), then `buildMessage` with the source's template. Each requested destination goes to the registered `WorkerDestination` of its `kind`, in request order; `chat` has none (the panel opens it) and is only remembered. `sharedBy` is the pinned account's `displayName`.
- **copy:** `toHtml`/`toPlain` → clipboard → "Copied as rich text." (`'html'` → "Copied as rich text (HTML only)."). On failure `ok: false` with the message and `plain` = `toPlain(message)`.
- **channel:** "Sent to <name> (accepted)." A missing secret → "This channel's webhook URL is missing. Replace it."
- **reviewers:** per PR, read the reviewers fresh, skip people already on it, `addReviewer` for the rest. One result: "Added <names> to <n> pull requests." plus "<name> is already on Pull Request <id>." per skip.
- A destination that throws becomes one `ok: false` result with `messageOf(error)`; the others still run.
- After sending, `share:prefs:<org>` stores the request's destinations, dropping channel ids that no longer exist. The default when none is stored: `[{ kind: 'copy' }]`.
- `prefs()` returns the template (with the parse warning), the channels, the stored prefs and `tenantId` = `account.tenantId`.
- `people()` proxies `searchIdentities`.
- `test(id)` posts a card whose intro is "Azure DevOps for Orca can post to this channel." → "Sent (accepted). Teams doesn't confirm delivery; check the channel."
- The `pr` source maps keys with `parsePrItemKey`, reads each PR from `prs.cached` or `(await prs.source(org)).one(key)`, and uses `prShareItem`, `PrSettings.shareTemplate()`, `PR_TEMPLATE` and `PR_VARS`.
- `PrSettings.shareTemplate()` returns `PR_TEMPLATE` when the setting is empty or not a string.

- [ ] **Step 1: Write the failing tests.**
  - channels: `add keeps the URL only in secrets and returns metadata` (storage JSON doesn't contain the URL), `invalid URLs and names are refused with the fixed messages`, `replace and remove`, `a secrets failure gives the unavailable message`.
  - webhook: `post sends the Adaptive Card payload and treats 202 as accepted`.
  - `webhook failures never mention the URL` (**Review Focus 3**, in `worker/main.test.ts` inside `withWorker`, through `share.testChannel` and `share.send`): for 404, 400, 429, a rejected fetch whose error message contains the URL, and a timeout, the URL and its `sig` value appear in none of: the results, thrown messages, `w.logs`, `w.posts`, `host.data().storage`.
  - card: `each line is a RichTextBlock with an OpenUrl TextRun for the link`, `cards over 26,000 bytes are refused`.
  - destinations: `adding an existing reviewer never resets their vote` (**Review Focus 5**): the PR already has the person with vote 10 → no PUT for them, skip note present; a new person gets `{ vote: 0, isRequired: true }`. Also `a failed copy returns the plain text to copy by hand` and `a channel with a missing secret says to replace it`.
  - service: `send copies, posts and adds reviewers, one result per destination`, `a destination failure doesn't stop the others`, `items come from the PR source by key`, `send remembers destinations and people per org`, `prefs reports a template warning and the tenant`, `destinations dispatch by kind` (a stub `copy` destination receives the built message and the PR keys), `people proxies searchIdentities`, `test posts the test card and says sent (accepted)`.
  - settings: `shareTemplate falls back to the default when empty or not a string`.
  - main, inside `withWorker`: `share.addChannel never returns or logs the URL`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, `orca plugin validate . --json` and `orca plugin check . --json` pass.
- [ ] **Step 5: Commit** "Share to the clipboard, Teams channels and reviewers".

### Task 10: PRs tab

**Files:**
- Create: `src/panel/prs/state.ts`, `src/panel/prs/prs-tab.tsx`, `src/panel/prs/release-set.tsx`.
- Modify: `src/panel/panel.tsx` (`TabBody` renders `PrsTab` for `prs`; `setup` subscribes to `prs.changed`; the cleanup also hides PRs; `Panel` calls `syncPrs`), `src/panel/test-support.ts` (default `prs.snapshot` answer), `src/panel/panel.check.ts` (a `prs` scenario).
- Test: `src/panel/prs/prs-tab.test.tsx`.

**Interfaces:**
- Consumes: `prs.snapshot`, `prs.refresh`, `prs.approve`, `prs.autoComplete`, `prs.changed`, `ui.visibility` (Tasks 5–6); Plan 2's panel pattern (`syncWork(org, onScreen)`, `watchVisibility`, `acceptChange` in `src/panel/work/state.ts`); `messageOf`, `LONG_WAIT` (`src/panel/state.ts`); test helpers `mountPanel(orgs, requests, options)`, `closeCleanly`, `requestsTo`, `org(name, over)` (`src/panel/test-support.ts`).
- Produces: `syncPrs(org: OrgStatus | null, onScreen: boolean): void`, `acceptPrs(next: PrSnapshot): void`, `hidePrs(): void`, `PrsTab({ org }: { org: OrgStatus }): OrcaNode`, `ReleaseSetCard({ org, set }: { org: string; set: ReleaseSet }): OrcaNode`.

**UI** (exact copy):
- **Header:** `Text` muted "Updated <RelativeTime>"; `IconButton` refresh "Refresh". A stale `message` → `Text tone="warning"`; another `message` → muted.
- **Auto-complete line:** muted `Text` "Auto-complete uses <merge label>, <'deletes the source branch' | 'keeps the source branch'>, <'completes linked work items' | 'leaves work items alone'>. Change this in Settings → Azure DevOps."
- **Each set** (≤ 30, then muted "Showing 30 of <n> sets."): a `Card` with title = `set.title` and description = `sources.join(', ')` + ` · ` + the distinct repo names.
  - One `Row` per PR: `Link href={pr.url}` "Pull Request <id>", `Text` "→ <target>", then `Badge`s:
    - status: `merged ✓` success, `draft`, `conflicts` danger;
    - build: `● build` warning, `✗ build` danger, `✓ build` success;
    - policies: `✗ policies` danger, `· policies`;
    - votes: `<n> approved` success, `<n> rejected` danger, `waiting for <required name>` warning;
    - `auto-complete` accent.
  - Buttons: `Approve all`, `Auto-complete all` (Task 11 adds `Share…`). They act on the set's active PRs, are disabled when none qualify, and use `LONG_WAIT`.
  - After an action: a `Callout` (success tone when all rows are ok, else warning) with one `Text` per row: "Pull Request <id>: <message>".
- **To review:** `Collapsible` "To review (<toReviewCount>)", closed by default. ≤ 50 `ListItem`s (title, description `Pull Request <id> · <repo> · <author>`); pressing one calls `shell.openExternal(pr.url)`.
- **Empty:** `EmptyState` "No open pull requests of yours", description "Pull requests you create in this organization's code projects show up here."
- Errors: `messageOf(error)`.

- [ ] **Step 1: Write the failing tests.**
  - `sets show one row per PR with target, checks, votes and auto-complete`.
  - `Approve all sends prs.approve with the set's active PRs and shows each row's result`.
  - `Auto-complete all sends prs.autoComplete; the options line reflects the snapshot`.
  - `prs.changed replaces the sets; a stale snapshot keeps them with the warning`.
  - `To review opens a PR in the browser on press` (`host.callsOf('shell.openExternal')`, no refusals).
  - `visibility changes call ui.visibility with surface prs`.
  - `no sets shows the empty state`.
  - `more than 30 sets shows the cap note`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `orca plugin check . --json` exits 0 with the `prs` scenario.
- [ ] **Step 5: Commit** "Add the PRs tab with release sets".

### Task 11: Share composer, people picker and channel manager

**Files:**
- Create: `src/panel/share/state.ts`, `src/panel/share/composer.tsx`, `src/panel/share/people-picker.tsx`, `src/panel/share/channels.tsx`.
- Modify: `src/panel/prs/prs-tab.tsx` and `src/panel/prs/release-set.tsx` (a `Share…` button per set opens the composer for it; a header `IconButton` settings "Teams channels" opens `Channels`; `PrsTab` renders `Composer` or `Channels` while one is open), `src/panel/test-support.ts` (default `share.prefs` answer).
- Test: `src/panel/share/composer.test.tsx`, `src/panel/share/channels.test.tsx`.

**Interfaces:**
- Consumes: Task 7 (`buildMessage`, `toMarkdown`, `toPlain`, `teamsChatUrl`, `prShareItem`, `prItemKey`, `PR_TEMPLATE`, `PR_VARS`), `share.*` requests (Task 9), `shell.openExternal` from `orca`.
- Produces (Plan 4 opens the same composer for approvals):

```ts
export interface ComposerItem { key: string; label: string; item: ShareItem; checked: boolean }
export interface ComposerInput { org: string; kind: ShareKind; title: string; items: ComposerItem[]; suggestions: Identity[]; reviewers: boolean; fallback: string; vars: readonly string[] }
export function openComposer(input: ComposerInput): void
export function closeComposer(): void
export function openChannels(): void
export function shareView(): 'none' | 'composer' | 'channels'      // read while rendering; the hosting tab shows that view
export function Composer(): OrcaNode
export function PeoplePicker(props: { org: string; label: string; groups: boolean; required: boolean; people: Person[]; suggestions: Identity[]; onChange: (people: Person[]) => void }): OrcaNode
export function Channels(): OrcaNode
```

**Composer** (exact copy). A set's `Share…` opens it with title "Share pull requests", items = the set's PRs (label `Pull Request <id> → <target>`; active ones checked, completed ones unchecked), suggestions = the reviewers of the set's PRs, and `reviewers: true`. It loads `share.prefs` and preselects the remembered destinations and people.
- `Checkbox` per item; `Textarea` "Intro (optional)" (`maxLength` 2000).
- A `warning` from the template → `Callout tone="warning"`.
- "Preview" `Text`, then `Markdown` with `toMarkdown(message)`.
- "Send to":
  - `Checkbox` "Copy as rich text";
  - per channel, `Checkbox` "Post to <name>", and a ghost `Button` "Manage channels";
  - `Checkbox` "Message in Teams" with a `PeoplePicker` (users only, label "Find people");
  - `Checkbox` "Add as reviewers" (only when `reviewers`) with a `PeoplePicker` (users and groups, label "Find people or groups", a `Switch` "Required" per person).
- `Button` "Share" (disabled with no checked item or no destination); ghost `Button` "Back".
- **Share press order:**
  1. Build the message synchronously from the atoms.
  2. If chat is chosen: `teamsChatUrl({ users: people.map(p => p.uniqueName), text: toPlain(message), tenantId })`. `null` → a chat result "Too long for a Teams chat link. Use Copy instead." Otherwise call `shell.openExternal(url)` **before any await** and keep its promise.
  3. `plugin.request('share.send', { org, kind, keys, intro, destinations }, LONG_WAIT)`, where `destinations` lists every chosen destination in the order shown, chat included so it is remembered.
  4. Await the chat promise: opened → "Opened a Teams chat."; refused or failed → "Teams chat wasn't opened." plus a `Button` "Open Teams chat" that retries only the link.
- The composer closes when the active org changes.
- **Results:** one `Callout` per result (success or danger tone). A copy result with `plain` adds a `CodeView` labelled "Copy this text instead".
- **PeoplePicker:** `Input` (placeholder "Name or email", `onSubmit` → `share.people`) and an `IconButton` search "Search". Results and suggestions are `ListItem`s that add on press. Chosen people are `Row`s with name, the optional `Switch` "Required" and an `IconButton` remove "Remove <name>". No timers.

**Channels** (exact copy): `Heading` "Teams channels".
- Help text: "In Teams, open the channel's ⋯ menu → Workflows → \"Send webhook alerts to a channel\", then paste the URL it gives you. Posts come from the Workflows bot."
- Per channel: `Text` name, `Button` "Test" (shows the result), `Button` "Replace URL" (reveals an `Input type="password"` "New webhook URL" and `Button` "Save"), `Button` tone danger "Remove" → "Confirm remove".
- Add: `Input` "Channel name", `Input type="password"` "Webhook URL", `Button` "Add channel". URL drafts live in unkeyed, non-persisted atoms and are cleared after every save, success or failure.
- Back returns to the composer when it was open, else the list.

- [ ] **Step 1: Write the failing tests.**
  - `Share opens the composer with the set's active PRs checked and the reference preview`.
  - `unchecking a PR removes it from the preview and from share.send keys`.
  - `with chat chosen, the Teams link opens before share.send` (call order in `host.calls`; no refusals; the URL contains `tenantId`).
  - `a chat link that's too long is refused without opening anything`.
  - `Share sends copy, channels and reviewers and shows each result`.
  - `a failed copy shows the plain text to copy by hand`.
  - `people search adds a person, Required toggles, Remove removes`.
  - `remembered destinations and people are preselected`.
  - `a template warning shows above the preview`.
  - channels: `adding a channel clears the URL field and the URL never shows in the tree` (`panel.tree()` JSON and `panel.persisted` lack it), `Test shows sent (accepted)`, `Remove asks to confirm`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `orca plugin check . --json` exits 0.
- [ ] **Step 5: Commit** "Add the share composer and Teams channels".

### Task 12: Verification, README and live checks

- [ ] **Step 1: Run the full offline suite.** `orca plugin validate . --json`, `npm run typecheck`, `orca plugin test . --json` and `orca plugin check . --json` all pass, with no leftover `sleep 30.7…` processes.
- [ ] **Step 2: Update the README.**
  - Move "Pull requests and sharing" to "Works now".
  - A **PRs tab** section: release sets (how they form), Approve all, Auto-complete all and the kept-branch rule, To review.
  - A **Sharing** section: the template and its placeholders, each destination, what "sent (accepted)" means, Teams channel setup steps, copy support per OS (macOS verified; Windows unverified; Linux HTML only, needs `wl-clipboard` or `xclip`, display found by convention).
  - **Polling:** the PR cadences.
  - **Settings:** the four new keys.
  - **PAT scopes:** add Code (Read & write) (`vso.code_write`) for votes, auto-complete and reviewers, and Graph (Read) (`vso.graph`) plus Identity (Read) (`vso.identity`) for finding people. Hedge it like the existing list.
  - Status bar: `ADO · N to review`, counting PRs where you are a reviewer yourself (not through a group).
- [ ] **Step 3: Live checks with the user** (deferred until the user is present and the sandbox org exists; fill the pending rows of `docs/superpowers/spikes/2026-11-05-plan-3.md`):
  - (a) Three sandbox PRs from one branch form one set. Approve all and Auto-complete all work, the branch is kept, the merge type applies, and a "limit merge types" policy shows its per-row message.
  - (b) Copy as rich text, pasted into Teams desktop, Outlook and Slack: only "Pull Request N" is a link.
  - (c) A Workflows webhook to the user's test channel: the card renders, the `TextRun` links open the PR, Test and Replace work.
  - (d) Teams chat link: desktop app or browser page; prefill with line breaks; `tenantId` picks the right account; a two-person group chat; the real length limit; how often Orca asks for consent.
  - (e) Add reviewers (a person and a group, required and optional): ADO notifies them, and an existing reviewer's vote is untouched.
  - (f) Read-only on the client org: `X-RateLimit-*` after a visible refresh; whether `reviewerId` returns group-assigned PRs; whether the org-wide repositories list works.
  - (g) The status bar shows `ADO · N to review`.
  - (h) The PRs tab and composer at 360 px in both themes.
- [ ] **Step 4: Commit and report** which spikes were settled and which live rows remain.

---

## Pre-flight scan

Baseline `dec2c87`. "Fixed" means the plan text above already carries the fix.

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T0 → T5 | S3 call-budget formulas → T5 `a visible load fans out once per code project…` | OK: same counts for P = 2. |
| T0 → T8 | S1 env allowlist and route decision → `linuxDisplayEnv`, per-OS table | OK. |
| T0 → T12 | Spike record (created) → live rows (filled) | OK: one file, T0 creates, T12 edits. |
| T1 ↔ Plan 2 `pr-links.ts` | Extraction of evaluations/`mapLimit` ↔ chip cache from `48cd10b` | **Conflict, fixed.** "Move out of pr-links" didn't protect the 1 h terminal TTL or 404 caching. Now only evaluation/build/`mapLimit` code moves; `ttlOf`, `TERMINAL_TTL_MS`, `MAX_CONCURRENT`, `branchName` stay; the 21 tests stay unedited. |
| T1 ↔ Plan 2 `org.ts`, `messages.ts` | `orgWebUrl`, `branchName`, `MALFORMED.pullRequest` → `toPrSummary` | **Conflict, fixed.** `toPrSummary` took its own `orgUrl` and restated the malformed text and the `refs/heads/` strip. It now uses the single-sourced helpers. |
| T1 → T2 | `PrKey`, `PrReviewer`, `AutoCompleteOptions`, `toReviewer` → `pr-actions.ts` | Fixed in self-review: `listReviewers` needed a mapper, so T1 exports `toReviewer`. |
| T1 → T3 | `PrSummary`, `ReleaseSet` → `releaseSets` | OK. |
| T1 → T5 | `listPullRequests`, `getPullRequest`, `pullRequestWorkItems`, `codeProjects`, `toPrSummary`, `loadEvaluations`, `policyStateOf`, `mapLimit` → `createPrSource` | **Conflict, fixed.** `createPrSource(http, org, orgUrl, now)` no longer matched T1's `toPrSummary(raw, org)`; it is now `createPrSource(http, org, now)`. |
| T1 → T7 | `PrSummary`, `PrKey` types → `prShareItem`, `prItemKey` | OK: `src/shared/prs.ts` is types only, so the panel can import it. |
| T2 ↔ Plan 1/2 `http.ts`, `org.ts` | vssps host → `searchIdentities` | **Conflict, fixed.** A second hard-coded vssps URL would have joined `discoverTenant`'s inline one. Now `orgVsspsUrl(org)` in `org.ts` serves both, beside `orgWebUrl`. |
| T2 → T6 | `castVote`, `setAutoComplete` → `createPrActions` | OK. |
| T2 → T9 | `listReviewers`, `addReviewer`, `searchIdentities` → `reviewersDestination`, `people()` | OK. |
| T3 → T5 | `releaseSets(prs, now)`, `toReviewOf(prs, me)`, `COMPLETED_WINDOW_MS` → snapshot and completed query | OK. |
| T4 → T5 | `StatusBar.setCount`, `statusText(orgs, counts)` → `counts` dep, `status` command | OK; both edit `main.ts`, in sequence. |
| T5 ↔ Plan 2 `boards/handlers.ts` | `ui.visibility` handler | **Conflict, fixed.** `registerWorkHandlers` registers it at `dec2c87`, so a second registration would clash. It moves to `registerVisibilityHandler` (`worker/visibility-handler.ts`), routing `prs` and leaving work/board unchanged. |
| T5 ↔ Plan 2 `boards/snapshot.ts` | Byte budget → PR snapshot cap | **Conflict, fixed.** The PR cap would have copied `byteLength`/`newestThatFit`. Both move to `worker/budget.ts` (generic `at`), used by `capSnapshot`, `capBoard`, the PR cap and T9's card limit. |
| T5 ↔ Plan 2 tests | `fakeClock` (two copies), `fakeAdo` `hang`/`signal`, `withWorker` | **Conflict, fixed.** `fakePrs({ fallback })` duplicated the fake. It is now `fakeAdo()` plus PR routes; `fakeClock` moves to `worker/test-support.ts`; mounted tests use `withWorker`. |
| T5 ↔ Plan 2 scheduler jobs | Job `run(signal)` → `withSignal` | **Conflict, fixed.** The PR job ignored its signal. It now passes it to `PrSource` via `withSignal`, with the test `a removed job aborts its in-flight PR requests`. |
| T5 → T6 | `PrsService.source/activeMine/refresh`, `PrSettings`, `registerPrHandlers` → actions | **Conflict, fixed.** T6 added a second registrar (`registerPrActionHandlers`). `PrHandlerDeps` gains `actions` instead, so one per-feature registrar remains. |
| T5 → T9 | `PrsService.cached/source`, `PrSettings`, `byteLength` → `pr` source, card | OK; `worker/prs/settings.ts` and its test are created by T5 and extended by T9 (`shareTemplate`). |
| T5 → T10 | `prs.snapshot/refresh/changed`, `ui.visibility` `'prs'` → panel state | OK. |
| T6 → T10 | `prs.approve/autoComplete`, `RowResult` → set buttons | OK. |
| T7 → T9 | `buildMessage`, `toHtml`, `toPlain`, `PR_TEMPLATE`, `PR_VARS`, `parsePrItemKey`, `prShareItem`, share types → service, destinations | OK. |
| T7 → T11 | `buildMessage`, `toMarkdown`, `toPlain`, `teamsChatUrl`, `prShareItem`, `prItemKey` → composer | OK. |
| T7 ↔ Plan 2 `snapshot.ts` | `MAX_ITEMS` name | **Naming clash, fixed.** Renamed to `MAX_SHARE_ITEMS`. |
| T8 → T9 | `Clipboard.write` → `'rich' \| 'html'` → copy result text | OK. |
| T8 ↔ Plan 2 `sys/run.ts` | `stopAllCommands` on deactivate | OK: the clipboard spawns outside `runCommand`, so deactivate can't kill the clipboard owner. Stated in T8. |
| T9 → T11 | `share.*` protocol, `SharePrefsView`, `ShareDestination`, `ShareResult.plain` → composer, channels | OK. |
| T5, T6, T9 | `src/protocol.ts`, `worker/main.ts`, `worker/messages.ts`, `orca-plugin.json` | OK: distinct entries, edited in task order. |
| T10 → T11 | `prs-tab.tsx`, `release-set.tsx`, `ReleaseSetCard`, panel `test-support.ts` | Fixed in self-review: T10 referenced views only T11 builds. `Share…` and "Teams channels" now arrive in T11 via `shareView`/`openChannels`. |
| T12 ↔ all | README sections | OK. |

### Each task against itself

| Task | Tests ↔ code; created ↔ later touched | Finding |
|---|---|---|
| T0 | Commits only the spike record; probes stay uncommitted | OK. |
| T1 | Every produced function has a test | **Gap, fixed:** `getPullRequest` had none; test added. `pull-requests-review.json` is created here but first read by T5 (intended). |
| T2 | `org.ts`, `http.ts`, `messages.ts` edits each have a test | OK. |
| T3 | Pure; tests match rules | OK. |
| T4 | `setOrgs` dropping gone orgs | **Gap, fixed:** test extended. Main test uses `withWorker`. |
| T5 | Creates `load.ts`, `budget.ts`, `visibility-handler.ts`, `fake-prs.ts` | **Gap, fixed:** `load.test.ts` and `budget.test.ts` had no cases; added. The visibility router is covered by main tests. |
| T6 | Abandoned skip | **Gap, fixed:** covered in `autoCompleteAll skips PRs already set, completed or abandoned`. |
| T7 | `MAX_INTRO`, `MAX_SHARE_ITEMS` | **Gap, fixed:** caps now asserted. |
| T8 | Messages in `worker/messages.ts`; live test opt-in | OK. |
| T9 | `people()`, `test()`, `shareTemplate()` | **Gap, fixed:** tests added. Review Focus 3 moved into `main.test.ts` because it inspects `w.logs`/`w.posts`. Destination tests split into `destinations.test.ts`. |
| T10 | Produces `ReleaseSetCard`; `panel.check.ts` scenario checked in Step 4 | OK. |
| T11 | `openChannels`/`shareView` exercised by the channels tests | OK. |
| T12 | Verification only | OK. |
