import { Badge, Box, Button, Callout, Collapsible, EmptyState, IconButton, read, RelativeTime, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { OrgStatus } from '../../shared/types'
import type { WorkItemSummary, WorkSnapshot } from '../../shared/work'
import { openSettings } from '../org-settings'
import { ItemCard } from './item-card'
import { ItemDetails } from './item-details'
import { NO_BOARDS } from '../../shared/messages'
import { dismiss, load, move, notice, openBoard, openItem, refresh, refreshing, retryLoad, snapshot } from './state'

const MAX_CARDS = 300
const MAX_NUDGES = 10

function columnGroups(current: WorkSnapshot): { name: string; items: WorkItemSummary[] }[] {
  const names = current.board?.columns.map(column => column.name) ?? []
  const groups = new Map(names.map(name => [name, [] as WorkItemSummary[]]))
  for (const item of current.mine) {
    const name = item.column !== null && groups.has(item.column) ? item.column : (names[0] ?? item.column ?? 'No column')
    const list = groups.get(name)
    if (list) list.push(item)
    else groups.set(name, [item])
  }
  return [...groups].filter(([, items]) => items.length > 0).map(([name, items]) => ({ name, items }))
}

function Header({ org, current }: { org: string; current: WorkSnapshot }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm">
        <Box grow shrink minWidth={0}>
          <Row gap="sm" align="center" wrap>
            {current.board ? <Badge>{current.board.boardName}</Badge> : null}
            <Text muted size="sm">
              Updated <RelativeTime at={current.updatedAt} />
            </Text>
          </Row>
        </Box>
        <Row gap="xs" align="center">
          <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={read(refreshing)} onPress={() => refresh(org)} />
          <IconButton icon="open-external" label="Open board" variant="ghost" size="sm" onPress={() => openBoard(org)} />
        </Row>
      </Row>
      {current.message && current.stale ? (
        <Text size="sm" tone="warning">
          {current.message}
        </Text>
      ) : null}
      {current.message && !current.stale ? (
        <Text size="sm" muted>
          {current.message}
        </Text>
      ) : null}
    </Stack>
  )
}

function Nudges({ org, current }: { org: string; current: WorkSnapshot }): OrcaNode {
  const listed = current.nudges.flatMap(nudge => {
    const item = current.mine.find(candidate => candidate.id === nudge.itemId)
    return item ? [{ nudge, item }] : []
  })
  if (listed.length === 0) return null
  return (
    <Stack gap="sm">
      {listed.slice(0, MAX_NUDGES).map(({ nudge, item }) => (
        <Callout key={`${nudge.itemId}:${nudge.prId}`} tone="accent" title={`#${nudge.itemId} — PR ${nudge.prId} merged into ${nudge.branch}`}>
          <Stack gap="xs">
            <Text size="sm">{item.title}</Text>
            <Row gap="sm" wrap>
              <Button size="sm" onPress={() => move(org, item.id, item.rev, { column: nudge.toColumn })}>
                {`Move to ${nudge.toColumn}`}
              </Button>
              <Button size="sm" variant="ghost" onPress={() => dismiss(org, nudge)}>
                Dismiss
              </Button>
            </Row>
          </Stack>
        </Callout>
      ))}
      {listed.length > MAX_NUDGES ? (
        <Text size="sm" muted>
          {moreNudges(listed.length - MAX_NUDGES)}
        </Text>
      ) : null}
    </Stack>
  )
}

function moreNudges(count: number): string {
  return count === 1 ? '1 more suggestion not shown.' : `${count} more suggestions not shown.`
}

function Groups({ org, current }: { org: string; current: WorkSnapshot }): OrcaNode {
  const total = current.mine.length + current.other.length
  if (total === 0) return <EmptyState title="Nothing assigned to you on this board" />
  const groups = columnGroups(current).map(group => ({ key: `column:${group.name}`, ...group }))
  if (current.other.length > 0) groups.push({ key: 'other', name: 'Other', items: current.other })
  let room = MAX_CARDS
  const shown = groups.map(group => {
    const items = group.items.slice(0, room)
    room -= items.length
    return { ...group, count: group.items.length, items }
  })
  return (
    <Stack gap="sm">
      {shown.map(group => (
        <Collapsible key={group.key} title={`${group.name} (${group.count})`} defaultOpen>
          <Stack gap="sm">
            {group.items.map(item => (
              <ItemCard key={item.id} org={org} item={item} />
            ))}
          </Stack>
        </Collapsible>
      ))}
      {total > MAX_CARDS ? (
        <Text size="sm" muted>
          {`Showing ${MAX_CARDS} of ${total} items. Open the board to see the rest.`}
        </Text>
      ) : null}
    </Stack>
  )
}

export function WorkTab({ org }: { org: OrgStatus }): OrcaNode {
  if (!org.boards) {
    return (
      <EmptyState title={NO_BOARDS}>
        <Button onPress={() => openSettings(org)}>Open settings</Button>
      </EmptyState>
    )
  }
  const open = read(openItem)
  if (open?.org === org.org) return <ItemDetails org={org.org} />
  const stored = read(snapshot)
  const current = stored?.org === org.org ? stored : null
  const status = read(load)
  if (!current) {
    if (status.status !== 'failed') return <Skeleton lines={3} label="Loading work items" />
    return (
      <Stack gap="sm">
        <Callout tone="danger">{status.message}</Callout>
        <Row gap="sm">
          <Button onPress={retryLoad}>Try again</Button>
        </Row>
      </Stack>
    )
  }
  const shown = read(notice)
  return (
    <Stack gap="md">
      <Header org={org.org} current={current} />
      {shown ? <Callout tone={shown.tone}>{shown.text}</Callout> : null}
      <Nudges org={org.org} current={current} />
      <Groups org={org.org} current={current} />
    </Stack>
  )
}
