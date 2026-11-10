import { Badge, Box, Link, Row, Text, type OrcaNode } from 'orca'
import { CompactMove, moveTargets } from './item-card'
import { openDetails } from './item-details'
import { cutTitle, type TaskRow } from './plan'

const UNASSIGNED = 'Unassigned'

function TaskLine({ org, row }: { org: string; row: TaskRow }): OrcaNode {
  const title = row.mine ? cutTitle(row.title) : `${cutTitle(row.title)} · ${row.assignee ?? UNASSIGNED}`
  const movable = row.item && !row.done && moveTargets(row.item).length > 0 ? row.item : null
  return (
    <Row gap="xs" align="center" justify="between">
      <Box shrink={false}>
        <Link onPress={() => openDetails(org, row.id)}>{`#${row.id}`}</Link>
      </Box>
      <Box grow minWidth={0}>
        <Text size="sm" truncate muted={row.done}>
          {title}
        </Text>
      </Box>
      {movable ? (
        <CompactMove org={org} item={movable} placeholder={row.state} />
      ) : (
        <Box shrink={false}>
          <Badge tone={row.done ? 'success' : 'neutral'}>{row.state}</Badge>
        </Box>
      )}
    </Row>
  )
}

export function TaskRows({ org, rows, more }: { org: string; rows: readonly TaskRow[]; more: number }): OrcaNode {
  return (
    <Box background="muted" radius="sm" padding="xs" gap="xs">
      {rows.map(row => (
        <TaskLine key={row.id} org={org} row={row} />
      ))}
      {more > 0 ? (
        <Text size="xs" muted>
          {`+ ${more} more`}
        </Text>
      ) : null}
    </Box>
  )
}
