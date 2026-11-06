import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { NETWORK, SETTINGS_READ_FAILED } from '../messages'
import { drain } from '../test-support'
import {
  createNetwork,
  LOOPBACK_NO_PROXY,
  MAX_CA_FILE_BYTES,
  parsePem,
  parseProxy,
  readNetworkSettings,
  watchNetwork,
  type Network,
  type NetworkPorts,
  type NetworkSettings
} from './network'

const PROXY = 'http://proxy.example.com:8080'
const OTHER_PROXY = 'https://other-proxy.example.com'
const CA_FILE = '/certs/corp-ca.pem'
const DEFAULTS = ['default-ca-1', 'default-ca-2']
const SYSTEM = ['system-ca-1']
const OFF: NetworkSettings = { httpsProxy: '', caFile: '', systemCa: false }

function fixture(): Promise<string> {
  return fs.readFile(new URL('./fixtures/test-ca.pem', import.meta.url), 'utf8')
}

function proxyEnv(url: string): Record<string, string> {
  return { HTTPS_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' }
}

function fakePorts(files: Record<string, string> = {}) {
  const calls: unknown[][] = []
  let proxies = 0
  const ports: NetworkPorts = {
    getCACertificates: type => {
      calls.push(['getCACertificates', type])
      return type === 'default' ? [...DEFAULTS] : [...SYSTEM]
    },
    setDefaultCACertificates: certs => {
      calls.push(['setDefaultCACertificates', certs])
    },
    setProxy: env => {
      const id = ++proxies
      calls.push(['setProxy', env])
      return () => {
        calls.push(['restoreProxy', id])
      }
    },
    readFile: async (path, maxBytes) => {
      calls.push(['readFile', path, maxBytes])
      const text = files[path]
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
      return text.slice(0, maxBytes)
    }
  }
  return { ports, calls }
}

function mount(ports: NetworkPorts) {
  const logs: string[] = []
  return { network: createNetwork(ports, message => logs.push(message)), logs }
}

test('parseProxy accepts http and https proxies and refuses passwords, paths and other schemes', () => {
  assert.deepEqual(parseProxy('http://proxy.example.com:8080'), { url: 'http://proxy.example.com:8080' })
  assert.deepEqual(parseProxy('https://proxy.example.com'), { url: 'https://proxy.example.com' })
  assert.deepEqual(parseProxy('https://proxy.example.com/'), { url: 'https://proxy.example.com' })

  for (const withCredentials of ['http://u:p@proxy.example.com:8080', 'http://u@proxy.example.com:8080']) {
    const refused = parseProxy(withCredentials)
    assert.deepEqual(refused, { problem: NETWORK.proxyPassword })
    const text = JSON.stringify(refused)
    assert.ok(!text.includes('u:p') && !text.includes('proxy.example.com'), 'the message never quotes the setting')
  }

  for (const invalid of [
    'socks5://proxy.example.com:1080',
    'proxy.example.com:8080',
    'http://proxy.example.com/path',
    'http://proxy.example.com/?route=a',
    'http://proxy.example.com/#a',
    'ftp://proxy.example.com',
    ''
  ]) {
    assert.deepEqual(parseProxy(invalid), { problem: NETWORK.proxyInvalid }, JSON.stringify(invalid))
  }
})

test('parsePem reads certificates and refuses empty, oversized or broken files', async () => {
  const pem = await fixture()
  const block = pem.trim()
  assert.deepEqual(parsePem(pem), { certs: [block] })
  assert.deepEqual(parsePem(`# Corporate root\n${pem}\n# Corporate issuing\n${pem}`), { certs: [block, block] })

  const padded = (bytes: number) => `${'#'.repeat(bytes - pem.length - 1)}\n${pem}`
  assert.equal(Buffer.byteLength(padded(MAX_CA_FILE_BYTES)), MAX_CA_FILE_BYTES)
  assert.deepEqual(parsePem(padded(MAX_CA_FILE_BYTES)), { certs: [block] })

  const broken = block.replace(/^(-----BEGIN CERTIFICATE-----\n)MII/, '$1XYZ')
  const unended = `${pem}-----BEGIN CERTIFICATE-----\nMIIB\n`
  const key = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n'
  for (const invalid of ['', '   \n', 'not a certificate', key, broken, unended, padded(MAX_CA_FILE_BYTES + 1)]) {
    assert.deepEqual(parsePem(invalid), { problem: NETWORK.caInvalid })
  }
})

test('readNetworkSettings reads the three keys and treats anything else as off', () => {
  assert.deepEqual(readNetworkSettings({}), OFF)
  assert.deepEqual(readNetworkSettings({ httpsProxy: ` ${PROXY} `, caCertificatesFile: ` ${CA_FILE}\n`, useSystemCertificates: true, entraTenant: 'x' }), {
    httpsProxy: PROXY,
    caFile: CA_FILE,
    systemCa: true
  })
  assert.deepEqual(readNetworkSettings({ httpsProxy: 8080, caCertificatesFile: null, useSystemCertificates: 'yes' }), OFF)
})

test('apply routes fetch through the proxy and always bypasses loopback', async () => {
  const { ports, calls } = fakePorts()
  const { network, logs } = mount(ports)
  await network.apply({ ...OFF, httpsProxy: PROXY })
  assert.equal(LOOPBACK_NO_PROXY, 'localhost,127.0.0.1,::1')
  assert.deepEqual(calls, [['setProxy', { HTTPS_PROXY: 'http://proxy.example.com:8080', NO_PROXY: 'localhost,127.0.0.1,::1' }]])
  assert.deepEqual(network.notes(), [NETWORK.proxyInUse])
  assert.deepEqual(network.childEnv(), proxyEnv(PROXY))
  assert.deepEqual(logs, [])
})

test('apply restores the previous proxy before setting a new one and when cleared', async () => {
  const { ports, calls } = fakePorts()
  const { network } = mount(ports)
  await network.apply({ ...OFF, httpsProxy: PROXY })
  await network.apply({ ...OFF, httpsProxy: OTHER_PROXY })
  assert.deepEqual(network.childEnv(), proxyEnv(OTHER_PROXY))
  await network.apply(OFF)
  await network.apply(OFF)
  assert.deepEqual(calls, [['setProxy', proxyEnv(PROXY)], ['restoreProxy', 1], ['setProxy', proxyEnv(OTHER_PROXY)], ['restoreProxy', 2]])
  assert.deepEqual(network.notes(), [])
  assert.deepEqual(network.childEnv(), {})

  await network.apply({ ...OFF, httpsProxy: PROXY })
  await network.apply({ ...OFF, httpsProxy: 'ftp://proxy.example.com' })
  assert.deepEqual(calls.slice(4), [['setProxy', proxyEnv(PROXY)], ['restoreProxy', 3]])
  assert.deepEqual(network.notes(), [NETWORK.proxyInvalid])
  assert.deepEqual(network.childEnv(), {})
})

test('apply trusts default, system and file certificates and restores the defaults when cleared', async () => {
  const pem = await fixture()
  const { ports, calls } = fakePorts({ [CA_FILE]: pem })
  const { network, logs } = mount(ports)

  await network.apply({ ...OFF, caFile: CA_FILE })
  await network.apply({ ...OFF, caFile: CA_FILE, systemCa: true })
  await network.apply(OFF)
  await network.apply(OFF)

  assert.deepEqual(calls, [
    ['readFile', CA_FILE, MAX_CA_FILE_BYTES + 1],
    ['getCACertificates', 'default'],
    ['setDefaultCACertificates', [...DEFAULTS, pem.trim()]],
    ['readFile', CA_FILE, MAX_CA_FILE_BYTES + 1],
    ['getCACertificates', 'system'],
    ['setDefaultCACertificates', [...DEFAULTS, ...SYSTEM, pem.trim()]],
    ['setDefaultCACertificates', DEFAULTS]
  ])
  assert.equal(calls.filter(call => call[0] === 'getCACertificates' && call[1] === 'default').length, 1)
  assert.deepEqual(network.notes(), [])
  assert.deepEqual(network.childEnv(), {})
  assert.deepEqual(logs, [])

  await network.apply({ ...OFF, systemCa: true })
  assert.deepEqual(calls.slice(7), [['getCACertificates', 'system'], ['setDefaultCACertificates', [...DEFAULTS, ...SYSTEM]]])
})

test('nothing is touched while every network setting is empty', async () => {
  const { ports, calls } = fakePorts()
  const { network, logs } = mount(ports)
  await network.apply(readNetworkSettings({}))
  await network.apply(readNetworkSettings({ httpsProxy: '  ', caCertificatesFile: '', useSystemCertificates: false }))
  assert.deepEqual(calls, [])
  assert.deepEqual(network.notes(), [])
  assert.deepEqual(network.childEnv(), {})
  assert.deepEqual(logs, [])
})

test('a bad proxy or CA file is ignored with a message and nothing else changes', async () => {
  const pem = await fixture()
  const files = { [CA_FILE]: pem, '/certs/huge.pem': `${pem}${'#'.repeat(MAX_CA_FILE_BYTES)}`, '/certs/notes.txt': 'not a certificate' }

  const badProxy = fakePorts(files)
  const first = mount(badProxy.ports)
  await first.network.apply({ httpsProxy: 'http://u:p@proxy.example.com:8080', caFile: CA_FILE, systemCa: false })
  assert.deepEqual(badProxy.calls, [
    ['readFile', CA_FILE, MAX_CA_FILE_BYTES + 1],
    ['getCACertificates', 'default'],
    ['setDefaultCACertificates', [...DEFAULTS, pem.trim()]]
  ])
  assert.deepEqual(first.network.notes(), [NETWORK.proxyPassword])
  assert.deepEqual(first.logs, [NETWORK.proxyPassword])
  assert.deepEqual(first.network.childEnv(), {})

  const cases = [
    { caFile: '/certs/missing.pem', problem: NETWORK.caUnreadable },
    { caFile: '/certs/huge.pem', problem: NETWORK.caInvalid },
    { caFile: '/certs/notes.txt', problem: NETWORK.caInvalid }
  ]
  for (const { caFile, problem } of cases) {
    const { ports, calls } = fakePorts(files)
    const { network, logs } = mount(ports)
    await network.apply({ httpsProxy: PROXY, caFile, systemCa: false })
    assert.deepEqual(calls, [['setProxy', proxyEnv(PROXY)], ['readFile', caFile, MAX_CA_FILE_BYTES + 1]], caFile)
    assert.deepEqual(network.notes(), [problem, NETWORK.proxyInUse], caFile)
    assert.deepEqual(logs, [problem], caFile)
    const shown = JSON.stringify([network.notes(), logs])
    for (const secret of ['proxy.example.com', 'u:p', '/certs', 'BEGIN', 'not a certificate']) assert.ok(!shown.includes(secret), `${secret} leaked`)
  }

  const later = fakePorts(files)
  const { network } = mount(later.ports)
  await network.apply({ ...OFF, caFile: CA_FILE })
  await network.apply({ ...OFF, caFile: '/certs/missing.pem' })
  assert.deepEqual(later.calls.slice(3), [['readFile', '/certs/missing.pem', MAX_CA_FILE_BYTES + 1], ['setDefaultCACertificates', DEFAULTS]])
  assert.deepEqual(network.notes(), [NETWORK.caUnreadable])
})

test('applies run one at a time, in the order they were asked for', async () => {
  const pem = await fixture()
  const { ports, calls } = fakePorts()
  let release = () => {}
  const read = new Promise<void>(resolve => {
    release = resolve
  })
  const { network } = mount({
    ...ports,
    readFile: async (path, maxBytes) => {
      calls.push(['readFile', path, maxBytes])
      await read
      return pem
    }
  })
  const first = network.apply({ ...OFF, caFile: CA_FILE })
  const second = network.apply(OFF)
  await drain()
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, [
    ['readFile', CA_FILE, MAX_CA_FILE_BYTES + 1],
    ['getCACertificates', 'default'],
    ['setDefaultCACertificates', [...DEFAULTS, pem.trim()]],
    ['setDefaultCACertificates', DEFAULTS]
  ])
})

