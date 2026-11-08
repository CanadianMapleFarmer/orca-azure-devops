import { Badge, Row, type OrcaNode, type Tone } from 'orca'

export interface Chip {
  tone: Tone
  text: string
}

function uniqueKeys(chips: readonly Chip[]): string[] {
  const used = new Set<string>()
  const repeats = new Map<string, number>()
  return chips.map(({ text }) => {
    let key = text
    while (used.has(key)) {
      const n = (repeats.get(text) ?? 0) + 1
      repeats.set(text, n)
      key = `${text}#${n}`
    }
    used.add(key)
    return key
  })
}

export function Chips({ chips }: { chips: readonly Chip[] }): OrcaNode {
  const keys = uniqueKeys(chips)
  return (
    <Row gap="xs" wrap>
      {chips.map((chip, index) => (
        <Badge key={keys[index]} tone={chip.tone}>
          {chip.text}
        </Badge>
      ))}
    </Row>
  )
}
