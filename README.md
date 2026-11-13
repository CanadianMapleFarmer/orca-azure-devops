# Azure DevOps for Orca

![Azure DevOps for Orca: a board you can work in, one-click agents, and pull requests, pipelines and wikis](assets/cover.jpg)

Azure DevOps work items, pull requests, pipelines and wikis in the [Orca](https://github.com/stablyai/orca) sidebar, a full-tab board you can work in, and a workspace and agent started from any item in one click. Connect any number of organisations with the Azure CLI, a Microsoft account or a personal access token, and each one stays pinned to the account you signed in with.

Unofficial: not made or endorsed by Microsoft. Azure DevOps is a trademark of Microsoft.

## Install

Find **Azure DevOps** in Orca's plugin list ([catalog page](https://onorca.dev/plugins/kloppers-labs/orca-azure-devops)), or run:

```bash
orca plugin install kloppers-labs/orca-azure-devops
```

Orca lists what the plugin may do before you approve it, and [Permissions](docs/reference.md#permissions) explains each item. Starting a workspace or an agent from an item runs one line in a terminal of yours (`terminal:send`): an `orca` command, or for a repository it clones, `git clone`, `orca repo add` and `orca worktree create`. The plugin runs its own code with your account's access; community plugins are checked by machine, not reviewed by the Orca team. `orca plugin update` fetches newer releases.

Then open **Azure DevOps** in Orca's sidebar and connect an organisation, as [Connecting and signing in](docs/connecting.md) describes.

## What it does

- **Work:** your items by board column or by the board's own swimlanes, with their tasks inside them and a compact Move; a full-tab team board with drag-and-drop, where a card opens its details, tasks and comments beside the board to comment, reassign, and tick off or add tasks; a workspace and an agent started in one click from an item in the sidebar or a card on the board, in any repository in Orca or one it clones from Azure DevOps. [Work guide](docs/work.md)
- **Pull requests:** release sets grouped by project, **Mine** and **To review**, Approve and Auto-complete, sharing to Teams or the clipboard, and PR reviews with diffs, votes and comment threads. [Pull requests guide](docs/pull-requests.md)
- **Pipelines:** your runs grouped by project with their stages, approvals you can give or share, and a full-tab run view with a live log and an error summary. [Pipelines guide](docs/pipelines.md)
- **Wiki:** a page tree, search, Open in tab with Mermaid diagrams drawn, and Edit in Orca with a Publish that handles conflicts. [Wiki guide](docs/wiki.md)
- **Everywhere:** desktop notifications, `ADO · N failed · N approvals · N to review` on the status bar, and proxy and certificate settings for restricted networks. [Reference](docs/reference.md)

## Screenshots

<table>
  <tr>
    <td colspan="2"><img src="assets/screenshots/board.jpg" alt="The full-tab board with a card's details open: description, tasks, a pull request and its check, a comment and the start footer"></td>
  </tr>
  <tr>
    <td colspan="2">A board you can work in: open a card to comment, reassign, tick off tasks or start an agent.</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/work.jpg" alt="The Work tab by board column, and an item's details with Clone from Azure DevOps and Start a workspace and agent"></td>
    <td width="50%"><img src="assets/screenshots/pull-requests.jpg" alt="The PRs tab with release sets grouped by project, and the To review list"></td>
  </tr>
  <tr>
    <td>Start a workspace and agent from any item, in a repository in Orca or one it clones.</td>
    <td>Pull requests grouped by project, ready to share, approve or review.</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/pipelines.jpg" alt="The Pipelines tab with runs, their stage chips and a production approval"></td>
    <td width="50%"><img src="assets/screenshots/wiki.jpg" alt="The Wiki tab with the page tree, drafts and a page with diagram and table cards"></td>
  </tr>
  <tr>
    <td>Every run with its stages, and approvals you can give or share.</td>
    <td>Browse and edit wikis; Open in tab draws Mermaid diagrams full width.</td>
  </tr>
</table>

## Requirements

- Orca 1.4.256 or later.
- To start a workspace or an agent from an item: macOS or Linux, with bash or zsh as your shell.
- For Azure CLI sign-in: Azure CLI 2.54 or later.
- For Sign in with Microsoft: an app registration an admin creates once, as [Registering the app (for admins)](docs/connecting.md#registering-the-app-for-admins) describes. Without one, use the Azure CLI or a personal access token.

## Documentation

- [Connecting and signing in](docs/connecting.md): the three ways to connect, PAT scopes, troubleshooting, registering the app, and proxies and certificates
- [Work, the board and agents](docs/work.md)
- [Pull requests, sharing and reviews](docs/pull-requests.md)
- [Pipelines and runs](docs/pipelines.md)
- [The Wiki tab](docs/wiki.md)
- [Notifications, polling, settings and permissions](docs/reference.md)
- [Development](docs/development.md): building, testing, and the live checks still pending

## Feedback and security

Report problems and ideas in [Issues](https://github.com/kloppers-labs/orca-azure-devops/issues). Never paste a token, a sign-in code or a Teams webhook URL there. Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
