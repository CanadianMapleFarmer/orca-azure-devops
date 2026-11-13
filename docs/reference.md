# Notifications, polling, settings and permissions

[Back to the README](../README.md)

## Notifications

The plugin shows desktop notifications through Orca whenever Orca is open, with the Pipelines and PRs tabs hidden too. The background poll runs every 5 minutes, and a quiet pull request's comments are read every 10, so one can arrive several minutes late, and later still while Azure DevOps asks the plugin to slow down.

It notifies when:

- one of your runs fails: `<pipeline> failed`, with the organisation, run number, branch and, when it is known, the stage that failed (`notifyRunFailures`);
- a run waits for an approval that you can give, or one of your own runs waits for an approval: `<pipeline> is waiting for approval`, with where it waits and `You can approve it.` when you can (`notifyApprovals`);
- a run you watch finishes, whether it succeeded, finished with warnings, was canceled or failed (`notifyWatchedRuns`);
- someone asks for your review: `Review requested: Pull Request N`, with its title, author and repository, when a pull request newly appears in your To review list (`notifyReviewRequests`);
- someone else comments on one of your 20 newest active pull requests in an organisation: `New comment on Pull Request N`, with who wrote it and its first line as plain text (`notifyPrComments`). Several new comments on one thread make one notification, `<count> new comments on Pull Request N`, naming the latest. Your own comments, Azure DevOps's system comments (votes, policy updates) and deleted comments never count.

Each kind has a setting, on by default. See Settings.

- One notification per finish and per approval. When you rerun a stage and the run fails again, it notifies again.
- One notification per review request and per comment. A pull request that leaves To review and comes back doesn't notify again until the plugin restarts.
- Nothing for your runs that failed, or approvals that started waiting, before the plugin started. A watched run that finished while Orca was closed does notify, once, when the plugin next runs.
- The first load of an organisation after the plugin starts never notifies about pull requests: it only notes what is already waiting for your review and the comments already written. The same goes for the first load after you sign in or reconnect, the first read of a pull request's comments, and the first read after you turn `notifyPrComments` back on. A connection error that clears by itself, such as a sign-in renewal that runs before the network is back after sleep, and a pull request whose comments could not be read both keep what was noted, so what arrived meanwhile still notifies.
- At most 3 per poll, then one more, `N more pipeline updates` or `N more pull request updates`, for the rest.
- Orca gives the plugin no click event, so a click is expected to open nothing (not yet checked on macOS). The text says where to look: the Pipelines tab or the PRs tab.

The plugin needs the `notifications:show` permission to show them. Orca asks you to approve it once, when the plugin first loads with it. Until you do, nothing shows. The plugin logs "Couldn't show a desktop notification." and doesn't retry.

## The status bar

The status bar item reads `ADO · N failed · N approvals · N to review`. Each part shows only when it isn't zero, so with nothing to report it reads `ADO`.

- `N failed` is the **Failed** filter's count.
- `N approvals` is the **Needs me** count, and reads `1 approval` for one.
- `N to review` is the pull requests waiting for your review, as in To review.

Each number adds up your connected organisations. The tooltip and **Azure DevOps: Connection status** break them down by organisation. The pipeline counts refresh with the Pipelines polling below.

**Connection status** also shows, for each organisation with traffic in the last 5 minutes:

- the requests, by feature (`work`, `board`, `prs`, `pipelines`, `run` and so on);
- the three busiest endpoints, with ids shown as `{id}` and team names as `{team}`;
- the rate-limit state: the pressure level, how much of the limit is left when Azure DevOps says, how much polling has slowed, and how long ago the last rate-limit headers came;
- how many requests were throttled or delayed and the sum of `X-RateLimit-Cost`, when there was any;
- the endpoints that answered with an `ETag`, when any did.

```
contoso — connected as dev@contoso.com
  Requests, last 5 min: 41 (board 18, work 9, prs 8, pipelines 6)
  Busiest: POST /{team}/_apis/wit/wiql 14 · GET /_apis/git/pullrequests 7 · POST /_apis/wit/workitemsbatch 5
  Rate limit: near, 152 of 200 TSTU left, polling ×2 (headers 40 s ago)
  ETag seen: GET /_apis/wiki/wikis/{id}/pages
```

## Polling

