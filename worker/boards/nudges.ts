import { MAX_NUDGE_RULES, type BoardConfig, type Nudge, type WorkItemSummary } from '../../src/shared/work'
import type { StorePort } from '../connections'

export interface NudgeRule { branch: string; column: string }

const HEADS_PREFIX = /^refs\/heads\//
const DISMISSED_CAP = 500

export function nudgeRulesKey(org: string, teamId: string): string {
  return `nudgeRules:${org}:${teamId}`
}

function dismissedKey(org: string): string {
  return `nudgeDismissed:${org}`
}

function dismissal(itemId: number, prId: number): string {
  return `${itemId}:${prId}`
}

export function cleanRules(rules: readonly NudgeRule[]): NudgeRule[] {
  const named = rules
    .map(rule => ({ branch: branchName(rule.branch.trim()), column: rule.column }))
    .filter(rule => rule.branch !== '' && rule.column !== '')
  return [...new Map<string, NudgeRule>(named.map(rule => [rule.branch, rule])).values()].slice(0, MAX_NUDGE_RULES)
}

export function findNudges(cfg: BoardConfig, items: WorkItemSummary[], rules: NudgeRule[], dismissed: ReadonlySet<string>): Nudge[] {
  const order = cfg.columns.map(column => column.name)
  return items.flatMap(item => {
    const from = item.column === null ? -1 : order.indexOf(item.column)
    if (from < 0) return []
    return item.prs.flatMap(pr => {
      if (pr.state !== 'merged' || dismissed.has(dismissal(item.id, pr.prId))) return []
      const target = branchName(pr.target)
      const rule = rules.find(candidate => branchName(candidate.branch) === target && order.indexOf(candidate.column) > from)
      return rule ? [{ itemId: item.id, prId: pr.prId, branch: target, toColumn: rule.column }] : []
    })
  })
}

export interface NudgeStore {
  rules(org: string, teamId: string): Promise<NudgeRule[]>
  saveRules(org: string, teamId: string, rules: NudgeRule[]): Promise<void>
  dismissed(org: string): Promise<Set<string>>
  dismiss(org: string, itemId: number, prId: number): Promise<void>
}

export function createNudgeStore(store: StorePort): NudgeStore {
  let writes: Promise<void> = Promise.resolve()

  async function dismissedList(org: string): Promise<string[]> {
    const list = await store.get<unknown>(dismissedKey(org))
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  }

  return {
    async rules(org, teamId) {
      const list = await store.get<unknown>(nudgeRulesKey(org, teamId))
      return Array.isArray(list) ? list.filter(isRule) : []
    },

    saveRules(org, teamId, rules) {
      return store.set(nudgeRulesKey(org, teamId), rules)
    },

    async dismissed(org) {
      return new Set(await dismissedList(org))
    },

    dismiss(org, itemId, prId) {
      const key = dismissal(itemId, prId)
      const write = writes.then(async () => {
        const kept = (await dismissedList(org)).filter(entry => entry !== key)
        await store.set(dismissedKey(org), [...kept, key].slice(-DISMISSED_CAP))
      })
      writes = write.catch(() => {})
      return write
    }
  }
}

function branchName(ref: string): string {
  return ref.replace(HEADS_PREFIX, '')
}

function isRule(value: unknown): value is NudgeRule {
  if (typeof value !== 'object' || value === null) return false
  const { branch, column } = value as Record<string, unknown>
  return typeof branch === 'string' && typeof column === 'string'
}
