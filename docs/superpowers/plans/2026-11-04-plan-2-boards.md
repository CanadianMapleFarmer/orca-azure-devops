# Plan 2: Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Work tab and a full-tab team board.

The **Work tab** shows:
- the user's assigned items, grouped by the team board's columns;
- linked-PR chips;
- a "Move to" picker;
- item details with comments and the parent;
- an opt-in "move to next column?" nudge;
- "start a workspace" and "start an agent" on an item.

The **full-tab team board** has vertical columns with drag-and-drop and collapsed swimlanes.

**Architecture:** This builds on Plan 1's worker.
- **ADO layer.** New pure modules under `worker/ado/` for backlog config, board config, WIQL, batch hydration, moves, details and PR-link status. Each takes the authenticated `AdoHttp` from `connections.http`.
- **Boards service** (`worker/boards/service.ts`). It owns caching, a polling scheduler (fast for what is visible, slow in the background) and the `work.*` panel handlers. It posts `work.changed`.
- **Work tab.** A components view under `src/panel/work/`, plugged into Plan 1's `TabBody`.
- **Board.** An isolated-frame custom editor (`src/board/`) for `.adoboard` files. The worker opens it with `editor.open` on a small self-ignoring backing file in the focused workspace; `contributes.newFiles` is the fallback.
- **Workspace integration.** Hooks (`workspace.create.before/after`, `agent.prompt.before`) plus `agent.launch`.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`), the Orca components runtime, isolated frames, `orca/testing`, and ADO REST `api-version=7.1` (comments `7.1-preview.4`, policy evaluations `7.1-preview.1`).

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md` (§3 reference workflow, §4.1–4.2, §5.2, §5.7, §6 calls). **Plan 1** (foundation, already merged): `docs/superpowers/plans/2026-11-03-plan-1-foundation.md`.

## Global Constraints

Everything in Plan 1's Global Constraints still binds: credentials, the generic rule, repo hygiene, comments, and never approving on the user's behalf. Additions:

- **Capabilities added by this plan:** `workspace:read`, `workspace:write`, `agent:read`, `agent:launch`. `contributes.events: [{ "on": "agent.status.changed" }]`. `contributes.hooks`: `workspace.create.before`, `workspace.create.after`, `agent.prompt.before`, all `onError: "pass"`.
- **Hooks decide within 2 s, using only in-memory state.** No network call is awaited inside a hook handler.
- **ADO endpoints** (base `https://dev.azure.com/{org}`). The Plan 1 client builds the URLs; team-scoped paths use `/{project}/{team}/_apis/...`:
  - backlog config: `GET /{project}/{team}/_apis/work/backlogconfiguration`
  - boards: `GET /{project}/{team}/_apis/work/boards` and `/{id}`
  - team areas: `GET /{project}/{team}/_apis/work/teamsettings/teamfieldvalues`
  - type states: `GET /{project}/_apis/wit/workitemtypes/{type}/states`
  - WIQL: `POST /{project}/{team}/_apis/wit/wiql?$top=500`
  - hydration: `POST /{project}/_apis/wit/workitemsbatch` with `{ ids, $expand: "relations" }` (no `fields`; ADO refuses both), at most 200 ids per call
  - update: `PATCH /{project}/_apis/wit/workitems/{id}` with `application/json-patch+json`
  - comments: `GET|POST /{project}/_apis/wit/workItems/{id}/comments` at `7.1-preview.4`
  - PR by id: `GET /{project}/_apis/git/pullrequests/{id}`
  - policy evaluations: `GET /{project}/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` at `7.1-preview.1`
- **Nothing about a process is hard-coded.** Columns, states, lanes, work item types, the done column, branch names and state categories always come from ADO. Fixtures use `contoso`, `Fabrikam Web` and similar.
- **Polling budget.**
  - "My work": 60 s while the Work tab is visible, 5 min in the background.
  - An open board tab: 30 s.
  - PR chip status: cached 2 min.
  - On `rate_limited`, a job pauses for `retryAfterMs` (default 60 s).
  - Never more than one in-flight request per job.
- **Board backing file:** `<focused workspace>/.orca-ado/<org>.<teamId>.adoboard`. The folder holds a `.gitignore` containing `*`, so git never sees it. Its content is JSON `{ "org", "projectId", "teamId", "boardId" }`. Spec §7 makes this a spike, settled live with the user. The `contributes.newFiles` "Azure DevOps board" entry is the fallback and opens the same editor, which then asks which board.
- **Settings added:** `defaultAgent` (string, default `"claude"`, placeholder `claude`), `agentContext` (boolean, default `false`, title "Add work item context to agent prompts"), `branchTemplate` (string, default `"feature/{id}-{slug}"`).

## Review Focus

