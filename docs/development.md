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

### Live checks still pending

The tests use fixtures and fakes. These haven't been checked against a real organisation, Teams, Microsoft Entra or Orca's own interface yet.

Boards:

- The board opens as an editor and `git status` stays clean.
- Dragging a card moves it, and a split column writes Doing and Done correctly.
- The workspace hook names the branch, and **Start an agent** launches your default agent with its prompt.

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
