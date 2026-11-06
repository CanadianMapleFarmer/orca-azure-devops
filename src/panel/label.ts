export const MAX_LABEL_BYTES = 1024

const ELLIPSIS = '…'

function utf8Bytes(char: string): number {
  const point = char.codePointAt(0) ?? 0
  if (point < 0x80) return 1
  if (point < 0x800) return 2
  return point < 0x10000 ? 3 : 4
}

export function cutLabel(text: string): string {
  let total = 0
  for (const char of text) total += utf8Bytes(char)
  if (total <= MAX_LABEL_BYTES) return text
  let room = MAX_LABEL_BYTES - utf8Bytes(ELLIPSIS)
  let head = ''
  for (const char of text) {
    room -= utf8Bytes(char)
    if (room < 0) break
    head += char
  }
  return head + ELLIPSIS
}
