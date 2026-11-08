import { atom, plugin, read, set, update, type TreeItem } from 'orca'
import type { DiffText } from '../../shared/diff'
import { messageOf, SEARCH_TOO_SHORT } from '../../shared/messages'
import {
  draftKey,
  MIN_SEARCH_CHARS,
  type DraftSummary,
  type WikiHit,
  type WikiLevel,
  type WikiPage,
  type WikiPageRef,
  type WikiRef,
  type WikiResult
} from '../../shared/wiki'
import { counted } from '../copy'
import { cutLabel, MAX_LABEL_BYTES, utf8Length } from '../label'
import { LONG_WAIT } from '../state'

type Load = { status: 'idle' | 'loading' | 'ready' } | { status: 'failed'; message: string }
export type OpenPage = WikiPageRef & { title: string }
export type Confirm = 'discard' | 'mine' | 'theirs'
export interface Versions {
  theirs: DiffText
  mine: DiffText
}
export type Outcome =
  | { status: 'published' | 'unchanged' | 'updated' | 'failed' | 'opened' | 'refused'; message: string }
  | { status: 'conflict'; message: string; versions: Versions | null }
export interface Found {
  hits: WikiHit[]
  total: number
}

export const MAX_TREE_ITEMS = 1000
export const MAX_REMEMBERED_FOLDERS = 200
export const MAX_EXPAND_LOADS = 25
export const TREE_BYTES = 150 * 1024
const TREE_ITEM_OVERHEAD_BYTES = 40
const MAX_TREE_DEPTH = 16
export const ROOT = '/'

interface Scope {
  org: string
  wiki: WikiRef
}

export const wikiChoice = atom<Record<string, string>>('wikiChoice', {}, { persist: 'plugin' })
export const wikiExpanded = atom<Record<string, string[]>>('wikiExpanded', {}, { persist: 'plugin', version: 1 })
export const openPage = atom<OpenPage | null>('wikiPage', null, { persist: 'workspace' })
export const wikis = atom<WikiRef[]>([])
export const wikisLoad = atom<Load>({ status: 'idle' })
export const levels = atom<ReadonlyMap<string, WikiLevel>>(new Map())
export const rootLoad = atom<Load>({ status: 'idle' })
export const expanded = atom<string[]>([])
export const treeKey = atom(0)
export const treeNotice = atom<string | null>(null)
const lastShown = atom<WikiPageRef | null>(null)
export const refreshingTree = atom(false)
export const query = atom('')
export const found = atom<Found | null>(null)
export const searching = atom(false)
export const searchNotice = atom<string | null>(null)
export const loadedPage = atom<WikiPage | null>(null)
export const pageLoad = atom<Load>({ status: 'idle' })
export const drafts = atom<DraftSummary[] | null>(null)
export const draftsLoad = atom<Load>({ status: 'idle' })
const outcomes = atom<Record<string, Outcome>>({})
const confirms = atom<Record<string, Confirm>>({})
const running = atom<string[]>([])
const source = atom<string | null>(null)

const epochs = { wikis: 0, drafts: 0, tree: 0, search: 0, page: 0, bulk: 0 }
const levelLoads = new Set<string>()

const idle: Load = { status: 'idle' }

const without = <V>(all: Record<string, V>, key: string): Record<string, V> => {
  const next = { ...all }
  delete next[key]
  return next
}

const pageRef = ({ org, projectId, wikiId, path }: WikiPageRef): WikiPageRef => ({ org, projectId, wikiId, path })

const remount = (): void => update(treeKey, version => version + 1)

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || ROOT

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean)

const ancestorsOf = (path: string): string[] => {
  const parents = segmentsOf(path).slice(0, -1)
  return parents.map((_, index) => `/${parents.slice(0, index + 1).join('/')}`)
}