test("an Orca without the proxy or certificate functions says it can't apply those settings", async () => {
  const pem = await fixture()
  const { ports, calls } = fakePorts({ [CA_FILE]: pem })
  const { network, logs } = mount({ readFile: ports.readFile })
  await network.apply({ httpsProxy: PROXY, caFile: CA_FILE, systemCa: true })
  assert.deepEqual(calls, [])
  assert.deepEqual(network.notes(), [NETWORK.proxyUnsupported, NETWORK.caUnsupported])
  assert.deepEqual(logs, [NETWORK.proxyUnsupported, NETWORK.caUnsupported])
  assert.deepEqual(network.childEnv(), {})
  assert.equal(NETWORK.proxyUnsupported, "This version of Orca can't apply the HTTPS proxy setting, so it's ignored.")
  assert.equal(NETWORK.caUnsupported, "This version of Orca can't apply the certificate settings, so they're ignored.")
})

function fakeSettings(values: Record<string, JsonValue>) {
  const listeners: ((change: { key: string }) => void)[] = []
  const state = { failing: false }
  const settings = {
    get: async () => {
      if (state.failing) throw new Error('settings unavailable')
      return { ...values }
    },
    set: async () => {},
    onDidChange: (listener: (change: { key: string }) => void) => {
      listeners.push(listener)
      return { dispose: () => {} }
    }
  } as unknown as OrcaWorkerApi['settings']
  const change = async (key: string, value: JsonValue) => {
    values[key] = value
    for (const listener of listeners) listener({ key })
    await drain()
  }
  return { settings, change, state }
}

