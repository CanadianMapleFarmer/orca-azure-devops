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
- The details show the description, acceptance criteria, comments, parent and links, with each linked pull request's state. You can add a comment, link a pull request by its URL, start a workspace or an agent, or open the item in Azure DevOps.

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
- After Orca restarts, a board shows the cards saved last time with `Updated ‹time› · refreshing…`, such as `Updated 5 minutes ago · refreshing…`, until its first refresh replaces them. When a refresh fails, the board keeps the last loaded items and says how old they are and why, until a refresh succeeds.
- A board with more items than one answer holds (500 items, or 900 KiB) shows the most recently changed ones and says how many.

**Open board** in the Work tab writes `<workspace>/.orca-ado/<org>.<teamId>.adoboard` in your focused workspace and opens it. The `.orca-ado/` folder holds a `.gitignore` containing `*`, so git never sees it. This needs a local workspace. Without one, use **+ → Azure DevOps board**, which opens the editor and asks which board.

## Workspaces and agents

These use the workspace and agent permissions Orca asks you to approve.

- **Start a workspace** names the branch from your branch template and arms it. The next worktree you create in Orca within 10 minutes gets that branch and name, once. The new workspace is linked to the item. **Cancel** in the message disarms it, so the next worktree is created as you set it up. The message goes away by itself when a new workspace takes the branch, another arm replaces it or the 10 minutes are up.
- **Start an agent** launches your default agent in the item's workspace, or in the focused workspace when the item has none. The prompt is the item's link, description and acceptance criteria.
- With **Add work item context to agent prompts** on, the first prompt Orca sends to an agent in a linked workspace (a launch prompt, a task or an orchestration dispatch) starts with a link to the item. Prompts you type are never changed, and later prompts in the same terminal are left alone.
