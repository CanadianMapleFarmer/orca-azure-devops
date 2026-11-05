# Azure DevOps for Orca

Azure DevOps boards, pull requests, pipelines and wikis inside [Orca](https://github.com/stablyai/orca) (see Status).

**Status: under construction.**

| Works now | Coming |
| --- | --- |
| Connecting any number of Azure DevOps organisations | Pipelines |
| Pinning each organisation to one account | PR reviews |
| Choosing each org's boards project, team and code projects | Wiki |
| An always-on worker and an `ADO` status bar item | |
| A Work tab with your items, grouped by board column | |
| A full-tab team board with drag-and-drop | |
| Starting a workspace or an agent from a work item | |
| A PRs tab with your pull requests in release sets, plus Approve all and Auto-complete all | |
| Sharing pull requests to the clipboard, a Teams channel, a Teams chat and reviewers | |
| `ADO · N to review` on the status bar | |

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
- **Graph: Read** (`vso.graph`) and **Identity: Read** (`vso.identity`) for finding people to message or add as reviewers.

The identity check that pins your account hasn't been confirmed against a minimal PAT yet, and the Boards, pull request and people-search scopes haven't been checked live, so this list may change. More scopes will be listed here as features land.

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

Below the sets, a collapsed **To review (N)** list shows the active pull requests waiting for you. You are named as a reviewer yourself and haven't voted or declined, you didn't create it and it isn't a draft. A pull request that reaches you only through a group isn't listed or counted. Click a row to open it in Azure DevOps.

### Status bar

The status bar item reads `ADO · N to review` when N pull requests wait for you across your connected organisations, and `ADO` when none do. N adds up the To review counts. The tooltip and **Azure DevOps: Connection status** break it down by organisation.

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

## Polling

- My work: every 60 seconds while the Work tab is visible, every 5 minutes otherwise.
- An open board: every 30 seconds while visible.
- PR chip status: cached for 2 minutes, or an hour once the pull request is merged or abandoned.
- PRs tab: every 60 seconds while it is visible (your active and recently completed pull requests and your To review list, for each code project), every 5 minutes otherwise (the To review list only, for the status bar). Opening the tab shows data under a minute old without asking again.
- PRs tab caches: completed pull requests for 5 minutes, linked work items for 10 minutes (an hour once completed), build and policy status for 2 minutes, the code project list for an hour.
- PRs tab limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read pull requests, PR loads for that organisation pause for 10 minutes.
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
- `ADO · N to review` on the status bar.
- The PRs tab and composer at 360 px in both themes, Orca's To review fold and the first press of Share and Open Teams chat.
- The Markdown preview of a title that holds a bare URL.

## License

[MIT](LICENSE)
