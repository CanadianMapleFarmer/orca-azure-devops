import { atom, read, update } from 'orca'

export type FoldTab = 'work' | 'prs' | 'pipelines'
export interface Folds {
  all: 'open' | 'closed' | null
  open: string[]
  closed: string[]
}

export const MAX_OVERRIDES = 300

export const folds = atom<Record<string, Folds>>('folds', {}, { persist: 'plugin', version: 1 })

export const foldedAfter = <T extends string>(closed: T[], fold: T, open: boolean): T[] =>
  open ? closed.filter(other => other !== fold) : closed.includes(fold) ? closed : [...closed, fold]

const entryKey = (org: string, tab: FoldTab) => `${org}|${tab}`

const listed = (list: unknown, key: string): boolean => Array.isArray(list) && list.includes(key)

const keysOf = (list: unknown): string[] => (Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : [])

const allOf = (value: unknown): Folds['all'] => (value === 'open' || value === 'closed' ? value : null)

export function isOpenIn(state: Folds | undefined, key: string, natural: boolean): boolean {
  if (listed(state?.open, key)) return true
  if (listed(state?.closed, key)) return false
  const all = allOf(state?.all)
  return all === null ? natural : all === 'open'
}

export function override(state: Folds | undefined, key: string, open: boolean): Folds {
  const opened = keysOf(state?.open).filter(other => other !== key)
  const closed = keysOf(state?.closed).filter(other => other !== key)
  const target = open ? opened : closed
  target.push(key)
  // The two lists keep no order between them, so the longer one gives up its oldest key.
  while (opened.length + closed.length > MAX_OVERRIDES) (opened.length > closed.length ? opened : closed).shift()
  return { all: allOf(state?.all), open: opened, closed }
}

export function isFoldOpen(org: string, tab: FoldTab, key: string, natural = true): boolean {
  return isOpenIn(read(folds)?.[entryKey(org, tab)], key, natural)
}

export function setFoldOpen(org: string, tab: FoldTab, key: string, open: boolean): void {
  const entry = entryKey(org, tab)
  update(folds, all => ({ ...all, [entry]: override(all?.[entry], key, open) }))
}

export function setAllFolds(org: string, tab: FoldTab, open: boolean): void {
  const reset: Folds = { all: open ? 'open' : 'closed', open: [], closed: [] }
  update(folds, all => ({ ...all, [entryKey(org, tab)]: reset }))
}
