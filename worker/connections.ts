import type { ConnectFailure, ConnectionMethod, OrgConfig, OrgState, OrgStatus, PinnedAccount } from '../src/shared/types'
import { getConnectionData } from './ado/core'
import { AdoError, createAdoHttp, type AdoHttp, type AdoRequest, type ResponseObserver } from './ado/http'
import { discoverTenant, parseOrgInput } from './ado/org'
import { NOT_SIGNED_IN, type AzCliProvider, type AzProfiles } from './auth/azcli'
import { EntraError, type EntraTokens } from './auth/entra'
import { EntraTimeout, NoEntraSession, type EntraProvider, type EntraSignedIn } from './auth/entra-provider'
import { accountFromConnectionData, decodeTokenClaims, samePinnedAccount, tokenMatchesPin } from './auth/identity'
import { basicAuth, createPatProvider, patKey, type SecretsPort } from './auth/pat'
import { NOT_CONNECTED, SIGN_IN_FINISH_FAILED } from './messages'
import { CommandTimeoutError } from './sys/run'

export interface StorePort {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

export interface Connections {
  list(): Promise<OrgStatus[]>
  connect(input: { orgInput: string; method: ConnectionMethod; pat?: string }): Promise<OrgStatus>
  cancel(org: string): Promise<OrgStatus>
  signOut(org: string): Promise<OrgStatus>
  remove(org: string): Promise<void>
  update(org: string, patch: Partial<Pick<OrgConfig, 'boards' | 'codeProjects'>>): Promise<OrgStatus>
  http: AdoHttp
  resetInterrupted(): Promise<void>
  abandon(): void
}

export interface ConnectionsDeps {
  store: StorePort
  secrets: SecretsPort
  az: () => Promise<AzCliProvider | null>
  azProfiles: AzProfiles
  entra: EntraProvider
  fetch: typeof fetch
  post: (orgs: OrgStatus[]) => void
  connectFailed: (failure: ConnectFailure) => void
  now: () => number
  log: (message: string) => void
  observe?: ResponseObserver
}

const ORGS_KEY = 'orgs'
const SIGNING_IN_KEY = 'signing-in'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000
const TOKEN_COOL_DOWN_MS = 60_000
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/
const NEEDS_SIGN_IN = /AADSTS\d+|invalid_grant|interaction_required/

const MESSAGES = {
  invalidOrg: 'Enter an organization name or URL, like https://dev.azure.com/your-org.',
  emptyPat: 'Paste a personal access token.',
  unusablePat: "That token can't be used. Paste it again.",
  azMissing: 'Azure CLI not found. Install it, or set its path in Settings → Azure DevOps.',
  anonymous: "Azure DevOps didn't accept that sign-in.",
  signInFailed: 'Sign-in failed.',
  cancelled: 'Sign-in was cancelled.',
  timedOut: 'Sign-in timed out. Try again.',
  interrupted: 'Sign-in was interrupted. Try again.',
  expired: 'Your sign-in expired. Reconnect to continue.',
  otherAccount: 'This org is signed in as a different account.',
  notConnected: NOT_CONNECTED,
  signedOut: 'Signed out.',
  wipeFailed: "Couldn't delete this org's saved sign-in. Sign out to try again.",
  removeWipeFailed: "Couldn't delete this org's saved sign-in. It will be retried the next time Orca starts the plugin.",
  noAccess: "Your account can't access this in Azure DevOps.",
  unknownOrg: 'That organization is not connected.',
  unknownMethod: 'Unknown sign-in method.',
  anotherAccount: 'another account'
}

type Transient = { state: Exclude<OrgState, 'connected'>; message?: string }
type Credential = { header: string; expiresAt: number; objectId: string | null }
type Attempt = { controller: AbortController; registered: boolean; signInUrl: string | null }

class NoCredentialError extends Error {}
class SignInNeeded extends Error {}
class TokenUnavailable extends Error {}
class SignInTimedOut extends Error {}

class OtherAccount extends Error {
  constructor(readonly account: string) {
    super(MESSAGES.otherAccount)
  }
}

export function createConnections(deps: ConnectionsDeps): Connections {
  const pat = createPatProvider(deps.secrets)
  let orgs: OrgConfig[] = []
  let signingIn = new Set<string>()
  let loading: Promise<void> | null = null
  let writes: Promise<void> = Promise.resolve()
  let posting: Promise<void> = Promise.resolve()
  let lastPosted = ''
  const transient = new Map<string, Transient>()
  const credentials = new Map<string, Credential>()
  const pendingCredentials = new Map<string, Promise<Credential>>()
  const epochs = new Map<string, number>()
  const attempts = new Map<string, Attempt>()
  const chains = new Map<string, Promise<void>>()
  const coolDowns = new Map<string, number>()

  function load(): Promise<void> {
    loading ??= (async () => {
      orgs = (await deps.store.get<OrgConfig[]>(ORGS_KEY)) ?? []
      signingIn = new Set((await deps.store.get<string[]>(SIGNING_IN_KEY)) ?? [])
      for (const org of signingIn) transient.set(org, { state: 'disconnected', message: MESSAGES.interrupted })
    })().catch(error => {
      loading = null
      throw error
    })
    return loading
  }

  function save(key: string, value: unknown): Promise<void> {
    const write = writes.then(() => deps.store.set(key, value))
    writes = write.catch(() => {})
    return write
  }

  function saveAll(): Promise<unknown> {
    return Promise.all([save(ORGS_KEY, structuredClone(orgs)), save(SIGNING_IN_KEY, [...signingIn])])
  }

  function find(org: string): OrgConfig | undefined {
    return orgs.find(cfg => cfg.org === org)
  }

  function stateOf(cfg: OrgConfig): OrgState {
    return transient.get(cfg.org)?.state ?? (cfg.pinned ? 'connected' : 'disconnected')
  }

  function statusOf(cfg: OrgConfig, hasCredential: boolean, override?: Transient): OrgStatus {
    const signedOut: Transient | undefined = cfg.pinned && !hasCredential ? { state: 'disconnected', message: MESSAGES.signedOut } : undefined
    const current = override ?? transient.get(cfg.org) ?? signedOut
    const signInUrl = current?.state === 'signing-in' ? attempts.get(cfg.org)?.signInUrl : null
    return {
      org: cfg.org,
      url: cfg.url,
      method: cfg.method,
      state: current?.state ?? (cfg.pinned ? 'connected' : 'disconnected'),
      account: cfg.pinned,
      ...(current?.message ? { message: current.message } : {}),
      ...(signInUrl ? { signInUrl } : {}),
      tokenStore: tokenStoreOf(cfg),
      boards: cfg.boards,
      codeProjects: cfg.codeProjects
    }
  }

  function tokenStoreOf(cfg: OrgConfig): OrgStatus['tokenStore'] {
    switch (cfg.method) {
      case 'pat':
        return { kind: 'orca-secrets' }
      case 'azure-cli':
        return { kind: 'az-profile', path: cfg.org ? deps.azProfiles.profileDir(cfg.org) : '' }
      case 'entra':
        return { kind: 'orca-secrets' }
      default:
        return unknownMethod(cfg.method)
    }
  }

  async function credentialPresent(cfg: OrgConfig): Promise<boolean> {
    try {
      switch (cfg.method) {
        case 'pat':
          return (await deps.secrets.get(patKey(cfg.org))) !== null
        case 'azure-cli':
          return await deps.azProfiles.hasProfile(cfg.org)
        case 'entra':
          return await deps.entra.hasSession(cfg.org)
        default:
          return unknownMethod(cfg.method)
      }
    } catch {
      return false
    }
  }

  async function statusFor(cfg: OrgConfig): Promise<OrgStatus> {
    return statusOf(cfg, cfg.pinned ? await credentialPresent(cfg) : false)
  }

  function currentStatuses(): Promise<OrgStatus[]> {
    return Promise.all(orgs.map(statusFor))
  }

  function publish(): Promise<void> {
    const next = posting.then(async () => {
      const statuses = await currentStatuses()
      const text = JSON.stringify(statuses)
      if (text === lastPosted) return
      lastPosted = text
      deps.post(statuses)
    })
    posting = next.catch(() => {})
    return next
  }

  function setTransient(org: string, next: Transient | null): boolean {
    const current = transient.get(org)
    if (current?.state === next?.state && current?.message === next?.message) return false
    if (next) transient.set(org, next)
    else transient.delete(org)
    return true
  }

  function serial<T>(org: string, task: () => Promise<T>): Promise<T> {
    const run = (chains.get(org) ?? Promise.resolve()).then(task)
    const settled = run.then(() => {}, () => {})
    chains.set(org, settled)
    void settled.then(() => {
      if (chains.get(org) === settled) chains.delete(org)
    })
    return run
  }

  function epochOf(org: string): number {
    return epochs.get(org) ?? 0
  }

  function invalidate(org: string): void {
    epochs.set(org, epochOf(org) + 1)
    credentials.delete(org)
    pendingCredentials.delete(org)
    coolDowns.delete(org)
  }

  function coolingDown(org: string): boolean {
    return (coolDowns.get(org) ?? -Infinity) > deps.now()
  }

  function startAttempt(org: string, registered: boolean): Attempt {
    cancelAttempt(org)
    const attempt = { controller: new AbortController(), registered, signInUrl: null }
    attempts.set(org, attempt)
    return attempt
  }

  function cancelAttempt(org: string): boolean {
    const attempt = attempts.get(org)
    if (!attempt) return false
    attempts.delete(org)
    attempt.controller.abort()
    return true
  }

  function isCurrent(org: string, attempt: Attempt): boolean {
    return attempts.get(org) === attempt
  }

  function forgetCredentials(org: string, method: ConnectionMethod): Promise<void> {
    return serial(org, () => {
      switch (method) {
        case 'pat':
          return pat.forget(org)
        case 'azure-cli':
          return deps.azProfiles.signOut(org)
        case 'entra':
          return deps.entra.forget(org)
        default:
          return unknownMethod(method)
      }
    })
  }

  async function wipeCredentials(org: string, methods: ConnectionMethod[]): Promise<boolean> {
    signingIn.add(org)
    const wiping = Promise.all(methods.map(method => forgetCredentials(org, method)))
    const saving = saveAll()
    const wiped = await wiping.then(() => true, () => false)
    await saving
    if (!attempts.has(org)) {
      if (wiped) signingIn.delete(org)
      else if (find(org)) setTransient(org, { state: 'error', message: MESSAGES.wipeFailed })
    }
    await saveAll()
    await publish()
    return wiped
  }

  function acquire(cfg: OrgConfig): Promise<Credential> {
    switch (cfg.method) {
      case 'pat':
        return acquirePat(cfg)
      case 'azure-cli':
        return acquireAz(cfg)
      case 'entra':
        return acquireEntra(cfg)
      default:
        return unknownMethod(cfg.method)
    }
  }

  async function acquirePat(cfg: OrgConfig): Promise<Credential> {
    let header: string | null
    try {
      header = await pat.header(cfg.org)
    } catch {
      throw new Error(MESSAGES.unusablePat)
    }
    if (!header) throw new NoCredentialError()
    return { header, expiresAt: Infinity, objectId: null }
  }

  async function acquireAz(cfg: OrgConfig): Promise<Credential> {
    if (!(await deps.azProfiles.hasProfile(cfg.org))) throw new NoCredentialError()
    const az = await deps.az()
    if (!az) throw new Error(MESSAGES.azMissing)
    let issued: { token: string; expiresAt: number }
    try {
      issued = await serial(cfg.org, () => az.getToken(cfg.org, cfg.tenantId))
    } catch (error) {
      throw needsSignIn(error) ? new SignInNeeded() : new TokenUnavailable(messageOf(error))
    }
    return azCredential(cfg, issued)
  }

  async function acquireEntra(cfg: OrgConfig): Promise<Credential> {
    let tokens: EntraTokens
    try {
      tokens = await serial(cfg.org, () => deps.entra.getToken(cfg.org))
    } catch (error) {
      if (error instanceof NoEntraSession) throw new NoCredentialError()
      throw refusesRenewal(error) ? new SignInNeeded() : new TokenUnavailable(messageOf(error))
    }
    return entraCredential(cfg, tokens)
  }

  function azCredential(cfg: OrgConfig, issued: { token: string; expiresAt: number }): Credential {
    return bearerCredential(cfg, issued.token, issued.expiresAt, null)
  }

  function entraCredential(cfg: OrgConfig, tokens: EntraTokens): Credential {
    const pinnedObjectId = cfg.pinned?.objectId
    if (pinnedObjectId && tokens.objectId !== null && tokens.objectId !== pinnedObjectId) {
      throw new OtherAccount(tokens.username ?? MESSAGES.anotherAccount)
    }
    return bearerCredential(cfg, tokens.accessToken, tokens.expiresAt, tokens.objectId)
  }

  function bearerCredential(cfg: OrgConfig, token: string, expiresAt: number, objectId: string | null): Credential {
    const claims = decodeTokenClaims(token)
    if (cfg.pinned && !tokenMatchesPin(cfg.pinned, cfg.tenantId, claims)) {
      throw new OtherAccount(claims?.upn ?? claims?.preferredUsername ?? MESSAGES.anotherAccount)
    }
    return { header: `Bearer ${token}`, expiresAt, objectId: objectId ?? claims?.oid ?? null }
  }

  function credentialFor(cfg: OrgConfig): Promise<Credential> {
    const { org } = cfg
    const cached = credentials.get(org)
    if (cached && deps.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(cached)
    const inflight = pendingCredentials.get(org)
    if (inflight) return inflight
    const epoch = epochOf(org)
    const pending = acquire(cfg).then(fresh => {
      if (epochOf(org) === epoch) credentials.set(org, fresh)
      return fresh
    })
    pendingCredentials.set(org, pending)
    const settle = () => {
      if (pendingCredentials.get(org) === pending) pendingCredentials.delete(org)
    }
    pending.then(settle, settle)
    return pending
  }

  function blockedMessage(cfg: OrgConfig | undefined): string | null {
    if (!cfg?.pinned) return MESSAGES.notConnected
    switch (stateOf(cfg)) {
      case 'connected':
        return null
      case 'error':
        return signingIn.has(cfg.org) || coolingDown(cfg.org) ? (transient.get(cfg.org)?.message ?? MESSAGES.notConnected) : null
      case 'mismatch':
        return MESSAGES.otherAccount
      case 'expired':
        return MESSAGES.expired
      default:
        return MESSAGES.notConnected
    }
  }

  async function authHeader(org: string): Promise<string> {
    await load()
    const cfg = find(org)
    const blocked = blockedMessage(cfg)
    if (blocked !== null || !cfg) throw unauthorized(blocked ?? MESSAGES.notConnected)
    const epoch = epochOf(org)
    let credential: Credential
    try {
      credential = await credentialFor(cfg)
    } catch (error) {
      if (epochOf(org) !== epoch) throw unauthorized(blockedMessage(find(org)) ?? MESSAGES.notConnected)
      if (error instanceof NoCredentialError) {
        if (stateOf(cfg) === 'error') setTransient(org, null)
        await publish()
        throw unauthorized(MESSAGES.notConnected)
      }
      if (error instanceof SignInNeeded) {
        await expire(org)
        throw unauthorized(blockedMessage(find(org)) ?? MESSAGES.notConnected)
      }
      if (error instanceof OtherAccount && cfg.pinned) throw await refuseAccount(cfg, cfg.pinned, error.account)
      const message = messageOf(error)
      if (error instanceof TokenUnavailable) coolDowns.set(org, deps.now() + TOKEN_COOL_DOWN_MS)
      if (setTransient(org, { state: 'error', message })) await publish()
      throw unauthorized(message)
    }
    if (epochOf(org) !== epoch) throw unauthorized(blockedMessage(find(org)) ?? MESSAGES.notConnected)
    coolDowns.delete(org)
    if (stateOf(cfg) === 'error' && setTransient(org, null)) await publish()
    return credential.header
  }

  async function refresh(org: string): Promise<boolean> {
    const cfg = find(org)
    if (!cfg || blockedMessage(cfg) !== null) return false
    const epoch = epochOf(org)
    credentials.delete(org)
    try {
      await credentialFor(cfg)
      return epochOf(org) === epoch
    } catch (error) {
      if (epochOf(org) !== epoch) return false
      if (error instanceof NoCredentialError) await publish()
      else if (error instanceof OtherAccount && cfg.pinned) await refuseAccount(cfg, cfg.pinned, error.account)
      else await expire(org)
      return false
    }
  }

  async function expire(org: string): Promise<boolean> {
    const cfg = find(org)
    if (!cfg) return false
    const state = stateOf(cfg)
    if (state === 'expired') return true
    if (!cfg.pinned || (state !== 'connected' && state !== 'error')) return false
    invalidate(org)
    setTransient(org, { state: 'expired', message: MESSAGES.expired })
    await publish()
    return true
  }

  async function diagnose(org: string, rejection: AdoError): Promise<AdoError> {
    const cfg = find(org)
    const credential = credentials.get(org)
    if (!cfg?.pinned || !credential || blockedMessage(cfg) !== null) return rejection
    const pinned = cfg.pinned
    const epoch = epochOf(org)
    let account: PinnedAccount | null
    try {
      account = await identify(org, credential.header, cfg.tenantId)
    } catch (error) {
      if (!(error instanceof AdoError && error.code === 'unauthorized')) return rejection
      account = null
    }
    if (epochOf(org) !== epoch) return rejection
    if (!account) return (await expire(org)) ? unauthorized(MESSAGES.expired) : rejection
    if (!samePinnedAccount(pinned, account)) return refuseAccount(cfg, pinned, account.uniqueName)
    if (!pinned.objectId && credential.objectId) {
      cfg.pinned = { ...pinned, objectId: credential.objectId }
      await saveAll()
      await publish()
    }
    return new AdoError('forbidden', 403, MESSAGES.noAccess)
  }

  async function refuseAccount(cfg: OrgConfig, pinned: PinnedAccount, account: string): Promise<AdoError> {
    invalidate(cfg.org)
    setTransient(cfg.org, mismatchOf(account, pinned))
    await wipeCredentials(cfg.org, [cfg.method])
    return unauthorized(MESSAGES.otherAccount)
  }

  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      let rejected = false
      let refreshed = false
      const client = createAdoHttp({
        fetch: deps.fetch,
        authHeader,
        observe: deps.observe,
        onUnauthorized: async org => {
          rejected = true
          refreshed = await refresh(org)
          return refreshed
        }
      })
      try {
        return await client.json<T>(req)
      } catch (error) {
        if (!rejected || !(error instanceof AdoError) || error.code !== 'unauthorized') throw error
        if (refreshed) throw await diagnose(req.org, error)
        const cfg = find(req.org)
        const blocked = cfg && stateOf(cfg) !== 'connected' ? blockedMessage(cfg) : null
        throw blocked ? unauthorized(blocked) : error
      }
    }
  }

