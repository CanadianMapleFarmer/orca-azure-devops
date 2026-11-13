import { assert, test } from 'orca/testing'
import { OPEN_LINK_UNAVAILABLE } from '../shared/messages'
import { CLONE_VALUE } from '../shared/start-flow'
import type { Assignee, CloneTargets, DetailTask, ItemWorkspace, MoveTarget, StartRepos, StartWorkResult, WorkComment, WorkItemDetails, WorkItemSummary } from '../shared/work'
import { createDrafts } from './details-state'
import { find, findAll, fire, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { comment, details, detailTask, item } from './fixtures'
import { createPanel, type PanelApi, type PanelHost } from './panel'

const NOW = Date.parse('2026-11-11T09:00:00Z')
const MINUTE = 60_000
const BOARD = { teamId: '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e', boardId: 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091' }
const STORY = 4211
const OTHER = 4213

const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
const ALEX: Assignee = { displayName: 'Alex Contoso', uniqueName: 'alex@contoso.example' }
const GRACE: Assignee = { displayName: 'Grace Hopper', uniqueName: 'grace@contoso.example' }
const DENNIS: Assignee = { displayName: 'Dennis Ritchie', uniqueName: 'dennis@contoso.example' }

type DetailsInput = Parameters<PanelApi['details']>[0]

interface Asked {
  input: DetailsInput
  resolve(value: WorkItemDetails): void
  reject(error: Error): void
}

interface Pending<I, O> {
  input: I
  resolve(value: O): void
  reject(error: Error): void
}

function recorder<I, O>() {
  const list: Pending<I, O>[] = []
  const call = (input: I) => new Promise<O>((resolve, reject) => list.push({ input, resolve, reject }))
  return { list, call }
}

const fake = (node: HTMLElement) => node as unknown as FakeNode
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { platform?: string; narrow?: boolean } = {}) {
  const items = new Map<number, WorkItemSummary>([
    [STORY, item(STORY, { rev: 7, title: 'Add vehicle search filters' })],
    [OTHER, item(OTHER, { rev: 2, title: 'Show filter counts beside each option' })],
  ])
  const calls: string[] = []
  const moves = recorder<{ id: number; to: MoveTarget }, WorkItemSummary>()
  const comments = recorder<Parameters<PanelApi['comment']>[0], WorkComment>()
  const assigns = recorder<Parameters<PanelApi['assign']>[0], WorkItemSummary>()
  const taskMoves = recorder<Parameters<PanelApi['moveTask']>[0], WorkItemSummary>()
  const adds = recorder<Parameters<PanelApi['addTask']>[0], { task: DetailTask; parent: WorkItemSummary }>()
  const lookups = recorder<Parameters<PanelApi['itemWorkspace']>[0], ItemWorkspace>()
  const repoLists = recorder<Parameters<PanelApi['startRepos']>[0], StartRepos>()
  const targetLists = recorder<Parameters<PanelApi['cloneTargets']>[0], CloneTargets>()
  const works = recorder<Parameters<PanelApi['startWork']>[0], StartWorkResult>()
  let opener: Promise<string | null> = Promise.resolve(null)
  const host: PanelHost = {
    org: 'contoso',
    boardRef: () => BOARD,
    projectId: () => '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d',
    item: id => items.get(id) ?? null,
    move: (id, to) => {
      calls.push(`move ${id} ${JSON.stringify(to)}`)
      return moves.call({ id, to })
    },
    replace: summary => {
      calls.push(`replace ${summary.id} rev ${summary.rev} ${summary.assignedTo}`)
    },
    focusCard: id => {
      calls.push(`focusCard ${id}`)
      return items.has(id)
    },
    focusBoard: () => {
      calls.push('focusBoard')
    },
    openExternal: url => {
      calls.push(`openExternal ${url}`)
      return opener
    },
    showing: id => {
      calls.push(`showing ${id}`)
    },
    narrow: () => options.narrow === true,
  }
  const asked: Asked[] = []
  const api: PanelApi = {
    details: input => new Promise((resolve, reject) => asked.push({ input, resolve, reject })),
    comment: comments.call,
    assign: assigns.call,
    assignees: input => {
      calls.push(`assignees ${input.projectId} ${input.teamId}`)
      return Promise.resolve({ me: ALEX, members: [GRACE, DENNIS] })
    },
    people: () => Promise.resolve([]),
    moveTask: taskMoves.call,
    addTask: adds.call,
    itemWorkspace: lookups.call,
    startRepos: repoLists.call,
    cloneTargets: targetLists.call,
    startWork: works.call,
    startAgent: () => new Promise(() => {}),
    openWorkspace: () => Promise.resolve({ opened: true }),
  }
  const intervals = new Map<number, { run: () => void; ms: number }>()
  const timeouts = new Map<number, { run: () => void; ms: number }>()
  let nextTimer = 1
  const timers = {
    setInterval: ((run: () => void, ms: number) => {
      intervals.set(nextTimer, { run, ms })
      return nextTimer++
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      intervals.delete(id)
    }) as unknown as typeof clearInterval,
    setTimeout: ((run: () => void, ms: number) => {
      timeouts.set(nextTimer, { run, ms })
      return nextTimer++
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number | undefined) => {
      if (id !== undefined) timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
  }
  const clock = { now: NOW }
  const drafts = createDrafts()
  const panel = createPanel(host, api, { now: () => clock.now, locale: () => 'en', drafts, timers, platform: () => options.platform ?? 'Win32' })
  const root = fake(panel.node)
  const part = (match: (node: FakeNode) => boolean) => {
    const node = find(root, match)
    assert.ok(node)
    return node
  }
  return {
    panel,
    root,
    items,
    calls,
    asked,
    moves: moves.list,
    comments: comments.list,
    assigns: assigns.list,
    taskMoves: taskMoves.list,
    adds: adds.list,
    lookups: lookups.list,
    repoLists: repoLists.list,
    targetLists: targetLists.list,
    works: works.list,
    drafts,
    intervals,
    timeouts,
    clock,
    answer: (value: WorkItemDetails, index = asked.length - 1) => asked[index].resolve(value),
    openWith: (promise: Promise<string | null>) => {
      opener = promise
    },
    title: () => part(node => node.tagName === 'h2'),
    fields: () => part(node => node.className === 'fields'),
    meta: () => part(node => node.className === 'panel-meta'),
    labelled: (label: string) => part(node => node.attributes.get('aria-label') === label),
    select: () => part(node => node.tagName === 'select'),
    box: () => part(node => node.tagName === 'textarea'),
    send: () => part(node => node.tagName === 'button' && textOf(node) === 'Comment'),
    hint: () => part(node => node.className === 'muted hint'),
    assignee: () => part(node => node.className === 'assignee'),
    combobox: () => part(node => node.attributes.get('role') === 'combobox'),
    section: (name: string) => part(node => node.tagName === 'section' && node.attributes.get('aria-labelledby') === `panel-${name}-head`),
    articles: () => findAll(root, node => node.tagName === 'article').map(textOf),
    alerts: (section: string) => findAll(part(node => node.tagName === 'section' && node.attributes.get('aria-labelledby') === `panel-${section}-head`), node => node.attributes.get('role') === 'alert').map(textOf),
    taskBox: () => part(node => node.attributes.get('aria-label') === 'Add a task'),
    add: () => part(node => node.tagName === 'button' && textOf(node) === 'Add'),
    row: (title: string) => part(node => node.tagName === 'li' && textOf(node).includes(title)),
    rowTitles: () => findAll(part(node => node.className === 'tasks'), node => node.className === 'task-title').map(textOf),
    fieldAlerts: () => findAll(part(node => node.className === 'fields'), node => node.attributes.get('role') === 'alert').map(textOf),
    foot: () => part(node => node.tagName === 'footer'),
    footControl: (key: string) => {
      const node = find(part(entry => entry.tagName === 'footer'), entry => entry.dataset.start === key)
      assert.ok(node, `a ${key} control in the footer`)
      return node
    },
    footButton: (text: string) => {
      const node = find(part(entry => entry.tagName === 'footer'), entry => entry.tagName === 'button' && textOf(entry) === text)
      assert.ok(node, `a ${text} button in the footer`)
      return node
    },
  }
}

function typeInto(node: FakeNode, text: string): void {
  node.value = text
  fire(node, 'input')
}

function story(rev: number, overrides: Partial<WorkItemSummary> = {}): WorkItemDetails {
  return details({ item: item(STORY, { rev, title: 'Add vehicle search filters', ...overrides }), readAt: NOW })
}

test('opening by keyboard focuses the title, and by pointer leaves focus alone', () => {
  withFakeDom(() => {
    const t = setup()
    t.panel.open(STORY, 'keyboard')
    assert.equal(document.activeElement, t.title())
    assert.equal(t.root.hidden, false)
    assert.equal(t.panel.isOpen(), true)
    assert.equal(t.panel.openId(), STORY)

    const card = document.createElement('div')
    card.focus()
    t.panel.open(OTHER, 'pointer')
    assert.equal(document.activeElement, card)
    assert.equal(textOf(t.title()), 'Show filter counts beside each option')
  })
})

test('on a narrow board, opening by pointer focuses the title too, so Esc closes the sheet', () => {
  withFakeDom(() => {
    const t = setup({ narrow: true })
    const card = document.createElement('div')
    card.focus()
    t.panel.open(STORY, 'pointer')
    assert.equal(document.activeElement, t.title())
    fire(t.title(), 'keydown', { key: 'Escape' })
    assert.equal(t.panel.isOpen(), false)
  })
})

test("a description or comment of 1,500 or 10,000 nested list markers paints, and the last card's text never stays", async () => {
  await withFakeDom(async () => {
    for (const markers of [1_500, 10_000]) {
      const t = setup()
      const nested = '- '.repeat(markers) + 'x'
      t.panel.open(STORY, 'pointer')
      t.answer(details({ ...story(7), descriptionMd: 'Buyers filter by make.', comments: [comment(31, { textMd: 'Looks right.' })] }))
      await settle()
      t.panel.open(OTHER, 'pointer')
      t.answer(details({ item: item(OTHER, { rev: 2, title: 'Show filter counts beside each option' }), descriptionMd: nested, comments: [comment(41, { textMd: nested })], readAt: NOW }))
      await settle()
      const description = textOf(t.section('description'))
      assert.equal(description.includes('Buyers filter by make.'), false, `${markers} markers`)
      assert.ok(description.endsWith('- - x'))
      const articles = t.articles()
      assert.equal(articles.length, 1)
      assert.ok(articles[0].endsWith('- - x'))
    }
  })
})

test('opening another card swaps the panel and reads its details once', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    assert.deepEqual(t.asked.map(entry => entry.input), [{ org: 'contoso', id: STORY, board: BOARD }])

    const scroller = find(t.root, node => node.className === 'panel-scroll') as FakeNode & { scrollTop: number }
    scroller.scrollTop = 240
    t.panel.open(OTHER, 'pointer')
    t.panel.open(OTHER, 'pointer')
    assert.deepEqual(t.asked.map(entry => entry.input.id), [STORY, OTHER])
    assert.equal(scroller.scrollTop, 0)
    assert.equal(t.panel.openId(), OTHER)
    assert.deepEqual(t.calls, [`showing ${STORY}`, `showing ${OTHER}`])

    t.answer(story(7), 0)
    await settle()
    t.panel.boardChanged()
    assert.equal(textOf(t.title()), 'Show filter counts beside each option', "the first card's late answer is ignored")
    assert.equal(textOf(t.meta()), 'Loading details…')
  })
})

