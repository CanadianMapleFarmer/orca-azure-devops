import { assert, test } from 'orca/testing'
import { parseBoardRef } from './ref'

const REF = { org: 'contoso', projectId: 'proj-web', teamId: 'team-web', boardId: 'board-stories' }

test('parseBoardRef reads the board a backing file names', () => {
  assert.deepEqual(parseBoardRef(JSON.stringify(REF, null, 2)), REF)
  assert.deepEqual(parseBoardRef(JSON.stringify({ ...REF, note: 'ignored' })), REF)
})

test('parseBoardRef answers null for an empty, invalid or incomplete document', () => {
  for (const text of ['', '  \n', '{', 'null', '[]', '"contoso"', JSON.stringify({ ...REF, org: '' }), JSON.stringify({ ...REF, teamId: 7 })]) {
    assert.equal(parseBoardRef(text), null, text)
  }
  const { projectId: _, ...withoutProject } = REF
  assert.equal(parseBoardRef(JSON.stringify(withoutProject)), null)
  const { boardId: __, ...withoutBoard } = REF
  assert.equal(parseBoardRef(JSON.stringify(withoutBoard)), null)
  assert.equal(parseBoardRef(JSON.stringify({ ...REF, boardId: 12 })), null)
})
