# Work, the board and agents

[Back to the README](../README.md)

## The Work tab

Open the Azure DevOps panel and choose **Work**. It needs a boards project and team for the organisation (see its settings).

The toolbar has two rows. The first has the board's label and a **Columns** and **Lanes** switch. The second has `Updated …` in muted text on the left and four icon buttons on the right: **Collapse all**, **Expand all**, **Refresh** and **Open board**. The label is the team and the board, such as `Platform · Stories`. It is a label, not a picker: the board comes from the organisation's settings. **Open board** opens the full-tab board (see The board).

### My work

My work lists the items assigned to you. Finished items are left out.

- **Columns** is the default view. It has one group for each board column, in board order, with the number of items in its header, such as `Active · 3`. A column with nothing in it isn't shown.
- **Lanes** follows the board's own swimlanes. It has one group for each lane, in board order and empty lanes included, and inside it one group for each column that holds items. The board's unnamed lane is called **Default lane**. A board with no swimlanes shows the columns instead, under the note `This board has no swimlanes, so Lanes shows the columns.`
- **Not on this board** holds your items that move by state, not by column: Features and Epics, bugs the board doesn't show, and board items that have no column. It has one group for each type, and **Move** changes an item's state.
- **No parent** holds your tasks that have no parent, and nothing else.

### An item card

A card has two lines, and shows its tasks inside it while they are open (see Tasks under their parent). The first is the title, one pressable line cut with `…` after 90 characters: press it to open the item's details. The second has, on the left, the type's icon (it opens the details too), `#id`, the chips for linked pull requests and **Tasks n/m** when the item has tasks. On the right is a compact **Move** box.

