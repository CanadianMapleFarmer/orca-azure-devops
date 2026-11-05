# Plan 5: PR reviews and wiki (basic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review other people's pull requests and read, search, edit and publish wiki pages without leaving Orca.

- **PRs tab:** Plan 3's **To review (N)** fold gains **Reviewed by you**. A row opens a review view in the tab. It has:
  - the description, the reviewers and the four votes;
  - **Files**: a read-only, numbered CodeView `diff` per file, and file and line comments;
  - **Comments**: Reply, Resolve and Reactivate;
  - **Check out in Orca**.
- **Wiki tab:** a wiki picker, a lazy page tree, the rendered page and search.
  - **Edit in Orca** writes the page as Markdown under the focused local workspace's git-ignored `.orca-ado/wiki/` and opens it in Orca's own editor.
  - **Publish** writes it back with the ETag. On a conflict, it shows both diffs and offers **Publish mine**, **Take theirs** or **Merge by hand**.
- **Not in this plan:**
  - Review-requested and new-comment notifications. Spec §6 lists them, but no roadmap row owns them and they would need a new setting. Task 12 asks the user for a ruling, and the roadmap records them as an open item.
  - Creating PRs.
  - Creating, moving or deleting wiki pages, and attachments.

**Architecture:**
- `worker/reviews/` and `worker/wiki/` are on-demand services with no polling. They sit on `worker/ado/pr-review.ts`, `worker/ado/wiki.ts` and `setVote`.
- The worker diffs file versions itself, since ADO has no unified diff.
- Check out reuses Plan 2's arm, widened with a base ref.
- The panels are `src/panel/prs/review/*` (inside the PRs tab) and `src/panel/wiki/*`.
- There is no new editor; wiki editing uses Orca's own editor on a plugin-managed `.md` file. This departs from spec §5.1 (wiki editing as a full-tab custom editor, decided with the user), §6 ("plugin's own full-tab editor") and roadmap row 5 ("edit in the plugin's tab"). The brief requires it, and §5.5 ("Edit opens the page as Markdown in Orca") supports it. Task 12's report asks the user to confirm the departure.

**Baseline:** `cd86753` (Plan 4 through Task 6).
- Plan 4 Tasks 7–12 Produces blocks count as existing:
  - `worker/tab-files.ts` (`TAB_FOLDER`, `TabFileFs`, `writeTabFile`)
  - `worker/pipelines/remote.ts` (`AdoRemote`, `remotesOf`, `gitRemotes`)
  - `worker/pipelines/open-file.ts`
  - `noRepoWorkspace(repo)`
  - the Pipelines tab in `panel.tsx`
  - `shareView(host)` and `openChannels(host)`
- Two Plan 4 rulings apply. They are recorded in Plan 4's ledger, `.superpowers/sdd/2026-11-05-plan-4-pipelines/progress.md`, which this worktree doesn't hold:
  - R3: "openBoard keeps its own workspace check and uses writeTabFile only; openTabFile serves openRun — board-file.test.ts stays unedited."
  - R8: "export align from src/panel/prs/state.ts (or move it to a shared helper) for the Pipelines tab — no copy."
- Task 0 re-reads them.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`), Orca components (`Table`, `Tree`, `Tabs`, `Markdown`, `CodeView`), `orca/testing`, ADO REST 7.1, `editor.open`, `workspace.open`, `workspace.list`, `workspace.readContext`, and the `workspace.create.*` hooks.

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md`. §5.5 is the scope; §2, §4.1, §4.2, §5.1, §5.4, §5.7, §5.8, §6 and §7 also apply. Roadmap row 5: `docs/superpowers/plans/2026-11-03-roadmap.md`.

## Global Constraints

Plans 1–4's Global Constraints still bind. Every commit ends with a blank line and a `Co-Authored-By:` trailer. Verification means `npm run typecheck`, `orca plugin test . --json` (`# fail 0`), `orca plugin validate . --json` and `orca plugin check . --json`.

- **Never:**
  - run `orca plugin dev load|watch|reload`, `enable` or `--approve`;
  - push, merge, change branches or write in the `plan-4-pipelines` worktree.
- **Worker limits.** The worker never runs the `orca` CLI. Its only git use is read-only `git -C <path> remote -v` (`gitRemotes`).
- **Secrets.** No token, PAT, `Authorization` value or webhook URL outside `orca.secrets`.
- **Tests fake ADO** with `fakeAdo()`: `on`, `hold`, `hang`, `count` and `calls`, never `clear()`. Live checks wait for Task 12 with the user.
- **Writes.** Each runs only from a press, reads fresh first and makes at most one write. Writes are never auto-retried and report only what ADO answered. A write's button is disabled while that action runs, so a second press before the redraw sends nothing.
- **Copy and errors.**
  - Only messages reach the UI: the panel shows `messageOf(error)`, and Orca maps codes to `action_failed`.
  - Worker copy lives in `worker/messages.ts`; shared copy in `src/shared/messages.ts`.
  - Hosts come only from `worker/ado/org.ts`. Only `branchName` strips `refs/heads/`.
