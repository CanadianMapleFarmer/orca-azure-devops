# Plan 6: Sign in with Microsoft and release prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an organization with **Sign in with Microsoft** (the user's admin registers one Entra app), pinned to one account like the other methods; let the plugin work behind a proxy or TLS inspection; and leave the repository ready to publish when the user asks.

- **Sign in with Microsoft.** The Setup view gains a third method. Connect starts a redirect listener in the worker; the panel shows **Open sign-in page**, a press opens the Microsoft account picker, and the browser posts the result back to the worker. The account is pinned per org, a token for another account is refused, the refresh token lives only in `orca.secrets` (`entra:<org>`), access tokens are renewed silently before they expire, and Sign out deletes the secret.
- **Network.** Optional proxy and CA settings, applied in code because Orca strips `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` from the worker.
- **Release prep.** An icon, screenshots (taken with the user), a README admin guide for the app registration, a Permissions section, README polish, a release checklist and an `orca plugin inspect` review. Nothing is published.
- **Not in this plan:** Microsoft Graph or Teams posting as the user, a shared author-owned app registration (both spec §2 non-goals), device code flow, the macOS broker, proxies that need a password, and anything that publishes.

**Architecture:**
- `worker/auth/entra.ts` holds the OAuth protocol (PKCE, the sign-in URL, code redemption, refresh, error mapping) over an injected `fetch`. `worker/auth/loopback.ts` is the one-shot redirect listener on `127.0.0.1`. `worker/auth/entra-provider.ts` joins them with the settings, a 5-minute `AbortSignal` bound and the `entra:<org>` secret, like `AzCliProvider` does for `az`.
- `worker/connections.ts` gains the method `entra`. It reuses `begin`, `signIn`, `conclude`, `refuseAccount`, `expire` and the per-org `serial` chain, so pinning, mismatch, expiry, cancel and interrupted sign-ins behave exactly as for the Azure CLI.
- The panel opens the sign-in page itself, from a press, before any await (Plan 3's S2 rule). The URL reaches it as `OrgStatus.signInUrl`.
- `worker/net/network.ts` applies the proxy with `http.setGlobalProxyFromEnv` and the CAs with `tls.setDefaultCACertificates`, both verified on Orca's Node while planning (Task 0, S3).
- Release assets are generated or captured: `scripts/make-icon.mjs` writes `assets/icon.png`; screenshots come from `panel.check.ts` scenarios with fixture data only.

**Baseline:** the post-Plan-5 head of `feat/plan-5-reviews-wiki`, onto which this branch is stacked. Plan 4 (executing in another worktree, which nobody here writes to) and Plan 5 count as landed, with their Produces blocks:
- Plan 4: `customEditors.run`, the `approvalShareTemplate` and `notify*` settings, the Pipelines tab in `panel.tsx`, run views, git remotes and the approval share source in `worker/main.ts`, README sections Pipelines, Run tab and Notifications.
- Plan 5: `registerReviewHandlers` and `registerWikiHandlers` in `worker/main.ts`, `syncReview`/`syncWiki` and `WikiTab` in `panel.tsx` (the "Coming in a later update" fallback is gone), README sections for reviewing and the Wiki tab. No new settings.

Task 0 re-reads every signature cited below at that head.

**Tech Stack:** TypeScript (build-less, `engines.orca >=1.4.248`; installed 1.4.250), the worker's Node 24.22.1 (`fetch`, `node:http`, `node:crypto`, `node:tls`), OAuth 2.0 authorization code with PKCE (RFC 7636) and a loopback redirect (RFC 8252) against the Microsoft identity platform v2.0, `shell.openExternal`, `orca/testing`. No npm runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md`. The scope is roadmap row 6 (`docs/superpowers/plans/2026-11-03-roadmap.md`): §5.6 option 2 and account pinning for it, §5.8's proxy and CA settings, §5.10, and release prep. §2, §4.1, §4.3, §6 and §7 also apply. Plan 1 (`2026-11-03-plan-1-foundation.md` and its `.rulings.md`) built the connection layer; its rulings R19, R20, R27, R28, R30 and R33 apply to the new method.

## Global Constraints

Plans 1–5's Global Constraints still bind. Every commit ends with a blank line and a `Co-Authored-By:` trailer for the model doing the work.

- **Never:**
  - run `orca plugin dev load|watch|reload`, `orca plugin enable`, or anything with `--approve`;
  - push, merge, tag, create the GitHub repository, add a topic, or publish to a catalog (steps that need these are written "when the user asks" and are not run);
  - change branches, or write in the Plan 4 worktree.
- **The worker never runs the `orca` CLI.**
- **Secrets.** No token, refresh token, PAT, `Authorization` value, auth code, PKCE verifier or webhook URL outside `orca.secrets`: never in logs, storage, posts, panel state, errors, or URLs shown to the user.
  - The verifier, the `state` value and the auth code live only in the sign-in's closure in worker memory and are dropped when it ends. Access tokens live only in `connections`' in-memory cache.
  - The secret `entra:<org>` holds `{"v":1,"clientId":…,"authority":…,"refreshToken":…}` and nothing else.
  - The sign-in page URL (client ID, redirect, `state`, code challenge) reaches the panel only as `OrgStatus.signInUrl`, is never rendered as text, and is dropped when the attempt ends.
  - Microsoft's `error_description` text never reaches a message, a log or a page.
- **Tests fake ADO and Entra.** `fetch` is faked; the only real sockets are the redirect listener's on `127.0.0.1`. No test calls the real `http.setGlobalProxyFromEnv` or `tls.setDefaultCACertificates`; mounted-worker tests use only empty or invalid network settings. Live checks wait for Task 9, with the user present.
- **Writes and grants.** Writes are never auto-retried. An auth code is redeemed once; no token request is retried.
- **Only error messages reach the UI.** Worker copy lives in `worker/messages.ts` (`ENTRA`, `entraFailed`, `REDIRECT_PAGE`, `NETWORK`); panel-only copy lives in the panel file that shows it; `messageOf(error)` everywhere.
- **Single-sourced URLs.** Microsoft hosts come only from `worker/ado/org.ts` (`entraAuthorizeUrl`, `entraTokenUrl`); only `listenForRedirect` builds the redirect URI.
- **Timers.** None outside the scheduler. The sign-in wait (5 min) and each token request (30 s) are bounded by `AbortSignal`s from an injected `timeout` port (default `AbortSignal.timeout`), so tests fire them by hand.
- **Wiring.** Loads keep the linked-abort rule. No new `plugin.request` handlers: the method rides on `orgs.connect`, `orgs.cancel`, `orgs.signOut` and `orgs.remove`. Feature registrars stay composed in `worker/main.ts`, and mounted tests use `withWorker`.
- **Manifest.** No new capabilities, hooks, events or editors. New settings: `entraClientId`, `entraTenant` (Task 3), `httpsProxy`, `caCertificatesFile`, `useSystemCertificates` (Task 6). New top-level fields: `icon`, `author`, `homepage` (Task 8) and `screenshots` (Task 9). Orca may ask the user to approve again at their next load; nobody approves for them.
- **Endpoints and values:**
  - authorize: `https://login.microsoftonline.com/{authority}/oauth2/v2.0/authorize`
  - token: `https://login.microsoftonline.com/{authority}/oauth2/v2.0/token`
  - scope: `499b84ac-1321-427f-aa17-267ca6975798/.default openid profile offline_access`
  - redirect URI: `http://localhost:{port}`, listener bound to `127.0.0.1`, port chosen by the OS
  - `response_mode=form_post`, `prompt=select_account`, `code_challenge_method=S256`
  - `authority`: the org's discovered tenant, else the `entraTenant` setting, else `organizations`
- **Fixtures.** Org `contoso`; tenant `0f0e0d0c-0b0a-4908-8706-050403020100`; client ID `6a1d3b5c-7e9f-4b2d-8c4a-1f3e5d7b9a20`; Ada (`ada@contoso.com`, ADO id `u1`, oid `6f1c2e2a-0ada-4c3e-9a1b-0d4e8c7b6a51`) and Grace (`grace@contoso.com`, ADO id `u2`, oid `2b7d9f10-9ace-4e21-8d3c-71a0b5e4c9f2`), as in `worker/connections.test.ts`. The README and the admin guide use placeholders only, never a real tenant, org or app ID.
- **Code.** Zero code comments.
- **Verification:** `npm run typecheck`, `orca plugin test . --json` (TAP, `# fail 0`), `orca plugin validate . --json`, `orca plugin check . --json`.

## Review Focus

1. **The browser hands back another account** (the infra account, or the browser's default slipping past the picker), on a first connect, a reconnect, or a later refresh. Nothing is saved, the pin is unchanged, the message names both accounts, and a pinned org is refused before ADO is asked. *Tests:* T4 `an Entra sign-in for another account is refused before anything is saved`; T4 `a refreshed Entra token for another object id is refused as a mismatch and its secret deleted`.
2. **An abandoned sign-in** (Cancel, the tab closed, Open sign-in page never pressed or Orca's consent dialog cancelled, 5 minutes passing, the worker stopped mid-way). On Cancel, the timeout or a stop, the port closes, nothing is stored and the org says why; after a stop, the next start says the sign-in was interrupted. A cancelled consent dialog leaves the button to press again. *Tests:* T3 `a cancelled or timed-out sign-in closes its port and keeps nothing`; T4 `a cancelled or timed-out Entra sign-in leaves no listener and no state`; T4 main `deactivate during a Microsoft sign-in closes its port and the next start says it was interrupted`.
3. **Stray or hostile requests to the redirect port** (a GET carrying `?code=`, a wrong `state`, another `Host`, a 70 KB body, `/favicon.ico`, an error post with markup, a second post after success). Only one form post with the right `state` counts, no page echoes anything, and the port closes after it. *Test:* T2 `the redirect listener accepts only one form post with the right state and echoes nothing`.
4. **The sign-in stops renewing overnight** (an expired or revoked refresh token, MFA newly required, a rotated refresh token, two requests renewing at once, a restart in between). One renewal at a time, the rotated token is kept, and a dead refresh token marks the org expired once, with Reconnect. *Tests:* T3 `getToken stores the rotated refresh token and reports invalid_grant as needs sign-in`; T4 `concurrent requests share one Entra refresh and invalid_grant expires the org once`.
5. **An app registration that isn't ready** (no or malformed app ID, consent not granted, the app missing from the tenant, `http://localhost` not registered, a web-platform redirect asking for a secret, an account from another directory). A plain message that points at the fix, nothing registered or saved, and none of Microsoft's text. *Tests:* T1 `Entra errors map to plain messages that never quote Microsoft's text`; T4 `a first Microsoft connect that Entra refuses explains why and registers nothing`.

---

## File map

| File | Responsibility |
|------|----------------|
| `worker/ado/org.ts` (modify) | `ADO_RESOURCE` moves here; `entraAuthorizeUrl`, `entraTokenUrl` |
| `worker/auth/entra.ts` | PKCE, `state`, sign-in URL, code redemption, refresh, Entra error mapping |
| `worker/auth/fake-entra.ts` | Test fake for the token endpoint, unsigned JWTs, fixture ids |
| `worker/auth/loopback.ts` | One-shot redirect listener on `127.0.0.1`; `closeAllListeners` |
| `worker/auth/entra-provider.ts` | Entra settings, the sign-in session, the `entra:<org>` secret, silent refresh |
| `src/shared/types.ts` (modify) | `ConnectionMethod` gains `entra`; `OrgStatus.signInUrl` |
| `worker/connections.ts` (modify) | The `entra` method |
| `worker/net/network.ts` | Proxy and CA settings applied to `fetch`; proxy env for `az` |
| `worker/auth/azcli.ts` (modify) | `extraEnv` port; re-exports `ADO_RESOURCE` |
| `worker/status-bar.ts` (modify) | `statusText` lists network notes |
| `worker/messages.ts` (modify) | `ENTRA`, `entraFailed`, `REDIRECT_PAGE`, `NETWORK` |
| `worker/main.ts` (modify) | Wiring, `deactivate` closes listeners |
| `src/panel/setup.tsx`, `src/panel/panel.tsx`, `src/panel/panel.check.ts` (modify) | The Microsoft option, Open sign-in page, a check scenario |
| `orca-plugin.json` (modify) | Five settings; `icon`, `author`, `homepage`, description; `screenshots` |
| `scripts/make-icon.mjs`, `assets/icon.png`, `assets/screenshots/*.png` | Release images |
| `worker/manifest.test.ts` | Orca's image rules for the icon and screenshots |
| `README.md` (modify) | Sign in with Microsoft, admin guide, proxies and certificates, permissions, polish |
| `docs/release-checklist.md` | Release checklist; publishing steps "when the user asks" |
| `docs/superpowers/spikes/2026-11-05-plan-6.md` | Spike record |

## Shared types

```ts
// src/shared/types.ts (Task 4)
export type ConnectionMethod = 'azure-cli' | 'pat' | 'entra'
export interface OrgStatus {
  // …existing fields unchanged…
  signInUrl?: string   // entra only: present while that attempt is current, signing in, and its listener is open
}
```

No protocol entries are added. `tokenStore` for `entra` is `{ kind: 'orca-secrets' }`.

## Planning rulings

Calls made while writing this plan. Task 0 records the evidence; the user can overturn any of them.

- **P1 (S1): no MSAL Node; the flow is written by hand.** This rules against the spec's "MSAL Node" wording (§4.3, §5.6, roadmap row 6), and the `entra:<org>` secret replaces §5.6's "custom MSAL cache plugin". Reasons:
  - The plugin has no build step and Git installs clone the repository, so MSAL could only ship as a committed, generated, minified bundle (~230 KB) that `orca plugin inspect` reviewers can't read and that must be regenerated for every MSAL fix.
  - MSAL's interactive call has no abort and its listener no timeout, so "a cancelled or timed-out sign-in leaves no listener" needs a custom `loopbackClient` anyway, which is most of the hand-written code. MSAL also fetches instance and OpenID metadata, which the fakes would have to serve.
  - What remains is about 150 lines over `fetch` and `node:crypto`, tested against RFC 7636's own example. Task 0 stops only if Orca turns out to install npm dependencies itself.
- **P2: the redirect is `http://localhost:{port}`, listened on at `127.0.0.1` only.** Entra ignores the port only for `localhost` redirects, and its portal refuses `http://127.0.0.1` without a manifest edit (Microsoft's reply-URL page, read on 2026-11-05), so admins register `http://localhost` as spec §4.3 says. A browser that tries `::1` first is expected to fall back to IPv4 when that connection is refused; Task 9 checks this live.
- **P3: `response_mode=form_post`.** The code never lands in the browser's address bar or history.
- **P4: the scope adds `openid profile`** to the brief's `.default offline_access`, because without them Entra returns no id token to pin from.
- **P5: what is pinned.** `objectId` comes from the id token's `oid`; `uniqueName`, `adoId` and `displayName` come from ADO's `connectionData`, as for the other methods, so "signed in as" reads the same everywhere. A pinned org refuses a mismatching id token `oid` before asking ADO, and checks every access token with `tokenMatchesPin`.
- **P6: two presses.** Connect starts the listener; **Open sign-in page** opens the page. `shell.openExternal` needs a press on a control that has been settled for 500 ms, and the grant lasts 1 s (Plan 3 S2), so the URL can't be fetched and then opened in one press.
- **P7: network scope.**
  - One proxy for all of the worker's HTTPS. Loopback always bypasses it.
  - No proxy passwords: settings are stored in plain text.
  - No `NO_PROXY` setting, because every host the plugin calls is a Microsoft cloud host.
  - `az` gets the proxy through `HTTPS_PROXY`/`NO_PROXY` in its environment, but not the CA settings: `REQUESTS_CA_BUNDLE` would replace its whole trust store. The README sends TLS-inspected networks to Sign in with Microsoft or a PAT.
- **P8: images.**
  - The icon is generated by a committed script and uses no Microsoft mark.
  - The README and the manifest description say "Unofficial".
  - Screenshots come from check scenarios (fixture data only), taken with the user in Task 9, because `orca plugin shot --scenario` needs Orca's window hidden or minimised.

---

### Task 0: Spikes and baseline re-check

**Files:** `docs/superpowers/spikes/2026-11-05-plan-6.md`, in Plan 4's shape:
- one table per spike, with rows "Question · Method · Result · Decision";
- live rows marked **pending live** for Task 9.

Probes stay in `mktemp -d` folders outside the repository. The app bundle is read only with `python3 -I`. Orca's runtime may be run as Node (`ELECTRON_RUN_AS_NODE=1 /Applications/Orca.app/Contents/MacOS/Orca <probe.mjs>`) but is never modified.

- [ ] **Step 1: Baseline re-check.** At the post-Plan-5 head, re-read every "Consumes" signature in Tasks 1–8 and these names:
  - `createConnections`, `ConnectionsDeps`, `Connections`, and every `unknownMethod` switch in `worker/connections.ts` (list them);
  - `TokenClaims`, `decodeTokenClaims`, `tokenMatchesPin`; `SecretsPort`, `patKey`; `ADO_RESOURCE`, `createAzCliProvider` and its deps; `orgWebUrl`, `orgVsspsUrl`, `discoverTenant`, `isValidOrgName`;
  - `statusText`, `watchSettings`, `stopAllCommands`, `deactivate`, the `status` command registration;
  - `METHODS`, `isMethod`, `reconnect`, `connect`, `SigningIn`, `OPEN_LINK_UNAVAILABLE`, `messageOf`, `LONG_WAIT`, `openPr` (the open-before-await pattern);
  - test helpers `withWorker`, `memoryStore`, `orgsChanged`, `mountPanel`, `org()`, `closeCleanly`, `requestsTo`, and the `harness()` in `worker/connections.test.ts`;
  - the README sections, settings and `customEditors` that Plans 4 and 5 added, and the `panel.check.ts` scenario names.

  Answer: (a) does any test enumerate the Setup radio options or `ConnectionMethod` values? (b) does `orgsChanged(w.posts)` expose the full `OrgStatus`, so a mounted test can read `signInUrl`? Record each drift as "cited · actual · tasks affected". Interface drift goes to the controller before Task 1.
- [ ] **Step 2: S1, npm dependencies.** Record:
  - the authoring guide's rule ("bare imports resolve as Node does, but do not commit `node_modules/`; bundle npm dependencies") and that `.mjs` files are not transpiled;
  - that a throwaway plugin in `mktemp -d` with a hand-written `worker/vendor/x.mjs` imported by a `.ts` worker passes `orca plugin validate`, `check` and `test`;
  - what `orca plugin inspect . --json` reports for this repository (file count, total size, content hash form);
  - whether anything in the bundle's plugin install path runs `npm` (a `python3 -I` search of `app.asar` for `npm install` / `npm ci` near the plugin installer);
  - the MSAL facts from the recon (§"Node library", §"Which flow").

  Decision: **P1**. If Orca installs npm dependencies itself, stop and return to the controller.
- [ ] **Step 3: S2, loopback and consent.**
  - (a) A throwaway `orca plugin test` in `mktemp -d` whose test binds `node:http` on `127.0.0.1:0` and receives a POST. This proves the test runner allows it; the worker itself is plain Node (recon).
  - (b) In `app.asar`, around the functions Plan 3's S2 row cites (consent dialog, `pluginExternalHostGrants`, the 3-per-10-s limit, the 500 ms settle and 1 s grant), record whether `shell.openExternal` caps URL length; the sign-in URL is about 700 characters.
  - (c) Record P2 and P3 with the Microsoft reply-URL rules: `http` allowed for localhost, the port ignored only for `localhost`, the portal refusing `http://127.0.0.1`, `[::1]` unsupported.
  - Decisions: P2, P3, P6.
- [ ] **Step 4: S3, the worker's Node, proxy and CA.** Re-run the planning probe (a self-signed HTTPS server on `127.0.0.1`, a CONNECT-recording proxy, `https://probe.invalid/` as the proxied target, so nothing leaves the machine) under Orca's runtime. Record each result; while planning on 2026-11-05 they were:
  - Node `v24.22.1`, Electron `43.8.6`, undici `7.30.1`;
  - a self-signed server fails with `DEPTH_ZERO_SELF_SIGNED_CERT`, then `tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem])` makes global `fetch` accept it;
  - `tls.getCACertificates('system')` returns the OS store;
  - `http.setGlobalProxyFromEnv({ HTTPS_PROXY })` sends global `fetch` through `CONNECT probe.invalid:443`, honours `NO_PROXY`, and returns a function that restores direct connections.

  Also record whether `tls.getCACertificates('bundled')` exists. Task 6 builds from it, so applying twice is idempotent; if it doesn't exist, Task 6's port reads `default` once when the network is created and builds from that copy. Then record why the environment route can't work: the variables are stripped, and `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS` are read only at process start.

  Decision: **P7** and Task 6's three settings.
- [ ] **Step 5: S4, images, shots, inspect.** Record:
  - the manifest rules: `icon` PNG or WEBP, square, at least 128×128, at most 256 KB; `screenshots` at most 6, each PNG/JPEG/WEBP at least 1280×800 and at most 1536 KB with a required `alt`, all images together at most 8 MB; `cover` optional;
  - `orca plugin validate` on throwaway copies of the manifest: a 256×256 icon passes; a 100×100 icon and a 1000×600 screenshot fail (record the codes and messages);
  - that `orca plugin shot <dir> --scenario <name>` needs no approval (it renders like `plugin check`) but needs Orca's window hidden or minimised, so it runs only in Task 9 with the user;
  - `orca plugin release-entry . --json` (read-only): what it prints or needs (a remote, a tag).

  Decision: P8.
- [ ] **Step 6: Pending live rows (Task 9):**
  - the README admin guide against the real portal labels;
  - the consent dialog for `login.microsoftonline.com` and how often it asks;
  - the account picker on every sign-in;
  - Safari, Chrome and Firefox reaching `http://localhost:{port}` while the listener is on `127.0.0.1`;
  - whether "Allow public client flows: No" gives `AADSTS7000218`;
  - a refresh after the access token's lifetime and after an Orca restart;
  - a wrong-account refusal;
  - Cancel and the 5-minute timeout, with `lsof` showing no listener afterwards;
  - Sign out;
  - a proxy, only if the user has one;
  - screenshots in both themes.
- [ ] **Step 7: Commit** "Record the Plan 6 spikes".

### Task 1: The Entra protocol

**Files:**
- **Create:** `worker/auth/entra.ts`, `worker/auth/fake-entra.ts`.
- **Modify:**
  - `worker/ado/org.ts`: `ADO_RESOURCE` moves here, plus `entraAuthorizeUrl` and `entraTokenUrl`.
  - `worker/auth/azcli.ts`: imports `ADO_RESOURCE` and re-exports it, so `azcli.test.ts` stays unedited.
  - `worker/messages.ts`: `ENTRA` (the error copy below) and `entraFailed`.
- **Test:** `worker/auth/entra.test.ts`, `worker/ado/org.test.ts`.

**Interfaces:**
- Consumes: `decodeTokenClaims(token): TokenClaims | null` (`worker/auth/identity.ts`).
- Produces:

```ts
// worker/ado/org.ts
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
export function entraAuthorizeUrl(authority: string): string   // https://login.microsoftonline.com/<encodeURIComponent(authority)>/oauth2/v2.0/authorize
export function entraTokenUrl(authority: string): string       // …/oauth2/v2.0/token
// worker/auth/entra.ts
export const ENTRA_SCOPE = `${ADO_RESOURCE}/.default openid profile offline_access`
export const ENTRA_REQUEST_TIMEOUT_MS = 30_000
export type EntraErrorKind = 'config' | 'refused' | 'needs_sign_in' | 'unreachable' | 'malformed'
export class EntraError extends Error { constructor(kind: EntraErrorKind, message: string, code?: string | null); readonly kind: EntraErrorKind; readonly code: string | null }
export interface EntraTokens { accessToken: string; refreshToken: string; expiresAt: number; tenant: string | null; objectId: string | null; username: string | null }
export type Random = (size: number) => Uint8Array
export type Timeout = (ms: number) => AbortSignal
export function base64Url(bytes: Uint8Array): string
export function createPkce(random: Random): { verifier: string; challenge: string }           // 32 random bytes; S256
export function newState(random: Random): string                                             // 16 random bytes
export function authorizeUrl(p: { authority: string; clientId: string; redirectUri: string; challenge: string; state: string; loginHint: string | null }): string
export function redirectError(error: string, code: string | null): EntraError
export function redeemCode(fetchFn: typeof fetch, timeout: Timeout, p: { authority: string; clientId: string; redirectUri: string; code: string; verifier: string; now: number; signal?: AbortSignal }): Promise<EntraTokens>
export function refreshTokens(fetchFn: typeof fetch, timeout: Timeout, p: { authority: string; clientId: string; refreshToken: string; now: number; signal?: AbortSignal }): Promise<EntraTokens>
// worker/auth/fake-entra.ts (tests only)
export const CLIENT_ID: string; export const TENANT: string; export const OID_ADA: string; export const OID_GRACE: string
export function jwt(claims: Record<string, unknown>): string                                   // unsigned header.payload.sig
export function tokenAnswer(p: { oid: string; upn: string; refresh?: string; expiresIn?: number | string; idToken?: boolean; tid?: string }): Response
export function entraErrorAnswer(p: { error: string; codes?: number[]; description?: string; status?: number }): Response
export function fakeEntra(): { fetch: typeof fetch; calls: { url: string; form: URLSearchParams; headers: Headers }[]; answer(grant: 'authorization_code' | 'refresh_token', ...replies: (Response | Error)[]): void }
```

**Rules:**
- `authorizeUrl` builds `entraAuthorizeUrl(authority)` with the parameters in this order: `client_id`, `response_type=code`, `redirect_uri`, `response_mode=form_post`, `scope=ENTRA_SCOPE`, `state`, `code_challenge`, `code_challenge_method=S256`, `prompt=select_account`, and `login_hint` only when it is given.
- Each token request:
  - `POST entraTokenUrl(authority)` with `content-type: application/x-www-form-urlencoded`, `accept: application/json` and `redirect: 'manual'`;
  - signal `AbortSignal.any([p.signal, timeout(ENTRA_REQUEST_TIMEOUT_MS)])`, or just the timeout;
  - never a `client_secret`; never retried.
  - Code redemption sends `client_id`, `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier` and `scope`.
  - Refresh sends `client_id`, `grant_type=refresh_token`, `refresh_token` and `scope`.
- A success needs `access_token`, `refresh_token` (on refresh it falls back to the token sent) and `expires_in` (a number or a digit string).
  - `expiresAt = now + expires_in × 1000`.
  - `tenant`, `objectId` and `username` come from the id token: `tid`, `oid`, `preferredUsername ?? upn`.
  - Redemption without an id token, or without an `oid` in it, is `malformed`. On a refresh they are null when no id token comes back.
- Errors. The code is `AADSTS<error_codes[0]>`, else the first `AADSTS\d+` in `error_description`, else `error` when it matches `^[a-z_]{1,40}$`, else null. Matched in this order:

  | Entra says | Kind | Message |
  |---|---|---|
  | redirect `error=access_denied` (whatever the code) | `refused` | `ENTRA.browserCancelled` |
  | `AADSTS65001`, `AADSTS90094` or `consent_required` | `refused` | `ENTRA.consent` |
  | `AADSTS700016` | `config` | `ENTRA.appNotFound` |
  | `AADSTS50011` | `config` | `ENTRA.redirect` |
  | `AADSTS7000218` | `config` | `ENTRA.publicClient` |
  | `AADSTS50020` | `refused` | `ENTRA.wrongDirectory` |
  | `invalid_grant`, `interaction_required`, `AADSTS50076`, `50079`, `50173`, `70008`, `700082`, `700084` | `needs_sign_in` | `entraFailed(code)` |
  | anything else | `refused` | `entraFailed(code)` |
  | `fetch` rejects, or the timeout fires | `unreachable` | `ENTRA.unreachable` |
  | a 3xx, a body that isn't JSON, or a missing field | `malformed` | `ENTRA.malformed` |

- **Copy (`worker/messages.ts`):**
  - `ENTRA.browserCancelled` "Sign-in was cancelled in the browser."
  - `ENTRA.consent` "Your organization hasn't approved this app yet. Ask an admin to grant consent (see the README's admin guide)."
  - `ENTRA.appNotFound` "Microsoft can't find this app for your organization. Check the app (client) ID, or ask an admin to allow the app in your tenant."
  - `ENTRA.redirect` "The app registration doesn't allow this sign-in. Ask an admin to add http://localhost under Mobile and desktop applications."
  - `ENTRA.publicClient` "The app registration asks for a client secret. Ask an admin to turn on Allow public client flows (see the README's admin guide)."
  - `ENTRA.wrongDirectory` "That account isn't in this organization's directory. Sign in again and pick your work account."
  - `ENTRA.unreachable` "Couldn't reach Microsoft sign-in."
  - `ENTRA.malformed` "Microsoft sign-in returned an unexpected response."
  - `entraFailed(code)` → `Microsoft sign-in failed (${code}).`, or "Microsoft sign-in failed." when the code is null.

- [ ] **Step 1: Write the failing tests.**
  - `createPkce matches RFC 7636's example`: `random` returns the RFC's 32 bytes `[116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]`. The verifier is `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` and the challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. `newState` is 22 base64url characters.
  - `authorizeUrl asks for the account picker, form_post and the ADO scope`:
    - parsed with `URL`, the origin and path are `https://login.microsoftonline.com/<TENANT>/oauth2/v2.0/authorize`;
    - every parameter is as listed above, in that order;
    - `login_hint` appears only when given;
    - there is no `code_verifier`, `client_secret` or `nonce`.
  - `redeemCode sends one form post and reads the id token`:
    - one call with the exact form fields and headers;
    - `objectId === OID_ADA`, `username === 'ada@contoso.com'`, `tenant === TENANT`;
    - `expiresAt === now + 3_600_000`, and the same for `expires_in: '3600'`.
  - `refreshTokens keeps the old refresh token when none comes back`; with one in the answer, it returns the new one.
  - (**Review Focus 5**) `Entra errors map to plain messages that never quote Microsoft's text`: one case per table row, through `redeemCode` and through `redirectError`. Each description holds `ada@contoso.com`, `Trace ID: 5f0c…` and `<b>x</b>`, and no message contains any of them.
  - `an answer without tokens or an id token is malformed, a redirect is malformed, and a failed or timed-out fetch is unreachable`. The timeout case fires the injected `timeout` signal by hand.
  - org: `entra URLs encode the authority` (`contoso.onmicrosoft.com`, a GUID, `organizations`).
- [ ] **Step 2: Run** `orca plugin test . --json`. Expected: the new tests FAIL (modules missing); the rest pass.
- [ ] **Step 3: Implement** with `node:crypto` (`createHash('sha256')`) and `decodeTokenClaims`.
- [ ] **Step 4: Run.** Expected: PASS, and `npm run typecheck` exits 0.
- [ ] **Step 5: Commit** "Add the Entra sign-in protocol".

### Task 2: The redirect listener

**Files:**
- **Create:** `worker/auth/loopback.ts`.
- **Modify:** `worker/messages.ts`: `REDIRECT_PAGE`.
- **Test:** `worker/auth/loopback.test.ts`. It uses real `node:http` on `127.0.0.1` and sends requests with `http.request` so it can set `Host`.

**Interfaces:**
- Produces:

```ts
export type Redirect = { code: string } | { error: string; errorCode: string | null }
export interface Listener { redirectUri: string; result: Promise<Redirect> }
export type Listen = (opts: { state: string; signal: AbortSignal }) => Promise<Listener>
export const MAX_REDIRECT_BODY_BYTES = 64 * 1024
export const listenForRedirect: Listen
export function closeAllListeners(): void
```

**Rules:**
- An already-aborted signal rejects with its reason, without binding.
- Otherwise it binds `127.0.0.1` on port 0, and `redirectUri` is `http://localhost:<port>`.
- A request counts only when all of these hold:
  - it is `POST /`;
  - `Host` is `localhost:<port>` or `127.0.0.1:<port>`;
  - the content type is `application/x-www-form-urlencoded`;
  - the body is at most `MAX_REDIRECT_BODY_BYTES`;
  - its `state` equals the expected one (`crypto.timingSafeEqual` on equal-length buffers).
- When a request doesn't count, the listener keeps waiting:

  | Request | Answer |
  |---|---|
  | another method or path | 404 `notHere` |
  | wrong `Host` | 400 `notHere` |
  | body too large | 413 `notHere` |
  | wrong or missing `state` | 400 `stale` |

- The request that counts resolves `result` with `{ code }`, or `{ error, errorCode }` when the form carries `error`; `errorCode` is the first `AADSTS\d+` in `error_description`, else null. The answer is 200 `done` or `failed`. Then the server closes and destroys its connections, so later requests are refused.
- Every page:
  - a fixed HTML page from `REDIRECT_PAGE`;
  - headers `content-type: text/html; charset=utf-8`, `content-security-policy: default-src 'none'`, `cache-control: no-store` and `referrer-policy: no-referrer`;
  - never echoes anything from the request.
- An abort closes the server, destroys its sockets and rejects `result` with `signal.reason`. `closeAllListeners()` does that for every open listener, with an `AbortError`.
- **Copy:** `REDIRECT_PAGE`:
  - `title` "Azure DevOps for Orca"
  - `done` "You're signed in. You can close this tab and go back to Orca."
  - `failed` "Sign-in didn't finish. Go back to Orca to see why."
  - `stale` "This sign-in page is out of date. Start again in Orca."
  - `notHere` "Nothing here."

- [ ] **Step 1: Write the failing tests.**
  - `binds 127.0.0.1 on a random port and names localhost in the redirect`: the port is above 0, `redirectUri` is `http://localhost:<port>`, and a connection to `[::1]` on that port fails.
  - (**Review Focus 3**) `the redirect listener accepts only one form post with the right state and echoes nothing`. In order, with `result` still pending after each of the first six:
    1. `GET /?code=c1&state=<s>` → 404;
    2. `POST /favicon.ico` → 404;
    3. a POST with `Host: evil.example` → 400;
    4. a 70 KB body → 413;
    5. `state=wrong` → 400 with the `stale` page;
    6. a JSON body → 404;
    7. the right `state` with `code=c-ada-1` → 200 `done`, and `result` is `{ code: 'c-ada-1' }`.

    No response body contains `c1`, `c-ada-1`, the state or `evil`. Every response carries the four headers. A further POST is refused (`ECONNREFUSED`).
  - `an error post resolves with Entra's code and shows no markup`: `error=consent_required&error_description=<script>x</script> AADSTS65001: …` resolves `{ error: 'consent_required', errorCode: 'AADSTS65001' }`, and the page has no `<script>`.
  - `abort closes the port and rejects with the reason`, and `closeAllListeners closes every open listener`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS; typecheck exits 0.
- [ ] **Step 5: Commit** "Listen for the Microsoft sign-in redirect on 127.0.0.1".

### Task 3: The Entra provider and its settings

**Files:**
- **Create:** `worker/auth/entra-provider.ts`.
- **Modify:**
  - `orca-plugin.json`: two settings, appended after the existing ones.
  - `worker/messages.ts`: the `ENTRA` config and storage copy.
- **Test:** `worker/auth/entra-provider.test.ts`.

**Interfaces:**
- Consumes: Task 1's protocol, `fakeEntra`; Task 2's `Listen` and `listenForRedirect`; `SecretsPort` (`worker/auth/pat.ts`); `isValidOrgName` (`worker/ado/org.ts`); `memoryStore`-style in-memory secrets from the existing tests.
- Produces:

```ts
export const ENTRA_SIGN_IN_TIMEOUT_MS = 5 * 60_000
export function entraKey(org: string): string                                  // "entra:<org>"; throws for an invalid org name
export function readEntraSettings(values: Record<string, unknown>): { clientId: string | null; tenant: string | null; problem: string | null }
export function authorityFor(orgTenant: string | null, settingTenant: string | null): string
export class EntraTimeout extends Error {}
export class NoEntraSession extends Error {}
export interface EntraSignedIn extends EntraTokens { clientId: string; authority: string }
export interface EntraSession { url: string; tokens: Promise<EntraSignedIn> }
export interface EntraProvider {
  configProblem(): string | null
  begin(org: string, orgTenant: string | null, opts: { loginHint: string | null; signal: AbortSignal }): Promise<EntraSession>
  save(org: string, signedIn: EntraSignedIn): Promise<void>
  getToken(org: string): Promise<EntraTokens>
  hasSession(org: string): Promise<boolean>
  forget(org: string): Promise<void>
}
export function createEntraProvider(deps: {
  secrets: SecretsPort; fetch: typeof fetch; settings: () => Record<string, unknown>
  listen: Listen; random: Random; timeout: Timeout; now: () => number; log: (message: string) => void
}): EntraProvider
```

**Rules:**
- `readEntraSettings`:
  - `entraClientId` trimmed: empty → null; anything that isn't a GUID → `problem` `ENTRA.badClientId`.
  - `entraTenant` trimmed and lower-cased: empty → null; it must be a GUID or a DNS name with at least one dot (≤ 253 characters), else `problem` `ENTRA.badTenant`.
- `configProblem()` returns the settings' `problem` first, else `ENTRA.noClientId` when there is no client ID, else null.
- `authorityFor` returns the org's tenant, else the setting, else `organizations`.
- `begin`:
  - A config problem throws `EntraError('config', problem)` before any listener exists.
  - PKCE and `state` come from `random`.
  - The listener's signal is `AbortSignal.any([opts.signal, timeout(ENTRA_SIGN_IN_TIMEOUT_MS)])`. A bind failure throws `new Error(ENTRA.listenFailed)`.
  - `url` is `authorizeUrl(…)` for `authorityFor(orgTenant, settings.tenant)`, with `loginHint`.
  - `tokens`:
    - an `{ error, errorCode }` redirect rejects with `redirectError(error, errorCode)`;
    - `{ code }` is redeemed under the same combined signal;
    - when the timeout signal fired, it rejects with `EntraTimeout`; when the caller aborted, with the caller's reason.
  - The verifier, `state` and code stay inside `begin`.
  - The client ID and authority are captured at `begin`, so a settings change mid sign-in doesn't mix apps.
- `save` writes `entraKey(org)` = `JSON.stringify({ v: 1, clientId, authority: tenant ?? authority, refreshToken })`. A failure throws `new Error(ENTRA.notSaved)`.
- `getToken` refreshes with the stored `clientId`, `authority` and `refreshToken`, not with the current settings.
  - A missing or unreadable secret throws `NoEntraSession`.
  - A changed refresh token is written back. If that write fails, `log(ENTRA.rotateNotSaved)` and the tokens are still returned.
  - The access token is never stored.
- `hasSession` is true only for a readable `v: 1` secret. `forget` deletes it.
- **Settings (`orca-plugin.json`):**
  - `{ "key": "entraClientId", "title": "Microsoft sign-in: app (client) ID", "description": "From the app registration your admin created. See the README's admin guide.", "type": "string", "default": "", "placeholder": "00000000-0000-0000-0000-000000000000", "maxLength": 36 }`
  - `{ "key": "entraTenant", "title": "Microsoft sign-in: tenant", "description": "Used only when an organization's tenant can't be found. A tenant ID or domain; leave empty for any work or school account.", "type": "string", "default": "", "placeholder": "your-tenant.onmicrosoft.com", "maxLength": 253 }`
- **Copy (`ENTRA`):**
  - `noClientId` "Set the app (client) ID for Microsoft sign-in in Settings → Azure DevOps. The README explains how an admin creates it."
  - `badClientId` "The app (client) ID in Settings → Azure DevOps isn't a valid ID. Copy it again from the app registration."
  - `badTenant` "The Microsoft sign-in tenant in Settings → Azure DevOps isn't a tenant ID or domain."
  - `listenFailed` "Couldn't start the sign-in on this computer. Try again."
  - `notSaved` "Couldn't keep the sign-in in Orca's encrypted secrets."
  - `rotateNotSaved` "Couldn't save a renewed Microsoft sign-in; the previous one is kept."

- [ ] **Step 1: Write the failing tests.** Fake `listen` records its `state` and signal and resolves when the test delivers a redirect; fake `timeout` returns a controller's signal.
  - `begin refuses without a valid app ID or tenant and opens no listener`: empty → `ENTRA.noClientId`; `not-a-guid` → `ENTRA.badClientId`; tenant `foo` → `ENTRA.badTenant`; `listen` is never called.
  - `begin listens, builds the sign-in URL for the org's tenant and redeems the code with the verifier`:
    - the URL's `state` equals the one given to `listen`, and its `redirect_uri` is the listener's;
    - the token call's `code_verifier` hashes (S256) to the URL's `code_challenge`;
    - `redirect_uri` matches, and `tokens` resolves with `clientId === CLIENT_ID` and `authority === TENANT`.
  - `the authority is the org's tenant, then the tenant setting, then organizations`.
  - (**Review Focus 2**) `a cancelled or timed-out sign-in closes its port and keeps nothing`. This uses the real `listenForRedirect`:
    - aborting the caller's signal rejects `tokens` with its reason;
    - firing the timeout rejects with `EntraTimeout`;
    - in both, a connection to the port is refused, `fetch` was never called and the secrets are empty.
  - `save keeps only the refresh token, app ID and tenant under entra:<org>`: the exact secret JSON, which contains no access token.
  - (**Review Focus 4**) `getToken stores the rotated refresh token and reports invalid_grant as needs sign-in`:
    - a refresh sends the stored refresh token with the stored client ID to the stored authority, and a new `rt-ada-2` is written;
    - `invalid_grant` (`AADSTS700082`) rejects with `kind === 'needs_sign_in'`.
  - `a rotated token that can't be saved keeps the old one and is still used`: the log gets `ENTRA.rotateNotSaved`.
  - `hasSession is false for a missing or unreadable secret and forget deletes it`.
  - `entraKey refuses names that aren't org names`.
  - `settings changed mid sign-in don't change the app being redeemed`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, and add the two settings.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and `orca plugin validate . --json` pass.
- [ ] **Step 5: Commit** "Keep Microsoft sign-ins in Orca secrets and renew them silently".

### Task 4: Connect organizations with Sign in with Microsoft

**Files:**
- **Modify:** `src/shared/types.ts` (Shared types), `worker/connections.ts`, `worker/main.ts`.
- **Test:** `worker/connections.test.ts` (the `harness()` gains an `entra` dep built from `createEntraProvider` with a fake `listen`, `fakeEntra().fetch` and the harness's secrets; other existing tests stay unedited) and `worker/main.test.ts`.

**Interfaces:**
- Consumes:
  - Task 3: `EntraProvider`, `EntraTimeout`, `NoEntraSession`, `EntraSignedIn`.
  - Task 1: `EntraError`.
  - Task 2: `closeAllListeners`, `listenForRedirect`.
  - Plan 1: `begin`, `signIn`, `conclude`, `refuseAccount`, `expire`, `serial`, `credentialFor`, `tokenMatchesPin`, `decodeTokenClaims`, `discoverTenant`.
- Produces: `ConnectionsDeps.entra: EntraProvider`; `OrgStatus.signInUrl`; `deactivate()` also calls `closeAllListeners()`.

**Rules:**
- Every `unknownMethod` switch gains `entra`:
  - `tokenStoreOf` → `{ kind: 'orca-secrets' }`;
  - `credentialPresent` → `entra.hasSession`;
  - `forgetCredentials` and `discardSignIn` → `serial(org, () => entra.forget(org))`;
  - `acquire` → `acquireEntra`;
  - `connect` → `connectEntra`.
  - `resetInterrupted`'s fallback list becomes `['azure-cli', 'pat', 'entra']`.
- `connectEntra(parsed)`:
  1. `entra.configProblem()` → `draftError(parsed, 'entra', problem)`. Nothing is registered and no listener starts.
  2. `discoverTenant`, then `begin(parsed, 'entra', tenantId)`.
  3. `void signIn(cfg, attempt, obtain, keep)` and return `statusFor(cfg)`. `obtain(signal)`:
     - calls `entra.begin(org, cfg.tenantId, { loginHint: cfg.pinned?.uniqueName ?? null, signal })`;
     - while the attempt is current, records `session.url` as this attempt's sign-in URL and publishes;
     - awaits `session.tokens`, mapping `EntraTimeout` to `SignInTimedOut`;
     - returns `entraCredential(cfg, tokens)`.

     `keep` calls `entra.save(org, tokens)`. A `begin` failure flows through `signIn`, so a failed first connect unregisters and posts `orgs.connectFailed`, as for `az`.
- `entraCredential(cfg, tokens)`:
  - When `cfg.pinned?.objectId` is set and the id token's `objectId` differs, throw `OtherAccount(tokens.username ?? 'another account')`. ADO isn't asked.
  - When `tokenMatchesPin(cfg.pinned, cfg.tenantId, decodeTokenClaims(accessToken))` is false, throw `OtherAccount`.
  - Otherwise return `{ header: 'Bearer ' + accessToken, expiresAt, objectId: tokens.objectId ?? claims?.oid ?? null }`.

  `azCredential`'s shared part is reused rather than copied.
- `acquireEntra(cfg)`:
  - no session → `NoCredentialError`;
  - otherwise `serial(org, () => entra.getToken(org))`;
  - `NoEntraSession` → `NoCredentialError`; `EntraError` of kind `needs_sign_in` → `SignInNeeded`; anything else → `TokenUnavailable(messageOf(error))`, which starts the 60 s cool-down;
  - then `entraCredential`.

  Renewal is silent: `credentialFor` asks again from `expiresAt − 5 min`, and concurrent requests share the pending one.
- `statusOf` adds `signInUrl` only while the org is `signing-in`, its attempt is current and that attempt recorded a URL. `startAttempt`, `cancelAttempt` and `conclude` drop it.
- **`worker/main.ts`:**
  - `const entraSettings = await watchSettings(orca.settings, log)`;
  - `entra: createEntraProvider({ secrets: orca.secrets, fetch: globalThis.fetch, settings: entraSettings, listen: listenForRedirect, random: size => crypto.getRandomValues(new Uint8Array(size)), timeout: ms => AbortSignal.timeout(ms), now: Date.now, log })`;
  - `deactivate()` runs `closeAllListeners()` before `stopAllCommands`.

- [ ] **Step 1: Write the failing tests.** Connections tests use the harness; main tests use `withWorker` with settings `{ entraClientId: CLIENT_ID }` and a fake `fetch` for `vssps`, `login.microsoftonline.com` and `connectionData`.
  - `connect via Microsoft returns signing-in with the sign-in page, then posts connected`:
    - the first post has `state: 'signing-in'`, `method: 'entra'`, `tokenStore.kind === 'orca-secrets'` and a `signInUrl` whose `login_hint` is absent;
    - after the redirect is delivered, the last post is `connected` and has no `signInUrl`;
    - the pin is `{ adoId: 'u1', uniqueName: 'ada@contoso.com', objectId: OID_ADA }`;
    - the secret `entra:contoso` holds `rt-ada-1`.
  - (**Review Focus 1**) `an Entra sign-in for another account is refused before anything is saved`:
    - pinned to Ada with `objectId`, the id token is Grace's;
    - the state is `mismatch` with "Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.";
    - no `connectionData` call, no `entra:contoso` secret, the pin unchanged.
  - `a reconnect asks for the pinned account and still shows the picker`: the sign-in URL has `login_hint=ada@contoso.com` and `prompt=select_account`.
  - (**Review Focus 2**) `a cancelled or timed-out Entra sign-in leaves no listener and no state`:
    - `cancel` → the listener's signal is aborted, the state is `disconnected` with "Sign-in was cancelled.", no secret, no `signInUrl`, and the `signing-in` marker is cleared;
    - a timeout → "Sign-in timed out. Try again.", and a first connect stays registered as signed out.
  - `connect via Microsoft without an app ID explains where to set it and registers nothing`: the status is `error` with `ENTRA.noClientId`, and `orgs` stays `[]`.
  - (**Review Focus 5**) `a first Microsoft connect that Entra refuses explains why and registers nothing`: a `consent_required` redirect → `orgs.connectFailed` with `ENTRA.consent`, the org unregistered, no secret.
  - `an expired access token is renewed silently from the stored refresh token`: past `expiresAt − 5 min`, one refresh grant, a new `Bearer` header, and no new browser sign-in.
  - (**Review Focus 4**) `concurrent requests share one Entra refresh and invalid_grant expires the org once`:
    - three parallel requests make one refresh call;
    - then `invalid_grant` → `expired` with "Your sign-in expired. Reconnect to continue.";
    - one expired post, and no further refresh calls.
  - (**Review Focus 1**) `a refreshed Entra token for another object id is refused as a mismatch and its secret deleted`.
  - `signOut deletes only that org's Entra secret and keeps its settings`: with `contoso` and `fabrikam` both on Microsoft, signing out `contoso` keeps `entra:fabrikam`, `boards` and `codeProjects`.
  - `an Entra org whose secret is gone reports signed out` (R19).
  - `switching an org from Azure CLI to Microsoft wipes the profile and keeps the pin`.
  - `resetInterrupted wipes an Entra sign-in left by a previous worker`.
  - Extend `no secrets in posts or logs`: no post, log or stored value contains `rt-ada-1`, an access token, `c-ada-1` or the verifier.
  - main: `a Microsoft sign-in completes through the real redirect listener`:
    - read `signInUrl` from `orgsChanged(w.posts)`;
    - POST `code=c-ada-1&state=<state>` to `127.0.0.1:<port>` with `Host: localhost:<port>`;
    - the org connects;
    - `w.host.data().secrets` has `entra:contoso`;
    - the leak check (posts, logs, storage, calls other than `secrets.*`) finds no token, code or verifier.
  - (**Review Focus 2**) main: `deactivate during a Microsoft sign-in closes its port and the next start says it was interrupted`. After `deactivate` the port refuses connections; a new worker over the same storage lists the org `disconnected` with "Sign-in was interrupted. Try again." and no `entra:contoso`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run.** Expected: PASS, with every existing connections and main test green. Typecheck passes.
- [ ] **Step 5: Commit** "Connect organizations with Sign in with Microsoft".

### Task 5: Sign in with Microsoft in the panel

**Files:**
- **Modify:**
  - `src/panel/setup.tsx`: `METHODS`, `isMethod`, the hint, `openSignIn`, `signInNotice`.
  - `src/panel/panel.tsx`: `SigningIn`.
  - `src/panel/panel.check.ts`: the `signing-in-microsoft` scenario.
- **Test:** `src/panel/panel.test.tsx`.

**Interfaces:**
- Consumes: `OrgStatus.signInUrl`, method `entra` (Task 4); `shell`, `OPEN_LINK_UNAVAILABLE`, `messageOf`; the `openPr` pattern (`src/panel/prs/state.ts`).
- Produces: `export function openSignIn(url: string): void` and `export const signInNotice: Atom<string | null>` in `setup.tsx`.

**Rules and copy:**
- `METHODS` (in this order):
  - `{ value: 'azure-cli', label: 'Azure CLI (no setup)' }`
  - `{ value: 'entra', label: 'Microsoft account (needs an app ID)' }`
  - `{ value: 'pat', label: 'Personal access token' }`

  `isMethod` accepts `entra`. With `entra` chosen, a muted `Text size="sm"` under the radio group reads "Uses the app (client) ID in Settings → Azure DevOps. An admin registers the app once; the README explains how." Connect sends `{ orgInput, method: 'entra' }`, and `reconnect` connects directly, as for `azure-cli`.
- `SigningIn` for `method === 'entra'`:
  - the existing `Spinner` "Finish signing in in your browser…";
  - a neutral `Callout`: "Press Open sign-in page and pick the account you use for Azure DevOps. Orca asks before it opens login.microsoftonline.com. Tokens stay in Orca's encrypted secrets. Sign out deletes them.";
  - when `signInUrl` is present, a `Button` "Open sign-in page" beside the existing Cancel, disabled while `busy` is set;
  - `signInNotice` as a warning `Callout` when set.
- `openSignIn(url)`:
  - calls `shell.openExternal({ url })` first, synchronously in the press, then clears the notice;
  - `opened: false` with `cancelled` → "The sign-in page wasn't opened. Press Open sign-in page to try again.";
  - `consent-unavailable` → `OPEN_LINK_UNAVAILABLE`;
  - a rejection → `messageOf(error)`.

  The notice clears when the org leaves `signing-in`. The URL is never rendered as text.
- Scenario `signing-in-microsoft`: `org('contoso', { method: 'entra', state: 'signing-in', account: null, tokenStore: { kind: 'orca-secrets' }, signInUrl: 'https://login.microsoftonline.com/0f0e0d0c-0b0a-4908-8706-050403020100/oauth2/v2.0/authorize?client_id=6a1d3b5c-7e9f-4b2d-8c4a-1f3e5d7b9a20' })`.

- [ ] **Step 1: Write the failing tests.**
  - `the Microsoft option sends method entra and shows where the app ID comes from`:
    - choosing it shows the hint and no token field;
    - Connect sends exactly `{ orgInput: 'https://dev.azure.com/contoso', method: 'entra' }`.
  - `signing in with Microsoft opens the sign-in page from a press and never shows its address`:
    - pressing "Open sign-in page" makes exactly one `shell.openExternal` call with the URL;
    - `panel.summary()` never contains `login.microsoftonline.com/` or the client ID;
    - `closeCleanly` passes.
  - `a sign-in page Orca didn't open says so and the button stays`: the `cancelled` copy, then `OPEN_LINK_UNAVAILABLE`, with the button still pressable.
  - `a connected Microsoft org shows signed in as its account and its tokens in Orca's secrets`: the header reads "signed in as ada@contoso.com"; settings read "Tokens: Orca's encrypted secrets".
  - `Reconnect on an expired Microsoft org connects again without the setup form`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, and add the scenario.
- [ ] **Step 4: Run.** Expected: PASS. `orca plugin check . --json` and typecheck pass.
- [ ] **Step 5: Commit** "Sign in with Microsoft from the panel".

### Task 6: Proxy and CA settings

**Files:**
- **Create:** `worker/net/network.ts`.
- **Modify:**
  - `orca-plugin.json`: three settings.
  - `worker/messages.ts`: `NETWORK`.
  - `worker/auth/azcli.ts`: deps gain `extraEnv?: () => Record<string, string>`, merged last into `azEnv`.
  - `worker/status-bar.ts`: `statusText(orgs, counts?, notes: readonly string[] = [])` appends the notes.
  - `worker/main.ts`.
- **Test:** `worker/net/network.test.ts`, `worker/auth/azcli.test.ts` (one added case), `worker/status-bar.test.ts` (one added case), `worker/main.test.ts`.

**Interfaces:**
- Produces:

```ts
export interface NetworkSettings { httpsProxy: string; caFile: string; systemCa: boolean }
export interface NetworkPorts {
  getCACertificates(type: 'bundled' | 'system'): string[]
  setDefaultCACertificates(certs: string[]): void
  setProxy(env: Record<string, string>): () => void
  readFile(path: string): Promise<string>
}
export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'
export const MAX_CA_FILE_BYTES = 1024 * 1024
export function readNetworkSettings(values: Record<string, unknown>): NetworkSettings
export function parseProxy(text: string): { url: string } | { problem: string }
export function parsePem(text: string): { certs: string[] } | { problem: string }
export interface Network { apply(settings: NetworkSettings): Promise<void>; notes(): string[]; childEnv(): Record<string, string> }
export function createNetwork(ports: NetworkPorts, log: (message: string) => void): Network
export async function watchNetwork(settings: OrcaWorkerApi['settings'], network: Network): Promise<void>
```

**Rules:**
- `parseProxy`:
  - an `http:` or `https:` URL with a host and an optional port, no path beyond `/`, no query and no fragment → `{ url }`;
  - with a user name or password → `NETWORK.proxyPassword`;
  - anything else → `NETWORK.proxyInvalid`.
- `parsePem`: the text holds at most `MAX_CA_FILE_BYTES` and at least one `-----BEGIN CERTIFICATE-----` block, and each block parses with `new crypto.X509Certificate(block)`. Otherwise `NETWORK.caInvalid`.
- `apply`, serialised:
  - **Proxy.** It first calls the restore function of the previous proxy, if any. A valid proxy then gets `setProxy({ HTTPS_PROXY: url, NO_PROXY: LOOPBACK_NO_PROXY })`.
  - **CAs.** When `caFile` is set or `systemCa` is on, it calls `setDefaultCACertificates([...bundled, ...(systemCa ? system : []), ...fileCerts])`. When both are off but CAs were applied earlier in this run, it calls `setDefaultCACertificates(bundled)` to restore the default. With every setting empty from the start, neither port is ever called.
  - **Problems.** Each problem leaves that part unapplied. Its message goes to `notes()` (replaced on every apply) and to `log`. An unreadable file gives `NETWORK.caUnreadable`. No message contains the proxy URL, a password, a path or file content.
- `childEnv()` returns `{ HTTPS_PROXY, NO_PROXY }` while a proxy is applied, else `{}`.
- `watchNetwork` applies the current settings, then applies again on every `settings.onDidChange`.
- **`worker/main.ts`:**
  - `watchNetwork` runs first in `activate`, before `createConnections`. The ports are `node:tls`'s two functions, `http.setGlobalProxyFromEnv` and `fs.readFile(path, 'utf8')`.
  - `createAzCliProvider` gets `extraEnv: () => network.childEnv()`.
  - The `status` command passes `network.notes()`.
- **Settings (`orca-plugin.json`):**
  - `{ "key": "httpsProxy", "title": "HTTPS proxy", "description": "Send the plugin's Azure DevOps and Microsoft traffic through this proxy, like http://proxy.example.com:8080. Proxies that need a password aren't supported.", "type": "string", "default": "", "placeholder": "http://proxy.example.com:8080" }`
  - `{ "key": "caCertificatesFile", "title": "Extra CA certificates file", "description": "A PEM file of certificates to trust, for networks that inspect TLS.", "type": "string", "default": "", "placeholder": "/path/to/ca-certificates.pem" }`
  - `{ "key": "useSystemCertificates", "title": "Trust the system's certificates", "description": "Also trust the certificates your operating system trusts.", "type": "boolean", "default": false }`
- **Copy (`NETWORK`):**
  - `proxyInvalid` "The HTTPS proxy setting isn't an http:// or https:// address, so it's ignored."
  - `proxyPassword` "Proxy passwords aren't supported, so the HTTPS proxy setting is ignored."
  - `caUnreadable` "Couldn't read the extra CA certificates file, so it's ignored."
  - `caInvalid` "The extra CA certificates file isn't a PEM file of certificates, so it's ignored."

- [ ] **Step 1: Write the failing tests** (fake ports record calls).
  - `parseProxy accepts http and https proxies and refuses passwords, paths and other schemes`:
    - `http://proxy.example.com:8080` and `https://proxy.example.com` pass;
    - `http://u:p@proxy.example.com:8080` → `proxyPassword`, and the message contains neither `u:p` nor the host;
    - `socks5://…`, `proxy.example.com:8080`, `http://proxy.example.com/path` and `''` are refused (`''` only by `parseProxy`; `apply` treats empty as off).
  - `parsePem reads certificates and refuses empty, oversized or broken files`. It uses a fixture certificate generated once with `openssl` and committed at `worker/net/fixtures/test-ca.pem`.
  - `apply routes fetch through the proxy and always bypasses loopback`: `setProxy` receives exactly `{ HTTPS_PROXY: 'http://proxy.example.com:8080', NO_PROXY: 'localhost,127.0.0.1,::1' }`.
  - `apply restores the previous proxy before setting a new one and when cleared`.
  - `apply trusts bundled, system and file certificates and restores the default when cleared`.
  - `nothing is touched while every network setting is empty`.
  - `a bad proxy or CA file is ignored with a message and nothing else changes`: the notes and log hold the exact copy; a valid CA file next to a bad proxy is still applied.
  - azcli: `az runs with the proxy setting in its environment`.
  - status bar: `status text lists ignored network settings after the org lines`.
  - main: `the status command reports an ignored proxy setting`, with settings `{ httpsProxy: 'ftp://proxy.example.com' }`; no global is touched.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement and wire**, and add the settings.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck and validate pass.
- [ ] **Step 5: Commit** "Honour proxy and CA settings".

### Task 7: README: Sign in with Microsoft, the admin guide and network settings

**Files:** `README.md`.

- [ ] **Step 1: Connecting an organisation.** Add the third method between the two existing ones: "**Microsoft account (needs an app ID).** Signs in with Microsoft Entra ID through an app your admin registers once (see below). It doesn't need the Azure CLI, so it also suits Windows (not yet checked live)."
- [ ] **Step 2: Add "Sign in with Microsoft"** for users:
  1. paste the app ID into `entraClientId`;
  2. choose the method and press Connect;
  3. press **Open sign-in page**. Orca asks before opening `login.microsoftonline.com`; ticking "Always allow" skips that next time;
  4. pick the account; the tab says "You're signed in…";
  5. the panel shows `signed in as <account>`.

  Then:
  - The account picker shows every time. The org is pinned, and another account is refused.
  - Cancel works at any time, and a sign-in stops after 5 minutes. While it waits, the plugin listens only on `127.0.0.1`, and only for that one sign-in.
  - **Where credentials live** gains: "**Microsoft:** the refresh token for each organisation is kept in Orca's encrypted secrets; access tokens stay in memory and are renewed before they expire. Sign out deletes it. It doesn't sign you out of Microsoft in your browser."
  - Troubleshooting: one line per `ENTRA` message from Task 1, saying who fixes it (you or your admin).
- [ ] **Step 3: Add "Registering the app (for admins)".** Generic, with no tenant, org or app values. Steps:
  1. In the Microsoft Entra admin center, open **App registrations → New registration**.
  2. Name it, for example "Azure DevOps for Orca".
  3. **Supported account types:** "Accounts in this organizational directory only" when every Azure DevOps organization your people use is in this tenant; "Accounts in any organizational directory" when they also sign in to organizations in other tenants. Each of those tenants' admins then consents once.
  4. **Redirect URI:** platform "Public client/native (mobile & desktop)", value `http://localhost`. Register.
  5. **Authentication → Advanced settings → Allow public client flows: Yes.** This marks the app as a public client, so Entra never asks the plugin for a secret. The plugin itself uses only the browser sign-in.
  6. **API permissions → Add a permission → APIs my organization uses →** search "Azure DevOps" (`499b84ac-1321-427f-aa17-267ca6975798`) **→ Delegated → `user_impersonation` → Add.** Keep Microsoft Graph `User.Read`.
  7. If people in your tenant can't consent to apps themselves, **Grant admin consent for <your tenant>**.
  8. Copy the **Application (client) ID** from Overview and give it to your developers. Don't create a client secret or certificate.

  Then three notes:
  - The organization must be connected to Microsoft Entra ID; organizations that use personal Microsoft accounts need the Azure CLI or a PAT.
  - Conditional Access applies as for any sign-in.
  - Removing consent, or deleting the registration, stops every saved sign-in, which then asks to reconnect.
- [ ] **Step 4: Add "Proxies and certificates":**
  - why these settings exist (Orca doesn't pass the proxy or certificate environment variables to plugins);
  - the three settings and what each does; proxies with passwords aren't supported;
  - `az` uses the proxy but not the certificate settings, so behind TLS inspection use Sign in with Microsoft or a PAT;
  - **Azure DevOps: Connection status** lists any setting that was ignored, and why.
- [ ] **Step 5: Settings** gains the five keys with their defaults. **Requirements** notes that Sign in with Microsoft needs an app registration. **Live checks still pending** gains the Task 0 Step 6 rows.
- [ ] **Step 6: Verify.**
  - `git grep -n -E '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' README.md` shows only `499b84ac-1321-427f-aa17-267ca6975798` and the all-zero placeholder.
  - Every label quoted in the admin guide is marked for the Task 9 portal check.
  - `orca plugin validate . --json` passes.
- [ ] **Step 7: Commit** "Document Sign in with Microsoft and the admin app registration".

### Task 8: Release prep: icon, permissions and the checklist

**Files:**
- **Create:** `scripts/make-icon.mjs`, `assets/icon.png`, `worker/manifest.test.ts`, `docs/release-checklist.md`.
- **Modify:** `orca-plugin.json`, `README.md`.

**Interfaces:**
- Produces: `node scripts/make-icon.mjs` writes `assets/icon.png`, and running it again produces identical bytes.

**Rules:**
- **The icon.**
  - A 256×256 RGBA PNG, under 256 KB.
  - A rounded square (radius 48) in `#2B59C3`, holding three white rounded bars (radius 12), 36 wide and 20 apart, centred, tops at y = 60, heights 136, 96 and 116.
  - 4×4 supersampling, `zlib.deflateSync` level 9 and `zlib.crc32`. No dependencies and no Microsoft marks.
- **Manifest:**
  - `"icon": "assets/icon.png"`
  - `"author": { "name": "Gerhard Kloppers", "url": "https://github.com/CanadianMapleFarmer" }`
  - `"homepage": "https://github.com/CanadianMapleFarmer/orca-azure-devops"`
  - `"description": "Unofficial. Azure DevOps work items, boards, pipelines, pull requests and wikis in the Orca sidebar."`
  - `version` stays `0.1.0` (the checklist covers choosing one).
- **README:**
  - The opening is one paragraph and the line "Unofficial: not made or endorsed by Microsoft. Azure DevOps is a trademark of Microsoft."
  - "Status: under construction" and the Works now / Coming table become a feature list of what works.
  - A **Permissions** section with one line per capability, hook and event that `orca plugin inspect . --json` lists, naming the feature that uses it. Find each with `git grep` on the capability or hook name.
- **`docs/release-checklist.md`:**
  - **Before every release** (an agent may run these):
    1. the four verification commands;
    2. `orca plugin inspect . --json` compared with the README's Permissions and Settings (file count ≤ 2,000, size ≤ 50 MiB, recorded);
    3. a privacy scan: `git grep -n -i -E '<terms>'` with terms the user supplies at release time, which are never written into the repository, plus a review of every GUID that `git grep` finds (only fixtures and `499b84ac-…` may remain). One planning document names the author's employer in its Global Constraints, so the user decides whether to redact it or leave `docs/superpowers/` and `docs/research/` out of the public repository;
    4. images meet the rules (`worker/manifest.test.ts`) and show fixture data only;
    5. the README's settings list matches the manifest, and its pending live checks are current;
    6. the license (MIT, Plan 1's call) is confirmed by the user;
    7. `version` is the same in `orca-plugin.json` and `package.json`.
  - **Publishing, only when the user asks** (never run by an agent on its own; GitHub work uses the CanadianMapleFarmer account's credentials):
    1. create the public repository `CanadianMapleFarmer/orca-azure-devops` and push `main`;
    2. set `version`, commit, then `git tag -a v<version> -m v<version>` and push the tag;
    3. `gh repo edit CanadianMapleFarmer/orca-azure-devops --add-topic orca-plugin`;
    4. check `https://www.onorca.dev/plugins/CanadianMapleFarmer/orca-azure-devops`;
    5. for a catalog, run `orca plugin release-entry . --json` at the tag and paste its entry into that catalog's `orca-catalog.json` `releases`, newest first;
    6. install from the listing on a clean Orca profile and follow the README's first connect.

- [ ] **Step 1: Write the failing test.** `worker/manifest.test.ts`, `the manifest icon and screenshots meet Orca's image rules`. It reads `orca-plugin.json` and the PNG headers (signature, then IHDR width and height):
  - the icon is square, at least 128 px and at most 256 KB;
  - at most 6 screenshots, each at least 1280×800 and at most 1536 KB, each with a non-empty `alt`;
  - all images together at most 8 MB.
- [ ] **Step 2: Run.** Expected: FAIL (no `icon`).
- [ ] **Step 3: Write the script, run it, and update the manifest, README and checklist.**
- [ ] **Step 4: Run.** Expected: PASS. Running the script again leaves `git diff --exit-code assets/icon.png` clean. Validate and check pass. Read `assets/icon.png` and confirm it looks as described.
- [ ] **Step 5: Commit** "Prepare the release: icon, permissions and checklist".

### Task 9: Verification, screenshots and live checks

- [ ] **Step 1: Run the full offline suite.** `npm run typecheck`, `orca plugin test . --json` (`# fail 0`), `orca plugin validate . --json`, `orca plugin check . --json`.
- [ ] **Step 2: Inspect review.** Run `orca plugin inspect . --json` and show the user what the plugin contributes and asks for. Record the file count, size and hash in `docs/release-checklist.md`.
- [ ] **Step 3: Live checks, with the user present.** They need the user's sandbox org and a sandbox app registration made by following the README's admin guide. The user loads the plugin; the agent never runs `dev load` or `--approve`. Fill the pending rows of `docs/superpowers/spikes/2026-11-05-plan-6.md`:
  - (a) Walk the admin guide in the portal and fix every label that differs.
  - (b) Connect with Microsoft:
    - the consent dialog and how often it asks;
    - the account picker;
    - "signed in as";
    - the browser tab's page.
  - (c) Pick the other account on the pinned org: refused, and the message names both accounts.
  - (d) Press Cancel mid sign-in; let one sign-in time out. After each, `lsof -nP -iTCP -sTCP:LISTEN` shows no plugin listener.
  - (e) Restart Orca: the org reconnects without the browser. After the access token's lifetime, requests still succeed.
  - (f) Sign out, then Reconnect, which needs the browser again.
  - (g) Reach the redirect from Safari, Chrome and Firefox.
  - (h) Try "Allow public client flows: No" and record whether `AADSTS7000218` appears. Update README step 5 to "optional" if it doesn't.
  - (i) A proxy, only if the user has one.
  - (j) Read-only on the client org, if the user wants: Microsoft sign-in with the client tenant's app, when one exists.
- [ ] **Step 4: Screenshots, with the user present and Orca minimised.**
  - For each of three scenarios (`work`, `prs` and Plan 4's Pipelines scenario; names per Task 0) and both themes, run `orca plugin shot . --scenario <name> --theme <light|dark> --width 1280 --out assets/screenshots/<name>-<theme>.png --json`. Check `themeApplied: true`.
  - Bring each PNG to at least 1280×800 and at most 1536 KB:
    - pad a shot that is shorter than 16:10 to 16:10 for its own width with `sips --padToHeightWidth <width × 10 / 16> <width> --padColor <hex>`, where `<hex>` is the shot's first pixel, read from its decompressed first IDAT row with `python3 -I` (stdlib `zlib`);
    - convert one that is still over 1536 KB to JPEG with `sips -s format jpeg -s formatOptions 85`.
  - View every image: only fixture names (`contoso`, `Fabrikam`, Ada, Grace).
  - Add the `screenshots` entries, each with `alt`, `caption` and `theme`, and two light images to the README.
  - `worker/manifest.test.ts` and validate pass.
- [ ] **Step 5: Roadmap and report.**
  - Roadmap row 6 reads "Sign in with Microsoft (Entra auth code + PKCE, loopback; Plan 6 ruling P1)".
  - Report:
    - the spikes settled and the live rows left;
    - rulings P1–P8, for the user to confirm or overturn;
    - the publishing steps, which wait for the user to ask.
- [ ] **Step 6: Commit** "Add screenshots and record the Plan 6 live checks".

---

## Pre-flight scan

Baseline: the post-Plan-5 head, with Plans 4 and 5 as specified. "Fixed" means the plan above already carries the fix.

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Finding |
|---|---|---|
| T0 → T1–T9 | S1–S4 decisions (P1–P8), pending live rows → T9 | OK. P1 is decided here; T0 stops only if Orca installs npm dependencies itself. |
| T0 ↔ Plans 4 and 5 | `README.md`, `orca-plugin.json`, `panel.tsx`, `main.ts` and the check scenario names | **Risk, handled.** Plan 4 is still executing elsewhere; T0 re-reads them at the post-Plan-5 head and returns drift before T1. |
| T1 ↔ Plan 1 `azcli.ts` | `ADO_RESOURCE` | **Duplicate, fixed.** The Entra scope needs the resource id; it moves to `worker/ado/org.ts` with the other hosts, and `azcli.ts` re-exports it, so `azcli.test.ts` stays unedited. |
| T1 ↔ Plan 5 "hosts only from `org.ts`" | `entraAuthorizeUrl`, `entraTokenUrl` | OK. |
| T1 → T3, T4 | `redeemCode`, `refreshTokens`, `redirectError`, `EntraError.kind` | OK. `needs_sign_in` is the only kind T4 treats specially. |
| T2 → T3, T4 | `Listen`, `listenForRedirect`, `closeAllListeners` | OK. T3 tests the real listener for Review Focus 2; T4's harness fakes it; T4's main tests run it for real. |
| T3 → T4 | `EntraProvider`, `EntraTimeout`, `NoEntraSession`, `EntraSignedIn` | OK. `EntraSignedIn` carries the client ID and authority that `save` needs, so the refresh token never needs the settings. |
| T3, T6 ↔ manifest | Five new settings | OK. Appended after Plan 4's settings, in task order; no capability changes. |
| T4 ↔ Plan 1 `connections.ts` | Third method in every `unknownMethod` switch | **Conflict, fixed.** The compiler forces each switch; T0 lists them. Existing tests stay unedited except the `harness()`, which gains the `entra` dep. |
| T4 ↔ Plan 1 R20 (wipe before `az login`) | Reconnect | OK. Nothing is saved before verification; success replaces the secret, and cancel or timeout wipes it through the existing `wipeCredentials`, as `az` does. |
| T4 ↔ Plan 1 R27, R28 | Object-id pinning, re-auth errors → expired | OK. `entraCredential` reuses `tokenMatchesPin`; `needs_sign_in` maps to `SignInNeeded`. |
| T4 ↔ Plan 1 R33 | `deactivate` stops sign-ins | OK. `closeAllListeners()` joins `stopAllCommands`. |
| T4 → T5 | `signInUrl`, method `entra` | OK. |
| T5 ↔ Plan 3 S2 | One open per press, before any await | OK. `openSignIn` follows `openPr`; the URL arrives earlier by post. |
| T5 ↔ T9 | `panel.check.ts` scenarios | OK. T5 adds `signing-in-microsoft`; T9 shoots existing scenarios. |
| T6 ↔ T4 in `main.ts` | Order of `activate` | OK. `watchNetwork` runs first, before anything calls `fetch`. |
| T6 ↔ Plan 1 `azcli.ts` | `extraEnv` | OK. Optional, merged last; existing tests stay unedited. |
| T6 ↔ Plans 3 and 4 `status-bar.ts` | `statusText` | OK. The third parameter is optional; existing cases stay unedited. |
| T6 ↔ every mounted test | Process-wide proxy and CA | **Risk, handled.** Only `main.ts` passes real ports; mounted tests use empty or invalid settings, which never call them. |
| T7, T8 ↔ Plans 4 and 5 README | Sections | OK. Each adds its own sections; T8 rewrites only the opening and the status table. |
| T8 → T9 | `worker/manifest.test.ts` | OK. It already covers the screenshots T9 adds. |
| T1, T2, T3, T6 | `worker/messages.ts` | OK. Distinct objects (`ENTRA`, `REDIRECT_PAGE`, `NETWORK`), edited in task order. |

### Each task against itself

| Task | Finding |
|---|---|
| T0 | OK. Commits only the spike record; probes stay outside the repository. |
| T1 | OK. RFC 7636 known answer; every row of the error table has a case (Review Focus 5). |
| T2 | OK. Real sockets on `127.0.0.1`, each refusal kind, and abort (Review Focus 3). |
| T3 | OK. Settings validation, the real listener on cancel and timeout (Review Focus 2), rotation (Review Focus 4). |
| T4 | OK. Each rule has a case, including Review Focus 1, 2, 4 and 5 and the end-to-end main test. |
| T5 | OK. Press order and the no-URL-in-tree check; `plugin check` renders the new scenario. |
| T6 | OK. Fake ports only, plus one main test that touches no globals. |
| T7 | OK. Docs only; the GUID scan guards "no tenant-specific values". |
| T8 | OK. The image rules are tested; the icon script is deterministic. |
| T9 | OK. Verification, screenshots and live rows, with the user present. |