  async function identify(org: string, header: string, tenantId: string | null): Promise<PinnedAccount | null> {
    const client = createAdoHttp({ fetch: deps.fetch, authHeader: async () => header, observe: deps.observe })
    return accountFromConnectionData(await getConnectionData(client, org), tenantId)
  }

  async function verifiedAccount(org: string, header: string, tenantId: string | null): Promise<PinnedAccount> {
    const account = await identify(org, header, tenantId)
    if (!account) throw new Error(MESSAGES.anonymous)
    return account
  }

  function discardSignIn(cfg: OrgConfig): Promise<void> {
    switch (cfg.method) {
      case 'pat':
        return Promise.resolve()
      case 'azure-cli':
        return serial(cfg.org, () => deps.azProfiles.signOut(cfg.org))
      case 'entra':
        return serial(cfg.org, () => deps.entra.forget(cfg.org))
      default:
        return unknownMethod(cfg.method)
    }
  }

  async function conclude(org: string, attempt: Attempt, next: Transient | null, clearMarker = true): Promise<void> {
    if (!isCurrent(org, attempt)) return
    attempts.delete(org)
    setTransient(org, next)
    if (clearMarker) signingIn.delete(org)
    await saveAll()
    await publish()
  }

  async function unregister(cfg: OrgConfig, attempt: Attempt, message: string): Promise<boolean> {
    const { org } = cfg
    if (!isCurrent(org, attempt)) return false
    attempts.delete(org)
    orgs = orgs.filter(item => item !== cfg)
    transient.delete(org)
    signingIn.delete(org)
    await saveAll()
    await publish()
    deps.connectFailed({ org, url: cfg.url, method: cfg.method, message })
    return true
  }