- **Timers.** None outside the scheduler. Nothing here polls; data loads on open, after actions and on Refresh.
- **Aborts.** Each load runs under `linkedAbort`, taken off the org entry's controller, released in `finally` and passed down with `withSignal`. `onOrgs` aborts orgs that leave `connected`; from then on they get `notConnected()`.
- **Budgets** (`byteLength`, `worker/budget.ts`):
  - an answer at most `ANSWER_BUDGET_BYTES` (900 KiB, moved from Plan 4's `run-views.ts` into `worker/budget.ts` by Task 1);
  - diff text at most `MAX_DIFF_BYTES` (60 KiB);
  - panel Markdown at most 60,000 bytes;
  - a panel render under 4,000 nodes and 450 KiB of tree data.

  Orca refuses a render past 5,000 nodes, 512 KiB, 16 KiB per text, 1 KiB per label, 64 KiB per Markdown or CodeView, 500 Select options, 2,000 Tree items or 5,000 Table rows. Nothing is posted.
- **Wiring.** One `register*Handlers` per feature, composed in `worker/main.ts`. Mounted tests use `withWorker`.
- **Code and manifest.** Zero code comments. No new capabilities, settings, hooks or editors.
- **Generic.** Names come from ADO or `git remote -v`; `origin` is only a fallback. Fixtures:
  - `contoso`, `Fabrikam Web`, `web-app`;
  - PR 4110 (`hotfix/1211-login-redirect` → `main`, by Grace Hopper, to review) and PR 4111 (I voted 5);
  - wikis `Fabrikam Web.wiki` (project) and `api-docs` (code).
- **Draft paths** come only from `draftName`, `baseName` and `theirsName`. `assertInside` runs before every mkdir, read, write and rm, including the `writeTabFile` call. It refuses any symlink from `.orca-ado` down to the file.
- **ADO endpoints.** Base `https://dev.azure.com/{org}/{projectId}`, version 7.1. Tasks cite them by these labels.
  - **PR:** `GET /_apis/git/repositories/{repo}/pullrequests/{prId}`. This is Plan 3's `getPullRequest`, which now also reads `description` and `forkSource`.
  - **iterations:** `GET …/pullRequests/{prId}/iterations`
  - **changes:** `GET …/iterations/{id}/changes?$compareTo=0&$top=1000`
  - **threads:** `GET …/pullRequests/{prId}/threads?$iteration={latest}&$baseIteration=0`
  - **thread:** `GET …/threads/{threadId}`
  - **blob size:** `GET /_apis/git/repositories/{repo}/blobs/{objectId}`, JSON `size`.
  - **file text:** `GET /_apis/git/repositories/{repo}/items?path=&versionDescriptor.version={commit}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json`
  - **vote:** `PUT …/pullRequests/{prId}/reviewers/{me}` with `{ vote, isRequired }` (10, 5, −5, −10).
  - **reply:** `POST …/threads/{threadId}/comments` with `{ content, parentCommentId, commentType: 'text' }`.
  - **status:** `PATCH …/threads/{threadId}` with `{ status }`.
  - **new thread:** `POST …/pullRequests/{prId}/threads` with `{ comments: [{ parentCommentId: 0, content, commentType: 'text' }], status: 'active', threadContext?, pullRequestThreadContext? }`.
  - **wikis:** `GET https://dev.azure.com/{org}/_apis/wiki/wikis`
  - **level:** `GET /_apis/wiki/wikis/{wikiId}/pages?path=&recursionLevel=oneLevel`
  - **page:** `GET …/pages?path=&includeContent=true`. The `ETag` header is the version.
  - **publish:** `PUT …/pages?path=` with `If-Match` and `{ content }`.
  - **search:** `POST https://almsearch.dev.azure.com/{org}/{projectId}/_apis/search/wikisearchresults` with `{ searchText, $top: 25, $skip: 0, filters: { Wiki: [name] }, includeFacets: false }`. Plan 1's client retries once with `-preview` if asked.

## Review Focus

1. **Huge PRs and files.** 2,000 files, a 5 MB generated file, a 300 KB line, 10,000 changed lines, binaries, 150 short threads, 300 long comments. Every view renders, and each part left out says why. *Tests:*
   - T2 `diffText degrades for oversized, too-many-change and long-line files and caps the bytes`;
   - T3 `a review of 2,000 files and 300 long comments fits the answer budget and says what was left out`, and `150 short threads keep 100, count all 150 and say some were left out`;
   - T7 `the largest review stays under 4,000 nodes and 450 KiB in every section`.
2. **A wiki page that changed while you edited.** Someone else's save, a race between the fresh read and the PUT, a deleted page, an ETag change with no content change, a Publish right after Merge by hand. Nothing is overwritten silently: at most one PUT per press, and both diffs are shown. *Test:* T10 `publish never overwrites a page that changed since the draft began`.
3. **Hostile or ADO-only markup.** `<img onerror>`, `javascript:` in inline, reference-style, autolink and raw `<a>` links, `/.attachments` images, `@<GUID>` mentions, `[[_TOC_]]`, a 200 KB comment. Images become links, unsafe hrefs are dropped, mentions show names, code is left alone, and long text is cut with a note. *Test:* T1 `panelMarkdown makes hostile and ADO-only markup safe to show`.
4. **A PR that changes under a press.** It completed after it was opened, a thread was deleted, a push dropped a file, the line is past the end, or ADO answers 403. One fresh read, at most one write, and a truthful result. *Test:* T4 `writes read fresh and report what Azure DevOps did`.
5. **A hostile page path.** `/../../etc/passwd`, `Q&A: what?`, `CON`, trailing dots, 300 characters, a deep page past 200 characters, `Foo` and `foo`, a page titled `X.theirs`, two pages that clean to one name, and a committed symlink at `.orca-ado`, `.orca-ado/wiki` or a draft file. Drafts stay inside, unique and valid on every OS, and nothing is created outside. *Test:* T9 `draft file names stay inside the wiki folder and are valid on every OS`.

---

## Shared types

Task 1 creates these. The panel imports them, so they use no Node APIs.

```ts
// src/shared/diff.ts
export const MAX_DIFF_BYTES = 60 * 1024
export interface DiffText { text: string | null; message?: string }
// src/shared/reviews.ts
export interface ReviewKey extends PrKey { org: string }
export type VoteChoice = 'approve' | 'suggestions' | 'waitForAuthor' | 'reject'
export const VOTE_VALUE: Record<VoteChoice, number>      // 10, 5, -5, -10
export const VOTE_BUTTON: Record<VoteChoice, string>     // 'Approve', 'Approve with suggestions', 'Wait for author', 'Reject'
export function votePhrase(vote: number): string          // 'Approved' | 'Approved with suggestions' | 'Waiting for author' | 'Rejected' | 'No vote'
export type ChangeKind = 'added' | 'edited' | 'deleted' | 'renamed'
export interface ChangedFile { path: string; originalPath: string | null; kind: ChangeKind }
export type ThreadStatus = 'active' | 'pending' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'unknown'
export const THREAD_STATUS_LABEL: Record<ThreadStatus, string>   // Active, Pending, Resolved, Won't fix, Closed, By design, Unknown
export function isResolved(status: ThreadStatus): boolean         // fixed | wontFix | closed | byDesign
export interface ThreadAnchor { path: string; line: number | null; side: 'new' | 'old' }
export const MAX_REVIEW_COMMENT = 10_000
export interface ReviewComment { id: number; author: string; at: number; content: string }
export interface ReviewThread { id: number; status: ThreadStatus; anchor: ThreadAnchor | null; comments: ReviewComment[]; hidden: number }
export interface PrReview { key: ReviewKey; pr: PrSummary; description: string; myVote: number; files: ChangedFile[]; moreFiles: boolean; threads: ReviewThread[]; threadCount: number; loadedAt: number; message?: string }
export type LineCount = number | null | 'unknown'                 // null: the side is absent; 'unknown': never read (blob over 2 MiB)
export interface FileDiff extends DiffText { path: string; lines: { old: LineCount; new: LineCount } }
export interface ReviewResult { ok: boolean; message: string; warn?: true }
export type CheckoutResult = { status: 'opened' | 'refused'; message: string } | { status: 'armed'; message: string; armedUntil: number }
// src/shared/wiki.ts
export const MAX_DRAFTS = 50
export const MIN_SEARCH_CHARS = 2
export interface WikiRef { id: string; name: string; projectId: string; projectName: string; editable: boolean; mappedPath: string | null }
export interface WikiPageRef { org: string; projectId: string; wikiId: string; path: string }
export interface WikiNode { path: string; title: string; hasChildren: boolean }
export interface WikiLevel { pages: WikiNode[]; total: number }
export interface WikiPage extends WikiPageRef { title: string; content: string; url: string; editable: boolean; notice?: string }
export interface WikiHit { path: string; title: string; snippet: string }
export interface DraftSummary extends WikiPageRef { key: string; wikiName: string; title: string; file: string; workspaceName: string; changed: boolean; publishedAt: number | null }
export type WikiResult =
  | { status: 'published' | 'unchanged' | 'updated' | 'failed'; message: string }
  | { status: 'conflict'; message: string; theirs: DiffText; mine: DiffText }
```

`src/protocol.ts` additions. Each task adds what it registers. No panel events are added. Task 6 adds `reviewed: PrSummary[]` to `PrSnapshot`.

```ts
'reviews.open': { input: ReviewKey; output: PrReview }                                                         // T3
'reviews.diff': { input: ReviewKey & { path: string }; output: FileDiff }                                      // T3
'reviews.vote': { input: ReviewKey & { vote: VoteChoice }; output: ReviewResult }                              // T4
'reviews.reply': { input: ReviewKey & { threadId: number; text: string }; output: ReviewResult }              // T4
'reviews.setStatus': { input: ReviewKey & { threadId: number; status: 'fixed' | 'active' }; output: ReviewResult } // T4
'reviews.comment': { input: ReviewKey & { text: string; path?: string; line?: number }; output: ReviewResult } // T4
'reviews.checkout': { input: ReviewKey; output: CheckoutResult }                                               // T5
'wiki.list': { input: { org: string }; output: WikiRef[] }                                                     // T8
'wiki.pages': { input: WikiPageRef; output: WikiLevel }                                                        // T8
'wiki.page': { input: WikiPageRef; output: WikiPage }                                                          // T8
'wiki.search': { input: Omit<WikiPageRef, 'path'> & { text: string }; output: { hits: WikiHit[]; total: number } } // T8
'wiki.edit': { input: WikiPageRef; output: { opened: boolean; message: string } }                              // T9
'wiki.drafts': { input: { org: string }; output: DraftSummary[] }                                              // T9
'wiki.discard': { input: { key: string }; output: { ok: true; message: string } }                             // T9
'wiki.publish': { input: { key: string }; output: WikiResult }                                                 // T10
'wiki.resolve': { input: { key: string; choice: 'mine' | 'theirs' | 'merge' }; output: WikiResult }           // T10
```

---

### Task 0: Spikes (offline halves) and baseline re-check

**Files:** `docs/superpowers/spikes/2026-11-05-plan-5.md`, in Plan 4's shape:
- one table per spike, with rows "Question · Method · Result · Decision";
- live rows marked **pending live** for Task 12;
- probes kept outside the repo; bundle reads read-only (`python3 -I`).

- [ ] **Step 1: Baseline re-check.**
  - At the post-Plan-4 head, re-read every "Consumes" signature in Tasks 1–11 and the exports of each file in the pre-flight table.
  - Record each drift as "cited · actual · tasks affected".
  - Answer:
    - (a) Does `writeTabFile` accept names with `/`? Task 9 assumes it doesn't.
    - (b) Is Plan 4's `ANSWER_BUDGET_BYTES` still private to `worker/pipelines/run-views.ts`? Task 1 moves it.
    - (c) Is the remote-to-repo match private to `open-file.ts`?
    - (d) Where is `gitRemotes(…)` created?
    - (e) Which tests assert "Coming in a later update"?
    - (f) Does any test call `registerWorkspaceHandlers` directly?
  - Interface drift goes to the controller before Task 1.
- [ ] **Step 2: S1 Check out in Orca.**
  - No host call creates a worktree. `workspace.create.before` may change `name`, `branch` and `base`.
  - In `app.asar` `out/main/index.js`, they become `branchNameOverride` and `baseBranch`. Record:
    - (a) whether an unfetched `<remote>/<branch>` base is fetched. First read: yes, via `resolveRemoteTrackingBase`.
    - (b) the outcome for a branch that is local, remote-only, or checked out elsewhere. First read: a local branch is checked out as is; a remote-only name may be refused or suffixed `-2` by `As(name, n)`. Read the conflict check.
    - (c) the form of `workspace.list` `branch`.
    - (d) whether `workspace.create.before`'s `projectId` can be tied to a candidate workspace (for example through its path, or the project of the workspace `workspace.open` focused). Task 5 scopes the PR arm by it only if it can.
    - (e) whether a project opened from a `folder`-kind workspace can create worktrees. If not, Task 5 ranks `worktree`-kind candidates first.
  - Decide:
    - **Option A** arms `{ branch: <source>, base: '<remote>/<source>' }`, if Orca checks the source branch out under its own name.
    - **Option B** arms `{ branch: 'review/<prId>', base: '<remote>/<source>' }`. It always works, but Orca's PR card won't match.
  - Record what the user sees, step by step.
- [ ] **Step 3: S2 Review shapes and fixtures.** Record the shapes Tasks 3 and 4 assume, citing the recon and the 7.1 reference: the iteration commits (and whether `targetRefCommit` is a usable old side when `commonRefCommit` is missing), the change entries and their `changeType` flags, the blob `size`, the item `content` and `isBinary`, thread anchors, `commentType`, `identities` and `@<GUID>` mentions, and the new-thread `offset: 1` and `pullRequestThreadContext`. Then write these fixtures:
  - `pull-request-4110.json`: the description has a `/.attachments` image and a mention.
  - `pr-iterations-4110.json`: iterations 1 and 2.
  - `pr-changes-4110.json`: an edit to `/src/auth/redirect.ts`, an added `redirect.test.ts`, a deleted `legacy-return.ts`, a rename from `/docs/login.md` to `/docs/auth.md` with the same blob, an added binary `/assets/lock.png`, and a folder.
  - `pr-threads-4110.json`:
    - a general active thread in which Grace mentions `@<9D1C2B3A-4444-4E5F-8A6B-7C8D9E0F1A2B>` (fake-prs `ME`, Alex Contoso) and Alex replies;
    - a fixed thread at right line 42 of `redirect.ts`;
    - a pending thread at left line 7 of the deleted file;
    - a `system` vote thread;
    - a deleted thread.
  - `pr-files-4110.json`: maps `<commit>:<path>` to `{ objectId, content, isBinary }`. `redirect.ts` grows from 60 to 64 lines, with the change around lines 40–45.
  - `pr-thread-created.json` and `pr-comment-created.json`.
- [ ] **Step 4: S3 Wiki shapes and fixtures.** Record the shapes Task 8 assumes:
  - the wiki `type` (`projectWiki` or `codeWiki`);
  - `subPages[]` with `order` and `isParentPage`;
  - a quoted `ETag` header, with a new one on a PUT;
  - a stale `If-Match` answering 412 (Task 10 treats 409 the same way);
  - search `path` as the git path, for example `/Release-process/Checklist.md`, with `<highlighthit>` marking matches; for a code wiki, whether it carries the `mappedPath` prefix;
  - the wiki `mappedPath` field;
  - which search error (status and `typeKey`) means search isn't offered, as opposed to a rejected query.

  Code wikis are read-only in this plan. Write these fixtures:
  - `wikis.json`: `api-docs` has `mappedPath: '/docs'`;
  - `wiki-level-root.json`: `/Home`, `/Release process` (a parent), `/Onboarding` and `/Résumé` (a parent);
  - `wiki-level-release.json`: `Checklist` and `Rollback`;
  - `wiki-page-checklist.json`: an `/.attachments/flow-1a2b.png` image, `<img src="/.attachments/x.png" width=300>`, `[Rollback](/Release-process/Rollback)` and `[[_TOC_]]`;
  - `wiki-page-unicode.json`: `/Résumé/Überblick 文档`;
  - `wiki-search.json`: a project-wiki hit, an `api-docs` hit at `/docs/Setup-guide.md`, and a hit at `/FAQ%3A-login.md`.
- [ ] **Step 5: S4 Editing in Orca.** Record:
  - Plan 2's finding that `editor.open` takes git-ignored `.orca-ado/` paths;
  - that `.md` opens in Orca's own editor (custom editors are only an option there);
  - what the bundle does when an open file is rewritten on disk.
- [ ] **Step 6: S5 Panel limits.** Confirm the Global Constraints values with `orca skills get orca-plugin-authoring --reference components`, and that `panel.warnings` reports a refused render. Every budget test ends with `closeCleanly`.
- [ ] **Step 7: Pending live rows.**
  - S1: creating the armed worktree (local, remote-only, and checked-out-elsewhere branches), a worktree created in another project while armed, then the Source Control compare.
  - S2: every shape, thread positions, the offset rule, and mention names.
  - S3: the ETag form, the PUT conflict status, a code wiki, search on the client org, the git-path mapping (including a `mappedPath` code wiki and a unicode page), and the search error forms.
  - S4: the editor, its preview, and an outside rewrite with unsaved edits.
  - Both views at 360 px in both themes.
- [ ] **Step 8: Commit** "Record the Plan 5 spikes".

### Task 1: Shared types, panel Markdown and the search host

**Files:**
- **Create:** the three shared files and `worker/panel-markdown.ts`.
- **Modify:**
  - `worker/ado/org.ts`: `orgSearchUrl`.
  - `worker/ado/http.ts`: `host?: 'vssps' | 'almsearch'`.
  - `worker/budget.ts`: exports `ANSWER_BUDGET_BYTES = 900 * 1024`, moved from `worker/pipelines/run-views.ts`, which now imports it.
  - `worker/messages.ts`: `MARKDOWN_CUT_NOTE` "The rest is in Azure DevOps." and `imageLink(alt)` = `Image: <alt>`.
  - `src/shared/messages.ts`: `BAD_LINE` "Enter the line as a whole number from 1 up."
- **Test:** `src/shared/reviews.test.ts`, `worker/panel-markdown.test.ts`, `worker/ado/http.test.ts`, `worker/ado/org.test.ts`. `worker/pipelines/run-views.test.ts` stays green unedited.

**Interfaces:**
- Consumes `PrKey`, `PrSummary`, `orgWebUrl`, `UNKNOWN_AUTHOR` and `cutText`.
- Produces the shared types, and:

```ts
export function orgSearchUrl(org: string): string     // https://almsearch.dev.azure.com/<encoded org>
export interface MarkdownTarget { maxBytes: number; resolve: (href: string) => string; people?: ReadonlyMap<string, string> }
export function panelMarkdown(text: string, target: MarkdownTarget): string
```

**Rules for `panelMarkdown`:**
- Fenced code blocks and inline code spans are left untouched; every rule below applies only outside them.
- `![alt](src)` and `<img … src=…>` become `[Image: alt](href)`.
  - The alt falls back to the file name, then to `image`.
  - The href is `src` when it is `http(s):`, otherwise `resolve(src)`.
- `http:`, `https:` and `mailto:` links stay. Any other href becomes `resolve(href)`, which must return `https:`. This applies to inline links, reference definitions (`[r]: href`) and autolinks (`<scheme:…>`).
- A raw `<a …>` keeps its text and loses the tag.
- Lines that are exactly `[[_TOC_]]` or `[[_TOSP_]]` are dropped.
- `@<GUID>` becomes `@<name>` from `people` (matched case-insensitively), or `@Unknown`.
- Past `maxBytes` (UTF-8), the text is cut at a line break, an open code fence is closed, and `\n\n*The rest is in Azure DevOps.*` is appended.

- [ ] **Step 1: Write the failing tests.**
  - `votePhrase names every vote and isResolved covers the resolved statuses`.
  - `panelMarkdown turns images into links and resolves relative links`.
  - (**Review Focus 3**) `panelMarkdown makes hostile and ADO-only markup safe to show`:
    - `<img src=/x.png onerror=alert(1)>` becomes a link to `resolve('/x.png')`;
    - `[x](javascript:alert(1))`, `[x][r]` with `[r]: javascript:alert(1)` and `<javascript:alert(1)>` each get the resolved https href;
    - `<a href="javascript:alert(1)">x</a>` becomes plain `x`;
    - the `ME` mention becomes `@Alex Contoso`, and an unknown one `@Unknown`;
    - no `[[_TOC_]]`;
    - a mention, `[[_TOC_]]` and `![a](b.png)` inside a fenced block and inside inline code come out unchanged;
    - a 200 KB comment is cut with the note.
  - `panelMarkdown cuts at a line and closes an open code block`.
  - `a search request goes to almsearch.dev.azure.com`.
  - `orgSearchUrl encodes the org`.
- [ ] **Step 2: Run** `orca plugin test . --json`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, and `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Add review and wiki types, panel Markdown and the search host".

### Task 2: Line diff

**Files:**
- **Create:** `worker/reviews/diff.ts`.
- **Test:** `worker/reviews/diff.test.ts`.
- **Modify:** `worker/messages.ts`:
  - `DIFF_BINARY` "Binary file; it isn't shown here."
  - `DIFF_TOO_LARGE` "This file is too large to show here. Check out the branch in Orca to see it."
  - `DIFF_TOO_MANY` "Too many changes to show here. Check out the branch in Orca to see this diff."
  - `DIFF_NO_TEXT_CHANGES` "No text changes in this file."
  - `diffCut(n)` "Showing the first <n, en-US> lines of this diff. Check out the branch in Orca for the rest."

**Interfaces:**

```ts
export const CONTEXT_LINES = 3
export const MAX_EDITS = 2_000
export const MAX_SIDE_LINES = 50_000
export const MAX_DIFF_LINE_CHARS = 1_000
export const MAX_DIFF_WORK = 20_000_000
export interface DiffLine { kind: ' ' | '-' | '+'; old: number | null; new: number | null; text: string }
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
export function splitLines(text: string): string[]
export function diffLines(before: readonly string[], after: readonly string[], limits?: { edits?: number; work?: number }): Hunk[] | 'tooMany'   // defaults MAX_EDITS, MAX_DIFF_WORK
export function formatHunks(hunks: readonly Hunk[], maxBytes?: number): { text: string; shownLines: number; cut: boolean }
export function diffText(before: string | null, after: string | null): DiffText & { lines: { old: number | null; new: number | null } }
```

**Rules:**
- **`splitLines`:** split on `\n` and drop a trailing `\r`. A final newline adds no empty line, and `''` gives `[]`.
- **`diffLines`:** trim the common prefix and suffix first. If a side is then empty, the result is a pure insert or delete, with no edit limit.
  - Otherwise, run Myers' greedy algorithm on lines interned to integers. Step `d` keeps a copy of `V` of size `2d+1` (not `N+M+1`), for the backtrack.
  - Past `limits.edits`, or once the diagonals visited plus the snake comparisons pass `limits.work`, return `'tooMany'`. This bounds the synchronous work on the worker thread.
  - Use `CONTEXT_LINES` of context; touching hunks merge.
- **`formatHunks`:**
  - A hunk header is `@@ -a,b +c,d @@`.
  - A line is `<kind><old> <new> │ <text>`. Numbers are right-aligned to the widest, and blank where the line is absent. The marker stays first, so CodeView's `diff` grammar colours the line.
  - Text is cut at `MAX_DIFF_LINE_CHARS` with `…`.
  - Output stops before `maxBytes` (default `MAX_DIFF_BYTES`), with `cut` set.
- **`diffText`:** `null` means an absent side.
  - Over `MAX_SIDE_LINES` gives `text: null` and `DIFF_TOO_LARGE`.
  - `'tooMany'` gives `DIFF_TOO_MANY`.
  - No hunks gives `DIFF_NO_TEXT_CHANGES`.
  - A cut gives `diffCut(shownLines)`.
  - `lines` counts each present side.

- [ ] **Step 1: Write the failing tests.**
  - `splitLines handles LF, CRLF and a missing final newline`.
  - `diffLines finds the smallest edit with three lines of context and merges close hunks`.
  - `an added or deleted file is one hunk with no edit limit` (30,000 added lines).
  - `diffLines gives up past the edit limit or the work limit`:
    - two unrelated 3,000-line texts give `'tooMany'`;
    - a 100,000-line file of unique lines with 900 scattered one-line replacements (edit distance 1,800) still diffs;
    - the same file with `limits.work` at 100,000 gives `'tooMany'`.
  - `formatHunks numbers old and new lines and keeps the marker first` (exact text for a five-line change).
  - (**Review Focus 1**) `diffText degrades for oversized, too-many-change and long-line files and caps the bytes`:
    - 50,001 lines give `DIFF_TOO_LARGE`;
    - a 300 KB line is cut to 1,000 characters;
    - 5,000 appended lines (a pure insert after trimming) stay within `MAX_DIFF_BYTES` and say `diffCut(n)`;
    - 10,000 changed lines in a 10,000-line file give `DIFF_TOO_MANY`.
  - `identical texts say there are no text changes`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, and typecheck passes.
- [ ] **Step 5: Commit** "Diff file versions line by line".

### Task 3: Read pull request reviews and file diffs

**Files:**
- **Create:**
  - `worker/ado/pr-review.ts`
  - `worker/reviews/{threads,service,handlers}.ts`
  - `worker/reviews/fake-reviews.ts`: `fakeReviews()` is `fakePrs()` plus routes for iterations, changes, threads, a thread, blobs and items. It exports the matchers `isIterations`, `isChanges`, `isThreads`, `isThreadGet`, `isBlob` and `isItem`, and a `review` handle whose `pr`, `threads` and `files` tests mutate.
- **Modify:**
  - `worker/ado/pullrequests.ts`: `RawPullRequest` gains `description?: string` and `forkSource?: unknown`.
  - `src/protocol.ts`.
  - `worker/messages.ts`:
    - `MALFORMED.review` "Azure DevOps returned an unexpected pull request review response."
    - `REVIEW_PR_GONE` "That pull request no longer exists, or you can't see it."
    - `REVIEW_TRIMMED` "Some comments were left out to keep this view small. Open the pull request in Azure DevOps to see them all."
    - `DIFF_NO_BASE` "Azure DevOps hasn't worked out this pull request's base yet, so the diff can't be shown. Refresh in a moment, or check the branch out in Orca."
    - `REVIEW_FILES_CAPPED` "More than 1,000 files changed. Open the pull request in Azure DevOps, or check it out in Orca, to see them all."
    - `FILE_NOT_IN_PR` "That file isn't changed in this pull request any more."
    - `renamedFrom(path)` "Renamed from <path>."
  - `worker/main.ts`: `createReviews`; `onOrgs` in the connections `post` and at start; `registerReviewHandlers`.
- **Test:** `worker/ado/pr-review.test.ts`, `worker/reviews/threads.test.ts`, `worker/reviews/service.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- **Consumes:** Tasks 1–2; `getPullRequest`, `toPrSummary` and `RawPullRequest`; `isSignedIn`, `notConnected` and `loadFailure` (`worker/org-status.ts`); `PRS_NEED_CODE_READ`.
- **Produces:**

```ts
// worker/ado/pr-review.ts
export interface RawThread { id: number; status?: string; isDeleted?: boolean; threadContext?: { filePath?: string; rightFileStart?: { line: number } | null; leftFileStart?: { line: number } | null } | null; comments?: { id: number; author?: { id: string; displayName: string }; content?: string; publishedDate?: string; commentType?: string; isDeleted?: boolean }[]; identities?: Record<string, { id: string; displayName: string }> | null }
export interface IterationFacts { id: number; source: string; common: string | null }
export interface FileFacts extends ChangedFile { changeTrackingId: number; objectId: string | null; originalObjectId: string | null }
export function latestIteration(http: AdoHttp, org: string, key: PrKey, signal?: AbortSignal): Promise<IterationFacts>
export function listChanges(http: AdoHttp, org: string, key: PrKey, iterationId: number, signal?: AbortSignal): Promise<{ files: FileFacts[]; more: boolean }>
export function listThreads(http: AdoHttp, org: string, key: PrKey, iterationId: number, signal?: AbortSignal): Promise<RawThread[]>
export function getThread(http: AdoHttp, org: string, key: PrKey, threadId: number): Promise<RawThread | null>
export function blobSize(http: AdoHttp, org: string, key: PrKey, objectId: string, signal?: AbortSignal): Promise<number>
export function fileText(http: AdoHttp, org: string, key: PrKey, path: string, commitId: string, signal?: AbortSignal): Promise<{ text: string; binary: boolean }>
// worker/reviews/threads.ts
export const MAX_THREADS = 100
export const MAX_COMMENTS_PER_THREAD = 20
export const MAX_COMMENT_BYTES = 8_000
export function toReviewThreads(raw: readonly RawThread[], context: { people: ReadonlyMap<string, string>; prUrl: string }): { threads: ReviewThread[]; total: number }
export function fitReview(review: PrReview, budget: number): PrReview
// worker/reviews/service.ts
export interface Reviews {
  onOrgs(orgs: OrgStatus[]): void
  open(key: ReviewKey): Promise<PrReview>
  diff(input: ReviewKey & { path: string }): Promise<FileDiff>
  pullRequest(key: ReviewKey): Promise<RawPullRequest>
  fileFacts(input: ReviewKey & { path: string }): Promise<{ iterationId: number; file: FileFacts; lines: FileDiff['lines']; binary: boolean } | null>
}
export function createReviews(deps: { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; now: () => number }): Reviews
// worker/reviews/handlers.ts
export interface ReviewHandlerDeps { reviews: Reviews }      // T4 adds actions, T5 checkout
export function registerReviewHandlers(orca: OrcaWorkerApi, deps: ReviewHandlerDeps): void
```

**Rules.** Endpoints: PR, iterations, changes, threads, thread, blob size and file text.
- **ADO reads:**
  - `latestIteration` takes the highest `id`. A missing source commit is malformed. `common` is `commonRefCommit`, else `targetRefCommit` if S2 found it usable, else null.
  - `listChanges` skips folders. The kind follows the `changeType` flags: `delete`, else `add`, else `rename`, else edited. `originalPath` is set only for a rename. `more` is `nextTop > 0`, or exactly 1,000 entries.
  - `fileText`: `binary` is `contentMetadata.isBinary`, or text that holds `\u0000`.
  - `getThread` returns null on `not_found`.
- **`toReviewThreads`:**
  - Drop deleted threads, deleted and `system` comments, then any thread left empty.
  - The anchor is `threadContext.filePath`. A right line is side `new`, a left line `old`, and no line means `line: null`.
  - Content goes through `panelMarkdown` (at most `MAX_COMMENT_BYTES`, links to `prUrl`). `people` are the author, reviewers, `identities` and commenters.
  - Order: unresolved first, then newest comment descending, then `id` descending. Keep at most `MAX_THREADS`. `total` counts every thread left after the drops, before this cap.
  - Past 20 comments, keep the first and the 19 newest; `hidden` counts the rest.
- **`fitReview`:** measure each thread once with `itemBytes`, then drop threads from the end, subtracting their bytes, until the review fits (as `newestThatFit` does). Join `REVIEW_TRIMMED` whenever `threads.length < threadCount`, whether threads went by count or by bytes.
- **`open`:**
  - Read the PR, then the latest iteration, then changes and threads together.
  - The description goes through `panelMarkdown` (60,000 bytes, links to the PR, the same `people` as the threads).
  - `myVote` is my reviewer vote, or 0. `threadCount` is `toReviewThreads`' `total`.
  - `moreFiles` joins `REVIEW_FILES_CAPPED`.
  - The facts are kept per PR (LRU 5) for `diff`.
- **`diff`:**
  - Use the kept facts, or read them. An unknown path is `badRequest(FILE_NOT_IN_PR)`.
  - The old side is read at `common`, under `originalPath ?? path`; the new side at `source`. An added file has no old side; a deleted file has no new side.
  - An unchanged rename gives `renamedFrom` and no text. An edited rename joins `renamedFrom` to the message.
  - A null `common` gives `DIFF_NO_BASE` for any file with an old side; an added file still diffs.
  - A blob over 2 MiB gives `DIFF_TOO_LARGE`, without reading its content, and that side's `lines` is `'unknown'`. A binary gives `DIFF_BINARY`.
  - Text is cached by object id (LRU 100, 32 MiB), so a repeat makes no calls.
- **`pullRequest` and `fileFacts`** always read fresh. `fileFacts` is null when the path isn't in the latest iteration. Its `lines` follow `diff`: `'unknown'` for a side over 2 MiB.
- **Errors:** PR `not_found` gives `REVIEW_PR_GONE`; `forbidden` gives `PRS_NEED_CODE_READ`; a signed-out org gives `notConnected()`.

- [ ] **Step 1: Write the failing tests.**
  - **ADO reads:**
    - `latestIteration picks the newest iteration`.
    - `listChanges maps adds, edits, deletes and renames and skips folders`.
    - `listThreads asks for positions on the latest iteration`.
    - `fileText reads JSON content and spots binaries`.
  - **Threads:**
    - `toReviewThreads keeps people's comments, anchors and order`: the general thread comes first and shows `@Alex Contoso`; the fixed thread is `{ path: '/src/auth/redirect.ts', line: 42, side: 'new' }`; the deleted file's thread is `old`.
    - `system, deleted and empty threads are dropped`.
    - `a long thread keeps its first and newest comments and counts the rest`.
    - `150 short threads keep 100, count all 150 and say some were left out`: `threadCount` 150, `REVIEW_TRIMMED` in `message`, with the bytes far under budget.
  - **Service:**
    - `open reads the PR, iteration, changes and threads in four calls`.
    - `diff reads each side once and reuses it`.
    - `diff says what it can't show for renamed, binary and oversized files`.
    - `a missing common commit still opens the review, and diff says why`: the description, threads and votes load, an edited file gives `DIFF_NO_BASE`, and an added file diffs.
    - `a pull request that disappeared says so`.
    - `nothing is answered after the org signs out` (`hang(isThreads)`, then `onOrgs([])`).
  - (**Review Focus 1**) `a review of 2,000 files and 300 long comments fits the answer budget and says what was left out`:
    - the changes' first page holds 1,000 entries with `nextTop`;
    - the answer is at most 900 KiB, with both notes and `moreFiles`;
    - a diff of its 5 MB generated file gives `DIFF_TOO_LARGE` without an items call (`count(isItem)` is 0).
  - **Main:** `reviews.open and reviews.diff answer through the handlers`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS, and typecheck, validate and check pass.
- [ ] **Step 5: Commit** "Read pull request reviews and file diffs".

### Task 4: Vote, reply, resolve and comment

**Files:**
- **Create:** `worker/reviews/actions.ts`.
- **Modify:**
  - `worker/ado/pr-actions.ts`: add `setVote`. `castVote` delegates to it, unchanged.
  - `worker/ado/pr-review.ts`: the writes.
  - `src/protocol.ts`.
  - `worker/reviews/handlers.ts`: deps gain `actions`.
  - `worker/messages.ts`.
  - `worker/main.ts`: `after: org => void prs.reloadFresh(org).catch(() => {})`.
- **Test:** `worker/ado/pr-actions.test.ts` (existing cases unedited), `worker/reviews/actions.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- **Consumes:**
  - from Task 3: `pullRequest`, `fileFacts`, `getThread`;
  - `PrsService.me` and `reloadFresh`;
  - `EMPTY_COMMENT`, `PR_APPROVED`, `REJECTED`, `BAD_LINE`, `VOTE_VALUE`, `MAX_REVIEW_COMMENT`, `votePhrase`, `isResolved`.
- **Produces:**

```ts
export function setVote(http: AdoHttp, org: string, key: PrKey, me: string, isRequired: boolean, vote: number): Promise<RawReviewer>
export interface NewThread { content: string; file?: { path: string; line: number | null; side: 'new' | 'old'; changeTrackingId: number; iterationId: number } }
export function replyTo(http: AdoHttp, org: string, key: PrKey, threadId: number, parentCommentId: number, content: string): Promise<void>
export function setThreadStatus(http: AdoHttp, org: string, key: PrKey, threadId: number, status: 'fixed' | 'active'): Promise<void>
export function createThread(http: AdoHttp, org: string, key: PrKey, thread: NewThread): Promise<void>
export interface ReviewActions {
  vote(input: ReviewKey & { vote: VoteChoice }): Promise<ReviewResult>
  reply(input: ReviewKey & { threadId: number; text: string }): Promise<ReviewResult>
  setStatus(input: ReviewKey & { threadId: number; status: 'fixed' | 'active' }): Promise<ReviewResult>
  comment(input: ReviewKey & { text: string; path?: string; line?: number }): Promise<ReviewResult>
}
export function createReviewActions(deps: { http: AdoHttp; reviews: Pick<Reviews, 'pullRequest' | 'fileFacts'>; me: (org: string) => Promise<string>; after: (org: string) => void }): ReviewActions
```

**Rules.** Endpoints: vote, reply, status and new thread. Input checks come first. A refusal returns `{ ok: false, message: messageOf(error) }`.

- **vote.** Read the PR fresh.
  - Not active → `REVIEW_PR_CLOSED` "This pull request is no longer active."
  - Draft → `REVIEW_DRAFT_NO_VOTES` "Votes are off while a pull request is a draft."
  - Already that vote → `ok` with `alreadyVoted(phrase)` "You already voted: <phrase>.", and no PUT.
  - Otherwise `setVote` with my `isRequired` (or false).
    - The answer matches → `VOTED[choice]`: approve reuses `PR_APPROVED`, reject reuses `REJECTED`, suggestions "Approved with suggestions.", waitForAuthor "Marked as waiting for the author."
    - The answer differs → `warn` with `votedAs(phrase)` "Azure DevOps recorded your vote as <phrase>."
  - After any PUT, `after(org)` runs unawaited.
- **Text** is trimmed.
  - Empty → `EMPTY_COMMENT`.
  - Over `MAX_REVIEW_COMMENT` characters → `REVIEW_COMMENT_TOO_LONG` "Keep the comment under 10,000 characters."
- **reply.** Read the thread fresh.
  - Missing or deleted → `THREAD_GONE` "That comment thread no longer exists."
  - Otherwise post under its first comment → `REPLIED` "Reply posted."
- **setStatus.** Read the thread fresh; missing or deleted → `THREAD_GONE`.
  - `fixed` on a resolved thread → `ALREADY_RESOLVED` "This thread is already resolved."
  - `active` on an active or pending thread → `ALREADY_ACTIVE` "This thread is already active."
  - Otherwise PATCH → `RESOLVED` "Resolved." or `REACTIVATED` "Reactivated."
- **comment.**
  - A line that isn't a positive safe integer, or a line without a path → `badRequest(BAD_LINE)`.
  - No path → general thread → `COMMENTED` "Comment posted."
  - With a path, read `fileFacts`. Null → `FILE_NOT_IN_PR`. The side is `old` for a deleted file, `new` otherwise.
  - With a line:
    - a binary file → `BINARY_NO_LINES` "Binary files take comments on the whole file only.";
    - a side whose `lines` is `'unknown'` → `LINE_UNCHECKED` "This file is too large to check the line. Comment on the whole file, or comment in Azure DevOps.";
    - a side with 0 lines → `NO_LINES` "This file has no lines; comment on the whole file instead.";
    - a line past the end → `lineOutOfRange(n)` "Pick a line from 1 to <n>."
  - Posted → `commentedOn(path, line)` "Comment posted on <path>, line <n>." (", line <n>" only for a line comment).
- **Thread body.**
  - `threadContext.filePath`.
  - A line adds `rightFileStart` and `rightFileEnd` `{ line, offset: 1 }`, or `left…` for the old side.
  - `pullRequestThreadContext: { changeTrackingId, iterationContext: { firstComparingIteration: 1, secondComparingIteration: iterationId } }`.
  - A general thread has neither.

- [ ] **Step 1: Write the failing tests.**
  - `setVote sends the vote and castVote still approves` (exact bodies).
  - (**Review Focus 4**) `writes read fresh and report what Azure DevOps did`:
    - a PR completed since opening → no PUT, `REVIEW_PR_CLOSED`;
    - a deleted thread → no POST, `THREAD_GONE`;
    - line 120 of a 64-line file → no POST, "Pick a line from 1 to 64.";
    - a file dropped by a newer iteration → `FILE_NOT_IN_PR`;
    - a line comment on a file over 2 MiB → no POST, `LINE_UNCHECKED`, while a whole-file comment on it posts;
    - a 403 on the PUT → `ok: false` with ADO's message, and exactly one PUT.
  - `each vote sends its value and says what was recorded`: 10, 5, −5 and −10; a different answer gives `warn`.
  - `a vote already cast makes no call`.
  - `reply posts under the thread's first comment`.
  - `resolve and reactivate patch the status and skip a thread already there`.
  - `a line comment carries the path, side, line and iteration context; a general comment carries none`: exact bodies, with `leftFileStart` for the deleted file.
  - `empty, overlong and badly numbered comments are refused before any call`.
  - `a vote refreshes the PR list afterwards, unawaited`.
  - Main: `reviews.vote answers through the handler`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck passes.
- [ ] **Step 5: Commit** "Vote, reply, resolve and comment on pull requests".

### Task 5: Check out in Orca

**Files:**
- **Create:** `worker/reviews/checkout.ts`.
- **Move:** `git mv worker/pipelines/remote.ts` (and its test) to `worker/workspace/remotes.ts`. `open-file.ts` imports from there, and uses `sameRepo` if Task 0 (c) found a private matcher.
- **Modify:**
  - `worker/workspace/arm.ts` and `hooks.ts`.
  - `worker/workspace/handlers.ts`: deps gain `arm: Arm`, and its own `createArm` goes.
  - `worker/reviews/handlers.ts`: deps gain `checkout`.
  - `src/protocol.ts` and `worker/messages.ts`.
  - `worker/main.ts`: one `createArm(Date.now)` for both registrars. Share the existing `gitRemotes(…)`, creating it once if Plan 4 inlined it.
- **Test:** `worker/reviews/checkout.test.ts`, `worker/workspace/hooks.test.ts`, `worker/workspace/remotes.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- **Consumes:** the S1 decisions (the option, (d) and (e)); `Arm`; `listWorkspaces`, `focusedWorkspace`, `HostCall`, `WorkspaceEntry`; `remotesOf`, `gitRemotes`, `noRepoWorkspace`, `branchName`; `Reviews.pullRequest`; `REVIEW_PR_CLOSED`.
- **Produces:**

```ts
export type ArmedBranch = { org: string; branch: string; itemId: number } | { org: string; branch: string; base: string; prId: number; projectId: string | null }   // projectId only when S1 (d) can tie it
export interface AdoRemote { remote: string; org: string; project: string; repo: string }   // remote = the git remote's name
export function sameRepo(remote: AdoRemote, target: { org: string; project: string; repo: string }): boolean
export interface CheckoutDeps { call: HostCall; remotes: (workspacePath: string) => Promise<AdoRemote[]>; arm: Pick<Arm, 'arm'>; pullRequest: (key: ReviewKey) => Promise<RawPullRequest> }
export function checkoutPr(deps: CheckoutDeps, key: ReviewKey): Promise<CheckoutResult>
```

**Rules:**
- **Fresh PR first.**
  - Not active → refused, `REVIEW_PR_CLOSED`.
  - `forkSource` set → refused, `CHECKOUT_FORK` "This pull request comes from a fork. Check it out from the fork's repository instead."
- **Candidates** are local workspaces (`hostId === null`) with a remote where `sameRepo` matches `{ org, project: projectName, repo: repoName }`.
  - Order: on the source branch (`branchName(entry.branch ?? '')`) first, then (only if S1 (e) found that folder projects can't create worktrees) `worktree`-kind ones, then the focused one, then listing order.
  - None → refused, `noRepoWorkspace(repoName)`.
- **First candidate already on the source branch:** `workspace.open` it → opened, `openedCheckout(name, source)` "Opened <name>. It's already on <source>."
- **Otherwise:**
  1. `workspace.open` the first candidate, unless it is focused, so Orca's new-workspace flow starts in that project.
  2. Arm `{ org, branch, base: '<remote>/<source>', prId }`.
     - `branch` follows S1: `<source>` for Option A, `review/<prId>` for Option B.
     - `<remote>` is the candidate's matching remote, else `origin`.
  3. Return armed, with `armedUntil` and `armedCheckout({ repo, branch: source, base, prId, target })`: "Now create a new workspace in Orca from the <repo> project. It will check out <source> from <base>, the source of Pull Request <prId>. To review it, compare it with <target> in Source Control." When the arm has no `projectId`, `ARM_ANY_PROJECT` "Create it before any other new workspace: the next one, in any project, gets this branch." is joined.
- **What the user sees:**
  1. Orca shows the repo's workspace, and the panel shows that text.
  2. The user creates a workspace with Orca's own flow, in that project.
  3. The hook sets the branch and base; Orca fetches and checks out, per S1.
  4. The user compares against the target in Source Control.
- **The arm.** One slot, for 10 minutes, used once. It replaces an armed work item and the reverse. `work.cancelWorkspace` disarms either.
- **Hooks.**
  - A PR arm passes a `folder`-kind event through and stays armed. With a `projectId`, so does an event from another project.
  - Otherwise `before` returns `next({ ...event, branch, name: branch, ...(base ? { base } : {}) })`.
  - `after` links work-item arms only.
- **Remotes.** `remotesOf` keeps each remote's name. `sameRepo` compares org, project and repo case-insensitively; with no project in the remote, it compares org and repo.

- [ ] **Step 1: Write the failing tests.** Use a fake `call` and stub `remotes`.
  - `checkout opens a workspace that is already on the source branch`: no arm.
  - `checkout arms the next worktree from the remote branch and opens the repository's workspace`:
    - the base is `origin/hotfix/1211-login-redirect`, or `upstream/…` when the matching remote is `upstream`;
    - `prId` is 4110;
    - nothing is opened when the candidate is focused.
  - `checkout refuses a closed PR, a fork and a repository with no local workspace`: no host writes.
  - `an armed pull request sets the branch, name and base and links nothing`. Plan 2's hook tests stay green.
  - `a pull request arm skips folder workspaces and other projects and stays armed`. The other-project half applies only if S1 (d) can tie a project; otherwise the test asserts that the armed message carries `ARM_ANY_PROJECT`.
  - `remotesOf keeps each remote's name` and `sameRepo matches org, project and repo case-insensitively`. Plan 4's moved tests stay green.
  - Main: `reviews.checkout and work.cancelWorkspace share one arm`. After the cancel, `w.hooks.fire('workspace.create.before', …)` passes the event through.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement, move and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, validate and check pass.
- [ ] **Step 5: Commit** "Check out a pull request's branch in Orca".

### Task 6: Inbox, review header, votes and checkout

**Files:**
- **Create:** `src/panel/prs/review/{state.ts,review-view.tsx,fixtures.ts}`. Fixtures provide `reviewOf(over)` from Task 0's data for 4110.
- **Modify:**
  - `src/shared/prs.ts`: `PrSnapshot.reviewed`.
  - `worker/prs/release-sets.ts`: `reviewedOf`.
  - `worker/prs/service.ts`: both `compose` and the reviews-only background path compute `reviewedOf` beside `toReviewOf`; `capPrSnapshot` fits up to 50 `reviewed` after `toReview`.
  - Every `PrSnapshot` literal gains `reviewed`: `src/panel/prs/fixtures.ts` (`snapshotOf` defaults `reviewed: []`), `src/panel/panel.check.ts`, and the deep-equal literals in `worker/prs/service.test.ts` (:236) and `src/panel/prs/prs-tab.test.tsx`.
  - `src/panel/prs/prs-tab.tsx`: after the `shareView('prs')` checks, an open review for this org renders `ReviewView`. The To review rows stop calling `openPr`; the `reviewNotice` Callout moves into the review header.
  - `src/panel/panel.tsx`: `syncReview(loaded.status === 'ready' && org?.state === 'connected' ? org.org : null)`.
  - `src/panel/test-support.ts`: default `reviews.open`.
  - `src/panel/panel.check.ts`: a `review` scenario via `persisted.workspace.openReview`.
- **Test:**
  - `worker/prs/release-sets.test.ts` and `worker/prs/service.test.ts`.
  - `src/panel/prs/prs-tab.test.tsx`, four existing tests:
    - `To review opens a PR in the browser on press` becomes `To review opens the review in the panel on press`.
    - `a link Orca refuses to open…`, `a link Orca could not ask about…` and `a link the person declined…` keep their names and assertions, but `pressReview` now opens the review and presses its header `Link` "Open in Azure DevOps". `assertInToReview` becomes `assertInReviewHeader`: the Callout sits directly after that Link.
  - `src/panel/prs/review/review-view.test.tsx`.

**Interfaces:**
- **Consumes:** `reviews.open`, `reviews.vote`, `reviews.checkout`, `reviews.comment`, `work.cancelWorkspace`; `toReviewOf`, `sameId`, `newestThatFit`; `openPr` and `reviewNotice` (`src/panel/prs/state.ts`); `MAX_REVIEW_COMMENT`; `LONG_WAIT`, `LoadFailure`, `SnapshotMessage`; the panel test helpers.
- **Produces:**

```ts
export function reviewedOf(prs: PrSummary[], me: string): PrSummary[]   // active, not a draft, not mine, my direct vote ≠ 0 and not declined; newest first
export type ReviewSection = 'overview' | 'files' | 'comments'
export const openReview: Atom<(ReviewKey & { title: string }) | null>   // key 'openReview', persist 'workspace'
export const reviewSection: Atom<ReviewSection>                          // key 'reviewSection', persist 'workspace', default 'overview'
export function showReview(org: string, pr: PrSummary): void
export function closeReview(): void
export function syncReview(org: string | null): void                     // null keeps everything; a different org closes the review
export function reloadReview(): Promise<void>
export function vote(choice: VoteChoice): Promise<void>
export function checkout(): Promise<void>
export function cancelCheckout(): Promise<void>
export function comment(input: { text: string; path?: string; lineText?: string }): Promise<void>   // T6: general comments; T7 adds path and lineText
export function isRunning(slot: string): boolean
export function resultOf(slot: string): ReviewResult | null             // 'vote' | 'checkout' | 'comment' | `thread:${id}` | `file:${path}`
export function ReviewView({ org }: { org: OrgStatus }): OrcaNode
```

**UI** (copy exact):

- **Inbox.**
  - The fold shows while `toReviewCount > 0` or either list has rows. Its title stays `To review (<n>)`.
  - To review rows now call `showReview`.
  - Below them come `Text size="sm" weight="semibold"` "Reviewed by you" and `List label="Reviewed by you"`, with at most 50 rows.
  - Each reviewed row shows the title and `Pull Request <id> · <repo> · <author> · you: <votePhrase>`, and opens the review.
- **Header.**
  - `IconButton icon="close" label="Back"` and `IconButton icon="refresh" label="Refresh"`.
  - `Heading level={3}` with the title.
  - Two muted lines: `Pull Request <id> · <repo> · <source> → <target>`, then `<author> · opened <RelativeTime> · loaded <RelativeTime of loadedAt>`.
  - Badges:
    - `draft`, neutral;
    - `conflicts`, danger;
    - `You: <votePhrase>` when my vote isn't 0: success at 5 or more, warning at −5, danger at −10.
  - `Link` "Open in Azure DevOps" with `onPress={() => openPr(pr.url)}`, then the `reviewNotice` danger `Callout` when set (Plan 3's consent handling, unchanged).
  - `SnapshotMessage` for `message`.
- **Votes.**
  - Four small `Button`s labelled from `VOTE_BUTTON`, in a wrapping `Row`.
  - The current vote is `solid`; the others are `outline`.
  - Tones: success (approve, suggestions), warning (wait for author), danger (reject).
  - All are disabled while an action runs.
  - The result shows in a `Callout`: success; warning for `warn`; danger for `ok: false`. The review then reloads.
- **Check out.**
  - `Button size="sm" variant="outline" icon="branch"` "Check out in Orca".
  - Armed: `Callout tone="accent" title="Create the workspace in Orca"` holding the message.
    - Then muted: "This applies to the next workspace you create in the next 10 minutes."
    - A ghost "Cancel" sends `work.cancelWorkspace` and hides the callout.
  - Opened shows a success `Callout`; refused, a danger `Callout`.
- **Sections.**
  - `Tabs label="Pull request"`: "Overview", `Files (<n>)` (with `+` when `moreFiles`) and `Comments (<threadCount>)`.
  - Only the selected section renders. Task 7 fills Files and Comments.
- **Overview.**
  - The `Markdown` description, or muted "No description."
  - `Text weight="semibold"` "Reviewers", then `List label="Reviewers"`:
    - title: the name, plus ` (required)` when required;
    - description: the `votePhrase`.
  - `Textarea label="Add a comment" rows={3} maxLength={MAX_REVIEW_COMMENT}` and a "Comment" button.
    - It sends `reviews.comment` without a path, and is disabled while `isRunning('comment')`.
    - On `ok` it clears the box and reloads.
- **Loading and failure.**
  - `Skeleton lines={4} label="Loading the pull request"`.
  - On failure, `LoadFailure` plus Back.
- **State rules.**
  - Requests use `LONG_WAIT`.
  - An answer for another PR is dropped.
  - Results are kept per slot (Plan 3 R11). A slot's action refuses to start while `isRunning(slot)`.
  - `syncReview` acts only on a non-null org that differs from the open review's org. `Panel` passes null until the org list is `ready` and the current org is connected, so a panel start never wipes the persisted review.

- [ ] **Step 1: Write the failing tests.**
  - Worker:
    - `reviewedOf lists active PRs I voted on, newest first, and none of mine`
    - `the snapshot carries at most 50 reviewed PRs within the post budget`
    - `a background reviews-only poll moves a PR I voted on from To review to Reviewed by you`
  - Panel:
    - `To review opens the review in the panel on press`: input `{ org, projectId, repoId, prId }`, and the exact header lines.
    - `Reviewed by you lists the PRs I voted on with my vote`
    - `Back returns to the list`
    - `votes send reviews.vote, mark the current vote and show the result`
    - `the review reloads after a vote`
    - `Check out in Orca shows the armed instructions and Cancel disarms`
    - `an opened or refused checkout shows its message`
    - `a general comment sends reviews.comment and clears the box`
    - `a review that fails to load shows the message with Try again and Back`
    - `switching org closes the review`
    - `the open review survives leaving the PRs tab and a panel reload`: it mounts with the same persisted `openReview` as the `review` check scenario and asserts the review header renders, not the PR list (check scenarios can't assert).
    - `a second Comment press before the buttons redraw sends nothing`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Check passes with the `review` scenario.
- [ ] **Step 5: Commit** "Open reviews from the To review inbox".

### Task 7: Files, diffs and comment threads in the review

**Files:**
- **Create:** `src/panel/prs/review/{files.tsx,threads.tsx,fit.ts}`.
- **Modify:** `state.ts`, `review-view.tsx` and `fixtures.ts`, all in that folder.
- **Test:** `fit.test.ts` and `review-view.test.tsx`.

**Interfaces:**
- **Consumes:** `reviews.diff`, `reviews.reply`, `reviews.setStatus` and `reviews.comment`; `THREAD_STATUS_LABEL`, `BAD_LINE` and `MAX_REVIEW_COMMENT`; `resultOf`, `isRunning`, `reloadReview` and `comment` (Task 6), which this task extends to send `path` and a parsed `lineText`.
- **Produces:**

```ts
export const MAX_THREAD_CARDS = 30
export const MAX_COMMENTS_SHOWN = 10
export const THREADS_BYTES = 300 * 1024
export const FILE_THREADS_BYTES = 100 * 1024
export const MAX_FILE_ROWS = 1000
export function fitThreads(threads: readonly ReviewThread[], budget?: number): { shown: ReviewThread[]; hidden: number }
export function fileRows(files: readonly ChangedFile[], filter: string): ChangedFile[]
export function anchorTitle(anchor: ThreadAnchor | null): string   // 'General' | '<path>' | '<path>, line <n>' | '<path>, old line <n>'
export function parseLine(text: string): number | null | 'bad'     // '' → null
export const selectedFile: Atom<string | null>
export function selectFile(path: string): Promise<void>
export function reply(threadId: number, text: string): Promise<void>
export function markThread(threadId: number, status: 'fixed' | 'active'): Promise<void>
```

**Rules:**
- `fitThreads` takes whole threads in order. Each shows at most `MAX_COMMENTS_SHOWN` comments: its first and its newest. The comments it drops are added to that thread's `hidden`. It stops at `MAX_THREAD_CARDS`, or before the content bytes pass the budget.
- `fileRows` filters on path text, case-insensitively, and keeps at most `MAX_FILE_ROWS`.
- A diff answer for a path other than `selectedFile` is dropped.
- Results are keyed `thread:<id>` and `file:<path>` (Plan 3 R11). Every successful action reloads the review.

**UI** (copy exact):

- **Files section:**
  - `Input type="search" label="Filter files" labelHidden placeholder="Filter files"`.
  - `Table label="Changed files" selectionMode="single" maxHeight="md" emptyText="No files match."`, keyed by path.
    - Column `change`, labelled "Change" (`width="sm"`), shows `added`, `edited`, `deleted` or `renamed`.
    - Column `path` is labelled "File".
  - The selected file:
    - The path as `Text weight="semibold" truncate`, then its message, muted.
    - `CodeView language="diff" label="Diff of <path>" lineNumbers={false} maxHeight="lg"` when there is text. While it loads: `Skeleton lines={6} label="Loading the diff"`.
    - Its threads: the review's threads on this path, through `fitThreads(…, FILE_THREADS_BYTES)`, as Comments cards. When some don't fit, muted: "Showing <shown> of <m> comment threads on this file. Open the pull request in Azure DevOps for the rest."
    - A muted hint: "Line numbers refer to the new version: the second number on each diff line." For a deleted file: "Line numbers refer to the old version: the first number on each diff line."
    - `Input label="Line (optional)" placeholder="42" maxLength={7}`, `Textarea label="Comment on this file" rows={3} maxLength={MAX_REVIEW_COMMENT}`, and a "Comment on file" button, disabled while `isRunning(`file:${path}`)`.
    - A `'bad'` line shows `BAD_LINE` and sends no request.
- **Comments section:**
  - No threads: `EmptyState title="No comments yet" description="Comments on this pull request show up here."`
  - Each shown thread is a `Card` with `title={anchorTitle(anchor)}` and `description={THREAD_STATUS_LABEL[status]}`.
  - Each comment: `Text size="sm" weight="medium"` "<author> · " followed by `RelativeTime`, then its `Markdown`.
  - Hidden comments, muted: "<n> more replies are in Azure DevOps." For one: "1 more reply is in Azure DevOps."
  - Then `Textarea label="Reply" rows={2} maxLength={MAX_REVIEW_COMMENT}`, a small "Reply" button, and an outline "Resolve" (unresolved) or "Reactivate" (resolved). All three are disabled while `isRunning(`thread:${id}`)`.
  - Its result shows as a `Callout` in the card.
  - Last, when `shown < threadCount`, muted: "Showing <shown> of <threadCount> comment threads. Open the pull request in Azure DevOps for the rest."

- [ ] **Step 1: Write the failing tests.**
  - `fitThreads keeps whole threads within the byte budget and counts the rest`, including a 20-comment thread whose 10 dropped comments raise `hidden` from 0 to 10
  - `fileRows filters by path text, case-insensitively, and caps the rows`
  - `anchorTitle names general, file, line and old-line threads`
  - `parseLine accepts whole numbers only`
  - `Files lists the changes and selecting one shows its diff`
  - `a binary or too-large file shows the message instead of a diff`
  - `a quick second selection drops the first answer`
  - `a file comment sends the path and line; a bad line is refused in the panel`
  - `Comments shows threads unresolved first with status, and Reply sends reviews.reply`
  - `Resolve and Reactivate send reviews.setStatus`
  - `a result stays with its thread after a reload reorders the threads`
  - `a second Reply or Comment on file press before the buttons redraw sends nothing`
  - `the Comments footer counts the threads the worker left out`: 100 threads shown of a `threadCount` of 150
  - (**Review Focus 1**) `the largest review stays under 4,000 nodes and 450 KiB in every section`:
    - the review has 1,000 files, 100 threads of 20 comments at 8,000 bytes each, all on the selected file, and a 60 KiB diff;
    - check Overview, Files with that file's diff and threads open, and Comments;
    - in each, count the nodes of `panel.tree()` and the bytes of `new TextEncoder().encode(JSON.stringify(panel.tree()))`;
    - finish with `closeCleanly`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Check passes.
- [ ] **Step 5: Commit** "Show files, diffs and comment threads in a review".

### Task 8: Read wikis, page trees, pages and search

**Files:**
- **Create:** `worker/ado/wiki.ts`; `worker/wiki/{service,handlers}.ts`; Task 0's fixtures; `worker/wiki/fake-wiki.ts`.
  - `fakeWiki()` is `fakeAdo()` plus routes for wikis, levels and pages.
    - Its page PUT answers 412 unless `If-Match` equals the held ETag.
    - Search answers on `almsearch.dev.azure.com`.
  - Matchers: `isWikis`, `isLevel`, `isPage`, `isPagePut` and `isSearch`.
  - A `pages` map (path → `{ content, etag }`) lets tests change a page.
- **Modify:**
  - `src/protocol.ts`.
  - `src/shared/messages.ts`: `SEARCH_TOO_SHORT` "Type at least 2 characters to search." (the panel and the worker both test against `MIN_SEARCH_CHARS`).
  - `worker/messages.ts`:
    - `MALFORMED.wiki` "Azure DevOps returned an unexpected wiki response."
    - `WIKIS_LOAD_FAILED` "Couldn't load wikis."
    - `WIKI_NEEDS_READ` "The wiki needs Wiki (Read) access."
    - `UNKNOWN_WIKI` "That wiki no longer exists, or you can't see it."
    - `WIKI_PAGE_GONE` "This page was moved or deleted in Azure DevOps."
    - `WIKI_READ_ONLY` "This wiki is published from a repository. Edit its files there."
    - `WIKI_SEARCH_UNAVAILABLE` "Wiki search isn't available in this organization."
  - `worker/main.ts`.
- **Test:** `worker/ado/wiki.test.ts`, `worker/wiki/service.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- **Consumes:** Task 1; `listProjects` (`worker/ado/core.ts`); `parsedHref` (`worker/ado/pr-links.ts`); `decode` (`worker/ado/html-text.ts`).
- **Produces:**

```ts
export interface RawPage { path: string; order?: number; isParentPage?: boolean; remoteUrl?: string; content?: string; subPages?: RawPage[] }
export function listWikis(http: AdoHttp, org: string, signal?: AbortSignal): Promise<{ id: string; name: string; type: string; projectId: string; mappedPath: string | null }[]>
export function pageLevel(http: AdoHttp, org: string, projectId: string, wikiId: string, path: string, signal?: AbortSignal): Promise<RawPage>
export function getPage(http: AdoHttp, org: string, projectId: string, wikiId: string, path: string, signal?: AbortSignal): Promise<{ page: RawPage; etag: string }>
export function putPage(http: AdoHttp, org: string, projectId: string, wikiId: string, path: string, content: string, etag: string): Promise<{ page: RawPage; etag: string }>
export function searchWiki(http: AdoHttp, org: string, projectId: string, wikiName: string, text: string, signal?: AbortSignal): Promise<{ count: number; results: { path?: string; hits?: { highlights?: string[] }[] }[] }>
export function wikiPageUrl(org: string, projectName: string, wikiName: string, path: string): string   // <orgWebUrl>/<project>/_wiki/wikis/<wiki>?pagePath=<path>, parts encoded
export function pagePathOf(gitPath: string): string    // per segment: '-' → ' ', then decodeURIComponent, then drop '.md'
export function titleOf(path: string): string
export interface WikiService {
  onOrgs(orgs: OrgStatus[]): void
  wikis(org: string): Promise<WikiRef[]>
  wiki(org: string, wikiId: string): Promise<WikiRef>
  level(ref: WikiPageRef): Promise<WikiLevel>
  page(ref: WikiPageRef): Promise<WikiPage>
  fresh(ref: WikiPageRef): Promise<{ content: string; etag: string; title: string } | null>   // raw, never cached; null on not_found
  search(input: Omit<WikiPageRef, 'path'> & { text: string }): Promise<{ hits: WikiHit[]; total: number }>
}
export function createWikiService(deps: { http: AdoHttp; orgs: () => Promise<OrgStatus[]>; now: () => number }): WikiService
export interface WikiHandlerDeps { wiki: WikiService }        // T9 adds drafts, T10 publisher
export function registerWikiHandlers(orca: OrcaWorkerApi, deps: WikiHandlerDeps): void
```

**Rules.** Endpoints: wikis, level, page and search. `putPage` is tested here; Task 10 uses it.

- **`wikis`:**
  - Cached per org for 10 minutes.
  - `editable` is `type === 'projectWiki'`.
  - Project names come from `listProjects`, cached alongside.
  - Sorted by project, then name, at most 50. `mappedPath` is ADO's, or null.
  - `wiki` lists the wikis again once when the id isn't cached (a wiki created within the 10 minutes), and gives `UNKNOWN_WIKI` only if it is still missing.
- **`level`:** sorted by `order`, then title. At most 200, with `total`. Titles are `titleOf`, cut at 200. `hasChildren` is `isParentPage`.
- **Page paths are never Unicode-normalized.** They go to ADO and into `wikiPageUrl` exactly as ADO gave them; only draft file names are normalized (Task 9).
- **`pagePathOf`:** split on `/`; in each segment replace `-` with a space, then `decodeURIComponent` (so `%2D` becomes `-` and `%3A` becomes `:`); a segment that fails to decode keeps its spaces and stays encoded; drop a final `.md`.
- **`page`:**
  - Content (`content ?? ''`) goes through `panelMarkdown` (60,000 bytes).
  - Its `resolve` sends `/.attachments/…` and non-path hrefs to the page URL, and `/<path>` to `wikiPageUrl(pagePathOf(path))`.
  - `url` is `parsedHref(remoteUrl)`, else `wikiPageUrl`.
  - A code wiki gets `notice: WIKI_READ_ONLY`.
  - `not_found` gives `WIKI_PAGE_GONE`.
- **`getPage` and `putPage`:** a missing `etag` header is malformed. `putPage` sends `ifMatch` and never retries.
- **`search`:**
  - Trim the text. Under `MIN_SEARCH_CHARS` is `badRequest(SEARCH_TOO_SHORT)`; longer than 200, cut it.
  - Ask for `$top` 25.
  - For a code wiki, a hit outside its `mappedPath` is dropped, and the prefix is stripped first.
  - Each hit: `path` is `pagePathOf`; `title` is `titleOf`; `snippet` is the first highlight with its tags removed, `decode`d, whitespace collapsed and cut at 300.
  - `not_found`, or the unavailable-service `typeKey` S3 recorded, gives `WIKI_SEARCH_UNAVAILABLE`. Any other `bad_request` shows ADO's message.
- **Errors:** `forbidden` gives `WIKI_NEEDS_READ`. Aborts and `onOrgs` follow the Global Constraints.

- [ ] **Step 1: Write the failing tests.**
  - `listWikis marks project wikis editable and code wikis read-only`
  - `pageLevel sorts children by order and caps a level at 200 with the total`
  - `getPage returns the content and the ETag; a missing ETag is malformed`
  - `putPage sends If-Match and returns the new ETag`
  - `page renders Markdown for the panel with links into Azure DevOps`: images become links, `[[_TOC_]]` is gone, and the Rollback link points to `…?pagePath=%2FRelease%20process%2FRollback`.
  - `searchWiki posts to almsearch with the wiki filter and maps hits to pages`
  - `search the organization doesn't offer says so, and a rejected query shows ADO's message`
  - `too short a search is refused before any call`
  - `pagePathOf decodes wiki git paths`: `-` → space, `%2D` → `-`, `/FAQ%3A-login.md` → `/FAQ: login`, a bad `%` kept, `.md` dropped.
  - `a code wiki's hit drops its mappedPath`: the `api-docs` hit at `/docs/Setup-guide.md` opens `/Setup guide`.
  - `a unicode page keeps its path through the query, the link and the hits`: `/Résumé/Überblick 文档` in NFC and in NFD each reach the page query and `wikiPageUrl` unchanged, UTF-8 percent-encoded.
  - `a page with no content renders as empty text`: no `content` field gives `content: ''`, not malformed.
  - `a wiki created since the list was cached is found by listing again once`
  - `nothing is answered after the org signs out`
  - Main: `wiki.list and wiki.page answer through the handlers`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS; typecheck passes.
- [ ] **Step 5: Commit** "Read wikis, page trees, pages and search".

### Task 9: Edit wiki pages as drafts in Orca

**Files:**
- **Create:** `worker/wiki/draft-files.ts` and `worker/wiki/drafts.ts`.
- **Modify:**
  - `worker/tab-files.ts`: nested names.
  - `src/protocol.ts`.
  - `worker/wiki/handlers.ts`: deps gain `drafts`.
  - `worker/messages.ts` and `worker/main.ts`.
- **Test:** `worker/tab-files.test.ts` (existing cases unedited); `worker/wiki/draft-files.test.ts` and `worker/wiki/drafts.test.ts`, on real `mkdtemp` folders; `worker/main.test.ts`.

**Interfaces:**
- **Consumes:** `TAB_FOLDER`, `TabFileFs`, `writeTabFile`, `focusedWorkspace`, `listWorkspaces`, `HostCall`, `StorePort`, `WikiService.wiki`, `WikiService.fresh`, `titleOf` and `MAX_DRAFTS`.
- **Produces:**

```ts
// worker/tab-files.ts: a name with '/' creates its parent folders; an absolute name, '..' or an empty segment throws badRequest(BAD_TAB_FILE)
export const MAX_SEGMENT = 80
export const MAX_DRAFT_NAME = 200
export function fileSegment(text: string): string
export function draftName(org: string, wikiName: string, pagePath: string): string   // under TAB_FOLDER: wiki/<org>/<wiki>/<segments>.md
export function baseName(draft: string): string                                     // wiki/.base/<draft without 'wiki/'>
export function theirsName(draft: string): string                                   // wiki/.theirs/<draft without 'wiki/'>
export type DraftFs = TabFileFs & Pick<typeof import('node:fs/promises'), 'rm' | 'realpath' | 'lstat'>
export function assertInside(fs: DraftFs, workspacePath: string, relative: string): Promise<string>
export interface StoredDraft { key: string; org: string; projectId: string; wikiId: string; wikiName: string; path: string; version: string; workspaceId: string; workspacePath: string; workspaceName: string; file: string; startedAt: number; publishedAt: number | null; mergeMark: string | null }   // mergeMark: sha256 of the draft when Merge by hand ran
export function draftKey(ref: WikiPageRef): string                                   // `${org}:${wikiId}:${path}`
export interface Drafts {
  edit(ref: WikiPageRef): Promise<{ opened: boolean; message: string }>
  list(org: string): Promise<DraftSummary[]>
  discard(key: string): Promise<{ ok: true; message: string }>
  get(key: string): Promise<StoredDraft | null>
  texts(draft: StoredDraft): Promise<{ mine: string; base: string } | null>
  rebase(draft: StoredDraft, change: { version: string; base: string; mine?: string; publishedAt?: number; mergeMark?: string | null }): Promise<void>   // mergeMark defaults to null
  openTheirs(draft: StoredDraft, theirs: string): Promise<string>
  forget(key: string): Promise<void>
}
export function createDrafts(deps: { store: StorePort; fs: DraftFs; call: HostCall; wiki: Pick<WikiService, 'wiki' | 'fresh'>; now: () => number }): Drafts
```

**Rules:**
- **`fileSegment`:**
  - Apply NFC, then turn `<>:"/\|?*` and control characters into `-`.
  - Collapse whitespace, and trim spaces and dots at both ends.
  - Prefix `_` to Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`9`, `LPT1`–`9`), in any case, with or without an extension.
  - An empty result, `.` or `..` becomes `_`.
  - Cut at `MAX_SEGMENT` UTF-16 units without splitting a surrogate pair.
- **`draftName`:** a name over `MAX_DRAFT_NAME` UTF-16 units is cut to 188, never splitting a surrogate pair and trimming a trailing space, dot or `/`, then `~<first 8 hex of sha256(org, wikiName, pagePath)>.md` is appended.
- **`baseName` and `theirsName`** live under `wiki/.base/` and `wiki/.theirs/`. `fileSegment` trims leading dots, so no org, wiki or page can produce those folders.
- **`assertInside(fs, ws, relative)`** runs before any mkdir, read, write or rm, and before `writeTabFile`. It creates nothing.
  1. `root = realpath(ws)`.
  2. Walk `.orca-ado`, `.orca-ado/wiki` and each folder below them towards the file. Stop at the first one that doesn't exist; mkdir creates the rest later. Each one that exists must be a directory under `lstat` (not a symlink), and its `realpath` must equal `path.join(root, …)`.
  3. The file, if it exists, must be a regular file under `lstat`, not a symlink.
  4. Otherwise throw `badRequest(DRAFT_OUTSIDE)` "The wiki draft folder leads outside this workspace, so nothing was written."
  5. Return `path.join(root, TAB_FOLDER, relative)`.
  - `edit`, `texts`, `rebase`, `openTheirs`, `list` and `discard` call it for each draft, base or theirs file they touch.
- **Storage:**
  - Store the drafts under the key `wiki:drafts`, at most `MAX_DRAFTS` across orgs.
  - Write files through `writeTabFile`, so `.orca-ado/.gitignore` is `*`.
  - `BAD_TAB_FILE` is "That file name can't be used."
- **`edit`:**
  - A code wiki → `WIKI_READ_ONLY`.
  - **A record exists:**
    - Its workspace isn't in `workspace.list` → `DRAFT_WORKSPACE_GONE` "The workspace holding this draft is gone. Discard the draft to edit the page again."
    - Its file is gone → forget the record and continue as if there were none.
    - Its file equals its base → refresh the draft, base and version from `fresh`. If `fresh` is null → `WIKI_PAGE_GONE`, and the record is kept.
    - Otherwise, keep the file as it is.
    - Then `editor.open({ workspaceId, path: '.orca-ado/<file>' })` → `openedDraft(title)` "Opened <title> in Orca. Save your changes there, then press Publish here."
  - **No record:**
    - No focused local workspace → `NO_LOCAL_WORKSPACE_WIKI` "Open a local workspace first; wiki pages open in a tab there."
    - `fresh` is null → `WIKI_PAGE_GONE`.
    - Over 1 MiB → `WIKI_PAGE_TOO_LARGE` "This page is too large to edit here. Edit it in Azure DevOps."
    - At the limit → `TOO_MANY_DRAFTS` "You have 50 wiki drafts. Publish or discard some first."
    - Another record in the same workspace has the same file, compared NFC-normalised and lower-cased (`Foo` and `foo` collide on macOS and Windows) → `DRAFT_FILE_TAKEN` "Another draft already uses that file name. Publish or discard it first." The same file in another workspace is allowed.
    - Otherwise write the draft and its base, store the record (`version` = the ETag), open the draft, and return `openedDraft`.
- **`list`:** this org's drafts, newest `startedAt` first. `changed` compares the draft with its base; a missing file, or one `assertInside` refuses, counts as changed, and the list still loads.
- **`discard`:** delete the draft, base and theirs files (failures are ignored) and the record → `DRAFT_DISCARDED` "Draft discarded." No record → `DRAFT_GONE` "That draft no longer exists."

- [ ] **Step 1: Write the failing tests.**
  - (**Review Focus 5**) `draft file names stay inside the wiki folder and are valid on every OS`:
    - `/../../etc/passwd` stays under `wiki/contoso/…`.
    - `Q&A: what?` becomes `Q&A- what-`, and `CON` becomes `_CON`.
    - Trailing dots are trimmed.
    - 300 characters become 80, with surrogate pairs kept whole.
    - Two pages that clean to one name, and `Foo` beside `foo`, → `DRAFT_FILE_TAKEN` in one workspace; the same page in a second workspace is allowed.
    - A page nested deep enough to pass 200 characters gives a name of at most 200 ending `~<hash>.md`, and two such pages differ.
    - A page titled `X.theirs` and the theirs file of page `X` are different files.
    - Each of these, committed in the workspace, gives `DRAFT_OUTSIDE`: a `.orca-ado` symlink, a `.orca-ado/wiki` symlink, and a draft file that is a symlink to an outside file. The outside target is listed recursively before and after, and nothing appears in it (no `.gitignore`, no folder, no file); the outside file's text is unchanged; `discard` leaves it in place.
  - `writeTabFile creates nested folders and refuses names that leave the folder`
  - `edit writes the page and its base into the focused workspace and opens it`. `editor.open` gets `.orca-ado/wiki/contoso/Fabrikam Web.wiki/Release process/Checklist.md`, the base is `.orca-ado/wiki/.base/contoso/…`, and `.gitignore` holds `*`.
  - `a unicode page gets an NFC file name and keeps its page path`: `/Résumé/Überblick 文档` given in NFD opens `…/Résumé/Überblick 文档.md` in NFC, while the record's `path` stays as given.
  - `edit reopens a changed draft as it is and refreshes an unchanged one`; an unchanged draft whose page is gone says `WIKI_PAGE_GONE` and keeps the record
  - `edit refuses code wikis, pages over 1 MiB, a 51st draft and no local workspace`
  - `a draft whose workspace is gone says so`
  - `drafts lists this org's drafts with whether they changed`
  - `discard removes the record and its files`
  - `drafts survive a restart`
  - main: `wiki.edit and wiki.drafts answer through the handlers`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS; typecheck passes.
- [ ] **Step 5: Commit** "Edit wiki pages as drafts in Orca".

### Task 10: Publish wiki drafts with conflict handling

**Files:**
- **Create:** `worker/wiki/publish.ts`.
- **Modify:** `src/protocol.ts`; `worker/wiki/handlers.ts` (deps gain `publisher`); `worker/messages.ts`; `worker/main.ts`.
- **Test:** `worker/wiki/publish.test.ts` and `worker/main.test.ts`.

**Interfaces:**
- **Consumes:** `diffText` (Task 2); `putPage` and `fresh` (Task 8); and from `Drafts` (Task 9) `get`, `texts`, `rebase`, `openTheirs` and `forget`.
- **Produces:**

```ts
export const MAX_PUBLISH_BYTES = 1024 * 1024
export interface Publisher {
  publish(key: string): Promise<WikiResult>
  resolve(input: { key: string; choice: 'mine' | 'theirs' | 'merge' }): Promise<WikiResult>
}
export function createPublisher(deps: { http: AdoHttp; drafts: Drafts; wiki: Pick<WikiService, 'fresh'>; now: () => number }): Publisher
```

**Rules.** Uses the page and publish endpoints. Each press makes at most two reads (one fresh read, plus one after a refused PUT) and at most one PUT, and nothing is retried. A second `publish` or `resolve` for a key while one runs → `failed` with `DRAFT_BUSY` "This draft is already being published.", and no call.

**`publish`** checks these in order:
1. No record → `failed` with `DRAFT_GONE`.
2. No texts → `forget`, then `failed` with `DRAFT_FILE_GONE` "The draft file is gone. Press Edit to start again." `texts` throwing (`DRAFT_OUTSIDE`) → `failed` with `messageOf(error)`.
3. Mine equals base → `unchanged` with `NOTHING_TO_PUBLISH` "Nothing to publish yet. Save your changes in the editor first." No call is made.
4. Over `MAX_PUBLISH_BYTES` → `failed` with `WIKI_PAGE_TOO_LARGE`.
5. `fresh` throws → `failed` with `messageOf(error)`. It returns null → `failed` with `joinMessages(WIKI_PAGE_GONE, DRAFT_KEPT)`. `DRAFT_KEPT` is "Your draft is kept." No PUT either way.
6. The draft's sha256 equals `mergeMark` (Merge by hand ran and the draft hasn't changed since) → `conflict` with `MERGE_NOT_SAVED` "Your draft hasn't changed since their version opened. Copy what you need into it and save, or choose Publish mine.", with diffs as in step 7. No PUT.
7. Both the ETag and the content changed since the base → `conflict` with `WIKI_CONFLICT` "Someone changed this page in Azure DevOps after you started editing.", where `theirs` is `diffText(base, fresh)` and `mine` is `diffText(base, mine)`. No PUT.
8. Otherwise `putPage` with the fresh ETag, then `rebase` with the new ETag, `base` = mine and `publishedAt` = now → `published` with `PUBLISHED` "Published."
9. The PUT answers `precondition_failed` or `conflict` → one more `fresh`, then `conflict` as in step 7. That `fresh` failing → `failed` with its message.
10. Any other refusal → `failed` with `messageOf(error)`.

**`resolve`** applies publish steps 1, 2 and 5 first. Then:
- `mine` → `putPage` with mine, then `rebase` → `published` with `PUBLISHED_OVER` "Published. Their changes were replaced." A conflict answer gives `conflict` again.
- `theirs` → `rebase` with mine and base both set to theirs, which rewrites the draft → `updated` with `TOOK_THEIRS` "Your draft now holds their version."
- `merge` → `openTheirs`, then `rebase` with base set to theirs and `mergeMark` set to the draft's sha256. The draft itself is untouched → `updated` with `openedTheirs(name)` "Opened their version as <name>. Copy what you need into your draft, save it, then press Publish."
- Every other `rebase` clears `mergeMark`.

- [ ] **Step 1: Write the failing tests.**
  - (**Review Focus 2**) `publish never overwrites a page that changed since the draft began`:
    - Someone else's edit → `conflict` with both diffs and no PUT.
    - A race (the read matches, then the PUT answers 412) → `conflict` with exactly one PUT and two reads.
    - The ETag changed but the content equals base → published with the fresh ETag.
    - A page deleted since the draft began → `failed` with `WIKI_PAGE_GONE` and `DRAFT_KEPT`, no PUT, and the draft file unchanged.
    - Publish right after Merge by hand, with the draft unchanged → `conflict` with `MERGE_NOT_SAVED` and no PUT; after the draft is saved with changes, it publishes.
  - `publish sends the draft with If-Match and rebases the draft on what it published`. Publishing the same text again gives `unchanged`.
  - `a fresh read that fails reports its message and sends no PUT` (403 and signed out)
  - `a second publish of the same draft while one runs makes no calls`
  - `a missing draft file says so and forgets the draft`
  - `Publish mine replaces their version with one PUT`
  - `Take theirs rewrites the draft and its base`
  - `Merge by hand opens their version and rebases on it`. It calls `editor.open` with `.orca-ado/wiki/.theirs/…`.
  - `resolve refuses a missing draft, a missing file and a deleted page before any write`
  - `a refused PUT reports Azure DevOps's message and is not retried`
  - main: `wiki.publish answers through the handler`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS. Typecheck, validate and check pass.
- [ ] **Step 5: Commit** "Publish wiki drafts with conflict handling".

### Task 11: Wiki tab

**Files:**
- **Create:** `src/panel/wiki/{state.ts,wiki-tab.tsx,page-view.tsx,drafts.tsx,fixtures.ts}`.
- **Modify:**
  - `src/panel/panel.tsx`: `TabBody` renders `WikiTab`. The "Coming in a later update" fallback goes. Add `syncWiki(loaded.status === 'ready' && org?.state === 'connected' ? org.org : null)`.
  - `src/panel/panel.test.tsx`: the placeholder assertion found in Task 0.
  - `src/panel/test-support.ts`: defaults `wiki.list` `[]` and `wiki.drafts` `[]`.
  - `src/panel/panel.check.ts`: a `wiki` scenario with an open page and a draft.
- **Test:** `src/panel/wiki/wiki-tab.test.tsx` and `src/panel/panel.test.tsx`.

**Interfaces:**
- **Consumes:** the `wiki.*` requests; `SEARCH_TOO_SHORT` and `MIN_SEARCH_CHARS`; `LONG_WAIT`; `LoadFailure`; the panel test helpers.
- **Produces:**

```ts
export const MAX_TREE_ITEMS = 1000
export const wikiChoice: Atom<Record<string, string>>                      // key 'wikiChoice', persist 'plugin'; org → wikiId
export const openPage: Atom<(WikiPageRef & { title: string }) | null>     // key 'wikiPage', persist 'workspace'
export function syncWiki(org: string | null): void                           // null keeps everything; a different org resets all but wikiChoice
export function refreshTree(): Promise<void>
export function isRunning(key: string): boolean
export function chooseWiki(org: string, wikiId: string): void
export function toggleFolder(ref: WikiPageRef, open: boolean): Promise<void>
export function showPage(ref: WikiPageRef & { title: string }): void
export function search(text: string): Promise<void>
export function clearSearch(): void
export function edit(ref: WikiPageRef): Promise<void>
export function publish(key: string): Promise<void>
export function resolve(key: string, choice: 'mine' | 'theirs' | 'merge'): Promise<void>
export function discard(key: string): Promise<void>
export function treeItems(levels: ReadonlyMap<string, WikiLevel>, expanded: readonly string[], max?: number): { items: TreeItem[]; capped: boolean }
```

**UI** (copy exact):
- **Header:**
  - Loading: `Skeleton lines={3} label="Loading wikis"`. Failure: `LoadFailure` with the message and Try again.
  - No wikis: `EmptyState title="No wikis" description="Project wikis and published code wikis in this organization show up here."`
  - One wiki: its name as `Text weight="semibold"`. Several: `Select label="Wiki"` with options `<name> · <project>`, remembered per org.
  - `Input type="search" label="Search the wiki" labelHidden placeholder="Search the wiki"`. It searches on submit. Under `MIN_SEARCH_CHARS` it shows `SEARCH_TOO_SHORT` without a request. A failed search shows its message in a danger `Callout` under the box.
- **Drafts:** `Collapsible title="Drafts (<n>)" defaultOpen`, one `Card` per draft. While loading: `Skeleton lines={2} label="Loading drafts"`. Failure: `LoadFailure` with Try again.
  - Card title: the page title. Description: `<wiki> · in <workspace>`. Then the file, muted: `.orca-ado/<file>`.
  - A muted status line: "Saved changes not published yet." or "No changes since you opened or published it.", followed by "Published <RelativeTime>" once published.
  - Buttons: a small "Publish", an outline "Open" that sends `wiki.edit`, and a ghost danger "Discard…". Every button on a card, and in its result, is disabled while `isRunning(key)`.
  - "Discard…" asks "Discard this draft? Changes you haven't published are lost." with a danger "Discard" and a ghost "Keep".
  - Results are kept per key (Plan 3 R11). The list reloads after every action.
- **Results:**
  - Only the most recent conflict keeps its diffs and choices. When a new conflict arrives, an older conflict result keeps only its message, followed by muted "Press Publish to see both versions again."
  - Conflict: `Callout tone="warning" title="This page changed in Azure DevOps"` with the message.
    - "Their changes" and "Your changes", each as a semibold label over `CodeView language="diff" label=<same text> lineNumbers={false} maxHeight="md"`. A null `text` shows its message, muted.
    - "Publish mine…" asks "Publish your draft over their changes? Their changes are lost." with a danger "Publish mine" and a ghost "Cancel".
    - "Take theirs…" asks "Replace your draft with their version? Your changes are lost." with a danger "Take theirs" and a ghost "Cancel".
    - An outline "Merge by hand".
  - Any other result is a `Callout`: success when published or updated, neutral when unchanged, danger when failed.
- **Search:**
  - A muted count: "<n> pages match", "1 page matches" or "No pages match.", with a ghost "Clear search".
  - `List label="Search results"`. Each row's title is the page title and its description `<path> · <snippet>`. Pressing a row shows the page.
- **Tree:** `Tree label="Pages" maxHeight="lg"` built from `treeItems`, keyed by path, with `icon="file-text"` and `hasChildren`.
  - Each level loads once. `IconButton icon="refresh" label="Refresh pages"` above the tree (`refreshTree`) forgets the loaded levels and reloads the root and every expanded folder.
  - A capped level ends with a disabled `Showing <n> of <total> pages`.
  - Past `MAX_TREE_ITEMS`, muted: "Some pages are hidden. Collapse a folder to see others."
  - Expanded paths are kept in an atom.
- **Page:**
  - `IconButton icon="close" label="Back"`, the title as `Heading level={3}`, and the path, muted.
  - When editable, "Edit in Orca" (`icon="edit"`) sends `wiki.edit`. Its message shows in an accent `Callout` if the page opened, a danger one otherwise.
  - Then `Link` "Open in Azure DevOps", `IconButton icon="refresh" label="Refresh"`, the `notice` (muted), and the `Markdown`. Empty content shows muted "This page has no content yet." instead.
  - Loading: `Skeleton lines={6} label="Loading the page"`. Failure: `LoadFailure` plus Back.
- **Stale answers:** answers for an org, wiki or page that is no longer shown are dropped. `syncWiki` acts only on a non-null org that differs from the one shown, and then resets everything except `wikiChoice`.

- [ ] **Step 1: Write the failing tests.**
  - `the Wiki tab lists the wikis and the root pages`
  - `expanding a folder loads its children once`
  - `choosing a page shows it rendered with Open in Azure DevOps`
  - `a code wiki page has no Edit and says why`
  - `Edit in Orca sends wiki.edit and shows the message`
  - `search shows hits and opening one shows the page`
  - `a short search shows the message without a request`
  - `a search with no hits says No pages match.`
  - `a failed search shows its message under the box`
  - `a wiki list that fails to load shows the message and Try again`
  - `drafts show a skeleton while loading and the message if they fail`
  - `an empty page says it has no content yet`
  - `Refresh pages reloads the root and the expanded folders`
  - `Drafts shows each draft with Publish, Open and Discard`
  - `a conflict shows both diffs and the three choices; Publish mine and Take theirs ask first`
  - `Discard asks first`
  - `results stay with their draft`
  - `a second Publish press before the buttons redraw sends nothing`
  - `a newer conflict leaves the older one with its message only`
  - `switching org resets the tab but keeps the chosen wiki per org`
  - `an open page survives a panel reload`: mounted with a persisted `wikiPage`, it renders the page, not the tree, before and after the org list loads.
  - `the tree stops at 1,000 items, and the tab stays under 4,000 nodes and 450 KiB`: a 60 KiB page; then 50 drafts, three in conflict with 60 KiB diffs each, with the tree open. Ends with `closeCleanly`.
  - `the Wiki tab no longer shows the placeholder`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Check passes with the `wiki` scenario.
- [ ] **Step 5: Commit** "Add the Wiki tab".

### Task 12: Verification, README and live checks

- [ ] **Step 1:** Run `orca plugin validate . --json`, `npm run typecheck`, `orca plugin test . --json` (expect `# fail 0`) and `orca plugin check . --json`. All must pass.
- [ ] **Step 2: README.**
  - Move "PR reviews" and "Wiki" to "Works now".
  - Rewrite **To review** for Reviewed by you and the in-panel review.
  - Add **Reviewing a pull request**:
    - its sections, and that a new vote replaces your earlier one;
    - the numbered diff, and which number a line comment uses;
    - what isn't shown and why: binary files, files over 2 MiB (which take whole-file comments only), too many changes, more than 1,000 files;
    - thread limits;
    - Check out in Orca step by step (per S1), with Cancel and the 10-minute arm. Unless S1 (d) let the arm be tied to the project, say that the next new workspace, in any project, gets the branch.
  - Add **The Wiki tab**:
    - code wikis are read-only;
    - the tree, search, and images opening as links;
    - Edit in Orca: drafts live in `.orca-ado/wiki/` (git-ignored), Publish sends what is saved, and you can have up to 50 drafts;
    - the conflict choices, and Discard.
  - **Polling:** reviews and wiki pages load when opened and on Refresh, never in the background.
  - **PAT scopes:** Code: Read & write (`vso.code_write`) also covers votes and comments. Add Wiki: Read & write (`vso.wiki_write`), hedged like the existing list.
- [ ] **Step 3: Live checks with the user.** These need the sandbox org. Fill the pending rows of `docs/superpowers/spikes/2026-11-05-plan-5.md`.
  - (a) A PR with an edit, an add, a delete, a rename and a binary: compare diffs and line numbers with ADO.
  - (b) Reply, resolve and reactivate. File and line comments land on the right lines. Mentions show names.
  - (c) The four votes, as ADO records them. A draft PR refuses a vote.
  - (d) Check out in Orca: an existing workspace, a local branch, a remote-only branch, and a branch checked out elsewhere. Then the Source Control compare.
  - (e) Wiki: the tree, images and links, search and its path mapping, and a code wiki.
  - (f) Edit and Publish:
    - the ETag form;
    - `git status` stays clean;
    - Orca's editor and preview;
    - an edit made in the browser meanwhile → the conflict view, and each choice;
    - record the PUT conflict status;
    - a unicode page such as `/Résumé/Überblick 文档`: it opens in `editor.open`, publishes, and `git status` stays clean.
  - (g) Read-only on the client org: a large PR's load time and call count, and whether wiki search is offered.
  - (h) Both views at 360 px in both themes.
- [ ] **Step 4: Commit and report** which spikes were settled and which live rows remain. The report also asks the user two questions:
  - Confirm that wiki editing in Orca's own editor replaces the full-tab editor of spec §5.1 and §6 and roadmap row 5.
  - Rule on spec §6's review-requested and new-comment notifications, which no plan owns (the roadmap's open item).

