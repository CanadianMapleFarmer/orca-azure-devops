# Pipelines and runs

[Back to the README](../README.md)

## The Pipelines tab

Open the Azure DevOps panel and choose **Pipelines**. It lists pipeline runs in the organisation's code projects, the same projects the PRs tab reads, and the approvals waiting on them. Runs that haven't finished come first, newest first. Finished runs follow, newest finish first.

The toolbar has two rows. The first has the pickers and the filters (see Filters). The second has `Updated …` in muted text on the left and four icon buttons on the right: **Collapse all**, **Expand all**, **Refresh** and **Teams channels**. **Refresh** reloads now.

### Projects and repositories

Runs are grouped like pull requests (see [The PRs tab](pull-requests.md#the-prs-tab)).

- Each project is a collapsible group. Its header line has the project's name and a count such as `4 runs`, and one hint sits under it: `1 needs you`, else `2 failed`, else `1 running`.
- A project whose runs all come from one repository stays flat, and its header names the repository: `Fabrikam · fabrikam-api · 4 runs`. A project with runs from more than one repository reads `Fabrikam · 2 repos · 4 runs` and has one sub-group for each. A run with no repository sits under the project, outside the sub-groups.
- A run belongs to one project, so there is no **Across projects** group here.
- The **Project** picker (**All projects** by default) and, when the chosen project has more than one repository, the **Repository** picker filter the list. They are remembered for each organisation, apart from the PRs tab's. A remembered project with no runs in the data falls back to **All projects**, hides nothing, and comes back when it has runs again.
- **Collapse all**, **Expand all** and each group's state are remembered for each organisation, as in the PRs tab.

### Which runs show

For each code project the plugin reads:

- your runs from the last 7 days (the newest 50),
- the runs in progress, whoever started them (the newest 25),
- the pending approvals and the runs they belong to,
- the runs you are watching.

A run is yours when Azure DevOps names you as who it was requested for. The tab lists up to 30 runs for the filter you pick and says how many it leaves out. The plugin itself keeps the newest 100 runs and says when it trims.

### Filters

The filter you pick is remembered. The four filters are one switch in the toolbar. The counts on **Needs me** and **Failed** are this organisation's share of the numbers on the status bar.

- **Mine:** your runs from the last 7 days.
- **Running:** every run that hasn't finished, whoever started it: queued, running, waiting for approval or cancelling.
- **Needs me:** runs with a pending approval you can give, and your own runs while they wait for an approval.
- **Failed:** your runs that failed in the last 24 hours. A run leaves this list when a newer run of the same pipeline and branch is queued, in progress or has succeeded (even with issues).

### A run card

A card has these rows:

- The state badge, the pipeline's name and, at the right, the run's age: when it finished, else when it started, else when it was queued. The badge reads `queued`, `running`, `waiting` (for an approval), `cancelling`, `✓ succeeded`, `! partial` (partially succeeded), `✕ failed` or `canceled`.
- A muted line with the run number, the branch (or `PR !N` when a pull request started it) and who requested it. The name is left out on **Mine**, because it's you.
- The stage chips.
- One warning line for each approval the run waits on, with that approval's buttons under it (see Approvals).
- A row of buttons.

The buttons:

- **Open run** opens the run tab (see The run tab).
- **Watch** (the bell icon) is described next.
- **Open in Azure DevOps** (an icon button) opens the run on the website.

**Share for approval** isn't in that row. While the run waits for an approval, it sits in the button row of the last approval, beside **Approve…** and **Reject…** when you can decide (see Share for approval).

The stage chips are one small chip for each stage, with its name and a mark: `Build ✓`, `Image ✓`, `Deploy production ⏸`. A chip's colour follows the stage's state. The marks are ✓ succeeded, ✗ failed, ● running, ⏸ waiting for approval, ! succeeded with issues, ⊘ canceled, – skipped and ○ not started. Up to 12 stages show.

The stages come from each run's timeline. A load reads them for up to 8 runs in progress and up to 8 finished runs it hasn't read yet, and keeps what it read, so a long list fills in over the next loads. Until then a run has no chips.

### Watching a run

**Watch** works on a run that hasn't finished. A watched run is read every 30 seconds while the Pipelines tab is visible and every minute otherwise, and you get a notification when it finishes, whoever started it. Watching ends by itself at the finish. You can watch up to 20 runs per organisation, and the list is kept when Orca restarts.

### Approvals

A run waiting at an environment check shows one warning line for each approval. It says where the run waits (the environment, else the stage), who can approve and how long it has waited: `Production needs Release Approvers (group) · waiting 4d`. People are listed by name and groups as `(group)`, with `needs 2 of …` when more than one approval is required.

**Approve…** and **Reject…** show only when Azure DevOps says you can decide: you hold the approval permission, or the approval is assigned to you. Then the instructions the approval carries show too, cut at 500 characters. Pressing one opens an optional comment (up to 1,000 characters). A second press on **Approve** or **Reject** sends it. The plugin never decides for you.

- It reads the approval again just before sending. If it is no longer pending, the result says so and nothing is sent.
- It sends one request and never retries.
- When the approval needs more people, the result says how many: "Approved. It still needs 1 more approval."
- When Azure DevOps refuses, the result shows its message.

### Share for approval

**Share for approval** opens the composer with one line for each approval the run waits on, all ticked. Add an intro, check the preview, untick any line you don't want and tick where it goes. Each destination reports its own result. Destinations and people are remembered per organisation, apart from the ones you use for pull requests.

- **Copy as rich text**, **Post to a Teams channel** and **Message in Teams** work as described under Sharing, with the same channels. **Teams channels** in the tab's toolbar manages them.
- **Email** opens a draft in your mail app. The subject is `Approval needed: <pipeline> <run>` and the body is the message. Pick people with **Find people to email**. A link over 2,000 characters isn't opened, and the composer suggests Copy.
- The approvers who are people, apart from you, show as suggestions in both people lists. Groups aren't suggested, and neither is anyone Azure DevOps lists without a sign-in name, since a link can't reach them.
- Orca opens one link per press. With Teams chat and email both chosen, the chat opens first and **Open email** opens the draft.
- There is no **Add as reviewers** for approvals.

The message has one line for each approval, built from the `approvalShareTemplate` setting. The default is `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`.

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

The tab refreshes every 5 seconds while a step runs, every 30 seconds while the run is queued or waits for an approval, and every minute once it has finished, and slows down while nothing changes (see [Polling](reference.md#polling)). When a refresh fails, it keeps what it has and says why. When the run no longer exists, or you can't see it, it says so and stops refreshing.

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
- A workspace whose git remotes can't be read, because git failed or took over 5 seconds, is skipped and the others are still searched.

### Rerun and cancel

- **Rerun failed stage** shows for a finished run with a failed or canceled stage. It reruns the selected stage when that one qualifies, else the first that does. It asks Azure DevOps to retry the stage, without forcing every job to run again. A run with no stages, whose jobs sit under **All jobs**, can't be rerun here.
- **Cancel run** shows while the run hasn't finished and isn't already cancelling. It takes two presses: **Cancel run**, then **Confirm cancel**. The button disarms when it loses focus.
- Both read the run first and report what Azure DevOps did, and neither retries.
