# Pull requests, sharing and reviews

[Back to the README](../README.md)

## The PRs tab

Open the Azure DevOps panel and choose **PRs**. It lists the pull requests you created in the organisation's code projects, grouped into release sets, and the ones waiting for your review or that you have already voted on. Both lists are grouped by project.

The toolbar has two rows. The first has the pickers (see Projects and repositories) and the **Mine** and **To review** switch. The second has `Updated …` in muted text on the left and four icon buttons on the right: **Collapse all**, **Expand all**, **Refresh** and **Teams channels**. **Refresh** reloads now.

- **Mine** shows your release sets. It is the default.
- **To review** shows the pull requests waiting for you (see To review). Its label carries the count: `To review · 12`. With a project chosen it reads `To review · 3 of 12`: three in that project, twelve in all.

The switch is remembered for each organisation.

### Projects and repositories

Each project is a collapsible group, in name order. Its header line has the project's name and a count such as `3 sets`. On **Mine**, a hint such as `1 needs you` sits under the header when something does. A hint counts the sets that have a pull request with conflicts, a failed build, a rejected policy, or a Rejected or Waiting for author vote.

- A project whose pull requests all come from one repository stays flat, and its header names the repository: `Fabrikam · fabrikam-web · 3 sets`.
- A project with pull requests from more than one repository reads `Fabrikam · 2 repos · 3 sets`, with one sub-group for each repository, in name order.
- A release set whose pull requests are in more than one repository of a project goes in an **Across repos** sub-group at the top of that project. Each of its rows has a chip with the repository's name.
- A release set whose pull requests are in more than one project goes in one **Across projects** group at the top of the list. Sets join through shared work items across the organisation. A set is never copied under each project. Each of its rows has a `project / repo` chip.
- The **Project** picker (**All projects** by default) filters the list. A set shows under a chosen project when any of its pull requests is in it. When the chosen project has more than one repository, a **Repository** picker (**All repos**) appears next to it.

The pickers are remembered for each organisation. When the remembered project is no longer in the data (its last pull request merged, say), the tab shows **All projects**, hides nothing, and brings the choice back when the project returns. When the project you chose has nothing in the list you are on, the tab says `Nothing here for <project>` and suggests **All projects**.

**Collapse all** closes every group and **Expand all** opens them. You can still open or close any one. Which are open is remembered for each organisation, and survives a reload.

### Release sets

A release set is a group of your pull requests that ship together. Pull requests share a set when they:

- have the same source branch in the same repository, or
- are linked to the same work item.

The links chain: if one pull request shares a branch with a second, and the second shares a work item with a third, all three are one set. A set holds your active pull requests and the ones you completed in the last 14 days, shown as `merged`. A set with no active pull request left disappears, and the newest sets come first. Without enough access to read linked work items, sets form by source branch only and the tab says so.

A set is one card:

- Its title is the title of its lowest-numbered pull request. A muted line under it gives the source branch. When the set's pull requests have different source branches that share a prefix of at least 4 characters, the line shows the prefix and `*`, such as `feature/login-*`. Otherwise it reads `3 branches`.
- Each pull request is a row: `!N` as a link, `→ target`, the place chip when the group needs one (see Projects and repositories) and one status chip.
- A set shows every row that isn't merged and the first 2 merged pull requests. The others fold into `+ N merged · show`. Press it to see them, and **Hide merged** to fold them again.
- The buttons are **Share…** first, then **Approve** and **Auto-complete**. These two show only when a pull request in the set still needs them.

The status chip carries the meaning in its colour:

- A merged pull request shows only `merged`, and an abandoned one `abandoned`, because votes and checks no longer matter.
- An active one shows the worst of its checks first: `conflicts`, `✗ build`, `✗ policies`, `rejected` (a Rejected vote), `waiting for author`, `building` while a build runs, `· policies` while some are pending, and `✓ build` when the build succeeded or the policies are approved. `draft` and `auto-complete` join the same chip when they apply, as in `draft · ✗ build`. A pull request with nothing to say has no chip.
- `waiting for …` sits under the pull request's row and names the required reviewers who haven't voted or declined.

The tab shows the 30 newest sets and up to 150 rows, and says when it leaves some out.

### Approve

**Approve** votes Approved, as you, on every active pull request in the set. It shows only when a pull request in the set is active, isn't a draft and isn't already approved by you. It skips completed, abandoned and draft pull requests, and ones you have already approved. Any other vote of yours on the rest (waiting for the author, rejected, approved with suggestions) is replaced.

