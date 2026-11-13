import { atom, Button, Callout, Link, plugin, read, Row, Select, set, Stack, Text, update, type OrcaNode } from 'orca'
import {
  changeRepo,
  chooseCloneRepo,
  chooseProject,
  chooseRepo,
  CLONE_VALUE,
  cloneNote,
  cloneRepoOptions,
  lateNotice,
  pickerOf,
  pickOf,
  projectOptions,
  readyNotice,
  REPO_LABELS,
  repoOptions,
  repoSummary,
  SETUP_SKIPPED,
  SHORTENED,
  START_LABELS,
  startAgentOutcome,
  startWorkOutcome,
  withTargets,
  workingNotice,
  type Picker,
  type StartNotice as Notice,
  type StartOutcome,
  type Waiting as Awaiting
} from '../../shared/start-flow'
import type { CloneTargets, WorkItemSummary, WorkspaceRef } from '../../shared/work'
import { LONG_WAIT, messageOf } from '../state'
import { openItem } from './state'

type Lookup = { status: 'loading' } | { status: 'ready'; workspace: WorkspaceRef | null; unsupported: string | null }
type Waiting = Awaiting & { org: string; id: number; answered: boolean }
type ClonePicker = Extract<Picker, { mode: 'clone' }>

const lookup = atom<Lookup>({ status: 'loading' })
const notice = atom<Notice | null>(null)
const shortened = atom(false)
const setupSkipped = atom(false)
const picker = atom<Picker | null>(null)
const busy = atom(false)
const waiting = atom<Waiting | null>(null)
let lateTimer: ReturnType<typeof setTimeout> | undefined

const isOpen = (org: string, id: number): boolean => {
  const open = read(openItem)
  return open?.org === org && open.id === id
}

const waitingFor = (org: string, id: number): Waiting | null => {
  const current = read(waiting)
  return current?.org === org && current.id === id && isOpen(org, id) ? current : null
}

function stopWaiting(): void {
  clearTimeout(lateTimer)
  set(waiting, null)
}

function waitFor(next: Waiting): void {
  stopWaiting()
  set(waiting, next)
  lateTimer = setTimeout(() => {
    if (read(waiting) !== next || !isOpen(next.org, next.id)) return
    set(waiting, { ...next, answered: true })
    set(notice, lateNotice(next.id, next))
  }, next.lateMs)
}

function linkWorkspace(workspace: WorkspaceRef): void {
  update(lookup, (current): Lookup => ({ status: 'ready', workspace, unsupported: current.status === 'ready' ? current.unsupported : null }))
}

export function resetStart(org: string, id: number): void {
  stopWaiting()
  set(lookup, { status: 'loading' })
  set(notice, null)
  set(shortened, false)
  set(setupSkipped, false)
  set(picker, null)
  set(busy, false)
  void lookUp(org, id)
}

async function lookUp(org: string, id: number): Promise<void> {
  try {
    const found = await plugin.request('work.itemWorkspace', { org, id })
    if (found.workspace === null && found.unsupported === null) await askRepos(org, id)
    if (isOpen(org, id)) update(lookup, (current): Lookup => (current.status === 'loading' ? { status: 'ready', ...found } : current))
  } catch {
    if (isOpen(org, id)) set(lookup, { status: 'ready', workspace: null, unsupported: null })
  }
}

async function askRepos(org: string, id: number): Promise<void> {
  const repos = await plugin.request('work.startRepos', { org, id }).catch(() => null)
  if (repos && isOpen(org, id) && read(picker) === null) showPicker(org, id, pickerOf(repos))
}

function showPicker(org: string, id: number, next: Picker): void {
  const current = read(picker)
  set(picker, next)
  if (next !== current && next.mode === 'clone' && next.targets === 'loading') void readTargets(org, id)
}

function changePicker(org: string, id: number, change: (current: Picker) => Picker): void {
  const current = read(picker)
  if (current) showPicker(org, id, change(current))
}

