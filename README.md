# Azure DevOps for Orca

Azure DevOps boards, pull requests, pipelines and wikis inside [Orca](https://github.com/stablyai/orca) (see Status).

**Status: under construction.**

| Works now | Coming |
| --- | --- |
| Connecting any number of Azure DevOps organisations | PR reviews |
| Pinning each organisation to one account | Wiki |
| Choosing each org's boards project, team and code projects | |
| An always-on worker and an `ADO` status bar item | |
| A Work tab with your items, grouped by board column | |
| A full-tab team board with drag-and-drop | |
| Starting a workspace or an agent from a work item | |
| A PRs tab with your pull requests in release sets, plus Approve all and Auto-complete all | |
| Sharing pull requests to the clipboard, a Teams channel, a Teams chat and reviewers | |
| A Pipelines tab with your runs, their stages and the approvals waiting on them | |
| A full-tab run view with a live log tail, search, errors only and an error summary | |
| Approving or rejecting an environment approval, rerunning a failed stage and cancelling a run | |
| Sharing an approval to the clipboard, a Teams channel, a Teams chat or email | |
| Desktop notifications for failed runs, watched runs and approvals | |
| `ADO · N failed · N approvals · N to review` on the status bar | |

## Requirements

- Orca 1.4.248 or later.
- For Azure CLI sign-in: Azure CLI 2.54 or later. Older versions don't return the numeric `expires_on` from `az account get-access-token`, which the plugin needs.

## Connecting an organisation

Open the Azure DevOps panel in the Orca sidebar, enter the organisation URL (`https://dev.azure.com/your-org`) and pick a method:

- **Azure CLI (no setup).** Works on macOS and Linux: the plugin runs `az login` in your browser, where you pick the account. On Windows, use a personal access token for now.
- **Personal access token.** Paste a PAT.

Each organisation is pinned to the account you sign in with. The panel shows `signed in as <account>`, and a token for a different account is refused.

### Where credentials live

- **Azure CLI:** the plugin uses its own private `az` profile in `~/.orca-azure-devops/az/<org>`, owner-only (mode 0700) on macOS and Linux. It never touches your terminal's `az` or `~/.azure`. Azure CLI keeps its tokens, refresh tokens included, in a plain file there. Sign out deletes the folder.
- **PAT:** stored in Orca's encrypted secrets for this plugin. Sign out deletes it. This needs an OS keyring for Orca's encrypted secrets, which may be unavailable on some Linux setups.
- **Teams webhook URLs:** stored in the same encrypted secrets, one per channel. The panel can't read a URL back, and it never goes into logs, settings or messages. Sign out doesn't remove channels; **Remove** in the channel manager does.

### PAT scopes

What exists so far is expected to work with:

- **Project and team: Read** (`vso.project`) for the project and team lists.
- **Work Items: Read & write** (`vso.work_write`) for the Work tab and board, moves, comments and links.
- **Code: Read** (`vso.code`) for pull request chips, the PRs tab and linking a pull request. Without it, chips are off for that organisation and the Work and PRs tabs say so.
- **Code: Read & write** (`vso.code_write`) for Approve all, Auto-complete all and adding reviewers.
- **Graph: Read** (`vso.graph`) and **Identity: Read** (`vso.identity`) for finding people to message, email or add as reviewers.
- **Build: Read & execute** (`vso.build_execute`) for the Pipelines tab and the run tab: runs, logs, rerun, cancel and approvals. Without Build access the tab says so and pauses for 10 minutes. Approvals may need a scope this list doesn't name yet. Without access to them the runs still load, and the tab says Needs me may be incomplete.

The identity check that pins your account hasn't been confirmed against a minimal PAT yet, and the Boards, pull request, people-search and Pipelines scopes haven't been checked live, so this list may change. More scopes will be listed here as features land.

## The Work tab

Open the Azure DevOps panel and choose **Work**. It needs a boards project and team for the organisation (see its settings).

- **My work** lists the items assigned to you, grouped by board column. Finished items are left out. Items of a type the board doesn't show, and items of a board type that aren't in a board column, are grouped under **Other** and move by state.
- Each card shows chips for its linked pull requests, one per target branch: the branch with `✓` when merged, `● build` while a build runs, `✗ build` when it failed, and `abandoned`. When several pull requests target the same branch, the chip shows the merged one, else an open one (a failed build first, then a running one), else an abandoned one. A card shows up to four chips and counts the rest; the board and the details show them all.
- **Move to** on a card moves the item to another column. Moving into a split column puts the item in Doing. A move is refused when someone else changed the item first: the item is refreshed and you try again.
- **Details** shows the description, acceptance criteria, comments, parent and links, with each linked pull request's state. You can add a comment, link a pull request by its URL, start a workspace or an agent, or open the item in Azure DevOps.
- **Open board** (the icon in the header) opens the full-tab board.

### Suggest moves

Off until you add rules. In the organisation's settings, open **Suggest moves** and add rules that pair a branch with a column. When a pull request linked to an item merges into that branch, and the column is further along than the item's, the Work tab offers to move the item there (`Move to <column>`) or dismiss the suggestion. Rules are saved per team.

## The board

The board opens in its own tab as a custom editor for `.adoboard` files.

- Drag a card to another column or lane to move it. The card shows in its new place while the move is sent, and returns with a message if Azure DevOps refuses it.
- Swimlanes collapse and expand. When a board has several lanes, all but the first start collapsed.
- **Me** and **Everyone** switch between your items and the whole team's. The **Parent** list filters to the children of one parent.
- It refreshes every 30 seconds while the tab is visible. When a refresh fails, the board keeps the last loaded items and says why, until a refresh succeeds.
- A board with more items than one answer holds (500 items, or 900 KiB) shows the most recently changed ones and says how many.

**Open board** in the Work tab writes `<workspace>/.orca-ado/<org>.<teamId>.adoboard` in your focused workspace and opens it. The `.orca-ado/` folder holds a `.gitignore` containing `*`, so git never sees it. This needs a local workspace. Without one, use **+ → Azure DevOps board**, which opens the editor and asks which board.

## Workspaces and agents

These use the workspace and agent permissions Orca asks you to approve.

- **Start a workspace** names the branch from your branch template and arms it. The next worktree you create in Orca within 10 minutes gets that branch and name, once. The new workspace is linked to the item. **Cancel** in the message disarms it, so the next worktree is created as you set it up.
- **Start an agent** launches your default agent in the item's workspace, or in the focused workspace when the item has none. The prompt is the item's link, description and acceptance criteria.
- With **Add work item context to agent prompts** on, the first prompt Orca sends to an agent in a linked workspace (a launch prompt, a task or an orchestration dispatch) starts with a link to the item. Prompts you type are never changed, and later prompts in the same terminal are left alone.

## The PRs tab

Open the Azure DevOps panel and choose **PRs**. It lists the pull requests you created in the organisation's code projects, grouped into release sets, and the ones waiting for your review.

### Release sets

A release set is a group of your pull requests that ship together. Pull requests share a set when they:

- have the same source branch in the same repository, or
- are linked to the same work item.

The links chain: if one pull request shares a branch with a second, and the second shares a work item with a third, all three are one set. A set holds your active pull requests and the ones you completed in the last 14 days, shown as `merged ✓`. A set with no active pull request left disappears. Its title is the title of its lowest-numbered pull request, and the newest sets come first. Without enough access to read linked work items, sets form by source branch only and the tab says so.

Each row shows `Pull Request N` as a link, its target branch and chips:

- `draft`, `conflicts` and `merged ✓`.
- Build: `● build` while running, `✓ build`, `✗ build`.
- Policies: `✗ policies`, and `· policies` while some are pending.
- Votes: `N approved`, `N rejected`, `N waiting for author` for reviewers who voted Waiting for author, and `waiting for …` for required reviewers who haven't voted or declined.
- `auto-complete` when it is set.

The tab shows the 30 newest sets and up to 150 rows, and says when it leaves some out. **Refresh** (the icon in the header) reloads now.

### Approve all

**Approve all** votes Approved, as you, on every active pull request in the set. It skips completed, abandoned and draft pull requests, and ones you have already approved. Any other vote of yours on the rest (waiting for the author, rejected, approved with suggestions) is replaced.

Each row reports its own result. When Azure DevOps refuses one, the others still go through and that row shows the error.

### Auto-complete all

**Auto-complete all** sets auto-complete, as you, on every active pull request in the set. It uses the three auto-complete settings (merge type, delete the source branch, complete linked work items) and never bypasses policies. It skips completed, abandoned and draft pull requests, and leaves one that is already set to auto-complete as it is.

Pull requests in a set often share one source branch. With "delete the source branch" on, the first one to merge would delete the branch the others still need. So when another active pull request in the same repository uses the same source branch, auto-complete is set with the branch kept, and the row says which pull request also uses it.

- The plugin asks Azure DevOps for the active pull requests on the branch at that moment. If the check fails, it keeps the branch and says so.
- If another pull request is already set to delete the shared branch when it completes, the row warns you. Turn that off in Azure DevOps; the plugin doesn't change it.

### To review

Below the sets, a collapsed **To review (N)** list shows the active pull requests waiting for you. You are named as a reviewer yourself and haven't voted or declined, you didn't create it and it isn't a draft. A pull request that reaches you only through a group isn't listed or counted. Click a row to open it in Azure DevOps. The count shows on the status bar (see The status bar).

## Sharing

**Share…** on a release set opens the composer. Tick the pull requests to share (the active ones start ticked; up to 50), add an optional intro (up to 2,000 characters), check the preview, tick where it goes and press **Share**. Your choices are remembered for each organisation, people included. Each destination reports its own result.

### The message

The message has one line per pull request, built from the `shareTemplate` setting. The default is `[Pull Request {id}]({url}): {title}`, which gives "Pull Request 1234: Add retry to the sync job", where only "Pull Request 1234" is a link.

- Placeholders: `{id}`, `{title}`, `{url}`, `{repo}`, `{project}`, `{source}`, `{target}` and `{author}`.
- `[text]({url})` makes the link. A template can have one link, its text can't be empty, and its address must be http or https.
- A line break inside a value becomes a space.
- A title is always plain text. It can't add a link or markup, whatever it contains.
- An empty or invalid template falls back to the default, and the composer says why.
- The in-panel preview is drawn by Orca's Markdown view, which may make a bare URL in a title clickable. The copied text, the channel post and the chat message are not affected.

### Destinations

**Copy as rich text** puts the message on the clipboard as HTML, so pasting into Teams, Outlook or Slack gives a link. If copying fails, the result shows the plain text to copy by hand.

| OS | How it copies | Status |
| --- | --- | --- |
| macOS | `osascript` puts HTML and plain text on the clipboard | The write was checked offline against a private clipboard. Pasting into Teams, Outlook and Slack is still to be checked. |
| Windows | PowerShell puts HTML and plain text on the clipboard | Unverified. |
| Linux | `wl-copy` on Wayland or `xclip` on X11, HTML only, with no plain text alongside | Unverified. |

On Linux you need `wl-clipboard` (Wayland) or `xclip` (X11). A Wayland session needs `wl-clipboard`: an `xclip`-only Wayland session can't copy rich text. Orca starts the plugin's worker without a display, so the plugin looks for one by convention: the lowest-numbered `wayland-N` socket in `/run/user/<your uid>`, else X11 display `:0`. A session on another display may not be found.

**Post to a Teams channel** posts an Adaptive Card through the channel's Workflows webhook. It has one line per pull request, with "Pull Request N" as the link, the intro above it and a small "Shared by <you> from Orca" footer. Blank lines in the intro are dropped from the card. See below to set a channel up.

- The result says "Sent to <channel> (accepted)". That means the webhook answered with a success status. Teams doesn't confirm delivery, so check the channel.
- If Teams refuses the post, the result gives the HTTP status and says to replace the URL if the workflow changed. A 429 says Teams is throttling. No message includes the URL.
- A card over about 26 KB is refused with "Share fewer items".

**Message in Teams** opens a Teams chat link with the people and the message filled in. Whether it lands in the Teams app or a browser page is still to be checked.

- You pick people (not groups) with **Find people**. The link uses their sign-in addresses and adds your account's tenant when known.
- The message is plain text, with the link at the end of each line.
- A link over 2,000 characters isn't opened. The composer says so and suggests Copy.
- The link opens first, before anything is sent anywhere else. Orca asks before opening it; tick "Always allow" to skip that. If it wasn't opened, **Open Teams chat** tries again without posting anything twice.

**Add as reviewers** adds people or groups, each required or optional, to every ticked pull request. It adds them with no vote. Someone who is already a reviewer is skipped and the result says so, so their vote is never reset. Finding people needs Graph and Identity (Read) access.

### Setting up a Teams channel

1. In Teams, open the channel's ⋯ menu → **Workflows** → "Send webhook alerts to a channel". Finish the setup and copy the URL it gives you. Posts come from the Workflows bot.
2. In Orca, open the PRs tab and choose **Teams channels** (the settings icon in the header), or choose **Manage channels** in the composer.
3. Enter a channel name and paste the URL, then press **Add channel**. The URL must be https. Names are unique and up to 100 characters, and you can add up to 20 channels.
4. **Test** posts a test message. **Replace URL** swaps in a new webhook when the workflow changes. **Remove** asks you to confirm.

Channels are shared by all your organisations. Which ones you post to is remembered per organisation.

## The Pipelines tab

Open the Azure DevOps panel and choose **Pipelines**. It lists pipeline runs in the organisation's code projects, the same projects the PRs tab reads, and the approvals waiting on them. Runs that haven't finished come first, newest first. Finished runs follow, newest finish first. **Refresh** (the icon in the header) reloads now.

### Which runs show

For each code project the plugin reads:

- your runs from the last 7 days (the newest 50),
- the runs in progress, whoever started them (the newest 25),
- the pending approvals and the runs they belong to,
- the runs you are watching.

A run is yours when Azure DevOps names you as who it was requested for. The tab lists up to 30 runs for the filter you pick and says how many it leaves out. The plugin itself keeps the newest 100 runs and says when it trims.

### Filters

The filter you pick is remembered. The counts on **Needs me** and **Failed** are this organisation's share of the numbers on the status bar.

- **Mine:** your runs from the last 7 days.
- **Running:** every run that hasn't finished, whoever started it: queued, running, waiting for approval or cancelling.
- **Needs me:** runs with a pending approval you can give, and your own runs while they wait for an approval.
- **Failed:** your runs that failed in the last 24 hours. A run leaves this list when a newer run of the same pipeline and branch is queued, in progress or has succeeded (even with issues).

### A run card

Each card shows the pipeline, the run number, the branch, `PR N` when a pull request started it, and who requested it. A badge gives its state: queued, running, waiting for approval, cancelling, succeeded, partially succeeded, failed or canceled. It also says when the run was queued, started or finished.

- **Open run** opens the run tab (see The run tab).
- **Open in Azure DevOps** opens the run on the website.
- **Watch** (the bell) is described next.

The stage bar has one segment per stage, coloured by its state, and a line below it with the stage names: `Build ✓ · Image ✓ · Deploy production ⏸`. The marks are ✓ succeeded, ✗ failed, ● running, ⏸ waiting for approval, ! succeeded with issues, ⊘ canceled, – skipped and ○ not started. Up to 12 stages show, then `+N more`.

The stages come from each run's timeline. A load reads them for up to 8 runs in progress and up to 8 finished runs it hasn't read yet, and keeps what it read, so a long list fills in over the next loads. Until then a run has no bar.

### Watching a run

**Watch** works on a run that hasn't finished. A watched run is read every 30 seconds, and you get a notification when it finishes, whoever started it. Watching ends by itself at the finish. You can watch up to 20 runs per organisation, and the list is kept when Orca restarts.

### Approvals

A run waiting at an environment check shows a **Waiting for approval** box. It says where the run waits (the environment, else the stage), how long it has waited, and who can approve. People are listed by name and groups as `(group)`, with `· needs N` when more than one approval is required. Instructions the approval carries show too, cut at 500 characters.

**Approve…** and **Reject…** show only when Azure DevOps says you can decide: you hold the approval permission, or the approval is assigned to you. Pressing one opens an optional comment (up to 1,000 characters). A second press on **Approve** or **Reject** sends it. The plugin never decides for you.

- It reads the approval again just before sending. If it is no longer pending, the result says so and nothing is sent.
- It sends one request and never retries.
- When the approval needs more people, the result says how many: "Approved. It still needs 1 more approval."
- When Azure DevOps refuses, the result shows its message.

### Share for approval

**Share for approval** opens the composer with one line for that approval. Add an intro, check the preview and tick where it goes. Each destination reports its own result. Destinations and people are remembered per organisation, apart from the ones you use for pull requests.

- **Copy as rich text**, **Post to a Teams channel** and **Message in Teams** work as described under Sharing, with the same channels. **Teams channels** in the tab's header manages them.
- **Email** opens a draft in your mail app. The subject is `Approval needed: <pipeline> <run>` and the body is the message. Pick people with **Find people to email**. A link over 2,000 characters isn't opened, and the composer suggests Copy.
- The approvers who are people, apart from you, show as suggestions in both people lists. Groups aren't suggested.
- Orca opens one link per press. With Teams chat and email both chosen, the chat opens first and **Open email** opens the draft.
- There is no **Add as reviewers** for approvals.

The message has one line, built from the `approvalShareTemplate` setting. The default is `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`.

- Placeholders: `{pipeline}`, `{run}`, `{url}`, `{environment}`, `{stage}`, `{branch}`, `{requestedBy}` and `{project}`. `{url}` is the run's address in Azure DevOps.
- `{environment}` falls back to the stage name when the environment couldn't be read.
- The rules under Sharing apply: one link, its text can't be empty, its address must be http or https, a line break in a value becomes a space, and an empty or invalid template falls back to the default.

## The run tab

**Open run** opens the run in its own tab, a custom editor for `.adorun` files.

It writes `<workspace>/.orca-ado/<org>.<buildId>.adorun` in your focused workspace and opens it. The file holds only the organisation, the project and the run id. The `.orca-ado/` folder is the one the board uses, and its `.gitignore` containing `*` keeps git out. Opening a run also deletes `.adorun` files there that haven't been opened for 7 days. This needs a local workspace. Without one, the button says so.

### What the tab shows

- A strip of the run's stages, each with its state and duration. The tab starts on the failed stage, else the one that is running or waiting, else the last one. It stays on the stage you click.
- The jobs and steps of that stage, each with its duration and its error and warning counts.
- The log of the selected step, with an **Errors** box above it when a step failed.
- A toolbar with the state, **Watch**, **Rerun failed stage**, **Cancel run** and **Open in Azure DevOps**.
- For a stage waiting for approval, the approvers, the waiting time and **Approve…** and **Reject…** work as in the Pipelines tab. To ask someone, use **Share for approval** there.

The tab refreshes every 5 seconds while the run is active and every minute once it has finished. When a refresh fails, it keeps what it has and says why. When the run no longer exists, or you can't see it, it says so and stops refreshing.

### The log

- A step's log shows when Azure DevOps publishes it, which may be only after the step ends. Until then the step says so.
- The tab reads a log only for the step you select, and reads it again when it has grown. The first read is the newest 1,000 lines. **Follow** keeps the view at the end and turns off when you scroll up. **Load earlier** reads 1,000 older lines.
- If a log grows by more than 1,000 lines between reads while you follow, the view jumps to the newest 1,000 lines.
- The tab holds up to 50,000 lines of a log and cuts lines over 2,000 characters with `…`.
- Colour codes show as colour. Other terminal codes are dropped, and log text is never read as markup. A line's timestamp shows as its tooltip.
- **Search the log** looks through the lines the tab holds. Enter goes to the next match and Shift+Enter to the previous one. It ignores case unless your query has a capital letter.
- **Errors only** keeps the error lines: `##[error]`, an `error:` or `error CS1234:` style prefix, `FAILED` and `fatal:`. They are found by these patterns, never by tool or stage name.

### Errors and Open in Orca

When a step failed, the **Errors** box lists the errors Azure DevOps recorded for it and up to 20 error lines from its log, once that log is loaded. The step's path selects it.

- **Jump to line** scrolls the log to that line.
- **Open in Orca** opens the file an error names. It shows when the message holds a file: `path(12,5): error …`, `path:12:5` or a Python `File "path", line 12`.

Open in Orca looks for the file in your local workspaces. It picks the ones whose git remote is the run's Azure Repos repository, preferring one on the run's branch, then the focused one. For a run from another kind of repository it uses the focused local workspace. Agent paths carry the agent's folders, so the plugin tries the path with its leading folders dropped one at a time, longest first, and opens the first file that exists.

- Nothing outside the workspace opens. A path with `..` is refused. An absolute path is tried only as a path inside the workspace, and a symlink that points out of it isn't followed. When nothing matches, the message says the file wasn't found.
- Orca opens the file without a line number. The tab shows what it opened: `Opened src/Api/Program.cs, line 12.`
- Workspaces on a remote host are skipped.

### Rerun and cancel

- **Rerun failed stage** shows for a finished run with a failed or canceled stage. It reruns the selected stage when that one qualifies, else the first that does. It asks Azure DevOps to retry the stage, without forcing every job to run again. A run with no stages, whose jobs sit under **All jobs**, can't be rerun here.
- **Cancel run** shows while the run hasn't finished and isn't already cancelling. It takes two presses: **Cancel run**, then **Confirm cancel**. The button disarms when it loses focus.
- Both read the run first and report what Azure DevOps did, and neither retries.

## Notifications

The plugin shows desktop notifications through Orca whenever Orca is open, with the Pipelines tab hidden too. The background poll runs every 5 minutes, so one can arrive a few minutes late.

It notifies when:

- one of your runs fails: `<pipeline> failed`, with the organisation, run number, branch and, when it is known, the stage that failed (`notifyRunFailures`);
- a run waits for an approval that you can give, or one of your own runs waits for an approval: `<pipeline> is waiting for approval`, with where it waits and `You can approve it.` when you can (`notifyApprovals`);
- a run you watch finishes, whether it succeeded, finished with warnings, was canceled or failed (`notifyWatchedRuns`).

Each kind has a setting, on by default. See Settings.

- One notification per finish and per approval. When you rerun a stage and the run fails again, it notifies again.
- Nothing for your runs that failed, or approvals that started waiting, before the plugin started. A watched run that finished while Orca was closed does notify, once, when the plugin next runs.
- At most 3 per poll, then one more, `N more pipeline updates`, for the rest.
- Orca gives the plugin no click event, so a click is expected to open nothing (not yet checked on macOS). The text says where to look: the Pipelines tab.

The plugin needs the `notifications:show` permission to show them. Orca asks you to approve it once, when the plugin first loads with it. Until you do, nothing shows. The plugin logs "Couldn't show a desktop notification." and doesn't retry.

## The status bar

The status bar item reads `ADO · N failed · N approvals · N to review`. Each part shows only when it isn't zero, so with nothing to report it reads `ADO`.

- `N failed` is the **Failed** filter's count.
- `N approvals` is the **Needs me** count, and reads `1 approval` for one.
- `N to review` is the pull requests waiting for your review, as in To review.

Each number adds up your connected organisations. The tooltip and **Azure DevOps: Connection status** break them down by organisation. The pipeline counts refresh with the Pipelines polling below.

## Polling

- My work: every 60 seconds while the Work tab is visible, every 5 minutes otherwise.
- An open board: every 30 seconds while visible.
- PR chip status: cached for 2 minutes, or an hour once the pull request is merged or abandoned.
- PRs tab: every 60 seconds while it is visible (your active and recently completed pull requests and your To review list, for each code project), every 5 minutes otherwise (the To review list only, for the status bar). Opening the tab shows data under a minute old without asking again.
- PRs tab caches: completed pull requests for 5 minutes, linked work items for 10 minutes (an hour once completed), build and policy status for 2 minutes, the code project list for an hour.
- PRs tab limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read pull requests, PR loads for that organisation pause for 10 minutes.
- Pipelines tab: every 30 seconds while it is visible. For each code project it reads your runs from the last 7 days, the runs in progress and the pending approvals, plus the runs you watch and the runs approvals wait on. It reads stages for up to 8 runs in progress and up to 8 finished runs it hasn't read yet per load, keeps the stages of the last 100 finished runs it read, and reads an approval's environment once. Opening the tab shows data under 30 seconds old without asking again.
- Pipelines in the background: every 5 minutes, your runs and the pending approvals only. There is no running list and no stage bar. This feeds the status bar and the notifications.
- Watched runs: every 30 seconds while one hasn't finished.
- An open run tab: every 5 seconds while the run is active and every minute once it has finished. A refresh reads the run and its timeline, its list of logs while a step runs, and the approval while a stage waits. Log lines are read only for the step you have selected, when its log has grown.
- Slow-down: when Azure DevOps answers with `Retry-After` or `X-RateLimit-Delay`, that organisation drops to the background pace for 5 minutes. The Pipelines tab then polls every 5 minutes, watched runs every 2 minutes and an open run tab every 30 seconds.
- Pipelines limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read builds, runs for that organisation pause for 10 minutes and the tab says why. When it refuses approvals only, approvals turn off for 10 minutes while runs keep loading, and the tab says Needs me may be incomplete.
- When Azure DevOps rate-limits the plugin, polling pauses and the last data stays on screen.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.
- `defaultAgent` (Default agent): the agent **Start an agent** launches, such as `claude` or `codex`. Defaults to `claude`.
- `agentContext` (Add work item context to agent prompts): off by default.
- `branchTemplate` (Branch name template): defaults to `feature/{id}-{slug}`. `{id}` is the work item id. `{slug}` is its title in lower case, with other characters turned into hyphens, cut to 40 characters.
- `autoCompleteMergeStrategy` (Auto-complete merge type): how **Auto-complete all** merges. One of Merge (no fast-forward), Squash commit, Rebase and fast-forward, or Semi-linear merge. Defaults to Merge (no fast-forward).
- `autoCompleteDeleteSourceBranch` (Auto-complete: delete the source branch): off by default. A branch that another active pull request still uses is kept either way.
- `autoCompleteTransitionWorkItems` (Auto-complete: complete linked work items): off by default.
- `shareTemplate` (Pull request share line): one line per pull request in a share. Defaults to `[Pull Request {id}]({url}): {title}`. See Sharing for the placeholders.
- `notifyRunFailures` (Notify when my pipeline runs fail): on by default.
- `notifyApprovals` (Notify when a run waits for approval): on by default. It covers approvals you can give and approvals on your own runs.
- `notifyWatchedRuns` (Notify when a watched run finishes): on by default.
- `approvalShareTemplate` (Approval share line): one line per approval in a share. Defaults to `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`. See The Pipelines tab for the placeholders.

## Development

```bash
npm install
npm run typecheck
orca plugin test .
orca plugin check .
orca plugin validate .
```

`npm run typecheck` writes Orca's plugin typings into `.orca/types/`, downloading them from the matching Orca release tag when the installed Orca doesn't ship them, then runs `tsc`.

To load the plugin for development, run `orca plugin dev watch .`. Orca asks for your approval first.

### Live checks still pending

The tests use fixtures and fakes. These haven't been checked against a real organisation, Teams or Orca's own interface yet.

Boards:

- The board opens as an editor and `git status` stays clean.
- Dragging a card moves it, and a split column writes Doing and Done correctly.
- The workspace hook names the branch, and **Start an agent** launches your default agent with its prompt.

Pull requests and sharing:

- Three pull requests from one branch form one set. Approve all and Auto-complete all work, the branch is kept, the merge type applies, and a "limit merge types" policy shows its message on its row.
- The pull request list returns `autoCompleteSetBy` and `completionOptions`, which is how a pull request that will delete a shared branch is spotted.
- Copy as rich text pasted into Teams desktop, Outlook and Slack makes only "Pull Request N" a link. This includes the macOS write to the real clipboard and the Windows and Linux routes.
- A Workflows webhook posts a card whose links open the pull request, Test and Replace work, and the intro's line breaks show on the card.
- The Teams chat link: desktop app or browser, prefilled line breaks, `tenantId` picking the right account, a two-person group chat, the real length limit, and how often Orca asks before opening it.
- Adding reviewers (a person and a group, required and optional) notifies them and leaves an existing reviewer's vote untouched.
- On the client organisation, read-only: `X-RateLimit-*` headroom after a refresh, whether `reviewerId` returns pull requests assigned to your groups, and whether the organisation-wide repository list works.
- The PRs tab and composer at 360 px in both themes, Orca's To review fold and the first press of Share and Open Teams chat.
- The Markdown preview of a title that holds a bare URL.

Pipelines and notifications:

- A multi-stage sandbox run: the Pipelines tab and the run tab follow its stages and steps live. Whether a running step's log grows before the step ends, whether `startLine` counts from 1 and `endLine` is inclusive, how `changeId` behaves and whether an unchanged timeline answers `204`, what a queued run's timeline and logs return, and whether a log's first line carries a byte order mark.
- A failing Docker-style step and a failing Helm-style step: Errors only and the error summary find their lines, **Jump to line** works, and **Open in Orca** opens a file in a local workspace. This includes agent paths such as `/home/vsts/work/1/s/…` and `D:\a\1\s\…`, and whether the workspace's branch name matches the run's.
- Rerun the failed stage, including the one implicit stage of a pipeline without stages and whether a retry replaces the stage's records, then cancel a run.
- An environment approval: Needs me, the approvers and waiting time, the environment name, Approve and Reject with a comment, and a two-approver check. Also what Azure DevOps answers when the requester approves their own run, the `permissions` value for a group-assigned approver, that `$expand=steps,permissions` is accepted, and that an approval's `pipeline.owner.id` is the run id and its Checkpoint records match.
- Share for approval to a Teams chat, the test channel, email and Copy. For email: whether `mailto:` opens in the default mail app, how Orca's consent prompt treats it, and whether an `@` encoded as `%40` survives in the address.
- Notifications for a failure, a watched run and an approval on macOS, with Orca in front and behind, and what a click does.
- On the client organisation, read-only: `X-RateLimit-*` and `Retry-After` headroom with the Pipelines tab and a run tab open for 10 minutes, whether `requestedFor` carries an id, who it names on a run started by pull request auto-complete, and the `triggerInfo` of one real pull request validation run and one CI run.
- Which scopes runs, approvals, environment names and the project list need with a partial PAT, and whether a refusal gives the right message.
- The Pipelines tab at 360 px and the run tab in both themes, a run tab whose file was pruned, and `ADO · N failed · N approvals · N to review` on the status bar.

## License

[MIT](LICENSE)