export function treeItems(
  levelsByPath: ReadonlyMap<string, WikiLevel>,
  open: readonly string[],
  max = MAX_TREE_ITEMS
): { items: TreeItem[]; capped: boolean } {
  const isOpen = new Set(open)
  let count = 0
  let used = 0
  let capped = false
  let full = false

  const take = (key: string, label: string, description = ''): boolean => {
    const cost = 2 * (utf8Length(key) + utf8Length(label) + utf8Length(description)) + TREE_ITEM_OVERHEAD_BYTES
    if (full || count >= max || used + cost > TREE_BYTES) {
      full = true
      capped = true
      return false
    }
    count += 1
    used += cost
    return true
  }

  const build = (path: string, depth: number): TreeItem[] => {
    const level = levelsByPath.get(path)
    const items: TreeItem[] = []
    if (!level) return items
    for (const node of level.pages) {
      if (utf8Length(node.path) > MAX_LABEL_BYTES) {
        capped = true
        continue
      }
      const label = cutLabel(node.title)
      const loaded = node.hasChildren ? levelsByPath.get(node.path) : undefined
      const description = loaded ? counted(loaded.total, 'page', 'pages') : undefined
      if (!take(node.path, label, description)) return items
      const nests = depth < MAX_TREE_DEPTH
      if (node.hasChildren && !nests) capped = true
      const item: TreeItem = { key: node.path, label, icon: node.hasChildren ? 'folder' : 'file-text', hasChildren: node.hasChildren && nests }
      if (description !== undefined) item.description = description
      if (item.hasChildren && isOpen.has(node.path) && levelsByPath.has(node.path)) item.children = build(node.path, depth + 1)
      items.push(item)
    }
    if (level.total > level.pages.length) {
      const key = `more:${path}`
      const label = `Showing ${level.pages.length} of ${level.total} pages`
      if (take(key, label)) items.push({ key, label, disabled: true })
    }
    return items
  }

  return { items: build(ROOT, 1), capped }
}

export function chosenWiki(org: string): WikiRef | undefined {
  const list = read(wikis)
  return list.find(wiki => wiki.id === read(wikiChoice)[org]) ?? list[0]
}

function scopeOf(): Scope | null {
  const org = read(source)
  const wiki = org === null ? undefined : chosenWiki(org)
  return org !== null && wiki !== undefined ? { org, wiki } : null
}

export const levelRef = (scope: Scope, path: string): WikiPageRef => ({
  org: scope.org,
  projectId: scope.wiki.projectId,
  wikiId: scope.wiki.id,
  path
})

export const isRunning = (key: string): boolean => read(running).includes(key)

export const outcomeOf = (key: string): Outcome | undefined => read(outcomes)[key]

export const confirmOf = (key: string): Confirm | undefined => read(confirms)[key]

export const ask = (key: string, confirm: Confirm): void => {
  if (!isRunning(key)) update(confirms, all => ({ ...all, [key]: confirm }))
}

export const cancelAsk = (key: string): void => update(confirms, all => without(all, key))

const memoryKey = (org: string, wikiId: string): string => `${org}|${wikiId}`

const scopeKey = (scope: Scope): string => memoryKey(scope.org, scope.wiki.id)

function rememberedAt(key: string): string[] {
  const list: unknown = read(wikiExpanded)?.[key]
  return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : []
}

function setRemembered(key: string, paths: readonly string[]): void {
  update(wikiExpanded, all => ({ ...all, [key]: paths.slice(-MAX_REMEMBERED_FOLDERS) }))
}

function remember(key: string, paths: readonly string[]): void {
  if (paths.length > 0) setRemembered(key, [...rememberedAt(key).filter(path => !paths.includes(path)), ...paths])
}

function forget(key: string, paths: readonly string[]): void {
  const kept = rememberedAt(key).filter(path => !paths.includes(path))
  if (kept.length !== rememberedAt(key).length) setRemembered(key, kept)
}

