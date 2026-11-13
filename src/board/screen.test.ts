import { assert, mockEditorHost, test } from 'orca/testing'
import { followDocument } from './document'
import { boardFileText, type BoardRef } from './ref'
import { closePanelFirst } from './screen'

const STORIES: BoardRef = { org: 'contoso', projectId: 'proj-web', teamId: 'team-web', boardId: 'board-stories' }
const BUGS: BoardRef = { ...STORIES, boardId: 'board-bugs' }

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function editor(text: string) {
  const host = mockEditorHost({ text })
  const seen: string[] = []
  let open = false
  let picked: ((ref: BoardRef) => Promise<void>) | null = null
  const panel = {
    close: () => {
      if (open) seen.push('panel closed')
      open = false
    }
  }
  await followDocument(
    host.orca.document!,
    closePanelFirst(panel, {
      board: ref => seen.push(`board ${ref.boardId}`),
      picker: pick => {
        seen.push('picker')
        picked = pick
      },
      note: text => seen.push(`note ${text}`),
      readFailed: () => seen.push('read failed')
    })
  )
  const pick = (ref: BoardRef) => (picked ? picked(ref) : assert.fail('the dialog is not showing'))
  return { host, seen, pick, openPanel: () => (open = true), isOpen: () => open }
}

test('an open panel closes before the document changes to another board', async () => {
  const { host, seen, openPanel, isOpen } = await editor(boardFileText(STORIES))
  openPanel()
  host.replace(boardFileText(BUGS))
  await tick()
  assert.deepEqual(seen, ['board board-stories', 'panel closed', 'board board-bugs'])
  assert.equal(isOpen(), false)
  host.dispose()
})

test('an open panel closes when the document empties into the dialog, but stays open for the echo of a picked board', async () => {
  const emptied = await editor(boardFileText(STORIES))
  emptied.openPanel()
  emptied.host.replace('')
  await tick()
  assert.deepEqual(emptied.seen, ['board board-stories', 'panel closed', 'picker'])
  emptied.host.dispose()

  const echoed = await editor('')
  await echoed.pick(STORIES)
  echoed.openPanel()
  echoed.host.replace(boardFileText(STORIES))
  await tick()
  assert.deepEqual(echoed.seen, ['picker', 'board board-stories'])
  assert.equal(echoed.isOpen(), true)
  echoed.host.dispose()
})
