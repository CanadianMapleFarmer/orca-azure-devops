import { Badge, Row, type OrcaNode, type Tone } from 'orca'

export interface Chip {
  tone: Tone
  text: string
}

export function Chips({ chips }: { chips: readonly Chip[] }): OrcaNode {
  return (
    <Row gap="xs" wrap>
      {chips.map(chip => (
        <Badge key={chip.text} tone={chip.tone}>
          {chip.text}
        </Badge>
      ))}
    </Row>
  )
}
