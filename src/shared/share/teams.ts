export const MAX_CHAT_URL = 2000

function encode(text: string): string {
  let wellFormed = ''
  for (const char of text) wellFormed += char.length === 1 && char >= '\uD800' && char <= '\uDFFF' ? '�' : char
  return encodeURIComponent(wellFormed)
}

export function teamsChatUrl(input: { users: string[]; text: string; tenantId: string | null }): string | null {
  if (input.users.length === 0) return null
  const tenant = input.tenantId ? `&tenantId=${encode(input.tenantId)}` : ''
  const url = `https://teams.microsoft.com/l/chat/0/0?users=${input.users.map(encode).join(',')}&message=${encode(input.text)}${tenant}`
  return url.length > MAX_CHAT_URL ? null : url
}