function recordingNetwork() {
  const applied: NetworkSettings[] = []
  const state = { failing: false }
  const network: Network = {
    apply: async settings => {
      applied.push(settings)
      if (state.failing) throw new Error('setGlobalProxyFromEnv refused http://u:p@proxy.example.com:8080')
    },
    notes: () => [],
    childEnv: () => ({})
  }
  return { network, applied, state }
}

test('an unrelated setting change touches no port', async () => {
  const { settings, change } = fakeSettings({ httpsProxy: '', entraTenant: '' })
  const { network, applied } = recordingNetwork()
  const logs: string[] = []
  await watchNetwork(settings, network, message => logs.push(message))
  assert.deepEqual(applied, [OFF])

  await change('entraTenant', 'contoso.onmicrosoft.com')
  await change('shareTemplate', '{title}')
  assert.equal(applied.length, 1)

  await change('httpsProxy', PROXY)
  assert.deepEqual(applied.slice(1), [{ ...OFF, httpsProxy: PROXY }])
  await change('caCertificatesFile', CA_FILE)
  await change('useSystemCertificates', true)
  assert.deepEqual(applied.slice(2), [
    { httpsProxy: PROXY, caFile: CA_FILE, systemCa: false },
    { httpsProxy: PROXY, caFile: CA_FILE, systemCa: true }
  ])
  assert.deepEqual(logs, [])
})

test('a network settings read or apply that fails is logged with a fixed line and the watch goes on', async () => {
  const { settings, change, state: reads } = fakeSettings({ httpsProxy: '' })
  const { network, applied, state: applies } = recordingNetwork()
  const logs: string[] = []
  await watchNetwork(settings, network, message => logs.push(message))

  reads.failing = true
  await change('httpsProxy', PROXY)
  assert.equal(applied.length, 1)
  assert.deepEqual(logs, [SETTINGS_READ_FAILED])

  reads.failing = false
  applies.failing = true
  await change('httpsProxy', OTHER_PROXY)
  assert.deepEqual(logs, [SETTINGS_READ_FAILED, NETWORK.applyFailed])

  applies.failing = false
  await change('httpsProxy', '')
  assert.deepEqual(applied.slice(1), [{ ...OFF, httpsProxy: OTHER_PROXY }, OFF])
  assert.deepEqual(logs, [SETTINGS_READ_FAILED, NETWORK.applyFailed])
})
