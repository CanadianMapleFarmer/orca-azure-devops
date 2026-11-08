import { Box, IconButton, RelativeTime, Row, Stack, Text, type IconName, type OrcaNode } from 'orca'
import { COLLAPSE_ALL, EXPAND_ALL } from './copy'
import { setAllFolds, type FoldTab } from './folds'
import { SnapshotMessage } from './snapshot-parts'

export interface ToolAction {
  icon: IconName
  label: string
  onPress: () => unknown
  disabled?: boolean
}

interface TabToolbarProps {
  left?: OrcaNode
  actions: readonly ToolAction[]
  updatedAt: number
  message?: string
  stale: boolean
}

export function foldActions(org: string, tab: FoldTab): ToolAction[] {
  return [
    { icon: 'collapse', label: COLLAPSE_ALL, onPress: () => setAllFolds(org, tab, false) },
    { icon: 'expand', label: EXPAND_ALL, onPress: () => setAllFolds(org, tab, true) }
  ]
}

export function TabToolbar({ left, actions, updatedAt, message, stale }: TabToolbarProps): OrcaNode {
  return (
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm" wrap>
        <Box grow shrink minWidth={0}>
          <Row gap="xs" wrap>
            {left}
          </Row>
        </Box>
        <Row gap="xs">
          {actions.map(action => (
            <IconButton key={action.label} icon={action.icon} label={action.label} variant="ghost" size="sm" disabled={action.disabled} onPress={action.onPress} />
          ))}
        </Row>
      </Row>
      <Text muted size="sm">
        Updated <RelativeTime at={updatedAt} />
      </Text>
      <SnapshotMessage message={message} stale={stale} />
    </Stack>
  )
}
