import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  CloneProject,
  CloneTarget,
  CloneTargets,
  ItemWorkspace,
  RepoPick,
  StartAgentResult,
  StartRefused,
  StartRepos,
  StartWorkResult,
  WorkItemDetails,
  WorkspaceRef
} from '../../src/shared/work'
import { CODE_REPOS_KEY, isUnlisted, type CodeRepos } from '../ado/code-projects'
import { branchName } from '../ado/pr-links'
import type { PrRef } from '../ado/workitems'
import type { BoardRef } from '../boards/board-views'
import type { OrgEntities } from '../data/entities'
import type { RepoRecord } from '../data/records'
import {
  AGENT_STARTING,
  BAD_AGENT,
  CLONE_FOLDER_SETTING,
  CLONE_GONE,
  CLONE_NAME_UNSAFE,
  CLONE_RELOAD,
  CLONE_URL_UNSAFE,
  cloneFolderNotYours,
  cloneFolderTaken,
  cloneRootUnsafe,
  COMMAND_TOO_LONG,
  LINK_NOT_SAVED,
  NO_GIT,
  NO_ITEM_WORKSPACE,
  NO_TERMINAL_HOME,
  PROMPT_NOT_SAVED,
  REPO_GONE,
  REPOS_UNLISTED,
  START_FILES_NOT_REMOVED,
  stillCloning,
  STILL_CREATING,
  TERMINAL_REFUSED
} from '../messages'
import { carriesContext, itemPrompt, shortPrompt } from './agents'
import { branchFor } from './arm'
import { cloneRoot, cloneUrlOf, folderKey, folderNameOf, folderState, prefersSsh, readyRoot, rootProblem, shownPath, type FolderDeps, type RootDeps } from './clone'
import { cloneCommand, createCommand, launchCommand, NEW_REPO_SETUP, PATH_CONTROL, validAgent, type StartCommand } from './command'
import { focusedWorkspace, isLocalWorkspace, listWorkspaces, type HostCall, type WorkspaceEntry } from './focused'
import type { LinkStore } from './links'
import { CLONE_CLAIM_MS, onItemBranch, PENDING_MS, type PendingLinks } from './pending'
import { sameRepo, type AdoRepo, type RemoteSets } from './remotes'
import { adoKey, defaultRepo, localRepos, prRepos, rankRepos, type LocalRepo } from './repo-candidates'
import { projectOf, runIn, type ChoiceScope, type RepoChoices } from './repo-for-item'
import { unsupportedShell, type ShellHost } from './shell'
import { START_FILE_MS, type StartFiles } from './start-files'

export interface StartDeps {
  call: HostCall
  remoteSets: RemoteSets
  log: (message: string) => void
  shell: ShellHost
  links: LinkStore
  pending: PendingLinks
  choices: RepoChoices
  item: (org: string, id: number) => Promise<{ id: number; title: string }>
  details: (org: string, id: number, board?: BoardRef) => Promise<WorkItemDetails>
  prRefs: (org: string, id: number) => PrRef[]
  tables: (org: string) => Pick<OrgEntities, 'codeRepos' | 'prs'>
  team: (org: string) => Promise<string | null>
  cloneFolder: () => string
  home: string
  hasGit: boolean
  root: RootDeps
  codeRepos: (org: string) => CodeRepos
  folders: FolderDeps
  now: () => number
  defaultAgent: () => string
  branchTemplate: () => string
  disarm: () => void
  files: StartFiles
  later: (ms: number, run: () => void) => void
}

type ItemInput = { org: string; id: number }
type StartInput = ItemInput & { board?: BoardRef }
type WorkInput = StartInput & { repo?: RepoPick }
type Starting = Map<string, 'work' | 'agent'>

interface Candidates { local: LocalRepo[]; repos: StartRepos; scope: ChoiceScope }

interface Start { org: string; id: number; details: WorkItemDetails; listed: WorkspaceEntry[]; scope: ChoiceScope }

interface Hold { repo: string; itemId: number; at: number; sent: boolean; done: boolean }

interface Gone { gone: string }

type Holds = Map<string, Hold>

interface Reserved {
  record: RepoRecord
  name: string
  root: string
  prior: Hold | null
  keep(): void
  settle(): void
  letGo(): void
}

export const MAX_CLONE_REPOS = 5_000

