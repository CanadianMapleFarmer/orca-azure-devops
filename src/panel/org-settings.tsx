import {
  atom,
  Box,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Text,
  update,
  type OrcaNode
} from 'orca'
import { NO_BOARDS } from '../shared/messages'
import type { OrgStatus } from '../shared/types'
import { MAX_NUDGE_RULES } from '../shared/work'
import { actionError, busy, LONG_WAIT, messageOf, view, type Busy } from './state'
import { snapshot as workSnapshot } from './work/state'

type Named = { id: string; name: string }
type Rule = { branch: string; column: string }
type RuleRow = Rule & { id: number }
type RulesLoad = 'idle' | 'loading' | 'ready' | 'failed'

const MAX_LISTED = 500
const WORKING: Record<Exclude<Busy, null>, string> = {
  'sign-out': 'Signing out…',
  remove: 'Removing…',
  cancel: 'Cancelling…'
}

export const settingsOrg = atom<string | null>(null)
const projects = atom<Named[]>([])
const teams = atom<Named[]>([])
const projectId = atom<string | null>(null)
const teamId = atom<string | null>(null)
const allCode = atom(true)
const codeIds = atom<string[]>([])
const loadedFor = atom<string | null>(null)
const loadingProjects = atom(false)
const loadingTeams = atom(false)
const saving = atom(false)
const confirmingRemove = atom(false)
const rulesTeam = atom<string | null>(null)
const rulesOpen = atom(false)
const rulesLoad = atom<RulesLoad>('idle')
const rules = atom<RuleRow[]>([])
const ruleColumns = atom<string[]>([])
const rulesError = atom<string | null>(null)
const rulesSaving = atom(false)

let generation = 0
let rulesRun = 0
let lastRuleId = 0

async function loadTeams(org: string, project: string, current: number): Promise<void> {
  set(loadingTeams, true)
  try {
    const list = await plugin.request('ado.teams', { org, projectId: project })
    if (current === generation) set(teams, list)
  } catch (error) {
    if (current === generation) set(actionError, messageOf(error))
  } finally {
    if (current === generation) set(loadingTeams, false)
  }
}

async function loadProjects(org: string, current: number): Promise<void> {
  set(loadedFor, org)
  set(loadingProjects, true)
  try {
    const list = await plugin.request('ado.projects', { org })
    if (current !== generation) return
    set(projects, list)
    const saved = read(projectId)
    if (saved) void loadTeams(org, saved, current)
  } catch (error) {
    if (current === generation) set(actionError, messageOf(error))
  } finally {
    if (current === generation) set(loadingProjects, false)
  }
}