- My work: every 60 seconds while the Work tab is visible, slowing to every 2 minutes while nothing changes, and not at all while it is hidden. Each poll asks Azure DevOps only for what changed since the last one, and rechecks everything every 15 minutes and when you press Refresh. It also reads, when they changed, the parents of your tasks and the child tasks of your items and of those parents. Coming back to the tab shows the last data at once and refreshes it if it is over a minute old.
- An open board: every 30 seconds while visible, slowing to every minute while nothing changes, and asking only for what changed. A hidden board stops polling and keeps its cards. Coming back shows them at once and refreshes them if they are over 30 seconds old. Up to 4 boards per organisation are kept this way.
- Item details: never polled. They are read when you open an item on the board or in the sidebar, and on Refresh. The details are reused for 5 minutes while the item is unchanged, and its comments for 2 minutes. The board, the sidebar and Start a workspace and agent share one copy, kept in memory only. An open board's panel reads its item again only when the board's own poll shows the item changed. Your team's people are read when you open **Assigned to**, and reused for an hour.
- PR chip status: a merged or abandoned pull request is final and isn't read again. Open pull requests are checked with one list per project every 2 minutes. Build and policy status is re-read after a push to the pull request or a change of reviewer or vote, every 2 minutes while a build runs, and otherwise every 30 minutes, for at most 8 pull requests per load, oldest first.
- PRs tab: every 60 seconds while it is visible, slowing to every 2 minutes while nothing changes (your active and recently completed pull requests and your To review list, for each code project). A project where none of your pull requests or review requests turned up in the last day is listed only every 3 to 5 minutes, and its last lists are kept in between, so something new there can take up to 5 minutes to show. Every 5 minutes otherwise, reading every project (the To review list, for the status bar and review notifications). Opening the tab shows the last data at once and refreshes it if it is over a minute old. Refresh reads every project.
- Comment notifications: with `notifyPrComments` on, the PRs polls also read the comment threads of your 20 newest active pull requests in the organisation. Each pull request's threads are re-read every 2 minutes, slowing to every 10 while nothing changes, and back to every 2 once something new arrives. The list of your active pull requests comes from the PRs tab while its last load is under 10 minutes old. Otherwise the poll lists them, one request per code project. With it off, the plugin reads no threads for notifications and makes no such list.
- PRs tab caches: completed pull requests for 5 minutes, linked work items for 10 minutes (an hour once completed), build and policy status as for the chips above, the code project list for an hour. The PRs tab and the chips share one copy of each pull request and its status.
- The repository list: one request lists every repository in the organisation, and is made at most once an hour. With **All projects with code** on, the code project list reads it, so **Clone from Azure DevOps…** usually costs nothing more. Otherwise only **Clone** reads it. When Azure DevOps answers 404 or 400, it isn't asked again for 10 minutes. The list is kept in memory only. The start section's picker and **Change repo** make no request.
- PRs tab limits: a load makes at most 4 requests at a time for an organisation, and so do comment reads. When Azure DevOps refuses to let the plugin read pull requests, PR loads for that organisation pause for 10 minutes. When it refuses every comment thread read in a poll, comment reads for that organisation pause for 10 minutes while PR loads and review notifications carry on. A pull request it refuses, can't find or can't read is skipped for that poll.
- Pipelines tab: every 30 seconds while it is visible, slowing to every 2 minutes while nothing moves. For each code project it reads your runs from the last 7 days, the runs in progress and the pending approvals, plus the runs you watch and the runs approvals wait on. A project where none of your runs, running runs or pending approvals turned up in the last day is listed only every 3 to 5 minutes, and its last lists are kept in between, so a run there can take up to 5 minutes to show. It reads stages for up to 8 runs in progress and up to 8 finished runs it hasn't read yet per load, asks only for the stages that changed, shares them with an open run tab, keeps the stages of the last 200 finished runs it read, and reads an approval's environment once. Opening the tab shows the last data at once and refreshes it if it is over 30 seconds old. Refresh reads every project.
- Pipelines in the background: every 5 minutes, your runs and the pending approvals only. There is no running list and no stage chips. This feeds the status bar and the notifications.
- Watched runs: every 30 seconds while the Pipelines tab is visible and every minute otherwise, while one hasn't finished. A run the Pipelines tab read in the last 30 seconds isn't read again. **Watch** itself always reads the run.
- An open run tab: every 5 seconds while a step runs, reading the timeline each time, the run every 20 seconds and its list of logs every 10 seconds or when the timeline moves. Every 30 seconds while the run is queued or waits for an approval, and every minute once it has finished. It slows down while nothing changes: to every 20 seconds while a step runs, every minute while the run waits and every 4 minutes once it has finished. A hidden run tab doesn't poll. A refresh also reads the approval while a stage waits. Log lines are read only for the step you have selected, when its log has grown.
- Reviews and the Wiki tab: never in the background (comment notifications read threads on their own, as above). A review is read when you open it, after you vote, comment, reply or resolve, and on Refresh. The Wiki tab reads the wiki list when it opens and keeps it for 10 minutes, a folder when you expand it, a page when you open it, again on Refresh, again when you press Open in tab and again when a Publish of it succeeds while it is open, and search when you press Enter. It reads the drafts when it opens.
- Slow-down: when Azure DevOps signals rate-limit pressure for an organisation, all of its polling slows by ×2, ×4 or ×8 depending on how close it is: ×2 once it sends `X-RateLimit-Limit` or `X-RateLimit-Remaining`, ×4 when a quarter of the limit or less is left, and ×8 after an `X-RateLimit-Delay`. After a 429 or a `Retry-After`, nothing polls until the wait has passed (a minute for a 429 without `Retry-After`), then polling runs at ×8. Your own clicks, Refresh included, are never held back. Polling returns to normal 5 minutes after the last signal, and the last data stays on screen meanwhile.
- Pipelines limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read builds, runs for that organisation pause for 10 minutes and the tab says why. When it refuses approvals only, approvals turn off for 10 minutes while runs keep loading, and the tab says Needs me may be incomplete.

