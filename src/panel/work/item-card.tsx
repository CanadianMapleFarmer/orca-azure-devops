import { Badge, Button, Card, read, Row, Select, type OrcaNode } from 'orca'
import { chipOf, MAX_CHIPS } from '../../shared/chips'
import type { WorkItemSummary } from '../../shared/work'
import { openDetails } from './item-details'
import { move, moveResets } from './state'

export function ItemCard({ org, item }: { org: string; item: WorkItemSummary }): OrcaNode {
  const byColumn = item.targets.columns.length > 0
  const current = byColumn ? item.column : item.state
  const options = (byColumn ? item.targets.columns : item.targets.states)
    .filter(value => value !== current)
    .map(value => ({ value, label: value }))
  return (
    <Card title={item.title} description={`${item.type} #${item.id}`}>
      {item.prs.length > 0 ? (
        <Row gap="xs" wrap>
          {item.prs.slice(0, MAX_CHIPS).map(pr => {
            const chip = chipOf(pr)
            return (
              <Badge key={pr.prId} tone={chip.tone}>
                {chip.text}
              </Badge>
            )
          })}
          {item.prs.length > MAX_CHIPS ? <Badge tone="neutral">{`+${item.prs.length - MAX_CHIPS}`}</Badge> : null}
        </Row>
      ) : null}
      {options.length > 0 ? (
        <Select
          key={`move-${read(moveResets)}`}
          label="Move to"
          labelHidden
          placeholder="Move to"
          options={options}
          onChange={value => move(org, item.id, item.rev, byColumn ? { column: value } : { state: value })}
        />
      ) : null}
      <Row gap="sm">
        <Button variant="ghost" size="sm" onPress={() => openDetails(org, item.id)}>
          Details
        </Button>
      </Row>
    </Card>
  )
}
