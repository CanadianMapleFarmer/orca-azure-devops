import { branchName } from '../ado/pr-links'
import type { ItemRef } from './links'

export const PENDING_MS = 120_000
export const CLONE_CLAIM_MS = 600_000
const WATCH_MS = 600_000
const CAP = 20

type Release = () => void

export interface PendingLinks {
  expect(link: ItemRef & { branch: string; release?: Release; claimMs?: number }): void
  awaits(branch: string): boolean
  expecting(ref: ItemRef): boolean
  forget(ref: ItemRef): void
  claim(branch: string): ItemRef | null
  expectAgent(ref: ItemRef): void
  tie(terminalId: string, launches: (ref: ItemRef) => boolean): ItemRef | null
  working(terminalId: string): ItemRef | null
}

interface Waiting { ref: ItemRef; branch: string; at: number; claimMs: number; release?: Release }

export function onItemBranch(actual: string | null, wanted: string): boolean {
  const branch = branchName(actual ?? '')
  if (branch === wanted) return true
  // Orca names a branch that already exists <branch>-2, -3 and so on.
  return branch.startsWith(`${wanted}-`) && /^\d+$/.test(branch.slice(wanted.length + 1))
}

const sameItem = (a: ItemRef, b: ItemRef) => a.org === b.org && a.itemId === b.itemId

export function createPendingLinks(now: () => number): PendingLinks {
  const waiting: Waiting[] = []
  const agents: { ref: ItemRef; at: number }[] = []
  const tied = new Map<string, { ref: ItemRef; at: number }>()

  const claimable = () => waiting.filter(entry => now() - entry.at <= entry.claimMs)

  function waitingFor(branch: string): number {
    const current = claimable()
    const found = current.find(entry => branchName(branch) === entry.branch) ?? current.find(entry => onItemBranch(branch, entry.branch))
    return found ? waiting.indexOf(found) : -1
  }

  function take(at: number): Waiting {
    const [entry] = waiting.splice(at, 1)
    entry.release?.()
    return entry
  }

  return {
    expect({ org, itemId, branch, release, claimMs = PENDING_MS }) {
      const same = waiting.findIndex(entry => sameItem(entry.ref, { org, itemId }))
      if (same >= 0) take(same)
      waiting.push({ ref: { org, itemId }, branch, at: now(), claimMs, release })
      if (waiting.length > CAP) take(0)
    },
    awaits: branch => waitingFor(branch) >= 0,
    expecting: ref => waiting.some(entry => sameItem(entry.ref, ref) && now() - entry.at <= PENDING_MS),
    forget(ref) {
      const at = waiting.findIndex(entry => sameItem(entry.ref, ref))
      if (at >= 0) take(at)
    },
    claim(branch) {
      const at = waitingFor(branch)
      if (at < 0) return null
      const { ref } = take(at)
      const agent = agents.find(entry => sameItem(entry.ref, ref))
      if (agent) agent.at = now()
      return ref
    },
    expectAgent(ref) {
      const same = agents.findIndex(entry => sameItem(entry.ref, ref))
      if (same >= 0) agents.splice(same, 1)
      agents.push({ ref, at: now() })
      if (agents.length > CAP) agents.shift()
    },
    tie(terminalId, launches) {
      const at = agents.findIndex(entry => now() - entry.at <= WATCH_MS && launches(entry.ref))
      if (at < 0) return null
      const [{ ref }] = agents.splice(at, 1)
      tied.delete(terminalId)
      tied.set(terminalId, { ref, at: now() })
      if (tied.size > CAP) tied.delete(tied.keys().next().value as string)
      return ref
    },
    working(terminalId) {
      const entry = tied.get(terminalId)
      tied.delete(terminalId)
      return entry && now() - entry.at <= WATCH_MS ? entry.ref : null
    }
  }
}