test('dragging the open card keeps the panel in step', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7, { column: 'Active' }))
    await settle()
    assert.match(textOf(t.fields()), /^ColumnActive/)
    assert.equal(t.select().value, 'Active')

    t.items.set(STORY, item(STORY, { rev: 7, column: 'Resolved', state: 'Resolved' }))
    t.panel.boardChanged()
    assert.match(textOf(t.fields()), /^ColumnResolved/)
    assert.equal(t.select().value, 'Resolved')
    assert.equal(t.asked.length, 1, 'the pending move costs nothing')

    t.items.set(STORY, item(STORY, { rev: 8, column: 'Resolved', state: 'Resolved' }))
    t.panel.boardChanged()
    assert.equal(t.asked.length, 2)
    assert.deepEqual(t.asked[1].input, { org: 'contoso', id: STORY, board: BOARD })
  })
})

test('closing returns focus to the card, or to the board when the card is gone', () => {
  withFakeDom(() => {
    const t = setup()
    t.panel.open(STORY, 'keyboard')
    fire(t.labelled('Close'), 'click')
    assert.equal(t.panel.isOpen(), false)
    assert.equal(t.panel.openId(), null)
    assert.equal(t.root.hidden, true)
    assert.deepEqual(t.calls, [`showing ${STORY}`, 'showing null', `focusCard ${STORY}`])

    t.calls.length = 0
    t.panel.open(STORY, 'pointer')
    t.items.delete(STORY)
    t.panel.close()
    assert.deepEqual(t.calls, [`showing ${STORY}`, 'showing null', `focusCard ${STORY}`, 'focusBoard'])

    t.calls.length = 0
    t.panel.close()
    assert.deepEqual(t.calls, [], 'closing a closed panel does nothing')
  })
})

