import type { OrcaWorkerApi } from 'orca/worker'
import { carriesContext, itemLink, type ContextCache, type ItemInfo } from './agents'
import type { Arm } from './arm'
import type { LinkStore } from './links'
import type { PendingLinks } from './pending'

export interface WorkspaceHookDeps {
  arm: Arm
  links: LinkStore
  pending: PendingLinks
  context: ContextCache
  itemInfo: (org: string, itemId: number, signal: AbortSignal) => Promise<ItemInfo | null>
  timeout: (ms: number) => AbortSignal
  agentContext: () => boolean
}

const ITEM_INFO_TIMEOUT_MS = 1_000

export function registerWorkspaceHooks(orca: OrcaWorkerApi, deps: WorkspaceHookDeps): void {
  orca.hooks.on('workspace.create.before', (event, next) => {
    if (event.kind !== 'worktree' || (event.branch !== undefined && deps.pending.awaits(event.branch))) return
    const armed = deps.arm.take()
    if (!armed) return
    return next({ ...event, branch: armed.branch, name: armed.branch, base: armed.base })
  })

  orca.hooks.on('workspace.create.after', event => {
    const ref = deps.pending.claim(event.branch)
    if (!ref) return
    deps.links.link(event.workspaceId, ref).catch(() => orca.log(`could not save the link for workspace ${event.workspaceId}`))
    orca.panels.post('work.workspaceReady', { ...ref, workspaceId: event.workspaceId, branch: event.branch })
  })

  orca.hooks.on('agent.launch.before', event => {
    if (event.workspaceId && event.terminalId) deps.context.record(event.terminalId, event.workspaceId)
  })

  orca.hooks.on('agent.prompt.before', async (event, next) => {
    if (!deps.agentContext() || deps.context.wasGiven(event.terminalId)) return
    const workspaceId = deps.context.workspaceOf(event.terminalId)
    const ref = workspaceId && deps.links.byWorkspace(workspaceId)
    if (!ref) return
    const info = await itemInfoInTime(deps, ref.org, ref.itemId)
    if (!info) return
    deps.context.markGiven(event.terminalId)
    return carriesContext(event.prompt, ref.itemId) ? undefined : next({ ...event, prompt: `${itemLink(ref.itemId, info)}\n\n${event.prompt}` })
  })

  orca.events.on('agent.status.changed', status => {
    if (status.workspaceId && status.terminalId) deps.context.record(status.terminalId, status.workspaceId)
  })
}

function itemInfoInTime(deps: WorkspaceHookDeps, org: string, itemId: number): Promise<ItemInfo | null> {
  const signal = deps.timeout(ITEM_INFO_TIMEOUT_MS)
  const late = new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))
  return Promise.race([deps.itemInfo(org, itemId, signal), late]).catch(() => null)
}
