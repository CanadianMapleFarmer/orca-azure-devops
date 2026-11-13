import { assert, test } from 'orca/testing'
import { createDrafts, failed, loaded, needsReread, onBoard, opened, refreshing, shownItem, withAssignee, withComment, withNewTask, withTaskRow, type PanelState } from './details-state'
import { comment, details, detailTask, item } from './fixtures'

const ID = 4211

test('an answer for an earlier open or refresh is ignored', () => {
  const first = refreshing(opened(ID, 1), 2)
  const second = refreshing(first, 3)
  assert.equal(loaded(second, 2, details()), second, 'the first read lands after a newer one was sent')
  assert.equal(failed(second, 2, 'Too slow.'), second)

  const ready = loaded(second, 3, details())
  assert.equal(ready.load.status, 'ready')
  const again = refreshing(ready, 4)
  assert.deepEqual(again.load, { status: 'ready', details: details(), refreshing: true }, 'a refresh keeps the details it has')
  assert.equal(loaded(again, 3, details({ descriptionMd: 'older' })), again)
  assert.deepEqual(failed(again, 4, 'Too slow.').load, { status: 'failed', message: 'Too slow.' })
})

test('the panel re-reads only when the board shows a newer rev of the open item', () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7 }) }))
  assert.equal(needsReread(ready, item(ID, { rev: 7 })), false, 'the same rev')
  assert.equal(needsReread(ready, item(ID, { rev: 8 })), true, 'a newer rev')
  assert.equal(needsReread(refreshing(ready, 3), item(ID, { rev: 8 })), false, 'while refreshing')
  assert.equal(needsReread(ready, null), false, 'no board item')
  assert.equal(needsReread(refreshing(opened(ID, 1), 2), item(ID, { rev: 8 })), false, 'while loading')
})

test("the fields follow the board's card, a pending move included", () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7, column: 'Active' }) }))
  const pending = item(ID, { rev: 7, column: 'Resolved', state: 'Resolved' })
  assert.equal(shownItem(ready, pending), pending, 'the same rev, moving')
  const newer = item(ID, { rev: 8, column: 'Closed' })
  assert.equal(shownItem(ready, newer), newer)
  assert.equal(shownItem(ready, item(ID, { rev: 6, column: 'New' }))?.column, 'Active', 'an older card')
  assert.equal(shownItem(ready, null)?.column, 'Active', 'the card left the board')

  const loading = refreshing(opened(ID, 1), 2)
  assert.equal(shownItem(loading, pending), pending, "while loading the board's card is all there is")
  assert.equal(shownItem(loading, null), null)
})

test('an item that left the board is marked, and marked back when it returns', () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details())
  assert.equal(ready.offBoard, false)
  const left = onBoard(ready, null)
  assert.equal(left.offBoard, true)
  assert.equal(onBoard(left, null), left, 'no change, the same state')
  const back = onBoard(left, item(ID))
  assert.equal(back.offBoard, false)
  assert.equal(onBoard(back, item(ID)), back)

  const loading = refreshing(opened(ID, 1), 2)
  assert.equal(onBoard(loading, null), loading, 'not before the details are read')
})

test('drafts are kept per item and field until cleared', () => {
  const drafts = createDrafts()
  assert.equal(drafts.get(ID, 'comment'), '')
  drafts.set(ID, 'comment', 'Looks right on staging.')
  drafts.set(ID, 'task', 'Write the filter tests')
  drafts.set(4213, 'comment', 'Needs a floor of 1990.')
  assert.equal(drafts.get(ID, 'comment'), 'Looks right on staging.')
  assert.equal(drafts.get(ID, 'task'), 'Write the filter tests')
  assert.equal(drafts.get(4213, 'comment'), 'Needs a floor of 1990.')
  assert.equal(drafts.get(4213, 'task'), '')

  drafts.clear(ID, 'comment')
  assert.equal(drafts.get(ID, 'comment'), '')
  assert.equal(drafts.get(ID, 'task'), 'Write the filter tests')
})

test('a posted comment shows first', () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ comments: [comment(31), comment(30)] }))
  const posted = withComment(ready, comment(32, { author: 'Alex Contoso', textMd: 'Looks right on staging.' }))
  assert.equal(posted.load.status === 'ready' && posted.load.details.comments.map(entry => entry.id).join(), '32,31,30')

  const full = loaded(refreshing(opened(ID, 1), 2), 2, details({ comments: Array.from({ length: 50 }, (_, index) => comment(100 - index)) }))
  const capped = withComment(full, comment(101))
  assert.equal(capped.load.status === 'ready' && capped.load.details.comments.length, 50)
  assert.equal(capped.load.status === 'ready' && capped.load.details.comments[0].id, 101)

  const loading = refreshing(opened(ID, 1), 2)
  assert.equal(withComment(loading, comment(32)), loading)
})

test("an assignment takes the answer's rev and the new assignee", () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7, assignedTo: 'Grace Hopper' }) }))
  const dennis = { displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example' }
  const assigned = withAssignee(ready, item(ID, { rev: 8, assignedTo: 'Dennis Ritchie' }), dennis)
  assert.equal(assigned.load.status === 'ready' && assigned.load.details.item.rev, 8)
  assert.equal(assigned.load.status === 'ready' && assigned.load.details.item.assignedTo, 'Dennis Ritchie')
  assert.deepEqual(assigned.load.status === 'ready' && assigned.load.details.assignee, dennis)

  const unassigned = withAssignee(assigned, item(ID, { rev: 9, assignedTo: null }), null)
  assert.equal(unassigned.load.status === 'ready' && unassigned.load.details.assignee, null)
  assert.equal(unassigned.load.status === 'ready' && unassigned.load.details.item.rev, 9)
})