const REFUSED_TERMINAL_CODES: ReadonlySet<unknown> = new Set(['capability_denied', 'not_permitted', 'consent_required'])

export function registerStartHandlers(orca: OrcaWorkerApi, deps: StartDeps): void {
  orca.panels.handle('work.itemWorkspace', input => itemWorkspace(deps, input))
  orca.panels.handle('work.startRepos', input => startRepos(deps, input))
  orca.panels.handle('work.cloneTargets', input => cloneTargets(deps, input))
  const sweep = sweeper(deps)
  const starting: Starting = new Map()
  const holds: Holds = new Map()
  orca.panels.handle('work.startWork', input => {
    sweep()
    return exclusively(deps, starting, input, 'work', () => startWork(deps, holds, input))
  })
  orca.panels.handle('work.startAgent', input => {
    sweep()
    return exclusively(deps, starting, input, 'agent', () => startAgent(deps, input))
  })
  orca.panels.handle('work.openWorkspace', async ({ workspaceId }) => {
    await deps.call('workspace.open', { workspaceId })
    return { opened: true as const }
  })
  sweep()
  orca.hooks.on('agent.prompt.before', event => {
    if (event.inputKind === 'launch') deps.pending.tie(event.terminalId, ref => carriesContext(event.prompt, ref.itemId))
  })
  orca.events.on('agent.status.changed', status => {
    const ref = status.state === 'working' && status.terminalId ? deps.pending.working(status.terminalId) : null
    if (ref) orca.panels.post('work.agentWorking', ref)
  })
}

async function itemWorkspace(deps: StartDeps, { org, id }: ItemInput): Promise<ItemWorkspace> {
  const found = await workspaceOfItem(deps, await listWorkspaces(deps.call), { org, id }, () => deps.item(org, id))
  return { workspace: found && refOf(found), unsupported: unsupportedShell(deps.shell) }
}

async function exclusively<T>(deps: StartDeps, starting: Starting, item: ItemInput, kind: 'work' | 'agent', start: () => Promise<T>): Promise<T | StartRefused> {
  const key = `${item.org}/${item.id}`
  const refused = refusal(deps, item, starting.get(key))
  if (refused) return refused
  starting.set(key, kind)
  try {
    return await start()
  } finally {
    starting.delete(key)
  }
}

async function startRepos(deps: StartDeps, input: StartInput): Promise<StartRepos> {
  const details = await deps.details(input.org, input.id, input.board)
  return (await candidatesOf(deps, input, details, await listWorkspaces(deps.call))).repos
}

async function candidatesOf(deps: StartDeps, { org, id, board }: StartInput, details: WorkItemDetails, listed: WorkspaceEntry[]): Promise<Candidates> {
  const scope = { org, teamId: board?.teamId ?? (await deps.team(org)), project: projectOf(details.item.url) }
  const local = await localRepos(deps, listed)
  const ranked = rankRepos({ org, local, prs: prRepos(org, deps.prRefs(org, id), deps.tables(org)), remembered: deps.choices.chosen(scope) })
  return { local, scope, repos: { repos: ranked, selected: defaultRepo(ranked), clone: await cloneState(deps, listed) } }
}

async function cloneState(deps: StartDeps, listed: WorkspaceEntry[]): Promise<StartRepos['clone']> {
  if (!deps.hasGit) return { problem: NO_GIT }
  if (!listed.some(isLocalWorkspace)) return { problem: NO_TERMINAL_HOME }
  const root = cloneRoot(deps.cloneFolder(), deps.home)
  if (root === null) return { problem: CLONE_FOLDER_SETTING }
  const problem = await rootProblem(deps.root, root)
  return problem === null ? { folder: shownPath(root, deps.home) } : { problem }
}

async function cloneTargets(deps: StartDeps, { org }: { org: string }): Promise<CloneTargets> {
  let records: RepoRecord[]
  try {
    records = await deps.codeRepos(org)()
  } catch (error) {
    throw isUnlisted(error) ? new Error(REPOS_UNLISTED) : error
  }
  const listed = records.filter(record => !record.disabled).sort(byProjectThenName)
  const projects = new Map<string, CloneProject>()
  for (const record of listed.slice(0, MAX_CLONE_REPOS)) {
    const project = projects.get(record.projectId) ?? { id: record.projectId, name: record.projectName, repos: [] }
    project.repos.push({ id: record.id, name: record.name })
    projects.set(record.projectId, project)
  }
  const readAt = deps.tables(org).codeRepos.get(CODE_REPOS_KEY)?.at ?? 0
  return { projects: [...projects.values()], readAt, more: Math.max(0, listed.length - MAX_CLONE_REPOS) }
}