  async function signIn(
    cfg: OrgConfig,
    attempt: Attempt,
    obtain: (signal: AbortSignal) => Promise<Credential>,
    keep: () => Promise<void> = async () => {}
  ): Promise<Transient | null> {
    const { org } = cfg
    const { signal } = attempt.controller
    let outcome: Transient
    try {
      const credential = await obtain(signal)
      const account = await verifiedAccount(org, credential.header, cfg.tenantId)
      if (!isCurrent(org, attempt)) return null
      if (cfg.pinned && !samePinnedAccount(cfg.pinned, account)) {
        outcome = mismatchOf(account.uniqueName, cfg.pinned)
      } else {
        await serial(org, () => {
          signal.throwIfAborted()
          return keep()
        })
        if (!isCurrent(org, attempt)) return null
        cfg.pinned = { ...account, objectId: credential.objectId ?? cfg.pinned?.objectId ?? null }
        credentials.set(org, credential)
        await conclude(org, attempt, null).catch(finishFailed)
        return null
      }
    } catch (error) {
      if (!isCurrent(org, attempt)) return null
      outcome = failedSignIn(error, cfg.pinned)
    }
    transient.set(org, outcome)
    const wiped = await discardSignIn(cfg).then(() => true, () => false)
    if (wiped && attempt.registered && outcome.state === 'error') {
      return (await unregister(cfg, attempt, outcome.message ?? MESSAGES.signInFailed)) ? outcome : null
    }
    await conclude(org, attempt, wiped ? outcome : { state: 'error', message: MESSAGES.wipeFailed }, wiped)
    return null
  }

