import { Badge, Box, Button, Card, IconButton, Link, read, Row, Select, Text, type OrcaNode } from 'orca'
import { chipOf, MAX_CHIPS } from '../../shared/chips'
import type { WorkItemSummary } from '../../shared/work'
import { setFoldOpen } from '../folds'
import { openDetails } from './item-details'
import { cutTitle, tasksKey, typeIcon, type WorkCard } from './plan'
import { move, moveResets } from './state'

export function CompactMove({ org, item }: { org: string; item: WorkItemSummary }): OrcaNode {
  const byColumn = item.targets.columns.length > 0
  const current = byColumn ? item.column : item.state
  const options = (byColumn ? item.targets.columns : item.targets.states)
    .filter(value => value !== current)
    .map(value => ({ value, label: value }))
  if (options.length === 0) return null
  return (
    <Box width={112} shrink={false}>
      <Select
        key={`move-${read(moveResets)}`}
        label="Move"
        labelHidden
        placeholder="Move"
        options={options}
        onChange={value => move(org, item.id, item.rev, byColumn ? { column: value } : { state: value })}
      />
    </Box>
  )
}

function TasksToggle({ org, card, open }: { org: string; card: WorkCard; open: boolean }): OrcaNode {
  if (card.total === 0) return null
  return (
    <Button variant="ghost" size="xs" tooltip={`${card.done} of ${card.total} tasks done`} onPress={() => setFoldOpen(org, 'work', tasksKey(card.id), !open)}>
      {`Tasks ${card.done}/${card.total}`}
    </Button>
  )
}

export function ItemCard({ org, item, card, open }: { org: string; item: WorkItemSummary; card: WorkCard; open: boolean }): OrcaNode {
  return (
    <Card>
      <Link onPress={() => openDetails(org, item.id)}>{cutTitle(item.title)}</Link>
      <Row gap="xs" align="center" wrap>
        <IconButton icon={typeIcon(item.type)} label={item.type} variant="ghost" size="xs" onPress={() => openDetails(org, item.id)} />
        <Text size="sm" muted>{`#${item.id}`}</Text>
        {item.prs.slice(0, MAX_CHIPS).map(pr => {
          const chip = chipOf(pr)
          return (
            <Badge key={pr.prId} tone={chip.tone}>
              {chip.text}
            </Badge>
          )
        })}
        {item.prs.length > MAX_CHIPS ? <Badge tone="neutral">{`+${item.prs.length - MAX_CHIPS}`}</Badge> : null}
        <TasksToggle org={org} card={card} open={open} />
        <CompactMove org={org} item={item} />
      </Row>
    </Card>
  )
}

export function ParentCard({ org, card, open }: { org: string; card: WorkCard; open: boolean }): OrcaNode {
  return (
    <Card>
      <Text muted weight="medium">
        {card.parent ? `#${card.id} ${cutTitle(card.parent.title)}` : `#${card.id}`}
      </Text>
      {card.total > 0 ? (
        <Row gap="xs" align="center" wrap>
          <TasksToggle org={org} card={card} open={open} />
        </Row>
      ) : null}
    </Card>
  )
}
