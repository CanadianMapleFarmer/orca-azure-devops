import type { OrcaWorkerApi } from 'orca/worker'
import type { BoardsService } from '../boards/service'
import type { StorePort } from '../connections'
import { createContextCache, startAgent } from './agents'
import { branchFor, type Arm } from './arm'
import type { HostCall } from './focused'
import { registerWorkspaceHooks } from './hooks'
import { createLinkStore } from './links'
import { watchWorkspaceSettings } from './settings'

export interface WorkspaceHandlerDeps { boards: BoardsService; store: StorePort; call: HostCall; arm: Arm }

export async function registerWorkspaceHandlers(orca: OrcaWorkerApi, { boards, store, call, arm }: WorkspaceHandlerDeps): Promise<void> {
  const settings = await watchWorkspaceSettings(orca.settings, message => orca.log(message))
  const links = await createLinkStore(store, Date.now)
  const context = createContextCache()
  registerWorkspaceHooks(orca, {
    arm,
    links,
    context,
    itemInfo: (org, itemId, signal) => boards.itemInfo(org, itemId, signal),
    timeout: ms => AbortSignal.timeout(ms),
    agentContext: settings.agentContext
  })

  orca.panels.handle('work.startWorkspace', async ({ org, id }) => {
    const item = boards.cachedItem(org, id) ?? (await boards.details(org, id)).item
    const branch = branchFor(settings.branchTemplate(), item)
    return { branch, armedUntil: arm.arm({ org, itemId: id, branch }) }
  })
  orca.panels.handle('work.cancelWorkspace', input => {
    arm.disarm(input?.org === undefined ? undefined : input)
    return { ok: true as const }
  })
  orca.panels.handle('work.startAgent', input =>
    startAgent({ call, links, context, details: (org, id) => boards.details(org, id), defaultAgent: settings.defaultAgent }, input)
  )
}