test('Esc in the panel closes it', () => {
  withFakeDom(() => {
    const t = setup()
    t.panel.open(STORY, 'keyboard')
    fire(t.title(), 'keydown', { key: 'Enter' })
    assert.equal(t.panel.isOpen(), true)
    const esc = fire(t.title(), 'keydown', { key: 'Escape' })
    assert.equal(t.panel.isOpen(), false)
    assert.equal(esc.defaultPrevented, true)
  })
})

test("a board change with a newer rev reads the details again, and an equal rev doesn't", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    t.panel.boardChanged()
    assert.equal(t.asked.length, 1)

    t.items.set(STORY, item(STORY, { rev: 8, title: 'Add vehicle search filters and sort' }))
    t.panel.boardChanged()
    t.panel.boardChanged()
    assert.equal(t.asked.length, 2, 'one read, however often the board paints')
    assert.equal(t.asked[1].input.fresh, undefined)
    assert.equal(textOf(t.meta()), 'Refreshing…')
    assert.equal(textOf(t.title()), 'Add vehicle search filters and sort', 'the newer card shows meanwhile')

    t.answer(story(8, { title: 'Add vehicle search filters and sort' }))
    await settle()
    t.panel.boardChanged()
    assert.equal(t.asked.length, 2)
    assert.equal(textOf(t.meta()), 'Read just now')
  })
})

test('a newer rev seen during a read is read once more when the read lands', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.items.set(STORY, item(STORY, { rev: 8 }))
    t.panel.boardChanged()
    assert.equal(t.asked.length, 1, 'no second read while the first runs')

    t.answer(story(7))
    await settle()
    assert.equal(t.asked.length, 2)

    t.answer(story(7))
    await settle()
    t.panel.boardChanged()
    assert.equal(t.asked.length, 2, 'an answer still behind the board is not chased again')

    t.items.set(STORY, item(STORY, { rev: 9 }))
    t.panel.boardChanged()
    assert.equal(t.asked.length, 3)
  })
})

test('Refresh asks for fresh details', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    fire(t.labelled('Refresh'), 'click')
    assert.deepEqual(t.asked[1].input, { org: 'contoso', id: STORY, board: BOARD, fresh: true })
    assert.equal(textOf(t.meta()), 'Refreshing…')

    t.asked[1].reject(new Error('Azure DevOps did not respond in time.'))
    await settle()
    const retry = find(t.root, node => node.tagName === 'button' && textOf(node) === 'Try again')
    assert.ok(retry)
    fire(retry, 'click')
    assert.deepEqual(t.asked[2].input, { org: 'contoso', id: STORY, board: BOARD })
  })
})

test('the read age repaints every minute while open, and stops when closed', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    assert.deepEqual([...t.intervals.values()].map(entry => entry.ms), [MINUTE])
    t.answer(story(7))
    await settle()
    assert.equal(textOf(t.meta()), 'Read just now')

    t.clock.now = NOW + 3 * MINUTE
    for (const entry of t.intervals.values()) entry.run()
    assert.equal(textOf(t.meta()), 'Read 3 minutes ago')

    t.panel.open(OTHER, 'pointer')
    assert.equal(t.intervals.size, 1, 'a swap keeps one timer')
    t.panel.close()
    assert.equal(t.intervals.size, 0)
    t.panel.open(STORY, 'pointer')
    assert.equal(t.intervals.size, 1)
    t.panel.dispose()
    assert.equal(t.intervals.size, 0)
  })
})

