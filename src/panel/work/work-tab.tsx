import { Badge, Button, Callout, EmptyState, read, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { MAX_CHIPS } from '../../shared/chips'
import { NO_BOARDS } from '../../shared/messages'
import type { BoardsTarget, OrgStatus } from '../../shared/types'
import type { WorkSnapshot } from '../../shared/work'
import { counted, showMore } from '../copy'
import { isFoldOpen } from '../folds'
import { Group } from '../group'
import { cutLabel } from '../label'
import { openSettings } from '../org-settings'
import { chooseWorkView, workViewIn, workViewKey, workViews, type WorkView } from '../prefs'
import { LoadFailure } from '../snapshot-parts'
import { foldActions, TabToolbar, type ToolAction } from '../toolbar'
import { ItemCard, ParentCard } from './item-card'
import { ItemDetails } from './item-details'
import { byColumn, byLane, GROUP_PAGE, planWork, tasksKey, tasksOpenByDefault, WORK_NODE_BUDGET, type LaneGroup, type TaskRow, type WorkCard, type WorkPlan } from './plan'
import { dismiss, load, move, notice, openBoard, openItem, pages, refresh, refreshing, retryLoad, showNextPage, snapshot } from './state'
import { TaskRows } from './task-rows'

const MAX_NUDGES = 10
const CARD_NODES = 12
const BADGE_NODES = 2
const ROW_NODES = 8
const GROUP_NODES = 4
const NOT_ON_BOARD = 'Not on this board'
const UNKNOWN_TYPE = 'Unknown type'
const NO_PARENT = 'No parent'
const SOME_HIDDEN = 'Some items are hidden. Collapse a group to see others.'
const NO_SWIMLANES = 'This board has no swimlanes, so Lanes shows the columns.'

interface Draw {
  org: string
  left: number
  hidden: boolean
  shown: Record<string, number>
}

function fits(draw: Draw, nodes: number): boolean {
  if (draw.hidden || draw.left < nodes) {
    draw.hidden = true
    return false
  }
  draw.left -= nodes
  return true
}

function fitting<T>(draw: Draw, items: readonly T[], nodes: number): T[] {
  const kept: T[] = []
  for (const item of items) {
    if (!fits(draw, nodes)) break
    kept.push(item)
  }
  return kept
}

function Toolbar({ org, boards, current, view }: { org: string; boards: BoardsTarget; current: WorkSnapshot; view: WorkView }): OrcaNode {
  const actions: ToolAction[] = [
    ...foldActions(org, 'work'),
    { icon: 'refresh', label: 'Refresh', disabled: read(refreshing), onPress: () => refresh(org) },
    { icon: 'open-external', label: 'Open board', onPress: () => openBoard(org) }
  ]
  const key = workViewKey(org, boards)
  const choose = (next: WorkView) => (view === next ? 'solid' : 'ghost')
  return (
    <TabToolbar
      left={
        <>
          {current.board ? <Badge>{cutLabel(`${boards.teamName} · ${current.board.boardName}`)}</Badge> : null}
          <Row gap="xs">
            <Button size="sm" variant={choose('columns')} onPress={() => chooseWorkView(key, 'columns')}>
              Columns
            </Button>
            <Button size="sm" variant={choose('lanes')} onPress={() => chooseWorkView(key, 'lanes')}>
              Lanes
            </Button>
          </Row>
        </>
      }
      actions={actions}
      updatedAt={current.updatedAt}
      message={current.message}
      stale={current.stale}
    />
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

function cardNodes(card: WorkCard): number {
  const prs = card.item?.prs.length ?? 0
  return CARD_NODES + BADGE_NODES * (Math.min(prs, MAX_CHIPS) + (prs > MAX_CHIPS ? 1 : 0))
}

function cardBlock(draw: Draw, card: WorkCard): OrcaNode {
  if (!fits(draw, cardNodes(card))) return null
  const open = card.total > 0 && isFoldOpen(draw.org, 'work', tasksKey(card.id), tasksOpenByDefault(card))
  const rows = open ? fitting(draw, card.tasks, ROW_NODES) : []
  return (
    <Stack key={card.key} gap="xs">
      {card.item ? <ItemCard org={draw.org} item={card.item} card={card} open={open} /> : <ParentCard org={draw.org} card={card} open={open} />}
      {rows.length > 0 || (open && card.more > 0) ? <TaskRows org={draw.org} rows={rows} more={card.more} /> : null}
    </Stack>
  )
}

function paged<T>(draw: Draw, key: string, items: readonly T[], drawEach: (shown: readonly T[]) => OrcaNode): OrcaNode {
  const limit = draw.shown[key] ?? GROUP_PAGE
  const body = drawEach(items.slice(0, limit))
  const left = items.length - limit
  return (
    <Stack gap="sm">
      {body}
      {left > 0 && !draw.hidden ? (
        <Button size="sm" variant="ghost" onPress={() => showNextPage(key)}>
          {showMore(Math.min(GROUP_PAGE, left))}
        </Button>
      ) : null}
    </Stack>
  )
}

function drawGroup(draw: Draw, key: string, title: string, count: string, body: () => OrcaNode): OrcaNode {
  draw.left -= GROUP_NODES
  const open = isFoldOpen(draw.org, 'work', key)
  return (
    <Group key={key} org={draw.org} tab="work" foldKey={key} title={title} count={count}>
      {open ? body() : null}
    </Group>
  )
}

function cardGroup(draw: Draw, key: string, title: string, cards: readonly WorkCard[]): OrcaNode {
  return drawGroup(draw, key, title, counted(cards.length, 'item', 'items'), () => paged(draw, key, cards, shown => shown.map(card => cardBlock(draw, card))))
}

function laneGroup(draw: Draw, lane: LaneGroup): OrcaNode {
  const count = lane.columns.reduce((sum, column) => sum + column.cards.length, 0)
  const key = `lane:${lane.id}`
  return drawGroup(draw, key, lane.name, counted(count, 'item', 'items'), () => (
    <Stack gap="sm">{lane.columns.map(column => cardGroup(draw, `${key}/column:${column.name}`, column.name, column.cards))}</Stack>
  ))
}

function offBoardGroup(draw: Draw, plan: WorkPlan): OrcaNode {
  const total = plan.offBoard.reduce((sum, type) => sum + type.cards.length, 0) + plan.unknown.length
  if (total === 0) return null
  return drawGroup(draw, 'offboard', NOT_ON_BOARD, counted(total, 'item', 'items'), () => (
    <Stack gap="sm">
      {plan.offBoard.map(type => cardGroup(draw, `offboard/type:${type.type}`, type.type, type.cards))}
      {plan.unknown.length > 0 ? cardGroup(draw, 'offboard/unknown', UNKNOWN_TYPE, plan.unknown) : null}
    </Stack>
  ))
}

function noParentGroup(draw: Draw, rows: readonly TaskRow[]): OrcaNode {
  if (rows.length === 0) return null
  return drawGroup(draw, 'noparent', NO_PARENT, counted(rows.length, 'task', 'tasks'), () =>
    paged(draw, 'noparent', rows, shown => {
      const drawn = fitting(draw, shown, ROW_NODES)
      return drawn.length > 0 ? <TaskRows org={draw.org} rows={drawn} more={0} /> : null
    })
  )
}

function Groups({ org, current, view }: { org: string; current: WorkSnapshot; view: WorkView }): OrcaNode {
  const plan = planWork(current)
  if (plan.board.length + plan.offBoard.length + plan.unknown.length + plan.noParent.length === 0) {
    return <EmptyState title="Nothing assigned to you on this board" />
  }
  const draw: Draw = { org, left: WORK_NODE_BUDGET, hidden: false, shown: read(pages) }
  const config = current.board ?? { columns: [], lanes: [] }
  const swimlanes = view === 'lanes' && config.lanes.length > 1
  return (
    <Stack gap="sm">
      {view === 'lanes' && !swimlanes ? (
        <Text size="sm" muted>
          {NO_SWIMLANES}
        </Text>
      ) : null}
      {swimlanes
        ? byLane(plan.board, config).map(lane => laneGroup(draw, lane))
        : byColumn(plan.board, config).map(column => cardGroup(draw, `column:${column.name}`, column.name, column.cards))}
      {offBoardGroup(draw, plan)}
      {noParentGroup(draw, plan.noParent)}
      {draw.hidden ? (
        <Text size="sm" muted>
          {SOME_HIDDEN}
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
    return <LoadFailure message={status.message} onRetry={retryLoad} />
  }
  const shown = read(notice)
  const view = workViewIn(read(workViews), workViewKey(org.org, org.boards))
  return (
    <Stack gap="md">
      <Toolbar org={org.org} boards={org.boards} current={current} view={view} />
      {shown ? <Callout tone={shown.tone}>{shown.text}</Callout> : null}
      <Nudges org={org.org} current={current} />
      <Groups org={org.org} current={current} view={view} />
    </Stack>
  )
}
