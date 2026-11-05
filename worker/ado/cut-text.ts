const ELLIPSIS = '…'

export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max - ELLIPSIS.length)
  const lastUnit = head.charCodeAt(head.length - 1)
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff
  return `${splitsPair ? head.slice(0, -1) : head}${ELLIPSIS}`
}
