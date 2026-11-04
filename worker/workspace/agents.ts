import type { WorkItemDetails } from '../../src/shared/work'
import { focusedWorkspace, listWorkspaces, type HostCall } from './focused'
import type { LinkStore } from './links'

export const NO_WORKSPACE = 'Start a workspace for this item first, or open one in Orca.'

const DEFAULT_MAX_CHARS = 4000
const CONTEXT_CAP = 500

export interface ContextCache {
  record(terminalId: string, workspaceId: string): void
  workspaceOf(terminalId: string): string | null
}

export interface ItemInfo { type: string; title: string; url: string }

export function itemLink(id: number, info: ItemInfo): string {
  return `[ADO ${info.type} #${id}: ${info.title}](${info.url})`
}

export function itemPrompt(details: WorkItemDetails, maxChars = DEFAULT_MAX_CHARS): string {
  const { item, descriptionMd, acceptanceMd } = details
  const sections = [
    descriptionMd && `## Description\n\n${descriptionMd}`,
    acceptanceMd && `## Acceptance criteria\n\n${acceptanceMd}`
  ].filter(Boolean)
  const text = [itemLink(item.id, item), ...sections].join('\n\n')
  if (text.length <= maxChars) return text
  const rest = `\n\n… open in Azure DevOps for the rest: ${item.url}`
  const kept = text.slice(0, Math.max(0, maxChars - rest.length)).replace(/[\uD800-\uDBFF]$/, '')
  return kept.trimEnd() + rest
}

export function createContextCache(): ContextCache {
  const workspaces = new Map<string, string>()
  return {
    record(terminalId, workspaceId) {
      workspaces.delete(terminalId)
      workspaces.set(terminalId, workspaceId)
      if (workspaces.size > CONTEXT_CAP) workspaces.delete(workspaces.keys().next().value as string)
    },
    workspaceOf: terminalId => workspaces.get(terminalId) ?? null
  }
}

export interface AgentDeps {
  call: HostCall
  links: LinkStore
  context: ContextCache
  details: (org: string, id: number) => Promise<WorkItemDetails>
  defaultAgent: () => string
}

async function workspaceFor(deps: AgentDeps, org: string, id: number): Promise<string | null> {
  const linked = deps.links.byItem(org, id)
  if (linked && (await listWorkspaces(deps.call)).some(entry => entry.id === linked)) return linked
  return (await focusedWorkspace(deps.call))?.id ?? null
}

export async function startAgent(deps: AgentDeps, input: { org: string; id: number }): Promise<{ launched: boolean; message?: string }> {
  const workspaceId = await workspaceFor(deps, input.org, input.id)
  if (!workspaceId) return { launched: false, message: NO_WORKSPACE }
  const prompt = itemPrompt(await deps.details(input.org, input.id))
  const { terminalId }: { terminalId: string } = await deps.call('agent.launch', { workspaceId, agent: deps.defaultAgent(), prompt })
  deps.context.record(terminalId, workspaceId)
  return { launched: true }
}
