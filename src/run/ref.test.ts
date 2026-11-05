import { assert, test } from 'orca/testing'
import { parseRunRef } from './ref'

const REF = { org: 'contoso', projectId: '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d', buildId: 4512 }

test('parseRunRef accepts a run file and refuses anything else', () => {
  assert.deepEqual(parseRunRef(`${JSON.stringify(REF, null, 2)}\n`), REF)
  assert.deepEqual(parseRunRef(JSON.stringify({ ...REF, note: 'ignored' })), REF)
  const refused = [
    '',
    '  \n',
    '{',
    'null',
    '[]',
    '4512',
    JSON.stringify({ ...REF, org: '' }),
    JSON.stringify({ ...REF, projectId: '' }),
    JSON.stringify({ ...REF, projectId: 7 }),
    JSON.stringify({ ...REF, buildId: '4512' }),
    JSON.stringify({ ...REF, buildId: 0 }),
    JSON.stringify({ ...REF, buildId: -3 }),
    JSON.stringify({ ...REF, buildId: 45.5 }),
    JSON.stringify({ ...REF, buildId: 2 ** 60 }),
    JSON.stringify({ org: 'contoso', projectId: 'proj-web', teamId: 'team-web', boardId: 'board-stories' })
  ]
  for (const text of refused) assert.equal(parseRunRef(text), null, text)
  const { org: _, ...withoutOrg } = REF
  assert.equal(parseRunRef(JSON.stringify(withoutOrg)), null)
  const { buildId: __, ...withoutBuild } = REF
  assert.equal(parseRunRef(JSON.stringify(withoutBuild)), null)
})