1. **A move made at the same time as someone else's edit.** The PATCH includes `test /rev`. A 412/409 reloads the item and says "Someone else changed this item. It's been refreshed; try again." It never silently overwrites. *Test: Task 5, `a stale rev is refused and the item is reloaded`.*
2. **A team board with split columns or a type mapped to no column.** Moves into a split column write the Doing/Done field. Items of types the board doesn't map go to "Other" and move by State only, never with a guessed column. *Tests: Task 5, `split column writes Column.Done=false` and `unmapped type moves by state only`.*
3. **Rate limiting during polling.** A `rate_limited` job pauses and keeps the last data with a muted "Updated N min ago". It never hammers or blanks the list. *Test: Task 1, `a rate-limited job waits retryAfterMs before running again`.*
4. **A hook firing while no item is armed, or after it expired.** The hook passes the event through unchanged in under 2 s. An armed branch name applies to exactly one workspace creation within 10 min. *Test: Task 11, `an expired or consumed arm passes the event through`.*
5. **Item text with HTML, images or huge descriptions.** Converted to Markdown without raw tags. Images become `[image]` links to the item. Text is capped to stay under the 64 KiB Markdown limit, with "… open in Azure DevOps for the rest". *Test: Task 3, `htmlToMarkdown caps and strips`.*

---

## File map

| File | Responsibility |
|------|----------------|
| `worker/poll/scheduler.ts` | Interval jobs with visibility, pause on rate limit, single-flight |
| `worker/ado/html.ts` | HTML → Markdown for descriptions and comments, with a length cap |
| `worker/ado/board-config.ts` | Backlog config, board list, board details, team areas, type states, with caching |
| `worker/ado/workitems.ts` | WIQL for "mine" and the board, batch hydration, `WorkItemSummary` mapping |
| `worker/ado/pr-links.ts` | Linked-PR status and validation build → chips |
| `worker/ado/move.ts` | Pure patch building for column and lane moves; sends the update |
| `worker/ado/details.ts` | Item details, comments list and add, parent |
| `worker/boards/service.ts` | Caching, polling, nudges, `work.*` handlers, `work.changed` posts |
| `worker/boards/board-file.ts` | Writing the self-ignoring backing file; `work.openBoard` |
| `worker/workspace/arm.ts`, `worker/workspace/hooks.ts`, `worker/workspace/agents.ts` | Arm-a-branch, hook handlers, agent launch, terminal↔workspace map |
| `src/shared/work.ts` | Work types shared by worker, panel and board |
| `src/panel/work/*.tsx` | Work tab: list, details, nudge, actions |
| `src/panel/org-settings.tsx` (modify) | "Suggest moves" rules editor |
| `src/board/board.html`, `src/board/board.ts`, `src/board/layout.ts`, `src/board/dnd.ts` | Board editor frame; pure layout and drop-target logic |

## Shared types (Task 2 defines them in `src/shared/work.ts`; used everywhere)

```ts
export type StateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed' | 'Removed'
export interface BoardColumn { id: string; name: string; isSplit: boolean; columnType: 'incoming' | 'inProgress' | 'outgoing'; stateMappings: Record<string, string> }
export interface BoardConfig {
  org: string; projectId: string; teamId: string; boardId: string; boardName: string
  requirementTypes: string[]                     // from backlog config (+ bugs when bugsBehavior = asRequirements)
  columns: BoardColumn[]; lanes: { id: string; name: string }[]
  fields: { column: string; columnDone: string; lane: string }   // WEF_* reference names
  areaPaths: { value: string; includeChildren: boolean }[]
  doneStates: Record<string, string[]>           // type → states in Completed/Removed categories
}
export interface PrChip { prId: number; repoId: string; projectId: string; target: string; state: 'open' | 'merged' | 'abandoned'; build: 'running' | 'succeeded' | 'failed' | 'none'; url: string }
export interface WorkItemSummary {
  org: string; id: number; rev: number; type: string; title: string; state: string
  column: string | null; columnDone: boolean; lane: string | null
  assignedTo: string | null; parentId: number | null; parentTitle: string | null
  changedAt: number; url: string; prs: PrChip[]
  targets: { columns: string[]; states: string[] }   // filled by the service from targetsFor (Task 5)
}
export interface Nudge { itemId: number; prId: number; branch: string; toColumn: string }
export interface WorkSnapshot { org: string; board: BoardConfig | null; mine: WorkItemSummary[]; other: WorkItemSummary[]; nudges: Nudge[]; updatedAt: number; stale: boolean; message?: string }
```

Protocol additions in `src/protocol.ts`:

```ts
'work.snapshot': { input: { org: string }; output: WorkSnapshot }
'work.refresh': { input: { org: string }; output: WorkSnapshot }
'work.details': { input: { org: string; id: number }; output: WorkItemDetails }
'work.move': { input: { org: string; id: number; rev: number; to: { column?: string; lane?: string; state?: string } }; output: WorkItemSummary }
'work.comment': { input: { org: string; id: number; text: string }; output: WorkComment }
'work.linkPr': { input: { org: string; id: number; rev: number; prUrl: string }; output: WorkItemSummary }
'work.board': { input: { org: string; projectId: string; teamId: string; boardId?: string; everyone: boolean }; output: { board: BoardConfig; items: WorkItemSummary[] } }
'work.openBoard': { input: { org: string }; output: { opened: boolean; message?: string } }
'work.dismissNudge': { input: { org: string; itemId: number; prId: number }; output: { ok: true } }
'work.nudgeRules': { input: { org: string; teamId: string; rules?: { branch: string; column: string }[] }; output: { rules: { branch: string; column: string }[] } }
'work.startWorkspace': { input: { org: string; id: number }; output: { branch: string; armedUntil: number } }
'work.startAgent': { input: { org: string; id: number }; output: { launched: boolean; message?: string } }
'ui.visibility': { input: { surface: 'work' | 'board'; org: string; visible: boolean }; output: { ok: true } }
// PluginPanelEvents
'work.changed': WorkSnapshot
```