test("a link opens through the host, and its message shows when Orca can't ask", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    const footer = find(t.root, node => node.tagName === 'a' && textOf(node) === 'Open in Azure DevOps')
    assert.ok(footer)

    fire(footer, 'click')
    assert.equal(t.calls.at(-1), 'openExternal https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/4211', 'called inside the click')
    await settle()
    assert.equal(textOf(t.fields()).includes(OPEN_LINK_UNAVAILABLE), false)

    t.openWith(Promise.resolve(OPEN_LINK_UNAVAILABLE))
    fire(footer, 'click')
    await settle()
    const notice = find(t.fields(), node => node.attributes.get('role') === 'alert')
    assert.equal(notice && textOf(notice), OPEN_LINK_UNAVAILABLE)
  })
})

test('a comment posts once, shows first and clears the draft', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(details({ ...story(7), comments: [comment(31, { textMd: 'Filters look right on staging.' })] }))
    await settle()
    const box = t.box()
    const send = t.send()
    assert.equal(send.disabled, true)
    typeInto(box, 'Needs a floor of 1990.')
    assert.equal(t.drafts.get(STORY, 'comment'), 'Needs a floor of 1990.')
    assert.equal(send.disabled, false)

    fire(box, 'keydown', { key: 'Enter' })
    assert.equal(t.comments.length, 0, 'Enter alone is a new line')
    const sent = fire(box, 'keydown', { key: 'Enter', ctrlKey: true })
    assert.equal(sent.defaultPrevented, true)
    fire(send, 'click')
    assert.deepEqual(t.comments.map(entry => entry.input), [{ org: 'contoso', id: STORY, text: 'Needs a floor of 1990.' }])
    assert.equal(send.disabled, true, 'off while it sends')

    t.comments[0].resolve(comment(32, { author: 'Alex Contoso', textMd: 'Needs a floor of 1990.' }))
    await settle()
    const articles = findAll(t.root, node => node.tagName === 'article')
    assert.deepEqual(articles.map(node => textOf(node).includes('Needs a floor of 1990.')), [true, false])
    assert.equal(box.value, '')
    assert.equal(t.drafts.get(STORY, 'comment'), '')
    assert.equal(send.disabled, true)
    assert.equal(t.asked.length, 1, 'the answer is enough, no read')
  })
})

test('a comment posted while a read runs survives that read landing without it', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(details({ ...story(7), comments: [comment(31, { textMd: 'Filters look right on staging.' })] }))
    await settle()
    fire(t.labelled('Refresh'), 'click')
    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.comments[0].resolve(comment(32, { author: 'Alex Contoso', textMd: 'Needs a floor of 1990.' }))
    await settle()
    t.answer(details({ ...story(7), comments: [comment(31, { textMd: 'Filters look right on staging.' })] }))
    await settle()
    assert.deepEqual(t.articles().map(text => text.includes('Needs a floor of 1990.')), [true, false])
  })
})

test("Refresh drops a newest comment deleted in Azure DevOps that wasn't posted here", async () => {
  await withFakeDom(async () => {
    const t = setup()
    const older = comment(31, { textMd: 'Filters look right on staging.' })
    t.panel.open(STORY, 'pointer')
    t.answer(details({ ...story(7), comments: [comment(32, { textMd: 'Needs a floor of 1990.' }), older] }))
    await settle()
    assert.equal(t.articles().length, 2)

    fire(t.labelled('Refresh'), 'click')
    t.answer(details({ ...story(7), comments: [older] }))
    await settle()
    assert.deepEqual(t.articles().map(text => text.includes('Filters look right on staging.')), [true])
  })
})

test('a comment you posted stays through Refreshes that lack it for 2 minutes, then goes', async () => {
  await withFakeDom(async () => {
    const t = setup()
    const lacking = details({ ...story(7), comments: [comment(31, { textMd: 'Filters look right on staging.' })] })
    t.panel.open(STORY, 'pointer')
    t.answer(lacking)
    await settle()
    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.comments[0].resolve(comment(32, { author: 'Alex Contoso', textMd: 'Needs a floor of 1990.' }))
    await settle()

    t.clock.now += 2 * MINUTE - 1
    fire(t.labelled('Refresh'), 'click')
    t.answer(lacking)
    await settle()
    assert.deepEqual(t.articles().map(text => text.includes('Needs a floor of 1990.')), [true, false])

    t.clock.now += 1
    fire(t.labelled('Refresh'), 'click')
    t.answer(lacking)
    await settle()
    assert.deepEqual(t.articles().map(text => text.includes('Filters look right on staging.')), [true])
  })
})

test('a comment that lands after a swap clears its draft, so coming back shows an empty composer', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.panel.open(OTHER, 'pointer')
    t.comments[0].resolve(comment(32, { textMd: 'Needs a floor of 1990.' }))
    await settle()
    assert.equal(t.drafts.get(STORY, 'comment'), '')

    t.panel.open(STORY, 'pointer')
    t.answer(details({ ...story(7), comments: [comment(32, { textMd: 'Needs a floor of 1990.' })] }))
    await settle()
    assert.equal(t.box().value, '')
    assert.equal(t.send().disabled, true)
  })
})

test('closing and reopening a card while its comment posts keeps Comment off, so it posts once', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.panel.close()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    assert.equal(t.send().disabled, true)
    fire(t.send(), 'click')
    fire(t.box(), 'keydown', { key: 'Enter', ctrlKey: true })
    assert.equal(t.comments.length, 1)

    t.comments[0].resolve(comment(32, { author: 'Alex Contoso', textMd: 'Needs a floor of 1990.' }))
    await settle()
    assert.deepEqual(t.articles().map(text => text.includes('Needs a floor of 1990.')), [true])
    assert.equal(t.box().value, '')
    assert.equal(t.send().disabled, true)
  })
})

