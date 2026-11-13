import { assert, test } from 'orca/testing'
import { comment } from '../board/fixtures'
import { OWN_COMMENT_MS, recordOwn, withOwn } from './own-comments'

const NOW = Date.parse('2026-11-11T09:00:00Z')
const KEY = 'contoso:4211'

const ids = (comments: { id: number }[]) => comments.map(entry => entry.id)

test('a read that lacks a comment you posted under 2 minutes ago gets it back, newest first', () => {
  const own = recordOwn({}, KEY, comment(32), NOW)
  assert.deepEqual(ids(withOwn(own, KEY, [comment(31)], NOW + OWN_COMMENT_MS - 1)), [32, 31])
  assert.deepEqual(ids(withOwn(own, KEY, [comment(33), comment(31)], NOW)), [33, 32, 31])
})

test('a read is taken as it is when it has your comment, for another item, or once your comment is 2 minutes old', () => {
  const own = recordOwn({}, KEY, comment(32), NOW)
  const holding = [comment(32), comment(31)]
  const lacking = [comment(31)]
  assert.equal(withOwn(own, KEY, holding, NOW), holding)
  assert.equal(withOwn(own, 'contoso:4213', lacking, NOW), lacking)
  assert.equal(withOwn(own, KEY, lacking, NOW + OWN_COMMENT_MS), lacking)
})

test('recording forgets comments posted 2 minutes ago or more', () => {
  const earlier = recordOwn(recordOwn({}, 'contoso:4213', comment(5), NOW), KEY, comment(31), NOW + 1)
  assert.deepEqual(recordOwn(earlier, KEY, comment(32), NOW + OWN_COMMENT_MS), {
    [KEY]: [
      { comment: comment(31), at: NOW + 1 },
      { comment: comment(32), at: NOW + OWN_COMMENT_MS }
    ]
  })
})
