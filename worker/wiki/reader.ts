import * as path from 'node:path'
import type { WikiPage, WikiPageRef } from '../../src/shared/wiki'
import { fenceAfter, toFencedMermaid } from '../../src/shared/wiki-blocks'
import { NO_LOCAL_WORKSPACE_WIKI, openedReader, READER_CUT_NOTE, READER_OUTSIDE, readerBanner } from '../messages'
import { ensureTabFolder, TAB_FOLDER } from '../tab-files'
import { focusedWorkspace, isLocalWorkspace, type HostCall } from '../workspace/focused'
import { assertInside, readerName, type DraftFs } from './draft-files'
import type { WikiService } from './service'

export const MAX_READER_BYTES = 614_400

export interface Reader {
  openInTab(ref: WikiPageRef): Promise<{ opened: boolean; message: string }>
}

export type ReaderFs = DraftFs & Pick<typeof import('node:fs/promises'), 'chmod'>

const READ_ONLY = 0o444
const WRITABLE = 0o644
const CUT_SUFFIX = `\n\n*${READER_CUT_NOTE}*`
const MARKDOWN_SPECIAL = /[\\`*_[\]<&~]/g

export function readerMarkdown(page: WikiPage, editable: boolean): string {
  const text = `${readerBanner(page.title.replace(MARKDOWN_SPECIAL, '\\$&'), editable)}\n\n${toFencedMermaid(page.content)}`
  return Buffer.byteLength(text) <= MAX_READER_BYTES ? text : cutAtLine(text)
}

export function createReader(deps: { wiki: Pick<WikiService, 'wiki' | 'page'>; call: HostCall; fs: ReaderFs }): Reader {
  return {
    async openInTab(ref) {
      const workspace = await focusedWorkspace(deps.call)
      if (!workspace || !isLocalWorkspace(workspace)) return { opened: false, message: NO_LOCAL_WORKSPACE_WIKI }
      const wiki = await deps.wiki.wiki(ref.org, ref.wikiId)
      const page = await deps.wiki.page(ref, MAX_READER_BYTES, READER_CUT_NOTE)
      const name = readerName(ref.org, wiki.name, ref.path)
      await writeReadOnly(deps.fs, workspace.path, name, readerMarkdown(page, wiki.editable))
      await deps.call('editor.open', { workspaceId: workspace.id, path: `${TAB_FOLDER}/${name}` })
      return { opened: true, message: openedReader(page.title) }
    }
  }
}

async function writeReadOnly(fs: ReaderFs, workspacePath: string, name: string, text: string): Promise<void> {
  const file = await assertInside(fs, workspacePath, name, READER_OUTSIDE)
  await ensureTabFolder(fs, workspacePath)
  const current = await fs.readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (current === text) return
  if (current === null) await fs.mkdir(path.dirname(file), { recursive: true })
  else await fs.chmod(file, WRITABLE)
  await fs.writeFile(file, text)
  await fs.chmod(file, READ_ONLY)
}

function cutAtLine(text: string): string {
  const lines = text.split('\n')
  const room = MAX_READER_BYTES - Buffer.byteLength(CUT_SUFFIX)
  let used = -1
  let fence = ''
  let kept = { count: 0, fence: '' }
  for (const line of lines) {
    used += 1 + Buffer.byteLength(line)
    fence = fenceAfter(line, fence)
    if (used + (fence ? fence.length + 1 : 0) > room) break
    kept = { count: kept.count + 1, fence }
  }
  return [...lines.slice(0, kept.count), ...(kept.fence ? [kept.fence] : [])].join('\n') + CUT_SUFFIX
}