test('a comment that fails after a swap shows its message when the card opens again', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.panel.open(OTHER, 'pointer')
    t.comments[0].reject(new Error('Azure DevOps is unreachable.'))
    await settle()

    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    assert.deepEqual(t.alerts('comments'), ['Azure DevOps is unreachable.'])
    assert.equal(t.box().value, 'Needs a floor of 1990.')
    assert.equal(t.send().disabled, false)

    t.panel.open(OTHER, 'pointer')
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await settle()
    assert.deepEqual(t.alerts('comments'), [], 'shown once')
  })
})

test("the footer's start buttons are off while one of the panel's writes runs", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    t.lookups[0].resolve({ workspace: null, unsupported: null })
    await settle()
    assert.equal(t.footButton('Start a workspace and agent').disabled, false)

    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    assert.equal(t.footButton('Start a workspace and agent').disabled, true)
    t.comments[0].resolve(comment(32, { textMd: 'Needs a floor of 1990.' }))
    await settle()
    assert.equal(t.footButton('Start a workspace and agent').disabled, false)
  })
})

test('the send hint follows the platform', async () => {
  await withFakeDom(async () => {
    const mac = setup({ platform: 'MacIntel' })
    mac.panel.open(STORY, 'pointer')
    mac.answer(story(7))
    await settle()
    assert.equal(textOf(mac.hint()), '⌘+Enter sends')
    typeInto(mac.box(), 'Looks right.')
    fire(mac.box(), 'keydown', { key: 'Enter', ctrlKey: true })
    assert.equal(mac.comments.length, 0)
    fire(mac.box(), 'keydown', { key: 'Enter', metaKey: true })
    assert.equal(mac.comments.length, 1)

    const windows = setup({ platform: 'Win32' })
    windows.panel.open(STORY, 'pointer')
    windows.answer(story(7))
    await settle()
    assert.equal(textOf(windows.hint()), 'Ctrl+Enter sends')
    typeInto(windows.box(), 'Looks right.')
    fire(windows.box(), 'keydown', { key: 'Enter', metaKey: true })
    assert.equal(windows.comments.length, 0)
    fire(windows.box(), 'keydown', { key: 'Enter', ctrlKey: true })
    assert.equal(windows.comments.length, 1)
  })
})

test("a move goes through the board's own move, so the card moves too", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7, { column: 'Active' }))
    await settle()
    const select = t.select()
    assert.equal(select.value, 'Active')

    select.value = 'Resolved'
    fire(select, 'change')
    assert.deepEqual(t.calls.filter(call => call.startsWith('move')), [`move ${STORY} {"column":"Resolved"}`])
    assert.equal(select.disabled, true, 'off while the move runs')

    t.moves[0].resolve(item(STORY, { rev: 8, column: 'Resolved', state: 'Resolved', title: 'Add vehicle search filters' }))
    await settle()
    assert.equal(select.disabled, false)
    assert.equal(select.value, 'Resolved')
    assert.equal(t.asked.length, 1)
  })
})

test("a reassignment sends the shown item's rev and updates the card", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer({ ...story(7, { assignedTo: 'Grace Hopper' }), assignee: GRACE })
    await settle()
    t.items.set(STORY, item(STORY, { rev: 8, title: 'Add vehicle search filters', assignedTo: 'Grace Hopper' }))
    t.panel.boardChanged()
    assert.equal(t.asked.length, 2, 'the newer card is being read')

    fire(t.assignee(), 'click')
    await settle()
    assert.equal(t.calls.includes('assignees 4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d 6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'), true)
    assert.equal(document.activeElement, t.combobox())
    typeInto(t.combobox(), 'den')
    fire(t.combobox(), 'keydown', { key: 'Enter' })
    assert.deepEqual(t.assigns.map(entry => entry.input), [{ org: 'contoso', id: STORY, rev: 8, to: DENNIS, board: BOARD }])
    assert.equal(t.assignee().disabled, true, 'off while it saves')

    t.assigns[0].resolve(item(STORY, { rev: 9, title: 'Add vehicle search filters', assignedTo: 'Dennis Ritchie' }))
    await settle()
    assert.equal(t.calls.at(-1), `replace ${STORY} rev 9 Dennis Ritchie`)
    assert.equal(textOf(t.assignee()), 'DRDennis Ritchie')
    assert.equal(t.assignee().disabled, false)
    assert.equal(document.activeElement, t.assignee())

    t.answer({ ...story(8, { assignedTo: 'Grace Hopper' }), assignee: GRACE })
    await settle()
    assert.equal(textOf(t.assignee()), 'DRDennis Ritchie', 'the slower read does not undo it')
  })
})

