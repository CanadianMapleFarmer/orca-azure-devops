# Azure DevOps for Orca

Azure DevOps boards, pull requests, pipelines and wikis inside [Orca](https://github.com/stablyai/orca) (see Status).

**Status: under construction.**

| Works now | Coming |
| --- | --- |
| Connecting any number of Azure DevOps organisations | Pull requests and sharing them |
| Pinning each organisation to one account | Pipelines |
| Choosing each org's boards project, team and code projects | PR reviews |
| An always-on worker and an `ADO` status bar item | Wiki |
| A Work tab with your items, grouped by board column | |
| A full-tab team board with drag-and-drop | |
| Starting a workspace or an agent from a work item | |

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

### PAT scopes

What exists so far is expected to work with:

- **Project and team: Read** (`vso.project`) for the project and team lists.
- **Work Items: Read & write** (`vso.work_write`) for the Work tab and board, moves, comments and links.
- **Code: Read** (`vso.code`) for pull request chips and for linking a pull request. Without it, chips are off for that organisation and the Work tab says so.

The identity check that pins your account hasn't been confirmed against a minimal PAT yet, and the Boards scopes haven't been checked live, so this list may change. More scopes will be listed here as features land.

## The Work tab

Open the Azure DevOps panel and choose **Work**. It needs a boards project and team for the organisation (see its settings).

- **My work** lists the items assigned to you, grouped by board column. Finished items are left out. Items of a type the board doesn't show are grouped under **Other** and move by state.
- Each card shows chips for its linked pull requests: the target branch with `✓` when merged, `● build` while a build runs, `✗ build` when it failed, and `abandoned`.
- **Move to** on a card moves the item to another column. Moving into a split column puts the item in Doing. A move is refused when someone else changed the item first: the item is refreshed and you try again.
- **Details** shows the description, acceptance criteria, comments, parent and links. You can add a comment, link a pull request by its URL, start a workspace or an agent, or open the item in Azure DevOps.
- **Open board** (the icon in the header) opens the full-tab board.

### Suggest moves

Off until you add rules. In the organisation's settings, open **Suggest moves** and add rules that pair a branch with a column. When a pull request linked to an item merges into that branch, and the column is further along than the item's, the Work tab offers to move the item there (`Move to <column>`) or dismiss the suggestion. Rules are saved per team.

## The board

The board opens in its own tab as a custom editor for `.adoboard` files.

- Drag a card to another column or lane to move it. The card shows in its new place while the move is sent, and returns with a message if Azure DevOps refuses it.
- Swimlanes collapse and expand. When a board has several lanes, all but the first start collapsed.
- **Me** and **Everyone** switch between your items and the whole team's. The **Parent** list filters to the children of one parent.
- It refreshes every 30 seconds while the tab is visible.

**Open board** in the Work tab writes `<workspace>/.orca-ado/<org>.<teamId>.adoboard` in your focused workspace and opens it. The `.orca-ado/` folder holds a `.gitignore` containing `*`, so git never sees it. This needs a local workspace. Without one, use **+ → Azure DevOps board**, which opens the editor and asks which board.

## Workspaces and agents

These use the workspace and agent permissions Orca asks you to approve.

- **Start a workspace** names the branch from your branch template and arms it. The next worktree you create in Orca within 10 minutes gets that branch and name, once. The new workspace is linked to the item.
- **Start an agent** launches your default agent in the item's workspace, or in the focused workspace when the item has none. The prompt is the item's link, description and acceptance criteria.
- With **Add work item context to agent prompts** on, the first prompt Orca sends to an agent in a linked workspace (a launch prompt, a task or an orchestration dispatch) starts with a link to the item. Prompts you type are never changed, and later prompts in the same terminal are left alone.

## Polling

- My work: every 60 seconds while the Work tab is visible, every 5 minutes otherwise.
- An open board: every 30 seconds while visible.
- PR chip status: cached for 2 minutes.
- When Azure DevOps rate-limits the plugin, polling pauses and the last data stays on screen.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.
- `defaultAgent` (Default agent): the agent **Start an agent** launches, such as `claude` or `codex`. Defaults to `claude`.
- `agentContext` (Add work item context to agent prompts): off by default.
- `branchTemplate` (Branch name template): defaults to `feature/{id}-{slug}`. `{id}` is the work item id. `{slug}` is its title in lower case, with other characters turned into hyphens, cut to 40 characters.

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

## License

[MIT](LICENSE)
