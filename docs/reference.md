# Notifications, polling, settings and permissions

[Back to the README](../README.md)

## Notifications

The plugin shows desktop notifications through Orca whenever Orca is open, with the Pipelines and PRs tabs hidden too. The background poll runs every 5 minutes, so one can arrive a few minutes late.

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

## Polling

- My work: every 60 seconds while the Work tab is visible, every 5 minutes otherwise. Each load also reads the parents of your tasks and the child tasks of your items and of those parents.
- An open board: every 30 seconds while visible.
- PR chip status: cached for 2 minutes, or an hour once the pull request is merged or abandoned.
- PRs tab: every 60 seconds while it is visible (your active and recently completed pull requests and your To review list, for each code project), every 5 minutes otherwise (the To review list, for the status bar and review notifications). Opening the tab shows data under a minute old without asking again.
- Comment notifications: with `notifyPrComments` on, each PRs poll also reads the comment threads of your 20 newest active pull requests in the organisation. While the tab is hidden, it first lists your active pull requests, one request per code project. With it off, the plugin reads no threads for notifications and makes no such list.
- PRs tab caches: completed pull requests for 5 minutes, linked work items for 10 minutes (an hour once completed), build and policy status for 2 minutes, the code project list for an hour.
- PRs tab limits: a load makes at most 4 requests at a time for an organisation, and so do comment reads. When Azure DevOps refuses to let the plugin read pull requests, PR loads for that organisation pause for 10 minutes. When it refuses every comment thread read in a poll, comment reads for that organisation pause for 10 minutes while PR loads and review notifications carry on. A pull request it refuses, can't find or can't read is skipped for that poll.
- Pipelines tab: every 30 seconds while it is visible. For each code project it reads your runs from the last 7 days, the runs in progress and the pending approvals, plus the runs you watch and the runs approvals wait on. It reads stages for up to 8 runs in progress and up to 8 finished runs it hasn't read yet per load, keeps the stages of the last 100 finished runs it read, and reads an approval's environment once. Opening the tab shows data under 30 seconds old without asking again.
- Pipelines in the background: every 5 minutes, your runs and the pending approvals only. There is no running list and no stage chips. This feeds the status bar and the notifications.
- Watched runs: every 30 seconds while one hasn't finished.
- An open run tab: every 5 seconds while the run is active and every minute once it has finished. A refresh reads the run and its timeline, its list of logs while a step runs, and the approval while a stage waits. Log lines are read only for the step you have selected, when its log has grown.
- Reviews and the Wiki tab: never in the background (comment notifications read threads on their own, as above). A review is read when you open it, after you vote, comment, reply or resolve, and on Refresh. The Wiki tab reads the wiki list when it opens and keeps it for 10 minutes, a folder when you expand it, a page when you open it, again on Refresh, again when you press Open in tab and again when a Publish of it succeeds while it is open, and search when you press Enter. It reads the drafts when it opens.
- Slow-down: when Azure DevOps answers any request for an organisation with `Retry-After` or `X-RateLimit-Delay`, whether for work items, pull requests or pipelines, that organisation's pipeline polling drops to the background pace for 5 minutes. The Pipelines tab then polls every 5 minutes, watched runs every 2 minutes and an open run tab every 30 seconds.
- Pipelines limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read builds, runs for that organisation pause for 10 minutes and the tab says why. When it refuses approvals only, approvals turn off for 10 minutes while runs keep loading, and the tab says Needs me may be incomplete.
- When Azure DevOps rate-limits the plugin, polling pauses and the last data stays on screen.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.
- `defaultAgent` (Default agent): the agent **Start an agent** launches, such as `claude` or `codex`. Defaults to `claude`.
- `agentContext` (Add work item context to agent prompts): off by default.
- `branchTemplate` (Branch name template): defaults to `feature/{id}-{slug}`. `{id}` is the work item id. `{slug}` is its title in lower case, with other characters turned into hyphens, cut to 40 characters.
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

- `storage:own`: the plugin's own storage keeps your connected organisations and their pinned accounts, each board's nudge rules and dismissed nudges, the runs you watch, your share choices and Teams channel names, the links between work items and workspaces, and the list of wiki drafts.
- `secrets:own`: Orca's encrypted secrets keep personal access tokens, the Microsoft refresh token for each organisation and each Teams webhook URL (see [Where credentials live](connecting.md#where-credentials-live)).
- `settings:own`: reads the settings under Settings and notices when you change one.
- `workspace:read`: finds your focused workspace and lists your workspaces, for Start an agent, opening a board, a run, a wiki draft or a wiki page, Open in Orca, and finding the workspace that holds a pull request's repository in Check out in Orca.
- `workspace:write`: shows a workspace (Check out in Orca) and opens files in an editor tab: a board, a run, a wiki draft, the read-only copy of a wiki page, or a file a failing step names.
- `agent:read`: lets the plugin hear `agent.status.changed`. It reads nothing else about agents.
- `agent:launch`: Start an agent launches your default agent in a workspace with the item's prompt.
- `notifications:show`: shows the desktop notifications for failed runs, watched runs, approvals, review requests and new comments on your pull requests (see Notifications).
- `workspace.create.before`: when Start a workspace or Check out in Orca has armed a branch, gives the next worktree you create that branch (and, for Check out in Orca, its base). Otherwise it changes nothing.
- `workspace.create.after`: links a workspace made by Start a workspace to its work item.
- `agent.launch.before`: notes which workspace an agent launch belongs to, so Add work item context to agent prompts knows where its prompt came from.
- `agent.prompt.before`: with Add work item context to agent prompts on, starts the first prompt of an agent in a linked workspace with a link to the item. Prompts you type are never changed.
- `agent.status.changed`: notes which workspace an agent that Orca reports belongs to, for the same purpose.
