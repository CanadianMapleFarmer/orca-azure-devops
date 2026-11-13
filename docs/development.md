# Development

[Back to the README](../README.md)

```bash
npm install
npm run typecheck
orca plugin test .
orca plugin check .
orca plugin validate .
```

`npm run typecheck` writes Orca's plugin typings into `.orca/types/`, downloading them from the matching Orca release tag when the installed Orca doesn't ship them, then runs `tsc`.

To load the plugin for development, run `orca plugin dev watch .`. Orca asks for your approval first.

### Why the plugin runs Orca's CLI to start workspaces and agents

No host call creates a worktree, and the plugin `agent.launch` of Orca 1.4.256 starts the agent but drops its prompt ([stablyai/orca#41107](https://github.com/stablyai/orca/issues/41107)). So **Start a workspace and agent** and **Start an agent** open a terminal with `terminal.create` and run `orca worktree create` or `orca agent launch` in it, which create the worktree, start the agent and submit the prompt in one command.

Orca types that command into its terminal shell: a single line raw, a multi-line one as a bracketed paste to bash and zsh and line by line to any other shell. So the command is always one short line, and work item text never becomes shell syntax. The CLI can't read the prompt from a file, so the worker writes the prompt and the worktree selector to `0600` files in `~/.orca-azure-devops/starts` (a `0700` folder), and the command reads them: `ado_prompt=$(command cat ~/.orca-azure-devops/starts/<id>.prompt) && orca … --prompt "$ado_prompt" … && exit`. A missing or unreadable file stops it before the CLI runs. The branch and the agent are plain words. A clone line also reads the clone address, the folder and the repository selector from start files, and types `GIT_ALLOW_PROTOCOL=https:ssh command git clone -- "$ado_url" "$ado_folder"` before `orca repo add` and `orca worktree create` (see [Clone from Azure DevOps](work.md#clone-from-azure-devops)); with the default template it is about 780 bytes at worst. A shell without `$(…)`, such as tcsh, refuses the line before anything runs. The command stays far below the 1,024 bytes a macOS tty keeps when Orca types it before the shell is ready, and the plugin refuses one over 1,000 bytes. A prompt over 100,000 bytes is replaced by the item's link and a pointer to it. The files go once the workspace is ready, when the terminal is refused or fails, and after two minutes in any case. The worker sweeps files older than two minutes when it starts, on every start, and again two minutes later while any remain; the sweep stops unless the folder is a real folder of the user's, and deletes only regular files with the plugin's exact names. Only the agent the command started counts as working: an observe-only `agent.prompt.before` handler ties the terminal whose launch prompt names the item. Windows and shells other than bash and zsh are turned off with a message. That check reads only `$SHELL`, and Orca's own Default shell setting can differ, so the one-line command, not the check, is what keeps every shell safe.

`python3 scripts/typed-command-check.py` types Orca's exact bytes for the commands the plugin builds into interactive bash, zsh, sh, dash, ksh, tcsh and csh through a pty, plus fish, pwsh and nu from Homebrew when they are installed. Each hostile prompt goes into four commands: a workspace start, an agent launch, a clone line, and the add-only line for a folder that is already a clone, whose folder and clone address hold quotes, `$(…)`, backticks and a leading `-`. Stand-in `orca` and `git` programs record the arguments they get, and the `git` one records `GIT_ALLOW_PROTOCOL` too. It writes the start files into a temporary home, types once the shell is ready and once before it is, and once more with the files gone. For bash and zsh it also types while a slow rc file runs, next to a 1,100-byte control line that the tty cuts off, which shows why the command must stay short. It checks that each shell either hands the programs the exact values or refuses the line, that a missing file stops the command, and that no item text runs. When git is installed, it also types a clone line into every shell that runs the line, with the real git and an address file holding a `file://` address, a local path or an `ext::` command, and checks that git refuses each one, makes no folder and runs nothing after it. A control run first clones the `file://` address and the local path with git alone, without `GIT_ALLOW_PROTOCOL`, so the refusals prove something. The clone cases make a full run take about twice as long as the workspace and agent cases alone. Run it after changing `worker/workspace/command.ts`.

### Checked live

Checked by hand in Orca for 0.4.0:

- The board's panel: a card opens its details beside the board.
- The repo picker lists the local repositories in Orca.
- **Start a workspace and agent** in a repository already in Orca creates the worktree and starts the agent.
- **+ → Azure DevOps board** remembers the board picked in its dialog: coming back to the tab opens the board, not the dialog.

### Live checks still pending

The tests use fixtures and fakes. These haven't been checked against a real organisation, Teams, Microsoft Entra or Orca's own interface yet.

Boards:

- The board opens as an editor and `git status` stays clean.
- **+ → Azure DevOps board**: Orca marks the file unsaved after a pick. Also whether Orca echoes the written text back through `onDidChange`.
- Dragging a card moves it, and a split column writes Doing and Done correctly.
- On the client organisation, the delta query with `timePrecision=true` is accepted and returns only the items changed since the watermark.
- Adding a child task and linking a pull request each bump the parent's `rev` and `ChangedDate`.
- Add a task from a named board: it appears under the story in Azure Boards, with the story's area and iteration, and on the sprint's taskboard when the story is in a sprint.
- Open a Feature on a Features board: its stories show read-only under **Children**, with no checkboxes and no add form.
- Reassign to a person whose display name another person shares, and unassign. Reassigning to a guest or a deleted identity shows Azure DevOps's message under **Assigned to**.
- Tick and untick a task in a Scrum project (To Do → Done → In Progress) and an Agile one (New → Closed → Active). Focus stays on the row's checkbox afterwards.
- As a Stakeholder: add and tick a task; reassigning shows Azure DevOps's message.
- The board's panel at 360 px and 1440 px in both themes: click from card to card, drag the open card and another card, Esc in the panel with focus returning to the card, the narrow sheet's `inert`, and links opening through `openExternal` while a middle-click does nothing.
- Type a comment while a teammate changes the story: the text, focus and caret stay.
- Comment, move, reassign and search for a person from the panel: each reaches Azure DevOps. Also where focus goes when the control you used is turned off while its change is sent.
- Start a workspace and agent from the board's panel, with a known repository and with the list: the footer says when the workspace is ready and when the agent works.

Starting workspaces and agents, in a throwaway repository with an Azure DevOps remote, after installing a dev build:

- Orca's approval lists `terminal:send` and no longer `agent:launch`, and the buttons are on with zsh on macOS, so the worker sees `$SHELL`.
- With Orca's Default shell set to `/bin/bash` (3.2 on macOS) the command runs, and with `/bin/tcsh` the terminal shows tcsh's error and nothing else runs.
- On Linux: the buttons are on with bash, and the start files are written and removed.
- A login shell whose rc files take longer than 15 seconds: the command runs once the shell is ready.
- `~/.orca-azure-devops/starts` is empty two minutes after a start, and after a worker restart.
- Close and reopen an item's details while its workspace is being created, then press Start: the details say the workspace is still being created. Also press Start in two Orca windows at once: one terminal opens.
- **Start a workspace and agent** gives the agent the item's prompt and closes the `ADO #<id>` terminal. Does `--activate` show the new worktree with the agent's tab selected?
- The installed plugin's `workspace.create.after` fires for the worktree the CLI made: the details switch to **Start an agent** and **Open workspace**, also for `<branch>-2` when the branch exists.
- Orca fires `agent.prompt.before` for the launch prompt of an agent the CLI started, and `agent.status.changed` names its terminal, so the details say `<agent> is working on it.` Without that, they show the neutral 60-second message instead.
- Another agent busy in the item's workspace during Start an agent doesn't make the details say it is working, and the start files stay until the two minutes are up.
- **Start an agent** in the linked workspace: the prompt arrives, and `--focus` selects the agent's tab.
- A failing command, with Default agent set to an agent Orca doesn't know: the terminal stays open with Orca's message, and after 60 seconds the neutral message's **Show it** opens its workspace.
- A description too long for one command: the agent gets the link and the short prompt, and the details say so.
- Several repositories in Orca: the list's order, the last choice for the board's team as `(last used)`, and **Change repo**. After an upgrade, a repository chosen for a project by an earlier version shows as `(last used)`.
- A pending **Check out in Orca**, then **Start a workspace and agent**: the arm is cancelled and the new workspace keeps the item's branch. Also press **Check out in Orca** while the item's command runs: does `workspace.create.before` carry the item's branch, so the arm leaves the new worktree alone?
- Pressing Start twice: the second press is off until the workspace is ready.
- A worktree created by hand on the item's branch is linked when the details next open.

The repo picker and Clone from Azure DevOps, in a throwaway project:

- An item in a project with no repositories: the repository of a linked pull request in another project ranks first, and Start creates the workspace there.
- Clone into an empty **Folder for new clones**: the line clones, adds the repository, creates the worktree without setup, starts the agent and closes the terminal, the details say the branch is open, and the setup note shows.
- `orca worktree create --repo path:<folder>` finds a repository just added with `orca repo add --path`.
- Where Orca shows a repository's setup steps, so the setup note and the Work guide can name it.
- A clone that needs a credential prompt, and an organisation whose remotes are all SSH.
- A clone that takes longer than 2 minutes links within 10, and its agent's `<agent> is working on it.` shows.
- `orca repo add --path` on a folder Orca already has.
- The pty harness on bash, zsh, sh, dash and ksh (runs), tcsh and csh (refuses), and fish, pwsh and nu (runs or refuses).

Pull requests and sharing:

- Three pull requests from one branch form one set. Approve and Auto-complete work, the branch is kept, the merge type applies, and a "limit merge types" policy shows its message on its row.
- The pull request list returns `autoCompleteSetBy` and `completionOptions`, which is how a pull request that will delete a shared branch is spotted.
- Copy as rich text pasted into Teams desktop, Outlook and Slack makes only "Pull Request N" a link. This includes the macOS write to the real clipboard and the Windows and Linux routes.
- A Workflows webhook posts a card whose links open the pull request, Test and Replace work, and the intro's line breaks show on the card.
- The Teams chat link: desktop app or browser, prefilled line breaks, `tenantId` picking the right account, a two-person group chat, the real length limit, and how often Orca asks before opening it.
- Adding reviewers (a person and a group, required and optional) notifies them and leaves an existing reviewer's vote untouched.
- On the client organisation, read-only: `X-RateLimit-*` headroom after a refresh, whether `reviewerId` returns pull requests assigned to your groups, and whether the organisation-wide repository list works.
- The PRs tab and composer at 360 px in both themes, the Mine and To review switch and the first press of Share and Open Teams chat.
- The Markdown preview of a title that holds a bare URL.

Pipelines and notifications:

- A multi-stage sandbox run: the Pipelines tab and the run tab follow its stages and steps live. Whether a running step's log grows before the step ends, whether `startLine` counts from 1 and `endLine` is inclusive, how `changeId` behaves and whether an unchanged timeline answers `204`, what a queued run's timeline and logs return, and whether a log's first line carries a byte order mark.
- A failing Docker-style step and a failing Helm-style step: Errors only and the error summary find their lines, **Jump to line** works, and **Open in Orca** opens a file in a local workspace. This includes agent paths such as `/home/vsts/work/1/s/…` and `D:\a\1\s\…`, and whether the workspace's branch name matches the run's.
- Rerun the failed stage, including the one implicit stage of a pipeline without stages and whether a retry replaces the stage's records, then cancel a run.
- An environment approval: Needs me, the approvers and waiting time, the environment name, Approve and Reject with a comment, and a two-approver check. Also what Azure DevOps answers when the requester approves their own run, the `permissions` value for a group-assigned approver, that `$expand=steps,permissions` is accepted, and that an approval's `pipeline.owner.id` is the run id and its Checkpoint records match.
- Share for approval to a Teams chat, the test channel, email and Copy. For email: whether `mailto:` opens in the default mail app, how Orca's consent prompt treats it, and whether an `@` encoded as `%40` survives in the address.
- Notifications for a failure, a watched run and an approval on macOS, with Orca in front and behind, and what a click does.
- Notifications for a real review request and for a comment from another account on one of your pull requests: the two-line text on macOS, a thread read that Azure DevOps refuses, and whether a thread list without an iteration returns every thread and a group-assigned review request counts.
- On the client organisation, read-only: `X-RateLimit-*` and `Retry-After` headroom with the Pipelines tab and a run tab open for 10 minutes, whether `requestedFor` carries an id, who it names on a run started by pull request auto-complete, and the `triggerInfo` of one real pull request validation run and one CI run.
- Which scopes runs, approvals, environment names and the project list need with a partial PAT, and whether a refusal gives the right message.
- The Pipelines tab at 360 px and the run tab in both themes, a run tab whose file was pruned, and `ADO · N failed · N approvals · N to review` on the status bar.

Reviews and wiki:

- A pull request with an edit, an add, a delete, an unchanged rename, an edited rename and a binary file: the diffs and their line numbers match Azure DevOps.
- Reply, Resolve and Reactivate work. File comments and line comments on the new and the old side land on the right lines, a line comment's span (offset 1 to 1) shows on its line, and mentions show names.
- Each of the four votes is recorded as the plugin says, and a draft pull request refuses a vote.
- Check out in Orca on a workspace already on the source branch, a remote-only source branch, a local branch at the remote's commit, a local branch at another commit, a local branch whose remote copy was never fetched, and a branch checked out in another workspace. Also a workspace created in another project while armed, and Source Control's compare base. Whether `workspace.list` names the branch of a detached worktree.
- The Wiki tab: the tree, images and links, a code wiki with a mapped folder, and search for a page title, text in a code wiki and a page with `%3A` in its path.
- Edit in Orca: the ETag form, that `git status` stays clean, and Orca's editor and its preview. A page edited in the browser meanwhile: the conflict view, each choice, and the status Azure DevOps answers to the stale Publish. Also the answer to a Publish to a page deleted meanwhile, and a draft file rewritten from outside while the editor holds unsaved edits.
- A unicode page such as `/Résumé/Überblick 文档` opens in the editor and publishes, and `git status` stays clean.
- On the client organisation, read-only: the load time and request count of a large pull request, and whether wiki search is offered. If it is refused, the status and `typeKey`. Also which scope wiki search needs with a partial PAT.
- The review view and the Wiki tab at 360 px in both themes.

Microsoft sign-in and network:

- The admin guide against the real portal labels: every label it quotes, and whether step 5 is needed.
- Orca's consent dialog for `login.microsoftonline.com`, and how often it asks.
- The account picker on every sign-in, `signed in as <account>` once it finishes, and the browser tab's page.
- Safari, Chrome and Firefox reaching `http://localhost:<port>` while the plugin listens on `127.0.0.1`. A browser that tries only `::1` wouldn't reach it.
- Whether Allow public client flows set to No gives `AADSTS7000218`, and which code a redirect under Web gives.
- For each code in the troubleshooting, whether Microsoft sends it back to the plugin or shows it on its own page.
- A renewal after the access token's lifetime, and after an Orca restart.
- A wrong-account refusal, naming both accounts.
- Cancel and the 5-minute timeout, with `lsof` showing no listener afterwards.
- Sign out, then Reconnect, which needs the browser again.
- A proxy, only on a network that has one.
- On the client organisation, read-only: Sign in with Microsoft with the client tenant's app, when one exists.
- Screenshots of the Work, PRs and Pipelines views in both themes, taken with Orca minimised.

Panel overhaul:

- Each of the four tabs at 360 px in light and dark, with real data.
- PRs and Pipelines: every card's project is visible without opening it, a project with several repositories splits and one with a single repository stays flat, and the project and repository pickers survive a reload.
- Child tasks on a real board: every task of yours sits under its parent or in **No parent** and nothing that showed before is missing, a parent that isn't yours is dimmed in its column, a task under a task, a parent you can't read, whether a bug counts as a task on a team that handles bugs as tasks, and the message when the child read fails.
- Swimlanes: **Columns** and **Lanes** on a board with swimlanes and **Lanes** on one without, each card in the lane Azure DevOps puts it in, and the unnamed lane as **Default lane**.
- A reload: the Work view and open groups survive a reload, and so do the PRs view and the open wiki folders.
- Wiki: folders look different from pages and show their page counts.
- Open in tab on a real page with a diagram in each form, a wide table and several headings: it opens with both Mermaid forms drawn and a wide table readable, with Orca's Markdown view at its default, the Table of Contents lists the headings, a save is refused and leaves the file as it was, and pressing **Open in tab** again while the tab is open rewrites the copy and the open tab shows the new text. A page over 600 KiB opens cut, with its note.
- Mermaid in both forms: `::: mermaid` with and without a space, a fenced `mermaid` block, a front matter block, and the diagram kinds Azure DevOps lists.
- Stage chips on every run card.

General:

- Orca 1.4.258 reports every local workspace with `hostId: "local"`, not `null`, and the plugin counts both as local. On a new Orca, check that a local workspace still opens a board, a run's file, a checkout and a wiki tab, and that an SSH workspace is still refused.
- On the client organisation, read **Connection status** after 10 minutes with the Work tab and a board open, and record the request totals and the `Rate limit` line with its `X-RateLimit-*` figures. Also record the `ETag seen` line, which names the endpoints that answer with an `ETag`.
