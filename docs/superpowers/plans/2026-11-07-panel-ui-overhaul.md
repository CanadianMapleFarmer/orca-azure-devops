# Sidebar panel UI overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar's four tabs calm and readable at 360 px: PRs and Pipelines grouped by project (and repository when it matters), Work laid out like the board with tasks under their parent, a Wiki tree that tells folders from pages, and a full-width wiki reader with Mermaid drawn.

**Architecture:**
- **Shared panel pieces first** (Tasks 1–2): one grouping rule for PRs and Pipelines (`src/panel/grouping.ts`), remembered fold state with Collapse all and Expand all (`src/panel/folds.ts`), remembered pickers and views (`src/panel/prefs.ts`), and three components: the tab toolbar, the group header and chips.
- **Each tab is its own task** and ships alone: the stage chip fix (Task 3), Pipelines (4), PRs (5), Work data (6), Work Columns (7), Work Lanes (8), Wiki tree (9), the reader (10) and the sidebar page (11).
- **Data additions are the ones design §6 allows**: Work reads the parents of tasks that are not listed (already read today for titles) and, in one batched `fields` read, the child tasks of listed items and of those parents (§5.4: every child task of the parent); the default board carries its task types. PRs and Pipelines need no worker change: `PrSummary` and `RunSummary` already carry the project and repository.
- **Open in tab** is Orca's own Markdown view of a git-ignored, read-only copy (Option A) or, if Task 0's S1 rules that out, a new isolated custom editor with a vendored renderer (Option B). If no Mermaid build fits a frame either, Option C is that editor with diagrams shown as source, and the author decides before Task 10 starts. Task 10 carries every branch; S1 picks one.
- **State that must survive a reload** (open groups, view, project and repository, wiki folders) lives in `persist: 'plugin'` atoms keyed by organisation, the scope `activeOrg` and `wikiChoice` already prove at the 1.4.248 floor.