---

## Pre-flight scan

Baseline `cd86753`, with Plan 4 Tasks 7–12 as specified. "Fixed" means the plan above already carries the fix.

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T0 → T3–T5, T8–T10, T12 | Fixtures, S1 option, shapes, pending rows | OK. T0 writes every new fixture, and T5's copy follows S1. |
| T0 ↔ Plan 4 T7–T12 | `tab-files.ts`, `remote.ts`, `open-file.ts`, `noRepoWorkspace`, Pipelines tab, `shareView(host)` | **Risk, handled.** None of these exist yet. T0 re-reads them and returns drift before T1. |
| T1 → T3, T8 | `panelMarkdown` | OK. One function; each caller passes its own `resolve`. |
| T1 ↔ Plan 1 `http.ts` | `host` gains `'almsearch'` | OK. Additive; Plan 4's pressure wrapper passes requests through. |
| T1 ↔ Plan 4 T7 `run-views.ts` | `ANSWER_BUDGET_BYTES` | **Duplicate, fixed.** The private constant moves to `worker/budget.ts` and both import it; run-views tests stay unedited. |
| T2 → T3, T10 | `diffText` | OK. File diffs and wiki conflict diffs share one function, so they share one cut rule and one message set. |
| T3 ↔ Plan 3 `pullrequests.ts` | `description`, `forkSource` | OK. Optional fields; `toPrSummary` is unchanged. |
| T3 → T4, T5 | `pullRequest`, `fileFacts`, `getThread` | OK. These always read fresh; writes never use `diff`'s kept facts. |
| T4 ↔ Plan 3 `pr-actions.ts` | `castVote` → `setVote` | OK. Plan 3's tests are unedited. |
| T5 ↔ Plan 2 arm, hooks, handlers | One arm | **Conflict, fixed.** Two arms would race for one hook. Main creates one and both registrars take it. `work.cancelWorkspace` disarms either. A PR arm skips folder events, and other projects when S1 (d) allows. |
| T5 ↔ Plan 4 T8 `remote.ts` | Workspace remotes | **Conflict, fixed.** Reviews would otherwise import from pipelines. The file moves, with its tests, to `worker/workspace/remotes.ts` (as code projects did in Plan 4) and gains `remote` and `sameRepo`. |
| T6 ↔ Plan 3 `PrSnapshot`, `service.ts`, prs-tab tests | `reviewed`; the To review press | **Conflict, fixed.** Both `compose` and the reviews-only poll compute `reviewed`, and every `PrSnapshot` literal (`service.test.ts`:236, `panel.check.ts`, `prs-tab.test.tsx`, `snapshotOf`) gains it. Four prs-tab tests change: the browser-press test is rewritten, and the three consent tests move to the review header's "Open in Azure DevOps", which keeps `openPr` and `reviewNotice` alive. T12 updates the README. |
| T6 ↔ Plan 4 T11 `prs-tab.tsx` | `shareView('prs')` checks | OK. The review view renders after them. |
| T6, T11 ↔ `panel.tsx` sync calls | `syncReview`, `syncWiki` | **Conflict, fixed.** `Panel` runs before the org list loads; both take null until it is `ready` and connected, and null keeps the persisted review and page. |
| T6 → T7 | `review/*` | OK. T6 leaves Files and Comments empty; T7 fills them. |
| T9 ↔ Plan 4 T7 `tab-files.ts` | Nested names; the `.gitignore` write | **Conflict, fixed.** `writeTabFile` only took flat names, and writes `.orca-ado/.gitignore` before any check. T9 adds parent folders and refuses names that escape, and `assertInside` runs before every `writeTabFile` call, so a symlinked `.orca-ado` is refused first. The board and run tests stay unedited. |
| T11 ↔ `panel.tsx` (Plan 4 T10) | Placeholder | Fixed. The placeholder goes; T0 lists its assertions and T11 edits them. |
| T3–T5, T8–T10 | `messages.ts`, `protocol.ts`, `main.ts` | OK. Distinct entries, edited in task order. |

