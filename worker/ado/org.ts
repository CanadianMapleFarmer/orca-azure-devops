const ORG_NAME = /^[a-z0-9][a-z0-9-]{0,49}$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALL_ZERO_TENANT = '00000000-0000-0000-0000-000000000000'
const LEGACY_HOST_SUFFIX = '.visualstudio.com'
const DISCOVERY_TIMEOUT_MS = 10_000

export function isValidOrgName(name: string): boolean {
  return ORG_NAME.test(name)
}

export function parseOrgInput(input: string): { org: string; url: string } | null {
  const text = input.trim().toLowerCase()
  const org = isValidOrgName(text) ? text : orgFromUrl(text)
  return org && isValidOrgName(org) ? { org, url: orgWebUrl(org) } : null
}

export function orgWebUrl(org: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}`
}

function orgFromUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname === 'dev.azure.com') return url.pathname.split('/').find(Boolean) ?? null
  if (url.hostname.endsWith(LEGACY_HOST_SUFFIX)) return url.hostname.slice(0, -LEGACY_HOST_SUFFIX.length)
  return null
}

export async function discoverTenant(
  org: string,
  fetchFn: typeof fetch,
  timeoutMs = DISCOVERY_TIMEOUT_MS
): Promise<string | null> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  try {
    const res = await fetchFn(`https://vssps.dev.azure.com/${org}`, { method: 'HEAD', signal: deadline.signal })
    const tenant = res.headers.get('x-vss-resourcetenant')
    return tenant && GUID.test(tenant) && tenant !== ALL_ZERO_TENANT ? tenant : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
