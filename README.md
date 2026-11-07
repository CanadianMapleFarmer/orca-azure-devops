# Azure DevOps for Orca

Azure DevOps work items, boards, pull requests, pipelines and wikis in the [Orca](https://github.com/stablyai/orca) sidebar. Connect any number of organisations with the Azure CLI, a Microsoft account or a personal access token, and the plugin keeps each one pinned to the account you signed in with.

Unofficial: not made or endorsed by Microsoft. Azure DevOps is a trademark of Microsoft.

| Works now |
| --- |
| Connecting any number of Azure DevOps organisations |
| Pinning each organisation to one account |
| Sign in with Microsoft, and proxy and certificate settings for restricted networks |
| Choosing each org's boards project, team and code projects |
| An always-on worker and an `ADO` status bar item |
| A Work tab with your items, grouped by board column |
| A full-tab team board with drag-and-drop |
| Starting a workspace or an agent from a work item |
| A PRs tab with your pull requests in release sets, plus Approve all and Auto-complete all |
| Sharing pull requests to the clipboard, a Teams channel, a Teams chat and reviewers |
| PR reviews: the description, reviewers, votes, numbered file diffs, comment threads and Check out in Orca |
| A Pipelines tab with your runs, their stages and the approvals waiting on them |
| A full-tab run view with a live log tail, search, errors only and an error summary |
| Approving or rejecting an environment approval, rerunning a failed stage and cancelling a run |
| Sharing an approval to the clipboard, a Teams channel, a Teams chat or email |
| Desktop notifications for failed runs, watched runs, approvals, review requests and new comments on your pull requests |
| Wiki: a page tree, search and rendered pages, with Edit in Orca and Publish that handles conflicts |
| `ADO · N failed · N approvals · N to review` on the status bar |

## Requirements

- Orca 1.4.248 or later.
- For Azure CLI sign-in: Azure CLI 2.54 or later. Older versions don't return the numeric `expires_on` from `az account get-access-token`, which the plugin needs.
- For Sign in with Microsoft: an app registration in Microsoft Entra ID, which an admin creates once (see Registering the app (for admins)). Without one, use the Azure CLI or a personal access token.

## Connecting an organisation

Open the Azure DevOps panel in the Orca sidebar, enter the organisation URL (`https://dev.azure.com/your-org`) and pick a method:

- **Azure CLI (no setup).** Works on macOS and Linux: the plugin runs `az login` in your browser, where you pick the account. On Windows, use a personal access token for now.
- **Microsoft account (needs an app ID).** Signs in with Microsoft Entra ID through an app your admin registers once (see below). It doesn't need the Azure CLI, so it also suits Windows (not yet checked live).
- **Personal access token.** Paste a PAT.

Each organisation is pinned to the account you sign in with. The panel shows `signed in as <account>`, and a token for a different account is refused.

### Where credentials live

- **Azure CLI:** the plugin uses its own private `az` profile in `~/.orca-azure-devops/az/<org>`, owner-only (mode 0700) on macOS and Linux. It never touches your terminal's `az` or `~/.azure`. Azure CLI keeps its tokens, refresh tokens included, in a plain file there. Sign out deletes the folder.
- **Microsoft:** the refresh token for each organisation is kept in Orca's encrypted secrets, which needs an OS keyring; access tokens stay in memory and are renewed before they expire. Sign out deletes it. It doesn't sign you out of Microsoft in your browser.
- **PAT:** stored in Orca's encrypted secrets for this plugin. Sign out deletes it. This needs an OS keyring for Orca's encrypted secrets, which may be unavailable on some Linux setups.
- **Teams webhook URLs:** stored in the same encrypted secrets, one per channel. The panel can't read a URL back, and it never goes into logs, settings or messages. Sign out doesn't remove channels; **Remove** in the channel manager does.

### PAT scopes

What exists so far is expected to work with:

- **Project and team: Read** (`vso.project`) for the project and team lists.
- **Work Items: Read & write** (`vso.work_write`) for the Work tab and board, moves, comments and links.
- **Code: Read** (`vso.code`) for pull request chips, the PRs tab and linking a pull request. Without it, chips are off for that organisation and the Work and PRs tabs say so.
- **Code: Read & write** (`vso.code_write`) for Approve all, Auto-complete all and adding reviewers. It also covers the votes and comments in a pull request review.
- **Graph: Read** (`vso.graph`) and **Identity: Read** (`vso.identity`) for finding people to message, email or add as reviewers.
- **Build: Read & execute** (`vso.build_execute`) for the Pipelines tab and the run tab: runs, logs, rerun, cancel and approvals. Without Build access the tab says so and pauses for 10 minutes. Approvals may need a scope this list doesn't name yet. Without access to them the runs still load, and the tab says Needs me may be incomplete.
- **Wiki: Read & write** (`vso.wiki_write`) for the Wiki tab: reading pages and publishing edits. Search may need a further scope this list doesn't name yet.

The identity check that pins your account hasn't been confirmed against a minimal PAT yet, and the Boards, pull request, review, people-search, Pipelines and Wiki scopes haven't been checked live, so this list may change. More scopes will be listed here as features land.

## Sign in with Microsoft

This needs the app (client) ID of an app your admin registered (see Registering the app (for admins)). Do step 1 once, then steps 2 to 5 for each organisation.

1. Ask your admin for the app's **Application (client) ID** and paste it into the `entraClientId` setting (Settings → Azure DevOps → **Microsoft sign-in: app (client) ID**). It looks like `00000000-0000-0000-0000-000000000000`.
2. In the panel, enter the organisation, choose **Microsoft account (needs an app ID)** and press **Connect**.
3. Press **Open sign-in page**. Orca asks before opening `login.microsoftonline.com`; ticking "Always allow" skips that next time. Orca lets a plugin open a page only from a button you press, which is why sign-in takes two presses.
4. Pick the account in your browser. The tab says "You're signed in. You can close this tab and go back to Orca."
5. The panel shows `signed in as <account>`.

- The account picker shows every time. The organisation is pinned, and another account is refused. Nothing is saved for a refused account, and the message names both accounts.
- Cancel works at any time, and a sign-in stops after 5 minutes. While it waits, the plugin listens only on `127.0.0.1`, and only for that one sign-in. The port closes when the sign-in ends.
- Access tokens are renewed in the background. When Microsoft refuses a renewal (the sign-in expired or was revoked, consent was withdrawn, or your tenant now asks for another check such as MFA), the organisation shows `Your sign-in expired. Reconnect to continue.` Press **Reconnect**, then **Open sign-in page**.

### Troubleshooting

Microsoft shows many sign-in errors on its own page, with an `AADSTS` code. The plugin never sees those. Note the code, press **Cancel** in Orca and look it up here. Which codes Microsoft sends back to the plugin, and which it only shows on its page, hasn't been checked live yet. When the plugin gets one, it shows a plain message in the panel instead.

- `AADSTS50011`: the redirect address isn't registered for the app. Microsoft shows this on its own page. Your admin fixes it: add `http://localhost` under Mobile and desktop applications (see Registering the app (for admins), step 4).
- `AADSTS700016`: Microsoft can't find the app in this tenant. You fix it when the ID in `entraClientId` is mistyped. Your admin fixes it otherwise: allow "Accounts in any organizational directory" for the app (step 3), or register the app in this tenant.
- `AADSTS50020`: the account you picked is from another directory, such as a personal account or a guest from another tenant. You fix it: sign in again and pick the work account that belongs to the organisation's directory.
- `AADSTS90094`, `AADSTS90095` or `AADSTS65001`: an admin hasn't approved the app yet, or hasn't consented to the permissions it asks for. Your admin fixes it: **Grant admin consent** (step 7).
- `AADSTS650057`: the app registration doesn't list the Azure DevOps permission. Your admin fixes it: add `user_impersonation` under Azure DevOps (step 6), then grant consent again.
- `AADSTS7000218`, `AADSTS9002326` or `AADSTS9002327`: Microsoft treats the app as a web or single-page app, so it asks for a secret or refuses the redirect. Your admin fixes it: move `http://localhost` to **Public client/native (mobile & desktop)** (step 4). If `AADSTS7000218` stays with the redirect already there, turn on **Allow public client flows** (step 5).

The plugin's own messages:

- `Sign-in was cancelled in the browser.` You pressed Cancel or declined the permissions on Microsoft's page (`AADSTS65004`). You fix it: press **Connect** (**Reconnect** for an organisation you've already added) and try again.
- `Couldn't reach Microsoft sign-in.` There was no answer from `login.microsoftonline.com`, or Microsoft was briefly unavailable. You fix it by checking your connection and Proxies and certificates, then trying again. If the network blocks Microsoft, your network admin fixes it.
- `Microsoft sign-in returned an unexpected response.` Something between you and Microsoft, such as a proxy or a network sign-in page, may have answered instead. Try again first. Your network admin fixes it if it repeats.
- `Set the app (client) ID for Microsoft sign-in in Settings → Azure DevOps. The README explains how an admin creates it.` The `entraClientId` setting is empty. You fix it by pasting in the ID your admin gives you.
- `The app (client) ID in Settings → Azure DevOps isn't a valid ID. Copy it again from the app registration.` It must be the whole **Application (client) ID** from Overview. You fix it by copying it again.
- `The Microsoft sign-in tenant in Settings → Azure DevOps isn't a tenant ID or domain.` The `entraTenant` setting holds something else. You fix it by entering a tenant ID or a domain such as `your-tenant.onmicrosoft.com`, or by emptying it.
- `Couldn't start the sign-in on this computer. Try again.` The plugin couldn't open its listener on `127.0.0.1`. You fix it by trying again. If it repeats, security software may be blocking local listeners.
- `Couldn't keep the sign-in in Orca's encrypted secrets.` Orca's encrypted secrets need an OS keyring (see Where credentials live), and the sign-in isn't kept without one. You fix it by setting up a keyring.
- `Couldn't save a renewed Microsoft sign-in; the previous one is kept.` This goes to the plugin's log, not the panel. A renewal worked but couldn't be saved. You fix it by reconnecting if the organisation later shows expired.
- `Microsoft sign-in failed (<code>).` Microsoft refused with a code that isn't listed above. Your admin fixes it in most cases, so send them the code.

