import { encodeWellFormed } from './url-encode'

export const MAX_MAIL_URL = 2000

export function mailtoUrl(input: { to: string[]; subject: string; body: string }): string | null {
  if (input.to.length === 0) return null
  const url = `mailto:${input.to.map(encodeWellFormed).join(',')}?subject=${encodeWellFormed(input.subject)}&body=${encodeWellFormed(input.body)}`
  return url.length > MAX_MAIL_URL ? null : url
}
