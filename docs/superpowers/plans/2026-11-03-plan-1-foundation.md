# Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable Orca plugin whose sidebar hub connects any Azure DevOps org through a private Azure CLI profile or a PAT. Each org is pinned to one account and remembers its boards project, team and code projects. A typed ADO HTTP client is in place for every later plan.

**Architecture:** One `trusted-worker` plugin.
- **Worker** (`worker/main.ts`, Node, transpiled by Orca): owns all network, credentials and state. Its modules take narrow injected ports (fetch, command runner, store, secrets, post) so they unit-test without Orca.
- **Sidebar panel** (`src/panel/panel.tsx`, `"ui": "components"`): talks to the worker only through `plugin.request` handlers and `orgs.changed` posts, declared once in `src/protocol.ts`.

**Tech Stack:**
- TypeScript, loaded build-less by Orca (`engines.orca >=1.4.248`).
- Orca components runtime and `orca/testing` (node:test), run with `orca plugin test`.
- Azure CLI (`az`) as a subprocess.
- Node 24 global `fetch`.
- No npm runtime dependencies in this plan.

**Spec:** `docs/superpowers/specs/2026-11-03-azure-devops-plugin-design.md` (sections 4.1–4.3, 5.1, 5.6, 5.8, 5.9). Read it before starting.

## Global Constraints

**Manifest and versions**
- `orca-plugin.json`:
  - `manifestVersion: 2`, `execution: "trusted-worker"`.
  - `id: "azure-devops"`, `name: "Azure DevOps"`, `engines.orca: ">=1.4.248"`, `pluginApi: 1`.
  - No `publisher` field.
- Orca 1.4.248 features are allowed. Anything newer is feature-detected with `host.has` / `ui.has`.
- The status bar item keeps the worker running while the plugin is enabled, so the worker must stay idle-cheap: no busy loops, and timers only through the polling scheduler (later plans).

**Capabilities in this plan:** `storage:own`, `secrets:own`, `settings:own` only. Later plans add what they use (`workspace:read`, `notifications:show`, `terminal:send`), and only capabilities that exist on 1.4.248. Each addition re-prompts the user's approval, which is intended.

**Safety rules**
- Never approve the plugin on the user's behalf. When Orca exits `3` (`approval_required`), show the user `error.data` and the exact `--approve` command, and stop until they say so.
- The worker never runs the `orca` CLI.
- Workspace actions only ever happen through `terminal:send` text the user sees, or a manual step (spec §5.7).

**Credentials**
- No token, PAT, `Authorization` header or `az` token output may be written to `orca.log`, `orca.storage`, panel state, notifications or error messages.
- PATs live only in `orca.secrets` under key `pat:<org>`.
- Azure CLI tokens live only in the private profile directory `~/.orca-azure-devops/az/<org>`:
  - Created with mode `0700`.
  - Exported to `az` as `AZURE_CONFIG_DIR`.
  - Never `~/.azure`.
  - Never turn on `core.encrypt_token_cache`.
- Sign out deletes that directory, or the `pat:<org>` secret.

**Runtime**
- The worker never writes inside the plugin folder (its content hash is verified before every spawn).
- No long operation is awaited inside a `panels.handle` handler or a command. Sign-in starts, the handler returns, and completion arrives as an `orgs.changed` post.
- Hosts and versions:
  - ADO REST base `https://dev.azure.com/{org}`, default `api-version=7.1`.
  - Tenant discovery host `https://vssps.dev.azure.com/{org}`.
  - ADO resource id `499b84ac-1321-427f-aa17-267ca6975798`.

**Generic, not one company's setup:** no org, project, team, branch, column or account names hard-coded anywhere outside test fixtures. Fixtures use `contoso` / `fabrikam`.

**Repo hygiene**
- Commits in this repo use the local identity already configured (`Gerhard Kloppers <66121776+CanadianMapleFarmer@users.noreply.github.com>`), each ending with the `Co-Authored-By` trailer from the session.
- Never commit `node_modules/` or `.orca/`.
- Code comments follow the user's global rule: default to zero, one line only for a non-obvious constraint.

