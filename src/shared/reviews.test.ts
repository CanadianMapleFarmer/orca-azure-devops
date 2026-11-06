import { assert, test } from 'orca/testing'
import { isResolved, THREAD_STATUS_LABEL, VOTE_BUTTON, VOTE_VALUE, votePhrase, type ThreadStatus, type VoteChoice } from './reviews'

test('votePhrase names every vote and isResolved covers the resolved statuses', () => {
  assert.deepEqual(VOTE_VALUE, { approve: 10, suggestions: 5, waitForAuthor: -5, reject: -10 })
  assert.deepEqual(VOTE_BUTTON, {
    approve: 'Approve',
    suggestions: 'Approve with suggestions',
    waitForAuthor: 'Wait for author',
    reject: 'Reject'
  })
  const choices = Object.keys(VOTE_VALUE) as VoteChoice[]
  assert.deepEqual(choices.map(choice => votePhrase(VOTE_VALUE[choice])), [
    'Approved',
    'Approved with suggestions',
    'Waiting for author',
    'Rejected'
  ])
  for (const vote of [0, 7, -1, 11, Number.NaN]) assert.equal(votePhrase(vote), 'No vote', String(vote))

  assert.deepEqual(THREAD_STATUS_LABEL, {
    active: 'Active',
    pending: 'Pending',
    fixed: 'Resolved',
    wontFix: "Won't fix",
    closed: 'Closed',
    byDesign: 'By design',
    unknown: 'Unknown'
  })
  const statuses = Object.keys(THREAD_STATUS_LABEL) as ThreadStatus[]
  assert.deepEqual(statuses.filter(isResolved), ['fixed', 'wontFix', 'closed', 'byDesign'])
})