  function finishFailed(): void {
    deps.log(SIGN_IN_FINISH_FAILED)
  }

  function draftError(parsed: { org: string; url: string } | null, method: ConnectionMethod, message: string): OrgStatus {
    const existing = parsed ? find(parsed.org) : undefined
    const cfg: OrgConfig = existing ?? { org: parsed?.org ?? '', url: parsed?.url ?? '', tenantId: null, method, pinned: null, boards: null, codeProjects: 'all' }
    return statusOf({ ...cfg, method }, true, { state: 'error', message })
  }

  async function begin(
    parsed: { org: string; url: string },
    method: ConnectionMethod,
    tenantId: string | null
  ): Promise<{ cfg: OrgConfig; attempt: Attempt | null }> {
    const existing = find(parsed.org)
    if (existing && existing.method !== method) {
      cancelAttempt(existing.org)
      if (!(await wipeCredentials(existing.org, [existing.method]))) return { cfg: existing, attempt: null }
    }
    let cfg = find(parsed.org)
    const registered = !cfg
    if (cfg) {
      cfg.url = parsed.url
      cfg.tenantId = tenantId ?? cfg.tenantId
      cfg.method = method
    } else {
      cfg = { ...parsed, tenantId, method, pinned: null, boards: null, codeProjects: 'all' }
      orgs.push(cfg)
    }
    const attempt = startAttempt(cfg.org, registered)
    invalidate(cfg.org)
    transient.set(cfg.org, { state: 'signing-in' })
    signingIn.add(cfg.org)
    await saveAll()
    await publish()
    return { cfg, attempt }
  }

