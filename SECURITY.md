# Security

This plugin handles Azure DevOps credentials: Azure CLI sign-ins, Microsoft sign-in tokens and personal access tokens. Please report anything that could expose them, or let a page, a pull request or a wiki reach outside what it should.

## Reporting a vulnerability

Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. Please don't open a public issue for a security problem.

Include what you found, how to reproduce it, and the plugin commit or version. Never include a real token, sign-in code or Teams webhook URL; describe where one appeared instead.

## In scope

- Tokens, codes or webhook URLs reaching logs, plugin storage outside Orca's secret store, the panel, notifications or error messages.
- The Microsoft sign-in flow and its local redirect listener.
- Paths: wiki drafts, run files and Open in Orca writing or opening files outside the workspace.
- Markdown from Azure DevOps (pull request descriptions, comments, wiki pages) producing unsafe links or content.