**License:** MIT (Claude's call; confirm with the user before publishing).

## Review Focus

1. **`az` not found when Orca was launched from the Dock.** Find `az` in Homebrew/usr-local locations or the `azPath` setting, and otherwise show "Azure CLI not found. Install it or set its path in Settings". Never a bare "connection failed". *Test: Task 5, `findExecutable falls back to Homebrew dirs when PATH is empty`.*
2. **Signing in with the wrong account** in the browser, e.g. the infra account. Refuse, name both accounts, pin nothing, delete the just-created profile, and offer "Try again". *Test: Task 7, `connect refuses when the az account differs from the pinned account`.*
3. **A token expires while Orca stays open overnight.** Refresh once silently: az refreshes, a PAT is re-read. If that fails, the org shows `expired` with Reconnect; lists never silently empty. *Test: Task 7, `401 triggers one refresh then marks the org expired`.*
4. **ADO throttling (429 or 503 with `Retry-After`).** Wait and retry at most twice, then fail with `rate_limited` carrying `retryAfterMs`. Never spin. *Test: Task 3, `honours Retry-After then gives up after two retries`.*
5. **The worker is reaped or restarted mid sign-in.** An org stuck in `signing-in` from a previous worker run must come back as `disconnected` with "Sign-in was interrupted", not spin forever. *Test: Task 7, `activate resets orgs left signing-in`.*

---

## File map

| File | Responsibility |
|------|----------------|
| `orca-plugin.json` | Manifest: panel, settings, capabilities |
| `package.json`, `tsconfig.json`, `LICENSE`, `README.md` | Tooling and docs (`typescript` dev dependency only) |
| `src/shared/types.ts` | Types shared by worker and panel (`OrgConfig`, `OrgStatus`, …) |
| `src/protocol.ts` | `PluginRequests` / `PluginPanelEvents` declarations |
| `worker/main.ts` | `activate(orca)`: builds ports and services, registers handlers |
| `worker/ado/org.ts` | Org URL parsing and tenant discovery |
| `worker/ado/http.ts` | ADO HTTP client: URLs, api-version, auth, errors, retries |
| `worker/ado/core.ts` | `connectionData`, projects, teams |
| `worker/auth/identity.ts` | JWT claim decoding, `PinnedAccount` checks |
| `worker/auth/azcli.ts` | Private-profile Azure CLI provider |
| `worker/auth/pat.ts` | PAT provider |
| `worker/sys/run.ts`, `worker/sys/find-executable.ts` | Subprocess runner and executable lookup |
| `worker/connections.ts` | Org registry, sign-in orchestration, pinning, auth headers, status posts |
| `worker/status-bar.ts` | Pure mapping from org statuses to the status bar item, plus the `status` command text |
| `src/panel/panel.tsx`, `src/panel/state.ts`, `src/panel/setup.tsx`, `src/panel/org-settings.tsx`, `src/panel/panel.check.ts` | Sidebar hub |

Tests sit beside their files as `*.test.ts(x)`.

## Shared types (defined in Task 1, used everywhere)

```ts
// src/shared/types.ts
export type ConnectionMethod = 'azure-cli' | 'pat'
export interface PinnedAccount { adoId: string; uniqueName: string; displayName: string; tenantId: string | null }
export interface BoardsTarget { projectId: string; projectName: string; teamId: string; teamName: string }
export interface OrgConfig {
  org: string                      // canonical, lower-case: "contoso"
  url: string                      // "https://dev.azure.com/contoso"
  tenantId: string | null
  method: ConnectionMethod
  pinned: PinnedAccount | null
  boards: BoardsTarget | null
  codeProjects: 'all' | { id: string; name: string }[]
}
export type OrgState = 'disconnected' | 'signing-in' | 'connected' | 'expired' | 'mismatch' | 'error'
export interface OrgStatus {
  org: string; url: string; method: ConnectionMethod; state: OrgState
  account: PinnedAccount | null
  message?: string                 // user-facing, never contains secrets
  tokenStore: { kind: 'orca-secrets' } | { kind: 'az-profile'; path: string }
  boards: BoardsTarget | null; codeProjects: OrgConfig['codeProjects']
}
```

```ts
// src/protocol.ts
import type { BoardsTarget, ConnectionMethod, OrgConfig, OrgStatus } from './shared/types'
declare module 'orca' {
  interface PluginRequests {
    'plugin.ping': { input: {}; output: { version: string } }
    'orgs.list': { input: {}; output: OrgStatus[] }
    'orgs.connect': { input: { orgInput: string; method: ConnectionMethod; pat?: string }; output: OrgStatus }
    'orgs.signOut': { input: { org: string }; output: OrgStatus }
    'orgs.remove': { input: { org: string }; output: { ok: true } }
    'ado.projects': { input: { org: string }; output: { id: string; name: string }[] }
    'ado.teams': { input: { org: string; projectId: string }; output: { id: string; name: string }[] }
    'orgs.setBoards': { input: { org: string; projectId: string; teamId: string }; output: OrgStatus }
    'orgs.setCodeProjects': { input: { org: string; projects: 'all' | string[] }; output: OrgStatus }
  }
  interface PluginPanelEvents { 'orgs.changed': { orgs: OrgStatus[] } }
}
```

---

### Task 1: Scaffold the plugin, manifest and smoke test

**Files:**
- Create: everything from `orca plugin create <tmp> --template worker-panel --id azure-devops --name "Azure DevOps"`, copied into the repo root and then edited. The repo already holds `docs/` and `.gitignore`, and `create` never overwrites.
- Create: `src/shared/types.ts`, `src/protocol.ts` (exact contents above), `LICENSE` (MIT, "Gerhard Kloppers"), `README.md` (one paragraph plus "Status: under construction").
- Modify: `orca-plugin.json`, `package.json`, `tsconfig.json`.
- Test: `worker/main.test.ts`.

**Interfaces:**
- Produces: `export default async function activate(orca: OrcaWorkerApi): Promise<void>` in `worker/main.ts`; handler `plugin.ping` returns `{ version }`, read from `orca-plugin.json`'s version, injected as a constant.

- [ ] **Step 1: Scaffold into a temp dir and move the files in.** Run `orca plugin create /tmp/ado-scaffold --template worker-panel --id azure-devops --name "Azure DevOps" --json` and copy its files into the repo root, keeping our `.gitignore` and `docs/`. Rename the template's worker/panel files to the paths in the file map, and follow the template's import-extension and tsconfig conventions everywhere after this.
- [ ] **Step 2: Write `orca-plugin.json`.**
  - Fields from Global Constraints.
  - `main: "worker/main.ts"`.
  - One panel `{ "id": "ado", "title": "Azure DevOps", "icon": "cloud", "entry": "src/panel/panel.tsx", "ui": "components" }`.
  - The three capabilities from Global Constraints.
  - `contributes.statusBarItems: [{ "id": "status", "text": "ADO", "icon": "cloud", "tooltip": "Azure DevOps", "command": "status" }]` and `contributes.commands: [{ "id": "status", "title": "Azure DevOps: Connection status" }]`.
  - One setting `{ "key": "azPath", "title": "Azure CLI path", "description": "Leave empty to find az automatically.", "type": "string", "default": "", "placeholder": "/opt/homebrew/bin/az" }`.
  - `repository` set to `https://github.com/CanadianMapleFarmer/orca-azure-devops`, `license` set to `"MIT"`.
- [ ] **Step 3: Write the failing smoke test.**

```ts
// worker/main.test.ts
import { assert, mountWorker, test } from 'orca/testing'
import * as worker from './main.ts'
test('ping answers with the plugin version', async () => {
  const w = await mountWorker(worker)
  const out = await w.request('plugin.ping', {})
  assert.match(out.version, /^\d+\.\d+\.\d+$/)
  assert.equal(w.refusals.length, 0)
})
```

- [ ] **Step 4: Run it.** `orca plugin test . --json`. Expected: FAIL (`unknown_method` for `plugin.ping`).
- [ ] **Step 5: Implement `activate` with the `plugin.ping` handler.** Remove the template's demo handlers.
- [ ] **Step 6: Verify.**
  - `orca plugin test . --json` → `"ok": true`.
  - `npx tsc -p .` → exit 0.
  - `orca plugin validate . --json` → exit 0.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "Scaffold the Azure DevOps plugin with a worker ping"`.

### Task 2: Parse org input and discover the tenant

**Files:**
- Create: `worker/ado/org.ts`.
- Test: `worker/ado/org.test.ts`.

**Interfaces:**
- Produces:
  - `parseOrgInput(input: string): { org: string; url: string } | null`
  - `discoverTenant(org: string, fetchFn: typeof fetch): Promise<string | null>`

- [ ] **Step 1: Write the failing tests.**

```ts
test('parseOrgInput accepts the common forms', () => {
  for (const input of ['contoso', ' Contoso ', 'https://dev.azure.com/contoso', 'https://dev.azure.com/Contoso/',
    'https://dev.azure.com/contoso/Web/_git/api', 'https://user@dev.azure.com/contoso/Web/_git/api',
    'https://contoso.visualstudio.com', 'contoso.visualstudio.com/DefaultCollection/Web'])
    assert.deepEqual(parseOrgInput(input), { org: 'contoso', url: 'https://dev.azure.com/contoso' })
})
test('parseOrgInput rejects other hosts and junk', () => {
  for (const input of ['', 'https://github.com/contoso', 'https://dev.azure.com/', 'not a url/with spaces'])
    assert.equal(parseOrgInput(input), null)
})
test('discoverTenant reads x-vss-resourcetenant from an anonymous HEAD', async () => {
  const calls: Request[] = []
  const fake = async (input: RequestInfo, init?: RequestInit) => {
    calls.push(new Request(input, init))
    return new Response(null, { status: 404, headers: { 'x-vss-resourcetenant': '11111111-2222-3333-4444-555555555555' } })
  }
  assert.equal(await discoverTenant('contoso', fake as typeof fetch), '11111111-2222-3333-4444-555555555555')
  assert.equal(calls[0].method, 'HEAD')
  assert.equal(calls[0].url, 'https://vssps.dev.azure.com/contoso')
  assert.equal(calls[0].headers.get('authorization'), null)
})
test('discoverTenant returns null when the header is missing or all zeros', async () => { /* 00000000-0000-0000-0000-000000000000 → null (MSA-backed org) */ })
```

- [ ] **Step 2: Run.** `orca plugin test . --json`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement both functions in `worker/ado/org.ts`.**
  - Org names: `[a-z0-9][a-z0-9-]{0,49}` after lower-casing.
  - `*.visualstudio.com` maps to its subdomain.
  - Any path after the org is ignored.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `worker/ado/org*.ts`: "Parse org URLs and discover their tenant".

### Task 3: ADO HTTP client

**Files:**
- Create: `worker/ado/http.ts`.
- Test: `worker/ado/http.test.ts`.

**Interfaces:**
- Produces:

```ts
export type AdoErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'precondition_failed'
  | 'rate_limited' | 'bad_request' | 'server' | 'network'
export class AdoError extends Error { constructor(code: AdoErrorCode, status: number, message: string, retryAfterMs?: number) }
export interface AdoRequest {
  org: string; project?: string; path: string            // path starts with "/_apis/..."
  query?: Record<string, string | number | boolean | undefined>
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown
  contentType?: 'application/json' | 'application/json-patch+json'
  apiVersion?: string                                     // default "7.1"
  ifMatch?: string; signal?: AbortSignal
}
export interface AdoHttp { json<T>(req: AdoRequest): Promise<{ data: T; headers: Headers }> }
export function createAdoHttp(deps: {
  fetch: typeof fetch
  authHeader: (org: string) => Promise<string>            // "Bearer …" or "Basic …"
  onUnauthorized?: (org: string) => Promise<boolean>      // true = credentials refreshed, retry once
  sleep?: (ms: number) => Promise<void>
}): AdoHttp
```

- [ ] **Step 1: Write the failing tests.** Fake `fetch` records each `Request`.
  - `builds project-scoped URLs with api-version 7.1`: `{org:'contoso', project:'Web App', path:'/_apis/git/repositories'}` → `https://dev.azure.com/contoso/Web%20App/_apis/git/repositories?api-version=7.1`. The `Authorization` header equals what `authHeader` returned.
  - `per-call apiVersion and query`: `apiVersion: '7.1-preview.4'` and `query: { $top: 5, x: undefined }` produce `?$top=5&api-version=7.1-preview.4`.
  - `retries once with -preview on VssInvalidPreviewVersionException`: a first 400 with body `{"typeKey":"VssInvalidPreviewVersionException","message":"…"}` is followed by a second request with `api-version=7.1-preview`.
  - `maps statuses to codes`:
    - 401 → `unauthorized`.
    - 203 with an HTML body → `unauthorized`.
    - 403 → `forbidden`, 404 → `not_found`, 409 → `conflict`, 412 → `precondition_failed`.
    - 500 → `server`.
    - `message` comes from the JSON `message` field when present.
  - `honours Retry-After then gives up after two retries` (**Review Focus 4**): three 429s with `Retry-After: 2` → `sleep` called with `2000` twice, then `AdoError('rate_limited', 429, …, 2000)`.
  - `401 asks onUnauthorized once`: `onUnauthorized` resolves true → the request is retried once with a fresh `authHeader()`. A second 401 throws `unauthorized` without calling `onUnauthorized` again.
  - `never puts the Authorization value in error messages`: an error message never contains the header value.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `createAdoHttp` in `worker/ado/http.ts`.**
  - JSON bodies are serialised with the given content type.
  - `If-Match` is sent when `ifMatch` is set.
  - Network failures become `network`.
  - `sleep` defaults to a `setTimeout` promise.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `worker/ado/http*.ts`: "Add the ADO HTTP client".

### Task 4: Identity and account pinning

**Files:**
- Create: `worker/auth/identity.ts`, `worker/ado/core.ts` (only `getConnectionData` in this task).
- Test: `worker/auth/identity.test.ts`, `worker/ado/core.test.ts`.

**Interfaces:**
- Produces:

```ts
// identity.ts
export interface TokenClaims { oid?: string; tid?: string; upn?: string; preferredUsername?: string; exp?: number }
export function decodeTokenClaims(token: string): TokenClaims | null      // base64url JWT payload, no verification
export function accountFromConnectionData(cd: ConnectionData, tenantId: string | null): PinnedAccount | null
export function samePinnedAccount(a: PinnedAccount, b: PinnedAccount): boolean   // by adoId
// core.ts
export interface ConnectionData { authenticatedUser: { id: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } } }
export function getConnectionData(http: AdoHttp, org: string): Promise<ConnectionData>   // GET /_apis/connectionData
```

- [ ] **Step 1: Write the failing tests.**
  - `decodeTokenClaims` reads `oid`/`tid`/`upn` from a hand-built unsigned JWT (`header.payload.sig`). It returns null for a PAT-like string.
  - `accountFromConnectionData`:
    - Maps `{ id:'u1', providerDisplayName:'Ada Lovelace', properties:{ Account:{ $value:'ada@contoso.com' } } }` to `{ adoId:'u1', uniqueName:'ada@contoso.com', displayName:'Ada Lovelace', tenantId:'t1' }`.
    - Returns **null** when `providerDisplayName` is `Anonymous` or the `Account` property is missing (an anonymous or invalid credential).
  - `getConnectionData` calls `GET https://dev.azure.com/contoso/_apis/connectionData`, using the preview fallback from Task 3.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Read and pin the signed-in ADO identity".

### Task 5: Subprocess runner, `az` lookup and the private Azure CLI profile

**Files:**
- Create: `worker/sys/run.ts`, `worker/sys/find-executable.ts`, `worker/auth/azcli.ts`.
- Test: `worker/sys/find-executable.test.ts`, `worker/auth/azcli.test.ts`.

**Interfaces:**
- Produces:

```ts
// run.ts
export interface RunResult { code: number; stdout: string; stderr: string }
export type RunCommand = (file: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }) => Promise<RunResult>
export const runCommand: RunCommand            // child_process.execFile, maxBuffer 16 MiB, never a shell
// find-executable.ts
export function findExecutable(name: string, opts: { override?: string; pathEnv?: string; extraDirs?: string[]; isExecutable?: (p: string) => boolean }): string | null
export const DEFAULT_EXTRA_DIRS: string[]      // ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
// azcli.ts
export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
export interface AzCliProvider {
  profileDir(org: string): string                                   // <home>/.orca-azure-devops/az/<org>
  login(org: string, tenantId: string | null, signal?: AbortSignal): Promise<void>
  getToken(org: string, tenantId: string | null): Promise<{ token: string; expiresAt: number }>   // epoch ms
  signOut(org: string): Promise<void>                               // deletes profileDir(org)
}
export function createAzCliProvider(deps: { azPath: string; run: RunCommand; home: string; fs: Pick<typeof import('node:fs/promises'), 'mkdir' | 'rm' | 'chmod'> }): AzCliProvider
```

- [ ] **Step 1: Write the failing tests.**
  - `findExecutable falls back to Homebrew dirs when PATH is empty` (**Review Focus 1**): with `pathEnv: ''` and `isExecutable` true only for `/opt/homebrew/bin/az` → `/opt/homebrew/bin/az`. A non-empty `override` wins whenever it is executable. Nothing found → `null`.
  - `login runs az in the private profile`: the fake `run` records exactly `['login', '--tenant', 't1', '--allow-no-subscriptions', '--output', 'none']`. Env includes `AZURE_CONFIG_DIR=<home>/.orca-azure-devops/az/contoso`, `AZURE_CORE_COLLECT_TELEMETRY=false` and `AZURE_CORE_ONLY_SHOW_ERRORS=true`. `mkdir` is called with `{ recursive: true, mode: 0o700 }`. Without a tenant, `--tenant` is omitted.
  - `getToken parses expires_on`: stdout `{"accessToken":"tok","expires_on":1793710000,"tokenType":"Bearer"}` → `{ token:'tok', expiresAt: 1793710000000 }`. Args: `['account','get-access-token','--resource', ADO_RESOURCE,'--tenant','t1','--output','json']`.
  - `getToken failure never leaks stdout`: on a non-zero exit, the error message is a fixed sentence plus at most the last stderr line, with any `eyJ…` JWT redacted.
  - `signOut deletes the profile dir`: `rm` is called with `(dir, { recursive: true, force: true })`. Use a real temp dir with `fs/promises`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the three modules.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Run az in a private per-org profile".

### Task 6: PAT provider

**Files:**
- Create: `worker/auth/pat.ts`.
- Test: `worker/auth/pat.test.ts`.

**Interfaces:**
- Produces:

```ts
export interface SecretsPort { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export function patKey(org: string): string                       // "pat:<org>"
export function basicAuth(pat: string): string                    // "Basic " + base64(":" + pat)
export function createPatProvider(secrets: SecretsPort): { save(org: string, pat: string): Promise<void>; header(org: string): Promise<string | null>; forget(org: string): Promise<void> }
```

- [ ] **Step 1: Write the failing tests.**
  - `basicAuth('abc')` → `'Basic OmFiYw=='`.
  - `save` → `header` round-trips through an in-memory `SecretsPort`.
  - `forget` deletes `pat:contoso`.
  - `save` trims whitespace and refuses an empty string.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Store PATs only in Orca secrets".

### Task 7: Connections service

**Files:**
- Create: `worker/connections.ts`.
- Modify: `worker/main.ts` (wire the ports and register the `orgs.*` handlers).
- Test: `worker/connections.test.ts`, `worker/main.test.ts` (add handler tests).

**Interfaces:**
- Consumes:
  - Task 2: `parseOrgInput`, `discoverTenant`.
  - Task 3: `createAdoHttp`, `AdoError`.
  - Task 4: `getConnectionData`, `accountFromConnectionData`, `samePinnedAccount`.
  - Task 5: `AzCliProvider`.
  - Task 6: the PAT provider.
- Produces:

```ts
export interface StorePort { get<T>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> }
export interface Connections {
  list(): Promise<OrgStatus[]>
  connect(input: { orgInput: string; method: ConnectionMethod; pat?: string }): Promise<OrgStatus>  // returns at once; az sign-in finishes in the background
  signOut(org: string): Promise<OrgStatus>
  remove(org: string): Promise<void>
  update(org: string, patch: Partial<Pick<OrgConfig, 'boards' | 'codeProjects'>>): Promise<OrgStatus>
  http: AdoHttp                                    // authHeader + onUnauthorized wired to this service
  resetInterrupted(): Promise<void>                // on activate
}
export function createConnections(deps: {
  store: StorePort; secrets: SecretsPort; az: AzCliProvider | null; fetch: typeof fetch
  post: (orgs: OrgStatus[]) => void; now: () => number
}): Connections
```

**Behaviour:**
- Storage key `orgs` holds `OrgConfig[]`. A transient state map holds `signing-in`, `error` and `expired`.
- Tokens are cached in memory per org until `expiresAt - 5 min`.
- `connect` with `azure-cli`:
  1. Parse the input, discover the tenant, then save the config with `pinned: null` and state `signing-in`.
  2. Post, then return.
  3. In the background: `login` → `getToken` → `connectionData` → `accountFromConnectionData`.
  4. Pin the account, set `connected`, and post.
- `connect` with `pat`: the same, but synchronous apart from network calls.
- An invalid input or anonymous identity sets `error` with a plain message. Messages never include tokens.
- Pin mismatch: when a later token's identity differs from `pinned` (by `adoId`), the state becomes `mismatch` with the message `Signed in as <new uniqueName>, but this org is pinned to <pinned uniqueName>.` The service stops issuing requests (`authHeader` throws `AdoError('unauthorized', …)`).
- A failed first connect deletes the profile, so nothing is pinned.

- [ ] **Step 1: Write the failing tests** (fakes for every port, with a fake ADO `fetch` that answers `connectionData` per token).
  - `connect via PAT pins the identity`: the state becomes `connected`, `account.uniqueName === 'ada@contoso.com'` and `tokenStore.kind === 'orca-secrets'`. The stored config has `pinned.adoId === 'u1'`.
  - `connect via azure-cli returns signing-in then posts connected`: the first result has `state === 'signing-in'` and `tokenStore.kind === 'az-profile'`. After the fake login resolves, the last post has `connected`.
  - `connect refuses when the az account differs from the pinned account` (**Review Focus 2**): an existing pin `u1` and a login that yields `u2` → state `mismatch`. The message names both accounts, the pin is unchanged, `signOut` is called on the new profile, and no further ADO request is sent.
  - `401 triggers one refresh then marks the org expired` (**Review Focus 3**): the fake `fetch` returns 401 twice → `getToken` is called once more, and the state becomes `expired` with the message `Your sign-in expired. Reconnect to continue.`
  - `activate resets orgs left signing-in` (**Review Focus 5**): a persisted transient `signing-in` → after `resetInterrupted()` the state is `disconnected` with the message `Sign-in was interrupted. Try again.`
  - `signOut forgets credentials but keeps settings`: the profile or PAT is removed, `pinned` becomes null, and `boards` and `codeProjects` are kept.
  - `no secrets in posts or logs`: across all tests, `JSON.stringify(posts)` never contains the fake PAT or token.
  - `statusBarFor` (in `worker/status-bar.ts`, signature `statusBarFor(orgs: OrgStatus[]): { text: string; tone: 'neutral' | 'success' | 'warning' | 'danger'; tooltip: string }`):
    - `[]` → `{ text: 'ADO', tone: 'neutral', tooltip: 'Azure DevOps: not connected' }`.
    - All connected → tone `success`, tooltip `Azure DevOps: contoso (ada@contoso.com)`.
    - Any `expired` → `warning`; any `mismatch` or `error` → `danger`, with the tooltip naming the org and its message.
  - `statusText(orgs)` returns one line per org (`contoso — connected as ada@contoso.com`), or `Not connected. Open the Azure DevOps panel to connect.`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `createConnections`, `statusBarFor` and `statusText`.**
- [ ] **Step 4: Wire it in `worker/main.ts`.**
  - Ports:
    - `orca.storage` / `orca.secrets`.
    - `fetch: globalThis.fetch`.
    - `az`: `findExecutable('az', { override: await orca.settings.get('azPath'), pathEnv: process.env.PATH })`, or null.
    - `post: (orgs) => { orca.panels.post('orgs.changed', { orgs }); void orca.host.call('statusBar.update', { id: 'status', ...statusBarFor(orgs) }) }`.
  - Register the `status` command with `orca.commands.register('status', async () => statusText(await connections.list()))`.
  - Push the initial status bar state during activate.
  - Call `resetInterrupted()` during activate.
  - Register `orgs.list`, `orgs.connect`, `orgs.signOut` and `orgs.remove`.
  - When `az` is null and the method is `azure-cli`, `connect` returns `error` with "Azure CLI not found. Install it, or set its path in Settings → Azure DevOps."
- [ ] **Step 5: Run.** `orca plugin test . --json`. Expected: PASS. Then `npx tsc -p .`, expected exit 0.
- [ ] **Step 6: Commit** "Connect orgs with pinned accounts".

### Task 8: Projects, teams and org settings

**Files:**
- Modify: `worker/ado/core.ts`, `worker/main.ts`.
- Test: `worker/ado/core.test.ts`, `worker/main.test.ts`.

**Interfaces:**
- Produces:

```ts
export function listProjects(http: AdoHttp, org: string): Promise<{ id: string; name: string }[]>   // GET /_apis/projects?$top=500, follows x-ms-continuationtoken
export function listTeams(http: AdoHttp, org: string, projectId: string): Promise<{ id: string; name: string }[]>  // GET /_apis/projects/{id}/teams?$top=500
```

  Handlers: `ado.projects`, `ado.teams`, `orgs.setBoards` (resolves names from the lists and saves a `BoardsTarget`) and `orgs.setCodeProjects` (`'all'` or ids → `{id,name}[]`).

- [ ] **Step 1: Write the failing tests.**
  - `listProjects` follows the continuation token across two pages and sorts by name, case-insensitively.
  - `orgs.setBoards` stores `{ projectId, projectName, teamId, teamName }` and posts `orgs.changed`.
  - `orgs.setCodeProjects` with an unknown id → `AdoError`-derived handler error with code `bad_request`; nothing is saved.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** "Let each org pick its boards project, team and code projects".

### Task 9: Sidebar hub — setup, status and org settings

**Files:**
- Create: `src/panel/state.ts`, `src/panel/setup.tsx`, `src/panel/org-settings.tsx`, `src/panel/panel.check.ts`.
- Modify: `src/panel/panel.tsx`.
- Test: `src/panel/panel.test.tsx`.

**Interfaces:**
- Consumes: the protocol requests and the `orgs.changed` post.
- Produces (for later plans):
  - `export const activeOrg: Atom<string | null>`, persisted as `persist: 'plugin'`.
  - `export const orgs: Atom<OrgStatus[]>`.
  - `export const tab: Atom<'work' | 'pipelines' | 'prs' | 'wiki'>`, persisted as `persist: 'workspace'`.
  - In `panel.tsx`: `export function TabBody(props: { tab: string }): OrcaNode`, which later plans replace per tab.

**UI (exact copy):**
- **No orgs** → `Setup` view:
  - `Input` label "Organization", placeholder "https://dev.azure.com/your-org".
  - `RadioGroup` label "Sign in with": "Azure CLI (no setup)" (`azure-cli`, default) or "Personal access token" (`pat`).
  - A password `Input` "Personal access token", shown only for `pat`.
  - `Button` "Connect".
- **`signing-in`**:
  - `Spinner` "Finish signing in in your browser…".
  - A `Callout` (neutral): "Pick the account you use for Azure DevOps. Tokens stay in a private Azure CLI folder: <path>. Sign out deletes it."
- **Connected** → a header `Row` showing:
  - The org `Select` (when there are more than one).
  - `Text` "signed in as <uniqueName>".
  - A `Badge` with the state tone: connected success, expired warning, mismatch and error danger.
  - `IconButton` settings.
  - Then `Tabs` label "Azure DevOps" with tabs Work, Pipelines, PRs and Wiki, each rendering `TabBody`. In this plan `TabBody` shows `EmptyState` "Coming in a later update".
- **`mismatch` / `expired` / `error`** → a danger or warning `Callout` with the `message`, plus a `Button` "Sign out" (mismatch) or "Reconnect" (expired).
- **Org settings view:**
  - `Select` "Boards project", then `Select` "Team" (loaded via `ado.teams`).
  - `Switch` "All projects with code", with a `Checkbox` per project when it is off.
  - `Button` "Sign out" (danger) and `Button` "Remove organization".

- [ ] **Step 1: Write the failing tests** (`mount(panel, { host: mockHost({ capabilities: [...], requests: {...} }) })`).
  - `shows setup when there are no orgs`: `summary()` includes "Organization", and `find({ text: 'Connect' })` is not null.
  - `connect sends the typed org and method`:
    1. Type "https://dev.azure.com/contoso".
    2. Select `pat` and type "secret".
    3. Press "Connect".
    4. The mock receives `orgs.connect` with `{ orgInput:'https://dev.azure.com/contoso', method:'pat', pat:'secret' }`.
    5. The rendered tree never contains "secret".
  - `signing-in shows the browser hint and token location`, from a posted `orgs.changed`.
  - `mismatch shows a danger callout with both accounts`.
  - `settings saves boards project and team` → `orgs.setBoards` is called with the selected ids.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the views.**
- [ ] **Step 4: Write `panel.check.ts` scenarios** `empty`, `signing-in`, `connected`, `mismatch` with `defineCheck`.
- [ ] **Step 5: Verify.**
  - `orca plugin test . --json` → PASS.
  - `orca plugin check . --json` → exit 0.
  - `npx tsc -p .` → exit 0.
- [ ] **Step 6: Commit** "Add the sidebar hub with setup and org settings".

### Task 10: Verification with mocks, then a live load with the user

The user's ADO test project doesn't exist yet. Everything here runs against mocks, except Step 4, which needs the user present.

- [ ] **Step 1: Run the full offline suite.**
  - `orca plugin validate . --json` → exit 0.
  - `npx tsc -p .` → exit 0.
  - `orca plugin test . --json` → `ok: true`.
  - `orca plugin check . --json` → exit 0.
- [ ] **Step 2: Check the scenario shots.** For each `panel.check.ts` scenario (`empty`, `signing-in`, `connected`, `mismatch`), save a PNG in both themes at width 360 with `orca plugin shot . --scenario <name> --theme <t> --width 360 --json`. This needs Orca's window hidden or minimised; if it isn't, record that and skip. Read the PNGs and fix layout issues as failing tests first.
- [ ] **Step 3: Write the README "Development" section.** Cover the test, check and dev-watch commands, and how to connect an org.
- [ ] **Step 4: Live load (user present).**
  1. Run `orca plugin dev load . --json`. On exit 3, show the user `error.data` and the `--approve` command, and wait.
  2. Once approved, confirm the status bar shows "ADO".
  3. Connect the **client org via Azure CLI, read-only**, and confirm:
     - (a) The browser shows Microsoft's account picker.
     - (b) `ls -ld ~/.orca-azure-devops/az/<org>` shows `drwx------`.
     - (c) The terminal's own `az account show` is unchanged.
     - (d) The panel shows "signed in as …".
     - (e) The boards project and team pickers list real projects.

  If (a) fails, stop and decide with the user.
- [ ] **Step 5: Commit any fixes and report.** Report the spikes settled (`az` on PATH, account picker, tenant header) and anything that changes Plan 2.