  async function connectPat(parsed: { org: string; url: string }, input: string | undefined): Promise<OrgStatus> {
    const token = (input ?? '').trim()
    if (!token) return draftError(parsed, 'pat', MESSAGES.emptyPat)
    if (!PRINTABLE_ASCII.test(token)) return draftError(parsed, 'pat', MESSAGES.unusablePat)
    const tenantId = await discoverTenant(parsed.org, deps.fetch)
    const { cfg, attempt } = await begin(parsed, 'pat', tenantId)
    if (!attempt) return statusFor(cfg)
    const header = basicAuth(token)
    const dropped = await signIn(cfg, attempt, async () => ({ header, expiresAt: Infinity, objectId: null }), () => pat.save(cfg.org, token))
    return dropped ? statusOf(cfg, true, dropped) : statusFor(cfg)
  }

  async function connectAz(parsed: { org: string; url: string }): Promise<OrgStatus> {
    const az = await deps.az()
    if (!az) return draftError(parsed, 'azure-cli', MESSAGES.azMissing)
    const tenantId = await discoverTenant(parsed.org, deps.fetch)
    const { cfg, attempt } = await begin(parsed, 'azure-cli', tenantId)
    if (!attempt) return statusFor(cfg)
    const { org } = cfg
    void signIn(cfg, attempt, async signal => {
      await serial(org, async () => {
        signal.throwIfAborted()
        await deps.azProfiles.signOut(org).catch(() => {
          throw new Error(MESSAGES.wipeFailed)
        })
        return az.login(org, cfg.tenantId, signal).catch((error: unknown) => {
          throw error instanceof CommandTimeoutError ? new SignInTimedOut() : error
        })
      })
      const issued = await serial(org, () => {
        signal.throwIfAborted()
        return az.getToken(org, cfg.tenantId)
      })
      return azCredential(cfg, issued)
    }).catch(finishFailed)
    return statusFor(cfg)
  }