A sign-in stuck on a Microsoft error page, or left in a tab you closed, doesn't end by itself. Press **Cancel** in Orca rather than leaving it to time out, which takes 5 minutes and ends with `Sign-in timed out. Try again.`

## Registering the app (for admins)

Sign in with Microsoft needs one app registration in your Microsoft Entra tenant. You register it once, and everyone who signs in uses its app (client) ID. It needs no client secret or certificate.

The labels below haven't been checked against the live portal yet, and Microsoft renames things, so look for the closest match.

1. In the Microsoft Entra admin center, open **App registrations → New registration**.
2. Name it, for example "Azure DevOps for Orca".
3. **Supported account types:** "Accounts in this organizational directory only" when every Azure DevOps organisation your people use is in this tenant; "Accounts in any organizational directory" when they also sign in to organisations in other tenants. Each of those tenants' admins then consents once.
4. **Redirect URI:** platform "Public client/native (mobile & desktop)", value `http://localhost`. Register. Not Web or Single-page application: those make Microsoft ask for a secret or refuse the sign-in. Add no port: Microsoft ignores the port for `localhost`, and the plugin picks a free one for each sign-in.
5. *(Optional, pending the live check.)* **Authentication → Advanced settings → Allow public client flows.** The browser sign-in doesn't need it while `http://localhost` is under Mobile and desktop applications; turn it on only if sign-in reports `AADSTS7000218` with the redirect already there.
6. **API permissions → Add a permission → APIs my organization uses →** search "Azure DevOps" (`499b84ac-1321-427f-aa17-267ca6975798`) **→ Delegated → `user_impersonation` → Add.** Keep Microsoft Graph `User.Read`.
7. If people in your tenant can't consent to apps themselves, **Grant admin consent for `<your tenant>`**.
8. Copy the **Application (client) ID** from Overview and give it to your developers. Don't create a client secret or certificate.

