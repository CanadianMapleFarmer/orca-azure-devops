import { Box, IconButton, RelativeTime, Row, Select, Stack, Text, type Atom, type IconName, type OrcaNode } from 'orca'
import { ALL_PROJECTS, ALL_REPOS, COLLAPSE_ALL, EXPAND_ALL } from './copy'
import { setAllFolds, type FoldTab } from './folds'
import type { Choices, Scope } from './grouping'
import { cutLabel } from './label'
import { chooseProject, chooseRepo } from './prefs'
import { SnapshotMessage } from './snapshot-parts'

const ALL = '*'

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

interface ScopePickersProps<S extends Scope> {
  org: string
  choices: Choices
  prefs: Atom<Record<string, S>>
}

export function ScopePickers<S extends Scope>({ org, choices, prefs }: ScopePickersProps<S>): OrcaNode {
  return (
    <>
      <Select
        label="Project"
        labelHidden
        value={choices.scope.project ?? ALL}
        options={[{ value: ALL, label: ALL_PROJECTS }, ...choices.projects.map(project => ({ value: project.id, label: cutLabel(project.name) }))]}
        onChange={value => chooseProject(prefs, org, value === ALL ? null : value)}
      />
      {choices.repos.length > 0 ? (
        <Select
          label="Repository"
          labelHidden
          value={choices.scope.repo ?? ALL}
          options={[{ value: ALL, label: ALL_REPOS }, ...choices.repos.map(repo => ({ value: repo.id, label: cutLabel(repo.name) }))]}
          onChange={value => chooseRepo(prefs, org, value === ALL ? null : value)}
        />
      ) : null}
    </>
  )
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