async function readTargets(org: string, id: number): Promise<void> {
  let targets: CloneTargets | { error: string }
  try {
    targets = await plugin.request('work.cloneTargets', { org })
  } catch (error) {
    targets = { error: messageOf(error) }
  }
  if (isOpen(org, id)) update(picker, current => current && withTargets(current, targets))
}

export function acceptWorkspaceReady({ org, itemId, workspaceId, branch }: { org: string; itemId: number; workspaceId: string; branch: string }): void {
  if (!isOpen(org, itemId)) return
  const workspace = { id: workspaceId, name: branch }
  linkWorkspace(workspace)
  const current = waitingFor(org, itemId)
  if (!current) return
  clearTimeout(lateTimer)
  set(waiting, { ...current, workspace, answered: true })
  set(notice, readyNotice(branch, current.agent))
}

export function acceptAgentWorking({ org, itemId }: { org: string; itemId: number }): void {
  const current = waitingFor(org, itemId)
  if (!current) return
  stopWaiting()
  set(notice, workingNotice(current.agent))
}

async function act(org: string, id: number, work: () => Promise<void>): Promise<void> {
  stopWaiting()
  set(busy, true)
  set(notice, null)
  set(shortened, false)
  set(setupSkipped, false)
  try {
    await work()
  } catch (error) {
    if (isOpen(org, id)) set(notice, { tone: 'danger', text: messageOf(error) })
  } finally {
    if (isOpen(org, id)) set(busy, false)
  }
}

function settle(org: string, id: number, outcome: StartOutcome): void {
  if (outcome.kind === 'choose') {
    showPicker(org, id, outcome.picker)
    if (outcome.message) set(notice, { tone: 'warning', text: outcome.message })
    return
  }
  if (outcome.linked) linkWorkspace(outcome.linked)
  set(notice, outcome.notice)
  set(shortened, outcome.shortened)
  set(setupSkipped, outcome.setupSkipped)
  if (outcome.waitFor) waitFor({ ...outcome.waitFor, org, id, answered: false })
}

function startWork(org: string, id: number): Promise<void> {
  const shown = read(picker)
  const repo = shown && pickOf(shown)
  return act(org, id, async () => {
    const result = await plugin.request('work.startWork', repo ? { org, id, repo } : { org, id }, LONG_WAIT)
    if (isOpen(org, id)) settle(org, id, startWorkOutcome(result))
  })
}

function startAgent(org: string, id: number): Promise<void> {
  return act(org, id, async () => {
    const result = await plugin.request('work.startAgent', { org, id }, LONG_WAIT)
    if (isOpen(org, id)) settle(org, id, startAgentOutcome(result))
  })
}

async function show(org: string, id: number, workspace: WorkspaceRef): Promise<void> {
  try {
    await plugin.request('work.openWorkspace', { workspaceId: workspace.id })
  } catch (error) {
    if (isOpen(org, id)) set(notice, { tone: 'danger', text: messageOf(error) })
  }
}

function CloneChoice({ org, id, shown, disabled }: { org: string; id: number; shown: ClonePicker; disabled: boolean }): OrcaNode {
  const intro = shown.repos.repos.length === 0 ? <Text size="sm" muted>{REPO_LABELS.noRepos}</Text> : null
  if (shown.targets === 'loading') {
    return (
      <>
        {intro}
        <Text size="sm" muted>
          {REPO_LABELS.reading}
        </Text>
      </>
    )
  }
  const note = cloneNote(shown)
  if ('error' in shown.targets) {
    return (
      <>
        {intro}
        <Callout tone="warning">{note}</Callout>
      </>
    )
  }
  return (
    <>
      {intro}
      <Select
        label={REPO_LABELS.project}
        value={shown.projectId ?? ''}
        placeholder={REPO_LABELS.chooseProject}
        options={projectOptions(shown)}
        disabled={disabled}
        onChange={projectId => changePicker(org, id, current => chooseProject(current, projectId))}
      />
      <Select
        label={REPO_LABELS.cloneRepo}
        value={shown.repoId ?? ''}
        placeholder={REPO_LABELS.choose}
        options={cloneRepoOptions(shown)}
        disabled={disabled || shown.projectId === null}
        onChange={repoId => changePicker(org, id, current => chooseCloneRepo(current, repoId))}
      />
      {note ? (
        <Text size="sm" muted>
          {note}
        </Text>
      ) : null}
    </>
  )
}