Three notes:

- The organisation must be connected to Microsoft Entra ID; organisations that use personal Microsoft accounts need the Azure CLI or a PAT.
- Conditional Access applies as for any sign-in.
- Removing consent, or deleting the registration, stops every saved sign-in, which then asks to reconnect.

## Proxies and certificates

Orca doesn't pass `HTTPS_PROXY`, `NO_PROXY` or `NODE_EXTRA_CA_CERTS` from your environment to plugins, and a worker can't pick them up once it is running. So the plugin has its own settings, in Settings → Azure DevOps, and applies them itself.

- `httpsProxy`: an `http://` or `https://` proxy address, such as `http://proxy.example.com:8080`. All the plugin's HTTPS traffic goes through it. Traffic to this computer (`localhost`, `127.0.0.1` and `::1`) never does. Proxies that need a password aren't supported, because settings are stored in plain text, and an address that carries a user name or password is ignored.
- `caCertificatesFile`: the full path to a PEM file of extra certificates to trust (`~` isn't expanded), up to 1 MiB, for networks that inspect TLS. The plugin trusts them as well as the certificates it already trusts.
- `useSystemCertificates`: also trust the certificates your operating system trusts. It may be enough where the certificate of the inspecting proxy is installed on the computer.

A change to any of them is picked up when you save it. A change to the certificate settings reaches new connections only; connections already open keep the certificates they started with.

`az` uses the proxy but not the certificate settings, so behind TLS inspection use Sign in with Microsoft or a PAT. The plugin gives `az` the proxy in its environment. It doesn't give it the certificates, because that would replace the trust store `az` already has.

**Azure DevOps: Connection status** lists any setting that was ignored, and why. A setting is ignored when the proxy address isn't `http://` or `https://`, when it carries a password, when the certificates file can't be read or isn't a PEM file of certificates, or when this Orca can't apply it. An Orca too old to apply a proxy or certificate setting says so there. While the proxy is in use, it shows `Using the HTTPS proxy from Settings.` If it shows `Couldn't apply the network settings.`, Orca refused a setting the plugin had already checked: save the setting again, and report it if it happens again.

## The Work tab

Open the Azure DevOps panel and choose **Work**. It needs a boards project and team for the organisation (see its settings).

- **My work** lists the items assigned to you, grouped by board column. Finished items are left out. Items of a type the board doesn't show, and items of a board type that aren't in a board column, are grouped under **Other** and move by state.
- Each card shows chips for its linked pull requests, one per target branch: the branch with `✓` when merged, `● build` while a build runs, `✗ build` when it failed, and `abandoned`. When several pull requests target the same branch, the chip shows the merged one, else an open one (a failed build first, then a running one), else an abandoned one. A card shows up to four chips and counts the rest; the board and the details show them all.
- **Move to** on a card moves the item to another column. Moving into a split column puts the item in Doing. A move is refused when someone else changed the item first: the item is refreshed and you try again.
- **Details** shows the description, acceptance criteria, comments, parent and links, with each linked pull request's state. You can add a comment, link a pull request by its URL, start a workspace or an agent, or open the item in Azure DevOps.
- **Open board** (the icon in the header) opens the full-tab board.

### Suggest moves

Off until you add rules. In the organisation's settings, open **Suggest moves** and add rules that pair a branch with a column. When a pull request linked to an item merges into that branch, and the column is further along than the item's, the Work tab offers to move the item there (`Move to <column>`) or dismiss the suggestion. Rules are saved per team.

## The board

The board opens in its own tab as a custom editor for `.adoboard` files.

- Drag a card to another column or lane to move it. The card shows in its new place while the move is sent, and returns with a message if Azure DevOps refuses it.
- Swimlanes collapse and expand. When a board has several lanes, all but the first start collapsed.
- **Me** and **Everyone** switch between your items and the whole team's. The **Parent** list filters to the children of one parent.
- It refreshes every 30 seconds while the tab is visible. When a refresh fails, the board keeps the last loaded items and says why, until a refresh succeeds.
- A board with more items than one answer holds (500 items, or 900 KiB) shows the most recently changed ones and says how many.

**Open board** in the Work tab writes `<workspace>/.orca-ado/<org>.<teamId>.adoboard` in your focused workspace and opens it. The `.orca-ado/` folder holds a `.gitignore` containing `*`, so git never sees it. This needs a local workspace. Without one, use **+ → Azure DevOps board**, which opens the editor and asks which board.

## Workspaces and agents

These use the workspace and agent permissions Orca asks you to approve.

- **Start a workspace** names the branch from your branch template and arms it. The next worktree you create in Orca within 10 minutes gets that branch and name, once. The new workspace is linked to the item. **Cancel** in the message disarms it, so the next worktree is created as you set it up. The message goes away by itself when a new workspace takes the branch, another arm replaces it or the 10 minutes are up.
- **Start an agent** launches your default agent in the item's workspace, or in the focused workspace when the item has none. The prompt is the item's link, description and acceptance criteria.
- With **Add work item context to agent prompts** on, the first prompt Orca sends to an agent in a linked workspace (a launch prompt, a task or an orchestration dispatch) starts with a link to the item. Prompts you type are never changed, and later prompts in the same terminal are left alone.

## The PRs tab

Open the Azure DevOps panel and choose **PRs**. It lists the pull requests you created in the organisation's code projects, grouped into release sets, and the ones waiting for your review or that you have already voted on.

### Release sets

A release set is a group of your pull requests that ship together. Pull requests share a set when they:

- have the same source branch in the same repository, or
- are linked to the same work item.

The links chain: if one pull request shares a branch with a second, and the second shares a work item with a third, all three are one set. A set holds your active pull requests and the ones you completed in the last 14 days, shown as `merged ✓`. A set with no active pull request left disappears. Its title is the title of its lowest-numbered pull request, and the newest sets come first. Without enough access to read linked work items, sets form by source branch only and the tab says so.

Each row shows `Pull Request N` as a link, its target branch and chips:

- `draft`, `conflicts` and `merged ✓`.
- Build: `● build` while running, `✓ build`, `✗ build`.
- Policies: `✗ policies`, and `· policies` while some are pending.
- Votes: `N approved`, `N rejected`, `N waiting for author` for reviewers who voted Waiting for author, and `waiting for …` for required reviewers who haven't voted or declined.
- `auto-complete` when it is set.

The tab shows the 30 newest sets and up to 150 rows, and says when it leaves some out. **Refresh** (the icon in the header) reloads now.

### Approve all

**Approve all** votes Approved, as you, on every active pull request in the set. It skips completed, abandoned and draft pull requests, and ones you have already approved. Any other vote of yours on the rest (waiting for the author, rejected, approved with suggestions) is replaced.

Each row reports its own result. When Azure DevOps refuses one, the others still go through and that row shows the error.

### Auto-complete all

**Auto-complete all** sets auto-complete, as you, on every active pull request in the set. It uses the three auto-complete settings (merge type, delete the source branch, complete linked work items) and never bypasses policies. It skips completed, abandoned and draft pull requests, and leaves one that is already set to auto-complete as it is.

Pull requests in a set often share one source branch. With "delete the source branch" on, the first one to merge would delete the branch the others still need. So when another active pull request in the same repository uses the same source branch, auto-complete is set with the branch kept, and the row says which pull request also uses it.

- The plugin asks Azure DevOps for the active pull requests on the branch at that moment. If the check fails, it keeps the branch and says so.
- If another pull request is already set to delete the shared branch when it completes, the row warns you. Turn that off in Azure DevOps; the plugin doesn't change it.

### To review

Below the sets, a collapsed **To review (N)** list shows the active pull requests waiting for you. You are named as a reviewer yourself and haven't voted or declined, you didn't create it and it isn't a draft. A pull request that reaches you only through a group isn't listed or counted. The count shows on the status bar (see The status bar).

**Reviewed by you**, inside the same fold, lists the active pull requests you have voted on: active, not a draft, not created by you, you voted and haven't declined. Each row shows your vote. It holds up to 50, and it isn't part of the count. The lists refresh after you vote.

Click a row in either list to open the review in the tab (see Reviewing a pull request).

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
2. In Orca, open the PRs tab and choose **Teams channels** (the settings icon in the header), or choose **Manage channels** in the composer.
3. Enter a channel name and paste the URL, then press **Add channel**. The URL must be https. Names are unique and up to 100 characters, and you can add up to 20 channels.
4. **Test** posts a test message. **Replace URL** swaps in a new webhook when the workflow changes. **Remove** asks you to confirm.

Channels are shared by all your organisations. Which ones you post to is remembered per organisation.

## Reviewing a pull request

Click a row in **To review** or **Reviewed by you** to open the review in the PRs tab. **Back** returns to the list. **Refresh** (the icon in the header) reads the pull request again. The tab remembers which review is open.

The header shows the title, `Pull Request N`, the repository, the source and target branches, who opened it and when, and when it was loaded. Chips show `draft`, `conflicts` and your own vote. **Open in Azure DevOps** opens it on the website. Under the header are the vote buttons, **Check out in Orca** and three sections:

- **Overview:** the description, the reviewers (up to 100) with their votes and whether each is required, and a box to add a general comment.
- **Files:** the changed files and their diffs (see The diff).
- **Comments:** the comment threads (see Comments and replies).

### Votes

**Approve**, **Approve with suggestions**, **Wait for author** and **Reject** vote as you. The button for your current vote is filled. A new vote replaces your earlier one. Pressing the vote you already have changes nothing and says so.

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
- Arming replaces an earlier arm, including one from **Start a workspace** on a work item.
- The workspace takes the branch name as its name.
- **Cancel** disarms it, and never a later arm that replaced it. The box goes away by itself when a new workspace takes the arm, another arm replaces it or the 10 minutes are up. A panel reload removes only the box: the arm still serves the next new workspace until it expires.
- When a local branch of the source's name exists and Orca has never fetched the remote's copy, Orca bases the workspace on that local branch as it is, without fetching. It may be behind, or hold commits you haven't pushed.

## The Pipelines tab

Open the Azure DevOps panel and choose **Pipelines**. It lists pipeline runs in the organisation's code projects, the same projects the PRs tab reads, and the approvals waiting on them. Runs that haven't finished come first, newest first. Finished runs follow, newest finish first. **Refresh** (the icon in the header) reloads now.

### Which runs show

For each code project the plugin reads:

- your runs from the last 7 days (the newest 50),
- the runs in progress, whoever started them (the newest 25),
- the pending approvals and the runs they belong to,
- the runs you are watching.

A run is yours when Azure DevOps names you as who it was requested for. The tab lists up to 30 runs for the filter you pick and says how many it leaves out. The plugin itself keeps the newest 100 runs and says when it trims.

### Filters

The filter you pick is remembered. The counts on **Needs me** and **Failed** are this organisation's share of the numbers on the status bar.

- **Mine:** your runs from the last 7 days.
- **Running:** every run that hasn't finished, whoever started it: queued, running, waiting for approval or cancelling.
- **Needs me:** runs with a pending approval you can give, and your own runs while they wait for an approval.
- **Failed:** your runs that failed in the last 24 hours. A run leaves this list when a newer run of the same pipeline and branch is queued, in progress or has succeeded (even with issues).

### A run card

Each card shows the pipeline, the run number, the branch, `PR N` when a pull request started it, and who requested it. A badge gives its state: queued, running, waiting for approval, cancelling, succeeded, partially succeeded, failed or canceled. It also says when the run was queued, started or finished.

- **Open run** opens the run tab (see The run tab).
- **Open in Azure DevOps** opens the run on the website.
- **Watch** (the bell) is described next.

The stage bar has one segment per stage, coloured by its state, and a line below it with the stage names: `Build ✓ · Image ✓ · Deploy production ⏸`. The marks are ✓ succeeded, ✗ failed, ● running, ⏸ waiting for approval, ! succeeded with issues, ⊘ canceled, – skipped and ○ not started. Up to 12 stages show.

The stages come from each run's timeline. A load reads them for up to 8 runs in progress and up to 8 finished runs it hasn't read yet, and keeps what it read, so a long list fills in over the next loads. Until then a run has no bar.

### Watching a run

**Watch** works on a run that hasn't finished. A watched run is read every 30 seconds, and you get a notification when it finishes, whoever started it. Watching ends by itself at the finish. You can watch up to 20 runs per organisation, and the list is kept when Orca restarts.

### Approvals

A run waiting at an environment check shows a **Waiting for approval** box. It says where the run waits (the environment, else the stage), how long it has waited, and who can approve. People are listed by name and groups as `(group)`, with `· needs N` when more than one approval is required. Instructions the approval carries show too, cut at 500 characters.

**Approve…** and **Reject…** show only when Azure DevOps says you can decide: you hold the approval permission, or the approval is assigned to you. Pressing one opens an optional comment (up to 1,000 characters). A second press on **Approve** or **Reject** sends it. The plugin never decides for you.

- It reads the approval again just before sending. If it is no longer pending, the result says so and nothing is sent.
- It sends one request and never retries.
- When the approval needs more people, the result says how many: "Approved. It still needs 1 more approval."
- When Azure DevOps refuses, the result shows its message.

### Share for approval

**Share for approval** opens the composer with one line for that approval. Add an intro, check the preview and tick where it goes. Each destination reports its own result. Destinations and people are remembered per organisation, apart from the ones you use for pull requests.

- **Copy as rich text**, **Post to a Teams channel** and **Message in Teams** work as described under Sharing, with the same channels. **Teams channels** in the tab's header manages them.
- **Email** opens a draft in your mail app. The subject is `Approval needed: <pipeline> <run>` and the body is the message. Pick people with **Find people to email**. A link over 2,000 characters isn't opened, and the composer suggests Copy.
- The approvers who are people, apart from you, show as suggestions in both people lists. Groups aren't suggested, and neither is anyone Azure DevOps lists without a sign-in name, since a link can't reach them.
- Orca opens one link per press. With Teams chat and email both chosen, the chat opens first and **Open email** opens the draft.
- There is no **Add as reviewers** for approvals.

The message has one line, built from the `approvalShareTemplate` setting. The default is `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`.

- Placeholders: `{pipeline}`, `{run}`, `{url}`, `{environment}`, `{stage}`, `{branch}`, `{requestedBy}` and `{project}`. `{url}` is the run's address in Azure DevOps.
- `{environment}` falls back to the stage name when the environment couldn't be read.
- The rules under Sharing apply: one link, its text can't be empty, its address must be http or https, a line break in a value becomes a space, and an empty or invalid template falls back to the default.

## The run tab

**Open run** opens the run in its own tab, a custom editor for `.adorun` files.

It writes `<workspace>/.orca-ado/<org>.<buildId>.adorun` in your focused workspace and opens it. The file holds only the organisation, the project and the run id. The `.orca-ado/` folder is the one the board uses, and its `.gitignore` containing `*` keeps git out. Opening a run also deletes `.adorun` files there that haven't been opened for 7 days. This needs a local workspace. Without one, the button says so.

### What the tab shows

- A strip of the run's stages, each with its state and duration. The tab starts on the failed stage, else the one that is running or waiting, else the last one. It stays on the stage you click.
- The jobs and steps of that stage, each with its duration and its error and warning counts.
- The log of the selected step, with an **Errors** box above it when a step failed.
- A toolbar with the state, **Watch**, **Rerun failed stage**, **Cancel run** and **Open in Azure DevOps**.
- For a stage waiting for approval, the approvers, the waiting time and **Approve…** and **Reject…** work as in the Pipelines tab. To ask someone, use **Share for approval** there.

The tab refreshes every 5 seconds while the run is active and every minute once it has finished. When a refresh fails, it keeps what it has and says why. When the run no longer exists, or you can't see it, it says so and stops refreshing.

### The log

- A step's log shows when Azure DevOps publishes it, which may be only after the step ends. Until then the step says so.
- The tab reads a log only for the step you select, and reads it again when it has grown. The first read is the newest 1,000 lines. **Follow** keeps the view at the end and turns off when you scroll up. **Load earlier** reads 1,000 older lines.
- If a log grows by more than 1,000 lines between reads while you follow, the view jumps to the newest 1,000 lines.
- The tab holds up to 50,000 lines of a log and cuts lines over 2,000 characters with `…`.
- Colour codes show as colour. Other terminal codes are dropped, and log text is never read as markup. A line's timestamp shows as its tooltip.
- **Search the log** looks through the lines the tab holds. Enter goes to the next match and Shift+Enter to the previous one. It ignores case unless your query has a capital letter.
- **Errors only** keeps the error lines: `##[error]`, an `error:` or `error CS1234:` style prefix, `FAILED` and `fatal:`. They are found by these patterns, never by tool or stage name.

### Errors and Open in Orca

When a step failed, the **Errors** box lists the errors Azure DevOps recorded for it and up to 20 error lines from its log, once that log is loaded. The step's path selects it.

- **Jump to line** scrolls the log to that line.
- **Open in Orca** opens the file an error names. It shows when the message holds a file: `path(12,5): error …`, `path:12:5` or a Python `File "path", line 12`.

Open in Orca looks for the file in your local workspaces. It picks the ones whose git remote is the run's Azure Repos repository, preferring one on the run's branch, then the focused one. For a run from another kind of repository it uses the focused local workspace. Agent paths carry the agent's folders, so the plugin tries the path with its leading folders dropped one at a time, longest first, and opens the first file that exists.

- Nothing outside the workspace opens. A path with `..` is refused. An absolute path is tried only as a path inside the workspace, and a symlink that points out of it isn't followed. When nothing matches, the message says the file wasn't found.
- Orca opens the file without a line number. The tab shows what it opened: `Opened src/Api/Program.cs, line 12.`
- Workspaces on a remote host are skipped.
- A workspace whose git remotes can't be read, because git failed or took over 5 seconds, is skipped and the others are still searched.

### Rerun and cancel

- **Rerun failed stage** shows for a finished run with a failed or canceled stage. It reruns the selected stage when that one qualifies, else the first that does. It asks Azure DevOps to retry the stage, without forcing every job to run again. A run with no stages, whose jobs sit under **All jobs**, can't be rerun here.
- **Cancel run** shows while the run hasn't finished and isn't already cancelling. It takes two presses: **Cancel run**, then **Confirm cancel**. The button disarms when it loses focus.
- Both read the run first and report what Azure DevOps did, and neither retries.

## The Wiki tab

Open the Azure DevOps panel and choose **Wiki**. It lists the project wikis and the published code wikis in the organisation. With more than one, a **Wiki** picker shows `name · project`, and your choice is remembered for each organisation.

### Reading

- The page tree loads a level at a time: expanding a folder reads its pages. A level shows up to 200 pages, in Azure DevOps's order and then by title. The tree draws up to 1,000 rows and says when it hides some. **Refresh pages** reloads the tree. **Refresh** on an open page reloads only that page.
- **Search the wiki** needs at least 2 characters. Press Enter to search. It shows up to 25 results, each with a snippet, and says how many pages match. **Clear search** returns to the tree. When the organisation has no wiki search, the tab says so.
- A page is shown as Markdown. Images appear as links, not as pictures, named `Image: <name>`; a reference-style image (`![text][ref]`) keeps its own text. An image at a web address links to that image; an attachment image links to the page in Azure DevOps, where it shows. Links to other wiki pages open that page in Azure DevOps. Only `http`, `https` and `mailto` links are kept, `[[_TOC_]]` is dropped, and a page over 60,000 bytes is cut with a note.
- **Open in Azure DevOps** opens the page on the website.

A code wiki is a folder of a repository published as a wiki. Its pages are read-only here: the page says so and has no **Edit in Orca**. Edit its files in the repository. Search finds only pages inside the published folder.

### Edit in Orca

**Edit in Orca** on a project wiki page opens the page as a Markdown file in Orca's own editor. It needs a local workspace in focus.

- The file is `<workspace>/.orca-ado/wiki/<organisation>/<wiki>/<page path>.md`. It is a draft. The `.orca-ado/` folder is the one the board and run tabs use, and its `.gitignore` containing `*` keeps git out. File names are cleaned so they are valid on every OS, and a very long one is cut and gets a short hash. A copy of the page as you started it is kept under `.orca-ado/wiki/.base/`.
- Save your changes in the editor, then press **Publish** in the Wiki tab. Publish, **Open** and **Discard** are on the draft's card under **Drafts (N)**, above the page tree. On a page, press **Back** to reach them. Publish sends what is saved in the file, not edits you haven't saved.
- **Drafts (N)** lists your drafts with their page, wiki, workspace and file, and whether they hold saved changes that aren't published. That status is as of the last time the list loaded; Publish always reads the saved file. You can keep up to 50 drafts across all organisations. A draft stays after you publish it, so you can keep editing. **Discard…** asks first, then deletes the draft's files. It sends nothing to Azure DevOps.
- **Edit in Orca** on a page that has a draft opens that draft again. When you haven't changed it, it is first brought up to the page's current version.
- A draft belongs to the workspace it was made in. When that workspace is gone, discard the draft to edit the page again. A page over 1 MiB can't be edited or published here.

### Publish

**Publish** reads your draft's file, then reads the page again.

- With no saved changes in the draft, it says `Nothing to publish yet` and sends nothing.
- When the page changed in Azure DevOps since you started, it sends nothing and shows the conflict. A change of version with the same text isn't a conflict.
- Otherwise it sends one request with the page's version (its ETag, in `If-Match`), so Azure DevOps refuses it if someone saves in between. A refusal of that kind shows the conflict too.

It never retries and never deletes your draft. When the page was moved or deleted in Azure DevOps, Publish says so and keeps the draft.

### When the page changed

The conflict shows **Their changes** (your starting copy to the current page) and **Your changes** (your starting copy to your draft) as diffs, under the same size rules as review diffs. Choose one:

- **Publish mine…** publishes your draft over their changes, after you confirm. Their changes are lost.
- **Take theirs…** replaces your draft with their version, after you confirm. Your changes are lost.
- **Merge by hand** opens their version in the editor, as a file under `.orca-ado/wiki/.theirs/`. Copy what you need into your draft, save it and press **Publish**. Until you save a change, Publish shows the conflict again and says your draft hasn't changed. **Publish mine** is still there.

## Notifications

The plugin shows desktop notifications through Orca whenever Orca is open, with the Pipelines and PRs tabs hidden too. The background poll runs every 5 minutes, so one can arrive a few minutes late.

It notifies when:

- one of your runs fails: `<pipeline> failed`, with the organisation, run number, branch and, when it is known, the stage that failed (`notifyRunFailures`);
- a run waits for an approval that you can give, or one of your own runs waits for an approval: `<pipeline> is waiting for approval`, with where it waits and `You can approve it.` when you can (`notifyApprovals`);
- a run you watch finishes, whether it succeeded, finished with warnings, was canceled or failed (`notifyWatchedRuns`);
- someone asks for your review: `Review requested: Pull Request N`, with its title, author and repository, when a pull request newly appears in your To review list (`notifyReviewRequests`);
- someone else comments on one of your 20 newest active pull requests in an organisation: `New comment on Pull Request N`, with who wrote it and its first line as plain text (`notifyPrComments`). Several new comments on one thread make one notification, `<count> new comments on Pull Request N`, naming the latest. Your own comments, Azure DevOps's system comments (votes, policy updates) and deleted comments never count.

Each kind has a setting, on by default. See Settings.

- One notification per finish and per approval. When you rerun a stage and the run fails again, it notifies again.
- One notification per review request and per comment. A pull request that leaves To review and comes back doesn't notify again until the plugin restarts.
- Nothing for your runs that failed, or approvals that started waiting, before the plugin started. A watched run that finished while Orca was closed does notify, once, when the plugin next runs.
- The first load of an organisation after the plugin starts never notifies about pull requests: it only notes what is already waiting for your review and the comments already written. The same goes for the first load after you sign in or reconnect, the first read of a pull request's comments, and the first read after you turn `notifyPrComments` back on. A connection error that clears by itself, such as a sign-in renewal that runs before the network is back after sleep, keeps what was noted, so what arrived meanwhile still notifies.
- At most 3 per poll, then one more, `N more pipeline updates` or `N more pull request updates`, for the rest.
- Orca gives the plugin no click event, so a click is expected to open nothing (not yet checked on macOS). The text says where to look: the Pipelines tab or the PRs tab.

The plugin needs the `notifications:show` permission to show them. Orca asks you to approve it once, when the plugin first loads with it. Until you do, nothing shows. The plugin logs "Couldn't show a desktop notification." and doesn't retry.

## The status bar

The status bar item reads `ADO · N failed · N approvals · N to review`. Each part shows only when it isn't zero, so with nothing to report it reads `ADO`.

- `N failed` is the **Failed** filter's count.
- `N approvals` is the **Needs me** count, and reads `1 approval` for one.
- `N to review` is the pull requests waiting for your review, as in To review.

Each number adds up your connected organisations. The tooltip and **Azure DevOps: Connection status** break them down by organisation. The pipeline counts refresh with the Pipelines polling below.

## Polling

- My work: every 60 seconds while the Work tab is visible, every 5 minutes otherwise.
- An open board: every 30 seconds while visible.
- PR chip status: cached for 2 minutes, or an hour once the pull request is merged or abandoned.
- PRs tab: every 60 seconds while it is visible (your active and recently completed pull requests and your To review list, for each code project), every 5 minutes otherwise (the To review list, for the status bar and review notifications). Opening the tab shows data under a minute old without asking again.
- Comment notifications: with `notifyPrComments` on, each PRs poll also reads the comment threads of your 20 newest active pull requests in the organisation. While the tab is hidden, it first lists your active pull requests, one request per code project. With it off, the plugin reads no threads for notifications and makes no such list.
- PRs tab caches: completed pull requests for 5 minutes, linked work items for 10 minutes (an hour once completed), build and policy status for 2 minutes, the code project list for an hour.
- PRs tab limits: a load makes at most 4 requests at a time for an organisation, and so do comment reads. When Azure DevOps refuses to let the plugin read pull requests, PR loads for that organisation pause for 10 minutes. When it refuses comment threads, comment reads for that organisation pause for 10 minutes while PR loads and review notifications carry on.
- Pipelines tab: every 30 seconds while it is visible. For each code project it reads your runs from the last 7 days, the runs in progress and the pending approvals, plus the runs you watch and the runs approvals wait on. It reads stages for up to 8 runs in progress and up to 8 finished runs it hasn't read yet per load, keeps the stages of the last 100 finished runs it read, and reads an approval's environment once. Opening the tab shows data under 30 seconds old without asking again.
- Pipelines in the background: every 5 minutes, your runs and the pending approvals only. There is no running list and no stage bar. This feeds the status bar and the notifications.
- Watched runs: every 30 seconds while one hasn't finished.
- An open run tab: every 5 seconds while the run is active and every minute once it has finished. A refresh reads the run and its timeline, its list of logs while a step runs, and the approval while a stage waits. Log lines are read only for the step you have selected, when its log has grown.
- Reviews and the Wiki tab: never in the background (comment notifications read threads on their own, as above). A review is read when you open it, after you vote, comment, reply or resolve, and on Refresh. The Wiki tab reads the wiki list when it opens and keeps it for 10 minutes, a folder when you expand it, a page when you open it, again on Refresh and again when a Publish of it succeeds while it is open, and search when you press Enter. It reads the drafts when it opens.
- Slow-down: when Azure DevOps answers any request for an organisation with `Retry-After` or `X-RateLimit-Delay`, whether for work items, pull requests or pipelines, that organisation's pipeline polling drops to the background pace for 5 minutes. The Pipelines tab then polls every 5 minutes, watched runs every 2 minutes and an open run tab every 30 seconds.
- Pipelines limits: a load makes at most 4 requests at a time for an organisation. When Azure DevOps refuses to let the plugin read builds, runs for that organisation pause for 10 minutes and the tab says why. When it refuses approvals only, approvals turn off for 10 minutes while runs keep loading, and the tab says Needs me may be incomplete.
- When Azure DevOps rate-limits the plugin, polling pauses and the last data stays on screen.

## Settings

In Orca, open Settings and find **Azure DevOps** in the list of plugins.

- `azPath` (Azure CLI path): leave empty to find `az` on your `PATH` and in the usual Homebrew and system folders. Set it when `az` lives somewhere else.
- `defaultAgent` (Default agent): the agent **Start an agent** launches, such as `claude` or `codex`. Defaults to `claude`.
- `agentContext` (Add work item context to agent prompts): off by default.
- `branchTemplate` (Branch name template): defaults to `feature/{id}-{slug}`. `{id}` is the work item id. `{slug}` is its title in lower case, with other characters turned into hyphens, cut to 40 characters.
- `autoCompleteMergeStrategy` (Auto-complete merge type): how **Auto-complete all** merges. One of Merge (no fast-forward), Squash commit, Rebase and fast-forward, or Semi-linear merge. Defaults to Merge (no fast-forward).
- `autoCompleteDeleteSourceBranch` (Auto-complete: delete the source branch): off by default. A branch that another active pull request still uses is kept either way.
- `autoCompleteTransitionWorkItems` (Auto-complete: complete linked work items): off by default.
- `shareTemplate` (Pull request share line): one line per pull request in a share. Defaults to `[Pull Request {id}]({url}): {title}`. See Sharing for the placeholders.
- `notifyRunFailures` (Notify when my pipeline runs fail): on by default.
- `notifyApprovals` (Notify when a run waits for approval): on by default. It covers approvals you can give and approvals on your own runs.
- `notifyWatchedRuns` (Notify when a watched run finishes): on by default.
- `notifyReviewRequests` (Notify when someone asks for my review): on by default.
- `notifyPrComments` (Notify about new comments on my pull requests): on by default. Off, the plugin reads no comment threads for notifications.
- `approvalShareTemplate` (Approval share line): one line per approval in a share. Defaults to `Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}`. See The Pipelines tab for the placeholders.
- `entraClientId` (Microsoft sign-in: app (client) ID): the app registration your admin created for Sign in with Microsoft. Empty by default. See Registering the app (for admins).
- `entraTenant` (Microsoft sign-in: tenant): a tenant ID or domain, used only when an organisation's tenant can't be found. Empty by default. Leave it empty for any work or school account.
- `httpsProxy` (HTTPS proxy): an `http://` or `https://` proxy address for the plugin's traffic, like `http://proxy.example.com:8080`. Proxies that need a password aren't supported. Empty by default. See Proxies and certificates.
- `caCertificatesFile` (Extra CA certificates file): the full path to a PEM file of certificates to trust, for networks that inspect TLS. Empty by default. A change reaches new connections only; connections already open keep the certificates they started with.
- `useSystemCertificates` (Trust the system's certificates): also trust the certificates your operating system trusts. Off by default. Like the certificates file, a change reaches new connections only.

## Permissions

Orca asks you to approve these when the plugin first loads. The plugin runs in a trusted worker, a separate Node.js process with your user account's access to the computer. `orca plugin inspect` lists the same grants.

- `storage:own`: the plugin's own storage keeps your connected organisations and their pinned accounts, each board's nudge rules and dismissed nudges, the runs you watch, your share choices and Teams channel names, the links between work items and workspaces, and the list of wiki drafts.
- `secrets:own`: Orca's encrypted secrets keep personal access tokens, the Microsoft refresh token for each organisation and each Teams webhook URL (see Where credentials live).
- `settings:own`: reads the settings under Settings and notices when you change one.
- `workspace:read`: finds your focused workspace and lists your workspaces, for Start an agent, opening a board, a run or a wiki draft, Open in Orca, and finding the workspace that holds a pull request's repository in Check out in Orca.
- `workspace:write`: shows a workspace (Check out in Orca) and opens files in an editor tab: a board, a run, a wiki draft, or a file a failing step names.
- `agent:read`: lets the plugin hear `agent.status.changed`. It reads nothing else about agents.
- `agent:launch`: Start an agent launches your default agent in a workspace with the item's prompt.
- `notifications:show`: shows the desktop notifications for failed runs, watched runs, approvals, review requests and new comments on your pull requests (see Notifications).
- `workspace.create.before`: when Start a workspace or Check out in Orca has armed a branch, gives the next worktree you create that branch (and, for Check out in Orca, its base). Otherwise it changes nothing.
- `workspace.create.after`: links a workspace made by Start a workspace to its work item.
- `agent.launch.before`: notes which workspace an agent launch belongs to, so Add work item context to agent prompts knows where its prompt came from.
- `agent.prompt.before`: with Add work item context to agent prompts on, starts the first prompt of an agent in a linked workspace with a link to the item. Prompts you type are never changed.
- `agent.status.changed`: notes which workspace an agent that Orca reports belongs to, for the same purpose.

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

### Live checks still pending

The tests use fixtures and fakes. These haven't been checked against a real organisation, Teams, Microsoft Entra or Orca's own interface yet.

Boards:

- The board opens as an editor and `git status` stays clean.
- Dragging a card moves it, and a split column writes Doing and Done correctly.
- The workspace hook names the branch, and **Start an agent** launches your default agent with its prompt.

Pull requests and sharing:

- Three pull requests from one branch form one set. Approve all and Auto-complete all work, the branch is kept, the merge type applies, and a "limit merge types" policy shows its message on its row.
- The pull request list returns `autoCompleteSetBy` and `completionOptions`, which is how a pull request that will delete a shared branch is spotted.
- Copy as rich text pasted into Teams desktop, Outlook and Slack makes only "Pull Request N" a link. This includes the macOS write to the real clipboard and the Windows and Linux routes.
- A Workflows webhook posts a card whose links open the pull request, Test and Replace work, and the intro's line breaks show on the card.
- The Teams chat link: desktop app or browser, prefilled line breaks, `tenantId` picking the right account, a two-person group chat, the real length limit, and how often Orca asks before opening it.
- Adding reviewers (a person and a group, required and optional) notifies them and leaves an existing reviewer's vote untouched.
- On the client organisation, read-only: `X-RateLimit-*` headroom after a refresh, whether `reviewerId` returns pull requests assigned to your groups, and whether the organisation-wide repository list works.
- The PRs tab and composer at 360 px in both themes, Orca's To review fold and the first press of Share and Open Teams chat.
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

## License

[MIT](LICENSE)