### Each task against itself

| Task | Finding |
|---|---|
| T0 | OK. Commits only the spike record and fixtures. |
| T1, T2 | OK. Every rule has a case (Review Focus 3 and 1). |
| T3 | OK. Each read, the mapping, caching and abort are tested, and the fake runs through the service. |
| T4 | OK. Every rule and both bodies are tested (Review Focus 4). |
| T5 | OK. Plan 4's moved tests stay green, and the shared arm is tested through main. |
| T6, T7 | OK. Worker rule tests, the persisted review, and node and byte budgets with `closeCleanly` (Review Focus 1). |
| T8 | OK. `putPage` is tested here and used by T10. |
| T9 | OK. Real files and real symlinks at three levels in `mkdtemp`, with the outside target listed before and after (Review Focus 5). |
| T10 | OK. Each publish step and choice has a case (Review Focus 2). |
| T11 | OK. Tree cap and page budget are asserted. |
| T12 | OK. Verification and docs only. |

## Plan review rulings

The independent review's findings were all applied. Where it offered a choice, or the fix had to differ, these rulings record why.

- Ruling: review-requested and new-comment notifications stay an open item for the user (roadmap, Task 12 report), not a task. They need a new setting, and this plan adds none.
- Ruling: the three consent tests move to the review header's "Open in Azure DevOps", and are not deleted. That keeps `openPr` and `reviewNotice` in use, and keeps consent failures visible.
- Ruling: a line comment on a side whose line count is `'unknown'` is refused with `LINE_UNCHECKED`, not posted unchecked. A line past the end would otherwise be reported as posted.
- Ruling: `orca plugin check` scenarios can't assert, so the "review view rendered" assertion lives in T6's panel-reload test, which mounts with the `review` scenario's persisted state.
- Ruling: an older conflict keeps its message and a hint to press Publish, rather than a new button, because each draft card already has Publish.
- Ruling: Publish right after Merge by hand returns `conflict` again, not a plain message, so Publish mine stays one press away.
- Ruling: the tree gets its own "Refresh pages" button, because the page's Refresh reloads only the page.
- Ruling: page paths are never Unicode-normalized; only draft file names are. A path must reach ADO exactly as ADO gave it.
- Ruling: `PrReview.loadedAt` and `DraftSummary.file` are shown, while `ReviewThread.updatedAt` and `DraftSummary.startedAt` are dropped. `StoredDraft.startedAt` stays for ordering.