function RepoPicker({ org, id, disabled }: { org: string; id: number; disabled: boolean }): OrcaNode {
  const shown = read(picker)
  if (!shown) return null
  if (shown.mode === 'known') {
    return (
      <Stack gap="xs">
        <Text size="sm" muted>
          {REPO_LABELS.repo}
        </Text>
        <Text size="sm">{repoSummary(shown)}</Text>
        <Button size="sm" variant="outline" disabled={disabled} onPress={() => changePicker(org, id, changeRepo)}>
          {REPO_LABELS.change}
        </Button>
      </Stack>
    )
  }
  return (
    <Stack gap="xs">
      <Select
        label={REPO_LABELS.repo}
        value={shown.mode === 'clone' ? CLONE_VALUE : (shown.key ?? '')}
        placeholder={REPO_LABELS.choose}
        options={repoOptions(shown.repos)}
        disabled={disabled}
        onChange={value => changePicker(org, id, current => chooseRepo(current, value))}
      />
      {shown.mode === 'clone' ? <CloneChoice org={org} id={id} shown={shown} disabled={disabled} /> : null}
    </Stack>
  )
}

function StartNotice({ org, id }: { org: string; id: number }): OrcaNode {
  const shown = read(notice)
  const note = (
    <>
      {read(setupSkipped) ? <Callout tone="warning">{SETUP_SKIPPED}</Callout> : null}
      {read(shortened) ? <Callout tone="warning">{SHORTENED}</Callout> : null}
    </>
  )
  if (!shown) return note
  const { show: target } = shown
  const main = target ? (
    <Callout tone={shown.tone}>
      <Stack gap="xs">
        <Text size="sm">{shown.text}</Text>
        <Row gap="sm">
          <Button size="sm" variant="ghost" onPress={() => show(org, id, target)}>
            {START_LABELS.show}
          </Button>
        </Row>
      </Stack>
    </Callout>
  ) : (
    <Callout tone={shown.tone}>{shown.text}</Callout>
  )
  return (
    <Stack gap="xs">
      {main}
      {note}
    </Stack>
  )
}

export function StartSection({ org, item, disabled }: { org: string; item: WorkItemSummary; disabled: boolean }): OrcaNode {
  const found = read(lookup)
  const off = disabled || read(busy)
  const starting = off || waitingFor(org, item.id)?.answered === false
  const workspace = found.status === 'ready' ? found.workspace : null
  const unsupported = found.status === 'ready' ? found.unsupported : null
  const shown = read(picker)
  const unpicked = shown !== null && pickOf(shown) === null
  return (
    <Stack gap="xs">
      {workspace ? null : <RepoPicker org={org} id={item.id} disabled={starting} />}
      <Row gap="sm" align="center" wrap>
        {workspace ? (
          <>
            <Button disabled={starting || unsupported !== null} onPress={() => startAgent(org, item.id)}>
              {START_LABELS.agent}
            </Button>
            <Button variant="outline" disabled={off} onPress={() => show(org, item.id, workspace)}>
              {START_LABELS.workspace}
            </Button>
          </>
        ) : (
          <Button disabled={starting || found.status === 'loading' || unsupported !== null || unpicked} onPress={() => startWork(org, item.id)}>
            {START_LABELS.work}
          </Button>
        )}
        <Link href={item.url}>Open in Azure DevOps</Link>
      </Row>
      {unsupported ? (
        <Text size="sm" muted>
          {unsupported}
        </Text>
      ) : null}
      <StartNotice org={org} id={item.id} />
    </Stack>
  )
}