- Each card shows chips for its linked pull requests, one per target branch: the branch with `✓` when merged, `building` while a build runs, `✗ build` when it failed, and `abandoned`. When several pull requests target the same branch, the chip shows the merged one, else an open one (a failed build first, then a running one), else an abandoned one. A card shows up to four chips and counts the rest; the board and the details show them all.
- **Move** moves the item to another column. Moving into a split column puts the item in Doing. A move is refused when someone else changed the item first: the item is refreshed and you try again.
- The details show the description, acceptance criteria, comments, parent and links, with each linked pull request's state. You can add a comment, link a pull request by its URL, start a workspace and agent for the item, or open the item in Azure DevOps.
- Under the title, `Read ‹time›`, such as `Read 3 minutes ago`, says when the details were read. **Refresh**, beside **Back**, reads them again and keeps them on screen meanwhile. The details are the same copy the board's panel shows, so opening an item in one soon after the other doesn't read it again (see [Polling](reference.md#polling)).

### Tasks under their parent

A task sits under its parent, whatever type the parent is. **Tasks n/m** on a parent shows how many of its tasks are done, and opens or closes the list, which shows inside the card on a shaded panel.

- The board's backlog settings say which types count as tasks: the task level's types, and bugs too when the team handles bugs as tasks.
- The list holds the child tasks of the parent, whoever they are assigned to and finished ones included. Removed tasks are left out of the list and of **Tasks n/m**. Your open tasks come first, then other people's open tasks, then finished ones, up to 20 tasks. When more than 20 of the open tasks are yours, all of those show. A longer list ends with `+ N more`.
- A task is one line: its `#id`, its title and its state. Press the `#id` to open the details; finished tasks open too. When the task isn't yours, the assignee's name or `Unassigned` follows the title. Titles are cut the same way as an item's.
- A finished task has a muted title and its state in a success badge. Your own open task shows its state as the placeholder of its **Move** box, which moves it. A task of yours with no state to move to shows its state as a badge, as other people's open tasks do.
- A list starts open when it holds a task of yours that isn't done or its parent is dimmed or can't be read, and closed otherwise.
- A parent that isn't assigned to you but has a task of yours shows dimmed, in the column (and lane) it is in, with a small progress bar beside **Tasks n/m**. A parent that isn't on the board goes in **Not on this board**, under its type.
- A task that has tasks of its own is listed in **Not on this board** under its type, with its tasks nested under it. It still shows as a row under its own parent.
- A parent you can't read shows as `#id` under **Unknown type**, in **Not on this board**, with its tasks.

The same load reads the parents of your tasks and the child tasks in batches, never one request per item. When the child tasks can't be read (a refusal on another project, throttling or a timeout), the tab still lists every item, without task lists, and says `Couldn't load the tasks under your items. They show after the next refresh.`

### Collapse all and Expand all

**Collapse all** closes every group, lane and task list in the tab. **Expand all** opens them all. You can still open or close any one afterwards.

- Which groups and task lists are open is remembered for each organisation, and survives a reload and a switch of tab.
- The view, **Columns** or **Lanes**, is remembered for each board.
- A group shows 25 items and ends with **Show N more**. That isn't remembered.
- On a very large board the tab stops drawing before it reaches Orca's panel limits, and says `Some items are hidden. Collapse a group to see others.`

### Suggest moves

Off until you add rules. In the organisation's settings, open **Suggest moves** and add rules that pair a branch with a column. When a pull request linked to an item merges into that branch, and the column is further along than the item's, the Work tab offers to move the item there (`Move to <column>`) or dismiss the suggestion. Rules are saved per team.

## The board

The board opens in its own tab as a custom editor for `.adoboard` files.

- Drag a card to another column or lane to move it. The card shows in its new place while the move is sent, and returns with a message if Azure DevOps refuses it.
- Swimlanes collapse and expand. When a board has several lanes, all but the first start collapsed.
- **Me** and **Everyone** switch between your items and the whole team's. Each board remembers your choice. A board you haven't opened before shows **Everyone**. The **Parent** list filters to the children of one parent.
- It refreshes every 30 seconds while the tab is visible, slowing to every minute while nothing changes, and asks Azure DevOps only for what changed. A hidden board keeps its cards and refreshes when you come back, if they are over 30 seconds old.
- After Orca restarts, a board shows the cards saved last time with `Updated ‹time› · refreshing…`, where ‹time› is when they were last loaded, such as `Updated 5 minutes ago · refreshing…`, until its first refresh replaces them. When a refresh fails, the board keeps the last loaded items and says how old they are and why, until a refresh succeeds.
- A board with more items than one answer holds (500 items, or 900 KiB) shows the most recently changed ones and says how many.

**Open board** in the Work tab writes `<workspace>/.orca-ado/<org>.<teamId>.adoboard` in your focused workspace and opens it. The `.orca-ado/` folder holds a `.gitignore` containing `*`, so git never sees it. This needs a local workspace. Without one, use **+ → Azure DevOps board**, which opens the editor and asks which board. The board you pick is written into the file, so the tab opens it again when you come back; Orca marks the file unsaved until you save it. A read-only file still shows the board, with a note that it won't be remembered.

### A card's details

Click a card to open its details in a panel beside the board, or press Enter or Space on a focused card. The board stays usable while the panel is open: click another card to swap it in, drag any card, the open one included, and switch **Me** and **Everyone** or the **Parent** list. Esc in the panel or **Close** closes it, and focus goes back to the card. In a tab narrower than 760 px the panel covers the board below the toolbar, which stays usable.

- **Header.** The type and id, the title, and **Refresh**, **Open in Azure DevOps** and **Close**. Under the title, `Read just now` for the first minute, then `Read ‹time›`, such as `Read 3 minutes ago`, says when the details were read, and `Refreshing…` shows while they are read again. **Refresh** reads them at once.
- **Column**, or **State** for an item that moves by state, moves the item as a drag does, to the same places as the sidebar's **Move**. Dragging the open card updates it too.
- **Assigned to** opens a list: **Assign to me**, **Unassigned**, and your team's people, filtered as you type. For anyone else, press Enter on `Search Azure DevOps for "…"`. Up, Down, Home, End, Enter and Esc work in the list.
- **Parent** names the item's parent.
- **Description** and **Acceptance criteria** show as formatted text: headings, bold and italic, code, lists, tables and links. Anything else shows as plain text, and list markers nested more than 16 deep show as text. A part that can't be drawn says `This text couldn't be shown.`
- **Tasks**, on the team's requirement-level board, such as Stories. The heading says `‹done› of ‹total› done` with a progress bar. Tick a task to move it to its type's first done state, and untick it to move it back to the first in-progress state, or the first proposed one when the type has none. The row says `Saving…` meanwhile, and the other rows stay usable. A child that isn't one of the team's task types, or has no done state, shows its state instead of a checkbox. Open tasks come first, then done ones, up to 50, then `‹n› more in Azure DevOps`. Removed tasks are left out. Type a title and press **Add** or Enter to add a task: it takes the item's area and iteration, and shows once Azure DevOps has created it.
- **Children** takes the place of Tasks on a Feature or Epic board. It lists each child read-only, with its type, title, state and a link to Azure DevOps, and has no checkboxes and no add form. A board whose team has no task type, or whose backlog settings couldn't be read, shows **Children** too, without saying why, and so does an item that isn't one of the board's own types.
- When the children can't be read, the section says `Couldn't read this item's tasks. Refresh to try again.`
- **Pull requests.** Each linked pull request shows `!‹id›`, its title and `into ‹branch›`, with one chip: `merged` or `abandoned`, or for an open one its checks in the PRs tab's words: `✗ build`, `✗ policies`, `building`, `· policies` or `✓ build`. Clicking a row opens the pull request in Azure DevOps. A pull request the plugin hasn't read, for example while chips are off, shows as `Pull request ‹id›` with no chip.
- **Comments** come newest first, with the author, the age and formatted text, up to the newest 50. The box above them takes a new comment: press **Comment**, or Ctrl+Enter (⌘+Enter on macOS).
- The footer has **Start a workspace and agent** (see Workspaces and agents) and **Open in Azure DevOps**.

How the panel behaves:

- **Typing is never interrupted.** A refresh or a teammate's change doesn't move focus or the caret out of the comment box, the task box or the people search. What you type in the comment and task boxes is kept for each item while the board's tab is open, through a swap or a close, until you post it.
- **When a change is refused,** its message shows under its section, what you typed stays, and the panel reads the details again. When someone else changed the item first, the message is `Someone else changed this item. It's been refreshed; try again.` A change still on its way when you open another card carries on. If it fails, its message shows the next time you open that card.
- **When the open item leaves the board,** for example assigned away on **Me** or closed by a teammate, the panel stays open and says `This item isn't on the board any more.` Closing it then focuses the board.
- **Links** open in your browser when you click them or press Enter on them. They aren't web links, so a middle-click or a drag does nothing. When the tab can't open links, the panel says `This view can't open links. Use Open in Azure DevOps in the sidebar.`
- **No polling.** The panel doesn't poll its item. When the board's own refresh shows the open item changed, the panel reads it again. Otherwise details are reused for 5 minutes, and comments for 2 minutes, and `Read ‹time›` says how old they are.
- **A comment you just posted** stays visible while Azure DevOps catches up. For 2 minutes after you post it, a read or **Refresh** that doesn't have it yet keeps it, so one you delete in Azure DevOps within those 2 minutes shows until they're up. The sidebar's details do the same. Otherwise the comments show as Azure DevOps has them: a deleted comment goes the next time they're read, and at once on **Refresh**.

## Workspaces and agents

These use the workspace, terminal and agent permissions Orca asks you to approve. They work on macOS and Linux when your shell is bash or zsh. On Windows, or with another shell such as fish, the start buttons are off and the details say why; **Open workspace** still shows a linked workspace.

The board's panel offers the same start in its footer, with the same buttons, messages and rules. Where this section says the details, the board's panel does the same. Both turn the start buttons off while another change to the item is on its way.

- **Start a workspace and agent** shows while the item has no workspace. It names the branch from your branch template and runs Orca's own command in a terminal titled `ADO #<id>`: `ado_prompt=$(command cat ~/.orca-azure-devops/starts/<file>.prompt) && orca worktree create --name <branch> --branch <branch> --agent <agent> --prompt "$ado_prompt" --no-parent --activate && exit`, where `<file>` is a new random name for each start. The prompt waits in a file only you can read, so nothing from the item is ever read as a shell command. The file goes once the workspace is ready, and after two minutes at the latest. Orca creates a worktree on the branch, opens it and starts your default agent with the item's link, description and acceptance criteria. When the branch already exists, Orca names it `<branch>-2`. Your repository's setup runs as you set it up, except in the first workspace of a repository the plugin has just cloned or added (see Clone from Azure DevOps).
- The workspace is made in the repository the details show (see Choosing the repository). The command runs in a local worktree of that repository: the focused workspace when it belongs to it, otherwise its first workspace by name.
- The details then say `Creating <branch> in <repo>. Orca opens it when it's ready.`, then `<branch> is open, and <agent> is starting with the item's details.`, then `<agent> is working on it.` once the agent the command started works; another agent busy in the same workspace doesn't count. Without an answer after 60 seconds (10 minutes for a clone) they say `Sent to Orca. If <branch> didn't appear, the terminal "ADO #<id>" in <workspace> shows why.` (or `If <agent> didn't start` for Start an agent), and **Show it** opens that workspace. The terminal closes when the command succeeds and stays open with Orca's message when it fails.
- When the description and acceptance criteria come to more than 100,000 bytes, the agent gets the item's link and `Read the description and acceptance criteria at the link above.`, and the details say so.
- Starting a workspace cancels a pending **Check out in Orca**, so the new workspace keeps the item's branch.
- Once the item has a workspace, the details show **Start an agent** and **Open workspace**. **Start an agent** runs `orca agent launch`, reading the workspace and the prompt from files the same way, in the item's workspace, never in the focused one, and says `<agent> is starting in <workspace>.` **Open workspace** shows it in Orca.
- A worktree you create yourself is linked to the item when its branch is the one the template gives, or that name with `-2`, `-3` and so on. The link is made when you next open the item's details. Keep `{id}` in the template, so two items never share a branch name.
- **Default agent** must be an agent name such as `claude` or `codex`: letters, digits, dots, dashes and underscores, starting with a letter or digit. Anything else is refused before a command runs.
- While Orca creates the workspace, **Start a workspace and agent** is off, and while an agent starts, **Start an agent** is off. Each comes back when Orca answers, or after the 60-second message (10 minutes for a clone). A second request while the first is still on its way is refused too, with `An agent is already starting for this item.` for an agent. A start pressed again while the workspace is still being created, after reopening the item, says `This item's workspace is still being created. If Orca's terminal shows an error, try again in two minutes.`
- With **Add work item context to agent prompts** on, the first prompt Orca sends to an agent in a linked workspace (a launch prompt, a task or an orchestration dispatch) starts with a link to the item. Prompts you type are never changed, and later prompts in the same terminal are left alone.

### Choosing the repository

While the item has no workspace, the details show the repository the workspace is made in, above **Start a workspace and agent**. Any repository already in Orca on this computer can be chosen, not only one of the item's own project, so an item planned in a project without code can start in a repository of another project. **Clone from Azure DevOps…** clones one first.

- When the plugin knows which repository to use, the details show it on one line, such as `web-app · Fabrikam Web (linked pull request)`, with **Change repo**, and Start uses it.
- Otherwise, and after **Change repo**, **Repository** lists every choice and starts on `Choose a repository`. Start stays off until you choose one.
- The list comes in this order, with each repository once, in its first place:
  1. the repositories of the item's linked pull requests, newest pull request first, marked `(linked pull request)`;
  2. the repository you last chose for the board's team, marked `(last used)`;
  3. the other repositories of this organisation, by name;
  4. every other repository in Orca, from another organisation, another host such as GitHub, or with no remote, by name;
  5. **Clone from Azure DevOps…**
- When the list starts with a linked pull request's repository or the last-used one, that one is chosen for you. Otherwise nothing is.
- A row reads `<repo> · <project>`, or `<repo> · <org>/<project>` for another organisation, `<repo> · <host>` for another host and `<folder> · local` for a repository with no remote. Worktrees of one repository make one row, found by their git remotes. Hidden formatting characters, such as right-to-left marks and zero-width spaces, are left out of a row, so a name can't reorder or hide part of it. A lookalike name, such as `web-app` spelt with a Cyrillic `е`, is a different repository with its own row.
- The team is the board panel's own team, and in the sidebar the board team in the organisation's settings. Without a team, the choice is kept for the item's project, and choices saved per project by earlier versions still count. Starting saves the choice, a cloned repository included, so next time it is `(last used)`. A remembered repository that is no longer in Orca is left out.
- The list makes no request to Azure DevOps of its own. It comes from the item's details, which Start reads anyway, from the pull requests and repositories the plugin already holds, and from git on this computer. A linked pull request whose repository the plugin can't name that way is left out.
- When the chosen repository has left Orca by the time you press Start, the list shows again with `That repository isn't in Orca any more. Choose another.`

### Clone from Azure DevOps

**Clone from Azure DevOps…** clones a repository of the organisation that Orca doesn't have yet, adds it to Orca and starts the workspace and agent in it, in one terminal and in one go.

- Choose the **Project**, then the **Repository to clone**. Nothing is chosen for you, not even a linked pull request's repository or a project's only repository. The details then say where it goes, such as `Clones into ~/orca/repos/web-app`.
- Opening **Clone** reads the organisation's repository list and says `Reading the repository list…` meanwhile. The list is read at most once an hour (see [Polling](reference.md#polling)). Projects and repositories are listed by name, without disabled repositories or ones in maintenance, up to 5,000. Past that the details say how many more aren't listed: clone those yourself and add them to Orca. A project with nothing to clone says `This project has no repositories to clone.`
- With no repositories in Orca at all, the picker opens on **Clone** and says `No repositories are in Orca on this computer yet. Clone one from Azure DevOps.`
- A repository that is already in Orca, found by its remote or by its folder, starts there without cloning.

Start then runs one line in a terminal titled `ADO #<id>`, in the focused local workspace or else the first local workspace by name. The new worktree doesn't depend on that workspace.

```
ado_url=$(command cat ~/.orca-azure-devops/starts/<file>.url) && ado_folder=$(command cat ~/.orca-azure-devops/starts/<file>.folder) && ado_repo=$(command cat ~/.orca-azure-devops/starts/<file>.repo) && ado_prompt=$(command cat ~/.orca-azure-devops/starts/<file>.prompt) && GIT_ALLOW_PROTOCOL=https:ssh command git clone -- "$ado_url" "$ado_folder" && orca repo add --path "$ado_folder" && orca worktree create --repo "$ado_repo" --name <branch> --branch <branch> --agent <agent> --prompt "$ado_prompt" --setup skip --no-parent --activate && exit
```

- The clone address, the folder, the repository and the prompt wait in files only you can read, so no project or repository name is ever read as a shell command. Every file is read before anything runs, so their removal after two minutes never cuts a long clone short.
- The plugin builds the clone address from the organisation, project and repository names. It never copies the address Azure DevOps gives. `GIT_ALLOW_PROTOCOL=https:ssh` lets this git use only HTTPS and SSH, and `--` stops the address or the folder from being read as an option.
- Git uses SSH when every Azure DevOps repository of this organisation in Orca uses SSH, there is at least one, and Azure DevOps offers SSH for the repository. Otherwise it uses HTTPS.
- Git signs in with this computer's own git credentials, as when you clone by hand, never with the plugin's sign-in (see [Where credentials live](connecting.md#where-credentials-live)). When it asks for a password or a passphrase, the clone waits in the terminal: **Show it** opens it so you can answer.
- When the repository's folder is already a clone of it, the line leaves out the `ado_url` read and `git clone`, and only adds the folder to Orca and creates the worktree.

**The folder.** Clones go in **Folder for new clones** (`cloneFolder`), `~/orca/repos` by default, each in a folder named after the repository. Everything below is checked before a file is written or a terminal opens.

- Empty means the default, and `~` is your home folder. The setting must then be a full path, or **Clone** says `"Folder for new clones" must be a full path, such as ~/orca/repos.`
- The plugin creates the folder at the first clone. It must belong to you and not be writable by your group or others. Every folder above it must belong to you or to the system (root), and must not be writable by your group or others unless it is a shared folder like `/tmp`, where only a file's owner can move or delete it. Otherwise **Clone** says `<folder> must be a folder only you can change. Check its owner and permissions, or change "Folder for new clones".` When it can't be created, Start says `Couldn't create <folder>. Check "Folder for new clones".`
- The repository's own folder must be absent, an empty folder of yours, or a clone of that repository that you own and that has a commit. A folder another user owns says `<folder> belongs to another user, so the plugin won't add it to Orca. Move it, or change "Folder for new clones", then try again.` Anything else, a link, a file or a half-made clone included, says `<folder> already exists and isn't a clone of <repo>. Move it, or change "Folder for new clones", then try again.`
- Two projects with a repository of the same name, even one that differs only in case, share one folder, so the second is refused as taken. Move the first one, or change the setting, to clone the second.
- While a clone runs, its folder is held, and another start into it says `<repo> is still being cloned (terminal "ADO #<id>"). Try again once it closes.` The hold ends when the workspace is linked, after 10 minutes, or after 2 minutes once the folder is gone or empty because the clone failed.

**While it clones.** The details say `Cloning <repo> into <folder>, then creating <branch>. Orca opens it when it's ready.`, or `Adding <folder> to Orca, then creating <branch>. Orca opens it when it's ready.` for a folder that was already a clone. **Show it** is there from the start, so you can watch git's progress.

- Start stays off for up to 10 minutes, not 60 seconds, before the neutral `Sent to Orca. If <branch> didn't appear, the terminal "ADO #<id>" in <workspace> shows why.`, so a long clone never reads as a failure.
- The new workspace is linked to the item when it appears within 10 minutes of the start, not 2 as for other starts. One that appears later is linked by its branch the next time you open the item's details.
- For every start of a workspace, `<agent> is working on it.` waits up to 10 minutes from when the workspace appears, not from when the line was sent, so an agent that starts after a long clone still shows as working.
- When git or Orca fails (credentials, the network, the disk, or a step Orca refuses), the line stops at that step and the terminal stays open with the error.

**Setup.** The first workspace of a repository the plugin has just cloned or added runs no setup (`--setup skip`), because nobody has looked the repository over yet. Look it over, then run its setup steps yourself in the workspace's terminal. Later workspaces in that repository run setup as usual, and so do repositories that were already in Orca. The details say so under the notice: `This repository's setup didn't run, because the plugin just added it to Orca. Look the repository over, then run its setup steps yourself in the workspace's terminal. Later workspaces in this repository run setup as usual.`

**When Clone can't run.** These show under **Clone** at once as a warning, and Start stays off:

| Case | What the details say |
| --- | --- |
| Git isn't installed | `Git wasn't found, so the plugin can't clone. Install Git, then try again.` |
| No local workspace in Orca for the terminal to run in | `Cloning needs a workspace in Orca to run in. Open any folder in Orca, then try again.` |
| **Folder for new clones** isn't a full path, or isn't only yours | The folder messages above |
| Azure DevOps won't list the repositories (it answers 404 or 400) | `Azure DevOps didn't list this organisation's repositories, so the plugin can't clone from it. Clone the repository yourself and add it to Orca.` **Clone** doesn't ask again for 10 minutes. Any other error shows its message, and the next **Clone** asks again. |

Pressing Start can still refuse a clone, before anything runs:

| Case | What the details say |
| --- | --- |
| A name that can't be a folder name: longer than 64 characters, a reserved name such as `CON`, a character such as `/`, `:`, `$` or a backtick, a hidden formatting character, or a leading `-`, `_` or `.` | `This repository's name can't be used as a folder name. Clone it yourself and add it to Orca.` |
| No safe clone address can be built | `The plugin can't build a safe clone address for this repository. Clone it yourself and add it to Orca.` |
| The repository left the organisation's list | `Azure DevOps no longer lists that repository. Choose another.`, with the list again |
| The plugin no longer holds the repository list, for example after Orca restarted it | `The repository list needs reloading. Choose the repository to clone again.`, with the list again. The next **Clone** reads the repository list again |
| The folder can't be created, belongs to another user, is taken or is still being cloned | The folder messages above |

A clone runs only where the one-click command runs: on Windows, or with a shell other than bash or zsh, Start is off with the usual message.
