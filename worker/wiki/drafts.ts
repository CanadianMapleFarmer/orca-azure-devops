import { MAX_DRAFTS, type DraftSummary, type WikiPageRef } from '../../src/shared/wiki'
import { titleText } from '../ado/wiki'
import type { StorePort } from '../connections'
import {
  badRequest,
  DRAFT_DISCARDED,
  DRAFT_FILE_TAKEN,
  DRAFT_GONE,
  DRAFT_WORKSPACE_GONE,
  NO_LOCAL_WORKSPACE_WIKI,
  openedDraft,
  TOO_MANY_DRAFTS,
  WIKI_PAGE_GONE,
  WIKI_PAGE_TOO_LARGE,
  WIKI_READ_ONLY
} from '../messages'
import { TAB_FOLDER, writeTabFile } from '../tab-files'
import { focusedWorkspace, listWorkspaces, type HostCall, type WorkspaceEntry } from '../workspace/focused'
import { assertInside, baseName, draftName, sameFile, theirsName, type DraftFs } from './draft-files'
import { MAX_PUBLISH_BYTES } from './publish'
import type { WikiService } from './service'

export interface StoredDraft {
  key: string
  org: string
  projectId: string
  wikiId: string
  wikiName: string
  path: string
  version: string
  workspaceId: string
  workspacePath: string
  workspaceName: string
  file: string
  startedAt: number
  publishedAt: number | null
  mergeMark: string | null
}

export interface DraftRebase {
  version: string
  base: string
  mine?: string
  publishedAt?: number
  mergeMark?: string | null
}

export interface Drafts {
  edit(ref: WikiPageRef): Promise<{ opened: boolean; message: string }>
  list(org: string): Promise<DraftSummary[]>
  discard(key: string): Promise<{ ok: true; message: string }>
  get(key: string): Promise<StoredDraft | null>
  texts(draft: StoredDraft): Promise<{ mine: string; base: string } | null>
  hasFile(draft: StoredDraft): Promise<boolean>
  rebase(draft: StoredDraft, change: DraftRebase): Promise<void>
  openTheirs(draft: StoredDraft, theirs: string): Promise<string>
  forget(key: string): Promise<void>
}

export interface DraftsDeps {
  store: StorePort
  fs: DraftFs
  call: HostCall
  wiki: Pick<WikiService, 'wiki' | 'fresh'>
  now: () => number
}

const DRAFTS_KEY = 'wiki:drafts'
const TEXT_FIELDS = ['key', 'org', 'projectId', 'wikiId', 'wikiName', 'path', 'version', 'workspaceId', 'workspacePath', 'workspaceName', 'file'] as const

export function draftKey(ref: WikiPageRef): string {
  return `${ref.org}:${ref.wikiId}:${ref.path}`
}