Each row reports its own result. When Azure DevOps refuses one, the others still go through and that row shows the error.

### Auto-complete

**Auto-complete** sets auto-complete, as you, on every active pull request in the set. It shows only when a pull request in the set is active, isn't a draft and hasn't auto-complete set already. It uses the three auto-complete settings (merge type, delete the source branch, complete linked work items) and never bypasses policies. It skips completed, abandoned and draft pull requests, and leaves one that is already set to auto-complete as it is. The button's tooltip says which settings apply: `Auto-complete uses Merge (no fast-forward), keeps the source branch, leaves work items alone. Change this in Settings → Azure DevOps.`

Pull requests in a set often share one source branch. With "delete the source branch" on, the first one to merge would delete the branch the others still need. So when another active pull request in the same repository uses the same source branch, auto-complete is set with the branch kept, and the row says which pull request also uses it.

- The plugin asks Azure DevOps for the active pull requests on the branch at that moment. If the check fails, it keeps the branch and says so.
- If another pull request is already set to delete the shared branch when it completes, the row warns you. Turn that off in Azure DevOps; the plugin doesn't change it.

### To review

**To review** lists the active pull requests waiting for you, under the same project groups and repository sub-groups as Mine. You are named as a reviewer yourself and haven't voted or declined, you didn't create it and it isn't a draft. A pull request that reaches you only through a group isn't listed or counted. The count shows on the status bar (see [The status bar](reference.md#the-status-bar)).

Its rows are compact, not set cards: the title, then `!N · author`. Press a row to open the review (see Reviewing a pull request). The tab shows up to 50 rows and says when it leaves some out.

**Reviewed by you** is a group under them. It lists the active pull requests you have voted on: active, not a draft, not created by you, you voted and haven't declined. Each row shows your vote. It holds up to 50, and it isn't part of the count. The lists refresh after you vote.

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
2. In Orca, open the PRs tab and choose **Teams channels** (the settings icon in the toolbar), or choose **Manage channels** in the composer.
3. Enter a channel name and paste the URL, then press **Add channel**. The URL must be https. Names are unique and up to 100 characters, and you can add up to 20 channels.
4. **Test** posts a test message. **Replace URL** swaps in a new webhook when the workflow changes. **Remove** asks you to confirm.

Channels are shared by all your organisations. Which ones you post to is remembered per organisation.

## Reviewing a pull request

Click a row in **To review** or **Reviewed by you** to open the review in the PRs tab. **Back** returns to the list. At the right of the same row are two icon buttons: **Refresh** reads the pull request again, and **Open in Azure DevOps** opens it on the website. The tab remembers which review is open.

The header shows the title as a heading, then `Pull Request N`, the repository, the source and target branches, who opened it and when, and when it was loaded. Chips show `draft`, `conflicts` and your own vote. Under the header are the vote buttons, **Check out in Orca** and three sections:

- **Overview:** the description, the reviewers (up to 100) with their votes and whether each is required, and a box to add a general comment.
- **Files:** the changed files and their diffs (see The diff).
- **Comments:** the comment threads (see Comments and replies).

### Votes

**Approve**, **Approve with suggestions**, **Wait for author** and **Reject** vote as you. The button for your current vote shows a check mark. A new vote replaces your earlier one. Pressing the vote you already have changes nothing and says so.

A press reads the pull request again, then sends one request and never retries. It is refused when the pull request is no longer active or is a draft. When Azure DevOps records a different vote from the one you pressed, the result says what it recorded. The PRs lists refresh afterwards.

### The diff

**Files** lists up to 1,000 changed files with how each changed (added, edited, deleted or renamed), and a box to filter them. Select a file to see its diff.

Azure DevOps has no unified diff, so the plugin works it out. It compares the file at the pull request's latest push with the common ancestor of the source and target branches. That shows what the pull request changes, not what the target gained since. A diff has three lines of context around each change and an `@@` line for each hunk.

Each line has two numbers before the `│`: the line in the old file, then the line in the new file. A removed line has only the first, an added line only the second, and a line that didn't change has both.

A line comment uses one of them:

- On an added, edited or renamed file, the second number: the line in the new file.
- On a deleted file, the first number: the line in the old file.

The note under the diff says which. Leave **Line** empty to comment on the whole file. A line past the end of the file, or one that isn't a whole number from 1 up, is refused and nothing is posted. A line removed from an edited file can't take a line comment here.

#### What isn't shown

The view says why when it leaves something out:

- **Binary files** show no diff and take comments on the whole file only.
- **Files over 2 MiB** show no diff. The plugin doesn't read them, so it can't check a line number. When the side a comment lands on is that large, comment on the whole file.
- **Files of more than 50,000 lines** show no diff either. The view says the file is too large to show.
- **Too many changes:** an edit of more than 2,000 changed lines (roughly) shows no diff. An added or deleted file, or a change that only adds or only removes one block of lines, has no such limit and shows the block up to its first 60 KiB.
- **More than 1,000 files:** the list holds the first 1,000 and says so.
- A diff stops at 60 KiB and says how many lines it shows. Lines over 1,000 characters are cut.
- When Azure DevOps hasn't worked out the pull request's common ancestor yet, there is no diff. Refresh in a moment.

For all of these except binary files, the view suggests **Check out in Orca**, where Source Control shows the whole change.

### Comments and replies

**Comments** lists the threads, unresolved first and the newest first. A thread shows where it is (`General`, a file, or a file and line, with `old line` for the old side), its status (Active, Pending, Resolved, Won't fix, Closed or By design) and its comments with author and time. Threads on a file also show under it in **Files**, and a renamed file also shows the threads on its old path. Vote changes and other system messages, and deleted comments, aren't listed.

- **Reply** posts under the thread's first comment.
- **Resolve** sets the thread to Resolved. **Reactivate**, shown on a resolved thread, sets it to Active.
- **Add a comment** in Overview starts a general thread. **Comment on file** in Files starts a file or line thread. A comment can be up to 10,000 characters.

Comments are shown as Markdown with images as links, and `@` mentions show names. The plugin keeps at most 100 threads and 20 comments in each (the first and the newest 19), and cuts a comment at 8,000 bytes. The panel shows up to 30 threads with 10 comments each (the first and the newest 9). The tab counts every thread, says how many it shows, and says how many replies it left out. Some comments may be dropped to keep a very large review within one answer, and it says so.

Votes, replies, status changes and file comments read the pull request or thread again first; a general comment is sent as is. Each write sends one request, never retries, and reports what Azure DevOps answered. Its button is off while it runs. A thread deleted meanwhile and a file a later push dropped are refused with a message, and so is a vote on a pull request that has completed.

### Check out in Orca

**Check out in Orca** gets the pull request's source branch into a workspace. It doesn't create the workspace itself. It tells Orca to use the branch for the next workspace you create.

1. Press **Check out in Orca**. The plugin reads the pull request again and looks in your local workspaces for one whose git remote is the pull request's repository. It prefers one already on the source branch, then a git worktree, then the one in focus. It refuses when the pull request is no longer active, comes from a fork (check it out from the fork's repository), or matches no local workspace. It also refuses when the repository is open in Orca only as a folder, which can't create worktrees: open it as a git project and press again.
2. If that workspace is already on the source branch, Orca opens it. You are done.
3. Otherwise the plugin shows the repository's workspace (unless it is in focus) and arms Orca's next new workspace for 10 minutes. The panel says what to do and has a **Cancel** button.
4. In Orca, create a new workspace in that repository's project and leave its branch options alone. It gets the source branch, made from the remote's copy. When a local branch of that name is checked out in another workspace, or sits at another commit than the remote's, it gets `<source>-2` from the same remote branch. Pushing from `<source>-2` creates a new branch on the remote; it does not update the pull request.
5. In Source Control, set the compare base to the target branch. Orca starts the new worktree's compare at the source branch itself, so the compare shows nothing until you change it.

The arm works like this:

- It serves one workspace and lasts 10 minutes.
- The next new workspace you create in Orca gets it, in any project. The plugin can't tie the arm to a project. A workspace made with the `orca` command or by an automation gets it too, so create the one you want first. A new folder workspace doesn't use it.
- Arming replaces an earlier arm. **Start a workspace and agent** on a work item cancels it, so its new workspace keeps the item's branch.
- The workspace takes the branch name as its name.
- **Cancel** disarms it, and never a later arm that replaced it. The box goes away by itself when a new workspace takes the arm, another arm replaces it or the 10 minutes are up. A panel reload removes only the box: the arm still serves the next new workspace until it expires.
- When a local branch of the source's name exists and Orca has never fetched the remote's copy, Orca bases the workspace on that local branch as it is, without fetching. It may be behind, or hold commits you haven't pushed.
