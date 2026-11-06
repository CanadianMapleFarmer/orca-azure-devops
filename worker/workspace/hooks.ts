import type { OrcaWorkerApi } from 'orca/worker'
import { carriesContext, itemLink, type ContextCache, type ItemInfo } from './agents'
import type { Arm } from './arm'
import type { LinkStore } from './links'

export interface WorkspaceHookDeps {
  arm: Arm
  links: LinkStore
  context: ContextCache
  itemInfo: (org: string, itemId: number) => ItemInfo | null
  agentContext: () => boolean
}

export function registerWorkspaceHooks(orca: OrcaWorkerApi, deps: WorkspaceHookDeps): void {
  orca.hooks.on('workspace.create.before', (event, next) => {
    if (event.kind !== 'worktree') return
    const armed = deps.arm.take()
    if (!armed) return
    return next({ ...event, branch: armed.branch, name: armed.branch, ...('base' in armed ? { base: armed.base } : {}) })
  })

  orca.hooks.on('workspace.create.after', event => {
    const armed = deps.arm.claim(event.branch)
    if (!armed) return
    deps.links.link(event.workspaceId, { org: armed.org, itemId: armed.itemId }).catch(() => orca.log(`could not save the link for workspace ${event.workspaceId}`))
  })

  orca.hooks.on('agent.launch.before', event => {
    if (event.workspaceId && event.terminalId) deps.context.record(event.terminalId, event.workspaceId)
  })

  orca.hooks.on('agent.prompt.before', (event, next) => {
    if (!deps.agentContext() || deps.context.wasGiven(event.terminalId)) return
    const workspaceId = deps.context.workspaceOf(event.terminalId)
    const ref = workspaceId && deps.links.byWorkspace(workspaceId)
    const info = ref && deps.itemInfo(ref.org, ref.itemId)
    if (!ref || !info) return
    deps.context.markGiven(event.terminalId)
    return carriesContext(event.prompt, ref.itemId) ? undefined : next({ ...event, prompt: `${itemLink(ref.itemId, info)}\n\n${event.prompt}` })
  })

  orca.events.on('agent.status.changed', status => {
    if (status.workspaceId && status.terminalId) deps.context.record(status.terminalId, status.workspaceId)
  })
}
