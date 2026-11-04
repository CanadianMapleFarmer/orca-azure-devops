import type { WorkItemDetails } from '../../src/shared/work'
import { NO_ITEM_WORKSPACE, REST_IN_ADO } from '../messages'
import { focusedWorkspace, listWorkspaces, type HostCall, type WorkspaceEntry } from './focused'
import type { LinkStore } from './links'

const DEFAULT_MAX_CHARS = 4000
const CONTEXT_CAP = 500

export interface ContextCache {
  record(terminalId: string, workspaceId: string): void
  workspaceOf(terminalId: string): string | null
  markGiven(terminalId: string): void
  wasGiven(terminalId: string): boolean
}

export interface ItemInfo { type: string; title: string; url: string }

export function itemLink(id: number, info: ItemInfo): string {
  return `[ADO ${info.type} #${id}: ${info.title.replace(/[\\[\]]/g, '\\$&')}](${info.url})`
}

export function carriesContext(prompt: string, id: number): boolean {
  return new RegExp(`^\\[ADO [^#]*#${escapeRegExp(String(id))}: `).test(prompt.split('\n', 1)[0])
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function itemPrompt(details: WorkItemDetails, maxChars = DEFAULT_MAX_CHARS): string {
  const { item, descriptionMd, acceptanceMd } = details
  const sections = [
    descriptionMd && `## Description\n\n${descriptionMd}`,
    acceptanceMd && `## Acceptance criteria\n\n${acceptanceMd}`
  ].filter(Boolean)
  const text = [itemLink(item.id, item), ...sections].join('\n\n')
  if (text.length <= maxChars) return text
  const rest = `\n\n${REST_IN_ADO}: ${item.url}`
  const kept = text.slice(0, Math.max(0, maxChars - rest.length)).replace(/[\uD800-\uDBFF]$/, '')
  return kept.trimEnd() + rest
}

export function createContextCache(): ContextCache {
  const workspaces = new Map<string, string>()
  const given = new Set<string>()
  return {
    record(terminalId, workspaceId) {
      workspaces.delete(terminalId)
      workspaces.set(terminalId, workspaceId)
      if (workspaces.size > CONTEXT_CAP) workspaces.delete(workspaces.keys().next().value as string)
    },
    workspaceOf: terminalId => workspaces.get(terminalId) ?? null,
    markGiven(terminalId) {
      given.delete(terminalId)
      given.add(terminalId)
      if (given.size > CONTEXT_CAP) given.delete(given.values().next().value as string)
    },
    wasGiven: terminalId => given.has(terminalId)
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
  let listed: WorkspaceEntry[] | undefined
  if (linked) {
    listed = await listWorkspaces(deps.call)
    if (listed.some(entry => entry.id === linked)) return linked
  }
  return (await focusedWorkspace(deps.call, listed))?.id ?? null
}

export async function startAgent(deps: AgentDeps, input: { org: string; id: number }): Promise<{ launched: boolean; message?: string }> {
  const workspaceId = await workspaceFor(deps, input.org, input.id)
  if (!workspaceId) return { launched: false, message: NO_ITEM_WORKSPACE }
  const prompt = itemPrompt(await deps.details(input.org, input.id))
  const { terminalId }: { terminalId: string } = await deps.call('agent.launch', { workspaceId, agent: deps.defaultAgent(), prompt })
  deps.context.record(terminalId, workspaceId)
  deps.context.markGiven(terminalId)
  return { launched: true }
}
