# Azure DevOps

An Orca plugin that puts Azure DevOps in the sidebar: sign in once per organisation with the Azure CLI or a personal access token, then work with boards, pipelines, pull requests and wikis next to your workspaces. Tokens stay in Orca's secrets or in a private Azure CLI profile folder, and are never written to logs or plugin storage.

Status: under construction.

Development: `npm run typecheck` writes the Orca typings into `.orca/types/` (downloading them from `stablyai/orca` when the installed Orca ships without them) and runs `tsc`.
