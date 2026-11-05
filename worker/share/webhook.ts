import { httpRefused, TEAMS_THROTTLED, TEAMS_UNREACHABLE } from '../messages'

const DEFAULT_TIMEOUT_MS = 15_000

export async function postToWebhook(fetchFn: typeof fetch, url: string, payload: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  let status: number
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: deadline.signal
    })
    status = response.status
    await response.body?.cancel().catch(() => {})
  } catch {
    throw new Error(TEAMS_UNREACHABLE)
  } finally {
    clearTimeout(timer)
  }
  if (status >= 200 && status < 300) return
  throw new Error(status === 429 ? TEAMS_THROTTLED : httpRefused(status))
}
