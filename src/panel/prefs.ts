import { atom, update, type Atom } from 'orca'
import type { Scope } from './grouping'

export type PrsView = 'mine' | 'review'
export type WorkView = 'columns' | 'lanes'

const REMEMBERED = { persist: 'plugin', version: 1 } as const

export const prsPrefs = atom<Record<string, Scope & { view: PrsView }>>('prsPrefs', {}, REMEMBERED)
export const runsPrefs = atom<Record<string, Scope>>('runsPrefs', {}, REMEMBERED)
export const workViews = atom<Record<string, WorkView>>('workViews', {}, REMEMBERED)

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function entryIn(all: Record<string, unknown> | null | undefined, org: string): Record<string, unknown> {
  const entry = all?.[org]
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {}
}

export function scopeIn(all: Record<string, Partial<Scope>>, org: string): Scope {
  const entry = entryIn(all, org)
  return { project: idOrNull(entry.project), repo: idOrNull(entry.repo) }
}

export function chooseProject<S extends Scope>(prefs: Atom<Record<string, S>>, org: string, project: string | null): void {
  update(prefs, all => ({ ...all, [org]: { ...entryIn(all, org), project, repo: null } as S }))
}

export function chooseRepo<S extends Scope>(prefs: Atom<Record<string, S>>, org: string, repo: string | null): void {
  update(prefs, all => ({ ...all, [org]: { ...entryIn(all, org), repo } as S }))
}
