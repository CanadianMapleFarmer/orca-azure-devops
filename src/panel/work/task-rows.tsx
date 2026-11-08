import { Box, Link, Row, Text, type OrcaNode } from 'orca'
import { CompactMove } from './item-card'
import { openDetails } from './item-details'
import { cutTitle, type TaskRow } from './plan'

const UNASSIGNED = 'Unassigned'

function TaskLine({ org, row }: { org: string; row: TaskRow }): OrcaNode {
  const text = `#${row.id} ${cutTitle(row.title)}`
  return (
    <Row gap="xs" align="center" wrap>
      {row.done ? (
        <Text size="sm" muted>
          {text}
        </Text>
      ) : (
        <Link onPress={() => openDetails(org, row.id)}>{text}</Link>
      )}
      <Text size="sm" muted>
        {row.state}
      </Text>
      {row.mine ? null : (
        <Text size="sm" muted>
          {row.assignee ?? UNASSIGNED}
        </Text>
      )}
      {row.item ? <CompactMove org={org} item={row.item} /> : null}
    </Row>
  )
}

export function TaskRows({ org, rows, more }: { org: string; rows: readonly TaskRow[]; more: number }): OrcaNode {
  return (
    <Box paddingX="sm" gap="xs">
      {rows.map(row => (
        <TaskLine key={row.id} org={org} row={row} />
      ))}
      {more > 0 ? (
        <Text size="sm" muted>
          {`+ ${more} more`}
        </Text>
      ) : null}
    </Box>
  )
}
