import type { StorePort } from '../connections'

export const LINKS_KEY = 'workspaceLinks'

const LINKS_CAP = 500

export interface ItemRef { org: string; itemId: number }

export interface LinkStore {
  link(workspaceId: string, ref: ItemRef): Promise<void>
  byWorkspace(id: string): ItemRef | null
  byItem(org: string, itemId: number): string | null
}

interface Link extends ItemRef { linkedAt: number }

function isLink(value: unknown): value is Link {
  const link = value as Link | null
  return typeof link?.org === 'string' && typeof link.itemId === 'number' && typeof link.linkedAt === 'number'
}

function parse(stored: unknown): Map<string, Link> {
  const entries = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.entries(stored) : []
  const links = entries.filter((entry): entry is [string, Link] => isLink(entry[1])).sort((a, b) => a[1].linkedAt - b[1].linkedAt)
  return new Map(links.slice(-LINKS_CAP))
}

export async function createLinkStore(store: StorePort, now: () => number): Promise<LinkStore> {
  const links = parse(await store.get<unknown>(LINKS_KEY))
  let writes: Promise<void> = Promise.resolve()

  return {
    link(workspaceId, ref) {
      links.delete(workspaceId)
      links.set(workspaceId, { org: ref.org, itemId: ref.itemId, linkedAt: now() })
      if (links.size > LINKS_CAP) links.delete(links.keys().next().value as string)
      const saved = Object.fromEntries(links)
      writes = writes.catch(() => {}).then(() => store.set(LINKS_KEY, saved))
      return writes
    },

    byWorkspace(id) {
      const link = links.get(id)
      return link ? { org: link.org, itemId: link.itemId } : null
    },

    byItem(org, itemId) {
      const match = [...links].reverse().find(([, link]) => link.org === org && link.itemId === itemId)
      return match?.[0] ?? null
    }
  }
}