function reconcile(scope: Scope, parent: string, level: WikiLevel): void {
  if (level.total > level.pages.length) return
  const listed = new Set(level.pages.filter(node => node.hasChildren).map(node => node.path))
  const key = scopeKey(scope)
  const gone = [...rememberedAt(key), ...read(expanded)].filter(path => parentOf(path) === parent && !listed.has(path))
  if (gone.length === 0) return
  const lost = (path: string): boolean => gone.some(root => path === root || path.startsWith(`${root}/`))
  forget(key, rememberedAt(key).filter(lost))
  if (read(expanded).some(lost)) {
    update(expanded, list => list.filter(path => !lost(path)))
    remount()
  }
}

const listsFolder = (all: ReadonlyMap<string, WikiLevel>, path: string): boolean =>
  segmentsOf(path).length < MAX_TREE_DEPTH && (all.get(parentOf(path))?.pages.some(node => node.path === path && node.hasChildren) ?? false)

async function openFolders(scope: Scope, candidates: readonly string[], mine: number, remembering: boolean): Promise<void> {
  const bulk = epochs.bulk
  const stale = (): boolean => epochs.tree !== mine || epochs.bulk !== bulk
  const key = scopeKey(scope)
  const handled = new Set<string>()
  let budget = MAX_EXPAND_LOADS
  let failure: string | null = null
  let changed = false
  for (;;) {
    if (stale()) return
    const all = read(levels)
    const open = new Set(read(expanded))
    const ready = candidates.filter(path => !handled.has(path) && !open.has(path) && listsFolder(all, path))
    const cached = ready.filter(path => all.has(path))
    const fetching = ready.filter(path => !all.has(path) && !levelLoads.has(`${mine}|${path}`)).slice(0, budget)
    if (cached.length + fetching.length === 0) break
    for (const path of [...cached, ...fetching]) handled.add(path)
    budget -= fetching.length
    const loading = fetching.map(path => `${mine}|${path}`)
    for (const id of loading) levelLoads.add(id)
    const answers = await Promise.allSettled(fetching.map(path => plugin.request('wiki.pages', levelRef(scope, path))))
    for (const id of loading) levelLoads.delete(id)
    if (stale()) return
    const fresh = new Map<string, WikiLevel>()
    const failed: string[] = []
    for (const [index, answer] of answers.entries()) {
      if (answer.status === 'fulfilled') {
        fresh.set(fetching[index], answer.value)
      } else {
        failed.push(fetching[index])
        failure ??= messageOf(answer.reason)
      }
    }
    const opened = [...cached, ...fresh.keys()]
    update(levels, current => new Map([...current, ...fresh]))
    update(expanded, list => [...list, ...opened.filter(path => !list.includes(path))])
    if (remembering) remember(key, opened)
    forget(key, failed)
    for (const [path, level] of fresh) reconcile(scope, path, level)
    changed ||= opened.length > 0
  }
  if (changed) remount()
  if (failure !== null) set(treeNotice, failure)
}

export function selectedIn(items: readonly TreeItem[], scope: Scope): string | undefined {
  const shown = read(lastShown)
  if (shown === null || shown.org !== scope.org || shown.wikiId !== scope.wiki.id) return undefined
  const holds = (list: readonly TreeItem[]): boolean => list.some(item => item.key === shown.path || holds(item.children ?? []))
  return holds(items) ? shown.path : undefined
}

async function loadRoot(): Promise<void> {
  const scope = scopeOf()
  if (!scope) return
  const mine = ++epochs.tree
  set(rootLoad, { status: 'loading' })
  let level: WikiLevel
  try {
    level = await plugin.request('wiki.pages', levelRef(scope, ROOT))
  } catch (error) {
    if (epochs.tree === mine) set(rootLoad, { status: 'failed', message: messageOf(error) })
    return
  }
  if (epochs.tree !== mine) return
  set(levels, new Map([[ROOT, level]]))
  set(rootLoad, { status: 'ready' })
  reconcile(scope, ROOT, level)
  await openFolders(scope, rememberedAt(scopeKey(scope)).reverse(), mine, false)
}