function resetRules(team: string | null): void {
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

export function openSettings(org: OrgStatus): void {
  generation += 1
  const saved = org.codeProjects
  set(actionError, null)
  set(settingsOrg, org.org)
  set(projects, [])
  set(teams, [])
  set(projectId, org.boards?.projectId ?? null)
  set(teamId, org.boards?.teamId ?? null)
  set(allCode, saved === 'all')
  set(codeIds, saved === 'all' ? [] : saved.map(project => project.id))
  set(loadedFor, null)
  set(loadingProjects, false)
  set(loadingTeams, false)
  set(saving, false)
  set(confirmingRemove, false)
  resetRules(org.boards?.teamId ?? null)
  set(view, 'settings')
  if (org.state === 'connected') void loadProjects(org.org, generation)
}

export function syncSettings(list: readonly OrgStatus[]): void {
  if (read(view) !== 'settings') return
  const target = list.find(item => item.org === read(settingsOrg))
  if (target && (target.boards?.teamId ?? null) !== read(rulesTeam)) resetRules(target.boards?.teamId ?? null)
  if (target?.state === 'connected' && read(loadedFor) !== target.org) void loadProjects(target.org, generation)
}

function leaveSettings(): void {
  generation += 1
  set(actionError, null)
  set(confirmingRemove, false)
  set(view, 'hub')
}

async function save(run: () => Promise<unknown>): Promise<void> {
  set(saving, true)
  set(actionError, null)
  try {
    await run()
  } catch (error) {
    set(actionError, messageOf(error))
  } finally {
    set(saving, false)
  }
}

function pickProject(org: string, id: string): void {
  generation += 1
  set(projectId, id)
  set(teamId, null)
  set(teams, [])
  set(actionError, null)
  void loadTeams(org, id, generation)
}

function pickTeam(org: string, id: string): void {
  const project = read(projectId)
  if (!project) return
  set(teamId, id)
  void save(() => plugin.request('orgs.setBoards', { org, projectId: project, teamId: id }))
}

function setAllCode(org: string, on: boolean): void {
  set(allCode, on)
  if (!on) return
  set(codeIds, [])
  void save(() => plugin.request('orgs.setCodeProjects', { org, projects: 'all' }))
}

function tickCodeProject(org: string, id: string, on: boolean): void {
  const next = on ? [...read(codeIds), id] : read(codeIds).filter(item => item !== id)
  set(codeIds, next)
  if (next.length > 0) void save(() => plugin.request('orgs.setCodeProjects', { org, projects: next }))
}

async function leaveAfter(kind: Exclude<Busy, null>, run: () => Promise<unknown>): Promise<void> {
  set(busy, kind)
  set(actionError, null)
  try {
    await run()
    generation += 1
    set(view, 'hub')
  } catch (error) {
    set(actionError, messageOf(error))
  } finally {
    set(busy, null)
    set(confirmingRemove, false)
  }
}

export const signOut = (org: string): Promise<void> =>
  leaveAfter('sign-out', () => plugin.request('orgs.signOut', { org }, LONG_WAIT))

export const cancelSignIn = (org: string): Promise<void> =>
  leaveAfter('cancel', () => plugin.request('orgs.cancel', { org }, LONG_WAIT))

const removeOrg = (org: string): Promise<void> => leaveAfter('remove', () => plugin.request('orgs.remove', { org }, LONG_WAIT))

function CapNote({ total }: { total: number }): OrcaNode {
  return total > MAX_LISTED ? (
    <Text muted size="xs">
      {`Showing the first ${MAX_LISTED}.`}
    </Text>
  ) : null
}

function Targets({ org }: { org: string }): OrcaNode {
  if (read(loadingProjects)) return <Skeleton lines={4} label="Loading projects" />
  const list = read(projects)
  if (list.length === 0) return null
  const project = read(projectId)
  const all = read(allCode)
  const chosen = read(codeIds)
  const frozen = read(saving)
  const teamsLoading = read(loadingTeams)
  const teamList = read(teams)
  return (
    <Stack gap="md">
      <Select
        label="Boards project"
        placeholder="Choose a project"
        options={list.slice(0, MAX_LISTED).map(item => ({ value: item.id, label: item.name }))}
        value={project ?? ''}
        disabled={frozen}
        onChange={id => pickProject(org, id)}
      />
      <CapNote total={list.length} />
      <Select
        label="Team"
        placeholder="Choose a team"
        options={teamList.slice(0, MAX_LISTED).map(item => ({ value: item.id, label: item.name }))}
        value={read(teamId) ?? ''}
        disabled={!project || teamsLoading || frozen}
        onChange={id => pickTeam(org, id)}
      />
      <CapNote total={teamList.length} />
      {teamsLoading ? <Spinner label="Loading teams…" /> : null}
      <Separator />
      <Switch label="All projects with code" checked={all} disabled={frozen} onChange={on => setAllCode(org, on)} />
      {all ? null : (
        <Stack gap="xs">
          {list.slice(0, MAX_LISTED).map(item => (
            <Checkbox
              key={item.id}
              label={item.name}
              checked={chosen.includes(item.id)}
              disabled={frozen}
              onChange={on => tickCodeProject(org, item.id, on)}
            />
          ))}
          <CapNote total={list.length} />
          {chosen.length === 0 ? (
            <Text muted size="xs">
              Pick at least one project. Nothing is saved until you do.
            </Text>
          ) : null}
        </Stack>
      )}
      {frozen ? <Spinner label="Saving…" /> : null}
    </Stack>
  )
}

function RuleRows({ org, team }: { org: string; team: string }): OrcaNode {
  const list = read(rules)
  const names = read(ruleColumns)
  const frozen = read(rulesSaving)
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
        <Button disabled={frozen} onPress={() => void saveRules(org, team)}>
          Save rules
        </Button>
      </Row>
      {frozen ? <Spinner label="Saving rules…" /> : null}
    </Stack>
  )
}

function SuggestMoves({ org }: { org: OrgStatus }): OrcaNode {
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

export function OrgSettings({ org }: { org: OrgStatus }): OrcaNode {
  const working = read(busy)
  const error = read(actionError)
  const confirming = read(confirmingRemove)
  return (
    <Stack gap="md">
      <Row align="center" gap="sm">
        <Button variant="ghost" size="sm" onPress={leaveSettings}>
          Back
        </Button>
        <Heading level={3}>{`${org.org} settings`}</Heading>
      </Row>
      <Text muted size="sm">
        {org.tokenStore.kind === 'az-profile' ? `Tokens: ${org.tokenStore.path}` : "Tokens: Orca's encrypted secrets"}
      </Text>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {org.state === 'connected' ? <Targets org={org.org} /> : null}
      {org.state === 'connected' ? <SuggestMoves org={org} /> : null}
      <Separator />
      {working ? <Spinner label={WORKING[working]} /> : null}
      <Row gap="sm" wrap>
        <Button tone="danger" disabled={working !== null} onPress={() => signOut(org.org)}>
          Sign out
        </Button>
        {confirming ? (
          <Row gap="sm">
            <Button tone="danger" disabled={working !== null} onPress={() => removeOrg(org.org)}>
              Confirm remove
            </Button>
            <Button variant="ghost" disabled={working !== null} onPress={() => set(confirmingRemove, false)}>
              Cancel
            </Button>
          </Row>
        ) : (
          <Button variant="outline" disabled={working !== null} onPress={() => set(confirmingRemove, true)}>
            Remove organization
          </Button>
        )}
      </Row>
    </Stack>
  )
}