  async function connectEntra(parsed: { org: string; url: string }): Promise<OrgStatus> {
    const problem = deps.entra.configProblem()
    if (problem) return draftError(parsed, 'entra', problem)
    const tenantId = await discoverTenant(parsed.org, deps.fetch)
    const { cfg, attempt } = await begin(parsed, 'entra', tenantId)
    if (!attempt) return statusFor(cfg)
    const { org } = cfg
    let signedIn!: EntraSignedIn
    void signIn(
      cfg,
      attempt,
      async signal => {
        const session = await deps.entra.begin(org, cfg.tenantId, { loginHint: cfg.pinned?.uniqueName ?? null, signal })
        if (isCurrent(org, attempt)) {
          attempt.signInUrl = session.url
          await publish()
        }
        try {
          signedIn = await session.tokens.catch((error: unknown) => {
            throw error instanceof EntraTimeout ? new SignInTimedOut() : error
          })
        } finally {
          attempt.signInUrl = null
          if (isCurrent(org, attempt)) await publish()
        }
        return entraCredential(cfg, signedIn)
      },
      () => deps.entra.save(org, signedIn)
    ).catch(finishFailed)
    return statusFor(cfg)
  }

  return {
    async list() {
      await load()
      return currentStatuses()
    },

    async connect(input) {
      await load()
      const { method } = input
      const parsed = parseOrgInput(input.orgInput)
      if (!parsed) return draftError(null, method, MESSAGES.invalidOrg)
      switch (method) {
        case 'pat':
          return connectPat(parsed, input.pat)
        case 'azure-cli':
          return connectAz(parsed)
        case 'entra':
          return connectEntra(parsed)
        default:
          return unknownMethod(method)
      }
    },

    async cancel(org) {
      await load()
      const cfg = find(org)
      if (!cfg) throw new Error(MESSAGES.unknownOrg)
      if (!cancelAttempt(org)) return statusFor(cfg)
      invalidate(org)
      setTransient(org, { state: 'disconnected', message: MESSAGES.cancelled })
      await wipeCredentials(org, [cfg.method])
      return statusFor(cfg)
    },

    async signOut(org) {
      await load()
      const cfg = find(org)
      if (!cfg) throw new Error(MESSAGES.unknownOrg)
      const cancelled = cancelAttempt(org)
      invalidate(org)
      cfg.pinned = null
      setTransient(org, cancelled ? { state: 'disconnected', message: MESSAGES.cancelled } : null)
      await wipeCredentials(org, [cfg.method])
      return statusFor(cfg)
    },

    async remove(org) {
      await load()
      const cfg = find(org)
      if (!cfg) return
      cancelAttempt(org)
      invalidate(org)
      orgs = orgs.filter(item => item !== cfg)
      transient.delete(org)
      if (!(await wipeCredentials(org, [cfg.method]))) throw new Error(MESSAGES.removeWipeFailed)
    },

    async update(org, patch) {
      await load()
      const cfg = find(org)
      if (!cfg) throw new Error(MESSAGES.unknownOrg)
      if (patch.boards !== undefined) cfg.boards = patch.boards
      if (patch.codeProjects !== undefined) cfg.codeProjects = patch.codeProjects
      await saveAll()
      await publish()
      return statusFor(cfg)
    },

    http,

    async resetInterrupted() {
      await load()
      for (const org of [...signingIn].filter(org => !attempts.has(org))) {
        const cfg = find(org)
        const wiped = await wipeCredentials(org, cfg ? [cfg.method] : ['azure-cli', 'pat', 'entra'])
        if (wiped && cfg && !attempts.has(org)) {
          setTransient(org, { state: 'disconnected', message: MESSAGES.interrupted })
          await publish()
        }
      }
    },

    abandon() {
      attempts.clear()
    }
  }
}

function unauthorized(message: string): AdoError {
  return new AdoError('unauthorized', 401, message)
}

function unknownMethod(method: never): never {
  throw new Error(MESSAGES.unknownMethod)
}

function mismatchOf(account: string, pinned: PinnedAccount): Transient {
  return { state: 'mismatch', message: `Signed in as ${account}, but this org is pinned to ${pinned.uniqueName}.` }
}

function failedSignIn(error: unknown, pinned: PinnedAccount | null): Transient {
  if (error instanceof OtherAccount && pinned) return mismatchOf(error.account, pinned)
  if (error instanceof SignInTimedOut) return { state: 'disconnected', message: MESSAGES.timedOut }
  return { state: 'error', message: messageOf(error) }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : MESSAGES.signInFailed
}

function refusesRenewal(error: unknown): boolean {
  return error instanceof EntraError && error.kind !== 'unreachable' && error.kind !== 'malformed'
}

function needsSignIn(error: unknown): boolean {
  return error instanceof Error && (NEEDS_SIGN_IN.test(error.message) || error.message === NOT_SIGNED_IN)
}
