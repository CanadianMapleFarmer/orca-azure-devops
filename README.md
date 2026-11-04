# Azure DevOps for Orca

Azure DevOps boards, pull requests, pipelines and wikis inside [Orca](https://github.com/stablyai/orca) (see Status).

**Status: under construction.**

| Works now | Coming |
| --- | --- |
| Connecting any number of Azure DevOps organisations | Boards |
| Pinning each organisation to one account | Pull requests and sharing them |
| Choosing each org's boards project, team and code projects | Pipelines |
| An always-on worker and an `ADO` status bar item | PR reviews |
| | Wiki |

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

The identity check that pins your account hasn't been confirmed against a minimal PAT yet, so this list may change. More scopes will be listed here as features land.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.

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
