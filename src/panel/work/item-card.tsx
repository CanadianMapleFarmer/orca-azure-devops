import { Badge, Box, Button, IconButton, List, ListItem, Progress, read, Row, Select, Text, type OrcaNode } from 'orca'
import { chipOf, MAX_CHIPS } from '../../shared/chips'
import type { WorkItemSummary } from '../../shared/work'
import { setFoldOpen } from '../folds'
import { openDetails } from './item-details'
import { cutTitle, tasksKey, typeIcon, type WorkCard } from './plan'
import { move, moveResets } from './state'

const movesByColumn = (item: WorkItemSummary): boolean => item.targets.columns.length > 0

export function moveTargets(item: WorkItemSummary): string[] {
  const byColumn = movesByColumn(item)
  const current = byColumn ? item.column : item.state
  return (byColumn ? item.targets.columns : item.targets.states).filter(value => value !== current)
}

export function CompactMove({ org, item }: { org: string; item: WorkItemSummary }): OrcaNode {
  const targets = moveTargets(item)
  if (targets.length === 0) return null
  const byColumn = movesByColumn(item)
  return (
    <Box width={112} shrink={false}>
      <Select
        key={`move-${read(moveResets)}`}
        label="Move"
        labelHidden
        placeholder="Move"
        options={targets.map(value => ({ value, label: value }))}
        onChange={value => move(org, item.id, item.rev, byColumn ? { column: value } : { state: value })}
      />
    </Box>
  )
}

const tasksDone = (card: WorkCard): string => `${card.done} of ${card.total} tasks done`

function TasksToggle({ org, card, open }: { org: string; card: WorkCard; open: boolean }): OrcaNode {
  if (card.total === 0) return null
  return (
    <Button variant="ghost" size="xs" icon={open ? 'expand' : 'next'} tooltip={tasksDone(card)} onPress={() => setFoldOpen(org, 'work', tasksKey(card.id), !open)}>
      {`Tasks ${card.done}/${card.total}`}
    </Button>
  )
}

interface CardProps {
  org: string
  card: WorkCard
  open: boolean
  children?: OrcaNode
}

export function ItemCard({ org, item, card, open, children }: CardProps & { item: WorkItemSummary }): OrcaNode {
  return (
    <Box border radius="md" background="card" padding="xs" gap="none">
      <List label={`${item.type} #${item.id}`}>
        <ListItem title={cutTitle(item.title)} onPress={() => openDetails(org, item.id)} />
      </List>
      <Box paddingX="sm" paddingY="xs" gap="xs">
        <Row justify="between" align="center" gap="xs">
          <Row gap="xs" align="center" wrap>
            <IconButton icon={typeIcon(item.type)} label={item.type} variant="ghost" size="xs" onPress={() => openDetails(org, item.id)} />
            <Text size="xs" muted>{`#${item.id}`}</Text>
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
          </Row>
          <CompactMove org={org} item={item} />
        </Row>
        {children}
      </Box>
    </Box>
  )
}

export function ParentCard({ org, card, open, children }: CardProps): OrcaNode {
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Text size="sm" muted>
        {card.parent ? `#${card.id} ${cutTitle(card.parent.title)}` : `#${card.id}`}
      </Text>
      {card.total > 0 ? (
        <Row gap="xs" align="center">
          <Box width={64}>
            <Progress label={tasksDone(card)} labelHidden value={Math.min(100, Math.round((100 * card.done) / card.total))} />
          </Box>
          <TasksToggle org={org} card={card} open={open} />
        </Row>
      ) : null}
      {children}
    </Box>
  )
}
