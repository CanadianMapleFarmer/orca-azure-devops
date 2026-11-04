import {
  atom,
  Button,
  Callout,
  Checkbox,
  Heading,
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
  type OrcaNode
} from 'orca'
import type { OrgStatus } from '../shared/types'
import { actionError, busy, LONG_WAIT, messageOf, view, type Busy } from './state'

type Named = { id: string; name: string }

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

let generation = 0

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
  set(view, 'settings')
  if (org.state === 'connected') void loadProjects(org.org, generation)
}

export function syncSettings(list: readonly OrgStatus[]): void {
  if (read(view) !== 'settings') return
  const target = list.find(item => item.org === read(settingsOrg))
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
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {org.state === 'connected' ? <Targets org={org.org} /> : null}
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