`WorkItemDetails = { item: WorkItemSummary; descriptionMd: string; acceptanceMd: string; comments: WorkComment[]; links: { kind: string; title: string; url: string }[] }`
`WorkComment = { id: number; author: string; createdAt: number; textMd: string }`

---

### Task 0: Stopped commands settle on Linux (carried from Plan 1, ruling R34)

**Files:**
- Modify: `worker/sys/run.ts`.
- Test: `worker/sys/run.test.ts`.

**Why:** On Linux, az's `webbrowser` launches the browser in a new session holding az's stdout and stderr. A stopped command waits for pipe EOF and never settles. That leaves cancel, the login timeout and sign-out hanging, and the org's serial chain wedged.

**Required:**
- **Settle once the group is gone.** Once stopped (abort, timeout or `stopAllCommands`), a command settles as soon as its leader has exited and `process.kill(-pid, 0)` reports the group gone. It destroys stdout and stderr instead of waiting for EOF from a process outside the group. A command that was not stopped keeps today's behaviour.
- **Unregister after escalation.** Track whether the SIGKILL escalation has fired. Once it has, always remove the registry entry at close, so a later `stopAllCommands` never signals a stale or recycled pgid.
- **Spawn failures reject.** Attach the `error` listener before touching stdio, so a spawn that fails before creating stdio (EMFILE/ENFILE) rejects with the fixed message instead of crashing the worker.

- [ ] **Step 1: Write the failing tests.**
  - `a stopped command settles even when a process outside its group holds its pipes`: a non-exec wrapper starts a detached `setsid` holder (e.g. `perl -e 'use POSIX; setsid(); sleep 60' &`) that inherits fds 1 and 2, then sleeps. Abort → settles within 5 s. `pkill` the holder in `finally`.
  - `the registry forgets a group after SIGKILL escalation`.
  - `a spawn that fails before stdio rejects instead of crashing`: make `spawn` injectable, e.g. `createRunCommand(spawnFn)` with `runCommand` = the real one.