export function createDrafts(deps: DraftsDeps): Drafts {
  let queue: Promise<unknown> = Promise.resolve()

  function serially<T>(change: () => Promise<T>): Promise<T> {
    const run = queue.then(change)
    queue = run.catch(() => {})
    return run
  }

  async function read(): Promise<StoredDraft[]> {
    const stored = await deps.store.get<unknown>(DRAFTS_KEY)
    return Array.isArray(stored) ? stored.filter(isStoredDraft) : []
  }

  function save(drafts: StoredDraft[]): Promise<void> {
    return deps.store.set(DRAFTS_KEY, drafts)
  }

  async function readText(workspacePath: string, name: string): Promise<string | null> {
    try {
      return await deps.fs.readFile(await assertInside(deps.fs, workspacePath, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  async function texts(draft: StoredDraft): Promise<{ mine: string; base: string } | null> {
    const mine = await readText(draft.workspacePath, draft.file)
    const base = mine === null ? null : await readText(draft.workspacePath, baseName(draft.file))
    return mine === null || base === null ? null : { mine, base }
  }

  async function write(workspacePath: string, files: [name: string, text: string][]): Promise<void> {
    for (const [name] of files) await assertInside(deps.fs, workspacePath, name)
    for (const [name, text] of files) await writeTabFile(deps.fs, workspacePath, name, text)
  }

  async function open(workspaceId: string, name: string): Promise<string> {
    const opened = `${TAB_FOLDER}/${name}`
    await deps.call('editor.open', { workspaceId, path: opened })
    return opened
  }

  async function rebaseNow(draft: StoredDraft, change: DraftRebase): Promise<void> {
    const drafts = await read()
    const current = drafts.find(item => item.key === draft.key)
    if (!current) return
    const files: [string, string][] = [[baseName(current.file), change.base]]
    if (change.mine !== undefined) files.push([current.file, change.mine])
    await write(current.workspacePath, files)
    const next: StoredDraft = {
      ...current,
      version: change.version,
      publishedAt: change.publishedAt ?? current.publishedAt,
      mergeMark: change.mergeMark ?? null
    }
    await save(drafts.map(item => (item === current ? next : item)))
  }

  async function reopen(ref: WikiPageRef, draft: StoredDraft, mine: string): Promise<{ opened: boolean; message: string }> {
    if (mine === (await readText(draft.workspacePath, baseName(draft.file)))) {
      const page = await deps.wiki.fresh(ref)
      if (!page) return refused(WIKI_PAGE_GONE)
      await rebaseNow(draft, { version: page.etag, base: page.content, mine: page.content })
    }
    await open(draft.workspaceId, draft.file)
    return { opened: true, message: openedDraft(titleText(draft.path)) }
  }

  async function edit(ref: WikiPageRef): Promise<{ opened: boolean; message: string }> {
    const wiki = await deps.wiki.wiki(ref.org, ref.wikiId)
    if (!wiki.editable) return refused(WIKI_READ_ONLY)
    let drafts = await read()
    let listed: WorkspaceEntry[] | undefined
    const existing = drafts.find(draft => draft.key === draftKey(ref))
    if (existing) {
      listed = await listWorkspaces(deps.call)
      if (!listed.some(entry => entry.id === existing.workspaceId)) return refused(DRAFT_WORKSPACE_GONE)
      const mine = await readText(existing.workspacePath, existing.file)
      if (mine !== null) return reopen(ref, existing, mine)
      drafts = drafts.filter(draft => draft !== existing)
      await save(drafts)
    }

    const workspace = await focusedWorkspace(deps.call, listed)
    if (!workspace || workspace.hostId !== null) return refused(NO_LOCAL_WORKSPACE_WIKI)
    const page = await deps.wiki.fresh(ref)
    if (!page) return refused(WIKI_PAGE_GONE)
    if (Buffer.byteLength(page.content) > MAX_PUBLISH_BYTES) return refused(WIKI_PAGE_TOO_LARGE)
    if (drafts.length >= MAX_DRAFTS) return refused(TOO_MANY_DRAFTS)
    const file = draftName(ref.org, wiki.name, ref.path)
    if (drafts.some(draft => inWorkspace(draft, workspace) && sameFile(draft.file, file))) return refused(DRAFT_FILE_TAKEN)

    await write(workspace.path, [
      [file, page.content],
      [baseName(file), page.content]
    ])
    const draft: StoredDraft = {
      key: draftKey(ref),
      org: ref.org,
      projectId: ref.projectId,
      wikiId: ref.wikiId,
      wikiName: wiki.name,
      path: ref.path,
      version: page.etag,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceName: workspace.name,
      file,
      startedAt: deps.now(),
      publishedAt: null,
      mergeMark: null
    }
    await save([...drafts, draft])
    await open(draft.workspaceId, file)
    return { opened: true, message: openedDraft(titleText(ref.path)) }
  }

  async function changed(draft: StoredDraft): Promise<boolean> {
    try {
      const current = await texts(draft)
      return current === null || current.mine !== current.base
    } catch {
      return true
    }
  }

  async function remove(workspacePath: string, name: string): Promise<void> {
    try {
      await deps.fs.rm(await assertInside(deps.fs, workspacePath, name), { force: true })
    } catch {}
  }

  return {
    edit: ref => serially(() => edit(ref)),

    async list(org) {
      const drafts = (await read()).filter(draft => draft.org === org).sort((a, b) => b.startedAt - a.startedAt)
      const summaries: DraftSummary[] = []
      for (const draft of drafts) summaries.push(summaryOf(draft, await changed(draft)))
      return summaries
    },

    discard: key =>
      serially(async () => {
        const drafts = await read()
        const draft = drafts.find(item => item.key === key)
        if (!draft) throw badRequest(DRAFT_GONE)
        for (const name of [draft.file, baseName(draft.file), theirsName(draft.file)]) await remove(draft.workspacePath, name)
        await save(drafts.filter(item => item !== draft))
        return { ok: true, message: DRAFT_DISCARDED }
      }),

    get: async key => (await read()).find(draft => draft.key === key) ?? null,

    texts,

    hasFile: async draft => (await readText(draft.workspacePath, draft.file)) !== null,

    rebase: (draft, change) => serially(() => rebaseNow(draft, change)),

    async openTheirs(draft, theirs) {
      const name = theirsName(draft.file)
      await write(draft.workspacePath, [[name, theirs]])
      return open(draft.workspaceId, name)
    },

    forget: key =>
      serially(async () => {
        const drafts = await read()
        await save(drafts.filter(draft => draft.key !== key))
      })
  }
}

function refused(message: string): { opened: false; message: string } {
  return { opened: false, message }
}

function inWorkspace(draft: StoredDraft, workspace: WorkspaceEntry): boolean {
  return draft.workspaceId === workspace.id || draft.workspacePath === workspace.path
}

function summaryOf(draft: StoredDraft, changed: boolean): DraftSummary {
  return {
    org: draft.org,
    projectId: draft.projectId,
    wikiId: draft.wikiId,
    path: draft.path,
    key: draft.key,
    wikiName: draft.wikiName,
    title: titleText(draft.path),
    file: draft.file,
    workspaceName: draft.workspaceName,
    changed,
    publishedAt: draft.publishedAt
  }
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  return (
    TEXT_FIELDS.every(field => typeof draft[field] === 'string') &&
    typeof draft.startedAt === 'number' &&
    (draft.publishedAt === null || typeof draft.publishedAt === 'number') &&
    (draft.mergeMark === null || typeof draft.mergeMark === 'string')
  )
}
