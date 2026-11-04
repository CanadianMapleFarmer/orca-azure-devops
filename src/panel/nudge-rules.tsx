import {
  atom,
  Box,
  Button,
  Callout,
  Collapsible,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  set,
  Skeleton,
  Spinner,
  Stack,
  Text,
  update,
  type OrcaNode
} from 'orca'
import { NO_BOARDS } from '../shared/messages'
import type { OrgStatus } from '../shared/types'
import { MAX_NUDGE_RULES } from '../shared/work'
import { messageOf } from './state'
import { snapshot as workSnapshot } from './work/state'

type Rule = { branch: string; column: string }
type RuleRow = Rule & { id: number }
type RulesLoad = 'idle' | 'loading' | 'ready' | 'failed'

const rulesTeam = atom<string | null>(null)
const rulesOpen = atom(false)
const rulesLoad = atom<RulesLoad>('idle')
const rules = atom<RuleRow[]>([])
const ruleColumns = atom<string[]>([])
const rulesError = atom<string | null>(null)
const rulesSaving = atom(false)

let rulesRun = 0
let lastRuleId = 0

export function resetRules(team: string | null): void {
  rulesRun += 1
  set(rulesTeam, team)
  set(rulesOpen, false)
  set(rulesLoad, 'idle')
  set(rules, [])
  set(ruleColumns, [])
  set(rulesError, null)
  set(rulesSaving, false)
}

function rowsOf(list: readonly Rule[]): RuleRow[] {
  return list.map(rule => ({ ...rule, id: (lastRuleId += 1) }))
}

async function columnNames(org: string, team: string): Promise<string[]> {
  const loaded = read(workSnapshot)
  const current = loaded?.org === org && loaded.board?.teamId === team ? loaded : await plugin.request('work.snapshot', { org })
  if (!current.board) throw new Error(current.message ?? NO_BOARDS)
  return current.board.columns.map(column => column.name)
}

async function loadRules(org: string, team: string): Promise<void> {
  const run = rulesRun
  set(rulesLoad, 'loading')
  set(rulesError, null)
  try {
    const [stored, names] = await Promise.all([plugin.request('work.nudgeRules', { org, teamId: team }), columnNames(org, team)])
    if (run !== rulesRun) return
    set(rules, rowsOf(stored.rules))
    set(ruleColumns, names)
    set(rulesLoad, 'ready')
  } catch (error) {
    if (run !== rulesRun) return
    set(rulesError, messageOf(error))
    set(rulesLoad, 'failed')
  }
}

function toggleRules(org: string, team: string, open: boolean): void {
  set(rulesOpen, open)
  if (open && (read(rulesLoad) === 'idle' || read(rulesLoad) === 'failed')) void loadRules(org, team)
}

function addRule(): void {
  update(rules, list => [...list, ...rowsOf([{ branch: '', column: '' }])])
}

function editRule(id: number, change: Partial<Rule>): void {
  update(rules, list => list.map(row => (row.id === id ? { ...row, ...change } : row)))
}

function removeRule(id: number): void {
  update(rules, list => list.filter(row => row.id !== id))
}

async function saveRules(org: string, team: string): Promise<void> {
  const run = rulesRun
  const sent = read(rules)
    .map(row => ({ branch: row.branch.trim(), column: row.column }))
    .filter(rule => rule.branch !== '')
  set(rulesSaving, true)
  set(rulesError, null)
  try {
    const saved = await plugin.request('work.nudgeRules', { org, teamId: team, rules: sent })
    if (run === rulesRun) set(rules, rowsOf(saved.rules))
  } catch (error) {
    if (run === rulesRun) set(rulesError, messageOf(error))
  } finally {
    if (run === rulesRun) set(rulesSaving, false)
  }
}

export function followRulesTeam(team: string | null): void {
  if (team !== read(rulesTeam)) resetRules(team)
}

function RuleRows({ org, team }: { org: string; team: string }): OrcaNode {
  const list = read(rules)
  const names = read(ruleColumns)
  const frozen = read(rulesSaving)
  const incomplete = list.some(row => row.branch.trim() !== '' && row.column === '')
  return (
    <Stack gap="sm">
      {list.map((row, index) => (
        <Row key={row.id} align="end" gap="sm">
          <Box grow shrink minWidth={0}>
            <Input
              label="Branch"
              labelHidden={index > 0}
              placeholder="uat"
              value={row.branch}
              disabled={frozen}
              onChange={branch => editRule(row.id, { branch })}
            />
          </Box>
          <Box grow shrink minWidth={0}>
            <Select
              label="Column"
              labelHidden={index > 0}
              placeholder="Choose a column"
              options={names.map(name => ({ value: name, label: name }))}
              value={row.column}
              disabled={frozen}
              onChange={column => editRule(row.id, { column })}
            />
          </Box>
          <IconButton icon="remove" label="Remove rule" variant="ghost" size="sm" disabled={frozen} onPress={() => removeRule(row.id)} />
        </Row>
      ))}
      <Row gap="sm" wrap>
        <Button variant="outline" disabled={frozen || list.length >= MAX_NUDGE_RULES} onPress={addRule}>
          Add rule
        </Button>
        <Button disabled={frozen || incomplete} onPress={() => void saveRules(org, team)}>
          Save rules
        </Button>
      </Row>
      {frozen ? <Spinner label="Saving rules…" /> : null}
    </Stack>
  )
}

export function SuggestMoves({ org }: { org: OrgStatus }): OrcaNode {
  const team = org.boards?.teamId
  if (!team) return null
  const status = read(rulesLoad)
  const error = read(rulesError)
  return (
    <Collapsible title="Suggest moves" open={read(rulesOpen)} onChange={open => toggleRules(org.org, team, open)}>
      <Stack gap="sm">
        <Text muted size="xs">
          When a linked PR merges into this branch, suggest moving the item to this column.
        </Text>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {status === 'loading' ? <Skeleton lines={2} label="Loading rules" /> : null}
        {status === 'failed' ? (
          <Row gap="sm">
            <Button variant="outline" onPress={() => void loadRules(org.org, team)}>
              Try again
            </Button>
          </Row>
        ) : null}
        {status === 'ready' ? <RuleRows org={org.org} team={team} /> : null}
      </Stack>
    </Collapsible>
  )
}