## Saved data

The plugin saves the last view of each tab, so that when Orca starts they show at once instead of empty.

- What is kept, for each organisation: the Work tab, up to 4 boards (the ones used most recently, each with its **Me** or **Everyone** choice), the PRs tab, the Pipelines tab, board settings, the code project list and the status of up to 600 pull requests, so merged and abandoned chips aren't read again.
- Where: Orca's plugin storage, at most 160 KiB per view and 1.5 MiB in all. Past that, the views used least recently are deleted first. Each view is written at most once a minute and only when it changed; one that only grew older is rewritten every 15 minutes. When the plugin stops, it spends up to 1.5 seconds writing the views still waiting.
- Who sees it: only the account that saved it, while its organisation is connected. Saved data from another account is never shown, and an organisation whose sign-in expired shows none until you reconnect.
- How it shows: the Work, PRs and Pipelines tabs say `Showing what was saved last time. Refreshing…`, and a board says `Updated ‹time› · refreshing…`, until the first refresh replaces it. Approving, sharing and watching never act on saved data: they read Azure DevOps first. Saved data never sends a notification or changes the status bar counts.
- When it is deleted: when you sign out of the organisation or remove it. A plugin update that changes what is saved discards the old copies.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.
- `defaultAgent` (Default agent): the agent **Start a workspace and agent** and **Start an agent** run, such as `claude` or `codex`. Defaults to `claude`. Letters, digits, dots, dashes and underscores only, starting with a letter or digit.
- `agentContext` (Add work item context to agent prompts): off by default.
- `branchTemplate` (Branch name template): defaults to `feature/{id}-{slug}`. `{id}` is the work item id. `{slug}` is its title in lower case, with other characters turned into hyphens, cut to 40 characters.
- `cloneFolder` (Folder for new clones): where **Clone from Azure DevOps…** puts repositories, each in a folder named after it. Defaults to `~/orca/repos`, and empty means the default. `~` is your home folder. It must be a full path to a folder only you can change: yours, and not writable by your group or others, under folders that are yours or the system's and not writable by your group or others, unless shared like `/tmp`. Otherwise **Clone** says `"Folder for new clones" must be a full path, such as ~/orca/repos.` or `<folder> must be a folder only you can change. Check its owner and permissions, or change "Folder for new clones".`, and Start stays off. The plugin creates the folder at the first clone, and says `Couldn't create <folder>. Check "Folder for new clones".` when it can't. See [Clone from Azure DevOps](work.md#clone-from-azure-devops) for the other clone messages.
- `autoCompleteMergeStrategy` (Auto-complete merge type): how **Auto-complete** merges. One of Merge (no fast-forward), Squash commit, Rebase and fast-forward, or Semi-linear merge. Defaults to Merge (no fast-forward).
- `autoCompleteDeleteSourceBranch` (Auto-complete: delete the source branch): off by default. A branch that another active pull request still uses is kept either way.
- `autoCompleteTransitionWorkItems` (Auto-complete: complete linked work items): off by default.
- `shareTemplate` (Pull request share line): one line per pull request in a share. Defaults to `[Pull Request {id}]({url}): {title}`. See Sharing for the placeholders.
- `notifyRunFailures` (Notify when my pipeline runs fail): on by default.
- `notifyApprovals` (Notify when a run waits for approval): on by default. It covers approvals you can give and approvals on your own runs.
- `notifyWatchedRuns` (Notify when a watched run finishes): on by default.
- `notifyReviewRequests` (Notify when someone asks for my review): on by default.
- `notifyPrComments` (Notify about new comments on my pull requests): on by default. Off, the plugin reads no comment threads for notifications.
- `approvalShareTemplate` (Approval share line): one line per approval in a share. Defaults to `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`. See The Pipelines tab for the placeholders.
- `entraClientId` (Microsoft sign-in: app (client) ID): the app registration your admin created for Sign in with Microsoft. Empty by default. See Registering the app (for admins).
- `entraTenant` (Microsoft sign-in: tenant): a tenant ID or domain, used only when an organisation's tenant can't be found. Empty by default. Leave it empty for any work or school account.
- `httpsProxy` (HTTPS proxy): an `http://` or `https://` proxy address for the plugin's traffic, like `http://proxy.example.com:8080`. Proxies that need a password aren't supported. Empty by default. See Proxies and certificates.
- `caCertificatesFile` (Extra CA certificates file): the full path to a PEM file of certificates to trust, for networks that inspect TLS. Empty by default. A change reaches new connections only; connections already open keep the certificates they started with.
- `useSystemCertificates` (Trust the system's certificates): also trust the certificates your operating system trusts. Off by default. Like the certificates file, a change reaches new connections only.

## Permissions

Orca asks you to approve these when the plugin first loads. The plugin runs in a trusted worker, a separate Node.js process with your user account's access to the computer. `orca plugin inspect` lists the same grants.

- `storage:own`: the plugin's own storage keeps your connected organisations and their pinned accounts, the last view of each tab (see Saved data), each board's nudge rules, dismissed nudges and **Me** or **Everyone** choice, the runs you watch, your share choices and Teams channel names, the links between work items and workspaces, the repository you last chose for each team, or for each project when there is no team, and the list of wiki drafts.
- `secrets:own`: Orca's encrypted secrets keep personal access tokens, the Microsoft refresh token for each organisation and each Teams webhook URL (see [Where credentials live](connecting.md#where-credentials-live)).
- `settings:own`: reads the settings under Settings and notices when you change one.
- `workspace:read`: finds your focused workspace and lists your workspaces, for finding an item's workspace and the repositories in Orca to start one in, opening a board, a run, a wiki draft or a wiki page, Open in Orca, and finding the workspace that holds a pull request's repository in Check out in Orca.
- `workspace:write`: shows a workspace (Check out in Orca, Open workspace and Show it) and opens files in an editor tab: a board, a run, a wiki draft, the read-only copy of a wiki page, or a file a failing step names.
- `agent:read`: lets the plugin hear `agent.status.changed`. It reads nothing else about agents.
- `terminal:send`: Start a workspace and agent and Start an agent open a terminal titled `ADO #<id>` in a local workspace and run one `orca worktree create` or `orca agent launch` command in it. With **Clone from Azure DevOps…**, the same line first runs `git clone`, limited to HTTPS and SSH, and `orca repo add`, as you in your own terminal. The command reads the prompt, and for a clone the address, the folder and the repository, from files in `~/.orca-azure-devops/starts` that only you can read, and the plugin deletes them afterwards. The plugin types nothing else into a terminal and reads none.
- `notifications:show`: shows the desktop notifications for failed runs, watched runs, approvals, review requests and new comments on your pull requests (see Notifications).
- `workspace.create.before`: when Check out in Orca has armed a branch, gives the next worktree you create that branch and its base. Otherwise it changes nothing.
- `workspace.create.after`: links the workspace Start a workspace and agent created to its work item, and tells the details it is open.
- `agent.launch.before`: notes which workspace an agent launch belongs to, so Add work item context to agent prompts knows where its prompt came from.
- `agent.prompt.before`: with Add work item context to agent prompts on, starts the first prompt of an agent in a linked workspace with a link to the item. Prompts you type are never changed. It also notes the terminal whose launch prompt names an item the plugin just started an agent for, so the details can say when that agent works; it never changes that prompt.
- `agent.status.changed`: notes which workspace an agent that Orca reports belongs to, for the same purpose, and tells the details when the agent an item started is working.
