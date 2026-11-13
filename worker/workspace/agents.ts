import type { WorkItemDetails } from '../../src/shared/work'
import { READ_AT_LINK } from '../messages'

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

export function itemPrompt(details: WorkItemDetails): string {
  const { item, descriptionMd, acceptanceMd } = details
  const sections = [
    descriptionMd && `## Description\n\n${descriptionMd}`,
    acceptanceMd && `## Acceptance criteria\n\n${acceptanceMd}`
  ].filter(Boolean)
  return [itemLink(item.id, item), ...sections].join('\n\n')
}

export function shortPrompt({ item }: WorkItemDetails): string {
  return `${itemLink(item.id, item)}\n\n${READ_AT_LINK}`
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
