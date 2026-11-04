import type { ConnectionMethod, OrgConfig, OrgState, OrgStatus, PinnedAccount } from '../src/shared/types'
import { getConnectionData } from './ado/core'
import { AdoError, createAdoHttp, type AdoHttp, type AdoRequest } from './ado/http'
import { discoverTenant, parseOrgInput } from './ado/org'
import type { AzCliProvider, AzProfiles } from './auth/azcli'
import { accountFromConnectionData, samePinnedAccount } from './auth/identity'
import { basicAuth, createPatProvider, type SecretsPort } from './auth/pat'

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
  unknownOrg: 'That organization is not connected.'
}

type Transient = { state: Exclude<OrgState, 'connected'>; message?: string }
type Credential = { header: string; expiresAt: number }
type Attempt = { controller: AbortController }

export function createConnections(deps: ConnectionsDeps): Connections {
  const pat = createPatProvider(deps.secrets)
  let orgs: OrgConfig[] = []
  let signingIn = new Set<string>()
  let loading: Promise<void> | null = null
  let writes: Promise<void> = Promise.resolve()
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

  function statusOf(cfg: OrgConfig, override?: Transient): OrgStatus {
    const current = override ?? transient.get(cfg.org)
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

  function publish(): void {
    deps.post(orgs.map(cfg => statusOf(cfg)))
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

  async function acquire(cfg: OrgConfig): Promise<Credential> {
    if (cfg.method === 'pat') {
      const header = await pat.header(cfg.org).catch(() => null)
      if (!header) throw new Error(MESSAGES.unusablePat)
      return { header, expiresAt: Infinity }
    }
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
      case 'error':
        return null
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
      const message = messageOf(error)
      if (setTransient(org, { state: 'error', message })) publish()
      throw unauthorized(message)
    }
    if (epochOf(org) !== epoch) throw unauthorized(blockedMessage(find(org)) ?? MESSAGES.notConnected)
    if (stateOf(cfg) === 'error' && setTransient(org, null)) publish()
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
    } catch {
      if (epochOf(org) === epoch) expire(org)
      return false
    }
  }

  function expire(org: string): boolean {
    const cfg = find(org)
    if (!cfg) return false
    const state = stateOf(cfg)
    if (state === 'expired') return true
    if (!cfg.pinned || (state !== 'connected' && state !== 'error')) return false
    invalidate(org)
    setTransient(org, { state: 'expired', message: MESSAGES.expired })
    publish()
    return true
  }

  const http: AdoHttp = {
    async json<T>(req: AdoRequest) {
      let rejected = false
      const client = createAdoHttp({
        fetch: deps.fetch,
        authHeader,
        onUnauthorized: org => {
          rejected = true
          return refresh(org)
        }
      })
      try {
        return await client.json<T>(req)
      } catch (error) {
        if (rejected && error instanceof AdoError && error.code === 'unauthorized' && expire(req.org)) {
          throw unauthorized(MESSAGES.expired)
        }
        throw error
      }
    }
  }

  async function verifiedAccount(org: string, header: string, tenantId: string | null): Promise<PinnedAccount> {
    const client = createAdoHttp({ fetch: deps.fetch, authHeader: async () => header })
    const account = accountFromConnectionData(await getConnectionData(client, org), tenantId)
    if (!account) throw new Error(MESSAGES.anonymous)
    return account
  }

  function discardSignIn(cfg: OrgConfig): Promise<void> {
    return cfg.method === 'azure-cli' ? serial(cfg.org, () => deps.azProfiles.signOut(cfg.org)) : Promise.resolve()
  }

  async function conclude(org: string, attempt: Attempt, next: Transient | null): Promise<void> {
    if (!isCurrent(org, attempt)) return
    attempts.delete(org)
    setTransient(org, next)
    signingIn.delete(org)
    await saveAll()
    publish()
  }

  async function signIn(
    cfg: OrgConfig,
    attempt: Attempt,
    obtain: (signal: AbortSignal) => Promise<Credential>,
    keep: () => Promise<void> = async () => {}
  ): Promise<void> {
    const { org } = cfg
    const { signal } = attempt.controller
    try {
      const credential = await obtain(signal)
      const account = await verifiedAccount(org, credential.header, cfg.tenantId)
      if (!isCurrent(org, attempt)) return
      if (cfg.pinned && !samePinnedAccount(cfg.pinned, account)) {
        const mismatch: Transient = {
          state: 'mismatch',
          message: `Signed in as ${account.uniqueName}, but this org is pinned to ${cfg.pinned.uniqueName}.`
        }
        transient.set(org, mismatch)
        try {
          await discardSignIn(cfg)
        } finally {
          await conclude(org, attempt, mismatch)
        }
        return
      }
      await serial(org, () => {
        signal.throwIfAborted()
        return keep()
      })
      if (!isCurrent(org, attempt)) return
      cfg.pinned = account
      credentials.set(org, credential)
      await conclude(org, attempt, null)
    } catch (error) {
      if (!isCurrent(org, attempt)) return
      try {
        await discardSignIn(cfg)
      } finally {
        await conclude(org, attempt, { state: 'error', message: messageOf(error) })
      }
    }
  }

  function draftError(parsed: { org: string; url: string } | null, method: ConnectionMethod, message: string): OrgStatus {
    const existing = parsed ? find(parsed.org) : undefined
    const cfg: OrgConfig = existing ?? { org: parsed?.org ?? '', url: parsed?.url ?? '', tenantId: null, method, pinned: null, boards: null, codeProjects: 'all' }
    return statusOf({ ...cfg, method }, { state: 'error', message })
  }

  async function begin(parsed: { org: string; url: string }, method: ConnectionMethod, tenantId: string | null) {
    let cfg = find(parsed.org)
    const previousMethod = cfg?.method
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
    if (previousMethod && previousMethod !== method) await forgetCredentials(cfg.org, previousMethod)
    await saveAll()
    publish()
    return { cfg, attempt }
  }

  return {
    async list() {
      await load()
      return orgs.map(cfg => statusOf(cfg))
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
        const header = basicAuth(token)
        await signIn(cfg, attempt, async () => ({ header, expiresAt: Infinity }), () => pat.save(cfg.org, token))
        return statusOf(cfg)
      }

      const az = await deps.az()
      if (!az) return draftError(parsed, method, MESSAGES.azMissing)
      const tenantId = await discoverTenant(parsed.org, deps.fetch)
      const { cfg, attempt } = await begin(parsed, method, tenantId)
      const { org } = cfg
      void signIn(cfg, attempt, async signal => {
        await serial(org, () => {
          signal.throwIfAborted()
          return az.login(org, cfg.tenantId, signal)
        })
        const { token, expiresAt } = await serial(org, () => {
          signal.throwIfAborted()
          return az.getToken(org, cfg.tenantId)
        })
        return { header: `Bearer ${token}`, expiresAt }
      }).catch(() => {})
      return statusOf(cfg)
    },

    async signOut(org) {
      await load()
      const cfg = find(org)
      if (!cfg) throw new Error(MESSAGES.unknownOrg)
      const cancelled = cancelAttempt(org)
      invalidate(org)
      transient.set(org, { state: 'disconnected' })
      await forgetCredentials(org, cfg.method)
      cfg.pinned = null
      setTransient(org, cancelled ? { state: 'disconnected', message: MESSAGES.cancelled } : null)
      signingIn.delete(org)
      await saveAll()
      publish()
      return statusOf(cfg)
    },

    async remove(org) {
      await load()
      const cfg = find(org)
      if (!cfg) return
      cancelAttempt(org)
      invalidate(org)
      transient.set(org, { state: 'disconnected' })
      await forgetCredentials(org, cfg.method)
      orgs = orgs.filter(item => item !== cfg)
      transient.delete(org)
      signingIn.delete(org)
      await saveAll()
      publish()
    },

    async update(org, patch) {
      await load()
      const cfg = find(org)
      if (!cfg) throw new Error(MESSAGES.unknownOrg)
      if (patch.boards !== undefined) cfg.boards = patch.boards
      if (patch.codeProjects !== undefined) cfg.codeProjects = patch.codeProjects
      await saveAll()
      publish()
      return statusOf(cfg)
    },

    http,

    async resetInterrupted() {
      await load()
      const interrupted = [...signingIn].filter(org => !attempts.has(org))
      if (interrupted.length === 0) return
      for (const org of interrupted) {
        signingIn.delete(org)
        const cfg = find(org)
        if (!cfg) continue
        if (cfg.method === 'azure-cli') await forgetCredentials(org, cfg.method)
        if (!attempts.has(org)) setTransient(org, { state: 'disconnected', message: MESSAGES.interrupted })
      }
      await saveAll()
      publish()
    }
  }
}

function unauthorized(message: string): AdoError {
  return new AdoError('unauthorized', 401, message)
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : MESSAGES.signInFailed
}