function startTree(): void {
  set(levels, new Map())
  set(expanded, [])
  remount()
  set(treeNotice, null)
  set(refreshingTree, false)
  set(rootLoad, idle)
  levelLoads.clear()
  void loadRoot()
}

export const retryRoot = (): void => startTree()

async function loadWikis(org: string): Promise<void> {
  const mine = ++epochs.wikis
  set(wikisLoad, { status: 'loading' })
  try {
    const list = await plugin.request('wiki.list', { org })
    if (epochs.wikis !== mine) return
    set(wikis, list)
    set(wikisLoad, { status: 'ready' })
    startTree()
  } catch (error) {
    if (epochs.wikis === mine) set(wikisLoad, { status: 'failed', message: messageOf(error) })
  }
}

async function loadDrafts(org: string): Promise<void> {
  const mine = ++epochs.drafts
  set(draftsLoad, { status: 'loading' })
  try {
    const list = await plugin.request('wiki.drafts', { org })
    if (epochs.drafts !== mine) return
    set(drafts, list)
    set(draftsLoad, { status: 'ready' })
  } catch (error) {
    if (epochs.drafts === mine) set(draftsLoad, { status: 'failed', message: messageOf(error) })
  }
}

export function retryWikis(): void {
  const org = read(source)
  if (org !== null) void loadWikis(org)
}

export function retryDrafts(): void {
  const org = read(source)
  if (org !== null) void loadDrafts(org)
}

export function loadWikiWhenIdle(org: string): void {
  void Promise.resolve().then(() => {
    if (read(source) !== org) return
    if (read(wikisLoad).status === 'idle') void loadWikis(org)
    if (read(draftsLoad).status === 'idle') void loadDrafts(org)
  })
}

export function loadPageWhenIdle(): void {
  void Promise.resolve().then(() => {
    const open = read(openPage)
    if (open !== null && open.org === read(source) && read(pageLoad).status === 'idle') void reloadPage()
  })
}

function resetAll(org: string): void {
  for (const name of Object.keys(epochs) as (keyof typeof epochs)[]) epochs[name] += 1
  levelLoads.clear()
  if (read(openPage)?.org !== org) set(openPage, null)
  set(loadedPage, null)
  set(pageLoad, idle)
  set(wikis, [])
  set(wikisLoad, idle)
  set(levels, new Map())
  set(rootLoad, idle)
  set(expanded, [])
  remount()
  set(treeNotice, null)
  set(lastShown, null)
  set(refreshingTree, false)
  set(query, '')
  set(found, null)
  set(searching, false)
  set(searchNotice, null)
  set(drafts, null)
  set(draftsLoad, idle)
  set(outcomes, {})
  set(confirms, {})
  set(running, [])
}

export function syncWiki(org: string | null): void {
  void Promise.resolve().then(() => {
    if (org === null || read(source) === org) return
    set(source, org)
    resetAll(org)
  })
}

export function clearSearch(): void {
  epochs.search += 1
  set(query, '')
  set(found, null)
  set(searching, false)
  set(searchNotice, null)
}

export function chooseWiki(org: string, wikiId: string): void {
  if (read(source) !== org) return
  update(wikiChoice, all => ({ ...all, [org]: wikiId }))
  clearSearch()
  startTree()
}

export async function toggleFolder(ref: WikiPageRef, open: boolean): Promise<void> {
  const scope = scopeOf()
  if (!scope || scope.org !== ref.org || scope.wiki.id !== ref.wikiId) return
  update(expanded, list => (open ? (list.includes(ref.path) ? list : [...list, ref.path]) : list.filter(path => path !== ref.path)))
  if (open) remember(scopeKey(scope), [ref.path])
  else forget(scopeKey(scope), [ref.path])
  if (!open || read(levels).has(ref.path)) return
  const mine = epochs.tree
  const loading = `${mine}|${ref.path}`
  if (levelLoads.has(loading)) return
  levelLoads.add(loading)
  set(treeNotice, null)
  try {
    const level = await plugin.request('wiki.pages', pageRef(ref))
    if (epochs.tree === mine) {
      update(levels, all => new Map(all).set(ref.path, level))
      reconcile(scope, ref.path, level)
    }
  } catch (error) {
    if (epochs.tree === mine) {
      update(expanded, list => list.filter(path => path !== ref.path))
      forget(scopeKey(scope), [ref.path])
      remount()
      set(treeNotice, messageOf(error))
    }
  } finally {
    levelLoads.delete(loading)
  }
}

