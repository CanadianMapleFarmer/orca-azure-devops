import type { DetailPr, DetailTask, PrChip, WorkComment, WorkItemDetails, WorkItemSummary } from '../../src/shared/work'
import type { TypeState } from '../ado/board-config'
import { bodyOf, linkedIds, linkRows } from '../ado/details'
import { chipOf, pullRequestNamedUrl } from '../ado/pr-links'
import { displayName, prRefsOf, textOr, workItemUrl, type PrRef, type RawWorkItem } from '../ado/workitems'
import type { OrgEntities, Stamped } from '../data/entities'
import { FRESHNESS } from '../data/freshness'
import { prKey, type DetailsRecord } from '../data/records'

export const MAX_DETAIL_TASKS = 50
export const MAX_LINKED_READS = 200

export function linkedReadIds(raw: RawWorkItem): number[] {
  return [...new Set(linkedIds(raw).map(link => link.id))].slice(0, MAX_LINKED_READS)
}

export function childIds(raw: RawWorkItem): number[] {
  return [...new Set(linkedIds(raw).flatMap(link => (link.kind === 'child' ? [link.id] : [])))]
}

export function relationsKey(raw: RawWorkItem): string {
  return keyOf([...linkedIds(raw).map(({ kind, id }) => `${kind}:${id}`), ...prRefsOf(raw).map(prKey)])
}

export function detailsFresh(held: Stamped<DetailsRecord> | undefined, storeRev: number | undefined, now: number): held is Stamped<DetailsRecord> {
  return held !== undefined && held.value.rev === storeRev && now - held.at < FRESHNESS.itemDetails
}

export function doneStateOf(states: readonly TypeState[]): string | null {
  return states.find(state => state.category === 'Completed')?.name ?? null
}

export function openStateOf(states: readonly TypeState[]): string | null {
  return (states.find(state => state.category === 'InProgress') ?? states.find(state => state.category === 'Proposed'))?.name ?? null
}

export function taskRowOf(raw: RawWorkItem, states: readonly TypeState[] | undefined, orgUrl: string, home: string): DetailTask | null {
  const state = textOr(raw.fields['System.State'], '')
  const category = states?.find(entry => entry.name === state)?.category
  if (category === 'Removed') return null
  return {
    id: raw.id,
    rev: raw.rev,
    type: typeOf(raw),
    title: textOr(raw.fields['System.Title'], ''),
    state,
    done: category === 'Completed',
    assignedTo: displayName(raw.fields['System.AssignedTo']),
    doneState: states ? doneStateOf(states) : null,
    openState: states ? openStateOf(states) : null,
    url: workItemUrl(orgUrl, textOr(raw.fields['System.TeamProject'], '') || home, raw.id)
  }
}

export function recordOf(input: {
  raw: RawWorkItem
  linked: readonly RawWorkItem[] | null
  states: ReadonlyMap<string, TypeState[]> | null
  chips: PrChip[]
  org: string
  orgUrl: string
  projectId: string
  home: string
  itemUrl: string
}): DetailsRecord {
  const { raw, linked, states, home } = input
  const rows = linked && states ? childRows(raw, linked, states, input.orgUrl, home) : null
  return {
    id: raw.id,
    rev: raw.rev,
    projectId: input.projectId,
    home,
    relations: relationsKey(raw),
    ...bodyOf(raw, input.itemUrl),
    links: linkRows(input.org, raw, linked ?? [], input.chips, home),
    tasks: rows?.tasks ?? [],
    moreTasks: rows?.more ?? 0,
    tasksRead: rows !== null,
    prRefs: prRefsOf(raw)
  }
}

export function withWrite(record: DetailsRecord, raw: RawWorkItem, states: ReadonlyMap<string, TypeState[]>, orgUrl: string, itemUrl: string): DetailsRecord | null {
  if (raw.id === record.id) {
    if (raw.rev < record.rev) return record
    if (relationsKey(raw) !== record.relations) return null
    return { ...record, rev: raw.rev, ...bodyOf(raw, itemUrl) }
  }
  const row = record.tasks.find(task => task.id === raw.id)
  if (!row || raw.rev < row.rev) return record
  const rebuilt = taskRowOf(raw, states.get(typeOf(raw)), orgUrl, record.home)
  const others = record.tasks.filter(task => task !== row)
  return { ...record, tasks: inOrder(rebuilt ? [...others, rebuilt] : others) }
}

export function withNewChild(record: DetailsRecord, task: DetailTask): DetailsRecord {
  const tasks = inOrder([...record.tasks.filter(row => row.id !== task.id), task])
  const kept = tasks.slice(0, MAX_DETAIL_TASKS)
  const after = record.links.filter(link => link.kind === 'parent' || link.kind === 'child').length
  return {
    ...record,
    relations: keyOf([...record.relations.split(' ').filter(Boolean), `child:${task.id}`]),
    links: [...record.links.slice(0, after), { kind: 'child', title: task.title, url: task.url }, ...record.links.slice(after)],
    tasks: kept,
    moreTasks: record.moreTasks + tasks.length - kept.length
  }
}

export function prRowsOf(org: string, refs: readonly PrRef[], tables: Pick<OrgEntities, 'prs' | 'prChecks'>): DetailPr[] {
  const unique = [...new Map(refs.map(ref => [prKey(ref), ref])).values()].sort((a, b) => b.prId - a.prId)
  return unique.map(ref => {
    const record = tables.prs.get(prKey(ref))?.value
    if (!record) {
      return { prId: ref.prId, title: null, target: null, state: null, build: null, policies: null, url: pullRequestNamedUrl(org, ref.projectId, ref.repoId, ref.prId) }
    }
    const checks = tables.prChecks.get(prKey(ref))?.value
    const chip = chipOf(record, checks)
    return { prId: ref.prId, title: record.title ?? null, target: chip.target, state: chip.state, build: chip.build, policies: checks?.policies ?? null, url: chip.url }
  })
}

export function composeDetails(parts: {
  record: DetailsRecord
  item: WorkItemSummary
  comments: WorkComment[]
  prs: DetailPr[]
  taskTypes: string[]
  taskType: string | null
  readAt: number
}): WorkItemDetails {
  const { record, ...rest } = parts
  return {
    ...rest,
    descriptionMd: record.descriptionMd,
    acceptanceMd: record.acceptanceMd,
    assignee: record.assignee,
    links: record.links,
    tasks: record.tasks,
    moreTasks: record.moreTasks,
    tasksRead: record.tasksRead
  }
}

function childRows(raw: RawWorkItem, linked: readonly RawWorkItem[], states: ReadonlyMap<string, TypeState[]>, orgUrl: string, home: string): { tasks: DetailTask[]; more: number } {
  const records = new Map(linked.map(item => [item.id, item]))
  const read = new Set(linkedReadIds(raw))
  const children = childIds(raw)
  const rows = inOrder(
    children.flatMap(id => {
      const child = records.get(id)
      return (child && taskRowOf(child, states.get(typeOf(child)), orgUrl, home)) ?? []
    })
  )
  const unread = children.filter(id => !read.has(id)).length
  return { tasks: rows.slice(0, MAX_DETAIL_TASKS), more: Math.max(0, rows.length - MAX_DETAIL_TASKS) + unread }
}

function inOrder(tasks: DetailTask[]): DetailTask[] {
  return [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id)
}

function keyOf(parts: string[]): string {
  return [...new Set(parts)].sort().join(' ')
}

function typeOf(raw: RawWorkItem): string {
  return textOr(raw.fields['System.WorkItemType'], '')
}