test("a read that lands after the panel's own write keeps the newer details", () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7, assignedTo: 'Grace Hopper' }) }))
  const reading = refreshing(ready, 3)
  const dennis = { displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example' }
  const written = withAssignee(reading, item(ID, { rev: 8, assignedTo: 'Dennis Ritchie' }), dennis)
  const landed = loaded(written, 3, details({ item: item(ID, { rev: 7, assignedTo: 'Grace Hopper' }) }))
  assert.deepEqual(landed.load, { status: 'ready', details: written.load.status === 'ready' ? written.load.details : null, refreshing: false })
  const newer = details({ item: item(ID, { rev: 9 }) })
  assert.deepEqual(loaded(refreshing(landed, 4), 4, newer).load, { status: 'ready', details: newer, refreshing: false })
})

function tasksOf(state: PanelState) {
  return state.load.status === 'ready' ? state.load.details.tasks : []
}

test("a ticked task takes the answer's state and rev", () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7 }), tasks: [detailTask(5001, { rev: 4 }), detailTask(5002, { rev: 2 })] }))
  const ticked = withTaskRow(ready, 5001, item(5001, { type: 'Task', rev: 5, state: 'Done' }), true)
  assert.deepEqual(
    tasksOf(ticked).map(task => [task.id, task.rev, task.state, task.done]),
    [
      [5001, 5, 'Done', true],
      [5002, 2, 'To Do', false],
    ]
  )
  assert.equal(ticked.load.status === 'ready' && ticked.load.details.item.rev, 7, "the parent isn't touched")

  const reopened = withTaskRow(ticked, 5001, item(5001, { type: 'Task', rev: 6, state: 'In Progress' }), false)
  assert.deepEqual(tasksOf(reopened)[0], { ...tasksOf(ticked)[0], rev: 6, state: 'In Progress', done: false })
  assert.deepEqual(tasksOf(withTaskRow(reopened, 5001, item(5001, { type: 'Task', rev: 5, state: 'Done' }), true)), tasksOf(reopened), 'an older answer is ignored')

  const loading = refreshing(opened(ID, 1), 2)
  assert.equal(withTaskRow(loading, 5001, item(5001, { rev: 5 }), true), loading)
})

test("a new task joins the open tasks in id order, and the parent's rev moves on", () => {
  const ready = loaded(
    refreshing(opened(ID, 1), 2),
    2,
    details({ item: item(ID, { rev: 7 }), tasks: [detailTask(5001), detailTask(6003), detailTask(5002, { done: true, state: 'Done' })] })
  )
  const added = withNewTask(ready, detailTask(6001, { state: 'New', rev: 1 }), item(ID, { rev: 8 }))
  assert.deepEqual(tasksOf(added).map(task => task.id), [5001, 6001, 6003, 5002])
  assert.equal(added.load.status === 'ready' && added.load.details.item.rev, 8)
  assert.equal(added.load.status === 'ready' && added.load.details.moreTasks, 0)

  const fifty = Array.from({ length: 50 }, (_, index) => detailTask(5000 + index, index < 40 ? {} : { done: true, state: 'Done' }))
  const full = loaded(refreshing(opened(ID, 1), 2), 2, details({ tasks: fifty, moreTasks: 3 }))
  const capped = withNewTask(full, detailTask(6001, { state: 'New' }), item(ID, { rev: 8 }))
  assert.equal(tasksOf(capped).length, 50)
  assert.equal(tasksOf(capped)[40].id, 6001)
  assert.equal(capped.load.status === 'ready' && capped.load.details.moreTasks, 4, 'the last done task moves to the unread ones')

  const loading = refreshing(opened(ID, 1), 2)
  assert.equal(withNewTask(loading, detailTask(6001), item(ID, { rev: 8 })), loading)
})

test('a read that lands after a tick keeps every held task row with a higher rev', () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ item: item(ID, { rev: 7 }), tasks: [detailTask(5001, { rev: 1 }), detailTask(5002, { rev: 3 })] }))
  const reading = refreshing(ready, 3)
  const ticked = withTaskRow(reading, 5001, item(5001, { type: 'Task', rev: 2, state: 'Done' }), true)
  const landed = loaded(ticked, 3, details({ item: item(ID, { rev: 7 }), tasks: [detailTask(5001, { rev: 1 }), detailTask(5002, { rev: 4, state: 'In Progress' }), detailTask(5003, { rev: 1 })] }))
  assert.deepEqual(
    tasksOf(landed).map(task => [task.id, task.rev, task.state, task.done]),
    [
      [5001, 2, 'Done', true],
      [5002, 4, 'In Progress', false],
      [5003, 1, 'To Do', false],
    ]
  )
})

test("a read's comments replace the held ones, so a comment deleted meanwhile goes", () => {
  const ready = loaded(refreshing(opened(ID, 1), 2), 2, details({ comments: [comment(32), comment(31)] }))
  const landed = loaded(refreshing(ready, 3), 3, details({ comments: [comment(31)] }))
  assert.deepEqual(landed.load.status === 'ready' && landed.load.details.comments.map(entry => entry.id), [31])
})