**Baseline:** `4bb5855` ("Design the sidebar panel UI overhaul") on `feat/ui-overhaul`. Plans 1–6 are built.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`), Orca components (`Collapsible`, `Tree`, `Select`, `Badge`, `Card`, `Box`, `Markdown`), `orca/testing` (`mount`, `mockHost`, `defineCheck`), ADO REST 7.1 (`wit/workitemsbatch`, `work/backlogconfiguration`), `editor.open`.

**Spec:** `docs/superpowers/specs/2026-11-07-panel-ui-overhaul-design.md` (binding; §5 the design, §6 constraints, §7 left to the builder, §8 done means). Base product spec: `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md`. The approved mock-ups are local, git-ignored files with private data: read them for intent only and copy nothing from them.

## Global Constraints

Plans 1–6's Global Constraints still bind. Every commit ends with a blank line and a `Co-Authored-By:` trailer.

- **Never** run `orca plugin dev load|watch|reload`, `enable` or `--approve`. Never push, merge, tag or publish; the author pushes.
- **Worker limits.** The worker never runs the `orca` CLI.
- **Secrets.** No token, PAT, `Authorization` value or webhook URL outside `orca.secrets`.
- **Tests fake ADO** with the existing fakes and fixtures (`fakeAdo()` with `on`, `hold`, `hang`, `count`, `calls`; never `clear()`). Live checks wait for Task 13, with the author present.
- **Copy and errors.** Only error messages reach the UI (`messageOf(error)`). Copy is single-sourced: worker copy in `worker/messages.ts`, shared copy in `src/shared/messages.ts`, panel copy used by more than one panel file in `src/panel/copy.ts` (new), other panel copy beside its one user. New copy uses British spelling and plain words; existing strings change only where this plan says.
- **Panel state.** Per-row state is keyed by id (PR ids, set key, approval id, build id, work item id, page path, group key), never by list position. State that survives a reload uses `persist: 'plugin'` atoms whose values are keyed by organisation. No timers outside the scheduler; the panel never polls.
- **Loads.** Each worker load runs under its linked abort (`linkedAbort` / `OrgLoad` / the scheduler's signal) and passes it down with `withSignal`.
- **Mounted tests** end with `closeCleanly(panel)` where they render a tab: `panel.errors`, `panel.warnings` and `panel.refusals` stay empty.
- **Orca's catalogue only**, as typed in `.orca/types/orca/index.d.ts`, using only props available at 1.4.248 (Task 0 S3). Icons only from `IconName`. A `ListItem` with `onPress` holds no other control. No `Box` used as a drawn graphic (its tinted backgrounds are what drew the empty stage bars).
- **Panel limits:** 5,000 nodes, 512 KiB of tree data, 1 KiB per label, 64 KiB per Markdown, 500 Select options, 2,000 Tree items, Tree depth 16. Budget tests keep a tab under **4,000 nodes and 450 KiB** and assert both, as `src/panel/prs/review/review-view.test.tsx:635-636` does: `countNodes(panel.tree()) < 4_000` and `new TextEncoder().encode(JSON.stringify(panel.tree())).length < 450 * 1024`. `closeCleanly` alone only catches Orca's own refusals. Posts stay under `POST_BUDGET_BYTES` (240 KiB), answers under `ANSWER_BUDGET_BYTES` (900 KiB).
- **Behaviour, polling, notifications and settings stay as they are**, except the data additions design §6 allows. No new capabilities, settings or hooks. The only possible new manifest entry is the custom editor of Option B or C.
- **Frames** import only `orca/*` and relative files: no npm packages. Each transpiled file stays under 1 MiB.
- **Code:** zero code comments by default. **Generic data only:** fixtures use `contoso`, `Fabrikam Web`, `fabrikam-api`, `web-app`, Ada Lovelace, Grace Hopper, Alex Contoso, Alan Turing. Nothing from the author's organisation appears in code, fixtures, docs or commit messages.
- **Verification** means `npm run typecheck`, `orca plugin test . --json` (exit 0, TAP `# fail 0`), `orca plugin validate . --json` and `orca plugin check . --json`.

## Review Focus

1. **The child task read fails or partly fails** (403 on another project, 429, 500, a timeout). The Work tab still lists every item, task lists are simply absent, and the snapshot says why. *Test:* T6 `a failed children read still posts the items, with no task lists and a message`.
2. **A remembered project or repository no longer matches the data** (the project left the code projects, its last PR merged, the org changed). The tab shows All projects, the picker says All projects, nothing is hidden silently, and the remembered choice comes back when the project does. *Tests:* T1 `a remembered project or repo that is no longer in the data falls back to All without forgetting it`; T4 and T5 `a remembered project with nothing in it now shows All projects`.
3. **Names that collide or run long:** two repositories called `web-app` in two projects, a pipeline named the same in three projects, a 2 KB project or lane name. Groups key by id, every card sits under its own project, and labels are cut to 1 KiB. *Tests:* T1 `groups are keyed by id, so same-named repos in two projects stay apart, ordered by name`; T2 `a group title and hint over 1 KiB are cut to the label limit`.
4. **Odd work hierarchies:** a task whose parent can't be read, a task under a task (yours or someone else's), a parent that is both listed and the parent of someone else's task, my task cut from its parent's posted list. Every task sits under its parent, whatever its type (design §5.4). Every task of mine shows exactly once as a row or a card. A parent that can't be read shows as a dimmed `#<id>` header. *Test:* T7 `every task of mine appears exactly once, wherever its parent is`.
5. **Awkward wiki content:** an unclosed `::: mermaid`, `::: mermaid` inside another fence, a table with escaped pipes and pipes in code spans, a 64-column table, CRLF lines. The sidebar never drops text outside diagrams and wide tables, and stays within Markdown limits. *Tests:* T10 `mermaidBlocks finds both forms, skips other fences and runs an unclosed block to the end`; T11 `pageSegments keeps every line outside diagrams and wide tables`.

---

## Shared types and remembered state

Tasks add these; the panel imports the shared ones, so they use no Node APIs.

```ts
// src/shared/work.ts (T6)
export const MAX_CHILD_TASKS = 20
export interface WorkTask { id: number; title: string; state: string; done: boolean; assignee: string | null; mine: boolean }  // assignee: display name, null when unassigned
export interface TaskList { parentId: number; tasks: WorkTask[]; total: number; done: number }
export interface WorkParent { id: number; type: string; title: string; state: string; column: string | null; lane: string | null }
export interface WorkFamilies { lists: TaskList[]; parents: WorkParent[] }
export const NO_FAMILIES: WorkFamilies                     // { lists: [], parents: [] }
// BoardConfig gains   taskTypes?: string[]                // set on the default-board path only
// WorkSnapshot gains  families: WorkFamilies
// src/shared/wiki-blocks.ts (T10, T11)
export interface MermaidBlock { first: number; last: number; colon: boolean; body: string }  // line indexes, inclusive
export function mermaidBlocks(lines: readonly string[]): MermaidBlock[]
export function toFencedMermaid(markdown: string): string
export function diagramKind(body: string): string
export function tableAt(lines: readonly string[], index: number): { columns: string[]; rows: string[][]; last: number } | null
export function isWideTable(columns: readonly string[], rows: readonly string[][]): boolean
```

`src/protocol.ts`: T10 adds `'wiki.openInTab': { input: WikiPageRef; output: { opened: boolean; message: string } }`. Options B and C also add `'wiki.read': { input: WikiPageRef; output: ReaderPage }` with `ReaderPage extends WikiPageRef { title: string; wikiName: string; url: string; markdown: string; notice?: string }` in `src/shared/wiki.ts`. No panel events change.

Remembered state (all `persist: 'plugin'`, `version: 1`, values read tolerantly):

| Atom key | Value | Owner |
|---|---|---|
| `folds` | `Record<"<org>\|<tab>", Folds>` | T1 `src/panel/folds.ts` |
| `prsPrefs` | `Record<org, { project: string \| null; repo: string \| null; view: 'mine' \| 'review' }>` | T1 `src/panel/prefs.ts` |
| `runsPrefs` | `Record<org, { project: string \| null; repo: string \| null }>` | T1 `src/panel/prefs.ts` |
| `workViews` | `Record<"<org>/<projectId>/<teamId>", 'columns' \| 'lanes'>` | T1 `src/panel/prefs.ts` |
| `wikiExpanded` | `Record<"<org>\|<wikiId>", string[]>` | T9 `src/panel/wiki/state.ts` |

`pipelinesFilter` (workspace) stays as it is. `toReviewOpen` and Work's `closedGroups` go.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/panel/grouping.ts` (new) | Project, repository, Across repos and Across projects grouping; picker choices; scope filter | 1, 4, 5 |
| `src/panel/folds.ts` | Existing `foldedAfter`, plus remembered `Folds` with Collapse all and Expand all | 1, 2, 4, 5, 7, 8 |
| `src/panel/prefs.ts` (new) | Remembered project, repository, PR view and Work view, per organisation or board | 1, 4, 5, 8 |
| `src/panel/copy.ts` (new) | Panel copy shared by several tabs | 1–11 |
| `src/panel/toolbar.tsx`, `group.tsx`, `chips.tsx` (new) | The tab toolbar, a group header, chips | 2, 4, 5, 7, 8 |
| `src/panel/test-support.ts` | `reloadPanel`, `mountPanel`'s `module` option and fixture defaults | 2, 6, 10 |
| `src/panel/pipelines/*` | Stage chips, grouped runs, calmer card | 3, 4 |
| `src/panel/prs/*`, `src/panel/prs/rows.ts` (new) | Grouped sets, Mine and To review, row chips | 5 |
| `src/shared/work.ts`, `worker/ado/board-config.ts`, `worker/ado/workitems.ts`, `worker/boards/{snapshot,service,fake-ado}.ts` | Task types, parents and child tasks | 6 |
| `src/panel/work/*`, `src/panel/work/{plan.ts,task-rows.tsx,fixtures.ts}` (new) | Compact cards, tasks under parents, Columns and Lanes | 7, 8 |
| `src/panel/wiki/*`, `src/panel/wiki/segments.ts` (new), `src/shared/wiki-blocks.ts` (new) | Tree, page header, diagram and table cards | 9, 10, 11 |
| `worker/panel-markdown.ts`, `worker/wiki/{service,reader,handlers,draft-files}.ts` | Mermaid blocks kept whole; the reader copy | 10 |
| `worker/messages.ts` | `TASKS_NOT_LOADED`; `openedReader` and the two reader banners | 6, 10 |
| `worker/main.ts`, `src/protocol.ts` | `wiki.openInTab` (and `wiki.read` for Options B and C) | 10 |
| Option A only: `worker/tab-files.ts` | `ensureTabFolder`, shared with `writeTabFile` | 10 |
| Options B and C only: `orca-plugin.json`, `src/reader/*`, `src/shared/wiki.ts`, `THIRD_PARTY_NOTICES.md` (B) | The wiki reader editor | 10 |
| `src/panel/panel.check.ts` | Check scenarios for each tab | 3–11 |
| `README.md`, `worker/readme.test.ts` | Docs | 12 |
| `docs/superpowers/spikes/2026-11-07-panel-ui-overhaul.md` (new) | Spike record | 0, 13 |

---

### Task 0: Spikes and baseline re-check

**Files:** `docs/superpowers/spikes/2026-11-07-panel-ui-overhaul.md` in Plan 5's shape: one table per spike with rows "Question · Method · Result · Decision", live rows marked **pending live**; probes kept outside the repo (the session scratchpad); bundle reads read-only with `python3 -I`. Fixture: `worker/ado/fixtures/workitems-children.json`.

- [ ] **Step 1: Baseline re-check.** At `4bb5855`, re-read every "Consumes" signature in Tasks 1–12 and the exports of every file in the File Structure table. Record each drift as "cited · actual · tasks affected" and send interface drift to the controller before Task 1. Answer:
  - (a) Which tests pin copy or structure this plan changes? List them by file and test name, checked against the "Changes" lines of Tasks 3–11.
  - (b) Which worker tests assert exact request lists or batch counts for a mine load? The children read happens only when some child link exists, so they should stay green.
  - (c) Does anything besides the Work tab read `WorkSnapshot.other` (board tab, nudges, status bar)?
  - (d) Is `MAX_STAGE_CHIPS` still enforced in `worker/pipelines/service.ts` before posting, so the panel never sees more than 12 stages?
  - (e) Every literal of `WorkSnapshot` and `BoardConfig` in `src/` and `worker/`.
- [ ] **Step 2: S1 Open in tab with Orca's own preview.** Read `.orca/types/orca-host/index.d.ts` (`editor.open` takes `{ workspaceId, path }` only), `orca skills get orca-plugin-authoring --reference references/host-api.md`, and read-only the bundle under `/Applications/Orca.app/Contents/Resources/` (renderer assets are in `app.asar.unpacked/out/renderer/assets/`; start with `EditorPanel-*.js`, `store-*.js`, `MarkdownPreview*.js`, `RichMarkdownEditor-*.js`, `mermaid*.js`, `markdown-navigation-details-*.js`). Record:
  - (a) the values of `markdownDefaultViewMode`, its default, and which mode a file opened through `editor.open` starts in;
  - (b) which modes draw Mermaid, and which Mermaid source form they accept (fenced `mermaid`, `::: mermaid`);
  - (c) how `fileContents[id].readOnly` is decided, and whether a file without write permission (mode `0o444`) opens read-only, or its save fails and how;
  - (d) whether that view offers heading navigation (an outline), or at least `#anchor` links to headings;
  - (e) how tables are laid out at full width.
  - **Decide:**
    - **Option A** when a newly opened `.md` shows rendered, with Mermaid drawn, under Orca's default settings, can't be saved over, and headings can be navigated (an outline, or anchors a contents list can use).
    - Otherwise **Option B** when a vendored Mermaid build fits a frame: every file under the 1 MiB transpile limit, and the plugin still under 2,000 files and 50 MiB. Record the renderer's files, the largest file, the total size and the licences.
    - Otherwise **Option C**: the Option B editor without a diagram renderer. It lays out Markdown and tables and shows each diagram as its source with "This diagram couldn't be drawn." That misses design §8 ("Mermaid diagrams drawn"), so report it to the author with the sizes found, and start Task 10 only after they answer.
- [ ] **Step 3: S2 Mermaid in ADO wiki pages.** From the ADO wiki Markdown reference and the existing fixtures, record: the `::: mermaid` form (opening line, closing `:::`, leading spaces, CRLF) and the fenced form; which diagram keywords ADO supports; front matter (`---`) and `%%` comment lines; what `panelMarkdown` does today to a sample body with `-->`, `[label]`, `A["<b>x</b>"]` and `<br/>`. **Decide** the conversion: for Option A, `::: mermaid` becomes a fenced block; for both, a colon block is kept whole like code (T10).
- [ ] **Step 4: S3 The catalogue at the 1.4.248 floor.** From `.orca/types/orca/index.d.ts` "Since" notes, `orca skills get orca-plugin-authoring --reference references/components.md` and `references/manifest.md`, confirm each prop this plan uses exists at 1.4.248: `Collapsible` `open`, `onChange`, `description`; `Tree` item `icon`, `description`, and `expanded`, `selected`; `Select` `labelHidden`; `Button` `tooltip` (1.4.247); `IconButton` `size="xs"`; `RelativeTime` `format`; `Box` (catalogue 4). Record:
  - which `PersistScope` values exist at the floor (the plan uses `'plugin'` regardless);
  - whether a closed `Collapsible`'s children are posted and count toward the node limit (the plan draws none either way);
  - why `Box width={14} height={6} background={tone}` drew empty grey bars (read the Box renderer), so no task repeats it.
- [ ] **Step 5: S4 Data each tab already has.** Record from `src/shared/*`, `worker/ado/*` and fixtures:
  - PRs: `projectId`, `projectName`, `repoId`, `repoName` on every `PrSummary` (sets, To review, Reviewed by you);
  - Pipelines: `projectId`, `projectName`, `repository: { id, name } | null`;
  - Work: `BoardConfig.lanes` (the default lane's `name` is `''`), each item's `lane` (null on the default lane), `parentId`, and the raw `relations` that `hydrate` already expands;
  - the backlog configuration's `taskBacklog.workItemTypes` (and whether bugs managed as tasks appear there);
  - the child link (`System.LinkTypes.Hierarchy-Forward`, url ending `/workItems/{id}`);
  - that `workitemsbatch` refuses `fields` together with `$expand`, and what a `fields` read returns for `System.AssignedTo` (`id`, `uniqueName`, `displayName`) and `System.Parent`;
  - that a `fields` read with `errorPolicy: 'omit'` answers `null` for an id the account can't read, as `hydrate`'s reads do, instead of failing the whole request.

  Write `workitems-children.json`: a `fields`-only batch answer with tasks 1207 (Active, Alex Contoso, parent 1204), 1209 (Closed, Grace Hopper, parent 1204), 1210 (New, unassigned, parent 1204) and 1211 (Removed, parent 1204).
- [ ] **Step 6: Pending live rows.** S1: Open in tab from a real page (rendered, Mermaid drawn, read-only, headings). S2: one real page in each Mermaid form. S4: the children read on the author's organisation, and the task types on a process with bugs managed as tasks. Every tab at 360 px in light and dark.
- [ ] **Step 7: Commit** "Record the panel overhaul spikes".

### Task 1: The grouping rule and remembered panel state

**Files:**
- **Create:** `src/panel/grouping.ts`, `src/panel/prefs.ts`, `src/panel/copy.ts`, `src/panel/grouping.test.ts`, `src/panel/folds.test.ts`.
- **Modify:** `src/panel/folds.ts` (keeps `foldedAfter`).

**Interfaces:**
- **Consumes:** `atom`, `read`, `update` from `orca`.
- **Produces:**

```ts
// src/panel/grouping.ts
export interface Place { projectId: string; projectName: string; repoId: string | null; repoName: string | null }
export interface RepoGroup<T> { key: string; repoName: string | null; items: T[] }            // repoName null: Across repos
export interface ProjectGroup<T> { key: string; projectId: string; projectName: string; repoName: string | null; repoCount: number; loose: T[]; repos: RepoGroup<T>[]; count: number }
export interface Grouped<T> { across: T[]; projects: ProjectGroup<T>[] }
export function groupByPlace<T>(items: readonly T[], places: (item: T) => readonly Place[]): Grouped<T>
export interface Scope { project: string | null; repo: string | null }
export interface Choices { projects: { id: string; name: string }[]; repos: { id: string; name: string }[]; scope: Scope }
export function choicesOf<T>(items: readonly T[], places: (item: T) => readonly Place[], stored: Scope): Choices
export function inScope<T>(items: readonly T[], places: (item: T) => readonly Place[], scope: Scope): T[]
// src/panel/folds.ts
export type FoldTab = 'work' | 'prs' | 'pipelines'
export interface Folds { all: 'open' | 'closed' | null; open: string[]; closed: string[] }
export const MAX_OVERRIDES = 300
export const folds: Atom<Record<string, Folds>>                       // key 'folds'
export function isOpenIn(state: Folds | undefined, key: string, natural: boolean): boolean
export function override(state: Folds | undefined, key: string, open: boolean): Folds
export function isFoldOpen(org: string, tab: FoldTab, key: string, natural?: boolean): boolean   // natural defaults to true
export function setFoldOpen(org: string, tab: FoldTab, key: string, open: boolean): void
export function setAllFolds(org: string, tab: FoldTab, open: boolean): void
// src/panel/prefs.ts
export type PrsView = 'mine' | 'review'
export type WorkView = 'columns' | 'lanes'
export const prsPrefs: Atom<Record<string, Scope & { view: PrsView }>>
export const runsPrefs: Atom<Record<string, Scope>>
export const workViews: Atom<Record<string, WorkView>>
export function scopeIn(all: Record<string, Partial<Scope>>, org: string): Scope
export function chooseProject<S extends Scope>(prefs: Atom<Record<string, S>>, org: string, project: string | null): void   // also clears repo
export function chooseRepo<S extends Scope>(prefs: Atom<Record<string, S>>, org: string, repo: string | null): void
// src/panel/copy.ts
export const COLLAPSE_ALL = 'Collapse all', EXPAND_ALL = 'Expand all', ALL_PROJECTS = 'All projects', ALL_REPOS = 'All repos'
export const ACROSS_PROJECTS = 'Across projects', ACROSS_REPOS = 'Across repos', OPEN_IN_TAB = 'Open in tab'
export const CHOOSE_ALL = 'Choose All projects to see everything.'
export function counted(count: number, one: string, many: string): string   // '1 set', '3 sets'
export function needYouHint(count: number): string                           // '1 needs you', '3 need you'
export function showMore(count: number): string                              // 'Show 25 more'
export function nothingIn(project: string): string                           // 'Nothing here for <project>'
export function repoCount(count: number): string                             // '3 repos'
```

**Rules for `groupByPlace`:**
- An item's places are made distinct by `(projectId, repoId)`. An item whose places span more than one project goes in `across` (key `across-projects`) and nowhere else.
- Projects are ordered by name (`localeCompare`, base sensitivity), then id; items keep their incoming order. A project's key is `project:<projectId>`; `count` is its item count.
- A project whose items name at most one repository is flat: `repoName` is that repository (or null), `repos` is empty, every item is in `loose`.
- A project whose items name several repositories gets `repoCount`, and:
  - items spanning repositories in an Across repos group first (`<projectKey>/across-repos`, `repoName: null`);
  - then one group per repository (`<projectKey>/repo:<repoId>`), ordered by name;
  - items with no repository in `loose`, drawn before the sub-groups.
- **`choicesOf`:** `projects` from every item's places, ordered by name; `repos` only when `stored.project` is among them and it has several repositories. `scope` is `stored` with any project or repository that isn't in the choices replaced by null. The stored value is never rewritten.
- **`inScope`** keeps an item when any of its places matches the project, and, when a repository is chosen, that repository.
- **`chooseProject` and `chooseRepo`** spread the organisation's previous entry, so a PR view stored beside the scope is kept.
- **Folds** store what was set by hand, not a difference from the default, because a default can change on its own (a task list's default turns closed once your last task is done):
  - `isOpenIn` is true when the key is in `open`, false when it is in `closed`, else `natural` when `all` is null, else `all === 'open'`.
  - `override` moves the key into `open` or `closed` (out of the other), keeping the newest `MAX_OVERRIDES` keys across both.
  - `setAllFolds` (Collapse all, Expand all) sets `all` and empties both lists.
  - Entries are keyed `"<org>|<tab>"`.

- [ ] **Step 1: Write the failing tests.**
  - `groupByPlace keeps a one-repo project flat and names the repo`
  - `groupByPlace splits a project into repo groups only when its items come from several repos`: keys, order and `repoCount` 2.
  - `an item spanning repos goes in Across repos at the top of its project, and one spanning projects in Across projects, never copied`: the cross-project item appears once in total.
  - `runs without a repository stay loose beside the repo groups`
  - (**Review Focus 3**) `groups are keyed by id, so same-named repos in two projects stay apart, ordered by name`: two `web-app` repositories in Fabrikam Web and Contoso Tools give `project:p1/repo:r1` and `project:p2/repo:r2` under their own projects.
  - `choicesOf lists the projects, and the repos of a chosen project with several`
  - (**Review Focus 2**) `a remembered project or repo that is no longer in the data falls back to All without forgetting it`: `scope` is `{ project: null, repo: null }` and the stored object is unchanged.
  - `inScope keeps a set when any of its pull requests is in the chosen project`
  - `choosing a project or repository keeps the remembered Mine/To review view`
  - `isOpenIn follows the natural state, then Collapse all or Expand all, then a group set by hand`
  - `override records a group set by hand, open or closed, and keeps the newest 300`
  - `a task list closed by hand stays closed after its default changes`: closed by hand with natural true, then read with natural false and with natural true; closed both times.
  - `counted, needYouHint and showMore read naturally for one and many`
- [ ] **Step 2: Run** `orca plugin test . --json`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the three modules and `copy.ts`.
- [ ] **Step 4: Run.** Expected: PASS; `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Add the shared grouping rule and remembered panel state".

### Task 2: Toolbar, group headers and chips

**Files:**
- **Create:** `src/panel/toolbar.tsx`, `src/panel/group.tsx`, `src/panel/chips.tsx`, `src/panel/chrome.test.tsx`.
- **Modify:** `src/panel/test-support.ts`: `reloadPanel`, and a `module` option on `mountPanel`.

**Interfaces:**
- **Consumes:** T1 folds and copy; `cutLabel`; `SnapshotMessage`; `mountPanel`, `closeCleanly`.
- **Produces:**

```ts
export interface ToolAction { icon: IconName; label: string; onPress: () => unknown; disabled?: boolean }
export function foldActions(org: string, tab: FoldTab): ToolAction[]          // Collapse all (icon 'collapse'), Expand all (icon 'expand')
export function TabToolbar(props: { left?: OrcaNode; actions: readonly ToolAction[]; updatedAt: number; message?: string; stale: boolean }): OrcaNode
export function Group(props: { org: string; tab: FoldTab; foldKey: string; title: string; count: string; hint?: string; natural?: boolean; children?: OrcaNode }): OrcaNode
export interface Chip { tone: Tone; text: string }
export function Chips(props: { chips: readonly Chip[] }): OrcaNode
// src/panel/test-support.ts
export interface MountOptions { visible?: boolean; persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }; module?: Parameters<typeof mount>[0] }   // module defaults to the panel
export async function reloadPanel(previous: TestPanel, orgs: OrgStatus[], requests?: MockRequests, options?: Pick<MountOptions, 'module' | 'visible'>): Promise<{ host: TestHost; panel: TestPanel }>
```

**Rules:**
- `TabToolbar` is one `Row justify="between" align="center" gap="sm" wrap`: a `Box grow shrink minWidth={0}` holding `left` (its own `Row gap="xs" wrap`), then a `Row gap="xs"` of ghost `size="sm"` IconButtons in the order given. Under it: `Text muted size="sm"` "Updated <RelativeTime at={updatedAt} />", then `SnapshotMessage`. The Updated line never sits on a row with a lone button.
- `Group` draws `Collapsible title={cutLabel(title)} description={cutLabel(hint ? `${count} · ${hint}` : count)} open={isFoldOpen(…)} onChange={open => setFoldOpen(…)}`. A closed group draws no children.
- `Chips` draws `Row gap="xs" wrap` with one `Badge tone={chip.tone}` per chip, keyed by its text.
- `reloadPanel` copies `previous.persisted.plugin` and `.workspace`, then runs `closeCleanly(previous)`, so the first mount's errors, warnings and refusals must be empty too. It then mounts `options.module` (default: the panel) again with those values.

- [ ] **Step 1: Write the failing tests.** They mount a small test module through `mountPanel(…, { module })` and reload it with `reloadPanel(…, { module })`:
  - `the toolbar puts the scope controls first and the icon buttons last, with Updated under it`
  - `Collapse all and Expand all set every group of the tab and survive a reload`: after Collapse all, both `Collapsible`s have `open: false` and `panel.persisted.plugin.folds['contoso|prs']` is `{ all: 'closed', open: [], closed: [] }`. After `reloadPanel`, both are still closed.
  - `reloadPanel fails when the first mount logged an error`
  - `a group set by hand stays as it was left, and other organisations keep their own`
  - `a closed group draws no children`
  - (**Review Focus 3**) `a group title and hint over 1 KiB are cut to the label limit`
  - `Chips draw one Badge per chip in its tone`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, with `closeCleanly` in each mounted test.
- [ ] **Step 5: Commit** "Add the tab toolbar, group headers and chips".

### Task 3: Stage chips that render

The run card's stage bar draws `Box` segments that show as tiny empty grey bars. They become chips.

**Files:**
- **Modify:** `src/panel/pipelines/run-card.tsx`: `StageBar` and `stageLine` give way to `StageChips` and `stageChips`.
- **Test:** `src/panel/pipelines/pipelines-tab.test.tsx`; `worker/readme.test.ts` stays green unedited.

**Interfaces:**
- **Consumes:** T2 `Chips` and `Chip`; `STEP_GLYPH`; `MAX_STAGE_CHIPS`.
- **Produces:** `export function stageChips(stages: readonly StageChip[]): Chip[]`, `export const STAGE_TONE: Record<StepState, Tone>` and `export function StageChips(props: { stages: readonly StageChip[] | null }): OrcaNode` (draws nothing for null or empty).

**Rules:**
- One chip per stage, at most `MAX_STAGE_CHIPS` (the worker already trims, so there is no overflow chip). The text is `<name> <glyph>`.
- Tones: succeeded `success`; failed `danger`; waiting and warning `warning`; running `accent`; pending, skipped and canceled `neutral`.
- Null or empty `stages` draws nothing. No `Box` remains in a run card's stage area.

**Changes** existing tests: `runs show their state, stage bar and stage line`, `stageLine writes each stage with its glyph and says how many more there are`, `a run with an empty stage list draws no stage bar and no stage line`, and `a stage bar draws at most twelve segments`. They become the tests below.

- [ ] **Step 1: Write the failing tests.**
  - `stage chips show each stage's name and mark in its tone`: for the eight states, Badges `Build ✓` success, `Image ✗` danger, `Deploy production –` neutral, `Test !` warning, `Approve ⏸` warning, `Smoke ●` accent, `Lint ○` neutral, `Docs ⊘` neutral. No `Box` with `width: 14` anywhere in the card.
  - `a run with no stages or an empty stage list draws no stage chips`
  - `twelve stages draw twelve chips and no overflow count`
  - `stageChips maps every step state to its mark and tone` (pure).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with the `pipelines` scenario.
- [ ] **Step 5: Commit** "Draw pipeline stages as chips".

### Task 4: Pipelines tab

**Files:**
- **Modify:** `src/panel/pipelines/{pipelines-tab.tsx,run-card.tsx,approval.tsx,state.ts,fixtures.ts}`, `src/panel/panel.check.ts` (the `pipelines` scenario spans two projects, one with two repositories).
- **Test:** `src/panel/pipelines/pipelines-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T1 `groupByPlace`, `choicesOf`, `inScope`, `runsPrefs`, `chooseProject`, `chooseRepo`, copy; T2 `TabToolbar`, `foldActions`, `Group`; T3 `StageChips`; `runsFor`, `needsMe`, `isActive`, `failedRuns`, `approverNames`, `openComposer`; `approvalShareItem`, `APPROVAL_TEMPLATE`, `APPROVAL_VARS` (`src/shared/share/approval-items.ts`).
- **Produces:**
  - `export function runPlaces(run: RunSummary): Place[]` (one place; the repository from `run.repository`).
  - `export function approvalLine(approval: ApprovalSummary): string`.
  - `export function largeRuns(): RunSummary[]` in fixtures: 30 waiting runs across three projects, one project with two repositories, each with twelve stages and an approval.

**UI** (copy exact):
- **Toolbar** `left`:
  - `Select label="Project" labelHidden` with `*` "All projects" first, then each project;
  - `Select label="Repository" labelHidden` with `*` "All repos", only when `choicesOf` returns repos;
  - the existing four filter buttons, unchanged.

  `actions`: Collapse all, Expand all, Refresh (`icon="refresh"`, label "Refresh", disabled while refreshing), Teams channels (`icon="settings"`).
- **List:**
  - The pickers come from `choicesOf(current.runs, runPlaces, stored)`, every run whatever the filter. So a remembered project falls back to All projects (Review Focus 2) only when no run of any filter is in it, and switching filters never changes the pickers.
  - The list is `runsFor(filter)`, then `inScope`, then the first `MAX_RUNS` (30), then `groupByPlace`. The note `Showing <n> of <total> runs.` stays.
  - Nothing in scope while a project is chosen: `EmptyState title={nothingIn(<project>)} description={CHOOSE_ALL}`, meaning this filter has nothing for that project. Otherwise the existing per-filter empty states.
- **Groups:**
  - Across projects, if any, comes first.
  - A project's title is `<project> · <repo>` when flat with a repository, `<project> · ${repoCount(n)}` when split, else `<project>`. Its loose runs come first, then repository groups titled with the repository name.
  - `count` is `counted(n, 'run', 'runs')`. `hint` is the first that applies: `needYouHint(<needsMe runs>)`, `<n> failed`, `<n> running`.
  - Fold keys are the grouping keys; all groups are naturally open.
- **Run card** (`Card` without a title):
  - The first row is the state `Badge` (existing text and tone), the pipeline name as `Text weight="semibold" truncate` in a growing `Box`, and `RelativeTime format="short" muted` of `finishedAt ?? startedAt ?? queuedAt`.
  - Meta, `Text size="sm" muted`: `<runNumber> · <branch>`, or `<runNumber> · PR !<prId>`, then ` · <requester>` unless the filter is Mine.
  - Then `StageChips`.
  - One warning line per approval: `Text size="sm" tone="warning"` with `approvalLine(approval)` followed by `<RelativeTime at={createdAt} format="duration" />`:
    - `<place> needs <approverNames>`;
    - `<place> needs <minRequired> of <approverNames>` when `minRequired > 1`;
    - `<place>` alone when there are no approvers;
    - each followed by ` · waiting `.
  - When `canApprove`: the clipped instructions (muted, 500 characters as today) and the existing Approve…/Reject… flow under that line.
  - One button row:
    - `Share for approval` (outline, small), only while the run is active with approvals;
    - `Open run` (small);
    - the bell `IconButton` (existing labels and rules);
    - `Link href={run.url}` "Open in Azure DevOps".
  - Then the run's note and outcomes, as today.
  - **Share for approval** opens one composer with one item per waiting approval of that run, all ticked, and suggests their approvers who are people, apart from you.

**Changes** existing tests: `a run card names the pipeline, run, branch, PR and requester, and links to Azure DevOps`, `Needs me shows the approval with approvers and waiting time`, `an approval names its environment, else its stage, else a stage; one approver needs no count; no approvers, no line`, `long instructions are cut at 500 characters with an ellipsis` (now on an approval you can give), `every waiting approval offers Share for approval, whether or not the person can approve it`, `Share for approval opens the composer for that approval only`, `thirty runs with twelve stages and an approval each stay under 2,000 nodes`, `the header has a Teams channels button that opens the manager and Back returns to the runs`.

- [ ] **Step 1: Write the failing tests.**
  - `runs group by project, and a project with runs from several repositories splits into repository groups`
  - `a project whose runs share one repository stays flat and names it in the header`
  - `pipelines named alike in different projects each sit under their own project`
  - `runs without a repository sit under their project before its repository groups`
  - `the project picker filters the runs, and the repository picker appears for a project with several repositories`
  - `the chosen project and repository survive a reload, per organisation` (`reloadPanel`).
  - (**Review Focus 2**) `a remembered project with nothing in it now shows All projects`
  - `a chosen project stays chosen across filters and shows Nothing here when the filter is empty`
  - `a group header counts its runs and says when one needs you, else failed, else running`
  - `a run card shows the state, pipeline and age first, then the run number with the branch or PR`
  - `on Mine the requester is left out; on the other filters it is shown`
  - `a waiting approval shows one line: where, who and how long`: the three forms.
  - `Share for approval shows only on a waiting run and shares every waiting approval of that run`
  - `Approve and Reject show only for an approval the person can give, with its instructions`
  - `Collapse all and Expand all close and open every project and repository group`
  - `thirty runs with approvals across projects and repositories, all open, stay under 2,000 nodes and 450 KiB` (`largeRuns`, then Approve…; asserts `countNodes(panel.tree()) < 2_000` and the encoded tree under 450 KiB; ends with `closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes.
- [ ] **Step 5: Commit** "Group pipeline runs by project and calm the run card".

### Task 5: PRs tab

**Files:**
- **Create:** `src/panel/prs/rows.ts`, `src/panel/prs/rows.test.ts`.
- **Modify:** `src/panel/prs/{prs-tab.tsx,release-set.tsx,state.ts,fixtures.ts}` (`toReviewOpen` and `setToReviewOpen` go), `src/panel/panel.check.ts` (`prs` spans projects and repositories and has a cross-project set; a new `prsToReview` scenario persists `prsPrefs` with `view: 'review'`).
- **Test:** `src/panel/prs/prs-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T1, T2; `act`, `isActing`, `outcomeOf`, `showReview`, `votePhrase`, `MERGE_STRATEGY_LABELS`, `openComposer`.
- **Produces:**

```ts
export function prPlace(pr: PrSummary): Place
export function setPlaces(set: ReleaseSet): Place[]
export function prChips(pr: PrSummary, place: 'repo' | 'project' | null): Chip[]
export function waitingOn(pr: PrSummary): string | null           // 'waiting for Grace Hopper, Release Approvers'
export function branchPattern(sources: readonly string[]): string
export function needsApprove(pr: PrSummary, me: string | null): boolean
export function needsAutoComplete(pr: PrSummary): boolean
export function needsYou(set: ReleaseSet): boolean
export const MERGED_SHOWN = 2
export const MIN_BRANCH_PREFIX = 4
export function largeSets(): PrSnapshot                            // fixtures: 50 PRs in 20 sets across 4 projects, Across repos and Across projects sets, 50 to review, 50 reviewed
```

**Rules:**
- **`prChips`** gives at most two chips: the place chip design §5.2 asks for, then one status chip (§5.1):
  - The place chip comes first, only in Across groups: neutral `<repoName>` for `'repo'`, `<projectName> / <repoName>` for `'project'`.
  - A completed PR's status chip is success `merged`; an abandoned one's is neutral `abandoned`.
  - Otherwise the worst check is the first that applies:
    1. danger `conflicts`;
    2. danger `✗ build`;
    3. danger `✗ policies`;
    4. danger `rejected` (a reviewer voted −10);
    5. warning `waiting for author` (a reviewer voted −5);
    6. warning `● build`;
    7. neutral `· policies`;
    8. success `✓ build` (build succeeded or policies approved).

    The status chip's text joins `draft` (when draft), the worst check and `auto-complete` (when set) with ` · `, for example `draft · ● build` or `✓ build · auto-complete`. Its tone is the worst check's. With no check it is accent for auto-complete, else neutral. With none of the three there is no status chip.
- **`waitingOn`** names required reviewers who haven't voted or declined, as today's `isWaitedFor`; null when none.
- **`branchPattern`:**
  - one source gives itself;
  - several give their longest common prefix plus `*` when that prefix is at least `MIN_BRANCH_PREFIX` characters;
  - otherwise `<n> branches`.
- **`needsApprove`:** active, not draft, and your vote isn't 10. **`needsAutoComplete`:** active, not draft, auto-complete not set. **`needsYou`:** some active PR with conflicts, a failed build, rejected policies, or a −10 or −5 vote.

**UI** (copy exact):
- **Toolbar** `left`:
  - the Project and Repository Selects, as in Task 4. Their choices come from sets, To review and Reviewed by you together, whatever the view; the list follows the shown view.
  - then two small Buttons, solid when chosen: `Mine` and the To review switch. The switch reads `To review · <toReviewCount>` at All projects. With a project chosen it reads `To review · <in scope> of <toReviewCount>`, so the filter never hides how many wait elsewhere. It is just `To review` when `toReviewCount` is 0. `<in scope>` counts the posted To review rows in scope.
  - `actions`: Collapse all, Expand all, Refresh, Teams channels. The auto-complete sentence leaves the list.
- **Mine:**
  - `inScope(sets)`, then the existing `setsToShow` caps (30 sets, 150 rows), then `groupByPlace(setPlaces)`, fold keys prefixed `mine/`.
  - When the caps cut sets, today's note stays under the groups, word for word: `Showing <n> of <N> sets.` (N: the sets in scope). The per-set `Showing <n> of <N> pull requests in this set.` stays too.
  - Header titles as in Task 4. `count` is `counted(n, 'set', 'sets')`, `hint` is `needYouHint(<sets that need you>)`.
  - Rows carry a `'repo'` place chip in Across repos and a `'project'` place chip in Across projects.
  - Empty: today's EmptyState, or `nothingIn` with `CHOOSE_ALL` while a project is chosen.
- **Set card:**
  - `Card title={set.title} description={branchPattern(set.sources)}`. The meta line never needs the repository: the project header, a repository group or a place chip always names it.
  - One row per PR: `Link href={pr.url}` `!<prId>`, `Text` `→ <target>`, `Chips`, then `waitingOn` as `Text size="sm" muted`.
  - Merged rows after the first `MERGED_SHOWN` fold behind `Link` `+ <n> merged · show`, which turns into `Hide merged`. This is kept per set key, in memory.
  - Buttons:
    - `Share…` (small, solid);
    - `Approve` (small, outline), only when some PR `needsApprove`;
    - `Auto-complete` (small, outline, `tooltip` = today's options sentence), only when some PR `needsAutoComplete`.

    Both action buttons still send the set's active PRs, are disabled while acting, and show today's per-row result Callout.
- **To review:**
  - `inScope(toReview)`, the first 50, `groupByPlace(prPlace)`, fold keys prefixed `review/`, `count` `counted(n, 'pull request', 'pull requests')`.
  - When rows are cut, today's note stays under the groups, word for word: `Showing <n> of <N> pull requests.`. N is `toReviewCount` at All projects, and the in-scope count with a project chosen.
  - Rows are `ListItem` with title `cutLabel(pr.title)`, description `cutLabel('!<prId> · <author>')`, and press → `showReview`.
  - Then a group `Reviewed by you` (key `review/reviewed`) of up to 50 rows with description `!<prId> · <project> / <repo> · <author> · you: <votePhrase>`.
  - Nothing at all: `EmptyState title="Nothing to review" description="Pull requests that name you as a reviewer show up here until you vote."`
- **Remembered:** the view, project and repository per organisation in `prsPrefs`.

**Changes** existing tests: `sets show one row per PR with target, checks, votes and auto-complete`, `only a required reviewer who has not voted and not declined counts as waited for`, `several waited-for reviewers share one badge`, `a reviewer who voted Waiting for author shows a warning chip, required or not, and is not waited for`, `Approve all sends prs.approve…`, `Auto-complete all sends prs.autoComplete; the options line reflects the snapshot`, `the options line names each merge type`, `both buttons are disabled while an action runs and when no PR qualifies`, `To review opens the review in the panel on press`, `Reviewed by you lists the PRs I voted on with my vote`, `the fold shows for reviewed PRs alone and keeps its To review count`, `an empty To review list is not shown`, `To review stays open when the tab is left and shown again`, `a second press before the buttons redraw sends nothing`, `rows are capped so the render stays within the node limit`, `one set of 300 PRs shows 150 rows, says so, and still acts on every active PR`.

- [ ] **Step 1: Write the failing tests.**
  - rows: `prChips gives the place chip and one status chip: merged alone, else draft, the worst check and auto-complete in one text with the check's tone`; `waitingOn names required reviewers who have not voted or declined`; `branchPattern turns a shared prefix into * and counts unrelated branches`; `needsApprove and needsAutoComplete skip drafts, finished pull requests and ones already done`.
  - `release sets group by project, flat with the repository named for a one-repo project`
  - `a project with sets from several repositories gets one group per repository and an Across repos group first, whose rows carry a repository chip`
  - `a set spanning projects shows once, in Across projects at the top, with project / repo chips, and under a project filter when any of its pull requests is there`
  - `a set card shows the branch pattern and one row per pull request with its chips and who it waits for`
  - `merged rows after the first two fold behind + N merged · show`
  - `Share… comes first, and Approve and Auto-complete show only when some pull request needs them`
  - `Approve sends prs.approve with the set's active pull requests and shows each row's result`
  - `the auto-complete settings sentence is the Auto-complete button's tooltip, not a line in the list`
  - `Mine and To review switch the list; To review groups its rows by project and keeps Reviewed by you`: the switch reads `To review · 12`, then `To review · 3 of 12` once a project is chosen.
  - `cut lists keep their notes: Showing n of N sets. and Showing n of N pull requests.`
  - `the chosen view, project and repository survive a reload, per organisation`
  - (**Review Focus 2**) `a remembered project with nothing in it now shows All projects`
  - `To review with nothing waiting shows its empty state`
  - `a project header says how many sets need you`
  - `fifty pull requests in sets across projects, with To review full, stay within Orca's limits in both views` (`largeSets`, all open; under 4,000 nodes and 450 KiB; `closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with `prs` and `prsToReview`.
- [ ] **Step 5: Commit** "Group pull requests by project and switch between Mine and To review".

### Task 6: Work data: task types, parents and child tasks

**Files:**
- **Modify:**
  - `src/shared/work.ts`: the T6 types.
  - `worker/ado/board-config.ts`: the default path keeps `taskBacklog.workItemTypes[].name` as `taskTypes`.
  - `worker/ado/workitems.ts`: `childIdsOf`, `readFields`, `TASK_FIELDS`.
  - `worker/boards/snapshot.ts`: families and the budget.
  - `worker/boards/service.ts`: passes `me`; `noBoards` has `NO_FAMILIES`; `publish` and `build` patch rows.
  - `worker/boards/fake-ado.ts`: answers `fields` batches with only the asked fields; `addChildren(ado: FakeAdo, parentId: number, children: RawWorkItem[]): void` stores the children and adds a `CHILD_LINK` relation per child to the parent.
  - `worker/messages.ts`: `TASKS_NOT_LOADED` "Couldn't load the tasks under your items. They show after the next refresh."
  - The `WorkSnapshot` literals Task 0 listed (`src/panel/test-support.ts`, `src/panel/panel.check.ts`, `src/panel/work/work-tab.test.tsx`, …) gain `families: NO_FAMILIES`.
- **Test:** `worker/ado/board-config.test.ts`, `worker/ado/workitems.test.ts`, `worker/boards/snapshot.test.ts`, `worker/boards/service.test.ts`.

**Interfaces:**
- **Consumes:** `hydrate`, `toSummary` (unchanged), `ItemSource.states`, `DONE_CATEGORIES`, `newestThatFit`, `byteLength`, `joinMessages`, `withSignal`, `RecentWrites.overlay`.
- **Produces:**

```ts
// worker/ado/workitems.ts
export const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward'
export const TASK_FIELDS: readonly string[]   // System.Id, System.WorkItemType, System.Title, System.State, System.AssignedTo, System.Parent
export function childIdsOf(raw: RawWorkItem): number[]
export function readFields(http: AdoHttp, org: string, projectId: string, ids: number[], fields: readonly string[]): Promise<RawWorkItem[]>
// worker/boards/snapshot.ts
export interface Me { id: string; uniqueName: string }
export const MAX_CHILD_READS = 1000
export const FAMILY_BUDGET_BYTES = 64 * 1024
export function loadMine(source: ItemSource, cfg: BoardConfig, me: Me | null): Promise<Loaded & { families: WorkFamilies; message?: string }>
export function patchFamilies(families: WorkFamilies, item: WorkItemSummary, done: boolean): WorkFamilies
```

**Rules:**
- A type is **task-level** when `cfg.taskTypes ?? []` holds it. A named board leaves `taskTypes` out, and its config requests stay as they are.
- **Dimmed parents:** for each loaded task-level item whose `parentId` isn't a loaded item, the parent comes from the missing-parents batch `summarize` already makes (no new read). `toSummary` of that raw gives `WorkParent` (type, title, state, column, lane). The parent may be any type, a task included. An unreadable parent gives none; Task 7 shows it as a `#<id>` header.
- **Children:**
  - Take `childIdsOf(raw)` of each loaded item, task-level ones included so a task under a task is found, then of each dimmed parent. Make them distinct and keep the first `MAX_CHILD_READS`.
  - The dimmed parents' children follow design §5.4: a task whose parent isn't in your list shows under that parent, with every child task of the parent. They ride in the same batched read, so §6's one-read rule holds and no request is added.
  - Read them in one `readFields` call. Each request posts exactly `{ ids, fields: TASK_FIELDS, errorPolicy: 'omit' }`, with no `$expand` and 200 ids a request, and null entries are dropped as `hydrate` does. Without `'omit'`, one child the account can't read would fail the whole read on every poll. Skip the read when there are none.
  - Keep task-level children. A `Removed` category drops a child; `Completed` marks it done. Categories come from `source.states(projectId, type)`, which is cached.
- **Assignee:** `assignee` is the display name, null when unassigned. `mine` is true when the identity's `id` matches `me.id` or its `uniqueName` matches `me.uniqueName` (case-insensitive). `me` is `{ id: account.adoId, uniqueName: account.uniqueName }` from the org's `account`, or null without one (then nothing is `mine`).
- **Lists:** one per parent with a task child. Tasks are ordered: your not-done tasks by id, then others' not-done by id, then done by id. Keep the first `MAX_CHILD_TASKS` but never drop your not-done tasks. `total` and `done` count every task child read.
- **Failure:** a children or states read that fails, unless aborted, leaves `lists` empty and joins `TASKS_NOT_LOADED` to the message. An abort rethrows.
- **Budget** (`capSnapshot`):
  1. Items fit exactly as today, against `POST_BUDGET_BYTES` minus the rest of the snapshot with `families: NO_FAMILIES`. So a snapshot posts the same items with families as without them, and nothing that posts today is dropped.
  2. Then it drops each dimmed parent no kept item names as its parent, and each list whose parent is neither a kept item nor a kept dimmed parent.
  3. Families then fit in `min(FAMILY_BUDGET_BYTES, POST_BUDGET_BYTES − bytes so far)`. First come the parents, then every list's `parentId`, `total` and `done` with no tasks, then tasks list by list, each from its start. Tasks that don't fit are trimmed from the end of their list and from every later list, so `Tasks n/m` and `+ N more` still show. Your own trimmed tasks still show, from your `other` items (Task 7).
  4. If even the parents and counts don't fit, they drop from the end. A task whose parent dropped shows under a `#<id>` header, as for an unreadable parent.
- **Writes:** a row matching an item takes the item's title and state, with `done` from the type's state categories (`source.states`, cached). `publish` does this after a move or link. `build` does it on each rebuild for every item the recent-writes overlay replaced, since ADO may still return the old state. The overlay returns a new object only for those.

- [ ] **Step 1: Write the failing tests.**
  - `the default board carries the task backlog's types; a board named by id leaves them out` (`loads the board named by boardId without the backlog configuration…` stays unedited).
  - `childIdsOf reads child links only and skips malformed ones`
  - `readFields posts the ids, the fields and errorPolicy omit without expanding relations, 200 ids a request`: 250 ids give two requests whose bodies deep-equal `{ ids: [first 200], fields: TASK_FIELDS, errorPolicy: 'omit' }` and `{ ids: [last 50], fields: TASK_FIELDS, errorPolicy: 'omit' }`.
  - `a child the account can't read comes back null and the other tasks still list, with no message`: 1204 also links to 1212, which the fake doesn't hold, so it answers `null` for it as it already does.
  - `a mine load reads missing parents once and the child tasks of listed items and those parents in one more batched read`: batch bodies are `[items]`, `[1100, parents…]`, then the children with `fields`, `errorPolicy: 'omit'` and no `$expand`.
  - `a task under a task: the parent task's children come in the same read`
  - `no child links means no children read`: in `worker/boards/service.test.ts`, the test `snapshot splits mine and other and attaches chips and parents` and its assertion `items, then every missing parent in one batch call` stay unedited.
  - `child task lists hold every task of a parent, any assignee, done ones marked, yours first, and count them`: with Alex Contoso's account (`9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b`, `alex@contoso.example`) and `workitems-children.json`, 1204's list is 1207 (`mine: true`), 1210 (`mine: false`, `assignee: null`), then 1209 (done, `mine: false`, `Grace Hopper`). 1211 (Removed) is left out; total 3, done 1.
  - `a parent with 30 tasks posts 20 and counts all 30, never dropping one of yours`
  - `a task whose parent isn't listed brings that parent as a dimmed parent with its column and lane`
  - `children that aren't tasks are left out`
  - (**Review Focus 1**) `a failed children read still posts the items, with no task lists and a message`: 403 and 500 answers; the same load aborted rejects instead.
  - `moving your task updates its row under its parent`
  - `a moved task shows its new state after the next poll while ADO still returns the old one`
  - `150 items with 300 tasks fit the post budget whole`: none trimmed, `byteLength` under `POST_BUDGET_BYTES`.
  - `a snapshot at the item budget posts the same items with families as without`
  - `families over the budget keep every list's counts and trim tasks from the end`: every list keeps `parentId`, `total` and `done`; later lists lose their tasks first.
  - `a list or dimmed parent whose item was cut by the item budget is dropped`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Read task parents and child tasks for the Work tab".

### Task 7: Work tab: compact cards, tasks under their parent, Columns

**Files:**
- **Create:** `src/panel/work/plan.ts`, `src/panel/work/task-rows.tsx`, `src/panel/work/fixtures.ts`, `src/panel/work/plan.test.ts`.
- **Modify:** `src/panel/work/{work-tab.tsx,item-card.tsx,state.ts}` (`closedGroups` and `setGroupOpen` go), `src/panel/panel.check.ts` (`work` gets families, a dimmed parent, Not on this board and No parent).
- **Test:** `src/panel/work/work-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T1 folds, prefs and copy; T2; T6 types; `chipOf`, `MAX_CHIPS`, `openDetails`, `move`, `moveResets`, `refresh`, `openBoard`.
- **Produces:**

```ts
export interface TaskRow { id: number; title: string; state: string; done: boolean; assignee: string | null; mine: boolean; item: WorkItemSummary | null }   // item: your `other` item, which keeps Move
export interface WorkCard { key: string; id: number; item: WorkItemSummary | null; parent: WorkParent | null; column: string | null; lane: string | null; tasks: TaskRow[]; total: number; done: number; more: number }   // item and parent both null: a parent that can't be read
export interface WorkPlan { board: WorkCard[]; offBoard: { type: string; cards: WorkCard[] }[]; unknown: WorkCard[]; noParent: TaskRow[] }
export function planWork(snapshot: WorkSnapshot): WorkPlan
export function byColumn(cards: readonly WorkCard[], board: BoardConfig): { name: string; cards: WorkCard[] }[]
export function tasksOpenByDefault(card: WorkCard): boolean
export function typeIcon(type: string): IconName
export const MAX_TITLE_CHARS = 90
export const GROUP_PAGE = 25
export const WORK_NODE_BUDGET = 3200   // estimated: 18 a card, 8 a task row, 4 a group
export function largeWork(): WorkSnapshot   // fixtures: 150 items over 5 columns and 2 lanes, 300 tasks, 10 dimmed parents, Features and a Bug off the board
```

**Rules for `planWork`:**
- **Board cards:** `mine` items, then dimmed parents on the board. A parent is on the board when its type is a requirement type and its column is a board column.
- **Off the board:** grouped by type, types ordered by name:
  - items in `other` that aren't task-level;
  - dimmed parents not on the board;
  - task-level parents (below).
- **Task-level parents** (design §5.4: the parent may be any type). A task-level item or dimmed parent with a task list gets a card in its type group, with its tasks nested one level under it:
  - your own task with no parent: its own card, with Move;
  - anything else: a dimmed header (`item: null`, `parent` built from it). Your task with a parent already shows as a row under that parent.
- **Unknown:** each parent that is neither listed nor dimmed (it couldn't be read, or the post budget dropped it) gets a dimmed `#<id>` card in `unknown`, holding your tasks under it.
- **A card's task rows** are its `TaskList` tasks plus any of your task-level `other` items with that `parentId` not already there. `item` is your `other` item when there is one, so the row keeps Move. `more` is `total` minus the rows shown, when positive.
- **No parent:** only your task-level items with no `parentId` and no task list.
- **Exactly once:** each of your task-level items is one row or one card. A dimmed header is a reference to a parent and never carries Move. Unknown columns fall back to the first column, as today.
- **`tasksOpenByDefault`:** true for a dimmed parent, or a card with a not-done task of yours; false otherwise.
- **`typeIcon`:**
  - `book`: User Story, Product Backlog Item, Requirement;
  - `bug`: Bug;
  - `check`: Task;
  - `layers`: Feature;
  - `flag`: Epic;
  - `warning`: Impediment, Risk;
  - `activity`: Test Case;
  - `file-text`: anything else.

**UI** (copy exact):
- **Toolbar** `left`: `Badge` `<teamName> · <boardName>`. The Columns | Lanes switch arrives with Lanes in Task 8, so this task ships no control that does nothing. `actions`: Collapse all, Expand all, Refresh, Open board (`icon="open-external"`). Nudges stay as they are, under the toolbar.
- **Groups:**
  - One per non-empty board column, in board order: key `column:<name>`, title the name, `count` `counted(cards, 'item', 'items')`.
  - Then `Not on this board` (key `offboard`) with a group per type (`offboard/type:<type>`), then `Unknown type` (key `offboard/unknown`) when `unknown` has cards.
  - Then `No parent` (key `noparent`, `counted(n, 'task', 'tasks')`) holding task rows.
  - Each group shows `GROUP_PAGE` cards, then a small ghost Button `showMore(<min(25, left)>)`; the count shown is kept per group key, in memory.
  - Past `WORK_NODE_BUDGET`, no more cards or rows are drawn, and `Text size="sm" muted` says "Some items are hidden. Collapse a group to see others."
  - Nothing at all: today's "Nothing assigned to you on this board".
- **Item card** (`Card` without a title):
  - `Link onPress={() => openDetails(org, id)}` with the title cut to `MAX_TITLE_CHARS` and `…`.
  - Then a `Row gap="xs" align="center" wrap`:
    - ghost `IconButton size="xs" icon={typeIcon(type)} label={type}` that also opens details;
    - `Text size="sm" muted` `#<id>`;
    - the PR chips as built (`chipOf`, at most `MAX_CHIPS`, then `+<n>`);
    - when the card has tasks, a ghost xs Button `Tasks <done>/<total>` with `tooltip` `<done> of <total> tasks done`, which toggles fold `tasks:<id>` (natural `tasksOpenByDefault`);
    - the compact Move: `Box width={112} shrink={false}` holding `Select label="Move" labelHidden placeholder="Move"`, keyed by `moveResets`, with today's targets and `move()` call.

  The full-width Move to box and the Details button go.
- **Dimmed parent:** a `Card` with `Text muted weight="medium"` `#<id> <title>` (cut the same way), or `#<id>` alone for a parent that couldn't be read. Its task rows are open by default.
- **Task rows** (`task-rows.tsx`), in a `Box paddingX="sm" gap="xs"` under the card, drawn only while open:
  - not done: `Link` `#<id> <title>` opening details;
  - done: `Text size="sm" muted` with the same text;
  - then `Text size="sm" muted` with the state, then, unless the row is `mine`, the assignee or `Unassigned` when it is null;
  - Move for rows with an `item`;
  - after the rows, `+ <more> more`.

**Changes** existing tests: `groups items by column in board order with an Other group`, `a card names its parent after the type and id`, `the header shows the board name and a refresh that replaces the snapshot`, `Move to sends work.move with the item rev`, `a refused move shows the message and the list follows the worker post`, `300 cards with four chips each and 25 nudges still render, with 10 nudges shown`, `a long list renders 300 cards, board groups first, and says how many are not shown`, `exactly 300 items are all shown without a note`, `leaving the Work tab and coming back keeps the open item, its draft and the collapsed sections`.

- [ ] **Step 1: Write the failing tests.**
  - plan: `planWork puts board items in their columns, dimmed parents beside them and the rest by type off the board`; `your tasks go under their parent of any type, listed, dimmed or unreadable, and only parentless ones in No parent`; (**Review Focus 4**) `every task of mine appears exactly once, wherever its parent is`. Its cases: an unreadable parent (a `#<id>` card in `unknown`), a task under your task, a task under someone else's task, a parent both listed and dimmed, and a task cut from its parent's posted list. `typeIcon maps the process types and falls back to a page`.
  - `a task-level parent shows in Not on this board under its type, with its tasks nested one level`
  - `a card is a pressable title, then the type, id, chips, Tasks n/m and a compact Move`
  - `pressing a card's title or type opens its details`
  - `Move sends work.move with the item rev from the compact control`
  - `a refused move shows the message and the list follows the worker post`
  - `Tasks n/m opens the tasks under the story with state and other people's names, Unassigned for nobody, done ones muted, and + N more`
  - `your task under a story keeps its Move`
  - `a task whose story isn't yours shows under that story, dimmed, in the story's column`
  - `Not on this board groups items that move by state by type, with their tasks nested`
  - `a task whose parent can't be read shows under a dimmed #id header in Unknown type`
  - `No parent lists only tasks with no parent`
  - `groups follow board order and count their cards`
  - `the board label names the team and the board, and Refresh replaces the snapshot`
  - `Collapse all and Expand all act on every group and every task list`
  - `open groups and task lists survive a reload`
  - `a task list closed by hand stays closed after your last task in it is done`
  - `a long group shows 25 cards and Show N more reveals the next ones`
  - `150 items with 300 tasks, all expanded, stay within Orca's limits and say when some are hidden` (`largeWork`, Expand all; under 4,000 nodes and 450 KiB; `closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with `work`.
- [ ] **Step 5: Commit** "Lay the Work tab out like the board, with tasks under their parent".

### Task 8: Work tab: Lanes

**Files:**
- **Modify:** `src/panel/work/{plan.ts,work-tab.tsx,fixtures.ts}`, `src/panel/panel.check.ts` (new `workLanes` scenario persisting `workViews` lanes on a two-lane board).
- **Test:** `src/panel/work/plan.test.ts`, `src/panel/work/work-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T7 `WorkCard`, `byColumn`, the Work toolbar; T1 `workViews`.
- **Produces:** `export function byLane(cards: readonly WorkCard[], board: BoardConfig): { id: string; name: string; columns: { name: string; cards: WorkCard[] }[] }[]` and `export const DEFAULT_LANE = 'Default lane'`.

**Rules:**
- The toolbar's `left` gains small Buttons `Columns` and `Lanes` after the board label, solid when chosen.
- Lanes in board order. A card goes in the lane whose name equals its `lane`. A null, `''` or unknown lane goes in the lane named `''`, else the first lane. The lane named `''` is titled `Default lane`.
- Inside a lane, `byColumn` of its cards, keeping only non-empty columns. Lane key `lane:<laneId>` with `counted(cards, 'item', 'items')`; column key `lane:<laneId>/column:<name>`.
- Not on this board and No parent follow the lanes, as in Columns.
- A board with at most one lane draws Columns under Lanes, with `Text size="sm" muted` "This board has no swimlanes, so Lanes shows the columns."
- The view is kept per board key `<org>/<projectId>/<teamId>`; Columns by default.

- [ ] **Step 1: Write the failing tests.**
  - `byLane puts cards in their lanes in board order, and the rest in Default lane`
  - `Lanes shows one group per swimlane in board order with a group per column inside`
  - `a board without swimlanes shows the columns under Lanes with a note`
  - `the Columns and Lanes buttons switch the view, and the chosen one is solid`
  - `the chosen view is remembered per board and survives a reload`
  - `Collapse all closes the lanes and their column groups too`
  - `150 items with 300 tasks in Lanes, all expanded, stay within Orca's limits` (under 4,000 nodes and 450 KiB, asserted; `closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with `workLanes`.
- [ ] **Step 5: Commit** "Add the Lanes view to the Work tab".

### Task 9: Wiki tree and toolbar

**Files:**
- **Modify:** `src/panel/wiki/{wiki-tab.tsx,state.ts,fixtures.ts}`, `src/panel/panel.check.ts` (`wikiTree` remembers an open folder).
- **Test:** `src/panel/wiki/wiki-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T1 copy; the existing `treeItems`, `toggleFolder`, `refreshTree`, `showPage`, `closePage`, `levels`, `expanded`.
- **Produces:**

```ts
export const wikiExpanded: Atom<Record<string, string[]>>   // key 'wikiExpanded'
export const MAX_REMEMBERED_FOLDERS = 200
export const MAX_EXPAND_LOADS = 25
export function collapseAll(): void
export function expandAll(): Promise<void>
export function largeLevels(): Record<string, WikiLevel>     // fixtures: 2,000 pages over three levels
```

**Rules:**
- `treeItems` gives a folder `icon: 'folder'` and, once its level has loaded, `description` `counted(level.total, 'page', 'pages')`; a leaf gets `icon: 'file-text'`. Nothing reads ahead.
- **Remembered folders.** `wikiExpanded["<org>|<wikiId>"]` keeps the newest `MAX_REMEMBERED_FOLDERS`. Expanding a folder adds it. Collapsing it by hand removes it, and Collapse all empties the list. A folder whose parent level loads without it is forgotten.
- **Starting a tree** (panel load, wiki switch, Try again) reloads and expands at most `MAX_EXPAND_LOADS` remembered folders, parents first. A folder reloads only after its parent has. The rest stay remembered but closed, and expanding one by hand loads it as usual. A start therefore sends the root read and at most 25 folder reads, and Refresh pages (which reloads what is expanded) stays as bounded as today.
- `Tree selected` is the last page shown. `closePage` expands that page's ancestors, loading their levels, so it shows selected.
- **`collapseAll`** empties `expanded`. **`expandAll`** opens every folder now visible, loading at most `MAX_EXPAND_LOADS` levels a press.

**UI:**
- The header keeps the wiki picker.
- The search row is a `Row gap="xs" align="center"`: the search `Input` in a growing `Box`, then ghost small IconButtons `Collapse all` (`collapse`), `Expand all` (`expand`) and `Refresh pages` (`refresh`).
- The row holding only Refresh pages goes.

**Changes** existing tests: `the pure tree builder nests loaded folders and leaves the rest to load on expand` (icons), `Refresh pages reloads the root and the expanded folders` (its place), `switching org resets the tab but keeps the chosen wiki per org` (now also keeps each wiki's folders).

- [ ] **Step 1: Write the failing tests.**
  - `folders show a folder icon and their page count once loaded; pages show a page icon`
  - `a folder's count never reads ahead: an unexpanded folder has no description and costs no request`
  - `the search row holds Collapse all, Expand all and Refresh pages`
  - `Collapse all closes every folder; Expand all opens the visible ones, loading at most 25 levels a press`
  - `expanded folders are remembered per wiki and reopen after a reload`
  - `a reload with 200 remembered folders sends the root and at most 25 folder reads, and keeps the rest remembered`: counts `wiki.pages` requests with `requestsTo`.
  - `going back from a page shows it selected with its folders expanded`
  - `a 2,000-page wiki stays within Orca's limits` (`largeLevels`, everything expanded; 1,000 items and the hidden note; under 4,000 nodes and 450 KiB; `closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with `wikiTree`.
- [ ] **Step 5: Commit** "Tell wiki folders from pages and remember open folders".

### Task 10: Open in tab: the full-width reader

S1 picked Option A, B or C (C only after the author agreed). The shared steps apply to every option; do only the steps of the chosen one. Option C is Option B with no vendored renderer: every "Option B" item applies to it except the vendor files, `THIRD_PARTY_NOTICES.md` and the renderer-initialisation test.

**Files (shared):**
- **Create:** `src/shared/wiki-blocks.ts` (Mermaid half), `src/shared/wiki-blocks.test.ts`, `worker/wiki/reader.ts`, `worker/wiki/reader.test.ts`.
- **Modify:**
  - `worker/panel-markdown.ts`: a `::: mermaid` block is a code unit.
  - `worker/wiki/service.ts`: `page(ref, maxBytes?)`.
  - `worker/wiki/handlers.ts`, `worker/main.ts`, `src/protocol.ts`: `wiki.openInTab`.
  - `worker/messages.ts`: `openedReader(title)` "Opened <title> in a tab."; `readerBanner(title, editable)` gives "*A read-only copy of <title>. To change it, use Edit in Orca in the Azure DevOps sidebar.*" for a project wiki (`WikiRef.editable`) and "*A read-only copy of <title>. To change it, edit the page in its repository.*" for a code wiki.
  - `src/panel/wiki/{state.ts,page-view.tsx}`: `openInTab` and an `Open in tab` button in the page's actions.
  - `src/panel/test-support.ts`: default `wiki.openInTab` `{ opened: true, message: '' }`.
- **Test:** `worker/panel-markdown.test.ts`, `src/panel/wiki/wiki-tab.test.tsx`.

**Files (Option A):**
- `worker/wiki/draft-files.ts`: `pageFileName(folder, org, wikiName, pagePath)`; `draftName` uses it with `'wiki'`; `readerName` uses it with `'wiki-read'`.
- `worker/tab-files.ts`: `ensureTabFolder(fs, workspacePath)` (the folder and its `.gitignore`), taken out of `writeTabFile`, which calls it, so its behaviour and tests stay as they are.

**Files (Options B and C):**
- `orca-plugin.json`: `customEditors` gains `{ "id": "wiki", "title": "Azure DevOps wiki page", "extensions": [".adowiki"], "entry": "src/reader/reader.html", "priority": "default", "frame": "isolated" }`.
- `src/reader/{reader.html,reader.ts,render.ts,ref.ts}`, `src/reader/vendor/*` (the files S1 listed; not for C), `src/reader/ref.test.ts`, `src/reader/render.test.ts`, `THIRD_PARTY_NOTICES.md` (not for C).
- `src/protocol.ts` and `src/shared/wiki.ts`: `wiki.read` and `ReaderPage`.

**Interfaces:**
- **Consumes:** `panelMarkdown`, `getPage`, `wikiPageUrl`, `focusedWorkspace`, `assertInside`, `TAB_FOLDER`, `NO_LOCAL_WORKSPACE_WIKI`, `LONG_WAIT`; Options B and C also `openTabFile`. Option A doesn't write the copy through `writeTabFile` or `openTabFile`: they write straight away, and a rewrite of a `0o444` copy would fail with `EACCES`.
- **Produces:**

```ts
export const MAX_READER_BYTES = 800_000
export function readerMarkdown(page: WikiPage, editable: boolean): string    // worker/wiki/reader.ts: readerBanner, blank line, toFencedMermaid(page.content)
export interface Reader { openInTab(ref: WikiPageRef): Promise<{ opened: boolean; message: string }>; read?(ref: WikiPageRef): Promise<ReaderPage> }
export type ReaderFs = DraftFs & Pick<typeof import('node:fs/promises'), 'chmod'>
export function createReader(deps: { wiki: Pick<WikiService, 'wiki' | 'page'>; call: HostCall; fs: ReaderFs; now: () => number }): Reader
export function openInTab(ref: WikiPageRef): Promise<void>                    // src/panel/wiki/state.ts; outcome key `read:<draftKey>`
// src/reader/render.ts (Options B and C)
export interface DiagramRenderer { initialize(config: { startOnLoad: false; securityLevel: 'strict'; theme: 'default' | 'dark' }): void; render(id: string, source: string): Promise<{ svg: string }> }
export function renderPage(markdown: string, deps: { diagrams: DiagramRenderer | null; theme: 'light' | 'dark' }): Promise<string>   // null: Option C
```

**Rules (shared):**
- **`mermaidBlocks`:**
  - It recognises `::: mermaid` (up to 3 leading spaces, any case, trailing spaces) up to the next line that is `:::`, and fenced blocks whose info string is exactly `mermaid`.
  - It skips lines inside other fences and treats CRLF as LF.
  - An unclosed block runs to the end.
- **`toFencedMermaid`** rewrites colon blocks as fenced ones and leaves everything else byte-for-byte.
- **`diagramKind`** reads the first line that isn't blank, `%%` or front matter:
  - `graph`, `flowchart` → `flowchart`;
  - `sequenceDiagram` → `sequence diagram`;
  - `classDiagram*` → `class diagram`;
  - `stateDiagram*` → `state diagram`;
  - `erDiagram` → `entity relationship diagram`;
  - `journey` → `user journey`;
  - `gantt` → `Gantt chart`;
  - `pie` → `pie chart`;
  - `gitGraph` → `git graph`;
  - `mindmap` → `mind map`;
  - `timeline` → `timeline`;
  - `quadrantChart` → `quadrant chart`;
  - `requirementDiagram` → `requirement diagram`;
  - anything else → `diagram`.
- **`panelMarkdown`** leaves a colon Mermaid block untouched like fenced code, and a cut inside one closes it with `:::` before the note.
- **`page(ref, maxBytes = 60_000)`.** The `wiki.page` handler is unchanged; the reader passes `MAX_READER_BYTES`.
- **Open in tab** needs a focused local workspace; without one it answers `{ opened: false, message: NO_LOCAL_WORKSPACE_WIKI }` and writes nothing. The page read runs under the org's linked load.
- **Panel:**
  - `Open in tab` (small, solid) is the first action on a page, for project and code wikis alike.
  - It is disabled while `read:<key>` runs, so a second press sends nothing.
  - A refusal shows its message in a danger `Callout` under the actions. Opening shows nothing.

**Rules (Option A):**
- The copy is `.orca-ado/<readerName(org, wikiName, path)>`, under `wiki-read/`.
- The order, as S1 found read-only works:
  1. `ensureTabFolder`;
  2. `assertInside`;
  3. read the copy; when it exists with the same text, skip to step 7;
  4. `chmod 0o644` when it exists;
  5. write;
  6. `chmod 0o444`;
  7. `editor.open` on it. The answer is `openedReader(title)`.
- When S1 found anchors but no outline, the copy starts with a `Contents` list of links to its headings.

**Rules (Options B and C):**
- Open in tab writes `.orca-ado/<org>.wiki.<12 hex of sha256(JSON [org, wikiId, path])>.adowiki` holding `{ org, projectId, wikiId, path, title }` through `openTabFile`. It prunes `.adowiki` files older than 7 days, at most 50 a press, as `openRun` does.
- `wiki.read` answers `ReaderPage` with `markdown = readerMarkdown(page, wiki.editable)` under `ANSWER_BUDGET_BYTES`.
- **The frame:**
  - parses the reference (`parseReaderRef`, like `parseRunRef`) and requests `wiki.read`;
  - draws the title, a contents list of the headings (a side column from 900 px wide), and the Markdown, with raw HTML shown as text;
  - puts tables in a horizontally scrolling wrapper, with no mid-word breaks;
  - draws each Mermaid block through `renderPage`'s `diagrams` seam. `reader.ts` passes the vendored renderer, initialised with `startOnLoad: false`, `securityLevel: 'strict'` and the theme from `orca` theme events (`dark` for a dark theme, else `default`). A block the renderer rejects, and every block under Option C (`diagrams: null`), shows its source and "This diagram couldn't be drawn.";
  - links open through `orca.shell.openExternal`;
  - the page is read-only.

- [ ] **Step 1: Write the failing tests.**
  - (**Review Focus 5**) `mermaidBlocks finds both forms, skips other fences and runs an unclosed block to the end`
  - `toFencedMermaid turns colon blocks into fences and leaves the rest alone`
  - `diagramKind names each Mermaid kind and falls back to diagram`
  - `panelMarkdown leaves a ::: mermaid block untouched like code, and a cut closes it`
  - A: `Open in tab writes a read-only copy with fenced diagrams under .orca-ado/wiki-read and opens it`. B and C: `Open in tab writes a wiki tab file and opens it, and wiki.read returns the page for the frame`.
  - `Open in tab without a local workspace says so and writes nothing`
  - `a second Open in tab rewrites the copy only when the page changed` (A) / `opening again keeps one tab file per page` (B and C).
  - `the copy stays inside .orca-ado and refuses a symlinked folder` (A; real files in `mkdtemp`).
  - `a changed page rewrites a read-only copy and leaves it read-only` (A; real files in `mkdtemp`, mode `0o444` before and after).
  - `a code wiki copy's banner says to edit it in its repository, not Edit in Orca`
  - B and C: `parseReaderRef accepts only a complete reference`; `the reader lists the headings, shows raw HTML as text and wraps tables to scroll`; `a diagram the renderer rejects shows its source and This diagram couldn't be drawn.` (a fake `DiagramRenderer` whose `render` rejects; with `diagrams: null` every block does).
  - B: `the renderer is initialised with securityLevel strict and the Orca theme` (a fake renderer records its `initialize` config for light and dark).
  - main: `wiki.openInTab answers through the handler`
  - panel: `Open in tab sends wiki.openInTab for the page and shows a refusal`; `a second Open in tab press before the button redraws sends nothing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the shared part, then the chosen option.
- [ ] **Step 4: Run.** Expected: PASS; typecheck, validate and check pass (Options B and C: `check` loads the new editor without refused imports).
- [ ] **Step 5: Commit** "Open wiki pages full width with Mermaid drawn".

### Task 11: The wiki page in the sidebar

**Files:**
- **Create:** `src/panel/wiki/segments.ts`, `src/panel/wiki/segments.test.ts`.
- **Modify:** `src/shared/wiki-blocks.ts` (the table half), `src/shared/wiki-blocks.test.ts`, `src/panel/wiki/page-view.tsx`, `src/panel/wiki/fixtures.ts`, `src/panel/panel.check.ts` (the `wiki` page holds a diagram and a wide table).
- **Test:** `src/panel/wiki/wiki-tab.test.tsx`.

**Interfaces:**
- **Consumes:** T10 `mermaidBlocks`, `diagramKind`, `openInTab`; `closePage`, `edit`, `reloadPage`.
- **Produces:**

```ts
export const WIDE_TABLE_COLUMNS = 4
export const WIDE_TABLE_CHARS = 48
export type PageSegment =                                  // first, last: line indexes into the page, inclusive
  | { kind: 'markdown'; first: number; last: number; text: string; refs: string }   // refs: definitions it uses from elsewhere on the page
  | { kind: 'diagram'; key: string; first: number; last: number; diagram: string }
  | { kind: 'table'; key: string; first: number; last: number; columns: string[] }
export function pageSegments(markdown: string): PageSegment[]
export function backLabel(path: string): string        // '‹ Release process' | '‹ All pages'
```

**Rules:**
- **`tableAt`** finds a GFM table: a header row and a delimiter row of `---` cells with optional colons, then rows until a blank or non-table line. Cells split on `|` that isn't escaped (`\|`) and isn't inside a code span; edge pipes are optional.
- **`isWideTable`:** at least `WIDE_TABLE_COLUMNS` columns, or the sum of each column's longest trimmed cell above `WIDE_TABLE_CHARS` characters.
- **`pageSegments`** outside fenced code turns each Mermaid block into a diagram segment and each wide table into a table segment. Everything else stays in Markdown segments. The segments' `first..last` ranges cover every line of the input in order, without gaps or overlaps, and a Markdown segment's `text` is exactly its lines. That property is what the tests check. Keys are `diagram:<first>` and `table:<first>`.
- **References across segments.** Drawing each Markdown segment as its own `Markdown` node would break reference-style links and footnotes defined in another segment. So each Markdown segment's `refs` holds the link reference definitions (`[label]: url`) and footnote definitions (`[^label]: text`) it uses but doesn't hold, copied from the rest of the page outside code. Labels match case-insensitively. `page-view.tsx` draws `text`, a blank line, then `refs`.
- **`backLabel`:** `‹ ` plus the parent path's segments joined with ` / `; a top-level page gives `‹ All pages`.

**UI** (copy exact):
- **Header:**
  - `Link onPress={closePage}` with `backLabel(path)`;
  - `Heading level={3}` with the title;
  - one `Row gap="sm" align="center" wrap`: `Open in tab` (small, solid), `Edit in Orca` (small, outline, `icon="edit"`, project wikis only), `Link` "Open in Azure DevOps" (when openable), ghost small `IconButton icon="refresh" label="Refresh"`.

  The close IconButton and the muted path line go. The `notice`, Edit's result and Open in tab's refusal sit under the row.
- **Content:**
  - each Markdown segment as `Markdown` (its `text`, then its `refs`);
  - a diagram as `Card title="Diagram · <kind>"` with a small outline `Open in tab`;
  - a wide table as `Card title="Table · <n> columns" description={cutLabel(columns.join(' · '))}` with a small outline `Open in tab`;
  - empty content keeps "This page has no content yet."

**Changes** existing tests: `choosing a page shows it rendered with Open in Azure DevOps`, `a page that fails to load shows the message, Try again and Back`, `while a page loads a skeleton and Back are shown`, `a code wiki page has no Edit and says why`, `a page answer after Back is dropped` (Back is the back link).

- [ ] **Step 1: Write the failing tests.**
  - `tableAt splits on unescaped pipes outside code spans and isWideTable applies both limits`
  - (**Review Focus 5**) `pageSegments keeps every line outside diagrams and wide tables`: a page with CRLF, an unclosed `::: mermaid`, a mermaid fence inside a `~~~` block, a 64-column table and a narrow table. The ranges tile the input lines and each Markdown `text` equals its lines.
  - `a page whose link references and footnotes sit below a diagram keeps its links in the segment above`: that segment's `refs` holds the definitions it uses, and only those.
  - `a page shows a back link to its parent, the title and one row of actions`
  - `a top-level page's back link says All pages, and pressing it returns to the tree`
  - `a code wiki page offers Open in tab but not Edit in Orca, and says why`
  - `a Mermaid block in either form becomes a Diagram card with Open in tab`
  - `a wide table becomes a Table card naming its columns, and a narrow one stays in the text`
  - `a 60 KiB page with twenty diagrams and tables stays under 4,000 nodes and 450 KiB` (`closeCleanly`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; check passes with `wiki`.
- [ ] **Step 5: Commit** "Give the wiki page a one-row header and cards for diagrams and wide tables".

### Task 12: README

**Files:** `README.md`, `worker/readme.test.ts`.

- [ ] **Step 1: Write the failing test** `the README describes the grouped tabs, Columns and Lanes, tasks under their parent and Open in tab`: it asserts these appear:
  - in **The PRs tab**: `Across repos`, `Across projects`, `**Mine**`, `**To review**`;
  - in **The Pipelines tab**: `**All projects**`;
  - in **The Work tab**: `**Columns**`, `**Lanes**`, `**Not on this board**`, `**No parent**`, `Collapse all`;
  - in **The Wiki tab**: `**Open in tab**`.

  Edit the `On a page, press **Back** to reach them` assertion to the back-link wording.
- [ ] **Step 2: Rewrite the sections.**
  - **The Work tab:** the toolbar and board label; Columns and Lanes (the board's own swimlanes, Default lane, the note on a board without them); the two-line card, its type icon, Tasks n/m and compact Move; tasks under their parent of any type (every child task, done ones muted, others' names or Unassigned, up to 20 then `+ N more`, a parent that isn't yours dimmed in its column, a task under a task nested under it in Not on this board, a parent you can't read as `#id` under Unknown type); **Not on this board** grouped by type (replacing **Other**); **No parent** (only tasks with no parent); Collapse all and Expand all; what is remembered.
  - **The PRs tab:** project groups, repository groups and the Across repos and Across projects groups; the pickers; **Mine** and **To review** (with a project chosen, `To review · 3 of 12`); the place chip and the one status chip (replacing the chip list); the branch pattern; `+ N merged · show`; **Approve** and **Auto-complete**, which show only when they apply, with the settings sentence on Auto-complete's tooltip. Rename the headings `### Approve all` and `### Auto-complete all` to `### Approve` and `### Auto-complete`.
  - **The Pipelines tab:** grouping and pickers; the card (age, meta, requester left out on Mine); stage chips (keep `Up to 12 stages show.`, no `+N more`); the one-line approval; Share for approval sharing every waiting approval of the run.
  - **The Wiki tab:** folder and page icons with counts; the search row; remembered folders (up to 25 reopen at start); the back link, title and actions; diagram and table cards; **Open in tab** (as S1 chose: Orca's own view of a read-only copy under `.orca-ado/wiki-read/`, or the `.adowiki` tab with its vendored renderer, or, under Option C, with diagrams shown as source).
  - **Live checks still pending:** a new `Panel overhaul:` list naming Open in tab, Mermaid in both forms, child tasks on a real board, swimlanes, and each tab at 360 px in light and dark.
- [ ] **Step 3: Run** `orca plugin test . --json`. Expected: PASS, `# fail 0`.
- [ ] **Step 4: Commit** "Describe the calmer sidebar in the README".

### Task 13: Verification and live checks

- [ ] **Step 1:** Run `npm run typecheck`, `orca plugin test . --json` (exit 0, `# fail 0`), `orca plugin validate . --json` and `orca plugin check . --json`. All pass. Confirm the largest-fixture tests ran: Tasks 4, 5, 6, 7, 8, 9 and 11.
- [ ] **Step 2: Public data scan.** In the session scratchpad only, never in the repository, list the distinctive words, five-digit numbers and branch-like strings of the mock-ups under `.superpowers/brainstorm/`. Search `git diff 4bb5855...HEAD` for them. Expected: no hits beyond common words. Delete the scratchpad list.
- [ ] **Step 3: Live checks with the author** (deferred until the author is present). Fill the pending rows of the spike record:
  - (a) Each tab at 360 px, in light and dark, with real data.
  - (b) PRs and Pipelines: every card's project is visible without opening it; a several-repository project splits, a one-repository project stays flat; the pickers survive a reload.
  - (c) Work: every task sits under its parent or in No parent; nothing from before is missing; Columns and Lanes on a board with swimlanes; the view and open groups survive a reload.
  - (d) Wiki: folders differ from pages; Open in tab draws both Mermaid forms and wide tables readably; the read-only behaviour S1 predicted.
  - (e) Stage chips on every run card.
- [ ] **Step 4: Commit and report** which spikes were settled and which live rows remain.

---

## Pre-flight scan

Baseline `4bb5855`.

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T0 → all | Drift list, S1 option, S3 props, fixture | OK. T0 sends interface drift before T1. T10 waits on S1, and on the author's answer if S1 lands on Option C. |
| T1 → T2, T4, T5, T7, T8 | `groupByPlace`, `choicesOf`, `inScope`, folds, prefs, copy | OK. One rule for PRs and Pipelines (design §7); Work uses folds and prefs only. |
| T1 ↔ `folds.ts` users | `foldedAfter` | OK. Kept; `item-details.tsx` and Work state keep importing it until T7 drops Work's `closedGroups`. |
| T2 → T4, T5, T7, T8 | `TabToolbar`, `Group`, `Chips`, `reloadPanel` | OK. Each tab passes its own `left` and actions. `reloadPanel` takes a `module`, so T2 tests it on its own test module, and it checks the first mount with `closeCleanly`. |
| T3 → T4 | `StageChips` | OK. T4 composes the card around it; T3 ships alone. |
| T3 ↔ `worker/readme.test.ts` | `Up to 12 stages show.`; no `+N more` | OK. No overflow chip; T12 keeps the sentence. |
| T4 ↔ T5 | `panel.check.ts`, the Teams channels button | OK. Separate scenarios and tabs. |
| T5 ↔ review view | `showReview`, `openReview` | OK. Rows still open the in-panel review; the review view is untouched. |
| T6 → T7 | `WorkFamilies`, `BoardConfig.taskTypes` | OK. T7 reads `board.taskTypes ?? []`. |
| T6 ↔ board tab | `BoardConfig`, `loadBoardConfig` | **Risk, handled.** `taskTypes` is optional and set only on the default path, so named boards make no new request and the board tab's tests stay unedited. |
| T6 ↔ service tests | Batch lists | **Risk, handled.** The children read is skipped without child links, so tests on the existing fixture keep their batch lists; new tests add children with `addChildren`. |
| T6 ↔ panel `WorkSnapshot` literals | `families` | OK. T6 adds `families: NO_FAMILIES` to every literal T0 listed. |
| T6 ↔ `capSnapshot` | Item budget | **Risk, handled.** Items fit first against the budget without families, so every item that posts today still posts; families take only what is left, and trimmed lists keep their counts. |
| T6 ↔ recent writes | `overlay` | OK. `build` patches families for every item the overlay replaced, as `publish` does after a write. |
| T7 → T8 | `WorkCard`, `byColumn`, Work toolbar | OK. T7 has no view switch; T8 adds Columns and Lanes together with the Lanes view. |
| T9 ↔ T10, T11 | `wiki-tab.tsx`, `state.ts`, `page-view.tsx` | OK. T9 edits the tree side, T10 adds `openInTab` and one button, T11 rebuilds the page header around it. |
| T10 → T11 | `wiki-blocks.ts`, `openInTab` | OK. T10 writes the Mermaid half, T11 the table half. |
| T10 ↔ drafts | `draftName`, `assertInside`, `.orca-ado/wiki/` | OK (Option A). `draftName` keeps its output through `pageFileName('wiki', …)`; read copies live in `wiki-read/`, so a draft and a copy never share a file. |
| T10 ↔ `writeTabFile` | `ensureTabFolder` | OK (Option A). `writeTabFile` calls the extracted helper and keeps its tests; the read-only copy is written by the reader's own chmod sequence. |
| T10 ↔ `panelMarkdown` users | Colon blocks as code | OK. Comments and work item details rarely hold `::: mermaid`; left whole there too. |
| T10 (B, C) ↔ manifest | New custom editor | **Risk, flagged.** Validate and check must pass, and the live check confirms Orca loads it. |
| T12 ↔ T3–T11 | README wording | OK. Written last, from the code. |

### Each task against itself

| Task | Finding |
|---|---|
| T0 | OK. Commits only the spike record and one fixture. |
| T1, T2 | OK. Pure rules tested; components tested mounted, with a reload. |
| T3 | OK. The bug fix is its own commit with its own tests. |
| T4, T5 | OK. Grouping, pickers, the reload, Review Focus 2, and the largest fixtures with `closeCleanly`. |
| T6 | OK. One extra batched read with `errorPolicy: 'omit'`, its failure (Review Focus 1), the budget at 150 items and 300 tasks and past it. |
| T7, T8 | OK. Placement is pure and tested (Review Focus 4), parents of any type included; both views are tested at the largest fixture with nodes and bytes asserted. |
| T9 | OK. Icons, counts without reading ahead, remembered folders with start-up reads capped, 2,000 pages. |
| T10 | OK. Each option carries its own tests; the shared part is tested either way; the renderer seam covers failure and initialisation. |
| T11 | OK. Segments tile the text and keep cross-segment references (Review Focus 5); page budget asserted. |
| T12, T13 | OK. Docs, verification, the public data scan and the deferred live checks. |

## Plan review rulings

All twenty findings of the independent review are applied; none is rejected. Where the review offered a choice:

- Ruling: unassigned tasks are told apart by `WorkTask.mine` (and `TaskRow.mine`), and a task that is nobody's reads `Unassigned`; the old `TaskRow.mine` item field is now `item`.
- Ruling: the recent-writes fix lives in the worker (`build` patches families for every item the overlay replaced), because `done` needs the type's state categories, which the panel doesn't have.
- Ruling: reading the children of dimmed parents stays, on design §5.4 ("every child task of the parent"); it rides in the same batched read, so no request is added.
- Ruling: draft and auto-complete fold into the one status chip's text; the place chip stays only in Across groups, as §5.2 asks.
- Ruling: the To review switch follows the scope as `To review · <in scope> of <total>` with a project chosen, so the filter never hides how many reviews wait elsewhere.
- Ruling: a parent that can't be read, or that the post budget dropped, shows as a dimmed `#<id>` header in a final `Unknown type` group under Not on this board, since its type is unknown.
