# Azure DevOps for Orca — design

Date: 2026-11-03 · Status: approved 2026-11-03 · Research: [`docs/research/2026-11-03-recon.md`](../../research/2026-11-03-recon.md)

## 1. Intent

Developers who live in [Orca](https://github.com/stablyai/orca) still leave it for the Azure DevOps (ADO) website, mostly to:

1. review other people's pull requests and check on their own,
2. get their PRs in front of reviewers and approvers,
3. check boards, read work items and move them between columns,
4. watch pipelines and troubleshoot failures, including prod deploys waiting for approval,
5. read and update wiki pages.

This plugin brings those jobs into Orca so you never have to leave it. It is **open source and generic**: anyone with an ADO organisation can install it. The author's own workflow (section 3) is the reference case the design is tested against, but nothing in it may be hard-coded.

## 2. Goals, non-goals, anti-goals

### Goals: must work really well in v1
- **Boards**: your work items by board column, their details, moving them, and seeing how far their PRs have travelled.
- **Pipelines**: watch runs live stage by stage, get to the error fast with a rich log, and share prod approvals that are waiting.
- **PR sharing**: handle a feature's set of PRs together (approve, auto-complete) and share them in the author's link format to people and channels.

### Goals: present in v1, refined later
- A PR review inbox: read, diff, comment, vote.
- Status of your own PRs: covered by the release-set view.
- Wiki: browse, read, search, edit and publish.

### Non-goals
- Releases (classic Release pipelines). The reference project deploys with Helm from pipelines.
- Rebuilding what Orca already does natively for ADO: the per-workspace PR badge, the Checks header and Create PR (see 4.4). The plugin complements these.
- Posting to Teams *as the user* through Microsoft Graph. It needs tenant consent, so maybe later.
- A shared, author-owned Entra app registration that works out of the box for everyone. Maybe later (see 5.6).
- Real-time push from ADO. None is available to a desktop app, so the plugin polls.

### Anti-goals: failure even if everything technically works
- **Acting as the wrong account.** Many developers have several Microsoft accounts. The plugin must never silently use a different account from the one pinned for an org (5.6).
- **Interfering with the developer's own tooling.** The plugin must never change which account the user's terminal `az` is signed into, nor be changed by it.
- **Hard-coding one company's setup**: org, project, team, process, state names, column names, swimlanes, branch names (`dev`/`staging`/`master`) or share format.
- **Needing admin rights to get started.** A developer can install it and use it the same day.
- **Leaking credentials.** No tokens in plaintext files the plugin owns, in logs, in panel state or in environment variables. The one accepted exception, approved by the user, is the Azure CLI connection's private `az` profile (see 5.6).
- **Hammering ADO.** It respects ADO rate limits and never makes Orca feel slow.
- **Looking foreign.** It uses Orca's native components and theme wherever possible.

## 3. The reference workflow (generic description)

The author's day, which v1 must make smooth (names are examples, not constants):

- **Boards.** Items are assigned to them. They create PRs for an item and link them to it. Once the PRs are merged into the lower environment branches (e.g. `dev` and `uat`/`staging`), they move the item to a *Testing* column. After testing it goes to *Ready for Release*. Once merged into the production branch (e.g. `master`) and deployed, they close it. They think of the board's vertical columns as "swimlanes" and work mostly with those.
- **PRs.** An Orca agent session finishes a feature and opens **three PRs from the same branch**, one per environment branch (e.g. `dev`, `staging`, `master`). For each, the author opens ADO, casts their own approval vote and sets auto-complete. They then copy each PR's heading in this exact shape and share it with an admin, a senior or a review group, typically in Microsoft Teams:

  > [Pull Request 123396](https://dev.azure.com/…/pullrequest/123396): [PROJ-55283] Reserve a buyer's line and flag missed calls on the lead

  Only "Pull Request 123396" is the hyperlink. The rest is plain text: the PR title, which here starts with a ticket key.
- **Pipelines.** They watch a run live from the start. Failures usually come in the Docker build step, the Helm deploy step, or a PR validation build (compile or a security scan such as Wiz). Prod deploys (from `master`) pause at an environment approval before Helm runs, and the author must get an admin or senior to approve it.
- **Accounts.** On their current client project they use **two Microsoft accounts**: one for ADO, portals and tools, and one for infrastructure and development auth (e.g. Azure subscriptions via `az`). Switching the terminal's `az` account for infra work must not change who the plugin acts as.

## 4. Constraints

All of these are verified in the research notes unless marked otherwise.

### 4.1 Orca platform (installed and latest: 1.4.248, released 2026-11-04)
- **Version floor.** The plugin targets `engines.orca >=1.4.248`. That unlocks hooks, status bar items, `workspace:write` (`editor.open`, `workspace.open`, `commands.run`), `agent:launch`, `terminal:read` and `customEditors[].frame`. Feature-detect anything newer with `host.has` / `ui.has`.
- **Always-on worker.** A plugin with `main` and `contributes.statusBarItems` has its worker started when it is enabled and kept running while it stays enabled. Background polling and notifications therefore work whenever Orca is open.
- **Still impossible on 1.4.248:**
  - **Creating a workspace.** No host API creates a worktree or workspace, so it stays one visible step: Orca's own new-workspace flow (named through the `workspace.create.before` hook) or a command the user can see in an Orca terminal.
  - **Virtual tabs.** Full tabs still need a backing file inside a workspace (`editor.open({ workspaceId, path })`).
- **Plugin shape.** A `trusted-worker` plugin. The `main` is a Node 24 child process with no sandbox and no network allowlist. Panels and custom editors are sandboxed frames with **no network**, so every ADO, Microsoft or webhook call goes through the worker.
- **Messaging limits.**
  - Panel→worker `plugin.request`: answers ≤1 MiB, timeout 30 s default (120 s max).
  - Worker→panels `panels.post`: ≤256 KiB, 200 per 10 s.
  - Frame→host messages: ≤64 KiB, 120 per 10 s. Chunk large saves.
- **Worker lifetime.**
  - Started at enable time and kept running, because the plugin declares a status bar item; otherwise it would start lazily.
  - `activate` must be ready within 10 s.
  - Commands time out after 30 s.
  - Up to 3 crash restarts.
  - Long work such as sign-in must start, return immediately, and report back via `panels.post`.
- **Storage.**
  - `orca.secrets`: Electron safeStorage with a Keychain-backed key. Strings ≤64 KiB each, 1,024 keys.
  - `orca.storage`: JSON, ≤256 KiB per value. A file over 5 MiB silently reads back as `{}`, so it is not a cache.
  - Large caches go on disk under the user's home or temp directory. **Never write into the plugin folder** (its hash is checked before each spawn).
- **Worker environment.** The environment is a whitelist. `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` are stripped, so proxies and custom CAs must be handled in code.
- **UI surfaces.**
  - Sidebar panels live only in the right sidebar, 220 px to nearly the full window wide.
  - A full editor tab is only possible as a custom editor bound to a real file with the plugin's suffix, opened with `editor.open` or from `contributes.newFiles`. There are no virtual documents.
  - No API focuses a plugin panel.
- **Components panels.**
  - Available: lists, tables, trees, tabs, cards, badges, Markdown, CodeView (incl. `diff`/`log` grammars), forms and RelativeTime.
  - Missing: drag-and-drop, dialogs, menus, a diff viewer, line clicks, remote images, free styling and a clipboard.
  - Limits: 5,000 nodes per render, 64 KiB per Markdown or CodeView.
- **HTML frames** (HTML panels and custom editors): own DOM, canvas, WASM, bundled libraries, theme CSS variables. No eval, no network. Images only as `data:`/`blob:` URLs supplied by the worker.
- **External links.** `shell.openExternal` is panel/editor only. It needs a press on a settled control, accepts only http/https/mailto, and Orca asks once per host. `orca://` links cannot reach plugins, so OAuth redirects must come back to a loopback server in the worker.
- **Reserved.** Task sources, connections, sidebar cards, MCP servers and skills are not buildable by plugins. Boards therefore cannot appear in Orca's Tasks page, and sign-in cannot live in Settings → Integrations.
- **Limits.** ≤2,000 files and ≤50 MiB per plugin. Don't commit `node_modules`; bundle (esbuild). The plugin id must not start with `orca-`.

### 4.2 Azure DevOps REST
- **Versions.** Use `api-version=7.1`, plus preview versions per call: work-item comments, policy evaluations, Graph search and Markdown comments.
- **No org-wide PR list.** "My PRs" and "To review" fan out per project (or per repo), filtered by the user's id from `connectionData`.
- **No unified-diff endpoint.** The worker fetches both blob versions per changed file and diffs them, or uses local git when the branch is checked out.
- **Board columns are per team.** A move PATCHes `System.State` plus that team's `WEF_<guid>_Kanban.Column` (and `.Done` for split columns), with a `test /rev`. `System.BoardColumn`/`BoardLane` are read-only. Read each team's board config (columns, state mappings, lanes) and cache it.
- **WIQL returns ids only.** Hydrate with `workitemsbatch`, 200 ids per call.
- **Pipelines.** Use the Build API for lists, timeline, logs by line range, stage retry and cancel. The Pipelines API is only for starting runs with parameters. Use the Approvals API for environment checks.
- **Wiki.** Page edits need the page ETag in `If-Match`. Images live in the wiki repo's `.attachments`.
- **Everything authenticated.** Avatars and images included: the worker fetches them and hands data URLs to frames.
- **No push to a desktop client.** Poll within the rate limit (200 TSTU per sliding 5 min) and honour `Retry-After` and `X-RateLimit-*`.

### 4.3 Sign-in
- **ADO's own OAuth apps are gone.** No new registrations since April 2025, and they are removed in 2026. Use Microsoft Entra ID (MSAL Node 7.x bundles to one ~230 KB minified ESM file and runs in the worker).
- **Per-tenant tokens.** Each org lives in an Entra tenant and needs a token from that tenant's authority. The tenant can be discovered anonymously from `vssps.dev.azure.com/{org}`.
- **App registration.** "Sign in with Microsoft" needs one: public client, platform *Mobile and desktop*, redirect `http://localhost`. Tenant policies often allow user consent only for verified publishers, so in many companies an admin approves once.
- **Graph is separate.** Microsoft Graph tokens, if ever used, are separate tokens from the same app.

### 4.4 What Orca already does for ADO (don't duplicate)
- For the workspace's own branch, Orca finds its PR, shows number, title, state, conflicts and one combined status in the sidebar card and Checks tab, and can create the PR.
- It has no PR lists, threads, votes, policies, builds, boards or wiki.
- It authenticates only from `ORCA_AZURE_DEVOPS_*` environment variables in Orca's main process. A plugin cannot feed its token to it.
- Orca's workspace references accept ADO PR URLs but reject work-item URLs, so links between work items and workspaces live in plugin storage.

### 4.5 Teams
- Office 365 connectors and incoming webhooks stopped in May 2026.
- **Workflows webhooks.** Any channel member can create one from the "Send webhook alerts to a channel" template in about two minutes. It posts an Adaptive Card (OpenUrl actions only, ~28 KB) as the Workflows bot. The URL is a secret, and a `202` means accepted, not delivered.
- **Chat deep links.** `https://teams.microsoft.com/l/chat/0/0?users=<UPN>&message=<text>` prefills **plain text only**.
- **Share-to-Teams web link.** `msgText` is limited to 200 characters.

## 5. Decided with the user

### 5.1 Overall shape
- **One plugin** with a **sidebar panel** (native components) of four tabs: **Work · Pipelines · PRs · Wiki**. It is the hub for lists, status and quick actions.
- **Full-width tabs** for the two rich views: the **team board** and the **live pipeline run**. They are custom editors (isolated frames) opened in one click with `editor.open`, backed by small plugin-managed files whose location is the Boards plan's first spike. **Wiki editing** opens a Markdown draft in Orca's own editor instead (see §6).
- **Status bar item** (always-on worker). It shows the connection state and the counts that need the user: failed runs, approvals waiting, PRs to review. Its tone follows the worst of those.
- **Everything in v1 targets Orca 1.4.248.** There is no separate enrichment release.

### 5.2 Boards
- **Sidebar "My work" list** (default: assigned to me, current sprint/iteration where the team uses one):
  - Items grouped by the team board's columns.
  - Each card shows type, id and title, plus **chips showing how far the item's linked PRs have travelled**: one chip per linked PR target branch, merged ✓ / open · / build running.
  - A "Move to…" picker that lists that board's columns.
  - Opening a card shows its details: description, acceptance criteria, comments (read and add), and links including PRs.
- **Full-tab team board:**
  - **Vertical columns are the primary structure**, with drag-and-drop between them.
  - Horizontal swimlanes appear only when the team's board defines them, and start collapsed.
  - Filter: me / everyone.
- **The boards project is chosen independently of the code.** Per org, the user picks the project (and team) whose board they use. It is often a dedicated project holding the epics, features and user stories for all the work, separate from the projects that hold the repos and pipelines. Work items and PRs link across projects within the org, and the plugin follows those links in both directions.
- **Hierarchy is visible.** Cards and details show the item's parent (e.g. the Epic or Feature above a story), and the board can be filtered by it.
- **Columns, lanes, states and transitions are always read from the team's board configuration,** never assumed.
- **Linking PRs to items:** link existing PRs, and new PRs created from an item are linked automatically.

### 5.3 Pipelines
- **Sidebar runs list:**
  - Filters: Mine, Running, Needs me, Failed. Running runs come first.
  - Each run shows a mini stage-progress bar and its status.
  - A run waiting for approval shows **Share for approval**.
- **Full-tab live run view:**
  - Stage strip across the top.
  - Steps of the selected stage with durations.
  - That step's log, **tailing live**, with search and an "errors only" filter.
  - An **error summary**: the failing step and its error lines, with *Jump to line*.
  - Rerun the failed stage, cancel, and *Open in ADO*.
- **Prod approvals:** show the waiting environment check, who can approve and how long it has waited.
  - **Share for approval** offers message an approver in Teams, post to the team channel, email the approvers, or copy the link.
  - If the user *is* an approver, **Approve/Reject** with an optional comment.
- **Desktop notifications** (`notifications.show`): when a run the user cares about fails, finishes, or starts waiting for approval. They fire whenever Orca is open, thanks to the always-on worker.
- **Open the failing file.** When an error points at a file in a workspace's repo, "Open in Orca" opens it with `editor.open`. There is no line argument; the line is shown alongside.

### 5.4 PRs and sharing
- **"Release set" grouping in the PRs tab.** The user's PRs that belong together are shown as one group, one row per target branch. Each row shows the PR number, build/policy status, reviewer votes and auto-complete state.
- **Group actions:**
  - **Approve all** casts the user's own vote on each.
  - **Auto-complete all** uses saved merge options: merge strategy, delete source branch, complete linked work items, transition work items.
  - **Share…**.
- **Share composer:**
  - Builds the message with one line per included PR, in the reference format: hyperlinked "Pull Request N", then ": title".
  - Optional editable intro text, and toggles for which PRs to include.
  - The format is a configurable template, and the default reproduces the reference format exactly.
- **Destinations (pick one or several, remembered):**
  1. **Copy as rich text.** HTML plus a plain-text fallback, so links keep their text when pasted into Teams, Slack or email.
  2. **Post to channel.** A named Teams Workflows webhook configured once, stored as a secret, with *Test* and *Replace* actions. It posts an Adaptive Card. The UI says "sent (accepted)", not "delivered".
  3. **Message a person.** Teams chat deep link with prefilled plain text.
  4. **Add as reviewers.** People or groups, required or optional. ADO notifies them.
- **Sharing is a list of pluggable destinations,** so Slack or a generic webhook can be added later without redesign.

### 5.5 PR reviews and wiki (basic in v1)
- **PR review inbox ("To review"):**
  - Lists PRs across the user's projects.
  - Opening one shows its description, changed files with read-only per-file diffs (CodeView `diff`), and comment threads.
  - Threads support reply, resolve, and a new comment on a file or line (line chosen by input).
  - Votes: approve, approve with suggestions, wait for author, reject.
  - **Check out in Orca** creates a worktree of the PR's source branch so Orca's native branch-compare diff can be used.
- **Wiki:**
  - Page tree, rendered page and search.
  - **Edit** opens the page as Markdown in Orca. **Publish** writes it back with the ETag and warns on conflict, showing what changed and letting the user choose.

### 5.6 Sign-in and accounts
- **Three ways to connect an org, all available in v1:**
  1. **Azure CLI (default, zero setup).**
     - The plugin runs its **own private `az` profile**: a separate `AZURE_CONFIG_DIR` under the user's home, never the user's normal `~/.azure`.
     - Signing in runs `az login` (browser) in that profile.
     - Tokens come from `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --tenant <org tenant>` in the same profile.
     - The terminal's `az` and the plugin can never affect each other.
     - **Token storage (approved by the user):** `az` keeps its tokens, including refresh tokens, in a plaintext `msal_token_cache.json` on macOS and Linux; it encrypts only on Windows. The user accepted this for the zero-setup default, under three conditions:
       - The private profile folder is created owner-only (0700, files 0600).
       - The panel states where the tokens live.
       - **Sign out deletes the folder.**
     - Don't turn on az's experimental `core.encrypt_token_cache`. On macOS it uses one fixed Keychain item that the user's own `az` would share.
  2. **Sign in with Microsoft (Entra ID via MSAL Node).**
     - The app (client) ID and optional tenant are a plugin setting. The README includes a step-by-step admin guide for registering the app.
     - Flow: auth code + PKCE with a loopback redirect. The panel's button opens the URL via `shell.openExternal`.
     - Tokens are cached in `orca.secrets` through a custom MSAL cache plugin.
  3. **Personal access token,** pasted into the panel and stored in `orca.secrets`.
- **Account pinning:**
  - Every connection forces the account picker (`prompt=select_account` or the az equivalent) so the browser's default account can't slip in.
  - After sign-in the plugin records the account (UPN and object id) as **pinned** for that org. The panel always shows "‹org› · signed in as ‹account›".
  - If a token ever comes back for a different account, the plugin refuses to use it and tells the user.
- **Multiple orgs:** any org can be added by URL, each with its own pinned account and its own connection method.

### 5.7 Connecting to Orca's workspaces
- **Stay inside Orca's permission model (decided by the user).** The plugin never runs the `orca` CLI in the background. That route is undocumented and bypasses Orca's approval prompts, and a public plugin has to be trustworthy.
- **Start an agent on this work item.** Launches the chosen agent (`agent.launch`) in the item's workspace with a prompt built from the item: title, description, acceptance criteria and link.
- **Work-item context for agents (opt-in setting, off by default).** The `agent.prompt.before` hook prefixes prompts that Orca submits to agents in a workspace linked to a work item with a short context line: id, title, link.
- **Branch naming through hooks.** When the user creates a workspace for an item, `workspace.create.before` sets the branch from the template and `workspace.create.after` records the item↔workspace link.
- **Start a workspace from this work item.** Creates an Orca worktree on a branch named from the item, using a template with sensible default (e.g. `feature/<id>-<slug>`). It records the item↔workspace link in plugin storage. "Check out PR in Orca" works the same way for a PR's source branch.
- **PR URLs are attached to workspaces as Orca references,** which Orca accepts natively.
- **How these actions run.**
  - **Opening workspaces, files and tabs, and launching agents:** one click through the official APIs (`workspace:write`, `editor.open`, `agent.launch`).
  - **Creating a workspace or worktree:** no official API exists, so the plugin hands the user one **visible step**. Either Orca's own new-workspace flow, with the branch named by the hook, or a command sent to an Orca terminal (`terminal.create` / `terminal.sendText` without Enter) that the user confirms. `terminal:read` lets the plugin check the result.
- **Branch→PR mapping for the focused workspace.** Match `workspace.list` to the read context, run local `git remote get-url`, then query ADO by `sourceRefName`. This drives context-aware views ("this workspace's item and PRs").

### 5.8 Settings (in Orca's Settings, via `contributes.settings`, plus in-panel setup)
- Orgs and their connection method and pinned account.
- Per org: the **boards project and team**, and the **code projects** included in the PR and pipeline views. *Claude's call:* by default this is every project the user can access that has repos, and the user can narrow it.
- Share destinations (webhook URLs stored as secrets) and the share template.
- Auto-complete defaults.
- Branch-name template.
- Notification toggles.
- Optional proxy and CA settings (because the worker env strips them).

### 5.9 Testing environment (decided by the user)
- **A free personal Azure DevOps org is the sandbox for everything that writes:** card moves, votes, auto-complete, stage retries, environment approvals, wiki publishes, share posts. The user creates it.
- **What the sandbox needs:**
  - A boards project separate from a code project.
  - A Kanban board with custom columns (e.g. Testing, Ready for Release) and a swimlane.
  - A repo with three environment branches and PR policies (build validation, required reviewers).
  - A multi-stage YAML pipeline with an environment approval before a deploy stage.
  - A wiki.
- **The client org is read-only during development.** It is used for read checks only, until the user starts using the plugin for real.
- **Teams share posts are tested against a channel the user chooses for testing.**

### 5.10 Repository
- **Local:** `~/Development/dev/orca-azure-devops`.
- **Public home:** GitHub under the **CanadianMapleFarmer** account, created and pushed only when the user asks.
- **Catalog:** publishing (tag, `orca-plugin` topic, catalog entry) only when the user asks.

## 6. Calls made by Claude (not explicitly decided by the user)
- **"Move to next column?" nudge.** When a linked PR merges into a branch, the plugin suggests the next column. The mapping is learned from the board, or configured per team as "PR merged into ‹branch› → suggest ‹column›". It is off until configured.
- **Release-set grouping:** PRs with the same source branch, or sharing a linked work item, form one set.
- **Polling cadence:** fast (a few seconds) for what is visible and running, slower for the rest, paused when no panel or tab is visible. The exception is runs the user explicitly *watches*, which keep polling until they finish. Always within ADO's rate-limit headers.
- **Which board.** "My work" and the full board use a team's **Kanban board for one backlog level**: by default the requirement level (Stories / PBIs / Requirements, whatever the process calls it), for the default team chosen per org. Assigned items that aren't on that board (e.g. Tasks) appear in an "Other" group by State and are moved by State. The sprint **Taskboard is out of v1**. Other teams' boards can be picked in the full-tab board.
- **Notifications and polling are always on** while the plugin is enabled. The status bar item keeps the worker running. Background polling is slow (minutes) and only fast for what is visible or *watched*.
- **PR chips on work-item cards:** an open PR shows its validation build and policy status; a merged PR shows ✓. Post-merge pipeline and deploy status, including "waiting for approval", is shown on demand in the work item's detail view, not on every card. This keeps the sidebar cheap.
- **Notification set:** failure, completion of a watched run, approval waiting, review requested, new comment on my PR.
- **Default branch template** `feature/<id>-<slug>`.
- **PR code review** uses Orca's native diff on a checked-out worktree for depth; the in-panel diff is read-only.
- **Wiki editing** happens in Orca's own editor, on a Markdown draft in the git-ignored `.orca-ado/wiki/` folder of a workspace, never on a tracked file in the user's repo. Publish and conflict handling live in the sidebar's Wiki tab and run in the worker. Decided by the user on 2026-11-06, replacing the earlier full-tab editor.
- **Horizontal swimlanes start collapsed** on the full board.
- **The plugin id** must not start with `orca-`. Something like `azure-devops`, with display name "Azure DevOps", is the builder's choice.

## 7. Left to the builder
- Code structure, bundling, test strategy (Orca's `orca/testing` kit, `orca plugin test/check`), caching layout, exact polling intervals, retry/backoff, and component composition within the decided layouts.
- Which libraries to bundle into the frames: a diff algorithm, drag-and-drop for the board, a virtualised log view with ANSI colours.
- How full-tab views open on 1.4.247: `newFiles` untitled documents vs plugin-managed files. Choose after the spike below.
- **Spikes to run first.** These are the research's open unknowns, settled before committing to the affected parts:
  - How the visible-command route works on 1.4.247: `terminal:send` reaches only the focused workspace's terminals, so what happens when no terminal is open there, and what the manual fallback looks like.
  - How untitled `newFiles` tabs behave: save prompts, survival across restarts.
  - Rich-text clipboard: `navigator.clipboard` inside a frame vs a worker shell-out per OS (macOS `osascript`/NSPasteboard HTML, Windows `Set-Clipboard -AsHtml`, Linux `xclip -t text/html`).
  - A board move works with only the WEF column fields plus state.
  - Real rate-limit headroom with the polling plan.
  - The isolated `AZURE_CONFIG_DIR` login and token flow running from the worker.
  - MSAL loopback inside the worker with Orca's external-link consent.
- Accessibility and keyboard support within what Orca's components allow.