async function startWork(deps: StartDeps, holds: Holds, input: WorkInput): Promise<StartWorkResult> {
  if (input.repo?.kind !== 'clone') return startPicked(deps, input, null)
  const clone = reserveClone(deps, holds, input, input.repo)
  if ('status' in clone) return clone
  try {
    return await startPicked(deps, input, clone)
  } finally {
    if ('settle' in clone) clone.settle()
  }
}

async function startPicked(deps: StartDeps, input: WorkInput, clone: Reserved | Gone | null): Promise<StartWorkResult> {
  const { org, id, repo } = input
  const details = await deps.details(org, id, input.board)
  const listed = await listWorkspaces(deps.call)
  const existing = await workspaceOfItem(deps, listed, { org, id }, async () => details.item)
  if (existing) return { status: 'linked', branch: branchName(existing.branch ?? ''), workspace: refOf(existing) }

  const { local, repos, scope } = await candidatesOf(deps, input, details, listed)
  if (clone && 'gone' in clone) return { status: 'choose-repo', repos, message: clone.gone }
  const start = { org, id, details, listed, scope }
  if (clone) return startClone(deps, start, local, clone)
  const key = repo?.kind === 'orca' ? repo.key : repos.selected
  const picked = local.find(each => each.key === key)
  if (!picked) return { status: 'choose-repo', repos, message: repo?.kind === 'orca' ? REPO_GONE : null }
  return startInRepo(deps, start, picked)
}

async function startInRepo(deps: StartDeps, start: Start, picked: LocalRepo): Promise<StartWorkResult> {
  await deps.choices.choose(start.scope, picked.key)
  const branch = branchFor(deps.branchTemplate(), start.details.item)
  const agent = deps.defaultAgent()
  const built = createCommand({ fileId: deps.files.id(), branch, agent, prompts: promptsOf(start.details) })
  if (!built) return refuse(COMMAND_TOO_LONG, 'danger')
  const target = runIn(picked, (await focusedWorkspace(deps.call, start.listed))?.id ?? null)
  const blocked = await send(deps, start, built, target, branch)
  return blocked ?? { status: 'sent', branch, repo: picked.name, agent, workspace: refOf(target), shortened: built.shortened, clone: null }
}

function reserveClone(deps: StartDeps, holds: Holds, { org, id }: ItemInput, pick: CloneTarget): Reserved | StartRefused | Gone {
  if (!deps.hasGit) return refuse(NO_GIT, 'danger')
  const records = deps.tables(org).codeRepos.get(CODE_REPOS_KEY)?.value
  if (!records) return { gone: CLONE_RELOAD }
  const record = records.find(each => each.projectId === pick.projectId && each.id === pick.repoId && !each.disabled)
  if (!record) return { gone: CLONE_GONE }
  const name = folderNameOf(record.name)
  if (name === null) return refuse(CLONE_NAME_UNSAFE, 'danger')
  const root = cloneRoot(deps.cloneFolder(), deps.home)
  if (root === null) return refuse(CLONE_FOLDER_SETTING, 'danger')

  const key = folderKey(path.join(root, name))
  const now = deps.now()
  const held = holds.get(key)
  const prior = held && (!held.sent || now - held.at <= CLONE_CLAIM_MS) ? held : null
  if (prior && (!prior.sent || now - prior.at <= PENDING_MS)) return refuse(stillCloning(prior.repo, prior.itemId), 'warning')
  const hold: Hold = { repo: record.name, itemId: id, at: now, sent: false, done: false }
  holds.set(key, hold)
  const letGo = () => {
    hold.done = true
    if (holds.get(key) === hold) holds.delete(key)
  }
  return {
    record,
    name,
    root,
    prior,
    keep: () => {
      hold.sent = true
      hold.at = deps.now()
    },
    settle: () => {
      if (hold.sent) return
      letGo()
      if (prior && !prior.done) holds.set(key, prior)
    },
    letGo
  }
}