export async function refreshTree(): Promise<void> {
  const scope = scopeOf()
  if (!scope) return
  const mine = ++epochs.tree
  levelLoads.clear()
  set(treeNotice, null)
  set(refreshingTree, true)
  const open = read(expanded)
  const settled = await Promise.allSettled([ROOT, ...open].map(path => plugin.request('wiki.pages', levelRef(scope, path))))
  if (epochs.tree !== mine) return
  const [root, ...folders] = settled
  if (root.status === 'rejected') {
    set(treeNotice, messageOf(root.reason))
  } else {
    const next = new Map([[ROOT, root.value]])
    const kept: string[] = []
    const lost: string[] = []
    let failure: string | null = null
    for (const [index, result] of folders.entries()) {
      if (result.status === 'fulfilled') {
        next.set(open[index], result.value)
        kept.push(open[index])
      } else {
        lost.push(open[index])
        failure ??= messageOf(result.reason)
      }
    }
    const added = read(expanded).filter(path => !open.includes(path))
    update(levels, current => {
      for (const path of added) {
        const level = current.get(path)
        if (level) next.set(path, level)
      }
      return next
    })
    set(expanded, [...kept, ...added])
    forget(scopeKey(scope), lost)
    if (kept.length !== open.length) remount()
    for (const [path, level] of next) reconcile(scope, path, level)
    set(treeNotice, failure)
  }
  set(refreshingTree, false)
}

export async function search(text: string): Promise<void> {
  const scope = scopeOf()
  if (!scope) return
  const mine = ++epochs.search
  const trimmed = text.trim()
  set(found, null)
  if ([...trimmed].length < MIN_SEARCH_CHARS) {
    set(searching, false)
    set(searchNotice, SEARCH_TOO_SHORT)
    return
  }
  set(searchNotice, null)
  set(searching, true)
  try {
    const { projectId, id: wikiId } = scope.wiki
    const answer = await plugin.request('wiki.search', { org: scope.org, projectId, wikiId, text: trimmed })
    if (epochs.search !== mine) return
    set(found, answer)
  } catch (error) {
    if (epochs.search === mine) set(searchNotice, messageOf(error))
  }
  if (epochs.search === mine) set(searching, false)
}

export function showPage(ref: OpenPage): void {
  set(openPage, ref)
  set(loadedPage, null)
  void reloadPage()
}

async function revealPage(ref: WikiPageRef): Promise<void> {
  set(lastShown, ref)
  const key = memoryKey(ref.org, ref.wikiId)
  const parents = ancestorsOf(ref.path)
  const scope = scopeOf()
  if (scope !== null && scopeKey(scope) === key && read(levels).has(ROOT)) await openFolders(scope, parents, epochs.tree, true)
  else remember(key, parents)
}

export function closePage(): void {
  const closing = read(openPage)
  epochs.page += 1
  set(openPage, null)
  set(loadedPage, null)
  set(pageLoad, idle)
  if (closing !== null) void revealPage(pageRef(closing))
}

export function collapseAll(): void {
  epochs.bulk += 1
  set(treeNotice, null)
  set(expanded, [])
  const scope = scopeOf()
  if (scope) setRemembered(scopeKey(scope), [])
  remount()
}

function visibleFolders(): string[] {
  const keys: string[] = []
  const walk = (items: readonly TreeItem[]): void => {
    for (const item of items) {
      if (item.hasChildren === true) keys.push(item.key)
      walk(item.children ?? [])
    }
  }
  walk(treeItems(read(levels), read(expanded)).items)
  return keys
}

