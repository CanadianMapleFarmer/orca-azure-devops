import type { ConnectionMethod, OrgConfig, OrgState, OrgStatus, PinnedAccount } from '../src/shared/types'
import { getConnectionData } from './ado/core'
import { AdoError, createAdoHttp, type AdoHttp, type AdoRequest } from './ado/http'
import { discoverTenant, parseOrgInput } from './ado/org'
import type { AzCliProvider, AzProfiles } from './auth/azcli'
import { accountFromConnectionData, samePinnedAccount } from './auth/identity'
import { basicAuth, createPatProvider, patKey, type SecretsPort } from './auth/pat'

export interface StorePort {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
}

export interface Connections {
  list(): Promise<OrgStatus[]>
  connect(input: { orgInput: string; method: ConnectionMethod; pat?: string }): Promise<OrgStatus>
  signOut(org: string): Promise<OrgStatus>
  remove(org: string): Promise<void>
  update(org: string, patch: Partial<Pick<OrgConfig, 'boards' | 'codeProjects'>>): Promise<OrgStatus>
  http: AdoHttp
  resetInterrupted(): Promise<void>
}

export interface ConnectionsDeps {
  store: StorePort
  secrets: SecretsPort
  az: () => Promise<AzCliProvider | null>
  azProfiles: AzProfiles
  fetch: typeof fetch
  post: (orgs: OrgStatus[]) => void
  now: () => number
}

const ORGS_KEY = 'orgs'
const SIGNING_IN_KEY = 'signing-in'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

const MESSAGES = {
  invalidOrg: 'Enter an organization name or URL, like https://dev.azure.com/your-org.',
  emptyPat: 'Paste a personal access token.',
  unusablePat: "That token can't be used. Paste it again.",
  azMissing: 'Azure CLI not found. Install it, or set its path in Settings → Azure DevOps.',
  anonymous: "Azure DevOps didn't accept that sign-in.",
  signInFailed: 'Sign-in failed.',
  cancelled: 'Sign-in was cancelled.',
  interrupted: 'Sign-in was interrupted. Try again.',
  expired: 'Your sign-in expired. Reconnect to continue.',
  otherAccount: 'This org is signed in as a different account.',
  notConnected: 'Connect this organization first.',
  signedOut: 'Signed out.',
  wipeFailed: "Couldn't delete this org's saved sign-in. Sign out to try again.",
  noAccess: "Your account can't access this in Azure DevOps.",
  unknownOrg: 'That organization is not connected.'
}

type Transient = { state: Exclude<OrgState, 'connected'>; message?: string }
type Credential = { header: string; expiresAt: number }
type Attempt = { controller: AbortController }