test('a refused write shows its message under its section and re-reads the details', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer({ ...story(7, { column: 'Active' }), assignee: GRACE })
    await settle()

    typeInto(t.box(), 'Needs a floor of 1990.')
    fire(t.send(), 'click')
    t.comments[0].reject(new Error(CONFLICT))
    await settle()
    assert.deepEqual(t.alerts('comments'), [CONFLICT])
    assert.equal(t.box().value, 'Needs a floor of 1990.', 'the draft stays')
    assert.equal(t.send().disabled, false)
    assert.deepEqual(t.asked.map(entry => entry.input), [
      { org: 'contoso', id: STORY, board: BOARD },
      { org: 'contoso', id: STORY, board: BOARD },
    ])
    t.answer({ ...story(7, { column: 'Active' }), assignee: GRACE })
    await settle()
    assert.deepEqual(t.alerts('comments'), [CONFLICT], 'the message outlasts the re-read')

    const select = t.select()
    select.value = 'Closed'
    fire(select, 'change')
    t.moves[0].reject(new Error(CONFLICT))
    await settle()
    assert.deepEqual(t.fieldAlerts(), [CONFLICT])
    assert.equal(select.value, 'Active', 'the select goes back')
    assert.equal(t.asked.length, 3)
    t.answer({ ...story(7, { column: 'Active' }), assignee: GRACE })
    await settle()

    fire(t.assignee(), 'click')
    await settle()
    fire(t.combobox(), 'keydown', { key: 'ArrowDown' })
    fire(t.combobox(), 'keydown', { key: 'Enter' })
    assert.deepEqual(t.assigns.map(entry => entry.input.to), [ALEX])
    assert.deepEqual(t.fieldAlerts(), [], 'a new write clears the old message')
    t.assigns[0].reject(new Error('You need the Edit work items permission.'))
    await settle()
    assert.deepEqual(t.fieldAlerts(), ['You need the Edit work items permission.'])
    assert.equal(t.assignee().disabled, false)
    assert.equal(t.asked.length, 4)
    assert.equal(t.asked[3].input.fresh, undefined)
  })
})

function withTasks(rev: number, tasks: DetailTask[]): WorkItemDetails {
  return { ...story(rev), tasks }
}

test('ticking a task sends its rev and done state and marks the row busy until the answer', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(
      withTasks(7, [
        detailTask(5001, { rev: 4, title: 'Review the filter copy', state: 'In Progress' }),
        detailTask(5002, { rev: 6, title: 'Write the filter tests', state: 'Done', done: true }),
      ])
    )
    await settle()
    fire(t.labelled('Done: Review the filter copy'), 'change')
    assert.deepEqual(t.taskMoves.map(entry => entry.input), [{ org: 'contoso', id: 5001, rev: 4, state: 'Done', board: BOARD }])
    assert.equal(t.row('Review the filter copy').attributes.get('aria-busy'), 'true')
    assert.equal(t.labelled('Done: Review the filter copy').disabled, true)
    assert.equal(textOf(t.row('Review the filter copy')).includes('Saving…'), true)
    assert.equal(t.labelled('Done: Write the filter tests').disabled, false, 'the other rows stay usable')
    fire(t.labelled('Done: Review the filter copy'), 'change')
    assert.equal(t.taskMoves.length, 1, 'once while it saves')

    document.body.focus()
    t.taskMoves[0].resolve(item(5001, { type: 'Task', rev: 5, state: 'Done', title: 'Review the filter copy' }))
    await settle()
    const ticked = t.labelled('Done: Review the filter copy')
    assert.equal(t.row('Review the filter copy').attributes.has('aria-busy'), false)
    assert.equal(ticked.disabled, false)
    assert.equal(ticked.checked, true)
    assert.equal(textOf(t.row('Review the filter copy')).endsWith('Done'), true)
    assert.equal(document.activeElement, ticked as unknown as Element, 'focus goes back to the row')
    assert.deepEqual(t.rowTitles(), ['Review the filter copy', 'Write the filter tests'], "the row doesn't jump")

    fire(t.labelled('Done: Review the filter copy'), 'change')
    assert.deepEqual(t.taskMoves[1].input, { org: 'contoso', id: 5001, rev: 5, state: 'In Progress', board: BOARD }, "the answer's rev")
    fire(t.labelled('Done: Write the filter tests'), 'change')
    assert.deepEqual(t.taskMoves[2].input, { org: 'contoso', id: 5002, rev: 6, state: 'In Progress', board: BOARD })
    t.taskMoves[2].resolve(item(5002, { type: 'Task', rev: 7, state: 'In Progress', title: 'Write the filter tests' }))
    await settle()
    assert.equal(t.labelled('Done: Write the filter tests').checked, false)
    assert.equal(t.labelled('Done: Review the filter copy').disabled, true, 'the first is still saving')
    assert.equal(t.asked.length, 1, 'the answers are enough, no read')
  })
})

test("a read that started before a tick lands after it, and the row stays ticked at the tick's rev", async () => {
  await withFakeDom(async () => {
    const t = setup()
    const untouched = withTasks(7, [detailTask(5001, { rev: 1, title: 'Review the filter copy', state: 'In Progress' })])
    t.panel.open(STORY, 'pointer')
    t.answer(untouched)
    await settle()
    fire(t.labelled('Refresh'), 'click')
    fire(t.labelled('Done: Review the filter copy'), 'change')
    t.taskMoves[0].resolve(item(5001, { type: 'Task', rev: 2, state: 'Done', title: 'Review the filter copy' }))
    await settle()
    assert.equal(t.labelled('Done: Review the filter copy').checked, true)

    t.answer(untouched)
    await settle()
    assert.equal(t.labelled('Done: Review the filter copy').checked, true)
    fire(t.labelled('Done: Review the filter copy'), 'change')
    assert.deepEqual(t.taskMoves[1].input, { org: 'contoso', id: 5001, rev: 2, state: 'In Progress', board: BOARD })
  })
})

test('a refused tick shows its message under Tasks and re-reads the details', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(withTasks(7, [detailTask(5001, { rev: 4, title: 'Review the filter copy' })]))
    await settle()
    fire(t.labelled('Done: Review the filter copy'), 'change')
    t.taskMoves[0].reject(new Error(CONFLICT))
    await settle()
    assert.deepEqual(t.alerts('children'), [CONFLICT])
    assert.equal(t.labelled('Done: Review the filter copy').checked, false)
    assert.equal(t.labelled('Done: Review the filter copy').disabled, false)
    assert.deepEqual(t.asked.map(entry => entry.input), [
      { org: 'contoso', id: STORY, board: BOARD },
      { org: 'contoso', id: STORY, board: BOARD },
    ])
  })
})