export async function expandAll(): Promise<void> {
  set(treeNotice, null)
  const scope = scopeOf()
  if (scope) await openFolders(scope, visibleFolders(), epochs.tree, true)
}

export async function reloadPage(): Promise<void> {
  const open = read(openPage)
  if (open === null) return
  const mine = ++epochs.page
  set(pageLoad, { status: 'loading' })
  try {
    const page = await plugin.request('wiki.page', pageRef(open))
    if (epochs.page !== mine) return
    set(loadedPage, page)
    set(pageLoad, { status: 'ready' })
  } catch (error) {
    if (epochs.page === mine) set(pageLoad, { status: 'failed', message: messageOf(error) })
  }
}

function record(key: string, next: Outcome): void {
  update(outcomes, all => {
    const kept: Record<string, Outcome> = {}
    for (const [id, outcome] of Object.entries(all)) {
      kept[id] = next.status === 'conflict' && next.versions !== null && outcome.status === 'conflict' ? { ...outcome, versions: null } : outcome
    }
    kept[key] = next
    return kept
  })
}

function outcomeOfResult(result: WikiResult): Outcome {
  return result.status === 'conflict'
    ? { status: 'conflict', message: result.message, versions: { theirs: result.theirs, mine: result.mine } }
    : { status: result.status, message: result.message }
}

async function exclusively(key: string, work: (org: string) => Promise<void>): Promise<void> {
  const org = read(source)
  if (org === null || isRunning(key)) return
  update(running, list => [...list, key])
  try {
    await work(org)
  } finally {
    update(running, list => list.filter(item => item !== key))
  }
}

async function settle(key: string, org: string, send: () => Promise<WikiResult>): Promise<void> {
  let result: WikiResult
  try {
    result = await send()
  } catch (error) {
    result = { status: 'failed', message: messageOf(error) }
  }
  if (read(source) !== org) return
  cancelAsk(key)
  record(key, outcomeOfResult(result))
  const open = read(openPage)
  const reload = result.status === 'published' && open !== null && draftKey(open) === key
  await Promise.all([loadDrafts(org), reload ? reloadPage() : undefined])
}

export const publish = (key: string): Promise<void> =>
  exclusively(key, org => settle(key, org, () => plugin.request('wiki.publish', { key }, LONG_WAIT)))

export const resolve = (key: string, choice: 'mine' | 'theirs' | 'merge'): Promise<void> =>
  exclusively(key, org => settle(key, org, () => plugin.request('wiki.resolve', { key, choice }, LONG_WAIT)))

export const discard = (key: string): Promise<void> =>
  exclusively(key, async org => {
    try {
      await plugin.request('wiki.discard', { key }, LONG_WAIT)
      if (read(source) === org) update(outcomes, all => without(all, key))
    } catch (error) {
      if (read(source) === org) record(key, { status: 'failed', message: messageOf(error) })
    }
    if (read(source) !== org) return
    cancelAsk(key)
    await loadDrafts(org)
  })

async function opening(send: () => Promise<{ opened: boolean; message: string }>): Promise<Outcome> {
  try {
    const { opened, message } = await send()
    return { status: opened ? 'opened' : 'refused', message }
  } catch (error) {
    return { status: 'refused', message: messageOf(error) }
  }
}

export const edit = (ref: WikiPageRef): Promise<void> =>
  exclusively(draftKey(ref), async org => {
    const outcome = await opening(() => plugin.request('wiki.edit', pageRef(ref), LONG_WAIT))
    if (read(source) !== org) return
    record(draftKey(ref), outcome)
    await loadDrafts(org)
  })

export const readKey = (ref: WikiPageRef): string => `read:${draftKey(ref)}`

export const openInTab = (ref: WikiPageRef): Promise<void> =>
  exclusively(readKey(ref), async org => {
    const outcome = await opening(() => plugin.request('wiki.openInTab', pageRef(ref), LONG_WAIT))
    if (read(source) === org) record(readKey(ref), outcome)
  })
