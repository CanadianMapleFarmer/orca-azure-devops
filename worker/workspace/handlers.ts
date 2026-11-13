import type { OrcaWorkerApi } from 'orca/worker'
import type { CodeRepos } from '../ado/code-projects'
import type { BoardsService } from '../boards/service'
import type { StorePort } from '../connections'
import type { Entities } from '../data/entities'
import { createContextCache } from './agents'
import type { Arm } from './arm'
import type { FolderDeps, RootDeps } from './clone'
import type { HostCall } from './focused'
import { registerWorkspaceHooks } from './hooks'
import { createLinkStore } from './links'
import { createPendingLinks } from './pending'
import type { RemoteSets } from './remotes'
import { createRepoChoices } from './repo-for-item'
import { watchWorkspaceSettings } from './settings'
import type { ShellHost } from './shell'
import { registerStartHandlers } from './start'
import type { StartFiles } from './start-files'

export interface WorkspaceHandlerDeps {
  boards: BoardsService
  store: StorePort
  call: HostCall
  arm: Arm
  remoteSets: RemoteSets
  entities: Entities
  team: (org: string) => Promise<string | null>
  home: string
  hasGit: boolean
  root: RootDeps
  codeRepos: (org: string) => CodeRepos
  folders: FolderDeps
  shell: ShellHost
  log: (message: string) => void
  files: StartFiles
  later: (ms: number, run: () => void) => void
}

export async function registerWorkspaceHandlers(
  orca: OrcaWorkerApi,
  { boards, store, call, arm, remoteSets, entities, team, home, hasGit, root, codeRepos, folders, shell, log, files, later }: WorkspaceHandlerDeps
): Promise<void> {
  const settings = await watchWorkspaceSettings(orca.settings, message => orca.log(message))
  const links = await createLinkStore(store, Date.now)
  const context = createContextCache()
  const pending = createPendingLinks(Date.now)
  registerWorkspaceHooks(orca, {
    arm,
    links,
    pending,
    context,
    itemInfo: (org, itemId, signal) => boards.itemInfo(org, itemId, signal),
    timeout: ms => AbortSignal.timeout(ms),
    agentContext: settings.agentContext
  })

  orca.panels.handle('work.cancelWorkspace', input => {
    arm.disarm(input?.org === undefined ? undefined : input)
    return { ok: true as const }
  })
  registerStartHandlers(orca, {
    call,
    remoteSets,
    log,
    shell,
    links,
    pending,
    choices: await createRepoChoices(store),
    item: async (org, id) => boards.cachedItem(org, id) ?? (await boards.details(org, id, { comments: false })).item,
    details: (org, id, board) => boards.details(org, id, { comments: false, board }),
    prRefs: (org, id) => boards.prRefs(org, id),
    tables: org => entities.of(org),
    team,
    cloneFolder: settings.cloneFolder,
    home,
    hasGit,
    root,
    codeRepos,
    folders,
    now: Date.now,
    defaultAgent: settings.defaultAgent,
    branchTemplate: settings.branchTemplate,
    disarm: () => arm.disarm(),
    files,
    later
  })
}