async function startClone(deps: StartDeps, start: Start, local: LocalRepo[], clone: Reserved): Promise<StartWorkResult> {
  const { record } = clone
  const target: AdoRepo = { org: start.org, project: record.projectName, repo: record.name }
  const known = local.find(repo => repo.ado.some(remote => sameRepo(remote, target)))
  if (known) return startInRepo(deps, start, known)
  const homes = start.listed.filter(isLocalWorkspace)
  if (homes.length === 0) return refuse(NO_TERMINAL_HOME, 'warning')

  const ready = await readyRoot(deps.root, clone.root)
  if ('problem' in ready) return refuse(ready.problem, 'danger')
  const folder = path.join(ready.root, clone.name)
  if (PATH_CONTROL.test(folder)) return refuse(cloneRootUnsafe(clone.root), 'danger')
  if (clone.prior && (await present(deps.folders, folder))) return refuse(stillCloning(clone.prior.repo, clone.prior.itemId), 'warning')
  const inOrca = await repoAt(deps.folders, local, folder)
  if (inOrca) return startInRepo(deps, start, inOrca)

  const shown = shownPath(folder, deps.home)
  const state = await folderState(deps.folders, folder, target)
  if (state === 'not-yours') return refuse(cloneFolderNotYours(shown), 'warning')
  if (state === 'taken') return refuse(cloneFolderTaken(shown, record.name), 'warning')
  const fresh = state === 'absent'
  const url = fresh ? cloneUrlOf(start.org, record, prefersSsh(start.org, local)) : null
  if (fresh && url === null) return refuse(CLONE_URL_UNSAFE, 'danger')

  await deps.choices.choose(start.scope, adoKey(target))
  const branch = branchFor(deps.branchTemplate(), start.details.item)
  const agent = deps.defaultAgent()
  const built = cloneCommand({ fileId: deps.files.id(), url, folder, branch, agent, prompts: promptsOf(start.details) })
  if (!built) return refuse(COMMAND_TOO_LONG, 'danger')
  const home = runIn({ workspaces: homes }, (await focusedWorkspace(deps.call, start.listed))?.id ?? null)
  const blocked = await send(deps, start, built, home, branch, clone)
  if (blocked) return blocked
  clone.keep()
  return {
    status: 'sent',
    branch,
    repo: record.name,
    agent,
    workspace: refOf(home),
    shortened: built.shortened,
    clone: { folder: shown, fresh, setupSkipped: NEW_REPO_SETUP === 'skip' }
  }
}

async function send(deps: StartDeps, { org, id }: Start, built: StartCommand, target: WorkspaceEntry, branch: string, clone?: Reserved): Promise<StartRefused | null> {
  const files = await savedFiles(deps, built)
  if (!files) return refuse(PROMPT_NOT_SAVED, 'danger')
  const release = clone
    ? () => {
        files()
        clone.letGo()
      }
    : files
  deps.pending.expect({ org, itemId: id, branch, release, claimMs: clone ? CLONE_CLAIM_MS : undefined })
  const blocked = await openTerminal(deps, target.id, id, built, () => deps.pending.forget({ org, itemId: id }))
  if (blocked) return blocked
  deps.disarm()
  deps.pending.expectAgent({ org, itemId: id })
  return null
}

async function startAgent(deps: StartDeps, { org, id }: ItemInput): Promise<StartAgentResult> {
  const target = await workspaceOfItem(deps, await listWorkspaces(deps.call), { org, id }, () => deps.item(org, id))
  if (!target) return refuse(NO_ITEM_WORKSPACE, 'warning')
  const agent = deps.defaultAgent()
  const built = launchCommand({ fileId: deps.files.id(), workspaceId: target.id, agent, prompts: promptsOf(await deps.details(org, id)) })
  if (!built) return refuse(COMMAND_TOO_LONG, 'danger')
  const release = await savedFiles(deps, built)
  if (!release) return refuse(PROMPT_NOT_SAVED, 'danger')
  const blocked = await openTerminal(deps, target.id, id, built, release)
  if (blocked) return blocked
  deps.pending.expectAgent({ org, itemId: id })
  return { status: 'sent', agent, workspace: refOf(target), shortened: built.shortened }
}