class NoCredentialError extends Error {}

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
    return {
      org: cfg.org,
      url: cfg.url,
      method: cfg.method,
      state: current?.state ?? (cfg.pinned ? 'connected' : 'disconnected'),
      account: cfg.pinned,
      ...(current?.message ? { message: current.message } : {}),
      tokenStore: cfg.method === 'pat'
        ? { kind: 'orca-secrets' }
        : { kind: 'az-profile', path: cfg.org ? deps.azProfiles.profileDir(cfg.org) : '' },
      boards: cfg.boards,
      codeProjects: cfg.codeProjects
    }
  }

  async function credentialPresent(cfg: OrgConfig): Promise<boolean> {
    try {
      if (cfg.method === 'pat') return (await deps.secrets.get(patKey(cfg.org))) !== null
      return await deps.azProfiles.hasProfile(cfg.org)
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
  }

  function startAttempt(org: string): Attempt {
    cancelAttempt(org)
    const attempt = { controller: new AbortController() }
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
    return serial(org, () => (method === 'pat' ? pat.forget(org) : deps.azProfiles.signOut(org)))
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

  async function acquire(cfg: OrgConfig): Promise<Credential> {
    if (cfg.method === 'pat') {
      let header: string | null
      try {
        header = await pat.header(cfg.org)
      } catch {
        throw new Error(MESSAGES.unusablePat)
      }
      if (!header) throw new NoCredentialError()
      return { header, expiresAt: Infinity }
    }
    if (!(await deps.azProfiles.hasProfile(cfg.org))) throw new NoCredentialError()
    const az = await deps.az()
    if (!az) throw new Error(MESSAGES.azMissing)
    const { token, expiresAt } = await serial(cfg.org, () => az.getToken(cfg.org, cfg.tenantId))
    return { header: `Bearer ${token}`, expiresAt }
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
        return signingIn.has(cfg.org) ? (transient.get(cfg.org)?.message ?? MESSAGES.notConnected) : null
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
      const message = messageOf(error)
      if (setTransient(org, { state: 'error', message })) await publish()
      throw unauthorized(message)
    }
    if (epochOf(org) !== epoch) throw unauthorized(blockedMessage(find(org)) ?? MESSAGES.notConnected)
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
    if (samePinnedAccount(pinned, account)) return new AdoError('forbidden', 403, MESSAGES.noAccess)
    invalidate(org)
    setTransient(org, mismatchOf(account, pinned))
    await wipeCredentials(org, [cfg.method])
    return unauthorized(MESSAGES.otherAccount)
  }

  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      let rejected = false
      let refreshed = false
      const client = createAdoHttp({
        fetch: deps.fetch,
        authHeader,
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
        throw cfg && stateOf(cfg) === 'expired' ? unauthorized(MESSAGES.expired) : error
      }
    }
  }

  async function identify(org: string, header: string, tenantId: string | null): Promise<PinnedAccount | null> {
    const client = createAdoHttp({ fetch: deps.fetch, authHeader: async () => header })
    return accountFromConnectionData(await getConnectionData(client, org), tenantId)
  }

  async function verifiedAccount(org: string, header: string, tenantId: string | null): Promise<PinnedAccount> {
    const account = await identify(org, header, tenantId)
    if (!account) throw new Error(MESSAGES.anonymous)
    return account
  }

  function discardSignIn(cfg: OrgConfig): Promise<void> {
    return cfg.method === 'azure-cli' ? serial(cfg.org, () => deps.azProfiles.signOut(cfg.org)) : Promise.resolve()
  }

  async function conclude(org: string, attempt: Attempt, next: Transient | null, clearMarker = true): Promise<void> {
    if (!isCurrent(org, attempt)) return
    attempts.delete(org)
    setTransient(org, next)
    if (clearMarker) signingIn.delete(org)
    await saveAll()
    await publish()
  }

  async function signIn(
    cfg: OrgConfig,
    attempt: Attempt,
    obtain: (signal: AbortSignal) => Promise<Credential>,
    keep: () => Promise<void> = async () => {}
  ): Promise<void> {
    const { org } = cfg
    const { signal } = attempt.controller
    let outcome: Transient
    try {
      const credential = await obtain(signal)
      const account = await verifiedAccount(org, credential.header, cfg.tenantId)
      if (!isCurrent(org, attempt)) return
      if (cfg.pinned && !samePinnedAccount(cfg.pinned, account)) {
        outcome = mismatchOf(account, cfg.pinned)
      } else {
        await serial(org, () => {
          signal.throwIfAborted()
          return keep()
        })
        if (!isCurrent(org, attempt)) return
        cfg.pinned = account
        credentials.set(org, credential)
        await conclude(org, attempt, null)
        return
      }
    } catch (error) {
      if (!isCurrent(org, attempt)) return
      outcome = { state: 'error', message: messageOf(error) }
    }
    transient.set(org, outcome)
    const wiped = await discardSignIn(cfg).then(() => true, () => false)
    await conclude(org, attempt, wiped ? outcome : { state: 'error', message: MESSAGES.wipeFailed }, wiped)
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
    if (cfg) {
      cfg.url = parsed.url
      cfg.tenantId = tenantId ?? cfg.tenantId
      cfg.method = method
    } else {
      cfg = { ...parsed, tenantId, method, pinned: null, boards: null, codeProjects: 'all' }
      orgs.push(cfg)
    }
    const attempt = startAttempt(cfg.org)
    invalidate(cfg.org)
    transient.set(cfg.org, { state: 'signing-in' })
    signingIn.add(cfg.org)
    await saveAll()
    await publish()
    return { cfg, attempt }
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

      if (method === 'pat') {
        const token = (input.pat ?? '').trim()
        if (!token) return draftError(parsed, method, MESSAGES.emptyPat)
        if (!PRINTABLE_ASCII.test(token)) return draftError(parsed, method, MESSAGES.unusablePat)
        const tenantId = await discoverTenant(parsed.org, deps.fetch)
        const { cfg, attempt } = await begin(parsed, method, tenantId)
        if (!attempt) return statusFor(cfg)
        const header = basicAuth(token)
        await signIn(cfg, attempt, async () => ({ header, expiresAt: Infinity }), () => pat.save(cfg.org, token))
        return statusFor(cfg)
      }

      const az = await deps.az()
      if (!az) return draftError(parsed, method, MESSAGES.azMissing)
      const tenantId = await discoverTenant(parsed.org, deps.fetch)
      const { cfg, attempt } = await begin(parsed, method, tenantId)
      if (!attempt) return statusFor(cfg)
      const { org } = cfg
      void signIn(cfg, attempt, async signal => {
        await serial(org, async () => {
          signal.throwIfAborted()
          await deps.azProfiles.signOut(org).catch(() => {
            throw new Error(MESSAGES.wipeFailed)
          })
          return az.login(org, cfg.tenantId, signal)
        })
        const { token, expiresAt } = await serial(org, () => {
          signal.throwIfAborted()
          return az.getToken(org, cfg.tenantId)
        })
        return { header: `Bearer ${token}`, expiresAt }
      }).catch(() => {})
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
      if (!(await wipeCredentials(org, [cfg.method]))) throw new Error(MESSAGES.wipeFailed)
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
        const wiped = await wipeCredentials(org, cfg ? [cfg.method] : ['azure-cli', 'pat'])
        if (wiped && cfg && !attempts.has(org)) {
          setTransient(org, { state: 'disconnected', message: MESSAGES.interrupted })
          await publish()
        }
      }
    }
  }
}

function unauthorized(message: string): AdoError {
  return new AdoError('unauthorized', 401, message)
}

function mismatchOf(account: PinnedAccount, pinned: PinnedAccount): Transient {
  return { state: 'mismatch', message: `Signed in as ${account.uniqueName}, but this org is pinned to ${pinned.uniqueName}.` }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : MESSAGES.signInFailed
}
