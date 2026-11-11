import type { BoardConfig } from '../../src/shared/work'
import type { TypeState } from '../ado/board-config'
import type { NamedItem } from '../ado/core'
import { byteLength, newestThatFit } from '../budget'
import type { Entities, OrgEntities, Stamped, Table, TableName } from './entities'
import { VALUE_BUDGET_BYTES, type Persisted } from './persist'
import { prKey, type CheckRecord, type PrRecord } from './records'

export type Row<T> = [key: string, value: T, at: number]
export interface SavedMeta { configs: Row<BoardConfig>[]; states: Row<TypeState[]>[]; projects: Row<NamedItem[]>[] }
export interface SavedPr extends Omit<PrRecord, 'projectId' | 'repoId'> { at: number; checks?: Stamped<CheckRecord> }
export interface SavedRepo { projectId: string; repoId: string; prs: SavedPr[] }
export interface SavedPrRecords { repos: SavedRepo[] }

export interface SavedTables {
  seed(org: string, account: string): Promise<void>
  save(org: string, account: string): void
  forget(org: string): void
}

export const MAX_SAVED_PRS = 600

type Part = 'meta' | 'pr-records'

const PARTS: [Part, TableName[]][] = [
  ['meta', ['boardConfigs', 'typeStates', 'projects']],
  ['pr-records', ['prs', 'prChecks']]
]
const EMPTY_META: SavedMeta = { configs: [], states: [], projects: [] }

export function createSavedTables(entities: Entities, persisted: Persisted): SavedTables {
  const seeds = new Map<string, Promise<void>>()
  const dirty = new Map<string, Set<Part>>()
  for (const [part, names] of PARTS) for (const name of names) entities.watch(name, org => changed(org, part))

  function changed(org: string, part: Part): void {
    const parts = dirty.get(org) ?? new Set<Part>()
    dirty.set(org, parts)
    parts.add(part)
  }

  async function restore(org: string, account: string): Promise<void> {
    const tables = entities.of(org)
    const [meta, records] = await Promise.all([persisted.load(org, 'meta', account), persisted.load(org, 'pr-records', account)])
    if (entities.of(org) !== tables) return
    seedMeta(tables, meta?.value)
    seedPrRecords(tables, records?.value)
  }

  return {
    seed(org, account) {
      const seeding = seeds.get(org) ?? restore(org, account)
      seeds.set(org, seeding)
      return seeding
    },

    save(org, account) {
      const parts = dirty.get(org)
      if (!parts) return
      dirty.delete(org)
      const tables = entities.of(org)
      if (parts.has('meta')) {
        const meta = metaOf(tables)
        persisted.save(org, 'meta', account, meta, timelessMeta(meta))
      }
      if (parts.has('pr-records')) {
        const records = prRecordsOf(tables)
        persisted.save(org, 'pr-records', account, records, timelessPrRecords(records))
      }
    },

    forget(org) {
      seeds.delete(org)
      dirty.delete(org)
    }
  }
}

export function metaOf(tables: Pick<OrgEntities, 'boardConfigs' | 'typeStates' | 'projects'>): SavedMeta {
  const configs = rowsOf(tables.boardConfigs)
  const states = rowsOf(tables.typeStates)
  const projects = rowsOf(tables.projects)
  const kept = newestThatFit<Row<unknown>>([...configs, ...states, ...projects], VALUE_BUDGET_BYTES - byteLength(EMPTY_META), row => row[2])
  return { configs: configs.filter(row => kept.has(row)), states: states.filter(row => kept.has(row)), projects: projects.filter(row => kept.has(row)) }
}

export function prRecordsOf(tables: Pick<OrgEntities, 'prs' | 'prChecks'>): SavedPrRecords {
  const checks = new Map(tables.prChecks.entries())
  const repoOf = new Map<SavedPr, SavedRepo>()
  const repos = new Map<string, SavedRepo>()
  for (const [key, { value, at }] of tables.prs.entries().sort(([a], [b]) => a.localeCompare(b))) {
    const { projectId, repoId, ...rest } = value
    const id = `${projectId}/${repoId}`
    const repo = repos.get(id) ?? { projectId, repoId, prs: [] }
    repos.set(id, repo)
    const held = checks.get(key)
    repoOf.set({ ...rest, at, ...(held ? { checks: held } : {}) }, repo)
  }
  const room = VALUE_BUDGET_BYTES - byteLength({ repos: [...repos.values()] })
  const kept = newestThatFit([...repoOf.keys()], room, pr => pr.at, MAX_SAVED_PRS)
  for (const pr of kept) repoOf.get(pr)!.prs.push(pr)
  return { repos: [...repos.values()].filter(repo => repo.prs.length > 0) }
}

function timelessMeta({ configs, states, projects }: SavedMeta): unknown {
  const timeless = (rows: Row<unknown>[]) => rows.map(([key, value]) => [key, value])
  return { configs: timeless(configs), states: timeless(states), projects: timeless(projects) }
}

function timelessPrRecords({ repos }: SavedPrRecords): unknown {
  const byId = (a: SavedPr, b: SavedPr) => a.prId - b.prId
  return repos.map(({ prs, ...repo }) => ({ ...repo, prs: [...prs].sort(byId).map(({ at, checks, ...pr }) => ({ ...pr, checks: checks?.value })) }))
}

export function seedMeta(tables: Pick<OrgEntities, 'boardConfigs' | 'typeStates' | 'projects'>, meta: unknown): void {
  if (!isRecord(meta)) return
  seedRows(tables.boardConfigs, meta.configs)
  seedRows(tables.typeStates, meta.states)
  seedRows(tables.projects, meta.projects)
}

export function seedPrRecords(tables: Pick<OrgEntities, 'prs' | 'prChecks'>, records: unknown): void {
  if (!isRecord(records) || !Array.isArray(records.repos)) return
  const saved = records.repos.filter(isRepo).flatMap(({ projectId, repoId, prs }) => prs.filter(isSavedPr).map(pr => ({ projectId, repoId, pr })))
  for (const { projectId, repoId, pr } of saved.sort((a, b) => a.pr.at - b.pr.at)) {
    const { at, checks, ...rest } = pr
    const record: PrRecord = { projectId, repoId, ...rest }
    seedOne(tables.prs, prKey(record), record, at)
    if (isStamped(checks)) seedOne(tables.prChecks, prKey(record), checks.value, checks.at)
  }
}

function rowsOf<T>(table: Table<T>): Row<T>[] {
  return table
    .entries()
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { value, at }]) => [key, value, at])
}

function seedRows<T>(table: Table<T>, rows: unknown): void {
  if (!Array.isArray(rows)) return
  for (const [key, value, at] of rows.filter(isRow).sort((a, b) => a[2] - b[2])) seedOne(table, key, value as T, at)
}

function seedOne<T>(table: Table<T>, key: string, value: T, at: number): void {
  const held = table.get(key)
  if (!held || held.at < at) table.put(key, value, at)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRow(value: unknown): value is Row<unknown> {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === 'string' && typeof value[1] === 'object' && value[1] !== null && Number.isFinite(value[2])
}

function isRepo(value: unknown): value is SavedRepo {
  return isRecord(value) && typeof value.projectId === 'string' && typeof value.repoId === 'string' && Array.isArray(value.prs)
}

function isSavedPr(value: unknown): value is SavedPr {
  return isRecord(value) && Number.isInteger(value.prId) && typeof value.status === 'string' && typeof value.target === 'string' && Number.isFinite(value.at)
}

function isStamped(value: unknown): value is Stamped<CheckRecord> {
  return isRecord(value) && isRecord(value.value) && Number.isFinite(value.at)
}
