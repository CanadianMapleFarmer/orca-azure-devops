const ORG_NAME = /^[a-z0-9][a-z0-9-]{0,49}$/
const ALL_ZERO_TENANT = '00000000-0000-0000-0000-000000000000'
const LEGACY_HOST_SUFFIX = '.visualstudio.com'

export function parseOrgInput(input: string): { org: string; url: string } | null {
  const text = input.trim().toLowerCase()
  const org = ORG_NAME.test(text) ? text : orgFromUrl(text)
  return org && ORG_NAME.test(org) ? { org, url: `https://dev.azure.com/${org}` } : null
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

export async function discoverTenant(org: string, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`https://vssps.dev.azure.com/${org}`, { method: 'HEAD' })
    const tenant = res.headers.get('x-vss-resourcetenant')
    return tenant && tenant !== ALL_ZERO_TENANT ? tenant : null
  } catch {
    return null
  }
}
