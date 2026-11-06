import { encodeWellFormed } from './url-encode'

export const MAX_CHAT_URL = 2000

export function teamsChatUrl(input: { users: string[]; text: string; tenantId: string | null }): string | null {
  if (input.users.length === 0) return null
  const tenant = input.tenantId ? `&tenantId=${encodeWellFormed(input.tenantId)}` : ''
  const url = `https://teams.microsoft.com/l/chat/0/0?users=${input.users.map(encodeWellFormed).join(',')}&message=${encodeWellFormed(input.text)}${tenant}`
  return url.length > MAX_CHAT_URL ? null : url
}
