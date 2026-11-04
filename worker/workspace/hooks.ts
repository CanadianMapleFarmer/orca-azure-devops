import type { OrcaWorkerApi } from 'orca/worker'
import { itemLink, type ContextCache, type ItemInfo } from './agents'
import type { Arm } from './arm'
import type { LinkStore } from './links'

const PREFIXED_CAP = 500

export interface WorkspaceHookDeps {
  arm: Arm
  links: LinkStore
  context: ContextCache
  itemInfo: (org: string, itemId: number) => ItemInfo | null
  agentContext: () => boolean
}

export function registerWorkspaceHooks(orca: OrcaWorkerApi, deps: WorkspaceHookDeps): void {
  const prefixed = new Set<string>()

  orca.hooks.on('workspace.create.before', (event, next) => {
    if (event.kind !== 'worktree') return
    const armed = deps.arm.take()
    return armed ? next({ ...event, branch: armed.branch, name: armed.branch }) : undefined
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
    if (!deps.agentContext() || prefixed.has(event.terminalId)) return
    const workspaceId = deps.context.workspaceOf(event.terminalId)
    const ref = workspaceId && deps.links.byWorkspace(workspaceId)
    const info = ref && deps.itemInfo(ref.org, ref.itemId)
    if (!ref || !info) return
    prefixed.add(event.terminalId)
    if (prefixed.size > PREFIXED_CAP) prefixed.delete(prefixed.values().next().value as string)
    const link = itemLink(ref.itemId, info)
    return event.prompt.startsWith(link) ? undefined : next({ ...event, prompt: `${link}\n\n${event.prompt}` })
  })

  orca.events.on('agent.status.changed', status => {
    if (status.workspaceId && status.terminalId) deps.context.record(status.terminalId, status.workspaceId)
  })
}
