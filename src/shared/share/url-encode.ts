export function encodeWellFormed(text: string): string {
  let wellFormed = ''
  for (const char of text) wellFormed += char.length === 1 && char >= '\uD800' && char <= '\uDFFF' ? '�' : char
  return encodeURIComponent(wellFormed)
}
