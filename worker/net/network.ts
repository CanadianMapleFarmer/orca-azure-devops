import { X509Certificate } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { NETWORK, SETTINGS_READ_FAILED } from '../messages'

export interface NetworkSettings {
  httpsProxy: string
  caFile: string
  systemCa: boolean
}

export interface NetworkPorts {
  getCACertificates?: (type: 'default' | 'system') => string[]
  setDefaultCACertificates?: (certs: string[]) => void
  setProxy?: (env: Record<string, string>) => () => void
  readFile: (path: string, maxBytes: number) => Promise<string>
}

export interface Network {
  apply(settings: NetworkSettings): Promise<void>
  notes(): string[]
  childEnv(): Record<string, string>
}

export const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'
export const MAX_CA_FILE_BYTES = 1024 * 1024

const NETWORK_KEYS = new Set(['httpsProxy', 'caCertificatesFile', 'useSystemCertificates'])
const BEGIN_CERTIFICATE = '-----BEGIN CERTIFICATE-----'
const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

export function readNetworkSettings(values: Record<string, unknown>): NetworkSettings {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  return { httpsProxy: text(values.httpsProxy), caFile: text(values.caCertificatesFile), systemCa: values.useSystemCertificates === true }
}

export function parseProxy(text: string): { url: string } | { problem: string } {
  const url = URL.parse(text)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return { problem: NETWORK.proxyInvalid }
  if (url.username || url.password) return { problem: NETWORK.proxyPassword }
  if (url.pathname !== '/' || url.search || url.hash) return { problem: NETWORK.proxyInvalid }
  return { url: url.origin }
}

export function parsePem(text: string): { certs: string[] } | { problem: string } {
  if (Buffer.byteLength(text) > MAX_CA_FILE_BYTES) return { problem: NETWORK.caInvalid }
  const certs = text.match(CERTIFICATE_BLOCK) ?? []
  const begun = text.split(BEGIN_CERTIFICATE).length - 1
  if (certs.length === 0 || certs.length !== begun || !certs.every(isCertificate)) return { problem: NETWORK.caInvalid }
  return { certs }
}

function proxyEnv(url: string): Record<string, string> {
  return { HTTPS_PROXY: url, NO_PROXY: LOOPBACK_NO_PROXY }
}

function isCertificate(block: string): boolean {
  try {
    return new X509Certificate(block).raw.length > 0
  } catch {
    return false
  }
}

export function createNetwork(ports: NetworkPorts, log: (message: string) => void): Network {
  let proxyUrl: string | null = null
  let restoreProxy: (() => void) | null = null
  let restoreCas: (() => void) | null = null
  let defaults: string[] | null = null
  let notes: string[] = []
  let queue: Promise<void> = Promise.resolve()

  function applyProxy(text: string, problems: string[]): void {
    restoreProxy?.()
    restoreProxy = null
    proxyUrl = null
    if (!text) return
    const parsed = parseProxy(text)
    if ('problem' in parsed) {
      problems.push(parsed.problem)
    } else if (!ports.setProxy) {
      problems.push(NETWORK.proxyUnsupported)
    } else {
      restoreProxy = ports.setProxy(proxyEnv(parsed.url))
      proxyUrl = parsed.url
    }
  }

  async function fileCerts(file: string, problems: string[]): Promise<string[]> {
    const text = await ports.readFile(file, MAX_CA_FILE_BYTES + 1).catch(() => null)
    const parsed = text === null ? { problem: NETWORK.caUnreadable } : parsePem(text)
    if ('certs' in parsed) return parsed.certs
    problems.push(parsed.problem)
    return []
  }

  async function extraCas(settings: NetworkSettings, problems: string[]): Promise<string[]> {
    if (!settings.caFile && !settings.systemCa) return []
    const get = ports.getCACertificates
    if (!get || !ports.setDefaultCACertificates) {
      problems.push(NETWORK.caUnsupported)
      return []
    }
    const fromFile = settings.caFile ? await fileCerts(settings.caFile, problems) : []
    return [...(settings.systemCa ? get('system') : []), ...fromFile]
  }

  async function applyCas(settings: NetworkSettings, problems: string[]): Promise<void> {
    const extra = await extraCas(settings, problems)
    const { getCACertificates: get, setDefaultCACertificates: set } = ports
    if (extra.length > 0 && get && set) {
      const base = (defaults ??= get('default'))
      set([...base, ...extra])
      restoreCas = () => set(base)
    } else {
      restoreCas?.()
      restoreCas = null
    }
  }

  async function applyNow(settings: NetworkSettings): Promise<void> {
    const problems: string[] = []
    applyProxy(settings.httpsProxy, problems)
    await applyCas(settings, problems)
    for (const problem of problems) log(problem)
    notes = proxyUrl ? [...problems, NETWORK.proxyInUse] : problems
  }

  return {
    apply(settings) {
      const run = queue.then(() => applyNow(settings))
      queue = run.then(
        () => {},
        () => {}
      )
      return run
    },
    notes: () => [...notes],
    childEnv: () => (proxyUrl ? proxyEnv(proxyUrl) : {})
  }
}

export async function watchNetwork(settings: OrcaWorkerApi['settings'], network: Network, log: (message: string) => void): Promise<void> {
  let queue: Promise<void> = Promise.resolve()
  const refresh = async () => {
    const values = await settings.get().catch(() => null)
    if (values === null) return log(SETTINGS_READ_FAILED)
    await network.apply(readNetworkSettings(values)).catch(() => log(NETWORK.applyFailed))
  }
  const next = () => (queue = queue.then(refresh))
  settings.onDidChange(change => {
    if (NETWORK_KEYS.has(change.key)) void next()
  })
  await next()
}