async function workspaceOfItem(
  deps: StartDeps,
  listed: WorkspaceEntry[],
  { org, id }: ItemInput,
  item: () => Promise<{ id: number; title: string }>
): Promise<WorkspaceEntry | null> {
  const local = listed.filter(isLocalWorkspace)
  const linkedId = deps.links.byItem(org, id)
  const linked = local.find(entry => entry.id === linkedId)
  if (linked) return linked

  const branch = branchFor(deps.branchTemplate(), await item())
  const free = (entry: WorkspaceEntry) => {
    const owner = deps.links.byWorkspace(entry.id)
    return owner === null || (owner.org === org && owner.itemId === id)
  }
  const onBranch = local.filter(entry => entry.kind === 'worktree' && free(entry) && onItemBranch(entry.branch, branch))
  const found = onBranch.find(entry => branchName(entry.branch ?? '') === branch) ?? onBranch[0]
  if (!found) return null
  await deps.links.link(found.id, { org, itemId: id }).catch(() => deps.log(LINK_NOT_SAVED))
  return found
}

function refusal(deps: StartDeps, { org, id }: ItemInput, busy: 'work' | 'agent' | undefined): StartRefused | null {
  const unsupported = unsupportedShell(deps.shell)
  if (unsupported) return refuse(unsupported, 'warning')
  if (!validAgent(deps.defaultAgent())) return refuse(BAD_AGENT, 'danger')
  if (busy === 'agent') return refuse(AGENT_STARTING, 'warning')
  return busy === 'work' || deps.pending.expecting({ org, itemId: id }) ? refuse(STILL_CREATING, 'warning') : null
}

function sweeper(deps: StartDeps): () => void {
  let waiting = false
  const sweep = () => {
    deps.files
      .sweep()
      .then(kept => {
        if (kept === 0 || waiting) return
        waiting = true
        deps.later(START_FILE_MS, () => {
          waiting = false
          sweep()
        })
      })
      .catch(() => deps.log(START_FILES_NOT_REMOVED))
  }
  return sweep
}

async function savedFiles(deps: StartDeps, built: StartCommand): Promise<(() => void) | null> {
  const names = Object.keys(built.files)
  let released = false
  const release = () => {
    if (released) return
    released = true
    deps.files.remove(names).catch(() => deps.log(START_FILES_NOT_REMOVED))
  }
  try {
    await deps.files.write(built.files)
  } catch {
    release()
    return null
  }
  deps.later(START_FILE_MS, release)
  return release
}

async function openTerminal(deps: StartDeps, workspaceId: string, itemId: number, built: StartCommand, abandon: () => void): Promise<StartRefused | null> {
  try {
    await deps.call('terminal.create', { workspaceId, title: `ADO #${itemId}`, command: built.command })
    return null
  } catch (error) {
    abandon()
    if (REFUSED_TERMINAL_CODES.has((error as { code?: unknown } | null)?.code)) return refuse(TERMINAL_REFUSED, 'danger')
    throw error
  }
}

async function present({ fs }: FolderDeps, folder: string): Promise<boolean> {
  try {
    return !(await fs.lstat(folder)).isDirectory() || (await fs.readdir(folder)).length > 0
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
}

async function repoAt(folders: FolderDeps, local: LocalRepo[], folder: string): Promise<LocalRepo | null> {
  const real = await realOf(folders, folder)
  if (real === null) return null
  const matches = await Promise.all(local.map(async repo => (await Promise.all(repo.workspaces.map(entry => realOf(folders, entry.path)))).includes(real)))
  return local[matches.indexOf(true)] ?? null
}

function realOf(folders: FolderDeps, target: string): Promise<string | null> {
  return folders.fs.realpath(target).catch(() => null)
}

function byProjectThenName(a: RepoRecord, b: RepoRecord): number {
  return compareNames(a.projectName, b.projectName) || a.projectId.localeCompare(b.projectId) || compareNames(a.name, b.name)
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function promptsOf(details: WorkItemDetails) {
  return { full: itemPrompt(details), short: shortPrompt(details) }
}

function refOf(entry: WorkspaceEntry): WorkspaceRef {
  return { id: entry.id, name: entry.name }
}

function refuse(message: string, tone: StartRefused['tone']): StartRefused {
  return { status: 'refused', message, tone }
}
