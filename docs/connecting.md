# Connecting and signing in

[Back to the README](../README.md)

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
- **Saved views:** the last view of each tab, kept in the plugin's storage for the account that saw it so the tabs show at once when Orca starts. Sign out and removing the organisation delete them (see [Saved data](reference.md#saved-data)).
- **Git:** **Clone from Azure DevOps…** runs `git clone` in your own terminal, so git signs in with this computer's git credentials, such as a credential helper or your SSH keys, as when you clone by hand. The plugin never hands git its own sign-in, and keeps nothing for it.
- **Teams webhook URLs:** stored in the same encrypted secrets, one per channel. The panel can't read a URL back, and it never goes into logs, settings or messages. Sign out doesn't remove channels; **Remove** in the channel manager does.

### PAT scopes

What exists so far is expected to work with:

- **Project and team: Read** (`vso.project`) for the project and team lists, and your team's people when you reassign an item.
- **Work Items: Read & write** (`vso.work_write`) for the Work tab and board, moves, comments, links, reassigning, ticking off tasks and adding tasks.
- **Code: Read** (`vso.code`) for pull request chips, the PRs tab, linking a pull request and the repository list of **Clone from Azure DevOps…**. Without it, chips are off for that organisation and the Work and PRs tabs say so.
- **Code: Read & write** (`vso.code_write`) for Approve, Auto-complete and adding reviewers. It also covers the votes and comments in a pull request review.
- **Graph: Read** (`vso.graph`) and **Identity: Read** (`vso.identity`) for finding people to message, email, add as reviewers or assign an item to.
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