test('adding a task clears the draft, and a refusal keeps it', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(withTasks(7, [detailTask(5001, { title: 'Review the filter copy' })]))
    await settle()
    typeInto(t.taskBox(), 'Add filter analytics')
    assert.equal(t.drafts.get(STORY, 'task'), 'Add filter analytics')
    fire(t.taskBox(), 'keydown', { key: 'Enter' })
    assert.deepEqual(t.adds.map(entry => entry.input), [{ org: 'contoso', parentId: STORY, title: 'Add filter analytics', board: BOARD }])
    assert.equal(t.taskBox().readOnly, true)
    assert.equal(t.add().disabled, true)
    fire(t.taskBox(), 'keydown', { key: 'Enter' })
    assert.equal(t.adds.length, 1, 'once while it adds')

    t.adds[0].resolve({ task: detailTask(6001, { rev: 1, title: 'Add filter analytics', state: 'New' }), parent: item(STORY, { rev: 8, title: 'Add vehicle search filters' }) })
    await settle()
    assert.deepEqual(t.rowTitles(), ['Review the filter copy', 'Add filter analytics'])
    assert.equal(t.taskBox().value, '')
    assert.equal(t.taskBox().readOnly, false)
    assert.equal(t.drafts.get(STORY, 'task'), '')
    assert.equal(t.calls.includes(`replace ${STORY} rev 8 null`), true, "the card takes the parent's new rev")
    assert.equal(t.asked.length, 1)

    typeInto(t.taskBox(), '   ')
    assert.equal(t.add().disabled, true)
    fire(t.taskBox(), 'keydown', { key: 'Enter' })
    assert.equal(t.adds.length, 1, 'a blank title is not sent')

    const tooLong = 'A task title can be at most 255 characters.'
    typeInto(t.taskBox(), 'Add analytics for every filter')
    fire(t.add(), 'click')
    t.adds[1].reject(new Error(tooLong))
    await settle()
    assert.deepEqual(t.alerts('children'), [tooLong])
    assert.equal(t.taskBox().value, 'Add analytics for every filter')
    assert.equal(t.drafts.get(STORY, 'task'), 'Add analytics for every filter')
    assert.equal(t.add().disabled, false)
    assert.equal(t.asked.length, 2)
    t.answer(withTasks(8, [detailTask(5001, { title: 'Review the filter copy' })]))
    await settle()

    fire(t.add(), 'click')
    t.panel.open(OTHER, 'pointer')
    t.adds[2].resolve({ task: detailTask(6002, { rev: 1, title: 'Add analytics for every filter', state: 'New' }), parent: item(STORY, { rev: 9 }) })
    await settle()
    assert.equal(t.drafts.get(STORY, 'task'), '', 'an added task leaves no draft behind, even after a swap')
  })
})

const BRANCH = 'feature/4211-add-vehicle-search-filters'
const SENT: StartWorkResult = { status: 'sent', branch: BRANCH, repo: 'web-app', agent: 'Claude', workspace: { id: 'wt-4211', name: BRANCH }, shortened: false, clone: null }

test('swapping or closing the panel disposes its start', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    assert.deepEqual(t.lookups.map(entry => entry.input), [{ org: 'contoso', id: STORY }])
    t.answer(story(7))
    t.lookups[0].resolve({ workspace: null, unsupported: null })
    await settle()
    fire(t.footButton('Start a workspace and agent'), 'click')
    assert.deepEqual(t.works.map(entry => entry.input), [{ org: 'contoso', id: STORY, board: BOARD }])
    t.works[0].resolve(SENT)
    await settle()
    assert.equal(t.timeouts.size, 1)

    t.panel.open(OTHER, 'pointer')
    assert.equal(t.timeouts.size, 0, 'a swap disposes the start')
    assert.deepEqual(t.lookups.map(entry => entry.input.id), [STORY, OTHER])
    t.answer(details({ item: item(OTHER, { rev: 2 }), readAt: NOW }))
    t.lookups[1].resolve({ workspace: null, unsupported: null })
    await settle()
    t.panel.workspaceReady({ org: 'contoso', itemId: STORY, workspaceId: 'wt-4211', branch: BRANCH })
    assert.equal(textOf(t.foot()).includes(BRANCH), false, "the swapped-out item's events are ignored")
    assert.equal(t.footButton('Start a workspace and agent').disabled, false)

    fire(t.footButton('Start a workspace and agent'), 'click')
    t.works[1].resolve({ ...SENT, branch: 'feature/4213-show-filter-counts' })
    await settle()
    assert.equal(t.timeouts.size, 1)
    t.panel.close()
    assert.equal(t.timeouts.size, 0, 'a close disposes the start')

    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    t.lookups[2].resolve({ workspace: null, unsupported: null })
    await settle()
    fire(t.footButton('Start a workspace and agent'), 'click')
    t.panel.dispose()
    t.works[2].resolve(SENT)
    await settle()
    assert.equal(t.timeouts.size, 0, 'a disposed panel disposes its start')
  })
})

test("the board's events reach the open panel's start", async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    t.lookups[0].resolve({ workspace: null, unsupported: null })
    await settle()
    fire(t.footButton('Start a workspace and agent'), 'click')
    t.works[0].resolve(SENT)
    await settle()
    assert.match(textOf(t.foot()), /Creating feature\/4211-add-vehicle-search-filters in web-app\./)
    assert.equal(t.footButton('Start a workspace and agent').disabled, true)

    t.panel.workspaceReady({ org: 'contoso', itemId: STORY, workspaceId: 'wt-4211', branch: BRANCH })
    assert.match(textOf(t.foot()), /feature\/4211-add-vehicle-search-filters is open, and Claude is starting/)
    assert.equal(t.footButton('Start an agent').disabled, false)
    assert.equal(t.footButton('Open workspace').disabled, false)

    t.panel.agentWorking({ org: 'contoso', itemId: STORY })
    assert.match(textOf(t.foot()), /Claude is working on it\./)
  })
})

