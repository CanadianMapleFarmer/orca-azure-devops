import { assert, test } from 'orca/testing'
import type { WorkItemDetails, WorkItemSummary } from '../../src/shared/work'
import { carriesContext, createContextCache, itemLink, itemPrompt, shortPrompt } from './agents'

const URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/1204'
const LINK = `[ADO User Story #1204: Add vehicle search filters](${URL})`

function details(over: Partial<WorkItemDetails> = {}): WorkItemDetails {
  const item = { org: 'contoso', id: 1204, type: 'User Story', title: 'Add vehicle search filters', url: URL } as WorkItemSummary
  return { item, descriptionMd: '', acceptanceMd: '', comments: [], links: [], assignee: null, tasks: [], moreTasks: 0, tasksRead: true, prs: [], taskTypes: [], taskType: null, readAt: 0, ...over }
}

test('itemLink is the one-line ADO reference', () => {
  assert.equal(itemLink(1204, { type: 'User Story', title: 'Add vehicle search filters', url: URL }), LINK)
})

test('carriesContext matches the reference to this item only at the start of the first line', () => {
  assert.equal(carriesContext(`${LINK}\n\nGo`, 1204), true)
  assert.equal(carriesContext('[ADO Bug #1204: Fix [a] thing](u)', 1204), true)
  assert.equal(carriesContext('[ADO Bug #1301: Regression of #1204: x](u)', 1204), false)
  assert.equal(carriesContext('[ADO Bug #12041: Other](u)', 1204), false)
  assert.equal(carriesContext(`Go\n${LINK}`, 1204), false)
})

test('itemLink escapes backslashes and brackets in the title so the link stays one link', () => {
  const info = { type: 'Bug', title: '[Bug] Search \\ filter](https://example.com/x', url: URL }
  assert.equal(itemLink(7, info), `[ADO Bug #7: \\[Bug\\] Search \\\\ filter\\](https://example.com/x](${URL})`)
})

test('itemPrompt opens with the reference, then the description and acceptance criteria', () => {
  const prompt = itemPrompt(details({ descriptionMd: 'Filter by **make**.', acceptanceMd: '- Filters persist', comments: [{ id: 1, author: 'Ada', createdAt: 1, textMd: 'Secret comment' }] }))
  assert.equal(prompt, `${LINK}\n\n## Description\n\nFilter by **make**.\n\n## Acceptance criteria\n\n- Filters persist`)
})

test('itemPrompt opens with the escaped reference when the title has brackets', () => {
  const bracketed = details({ descriptionMd: 'Body.' })
  bracketed.item = { ...bracketed.item, title: '[Bug] Search' }
  assert.equal(itemPrompt(bracketed), `[ADO User Story #1204: \\[Bug\\] Search](${URL})\n\n## Description\n\nBody.`)
})

test('itemPrompt leaves out an empty section and is just the reference when both are empty', () => {
  assert.equal(itemPrompt(details({ descriptionMd: 'Only this.' })), `${LINK}\n\n## Description\n\nOnly this.`)
  assert.equal(itemPrompt(details({ acceptanceMd: 'Only that.' })), `${LINK}\n\n## Acceptance criteria\n\nOnly that.`)
  assert.equal(itemPrompt(details()), LINK)
})

test('itemPrompt keeps the whole description and acceptance criteria, however long', () => {
  const long = 'a'.repeat(10_000)
  assert.equal(itemPrompt(details({ descriptionMd: long, acceptanceMd: long })), `${LINK}\n\n## Description\n\n${long}\n\n## Acceptance criteria\n\n${long}`)
})

test('shortPrompt is the reference and a pointer to the link', () => {
  assert.equal(shortPrompt(details({ descriptionMd: 'Never shown' })), `${LINK}\n\nRead the description and acceptance criteria at the link above.`)
})

test('the context cache maps a terminal to its workspace, the newest record winning', () => {
  const cache = createContextCache()
  assert.equal(cache.workspaceOf('term-1'), null)
  cache.record('term-1', 'ws-1')
  cache.record('term-1', 'ws-2')
  assert.equal(cache.workspaceOf('term-1'), 'ws-2')
})

test('the context cache remembers which terminals were given the context', () => {
  const cache = createContextCache()
  assert.equal(cache.wasGiven('term-1'), false)
  cache.markGiven('term-1')
  assert.equal(cache.wasGiven('term-1'), true)
  assert.equal(cache.wasGiven('term-2'), false)
})

test('the context cache forgets the oldest given terminal after 500', () => {
  const cache = createContextCache()
  for (let index = 1; index <= 501; index += 1) cache.markGiven(`term-${index}`)
  assert.equal(cache.wasGiven('term-1'), false)
  assert.equal(cache.wasGiven('term-2'), true)
  assert.equal(cache.wasGiven('term-501'), true)
})

test('the context cache keeps at most 500 terminals and drops the oldest', () => {
  const cache = createContextCache()
  for (let index = 1; index <= 501; index += 1) cache.record(`term-${index}`, `ws-${index}`)
  assert.equal(cache.workspaceOf('term-1'), null)
  assert.equal(cache.workspaceOf('term-2'), 'ws-2')
  assert.equal(cache.workspaceOf('term-501'), 'ws-501')
})