- [ ] **Step 2: Run.** `orca plugin test . --json`. Expected: the new tests FAIL (hang bounded by the test's own timeout, registry entry kept, uncaught error).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, with no leftover processes (`pgrep` for the test markers is empty).
- [ ] **Step 5: Commit** "Settle stopped commands when an outside process holds their pipes".

### Task 1: Polling scheduler

**Files:**
- Create: `worker/poll/scheduler.ts`.
- Test: `worker/poll/scheduler.test.ts`.

**Interfaces:**
- Produces:

```ts
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
export interface Job { key: string; visibleMs: number; backgroundMs: number; run(signal: AbortSignal): Promise<void> }
export interface Scheduler {
  upsert(job: Job): void                 // registers or replaces by key; first run is immediate
  remove(key: string): void
  setVisible(key: string, visible: boolean): void   // switches cadence; becoming visible runs now if last run is older than visibleMs
  runNow(key: string): Promise<void>     // single-flight: joins an in-flight run
  dispose(): void
}
export function createScheduler(clock: Clock): Scheduler
```

**Behaviour:**
- A job that throws an `AdoError` with code `rate_limited` waits `retryAfterMs` (default 60 000) before its next run. Any other error keeps the normal cadence.
- `dispose` aborts in-flight runs and clears all timers.

- [ ] **Step 1: Write the failing tests** (fake clock with manual `tick(ms)`).
  - `runs immediately then every backgroundMs`.
  - `visible jobs use visibleMs and run at once when they become visible and are stale`.
  - `a rate-limited job waits retryAfterMs before running again` (**Review Focus 3**).
  - `runNow joins an in-flight run instead of starting a second`.
  - `remove and dispose stop future runs and abort in-flight ones`.
- [ ] **Step 2: Run.** `orca plugin test . --json`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `createScheduler`.** A real clock wrapper is exported as `realClock`.
- [ ] **Step 4: Run.** Expected: PASS. `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Add the polling scheduler".

### Task 2: Shared work types and HTML → Markdown

**Files:**
- Create: `src/shared/work.ts` (types above), `worker/ado/html.ts`.
- Modify: `src/protocol.ts` (additions above).
- Test: `worker/ado/html.test.ts`.

**Interfaces:**
- Produces: `htmlToMarkdown(html: string | null | undefined, opts: { maxChars: number; itemUrl: string }): string`.

**Behaviour:**
- Converts `p`, `br`, `div`, `b`/`strong`, `i`/`em`, `a`, `ul`/`ol`/`li`, `code`/`pre`, `h1`–`h4`.
- `img` becomes `[image](itemUrl)`.
- Unknown tags are dropped and their text kept.
- Entities are decoded.
- Runs of blank lines collapse to one.
- Over `maxChars`, the text is cut at a line boundary and gets `\n\n… open in Azure DevOps for the rest`.

- [ ] **Step 1: Write the failing tests.**
  - `converts the common tags`, table-driven, including nested lists.
  - `htmlToMarkdown caps and strips` (**Review Focus 5**): a 100 KB description with `<script>` and `<img>` → output ≤ `maxChars` + suffix, no `<` tags, `[image](url)` present, and the suffix present.
  - `null and empty give ""`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** A small tokenizer, no dependency.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Add work types and HTML to Markdown".

### Task 3: Board configuration

**Files:**
- Create: `worker/ado/board-config.ts`.
- Test: `worker/ado/board-config.test.ts` with JSON fixtures in `worker/ado/fixtures/` (shaped like the real API responses: Agile process, one split column, two lanes, bugs as requirements).

**Interfaces:**
- Consumes: `AdoHttp` (Plan 1).
- Produces:

```ts
export function loadBoardConfig(http: AdoHttp, args: { org: string; projectId: string; teamId: string; boardId?: string }): Promise<BoardConfig>
export function listTeamBoards(http: AdoHttp, args: { org: string; projectId: string; teamId: string }): Promise<{ id: string; name: string }[]>
export function createBoardConfigCache(now: () => number, ttlMs?: number): { get(key: string): BoardConfig | undefined; set(key: string, cfg: BoardConfig): void; clear(): void }   // default 1 h
```

**Behaviour:**
- With no `boardId`, the board is the one whose `name` equals the backlog config's `requirementBacklog.name`.
- `requirementTypes` comes from `requirementBacklog.workItemTypes[].name`, plus the Bug type when `bugsBehavior === 'asRequirements'`.
- `doneStates[type]` lists the states whose category is Completed or Removed.

- [ ] **Step 1: Write the failing tests.**
  - `picks the requirement-level board by default`.
  - `maps columns, split flag, lanes and WEF field names`.
  - `adds Bug to requirementTypes only when bugs are requirements`.
  - `collects Completed and Removed states per type`.
  - `cache returns the same config within ttl`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Fetch backlog config, boards and team field values in parallel, then the board, then the states per type.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Read team board configuration".

### Task 4: Work items and PR chips

**Files:**
- Create: `worker/ado/workitems.ts`, `worker/ado/pr-links.ts`.
- Test: `worker/ado/workitems.test.ts`, `worker/ado/pr-links.test.ts`.

**Interfaces:**
- Produces:

```ts
export function wiqlMine(cfg: BoardConfig, allDoneStates: string[]): string
export function wiqlBoard(cfg: BoardConfig, everyone: boolean): string
export function queryIds(http: AdoHttp, org: string, projectId: string, teamId: string, wiql: string): Promise<number[]>
export function hydrate(http: AdoHttp, org: string, projectId: string, ids: number[]): Promise<RawWorkItem[]>   // 200 per call, keeps input order
export function toSummary(raw: RawWorkItem, cfg: BoardConfig, orgUrl: string): Omit<WorkItemSummary, 'prs' | 'parentTitle' | 'targets'> & { prRefs: PrRef[] }
export interface PrRef { projectId: string; repoId: string; prId: number }
export function parsePrRef(artifactUrl: string): PrRef | null   // vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}
export function loadPrChips(http: AdoHttp, org: string, refs: PrRef[], cache: Map<string, { at: number; chip: PrChip }>, now: () => number): Promise<PrChip[]>   // 2 min cache
```

**WIQL shapes** (exact clauses; values from config, quoted with `'`, and any `'` doubled):
- `wiqlMine`: `[System.AssignedTo] = @Me AND [System.State] NOT IN (<allDoneStates>)`, scoped to `[System.TeamProject] = @project`, ordered by `[System.ChangedDate] DESC`.
- `wiqlBoard`: `[System.WorkItemType] IN (<requirementTypes>)` plus the area clause from `areaPaths` (`UNDER` when `includeChildren`). `everyone=false` adds `AND [System.AssignedTo] = @Me`. Items in done states are included only when changed in the last 14 days.

**Chips:**
- `state` comes from PR `status`: `completed` → merged, `abandoned` → abandoned, otherwise open.
- `build` comes from the policy evaluation whose configuration type is "Build": `running` or `queued` → running, `approved` → succeeded, `rejected` → failed; no build policy → none.

- [ ] **Step 1: Write the failing tests.**
  - `wiqlMine excludes done states and escapes quotes`.
  - `wiqlBoard adds the area clause and the me filter`.
  - `hydrate splits into 200-id batches and keeps order`.
  - `toSummary reads column, done flag, lane and parent from WEF fields`.
  - `parsePrRef decodes the artifact url and rejects others`.
  - `loadPrChips maps status and build policy, and caches for 2 min`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Query work items and linked PR status".

### Task 5: Moving items

**Files:**
- Create: `worker/ado/move.ts`.
- Test: `worker/ado/move.test.ts`.

**Interfaces:**
- Produces:

```ts
export type MoveTarget = { column?: string; lane?: string; state?: string }
export function targetsFor(item: WorkItemSummary, cfg: BoardConfig): { columns: string[]; lanes: string[]; states: string[] }
export function buildMovePatch(item: WorkItemSummary, cfg: BoardConfig, to: MoveTarget): { op: 'test' | 'replace'; path: string; value: unknown }[]
export function moveItem(http: AdoHttp, org: string, projectId: string, item: WorkItemSummary, cfg: BoardConfig, to: MoveTarget): Promise<number>   // returns new rev
```

**Rules:**
- The patch always starts with `{ op: 'test', path: '/rev', value: item.rev }`.
- **Column move:**
  - `/fields/System.State` = `stateMappings[item.type]`.
  - `/fields/<cfg.fields.column>` = the column name.
  - For split columns, `/fields/<cfg.fields.columnDone>` = `false`.
- **Lane move:** `/fields/<cfg.fields.lane>` = the lane name (the default lane is the empty string).
- **Unmapped type** (the board has no mapping for it): only `{ state }` targets are allowed, using `System.State`. A column target throws `AdoError('bad_request', 400, 'This item type isn\'t on the board. Move it by state instead.')`.
- **412/409** from the PATCH become `AdoError('conflict', 409, "Someone else changed this item. It's been refreshed; try again.")`.

- [ ] **Step 1: Write the failing tests.**
  - `column move sets state and the WEF column`.
  - `split column writes Column.Done=false` (**Review Focus 2**).
  - `lane move writes only the lane field`.
  - `unmapped type moves by state only` (**Review Focus 2**).
  - `a stale rev is refused and the item is reloaded`: `moveItem` maps 412 to the conflict error (**Review Focus 1**; the reload is the service's job, asserted in Task 7).
  - `targetsFor lists only columns that map the item's type`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Move work items between columns and lanes".

### Task 6: Item details and comments

**Files:**
- Create: `worker/ado/details.ts`.
- Test: `worker/ado/details.test.ts`.

**Interfaces:**
- Produces:
  - `loadDetails(http, org, projectId, summary: WorkItemSummary, raw: RawWorkItem): Promise<WorkItemDetails>`
  - `addComment(http, org, projectId, id: number, text: string): Promise<WorkComment>`
  - `linkPr(http, org, projectId, id: number, rev: number, prUrl: string): Promise<number>`: accepts a PR web URL (`…/_git/<repo>/pullrequest/<n>`), resolves the repo and project ids via `GET /{project}/_apis/git/repositories/{repo}/pullrequests/{n}`, and PATCHes `test /rev` + `add /relations/-` `{ rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}', attributes: { name: 'Pull Request' } }`. Returns the new rev. A URL that isn't an ADO PR URL → `AdoError('bad_request', 400, "That isn't an Azure DevOps pull request link.")`.

**Behaviour:**
- `descriptionMd` comes from `System.Description` and `acceptanceMd` from `Microsoft.VSTS.Common.AcceptanceCriteria`, both through `htmlToMarkdown`, capped at 30 000 characters each.
- Comments are the newest 50, each text capped at 4 000 characters.
- `links` lists parent, children, related and PR relations with titles where cheap: the parent's title comes from one batch call.
- `addComment` rejects empty or whitespace-only text with "Write a comment first."; it posts `{ text }` with the text HTML-escaped and newlines turned into `<br>`.

- [ ] **Step 1: Write the failing tests.**
  - `details convert description and acceptance criteria`.
  - `comments are newest first, capped and converted`.
  - `addComment escapes HTML and refuses empty text`.
  - `linkPr adds an ArtifactLink relation with the rev test and rejects non-PR URLs`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Load item details and comments".

### Task 7: Boards service and handlers

**Files:**
- Create: `worker/boards/service.ts`.
- Modify: `worker/main.ts` (wire it in, register the `work.*` and `ui.visibility` handlers).
- Test: `worker/boards/service.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–6, Plan 1's `Connections` (`http`, `list()`).
- Produces: `createBoardsService(deps: { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; store: StorePort; scheduler: Scheduler; post: (s: WorkSnapshot) => void; now: () => number }): BoardsService`, with the methods behind each `work.*` handler.

**Behaviour:**
- **Jobs.** One scheduler job per connected org with `boards` set: key `mine:<org>`, `visibleMs` 60 000, `backgroundMs` 300 000. `ui.visibility` toggles it.
- **Snapshot.**
  - `mine` holds items on the board (type in `requirementTypes`); `other` holds the rest.
  - Parent titles come from one batch call.
  - Chips come from `loadPrChips`.
  - On failure the last snapshot is kept, with `stale: true` and `message`, and still posted.
- **Nudges.**
  - Rules live in storage `nudgeRules:<org>:<teamId>` as `{ branch, column }[]`, empty by default (off).
  - A nudge is produced for an item with a merged chip whose `target` matches a rule's branch (`refs/heads/` prefix ignored) when the item's column comes before the rule's column in board order.
  - Dismissed `itemId:prId` pairs live in storage `nudgeDismissed:<org>`, capped at 500 with the oldest dropped.
- **`work.move`.**
  - Reloads the item by id (batch) before patching if the cached `rev` is older than the input `rev`.
  - On conflict it re-hydrates the item, updates the snapshot, posts, and rethrows the conflict error.
- **`work.board`.** Loads with the 30 s cadence while a board surface is visible (job `board:<org>:<teamId>:<boardId>`).
- **Orgs without `boards`.** `work.snapshot` returns `{ board: null, message: "Pick a boards project and team in this org's settings." }`.
- **Jobs only for connected orgs** (Plan 1 final-review contract). The service subscribes to Plan 1's org status changes: wire `post` in `main.ts` so connections publish to both the panel and `boards.onOrgs(orgs)`. It keeps `mine:<org>` jobs only for orgs whose state is `connected`, removing them otherwise. A token cool-down or block from Plan 1 then never turns into a polling storm.
- **Missing scope for PR chips.** A `forbidden` while loading PR chips disables chips for that org for 10 minutes and sets the snapshot `message` to "Linked PR status needs Code (Read) access." The items still show; it doesn't retry every tick (the final review's R18 cost note).
- **Tidy `main.ts` as it grows.** Move Plan 1's board, team and project resolution helpers from `worker/main.ts` into `worker/ado/core.ts` (`resolveBoards`, `resolveProjects`), keeping the handlers' behaviour and tests green.

- [ ] **Step 1: Write the failing tests** (fake `AdoHttp` returning the Task 3/4 fixtures; fake scheduler or real one with a fake clock).
  - `snapshot splits mine and other and attaches chips and parents`.
  - `a failed refresh keeps the last snapshot as stale`.
  - `nudge appears for a merged PR into a ruled branch and not after dismissal`.
  - `no rules means no nudges`.
  - `move conflict refreshes the item and rethrows` (**Review Focus 1**).
  - `orgs without boards get the settings message`.
  - `visibility switches the job cadence`.
  - `jobs follow org status: added when connected, removed otherwise`.
  - `a forbidden PR-chip load disables chips for 10 minutes with the scope message`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and `orca plugin check . --json` pass.
- [ ] **Step 5: Commit** "Serve work items to the panel with polling and nudges".

### Task 8: Work tab in the sidebar

**Files:**
- Create: `src/panel/work/work-tab.tsx`, `src/panel/work/item-card.tsx`, `src/panel/work/item-details.tsx`, `src/panel/work/state.ts`.
- Modify: `src/panel/panel.tsx` (`TabBody` renders `WorkTab` for `work`), `src/panel/panel.check.ts` (add a `work` scenario).
- Test: `src/panel/work/work-tab.test.tsx`.

**UI** (exact copy):
- **Header** `Row`:
  - `Badge` with the board name.
  - `Text` muted: "Updated <RelativeTime>". When `stale`, `Text tone="warning"` with the message.
  - `IconButton` refresh (label "Refresh") → `work.refresh`.
  - `IconButton` open-external (label "Open board") → `work.openBoard`; its message is shown in a `Callout` when `opened` is false.
- **Nudges:** one accent `Callout` per nudge, titled "#<id> — PR <prId> merged into <branch>", with `Button` "Move to <column>" (→ `work.move`) and `Button` variant ghost "Dismiss" (→ `work.dismissNudge`).
- **Groups:** one `Collapsible` per board column that has items (title `<column> (<n>)`, open by default), then "Other (<n>)" when `other` is non-empty. Each item is a `Card`:
  - title: the item title;
  - description: `<type> #<id>`;
  - a `Row` of chip `Badge`s: `<target> ✓` success for merged, `<target> ·` neutral for open, `<target> ● build` warning for running, `<target> ✗ build` danger for failed;
  - a `Select` "Move to" (`labelHidden`) with the options from the summary's `targets` (columns, plus states for unmapped types);
  - a `Button` ghost "Details".
- **Details view** (atom route, Back `IconButton`):
  - `Heading` with the title;
  - `KeyValue` type, state, column, assigned, parent;
  - `Markdown` description;
  - `Collapsible` "Acceptance criteria";
  - `Collapsible` "Comments (<n>)" containing a `Markdown` per comment, a `Textarea` "Add a comment" and a `Button` "Comment";
  - `Input` "Link a pull request" (placeholder: a PR link) and `Button` "Link" (→ `work.linkPr`);
  - `Row` with `Button` "Start a workspace", `Button` "Start an agent" and `Link` "Open in Azure DevOps".
- **Empty states:**
  - no `boards` set → `EmptyState` with the settings message and a `Button` "Open settings";
  - no items → `EmptyState` "Nothing assigned to you on this board".
- **Errors:** show `messageOf(error)` (Plan 1 rule: never branch on codes).

- [ ] **Step 1: Write the failing tests** (`mount` + `mockHost` requests).
  - `groups items by column in board order with an Other group`.
  - `chips show merge and build state`.
  - `Move to sends work.move with the item rev`.
  - `nudge Move and Dismiss call the right requests`.
  - `details shows description, acceptance and comments, and Comment posts`.
  - `stale snapshot shows the warning but keeps the items`.
  - `work.changed post replaces the list`.
  - `visibility changes call ui.visibility`: use `setup(ctx)` with `ctx.visible`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. `orca plugin check . --json` exits 0 with the new `work` scenario.
- [ ] **Step 5: Commit** "Add the Work tab".

### Task 9: Full-tab board editor

**Files:**
- Create: `src/board/board.html`, `src/board/board.ts`, `src/board/layout.ts`, `src/board/dnd.ts`, `worker/boards/board-file.ts`.
- Modify: `orca-plugin.json`:
  - `contributes.customEditors`: `{ id: "board", title: "Azure DevOps board", extensions: [".adoboard"], entry: "src/board/board.html", priority: "default", frame: "isolated" }`;
  - `contributes.newFiles`: `{ id: "board", title: "Azure DevOps board", extension: ".adoboard" }`;
  - capability `workspace:read`, `workspace:write`.
- Test: `src/board/layout.test.ts`, `src/board/dnd.test.ts`, `worker/boards/board-file.test.ts`.

**Interfaces:**

```ts
// layout.ts (pure)
export interface Lane { id: string; name: string; collapsed: boolean; cells: Record<string, WorkItemSummary[]> }   // by column name
export function layoutBoard(cfg: BoardConfig, items: WorkItemSummary[], collapsed: ReadonlySet<string>): { columns: string[]; lanes: Lane[] }   // lanes only if cfg.lanes.length > 1; first lane open, others collapsed unless toggled
// dnd.ts (pure)
export interface Rect { left: number; top: number; width: number; height: number }
export function dropTarget(point: { x: number; y: number }, cells: { column: string; lane: string; rect: Rect }[]): { column: string; lane: string } | null
export function moveFor(item: WorkItemSummary, target: { column: string; lane: string }, cfg: BoardConfig): MoveTarget | null   // null when dropped on its own cell or a column the type doesn't map
// board-file.ts
export function boardFilePath(workspacePath: string, org: string, teamId: string): string   // <ws>/.orca-ado/<org>.<teamId>.adoboard
export function writeBoardFile(fs, workspacePath: string, content: { org: string; projectId: string; teamId: string; boardId: string }): Promise<string>   // also writes .orca-ado/.gitignore with "*\n" if missing
export type HostCall = (method: string, params?: unknown) => Promise<any>
export function openBoard(deps: { call: HostCall; fs: Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile' | 'readFile'>; boardOf: (org: string) => Promise<{ projectId: string; teamId: string; boardId: string } | null> }, org: string): Promise<{ opened: boolean; message?: string }>
```

**`openBoard` flow:**
1. `workspace.readContext`.
2. Match it to `workspace.list` by name and branch.
3. Write the file.
4. `editor.open({ workspaceId, path })`.

When there is no focused workspace or the workspace is remote (`hostId` set), it returns `{ opened: false, message: "Open a local workspace first, or use + → Azure DevOps board." }`.

**Editor frame (`board.ts`):**
- On load it reads the document text (JSON). If that's empty or invalid (the `newFiles` case), it shows a small picker: org, then board, via `work.snapshot` / the org list.
- It calls `work.board`, then renders:
  - vertical columns (header `name (n)`);
  - collapsed lanes as clickable headers;
  - cards with type, id, title, assignee initials and chips.
- Pointer-event drag-and-drop uses `dropTarget` and `moveFor`, then `work.move`.
  - The move is optimistic, reverted on error, and the error is shown in a top banner.
- A "Me / Everyone" toggle, and a "Parent" filter (all, or one of the parents present on the board, by `parentTitle`), because the spec's hierarchy is visible and filterable.
- Styling comes only from `--orca-*` variables, re-applied on `theme`.
- It never edits the document; it only reads it.
- It reports visibility via `ui.visibility` on `visibilitychange`.

- [ ] **Step 1: Write the failing tests.**
  - `layoutBoard puts items in their column and lane in board order`.
  - `layoutBoard hides lanes when the board has one`.
  - `dropTarget finds the cell under the pointer and null outside`.
  - `moveFor returns null for own cell and unmapped columns`.
  - `writeBoardFile writes the file and a self-ignoring .gitignore`: real fs in a temp dir, `git check-ignore` not needed; assert the contents.
  - `openBoard refuses remote or missing workspaces with the message`: `mountWorker`-style mock host answers.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `orca plugin check . --json` statically checks the editor (syntax, files, imports) and must exit 0.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Add the full-tab board".

### Task 10: "Suggest moves" rules in org settings

**Files:**
- Modify: `src/panel/org-settings.tsx`, `worker/main.ts` (the `work.nudgeRules` handler; Task 7's service already stores the rules).
- Test: `src/panel/panel.test.tsx` (add cases).

**UI:** a `Collapsible` "Suggest moves" (closed by default), shown when the org has a boards team. It lists rules as rows: `Input` "Branch" (placeholder `uat`) → `Select` "Column" (the board's columns) → `IconButton` remove. Below them, `Button` "Add rule" and `Button` "Save rules" (→ `work.nudgeRules` with `rules`). Helper text: "When a linked PR merges into this branch, suggest moving the item to this column."

- [ ] **Step 1: Write the failing tests.**
  - `rules load, edit and save`.
  - `empty branch rows are not saved`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Let teams opt in to move suggestions".

### Task 11: Workspaces and agents for work items

**Files:**
- Create: `worker/workspace/arm.ts`, `worker/workspace/hooks.ts`, `worker/workspace/agents.ts`.
- Modify: `orca-plugin.json` (hooks, events, capabilities `agent:read` and `agent:launch`, and the settings `defaultAgent`, `agentContext`, `branchTemplate`), `worker/main.ts`.
- Test: `worker/workspace/*.test.ts`.

**Interfaces:**

```ts
export function branchFor(template: string, item: { id: number; title: string }): string   // {id}, {slug}: lower-case ascii, non-alnum → '-', trimmed, ≤ 40 chars
export function createArm(now: () => number): { arm(a: { org: string; itemId: number; branch: string }): number; take(): { org: string; itemId: number; branch: string } | null }   // single use, 10 min
export interface ContextCache { record(terminalId: string, workspaceId: string): void; workspaceOf(terminalId: string): string | null }   // fed by agent.status.changed
export function registerWorkspaceHooks(orca: OrcaWorkerApi, deps: { arm: ReturnType<typeof createArm>; links: LinkStore; context: ContextCache; itemInfo: (org: string, itemId: number) => { type: string; title: string; url: string } | null; agentContext: () => boolean }): void   // itemInfo reads the boards service's cached snapshot
export interface LinkStore { link(workspaceId: string, ref: { org: string; itemId: number }): Promise<void>; byWorkspace(id: string): { org: string; itemId: number } | null }   // storage key "workspaceLinks", loaded into memory at activate
export function itemPrompt(details: WorkItemDetails, maxChars?: number): string   // default 4000
```

**Behaviour:**
- **`work.startWorkspace`.** Computes the branch from `branchTemplate`, arms it, and returns `{ branch, armedUntil }`. The panel then shows a `Callout`: "Create a new workspace in Orca now. Its branch will be named <branch>." Creating the workspace is the user's one visible step (spec §5.7).
- **`workspace.create.before`.** If an arm is live, it takes it and returns `next({ ...event, branch, name: <branch> })`. Otherwise it passes. It is in-memory only, under 2 s.
- **`workspace.create.after`.** If the last arm consumed within 30 s matches, it links `workspaceId` → item.
- **`work.startAgent`.**
  1. Finds the item's linked workspace, or else the focused workspace (matched via `workspace.list`).
  2. Builds `itemPrompt`.
  3. Calls `agent.launch({ workspaceId, agent: defaultAgent, prompt })`.
  4. Returns `{ launched: true }`, or `{ launched: false, message }` when there is no workspace.
- **`agent.prompt.before`.**
  - Only when `agentContext` is true and the prompt's terminal belongs to a linked workspace. The terminal → workspace map comes from `agent.status.changed` events (`workspaceId`, `terminalId`).
  - It prefixes `[ADO <type> #<id>: <title>](<url>)\n\n` to the prompt, once: it skips the prompt if the prefix is already present.
  - Uses only cached data.

- [ ] **Step 1: Write the failing tests** (`mountWorker(worker, { hooks: [...], events: [...] })`, `w.hooks.fire(...)`, `w.emit(...)`).
  - `branchFor slugs titles and respects the template`.
  - `an armed branch renames exactly one workspace creation`.
  - `an expired or consumed arm passes the event through` (**Review Focus 4**).
  - `create.after links the workspace to the item`.
  - `startAgent launches the default agent with the item prompt`.
  - `startAgent without a workspace returns the message`.
  - `prompt context is added only when enabled and linked, and only once`.
  - `hooks answer without awaiting the network`: the fake http rejects if called during a hook.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes, and `orca plugin validate . --json` exits 0 with the hooks.
- [ ] **Step 5: Commit** "Start workspaces and agents from work items".

### Task 12: Verification and README

- [ ] **Step 1: Run the full offline suite.** `orca plugin validate . --json`, `npm run typecheck`, `orca plugin test . --json` and `orca plugin check . --json` all pass.
- [ ] **Step 2: Update the README.** The Work tab and board are under "What works now", with the move rules, nudges and agent settings, and a note that the board file lives in a self-ignored `.orca-ado/` folder of the workspace. PAT scopes: add Work Items Read & Write (`vso.work_write`) and Code Read (`vso.code`) for PR chips, hedged like Plan 1's list.
- [ ] **Step 3: Live checks with the user** (deferred until the user is present and their sandbox org exists; mocks cover everything else):
  - (a) The board opens via `editor.open` and `git status` stays clean.
  - (b) Drag-and-drop moves a card in the sandbox.
  - (c) A split column writes Doing/Done correctly.
  - (d) The workspace hook names the branch.
  - (e) `agent.launch` starts the default agent with the prompt.
- [ ] **Step 4: Commit and report** which spikes were settled.
