import type { EditorDocumentApi } from 'orca/frame'
import { assert, hostError, mockEditorHost, test, type MockEditorHostOptions } from 'orca/testing'
import { followDocument } from './document'
import type { BoardRef } from './ref'

const REF: BoardRef = { org: 'contoso', projectId: 'proj-web', teamId: 'team-web', boardId: 'board-stories' }
const TEXT = '{\n  "org": "contoso",\n  "projectId": "proj-web",\n  "teamId": "team-web",\n  "boardId": "board-stories"\n}\n'
const READ_ONLY = "This file is read-only, so this board won't be remembered."
const NOT_SAVED = "Couldn't write this board into the file, so it won't be remembered."

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function editor(text: string, options: MockEditorHostOptions = {}, wrap = (doc: EditorDocumentApi) => doc) {
  const host = mockEditorHost({ text }, options)
  const seen: string[] = []
  let picked: ((ref: BoardRef) => Promise<void>) | null = null
  await followDocument(wrap(host.orca.document!), {
    board: ref => seen.push(`board ${ref.boardId}`),
    picker: pick => {
      seen.push('picker')
      picked = pick
    },
    note: text => seen.push(`note ${text}`),
    readFailed: () => seen.push('read failed')
  })
  const pick = (ref: BoardRef) => (picked ? picked(ref) : assert.fail('the dialog is not showing'))
  return { host, seen, pick }
}

test('picking a board in the dialog writes it into the document as the board file text', async () => {
  const { host, seen, pick } = await editor('')
  assert.deepEqual(seen, ['picker'])
  await pick(REF)
  assert.deepEqual(host.edits, [{ baseVersion: 1, content: { kind: 'text', text: TEXT } }])
  assert.equal(host.text, TEXT)
  assert.deepEqual(seen, ['picker', 'board board-stories'])
  host.dispose()
})

test('a reload or a document carrying the picked board opens the board, not the dialog', async () => {
  const reload = await editor(TEXT)
  assert.deepEqual(reload.seen, ['board board-stories'])
  reload.host.dispose()

  const changed = await editor('')
  changed.host.replace(TEXT)
  await tick()
  assert.deepEqual(changed.seen, ['picker', 'board board-stories'])
  changed.host.dispose()

  const echoed = await editor('')
  await echoed.pick(REF)
  echoed.host.replace(TEXT)
  await tick()
  assert.deepEqual(echoed.seen, ['picker', 'board board-stories'], 'the echo of the written text does not open the board again')
  echoed.host.dispose()
})

test('a read-only document still shows the picked board, with a note that it will not be remembered', async () => {
  const { host, seen, pick } = await editor('', { readOnly: true })
  await pick(REF)
  assert.deepEqual(seen, ['picker', 'board board-stories', `note ${READ_ONLY}`])
  assert.deepEqual(host.edits.map(edit => edit.refused), ['not_permitted'])
  assert.equal(host.text, '')
  host.dispose()
})

test('a conflict re-reads the document and retries once', async () => {
  const plain = await editor('')
  plain.host.conflictNext()
  await plain.pick(REF)
  assert.deepEqual(plain.host.edits.map(edit => edit.refused), ['conflict', undefined])
  assert.equal(plain.host.text, TEXT)
  assert.deepEqual(plain.seen, ['picker', 'board board-stories'])
  plain.host.dispose()

  const outside = await editor('')
  outside.host.conflictNext('\n')
  await outside.pick(REF)
  assert.deepEqual(outside.host.edits.map(edit => [edit.baseVersion, edit.refused]), [[1, 'conflict'], [2, undefined]])
  assert.equal(outside.host.text, TEXT)
  assert.deepEqual(outside.seen, ['picker', 'board board-stories', 'picker', 'board board-stories'], 'the board shows again once it is written')
  outside.host.dispose()

  let host: ReturnType<typeof mockEditorHost> | null = null
  const always = await editor('', {}, doc => ({
    ...doc,
    applyEdit: edit => {
      host?.conflictNext()
      return doc.applyEdit(edit)
    }
  }))
  host = always.host
  await always.pick(REF)
  assert.deepEqual(always.host.edits.map(edit => edit.refused), ['conflict', 'conflict'])
  assert.deepEqual(always.seen, ['picker', 'board board-stories', `note ${NOT_SAVED}`])
  always.host.dispose()
})

test('an edit Orca refuses as too large leaves the board showing with a note', async () => {
  const { host, seen, pick } = await editor('', {}, doc => ({ ...doc, applyEdit: async () => Promise.reject(hostError('too_large')) }))
  await pick(REF)
  assert.deepEqual(seen, ['picker', 'board board-stories', `note ${NOT_SAVED}`])
  host.dispose()
})

test('a document that cannot be read says so', async () => {
  const { seen, host } = await editor('', {}, doc => ({ ...doc, get: async () => Promise.reject(hostError('internal')) }))
  assert.equal(seen[0], 'read failed')
  host.dispose()
})