const CLONE_HERE = { folder: '~/orca/repos' }
const ROWS: StartRepos['repos'] = [
  { key: 'web-app', name: 'web-app', detail: 'Fabrikam Web', source: 'pr' },
  { key: 'api', name: 'api', detail: 'Fabrikam API', source: 'org' },
]
const TARGETS: CloneTargets = {
  projects: [{ id: 'p-web', name: 'Fabrikam Web', repos: [{ id: 'r-web', name: 'web-app' }, { id: 'r-api', name: 'api' }] }],
  readAt: NOW,
  more: 0,
}

async function offered(t: ReturnType<typeof setup>, repos: StartRepos, id = STORY, at = 0): Promise<void> {
  t.lookups[at].resolve({ workspace: null, unsupported: null })
  await settle()
  t.repoLists[at].resolve(repos)
  await settle()
  assert.equal(t.repoLists[at].input.id, id)
}

test('the panel sends its board with startRepos and startWork', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await offered(t, { repos: ROWS, selected: 'web-app', clone: CLONE_HERE })
    assert.deepEqual(t.repoLists.map(entry => entry.input), [{ org: 'contoso', id: STORY, board: BOARD }])
    assert.match(textOf(t.foot()), /web-app · Fabrikam Web \(linked pull request\)/)

    fire(t.footButton('Start a workspace and agent'), 'click')
    assert.deepEqual(t.works.map(entry => entry.input), [{ org: 'contoso', id: STORY, board: BOARD, repo: { kind: 'orca', key: 'web-app' } }])
  })
})

test('a swap or close disposes a clone list still being read', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await offered(t, { repos: [], selected: null, clone: CLONE_HERE })
    assert.deepEqual(t.targetLists.map(entry => entry.input), [{ org: 'contoso' }])
    assert.match(textOf(t.foot()), /Reading the repository list…/)

    t.panel.open(OTHER, 'pointer')
    t.answer(details({ item: item(OTHER, { rev: 2 }), readAt: NOW }))
    await offered(t, { repos: ROWS, selected: null, clone: CLONE_HERE }, OTHER, 1)
    t.targetLists[0].resolve(TARGETS)
    await settle()
    assert.equal(find(t.foot(), node => node.dataset.start === 'project'), undefined, "the swapped-out item's list is dropped")
    assert.equal(t.footControl('repo').value, '')

    t.footControl('repo').value = CLONE_VALUE
    fire(t.footControl('repo'), 'change')
    assert.equal(t.targetLists.length, 2, "the new item's start reads its own list")
    t.panel.close()
    t.targetLists[1].resolve(TARGETS)
    await settle()
    assert.equal(t.panel.isOpen(), false)
    assert.match(textOf(t.foot()), /Reading the repository list…/, 'a closed panel is not repainted')
  })
})

test('a repaint keeps the focused select and its value', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await offered(t, { repos: ROWS, selected: null, clone: CLONE_HERE })
    const before = t.footControl('repo')
    assert.equal(before.value, '')
    assert.equal(t.footButton('Start a workspace and agent').disabled, true, 'nothing is chosen yet')
    ;(before as unknown as HTMLElement).focus()
    before.value = 'api'
    fire(before, 'change')
    assert.notEqual(t.footControl('repo'), before, 'the footer is repainted')
    assert.equal(t.footControl('repo').value, 'api')
    assert.equal(document.activeElement, t.footControl('repo'))

    t.footControl('repo').value = CLONE_VALUE
    fire(t.footControl('repo'), 'change')
    const reading = t.footControl('repo')
    t.targetLists[0].resolve(TARGETS)
    await settle()
    assert.notEqual(t.footControl('repo'), reading, 'the list repaints the footer')
    assert.equal(t.footControl('repo').value, CLONE_VALUE)
    assert.equal(document.activeElement, t.footControl('repo'))

    ;(t.footControl('project') as unknown as HTMLElement).focus()
    t.footControl('project').value = 'p-web'
    fire(t.footControl('project'), 'change')
    assert.equal(t.footControl('project').value, 'p-web')
    assert.equal(document.activeElement, t.footControl('project'))

    const shown = t.footControl('project')
    for (const entry of t.intervals.values()) entry.run()
    typeInto(t.box(), 'Needs a floor of 1990.')
    assert.equal(t.footControl('project'), shown, 'an unrelated repaint leaves the picker alone')
    assert.equal(document.activeElement, shown)

    t.footControl('clone-repo').value = 'r-api'
    fire(t.footControl('clone-repo'), 'change')
    fire(t.footButton('Start a workspace and agent'), 'click')
    assert.deepEqual(t.works[0].input, { org: 'contoso', id: STORY, board: BOARD, repo: { kind: 'clone', projectId: 'p-web', repoId: 'r-api' } })
  })
})

test('Change repo moves focus to the list it opens', async () => {
  await withFakeDom(async () => {
    const t = setup()
    t.panel.open(STORY, 'pointer')
    t.answer(story(7))
    await offered(t, { repos: ROWS, selected: 'web-app', clone: CLONE_HERE })
    const change = t.footControl('change')
    ;(change as unknown as HTMLElement).focus()
    fire(change, 'click')
    assert.equal(t.footControl('repo').value, 'web-app')
    assert.equal(document.activeElement, t.footControl('repo'))
  })
})
