import type { TreeItem } from 'orca'
import { afterEach, assert, hostError, test, type MockRequests, type TestElement, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import { SEARCH_TOO_SHORT } from '../../shared/messages'
import type { OrgStatus } from '../../shared/types'
import type { DraftSummary, WikiHit, WikiLevel, WikiPage, WikiPageRef, WikiRef, WikiResult } from '../../shared/wiki'
import { closeCleanly, countNodes, mountPanel, org, requestsTo, type MountOptions, type TestHost } from '../test-support'
import {
  CARDS_CONTENT,
  CODE_WIKI,
  draftOf,
  largeLevels,
  LEVELS,
  levelOf,
  MINE_DIFF,
  NOW,
  nodeOf,
  OPEN_PAGE,
  pageOf,
  PAGE_CONTENT,
  PROJECT_WIKI,
  refOf,
  ROOT_PAGES,
  RUNBOOK_URL,
  SERVICES_TABLE,
  STEPS_TABLE,
  THEIRS_DIFF,
  WIKIS
} from './fixtures'
import { MAX_EXPAND_LOADS, MAX_REMEMBERED_FOLDERS, MAX_TREE_ITEMS, search, TREE_BYTES, treeItems } from './state'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

interface OpenOptions {
  orgs?: OrgStatus[]
  persisted?: MountOptions['persisted']
}

async function open(requests: MockRequests = {}, options: OpenOptions = {}) {
  const mounted = await mountPanel(
    options.orgs ?? [org('contoso')],
    {
      'wiki.list': [PROJECT_WIKI],
      'wiki.pages': input => LEVELS[input.path] ?? levelOf([]),
      'wiki.page': input => pageOf(input.path),
      ...requests
    },
    { persisted: { plugin: options.persisted?.plugin, workspace: { tab: 'wiki', ...options.persisted?.workspace } } }
  )
  panel = mounted.panel
  await panel.settled()
  return mounted.host
}

const inputsTo = (host: TestHost, name: string) => requestsTo(host, name).map(call => call.input)

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => unknown): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (check()) return
    await pause(5)
  }
  assert.fail('the panel never reached the expected state')
}

function held<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release: (value: T) => release(value) }
}

const TREE = { type: 'Tree', label: 'Pages' }
const SEARCH_BOX = { type: 'Input', label: 'Search the wiki' }
const BACK = { type: 'Link', text: /^‹ / }

const treeOf = () => (panel.find(TREE)?.props.items ?? []) as TreeItem[]

const keysOf = (items: readonly TreeItem[]) => items.map(item => item.key)

const countItems = (items: readonly TreeItem[]): number => items.reduce((total, item) => total + 1 + countItems(item.children ?? []), 0)

const findItem = (items: readonly TreeItem[], key: string): TreeItem | undefined => {
  for (const item of items) {
    const found = item.key === key ? item : findItem(item.children ?? [], key)
    if (found) return found
  }
  return undefined
}

const itemOf = (key: string) => findItem(treeOf(), key)

const childrenOf = (key: string) => keysOf(itemOf(key)?.children ?? [])

const walkNodes = (node: TreeSnapshot | string | null): TreeSnapshot[] => (node === null || typeof node === 'string' ? [] : [node, ...(node.children ?? []).flatMap(walkNodes)])

const searchRow = (): TreeSnapshot => {
  const holdsSearch = (node: TreeSnapshot) => walkNodes(node).some(inner => inner.type === 'Input' && inner.props?.label === 'Search the wiki')
  const row = walkNodes(panel.tree()).filter(node => node.type === 'Row' && (node.children ?? []).some(child => typeof child !== 'string' && holdsSearch(child))).at(-1)
  assert.ok(row, 'the search row is drawn')
  return row
}

const WIKI_KEY = 'contoso|wiki-project'

const rememberedAt = (key = WIKI_KEY) => (panel.persisted.plugin.wikiExpanded as Record<string, string[]> | undefined)?.[key]

const folderPath = (index: number) => `/Folder ${String(index).padStart(3, '0')}`

function folderLevels(count: number, nested = false): Record<string, WikiLevel> {
  const folders = Array.from({ length: count }, (_, index) => folderPath(index))
  const levels: Record<string, WikiLevel> = { '/': levelOf(folders, {}, folders) }
  for (const folder of folders) levels[folder] = levelOf([`${folder}/One`, `${folder}/Two`])
  if (nested) {
    levels[folderPath(0)] = levelOf([`${folderPath(0)}/Sub`, `${folderPath(0)}/Two`], {}, [`${folderPath(0)}/Sub`])
    levels[`${folderPath(0)}/Sub`] = levelOf([`${folderPath(0)}/Sub/Deep`])
  }
  return levels
}

const pagesFrom = (levels: Record<string, WikiLevel>) => (input: WikiPageRef) => levels[input.path] ?? levelOf([])

const readsOf = (host: TestHost) => inputsTo(host, 'wiki.pages').map(input => (input as WikiPageRef).path)

const button = (text: string, scope?: TestElement) => {
  const found = panel.findAll({ type: 'Button', text }).filter(item => scope === undefined || item.path.startsWith(`${scope.path}/`))
  return found[0] ?? null
}

const inside = (scope: TestElement, query: TestQuery) => panel.findAll(query).filter(item => item.path.startsWith(`${scope.path}/`))

function cardOf(title: string): TestElement {
  const card = panel.findAll({ type: 'Card' }).find(item => item.label === title)
  assert.ok(card, `the card ${title} is drawn`)
  return card
}

const cardTitles = () => panel.findAll({ type: 'Card' }).map(card => card.label)

const calloutsIn = (title: string) => inside(cardOf(title), { type: 'Callout' }).map(callout => [callout.props.tone, callout.props.title ?? null, callout.text])

const diffsIn = (title: string) => inside(cardOf(title), { type: 'CodeView' }).map(view => [view.props.label, view.props.code])

const pressIn = (title: string, text: string) => {
  const found = button(text, cardOf(title))
  assert.ok(found, `${text} is drawn in ${title}`)
  return panel.press(found)
}

const buttonsIn = (title: string) => inside(cardOf(title), { type: 'Button' }).map(item => item.text)

const treeBytes = () => new TextEncoder().encode(JSON.stringify(panel.tree())).length

const heading = () => panel.find({ type: 'Heading' })?.text

const textOf = (node: TreeSnapshot | string): string => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))

const actionsRow = (nodes: readonly TreeSnapshot[]) =>
  nodes.find(node => node.type === 'Row' && (node.children ?? []).some(child => typeof child !== 'string' && child.type === 'Button' && textOf(child) === 'Open in tab'))

const typesOf = (node?: TreeSnapshot) => (node?.children ?? []).flatMap(child => (typeof child === 'string' ? [] : [child.type]))

const partsOf = (row: TreeSnapshot) =>
  (row.children ?? []).flatMap(child => (typeof child === 'string' ? [] : [[child.type, child.type === 'IconButton' ? child.props?.label : textOf(child)]]))

const headerOf = (nodes: readonly TreeSnapshot[]) => {
  const row = actionsRow(nodes)
  return nodes.find(node => node.type === 'Stack' && row !== undefined && (node.children ?? []).includes(row))
}

const markdownOf = () => panel.findAll({ type: 'Markdown' }).map(node => String(node.props.content))

const utf8 = (text: string) => new TextEncoder().encode(text).length

const CONFLICT: WikiResult = {
  status: 'conflict',
  message: 'Someone changed this page in Azure DevOps after you started editing.',
  theirs: { text: THEIRS_DIFF },
  mine: { text: MINE_DIFF }
}

const OPENED = 'Opened Deploy in Orca. Save your changes there, then press Publish here.'

test('the Wiki tab no longer shows the placeholder', async () => {
  const mounted = await mountPanel([org('contoso')], { 'wiki.list': [PROJECT_WIKI], 'wiki.pages': LEVELS['/'] })
  panel = mounted.panel
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'work')
  await panel.select({ type: 'Tabs' }, 'wiki')
  const summary = panel.summary().join('\n')
  assert.equal(summary.includes('Coming in a later update'), false)
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'wiki')
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(panel.persisted.workspace.tab, 'wiki')
})

test('the Wiki tab lists the wikis and the root pages', async () => {
  const host = await open({ 'wiki.list': WIKIS })
  const picker = panel.find({ type: 'Select', label: 'Wiki' })
  assert.deepEqual(picker?.props.options, [
    { value: 'wiki-code', label: 'api-docs · Fabrikam Web' },
    { value: 'wiki-project', label: 'Fabrikam Web.wiki · Fabrikam Web' }
  ])
  assert.equal(picker?.props.value, 'wiki-code')
  assert.deepEqual(inputsTo(host, 'wiki.list'), [{ org: 'contoso' }])
  assert.deepEqual(inputsTo(host, 'wiki.pages'), [{ org: 'contoso', projectId: 'proj-web', wikiId: 'wiki-code', path: '/' }])
  const search = panel.find(SEARCH_BOX)
  assert.deepEqual([search?.props.type, search?.props.labelHidden, search?.props.placeholder], ['search', true, 'Search the wiki'])
  const tree = panel.find(TREE)
  assert.equal(tree?.props.maxHeight, 'lg')
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.deepEqual(
    treeOf().map(item => [item.label, item.icon, item.hasChildren === true]),
    [['Home', 'file-text', false], ['Runbooks', 'folder', true], ['Release notes', 'file-text', false]]
  )
})

test('one wiki shows its name instead of a picker', async () => {
  await open()
  assert.equal(panel.find({ type: 'Select', label: 'Wiki' }), null)
  const name = panel.find({ type: 'Text', text: 'Fabrikam Web.wiki' })
  assert.equal(name?.props.weight, 'semibold')
  assert.ok(panel.find(TREE))
})

test('the wiki chosen in the picker loads its own pages and is remembered', async () => {
  const host = await open({ 'wiki.list': WIKIS })
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  assert.deepEqual(
    inputsTo(host, 'wiki.pages').map(input => (input as WikiPageRef).wikiId),
    ['wiki-code', 'wiki-project']
  )
  assert.deepEqual(panel.persisted.plugin.wikiChoice, { contoso: 'wiki-project' })
  assert.equal(panel.valueOf({ type: 'Select', label: 'Wiki' }), 'wiki-project')
})

test('no wikis shows an empty state', async () => {
  await open({ 'wiki.list': [] })
  const empty = panel.find({ type: 'EmptyState', label: 'No wikis' })
  assert.equal(empty?.props.description, 'Project wikis and published code wikis in this organization show up here.')
  assert.equal(panel.find(SEARCH_BOX), null)
  assert.equal(panel.find(TREE), null)
})

test('a wiki list that fails to load shows the message and Try again', async () => {
  let failing = true
  const host = await open({
    'wiki.list': () => {
      if (failing) throw hostError('action_failed', "Couldn't load wikis.")
      return [PROJECT_WIKI]
    }
  })
  const callout = panel.find({ type: 'Callout' })
  assert.deepEqual([callout?.props.tone, callout?.text], ['danger', "Couldn't load wikis."])
  assert.equal(panel.find(TREE), null)
  failing = false
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(requestsTo(host, 'wiki.list').length, 2)
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
})

test('while the wikis load a skeleton stands in for the header', async () => {
  const answer = held<WikiRef[]>()
  let calls = 0
  await open({
    'wiki.list': () => {
      calls += 1
      if (calls === 1) throw hostError('action_failed', "Couldn't load wikis.")
      return answer.promise
    }
  })
  const retrying = panel.press({ type: 'Button', text: 'Try again' })
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading wikis' }))
  assert.equal(panel.find({ type: 'Skeleton', label: 'Loading wikis' })?.props.lines, 3)
  assert.equal(panel.find({ type: 'Callout' }), null)
  answer.release([PROJECT_WIKI])
  await retrying
  assert.equal(panel.find({ type: 'Skeleton', label: 'Loading wikis' }), null)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
})

test('a root level that fails to load shows the message and Try again', async () => {
  let failing = true
  const host = await open({
    'wiki.pages': () => {
      if (failing) throw hostError('action_failed', "That wiki no longer exists, or you can't see it.")
      return LEVELS['/']
    }
  })
  assert.deepEqual(panel.find({ type: 'Callout' })?.text, "That wiki no longer exists, or you can't see it.")
  assert.ok(panel.find(SEARCH_BOX))
  failing = false
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(requestsTo(host, 'wiki.pages').length, 2)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
})

test('an empty wiki says it has no pages yet', async () => {
  await open({ 'wiki.pages': levelOf([]) })
  assert.ok(panel.find({ type: 'EmptyState', label: 'No pages yet' }))
  assert.equal(panel.find(TREE), null)
})

test('an empty wiki can be refreshed once its first page exists', async () => {
  let pages = levelOf([])
  const host = await open({ 'wiki.pages': () => pages })
  assert.ok(panel.find({ type: 'EmptyState', label: 'No pages yet' }))
  assert.ok(panel.find({ type: 'IconButton', label: 'Refresh pages' }))
  pages = levelOf(['/Home'])
  await panel.press({ type: 'IconButton', label: 'Refresh pages' })
  assert.equal(requestsTo(host, 'wiki.pages').length, 2)
  assert.equal(panel.find({ type: 'EmptyState', label: 'No pages yet' }), null)
  assert.deepEqual(keysOf(treeOf()), ['/Home'])
})

test('expanding a folder loads its children once', async () => {
  const host = await open()
  const loads = () => inputsTo(host, 'wiki.pages').filter(input => (input as WikiPageRef).path === '/Runbooks').length
  assert.equal(loads(), 0)
  await panel.expand(TREE, '/Runbooks')
  assert.equal(loads(), 1)
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  await panel.collapse(TREE, '/Runbooks')
  assert.deepEqual(panel.expandedOf(TREE), [])
  await panel.expand(TREE, '/Runbooks')
  assert.equal(loads(), 1)
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.deepEqual(inputsTo(host, 'wiki.pages').at(1), refOf('/Runbooks'))
})

test('a folder that fails to load collapses and says why, and expanding again retries', async () => {
  let failing = true
  const host = await open({
    'wiki.pages': input => {
      if (input.path === '/Runbooks' && failing) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return LEVELS[input.path] ?? levelOf([])
    }
  })
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), [])
  assert.deepEqual(panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]), [['danger', 'This page was moved or deleted in Azure DevOps.']])
  failing = false
  await panel.expand(TREE, '/Runbooks')
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(inputsTo(host, 'wiki.pages').filter(input => (input as WikiPageRef).path === '/Runbooks').length, 2)
})

test('a capped level ends with a disabled note saying how many pages it shows', async () => {
  const pages = Array.from({ length: 200 }, (_, index) => `/Page ${index}`)
  await open({ 'wiki.pages': levelOf(pages, { total: 340 }) })
  const items = treeOf()
  assert.equal(items.length, 201)
  assert.deepEqual([items[200].label, items[200].disabled], ['Showing 200 of 340 pages', true])
})

test('choosing a page shows it rendered with Open in Azure DevOps', async () => {
  const host = await open()
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(inputsTo(host, 'wiki.page'), [refOf('/Home')])
  assert.equal(panel.find(TREE), null)
  assert.equal(panel.find({ type: 'Heading' })?.props.level, 3)
  assert.equal(heading(), 'Home')
  assert.equal(panel.find({ type: 'Text', text: '/Home' }), null, 'the muted path line is gone')
  assert.equal(panel.find({ type: 'IconButton', label: 'Back' }), null, 'so is the close button')
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, PAGE_CONTENT)
  assert.equal(panel.find({ type: 'Link', text: 'Open in Azure DevOps' })?.props.href, pageOf('/Home').url)
  assert.ok(panel.find({ type: 'IconButton', label: 'Refresh' }))
  assert.deepEqual(panel.persisted.workspace.wikiPage, { ...refOf('/Home'), title: 'Home' })

  await panel.press(BACK)
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(panel.persisted.workspace.wikiPage ?? null, null)
  assert.equal(requestsTo(host, 'wiki.list').length, 1)
})

test('a page shows a back link to its parent, the title and one row of actions', async () => {
  const editRefusal = 'Open a local workspace first; wiki pages open in a tab there.'
  const tabRefusal = 'Open a local workspace of this wiki first.'
  await open(
    { 'wiki.edit': () => ({ opened: false, message: editRefusal }), 'wiki.openInTab': () => ({ opened: false, message: tabRefusal }) },
    { persisted: { workspace: { wikiPage: OPEN_PAGE } } }
  )
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => link.text),
    ['‹ Runbooks', 'Open in Azure DevOps']
  )
  assert.equal(heading(), 'Deploy')
  assert.deepEqual(
    panel.findAll({ type: 'IconButton' }).filter(item => item.label === 'Back' || item.props.icon === 'close'),
    [],
    'no close button'
  )

  const nodes = walkNodes(panel.tree())
  const row = actionsRow(nodes)
  assert.ok(row, 'the actions share one row')
  const header = headerOf(nodes)
  assert.deepEqual(typesOf(header), ['Stack', 'Row'], 'the title block, then the one row')
  assert.deepEqual(typesOf(header?.children?.[0] as TreeSnapshot), ['Link', 'Heading'], 'the back link above the title')
  assert.deepEqual([row.props?.gap, row.props?.align, row.props?.wrap], ['sm', 'center', true])
  assert.deepEqual(partsOf(row), [
    ['Button', 'Open in tab'],
    ['Button', 'Edit in Orca'],
    ['Link', 'Open in Azure DevOps'],
    ['IconButton', 'Refresh']
  ])
  const openInTab = button('Open in tab')
  const edit = button('Edit in Orca')
  assert.deepEqual([openInTab?.props.size, openInTab?.props.variant], ['sm', 'solid'])
  assert.deepEqual([edit?.props.size, edit?.props.variant, edit?.props.icon], ['sm', 'outline', 'edit'])
  const refresh = panel.find({ type: 'IconButton', label: 'Refresh' })
  assert.deepEqual([refresh?.props.variant, refresh?.props.size], ['ghost', 'sm'])

  await panel.press({ type: 'Button', text: 'Open in tab' })
  const tabbed = walkNodes(panel.tree())
  assert.deepEqual(typesOf(headerOf(tabbed)), ['Stack', 'Row', 'Callout'], "Open in tab's refusal sits under the row")
  assert.deepEqual(
    tabbed.filter(node => node.type === 'Callout').map(callout => textOf(callout)),
    [tabRefusal]
  )

  await panel.press({ type: 'Button', text: 'Edit in Orca' })
  const edited = walkNodes(panel.tree())
  assert.deepEqual(typesOf(headerOf(edited)), ['Stack', 'Row', 'Callout', 'Callout'], "Edit's result sits under the row too")
  assert.deepEqual(
    edited.filter(node => node.type === 'Callout').map(callout => textOf(callout)),
    [editRefusal, tabRefusal]
  )
})

test("a top-level page's back link says All pages, and pressing it returns to the tree", async () => {
  await open()
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => link.text),
    ['‹ All pages', 'Open in Azure DevOps']
  )
  await panel.press({ type: 'Link', text: '‹ All pages' })
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.equal(panel.persisted.workspace.wikiPage ?? null, null)
})

test('Refresh reloads the page and shows a failure above it', async () => {
  let content = 'first'
  let failing = false
  const host = await open({
    'wiki.page': input => {
      if (failing) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return pageOf(input.path, { content })
    }
  })
  await panel.selectItem(TREE, '/Home')
  content = 'second'
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, 'second')
  failing = true
  await panel.press({ type: 'IconButton', label: 'Refresh' })
  assert.deepEqual([panel.find({ type: 'Callout' })?.props.tone, panel.find({ type: 'Callout' })?.text], ['danger', 'This page was moved or deleted in Azure DevOps.'])
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, 'second')
  assert.equal(requestsTo(host, 'wiki.page').length, 3)
})

test('a page that fails to load shows the message, Try again and Back', async () => {
  let failing = true
  await open({
    'wiki.page': input => {
      if (failing) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return pageOf(input.path)
    }
  })
  await panel.selectItem(TREE, '/Home')
  assert.equal(heading(), 'Home')
  assert.deepEqual(panel.find({ type: 'Callout' })?.text, 'This page was moved or deleted in Azure DevOps.')
  assert.ok(panel.find(BACK))
  failing = false
  await panel.press({ type: 'Button', text: 'Try again' })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, PAGE_CONTENT)
})

test('while a page loads a skeleton and Back are shown', async () => {
  const answer = held<WikiPage>()
  await open({ 'wiki.page': () => answer.promise })
  const selecting = panel.selectItem(TREE, '/Home')
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading the page' }))
  assert.equal(panel.find({ type: 'Skeleton', label: 'Loading the page' })?.props.lines, 6)
  assert.equal(heading(), 'Home')
  assert.ok(panel.find(BACK))
  answer.release(pageOf('/Home'))
  await selecting
  assert.equal(panel.find({ type: 'Skeleton' }), null)
  assert.ok(panel.find({ type: 'Markdown' }))
})

test('a code wiki page offers Open in tab but not Edit in Orca, and says why', async () => {
  const notice = 'This wiki is published from a repository. Edit its files there.'
  const host = await open({ 'wiki.list': [CODE_WIKI], 'wiki.page': input => pageOf(input.path, { editable: false, notice }) })
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(
    panel.findAll({ type: 'Button' }).map(item => item.text),
    ['Open in tab']
  )
  assert.equal(button('Edit in Orca'), null)
  const note = panel.find({ type: 'Text', text: notice })
  assert.deepEqual([note?.props.muted, note?.props.size], [true, 'sm'])
  assert.deepEqual(typesOf(headerOf(walkNodes(panel.tree()))), ['Stack', 'Row', 'Text'], 'the notice sits under the row')
  assert.equal(requestsTo(host, 'wiki.edit').length, 0)
})

test('an empty page says it has no content yet', async () => {
  await open({ 'wiki.page': input => pageOf(input.path, { content: '  \n' }) })
  await panel.selectItem(TREE, '/Home')
  assert.equal(panel.find({ type: 'Markdown' }), null)
  assert.equal(panel.find({ type: 'Text', text: 'This page has no content yet.' })?.props.muted, true)
})

test('a link that cannot be opened is left out', async () => {
  await open({ 'wiki.page': input => pageOf(input.path, { url: 'javascript:alert(1)' }) })
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(
    panel.findAll({ type: 'Link' }).map(link => link.text),
    ['‹ All pages']
  )
  assert.ok(panel.find({ type: 'Markdown' }))
})

const pageWith = (content: string) => ({ 'wiki.page': (input: WikiPageRef) => pageOf(input.path, { content }) })

test('a Mermaid block in either form becomes a Diagram card with Open in tab', async () => {
  const answer = held<{ opened: boolean; message: string }>()
  const host = await open({ ...pageWith(CARDS_CONTENT), 'wiki.openInTab': () => answer.promise })
  await panel.selectItem(TREE, '/Home')
  const diagrams = ['Diagram · flowchart', 'Diagram · sequence diagram']
  assert.deepEqual(
    cardTitles().filter(title => title?.startsWith('Diagram')),
    diagrams
  )
  for (const title of diagrams) {
    assert.deepEqual(buttonsIn(title), ['Open in tab'])
    const openInTab = button('Open in tab', cardOf(title))
    assert.deepEqual([openInTab?.props.size, openInTab?.props.variant, openInTab?.disabled], ['sm', 'outline', false])
  }
  assert.deepEqual(markdownOf().filter(text => /graph TD|sequenceDiagram|mermaid|:::/.test(text)), [], 'the diagram source is not drawn as text')

  const pressing = pressIn('Diagram · sequence diagram', 'Open in tab')
  await until(() => button('Open in tab')?.disabled)
  assert.deepEqual(
    panel.findAll({ type: 'Button', text: 'Open in tab' }).map(item => item.disabled),
    [true, true, true, true],
    'every Open in tab waits for the one that is running'
  )
  answer.release({ opened: true, message: 'Opened Home in a tab.' })
  await pressing
  assert.deepEqual(inputsTo(host, 'wiki.openInTab'), [refOf('/Home')])
  assert.equal(requestsTo(host, 'wiki.openInTab')[0]?.timeoutMs, 90_000)
  assert.equal(button('Open in tab')?.disabled, false)
})

test('a page keeps its prose in order between its cards, and a link reference below a diagram still works above it', async () => {
  await open(pageWith(CARDS_CONTENT))
  await panel.selectItem(TREE, '/Home')
  const lines = CARDS_CONTENT.split('\n')
  assert.deepEqual(markdownOf(), [
    `${lines.slice(0, 4).join('\n')}\n\n[rb]: ${RUNBOOK_URL}`,
    lines.slice(12, 17).join('\n'),
    lines.slice(21).join('\n')
  ])
  assert.deepEqual(
    walkNodes(panel.tree())
      .filter(node => node.type === 'Markdown' || node.type === 'Card')
      .map(node => (node.type === 'Card' ? node.props?.title : 'Markdown')),
    ['Markdown', 'Diagram · flowchart', 'Table · 4 columns', 'Markdown', 'Diagram · sequence diagram', 'Markdown']
  )
})

test('a wide table becomes a Table card naming its columns, and a narrow one stays in the text', async () => {
  const long = ['| Name | Command | Description |', '| --- | --- | --- |', `| ${'a'.repeat(20)} | ${'b'.repeat(20)} | ${'c'.repeat(20)} |`]
  const single = ['| ' + 'only '.repeat(11) + '|', '| --- |']
  const host = await open(pageWith([...SERVICES_TABLE, '', ...STEPS_TABLE, '', ...long, '', ...single].join('\n')))
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(
    cardTitles().filter(title => title?.startsWith('Table')),
    ['Table · 4 columns', 'Table · 3 columns', 'Table · 1 column']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Card' }).map(card => card.props.description),
    ['Service · Owner · Region · Tier', 'Name · Command · Description', 'only only only only only only only only only only only']
  )
  assert.deepEqual(
    panel.findAll({ type: 'Card' }).map(card => buttonsIn(String(card.label))),
    [['Open in tab'], ['Open in tab'], ['Open in tab']]
  )
  const narrow = markdownOf()
  assert.equal(narrow.length, 1)
  assert.ok(narrow[0].includes('| Deploy | Grace Hopper |'), 'the narrow table stays in the text')
  assert.ok(!narrow[0].includes('Service') && !narrow[0].includes('Command'), 'the wide ones are cards')

  await pressIn('Table · 3 columns', 'Open in tab')
  assert.deepEqual(inputsTo(host, 'wiki.openInTab'), [refOf('/Home')])
})

test('a table with 64 long column names keeps its card description within a label', async () => {
  const names = Array.from({ length: 64 }, (_, index) => `Column ${String(index + 1).padStart(2, '0')} ${'n'.repeat(40)}`)
  await open(pageWith([`| ${names.join(' | ')} |`, `| ${names.map(() => '---').join(' | ')} |`].join('\n')))
  await panel.selectItem(TREE, '/Home')
  const card = panel.find({ type: 'Card' })
  assert.equal(card?.label, 'Table · 64 columns')
  assert.ok(utf8(String(card?.props.description)) <= 1024)
  assert.ok(String(card?.props.description).endsWith('…'))
  assert.ok(String(card?.props.description).startsWith('Column 01'))
})

test('a 60 KiB page with twenty diagrams and tables stays under 4,000 nodes and 450 KiB', async () => {
  const definitions = Array.from({ length: 20 }, (_, index) => `[ref${index}]: ${RUNBOOK_URL}${index}`)
  const uses = definitions.map((_, index) => `[ref${index}]`).join(' ')
  const cardLines = (index: number) =>
    index % 2 === 0 ? ['::: mermaid', 'graph TD', `  A${index} --> B${index}`, ':::'] : ['| a | b | c | d |', '| - | - | - | - |', `| ${index} | 2 | 3 | 4 |`]
  const share = Math.floor((59_500 - utf8(definitions.join('\n')) - 20 * 70) / 21)
  const prose = `${uses} ${'word '.repeat(Math.floor((share - uses.length - 1) / 5))}`
  const content = [...Array.from({ length: 20 }, (_, index) => [prose, '', ...cardLines(index), '']).flat(), prose, '', ...definitions].join('\n')
  assert.ok(utf8(content) > 58_000 && utf8(content) <= 60_000, `${utf8(content)} bytes`)

  await open(pageWith(content))
  await panel.selectItem(TREE, '/Home')
  assert.equal(panel.findAll({ type: 'Card' }).length, 20)
  assert.equal(markdownOf().length, 21)
  assert.ok(markdownOf().every(text => utf8(text) < 64 * 1024))
  assert.ok(markdownOf().every(text => text.includes('[ref19]: ')), 'each stretch of prose keeps its links')
  assert.ok(countNodes(panel.tree()) < 4_000, `${countNodes(panel.tree())} nodes`)
  assert.ok(treeBytes() < 450 * 1024, `${treeBytes()} bytes`)
})

test('Edit in Orca sends wiki.edit and shows the message', async () => {
  let answer: { opened: boolean; message: string } = { opened: true, message: OPENED }
  const host = await open({ 'wiki.edit': () => answer })
  await panel.expand(TREE, '/Runbooks')
  await panel.selectItem(TREE, '/Runbooks/Deploy')
  const edit = button('Edit in Orca')
  assert.deepEqual([edit?.props.icon, edit?.disabled], ['edit', false])
  await panel.press({ type: 'Button', text: 'Edit in Orca' })
  assert.deepEqual(inputsTo(host, 'wiki.edit'), [refOf('/Runbooks/Deploy')])
  assert.equal(requestsTo(host, 'wiki.edit')[0]?.timeoutMs, 90_000)
  assert.deepEqual([panel.find({ type: 'Callout' })?.props.tone, panel.find({ type: 'Callout' })?.text], ['accent', OPENED])
  assert.equal(requestsTo(host, 'wiki.drafts').length, 2)

  answer = { opened: false, message: 'Open a local workspace first; wiki pages open in a tab there.' }
  await panel.press({ type: 'Button', text: 'Edit in Orca' })
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['danger', 'Open a local workspace first; wiki pages open in a tab there.']]
  )
})

test('an Edit that fails shows its message in a danger callout', async () => {
  await open({
    'wiki.edit': () => {
      throw hostError('action_failed', 'The wiki draft folder leads outside this workspace, so nothing was written.')
    }
  })
  await panel.selectItem(TREE, '/Home')
  await panel.press({ type: 'Button', text: 'Edit in Orca' })
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['danger', 'The wiki draft folder leads outside this workspace, so nothing was written.']]
  )
})

test('a second Edit in Orca press before the button redraws sends nothing', async () => {
  const answer = held<{ opened: boolean; message: string }>()
  const host = await open({ 'wiki.edit': () => answer.promise })
  await panel.selectItem(TREE, '/Home')
  const edit = button('Edit in Orca')
  assert.ok(edit)
  const presses = [panel.press(edit), panel.press(edit)]
  await until(() => button('Edit in Orca')?.disabled)
  assert.equal(button('Edit in Orca')?.disabled, true)
  answer.release({ opened: true, message: OPENED })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'wiki.edit').length, 1)
  assert.equal(button('Edit in Orca')?.disabled, false)
})

test('Open in tab sends wiki.openInTab for the page and shows a refusal', async () => {
  const refusal = 'Open a local workspace first; wiki pages open in a tab there.'
  let answer: () => { opened: boolean; message: string } = () => ({ opened: true, message: 'Opened Deploy in a tab.' })
  const host = await open({ 'wiki.openInTab': () => answer() })
  await panel.expand(TREE, '/Runbooks')
  await panel.selectItem(TREE, '/Runbooks/Deploy')
  assert.deepEqual(
    panel.findAll({ type: 'Button' }).map(item => item.text),
    ['Open in tab', 'Edit in Orca']
  )
  const openInTab = button('Open in tab')
  assert.deepEqual([openInTab?.props.size, openInTab?.props.variant, openInTab?.disabled], ['sm', 'solid', false])

  await panel.press({ type: 'Button', text: 'Open in tab' })
  assert.deepEqual(inputsTo(host, 'wiki.openInTab'), [refOf('/Runbooks/Deploy')])
  assert.equal(requestsTo(host, 'wiki.openInTab')[0]?.timeoutMs, 90_000)
  assert.deepEqual(panel.findAll({ type: 'Callout' }), [], 'opening shows nothing')

  answer = () => ({ opened: false, message: refusal })
  await panel.press({ type: 'Button', text: 'Open in tab' })
  assert.deepEqual(panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]), [['danger', refusal]])

  answer = () => {
    throw hostError('action_failed', 'The wiki draft folder leads outside this workspace, so nothing was written.')
  }
  await panel.press({ type: 'Button', text: 'Open in tab' })
  assert.deepEqual(
    panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
    [['danger', 'The wiki draft folder leads outside this workspace, so nothing was written.']]
  )

  answer = () => ({ opened: true, message: 'Opened Deploy in a tab.' })
  await panel.press({ type: 'Button', text: 'Open in tab' })
  assert.deepEqual(panel.findAll({ type: 'Callout' }), [], 'a later opening clears the refusal')
  assert.equal(requestsTo(host, 'wiki.edit').length, 0)
})

test('a code wiki page offers Open in tab as its first action', async () => {
  const notice = 'This wiki is published from a repository. Edit its files there.'
  const host = await open({ 'wiki.list': [CODE_WIKI], 'wiki.page': input => pageOf(input.path, { ...refOf(input.path, CODE_WIKI), editable: false, notice }) })
  await panel.selectItem(TREE, '/Home')
  assert.deepEqual(
    panel.findAll({ type: 'Button' }).map(item => item.text),
    ['Open in tab']
  )
  await panel.press({ type: 'Button', text: 'Open in tab' })
  assert.deepEqual(inputsTo(host, 'wiki.openInTab'), [refOf('/Home', CODE_WIKI)])
})

test('a second Open in tab press before the button redraws sends nothing', async () => {
  const answer = held<{ opened: boolean; message: string }>()
  const host = await open({ 'wiki.openInTab': () => answer.promise })
  await panel.selectItem(TREE, '/Home')
  const openInTab = button('Open in tab')
  assert.ok(openInTab)
  const presses = [panel.press(openInTab), panel.press(openInTab)]
  await until(() => button('Open in tab')?.disabled)
  assert.equal(button('Open in tab')?.disabled, true)
  assert.equal(button('Edit in Orca')?.disabled, false, 'Edit in Orca stays free')
  answer.release({ opened: true, message: 'Opened Home in a tab.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'wiki.openInTab').length, 1)
  assert.equal(button('Open in tab')?.disabled, false)
})

const HITS: WikiHit[] = [
  { path: '/Runbooks/Deploy', title: 'Deploy', snippet: 'Run the release pipeline' },
  { path: '/Home', title: 'Home', snippet: 'Start here' }
]

test('search shows hits and opening one shows the page', async () => {
  const host = await open({ 'wiki.search': { hits: HITS, total: 2 } })
  await panel.type(SEARCH_BOX, 'release')
  assert.equal(requestsTo(host, 'wiki.search').length, 0)
  await panel.submit(SEARCH_BOX)
  assert.deepEqual(inputsTo(host, 'wiki.search'), [{ org: 'contoso', projectId: 'proj-web', wikiId: 'wiki-project', text: 'release' }])
  assert.equal(panel.find(TREE), null)
  const count = panel.find({ type: 'Text', text: '2 pages match' })
  assert.deepEqual([count?.props.muted, count?.props.size], [true, 'sm'])
  assert.equal(panel.find({ type: 'Button', text: 'Clear search' })?.props.variant, 'ghost')
  assert.ok(panel.find({ type: 'List', label: 'Search results' }))
  assert.deepEqual(
    panel.findAll({ type: 'ListItem' }).map(item => [item.label, item.props.description]),
    [['Deploy', '/Runbooks/Deploy · Run the release pipeline'], ['Home', '/Home · Start here']]
  )

  await panel.press({ type: 'ListItem', label: 'Deploy' })
  assert.deepEqual(inputsTo(host, 'wiki.page'), [refOf('/Runbooks/Deploy')])
  assert.equal(heading(), 'Deploy')
  assert.deepEqual(panel.persisted.workspace.wikiPage, { ...refOf('/Runbooks/Deploy'), title: 'Deploy' })

  await panel.press(BACK)
  assert.ok(panel.find({ type: 'List', label: 'Search results' }))
  await panel.press({ type: 'Button', text: 'Clear search' })
  assert.equal(panel.find({ type: 'List', label: 'Search results' }), null)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(panel.valueOf(SEARCH_BOX), '')
})

test('one hit says 1 page matches, and a longer list says how many are shown', async () => {
  let answer = { hits: HITS.slice(0, 1), total: 1 }
  await open({ 'wiki.search': () => answer })
  await panel.type(SEARCH_BOX, 'release', { submit: true })
  assert.ok(panel.find({ type: 'Text', text: '1 page matches' }))
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ }), null)
  answer = { hits: HITS, total: 140 }
  await panel.type(SEARCH_BOX, ' notes', { submit: true })
  assert.ok(panel.find({ type: 'Text', text: '140 pages match' }))
  assert.equal(panel.find({ type: 'Text', text: /^Showing/ })?.text, 'Showing 2 of 140 pages. Narrow the search to see others.')
})

test('a short search shows the message without a request', async () => {
  const host = await open({ 'wiki.search': { hits: HITS, total: 2 } })
  for (const text of ['a', '  a  ', '😀']) {
    await panel.type(SEARCH_BOX, text, { replace: true, submit: true })
    assert.deepEqual(
      panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]),
      [['danger', SEARCH_TOO_SHORT]],
      text
    )
  }
  assert.equal(requestsTo(host, 'wiki.search').length, 0)
  assert.ok(panel.find(TREE))
  await panel.type(SEARCH_BOX, 'ok', { replace: true, submit: true })
  assert.equal(requestsTo(host, 'wiki.search').length, 1)
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a search with no hits says No pages match.', async () => {
  await open({ 'wiki.search': { hits: [], total: 0 } })
  await panel.type(SEARCH_BOX, 'zzz', { submit: true })
  assert.equal(panel.find({ type: 'Text', text: 'No pages match.' })?.props.muted, true)
  assert.ok(panel.find({ type: 'Button', text: 'Clear search' }))
  assert.equal(panel.find({ type: 'List' }), null)
  assert.equal(panel.find(TREE), null)
})

test('a failed search shows its message under the box', async () => {
  await open({
    'wiki.search': () => {
      throw hostError('action_failed', "Wiki search isn't available in this organization.")
    }
  })
  await panel.type(SEARCH_BOX, 'release', { submit: true })
  const callout = panel.find({ type: 'Callout' })
  assert.deepEqual([callout?.props.tone, callout?.text], ['danger', "Wiki search isn't available in this organization."])
  const order = panel.findAll({ type: 'Input' }).concat(panel.findAll({ type: 'Callout' })).map(item => item.type)
  assert.deepEqual(order, ['Input', 'Callout'])
  assert.ok(panel.find(TREE))
})

test('while a search runs a skeleton replaces the tree, and a newer search wins', async () => {
  const first = held<{ hits: WikiHit[]; total: number }>()
  const answers = [first.promise, Promise.resolve({ hits: HITS.slice(1), total: 1 })]
  const host = await open({ 'wiki.search': () => answers.shift() as Promise<{ hits: WikiHit[]; total: number }> })
  const firstSearch = panel.type(SEARCH_BOX, 'release', { submit: true })
  await until(() => panel.find({ type: 'Skeleton', label: 'Searching the wiki' }))
  assert.equal(panel.find(TREE), null)
  const newer = search('notes')
  await until(() => requestsTo(host, 'wiki.search').length === 2)
  await newer
  first.release({ hits: HITS, total: 2 })
  await firstSearch
  assert.deepEqual(
    panel.findAll({ type: 'ListItem' }).map(item => item.label),
    ['Home']
  )
  assert.ok(panel.find({ type: 'Text', text: '1 page matches' }))
  assert.equal(panel.find({ type: 'Skeleton' }), null)
})

test('a search answer for a wiki that is no longer shown is dropped', async () => {
  const answer = held<{ hits: WikiHit[]; total: number }>()
  await open({ 'wiki.list': WIKIS, 'wiki.search': () => answer.promise })
  const searching = panel.type(SEARCH_BOX, 'release', { submit: true })
  await until(() => panel.find({ type: 'Skeleton', label: 'Searching the wiki' }))
  const choosing = panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  await until(() => panel.find({ type: 'Skeleton', label: 'Searching the wiki' }) === null)
  answer.release({ hits: HITS, total: 2 })
  await Promise.all([searching, choosing])
  assert.equal(panel.find({ type: 'List', label: 'Search results' }), null)
  assert.equal(panel.find({ type: 'Skeleton', label: 'Searching the wiki' }), null)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(panel.valueOf(SEARCH_BOX), '')
})

test('Refresh pages reloads the root and the expanded folders', async () => {
  let generation = 0
  const host = await open({
    'wiki.pages': input => (input.path === '/' ? levelOf([`/Home ${generation}`, '/Runbooks'], {}, ['/Runbooks']) : levelOf([`/Runbooks/Deploy ${generation}`]))
  })
  await panel.expand(TREE, '/Runbooks')
  assert.equal(requestsTo(host, 'wiki.pages').length, 2)
  generation = 1
  const refresh = panel.find({ type: 'IconButton', label: 'Refresh pages' })
  assert.equal(refresh?.props.icon, 'refresh')
  assert.equal((searchRow().children as TreeSnapshot[]).at(-1)?.props?.label, 'Refresh pages')
  await panel.press({ type: 'IconButton', label: 'Refresh pages' })
  assert.deepEqual(
    inputsTo(host, 'wiki.pages').slice(2).map(input => (input as WikiPageRef).path).sort(),
    ['/', '/Runbooks']
  )
  assert.deepEqual(keysOf(treeOf()), ['/Home 1', '/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy 1'])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a folder expanded while the pages refresh stays expanded', async () => {
  const slow = held<WikiLevel>()
  let calls = 0
  await open({
    'wiki.pages': input => {
      if (input.path === '/') {
        calls += 1
        return calls === 2 ? slow.promise : LEVELS['/']
      }
      return LEVELS[input.path] ?? levelOf([])
    }
  })
  const refreshing = panel.press({ type: 'IconButton', label: 'Refresh pages' })
  await until(() => panel.find({ type: 'IconButton', label: 'Refresh pages' })?.disabled)
  assert.equal(panel.find({ type: 'IconButton', label: 'Refresh pages' })?.disabled, true)
  const expanding = panel.expand(TREE, '/Runbooks')
  await until(() => panel.expandedOf(TREE).includes('/Runbooks'))
  slow.release(LEVELS['/'])
  await Promise.all([refreshing, expanding])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
})

test('Refresh pages collapses a folder that is gone and keeps the tree when the root fails', async () => {
  let mode: 'ok' | 'folder' | 'root' = 'ok'
  await open({
    'wiki.pages': input => {
      if (mode === 'root' && input.path === '/') throw hostError('action_failed', 'Azure DevOps is not answering.')
      if (mode === 'folder' && input.path === '/Runbooks') throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return LEVELS[input.path] ?? levelOf([])
    }
  })
  await panel.expand(TREE, '/Runbooks')
  mode = 'root'
  await panel.press({ type: 'IconButton', label: 'Refresh pages' })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'Azure DevOps is not answering.')
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(panel.find({ type: 'IconButton', label: 'Refresh pages' })?.disabled, false)
  mode = 'folder'
  await panel.press({ type: 'IconButton', label: 'Refresh pages' })
  assert.equal(panel.find({ type: 'Callout' })?.text, 'This page was moved or deleted in Azure DevOps.')
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), [])
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
})

test('folders show a folder icon and their page count once loaded; pages show a page icon', async () => {
  await open()
  assert.deepEqual(
    treeOf().map(item => [item.label, item.icon, item.description ?? null]),
    [['Home', 'file-text', null], ['Runbooks', 'folder', null], ['Release notes', 'file-text', null]]
  )
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual([itemOf('/Runbooks')?.icon, itemOf('/Runbooks')?.description], ['folder', '2 pages'])
  assert.deepEqual(
    (itemOf('/Runbooks')?.children ?? []).map(item => [item.label, item.icon, item.description ?? null, item.hasChildren === true]),
    [['Deploy', 'file-text', null, false], ['Rollback', 'file-text', null, false]]
  )
})

test('a folder with one page says 1 page, and a capped level counts all of its pages', async () => {
  const levels = {
    '/': levelOf(['/One', '/Many'], {}, ['/One', '/Many']),
    '/One': levelOf(['/One/Only']),
    '/Many': levelOf(['/Many/A', '/Many/B'], { total: 340 })
  }
  await open({ 'wiki.pages': pagesFrom(levels) })
  await panel.expand(TREE, '/One')
  await panel.expand(TREE, '/Many')
  assert.deepEqual([itemOf('/One')?.description, itemOf('/Many')?.description], ['1 page', '340 pages'])
})

test("a folder's count never reads ahead: an unexpanded folder has no description and costs no request", async () => {
  const host = await open()
  assert.equal(itemOf('/Runbooks')?.hasChildren, true)
  assert.equal('description' in (itemOf('/Runbooks') ?? {}), false)
  assert.deepEqual(readsOf(host), ['/'])
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
  await panel.collapse(TREE, '/Runbooks')
  assert.equal(itemOf('/Runbooks')?.description, '2 pages')
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
})

test('the search row holds Collapse all, Expand all and Refresh pages', async () => {
  await open()
  const row = searchRow()
  assert.deepEqual([row.props?.gap, row.props?.align], ['xs', 'center'])
  const [search, ...buttons] = (row.children ?? []) as TreeSnapshot[]
  assert.equal(search.type, 'Box')
  assert.deepEqual([search.props?.grow, search.props?.shrink, search.props?.minWidth], [true, true, 0])
  assert.deepEqual(walkNodes(search).filter(node => node.type === 'Input').map(node => node.props?.label), ['Search the wiki'])
  assert.deepEqual(
    buttons.map(node => [node.type, node.props?.label, node.props?.icon, node.props?.variant, node.props?.size]),
    [
      ['IconButton', 'Collapse all', 'collapse', 'ghost', 'sm'],
      ['IconButton', 'Expand all', 'expand', 'ghost', 'sm'],
      ['IconButton', 'Refresh pages', 'refresh', 'ghost', 'sm']
    ]
  )
  assert.equal(panel.findAll({ type: 'IconButton', label: 'Refresh pages' }).length, 1)
  assert.equal(panel.findAll({ type: 'Row' }).filter(item => item.text === '' && item.props.justify === 'end').length, 0)
})

test('the search row buttons are disabled until the tree has loaded', async () => {
  const root = held<WikiLevel>()
  let calls = 0
  await open({
    'wiki.pages': () => {
      calls += 1
      if (calls === 1) throw hostError('action_failed', "That wiki no longer exists, or you can't see it.")
      return root.promise
    }
  })
  const states = () => ['Collapse all', 'Expand all', 'Refresh pages'].map(label => panel.find({ type: 'IconButton', label })?.disabled)
  assert.deepEqual(states(), [true, true, true])
  const retrying = panel.press({ type: 'Button', text: 'Try again' })
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading pages' }))
  assert.deepEqual(states(), [true, true, true])
  root.release(LEVELS['/'])
  await retrying
  assert.deepEqual(states(), [false, false, false])
})

test('Collapse all closes every folder; Expand all opens the visible ones, loading at most 25 levels a press', async () => {
  const levels = folderLevels(30, true)
  const host = await open({ 'wiki.pages': pagesFrom(levels) })
  const sub = `${folderPath(0)}/Sub`
  const first25 = Array.from({ length: 25 }, (_, index) => folderPath(index))
  assert.equal(readsOf(host).length, 1)

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(readsOf(host).length, 1 + MAX_EXPAND_LOADS)
  assert.deepEqual([...panel.expandedOf(TREE)].sort(), first25)
  assert.deepEqual(childrenOf(folderPath(0)), [sub, `${folderPath(0)}/Two`])
  assert.deepEqual(rememberedAt()?.slice().sort(), first25)

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(readsOf(host).length, 1 + MAX_EXPAND_LOADS + 6)
  assert.equal(panel.expandedOf(TREE).length, 31)
  assert.ok(panel.expandedOf(TREE).includes(sub))
  assert.deepEqual(childrenOf(sub), [`${sub}/Deep`])

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(readsOf(host).length, 1 + MAX_EXPAND_LOADS + 6)

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.equal(treeOf().length, 30)
  assert.equal(treeOf().every(item => item.children === undefined), true)
  assert.deepEqual(rememberedAt(), [])
  assert.equal(readsOf(host).length, 1 + MAX_EXPAND_LOADS + 6)

  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(panel.expandedOf(TREE).length, 30)
  assert.equal(panel.expandedOf(TREE).includes(sub), false)
  assert.equal(readsOf(host).length, 1 + MAX_EXPAND_LOADS + 6)
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('Expand all keeps a folder closed when its level fails to load, and says why', async () => {
  const levels = folderLevels(3)
  await open({
    'wiki.pages': input => {
      if (input.path === folderPath(1)) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return pagesFrom(levels)(input)
    }
  })
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual([...panel.expandedOf(TREE)].sort(), [folderPath(0), folderPath(2)])
  assert.deepEqual(panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]), [['danger', 'This page was moved or deleted in Azure DevOps.']])
  assert.deepEqual(rememberedAt()?.slice().sort(), [folderPath(0), folderPath(2)])
})

test('an Expand all that works clears the failure notice of an earlier one', async () => {
  let failing = true
  const levels = folderLevels(3)
  await open({
    'wiki.pages': input => {
      if (failing && input.path === folderPath(1)) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return pagesFrom(levels)(input)
    }
  })
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(panel.findAll({ type: 'Callout' }).length, 1)
  failing = false
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual([...panel.expandedOf(TREE)].sort(), [folderPath(0), folderPath(1), folderPath(2)])
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('Collapse all clears the failure notice of an Expand all', async () => {
  const levels = folderLevels(3)
  await open({
    'wiki.pages': input => {
      if (input.path === folderPath(1)) throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
      return pagesFrom(levels)(input)
    }
  })
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.equal(panel.findAll({ type: 'Callout' }).length, 1)
  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('Collapse all stops an Expand all that is still loading', async () => {
  const slow = held<WikiLevel>()
  const levels = folderLevels(3)
  const host = await open({ 'wiki.pages': input => (input.path === folderPath(1) ? slow.promise : pagesFrom(levels)(input)) })
  const expanding = panel.press({ type: 'IconButton', label: 'Expand all' })
  await until(() => requestsTo(host, 'wiki.pages').length === 4)
  const collapsing = panel.press({ type: 'IconButton', label: 'Collapse all' })
  await pause(20)
  slow.release(levels[folderPath(1)])
  await Promise.all([expanding, collapsing])
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), [])
})

const WIKI_SELECT = { type: 'Select', label: 'Wiki' }

function holdingFolderOne(levels: Record<string, WikiLevel>, slow: { promise: Promise<WikiLevel> }) {
  return {
    'wiki.list': WIKIS,
    'wiki.pages': (input: WikiPageRef) => (input.wikiId === 'wiki-project' && input.path === folderPath(1) ? slow.promise : pagesFrom(levels)(input))
  }
}

test("switching wiki during Expand all drops the first wiki's late folders", async () => {
  const slow = held<WikiLevel>()
  const levels = folderLevels(3)
  const host = await open(holdingFolderOne(levels, slow), { persisted: { plugin: { wikiChoice: { contoso: 'wiki-project' } } } })
  const expanding = panel.press({ type: 'IconButton', label: 'Expand all' })
  await until(() => readsOf(host).length === 4)
  const switching = panel.select(WIKI_SELECT, 'wiki-code')
  await until(() => readsOf(host).length === 5)
  slow.release(levels[folderPath(1)])
  await Promise.all([expanding, switching])
  assert.equal(panel.valueOf(WIKI_SELECT), 'wiki-code')
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.equal(rememberedAt('contoso|wiki-code'), undefined)
  assert.equal(rememberedAt(), undefined)
})

test("switching wiki while a start reloads remembered folders drops the first wiki's late folders", async () => {
  const slow = held<WikiLevel>()
  const levels = folderLevels(3)
  const remembered = [folderPath(0), folderPath(1), folderPath(2)]
  const host = await open(holdingFolderOne(levels, slow), { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: remembered } } } })
  const starting = panel.select(WIKI_SELECT, 'wiki-project')
  await until(() => readsOf(host).length === 5)
  const switching = panel.select(WIKI_SELECT, 'wiki-code')
  await until(() => readsOf(host).length === 6)
  slow.release(levels[folderPath(1)])
  await Promise.all([starting, switching])
  assert.equal(panel.valueOf(WIKI_SELECT), 'wiki-code')
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), remembered)
  assert.equal(rememberedAt('contoso|wiki-code'), undefined)
})

test('expanded folders are remembered per wiki and reopen after a reload', async () => {
  const requests = { 'wiki.list': WIKIS }
  await open(requests)
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  assert.equal(rememberedAt(), undefined)
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
  assert.equal(rememberedAt('contoso|wiki-code'), undefined)

  const stored = { plugin: panel.persisted.plugin, workspace: panel.persisted.workspace }
  await closeCleanly(panel)
  const host = await open(requests, { persisted: stored })
  assert.equal(panel.valueOf({ type: 'Select', label: 'Wiki' }), 'wiki-project')
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
  assert.deepEqual(rememberedAt(), ['/Runbooks'])

  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-code')
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])

  await panel.collapse(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), [])
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(rememberedAt(), [])
  assert.deepEqual(panel.expandedOf(TREE), [])
})

test('collapsing a folder by hand forgets only that folder, and expanding it again makes it the newest', async () => {
  const levels = folderLevels(3)
  await open({ 'wiki.pages': pagesFrom(levels) })
  await panel.expand(TREE, folderPath(0))
  await panel.expand(TREE, folderPath(1))
  await panel.expand(TREE, folderPath(2))
  assert.deepEqual(rememberedAt(), [folderPath(0), folderPath(1), folderPath(2)])
  await panel.collapse(TREE, folderPath(0))
  assert.deepEqual(rememberedAt(), [folderPath(1), folderPath(2)])
  await panel.expand(TREE, folderPath(0))
  assert.deepEqual(rememberedAt(), [folderPath(1), folderPath(2), folderPath(0)])
  await panel.expand(TREE, folderPath(0))
  assert.deepEqual(rememberedAt(), [folderPath(1), folderPath(2), folderPath(0)])
})

test('a reload with 200 remembered folders sends the root and at most 25 folder reads, and keeps the rest remembered', async () => {
  const levels = folderLevels(201)
  const remembered = Array.from({ length: MAX_REMEMBERED_FOLDERS }, (_, index) => folderPath(index))
  const host = await open({ 'wiki.pages': pagesFrom(levels) }, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: remembered } } } })
  const reads = readsOf(host)
  assert.equal(reads[0], '/')
  assert.equal(reads.length, 1 + MAX_EXPAND_LOADS)
  const newest = remembered.slice(-MAX_EXPAND_LOADS)
  assert.deepEqual(reads.slice(1).sort(), newest)
  assert.deepEqual([...panel.expandedOf(TREE)].sort(), newest)
  assert.deepEqual(rememberedAt(), remembered)

  const closed = folderPath(0)
  await panel.expand(TREE, closed)
  assert.deepEqual(readsOf(host).slice(-1), [closed])
  assert.deepEqual(childrenOf(closed), [`${closed}/One`, `${closed}/Two`])
  assert.deepEqual(rememberedAt(), [...remembered.slice(1), closed])

  const extra = folderPath(200)
  await panel.expand(TREE, extra)
  assert.equal(rememberedAt()?.length, MAX_REMEMBERED_FOLDERS)
  assert.deepEqual(rememberedAt()?.slice(-2), [closed, extra])
  assert.equal(rememberedAt()?.includes(folderPath(1)), false)
})

test('a remembered folder reloads only after its parent has', async () => {
  const slow = held<WikiLevel>()
  const levels = {
    '/': levelOf(['/A'], {}, ['/A']),
    '/A': levelOf(['/A/B'], {}, ['/A/B']),
    '/A/B': levelOf(['/A/B/C'], {}, ['/A/B/C']),
    '/A/B/C': levelOf(['/A/B/C/D'])
  }
  let failing = true
  const host = await open(
    {
      'wiki.pages': input => {
        if (input.path === '/' && failing) throw hostError('action_failed', 'Azure DevOps is not answering.')
        return input.path === '/A' ? slow.promise : pagesFrom(levels)(input)
      }
    },
    { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/A/B/C', '/A/B', '/A'] } } } }
  )
  failing = false
  const retrying = panel.press({ type: 'Button', text: 'Try again' })
  await until(() => readsOf(host).includes('/A'))
  await pause(30)
  assert.deepEqual(readsOf(host), ['/', '/', '/A'])
  slow.release(levels['/A'])
  await retrying
  assert.deepEqual(readsOf(host), ['/', '/', '/A', '/A/B', '/A/B/C'])
  assert.deepEqual([...panel.expandedOf(TREE)].sort(), ['/A', '/A/B', '/A/B/C'])
})

test('a remembered folder whose parent no longer lists it is forgotten, and so are its subfolders', async () => {
  const host = await open(
    { 'wiki.pages': pagesFrom(LEVELS) },
    { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/Gone/Child', '/Runbooks', '/Gone', '/Home'] } } } }
  )
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
})

test('expanding a folder by hand forgets a remembered subfolder that its level no longer lists', async () => {
  const levels = {
    '/': levelOf(['/A'], {}, ['/A']),
    '/A': levelOf(['/A/B', '/A/C'], {}, ['/A/C'])
  }
  const host = await open({ 'wiki.pages': pagesFrom(levels) }, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/A/B'] } } } })
  assert.deepEqual(readsOf(host), ['/'])
  assert.deepEqual(rememberedAt(), ['/A/B'])
  await panel.expand(TREE, '/A')
  assert.deepEqual(rememberedAt(), ['/A'])
  assert.deepEqual(panel.expandedOf(TREE), ['/A'])
})

test('Refresh pages collapses and forgets a folder that its parent now lists as a page', async () => {
  let folder = true
  const host = await open({ 'wiki.pages': input => (input.path === '/' && !folder ? levelOf(ROOT_PAGES) : (LEVELS[input.path] ?? levelOf([]))) })
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
  folder = false
  await panel.press({ type: 'IconButton', label: 'Refresh pages' })
  assert.deepEqual(readsOf(host).slice(-2), ['/', '/Runbooks'])
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), [])
  assert.equal(itemOf('/Runbooks')?.hasChildren, false)
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('a subfolder that vanished under a folder opened by Expand all is forgotten', async () => {
  const levels = {
    '/': levelOf(['/A'], {}, ['/A']),
    '/A': levelOf(['/A/Gone'])
  }
  const host = await open({ 'wiki.pages': pagesFrom(levels) }, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/A/Gone'] } } } })
  assert.deepEqual(readsOf(host), ['/'])
  assert.deepEqual(rememberedAt(), ['/A/Gone'])
  await panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(readsOf(host), ['/', '/A'])
  assert.deepEqual(panel.expandedOf(TREE), ['/A'])
  assert.deepEqual(rememberedAt(), ['/A'])
})

test('a subfolder that vanished under a remembered folder is forgotten when a start reopens it', async () => {
  const levels = {
    '/': levelOf(['/A'], {}, ['/A']),
    '/A': levelOf(['/A/Gone'])
  }
  const host = await open({ 'wiki.pages': pagesFrom(levels) }, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/A/Gone', '/A'] } } } })
  assert.deepEqual(readsOf(host), ['/', '/A'])
  assert.deepEqual(panel.expandedOf(TREE), ['/A'])
  assert.deepEqual(rememberedAt(), ['/A'])
})

test('a capped level keeps a remembered folder it does not list', async () => {
  const levels = { '/': levelOf(['/A'], { total: 340 }, ['/A']) }
  const host = await open({ 'wiki.pages': pagesFrom(levels) }, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/Z'] } } } })
  assert.deepEqual(readsOf(host), ['/'])
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(rememberedAt(), ['/Z'])
})

test('a remembered folder that fails to load stays closed, is forgotten and says why', async () => {
  const host = await open(
    {
      'wiki.pages': input => {
        if (input.path === '/Runbooks') throw hostError('action_failed', 'This page was moved or deleted in Azure DevOps.')
        return LEVELS[input.path] ?? levelOf([])
      }
    },
    { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: ['/Runbooks'] } } } }
  )
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]), [['danger', 'This page was moved or deleted in Azure DevOps.']])
  assert.deepEqual(rememberedAt(), [])
})

test('a remembered folder too deep for the tree is not read', async () => {
  const chain = Array.from({ length: 18 }, (_, index) => `/${Array.from({ length: index + 1 }, (_, part) => `d${part}`).join('/')}`)
  const below = (path: string) => (path === '/' ? chain[0] : chain[chain.indexOf(path) + 1])
  const host = await open(
    { 'wiki.pages': input => (below(input.path) === undefined ? levelOf([]) : levelOf([below(input.path)], {}, [below(input.path)])) },
    { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: chain } } } }
  )
  assert.deepEqual(readsOf(host), ['/', ...chain.slice(0, 15)])
  assert.equal(panel.expandedOf(TREE).length, 15)
  assert.equal(countItems(treeOf()), 16)
  assert.deepEqual(rememberedAt(), chain)
})

test('a remembered list that is not a list of paths is read as empty', async () => {
  const host = await open({}, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: 'nonsense' } } } })
  assert.deepEqual(readsOf(host), ['/'])
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), ['/Runbooks'])
})

test('a remembered list with entries that are not paths keeps only the paths', async () => {
  const host = await open({}, { persisted: { plugin: { wikiExpanded: { [WIKI_KEY]: [3, null, '/Runbooks'] } } } })
  assert.deepEqual(readsOf(host), ['/', '/Runbooks'])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  await panel.collapse(TREE, '/Runbooks')
  assert.deepEqual(rememberedAt(), [])
})

test('going back from a page shows it selected with its folders expanded', async () => {
  const first = await open({}, { persisted: { workspace: { wikiPage: OPEN_PAGE } } })
  assert.equal(heading(), 'Deploy')
  assert.equal(requestsTo(first, 'wiki.pages').length, 0)
  await panel.press(BACK)
  assert.deepEqual(readsOf(first), ['/', '/Runbooks'])
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(panel.find(TREE)?.props.selected, '/Runbooks/Deploy')
  assert.deepEqual(rememberedAt(), ['/Runbooks'])

  await panel.selectItem(TREE, '/Runbooks/Rollback')
  assert.equal(heading(), 'Rollback')
  await panel.press(BACK)
  assert.equal(panel.find(TREE)?.props.selected, '/Runbooks/Rollback')
  assert.deepEqual(readsOf(first), ['/', '/Runbooks'])
})

test('going back to a page found by search loads and opens its folders, parents first', async () => {
  const levels = {
    '/': levelOf(['/A'], {}, ['/A']),
    '/A': levelOf(['/A/B'], {}, ['/A/B']),
    '/A/B': levelOf(['/A/B/Page', '/A/B/Other'])
  }
  const host = await open({
    'wiki.pages': pagesFrom(levels),
    'wiki.search': { hits: [{ path: '/A/B/Page', title: 'Page', snippet: 'found it' }], total: 1 }
  })
  assert.deepEqual(readsOf(host), ['/'])
  await panel.type(SEARCH_BOX, 'found', { submit: true })
  await panel.press({ type: 'ListItem', label: 'Page' })
  assert.equal(heading(), 'Page')
  await panel.press(BACK)
  await until(() => readsOf(host).length === 3)
  assert.deepEqual(readsOf(host), ['/', '/A', '/A/B'])
  await panel.press({ type: 'Button', text: 'Clear search' })
  assert.deepEqual(panel.expandedOf(TREE), ['/A', '/A/B'])
  assert.deepEqual(rememberedAt(), ['/A', '/A/B'])
  assert.equal(panel.find(TREE)?.props.selected, '/A/B/Page')
  assert.deepEqual(childrenOf('/A'), ['/A/B'])
})

test('a page that is not in the tree is not marked selected, and another wiki has no selection', async () => {
  await open({ 'wiki.list': WIKIS, 'wiki.search': { hits: [{ path: '/Elsewhere', title: 'Elsewhere', snippet: 'x' }], total: 1 } })
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  await panel.selectItem(TREE, '/Home')
  await panel.press(BACK)
  assert.equal(panel.find(TREE)?.props.selected, '/Home')
  assert.equal(rememberedAt(), undefined)
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-code')
  assert.equal(panel.find(TREE)?.props.selected, undefined)
  await panel.type(SEARCH_BOX, 'else', { submit: true })
  await panel.press({ type: 'ListItem', label: 'Elsewhere' })
  await panel.press(BACK)
  await panel.press({ type: 'Button', text: 'Clear search' })
  assert.equal(panel.find(TREE)?.props.selected, undefined)
})

test('drafts show a skeleton while loading and the message if they fail', async () => {
  const answer = held<DraftSummary[]>()
  let calls = 0
  const host = await open({
    'wiki.drafts': () => {
      calls += 1
      if (calls === 1) throw hostError('action_failed', "Couldn't read your drafts.")
      return answer.promise
    }
  })
  assert.deepEqual(panel.findAll({ type: 'Callout' }).map(callout => [callout.props.tone, callout.text]), [['danger', "Couldn't read your drafts."]])
  assert.ok(panel.find({ type: 'Button', text: 'Try again' }))
  assert.ok(panel.find(TREE))
  const retrying = panel.press({ type: 'Button', text: 'Try again' })
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading drafts' }))
  assert.equal(panel.find({ type: 'Skeleton', label: 'Loading drafts' })?.props.lines, 2)
  assert.equal(panel.find({ type: 'Callout' }), null)
  answer.release([draftOf('/Home')])
  await retrying
  assert.equal(panel.find({ type: 'Skeleton', label: 'Loading drafts' }), null)
  assert.deepEqual(cardTitles(), ['Home'])
  assert.equal(requestsTo(host, 'wiki.drafts').length, 2)
})

const DEPLOY = draftOf('/Runbooks/Deploy', { changed: true })
const HOME = draftOf('/Home', { publishedAt: NOW - 60_000 })

test('Drafts shows each draft with Publish, Open and Discard', async () => {
  const host = await open({ 'wiki.drafts': [DEPLOY, HOME] })
  assert.deepEqual(inputsTo(host, 'wiki.drafts'), [{ org: 'contoso' }])
  const drafts = panel.find({ type: 'Collapsible', label: 'Drafts (2)' })
  assert.equal(drafts?.props.defaultOpen, true)
  assert.deepEqual(cardTitles(), ['Deploy', 'Home'])
  const deploy = cardOf('Deploy')
  assert.equal(deploy.props.description, 'Fabrikam Web.wiki · in web-app')
  assert.deepEqual(
    inside(deploy, { type: 'Text' }).map(text => [text.text, text.props.muted, text.props.size]),
    [
      ['.orca-ado/wiki/Fabrikam-Web.wiki/Runbooks/Deploy.md', true, 'sm'],
      ['Saved changes not published yet.', true, 'sm']
    ]
  )
  const home = inside(cardOf('Home'), { type: 'Text' })
  assert.match(home[1].text, /^No changes since you opened or published it\. Published /)
  assert.equal(home[1].props.muted, true)
  assert.deepEqual(inside(cardOf('Home'), { type: 'RelativeTime' }).map(time => time.props.at), [NOW - 60_000])
  assert.deepEqual(
    inside(deploy, { type: 'Button' }).map(item => [item.text, item.props.size, item.props.variant ?? null, item.props.tone ?? null, item.disabled]),
    [
      ['Publish', 'sm', null, null, false],
      ['Open', 'sm', 'outline', null, false],
      ['Discard…', 'sm', 'ghost', 'danger', false]
    ]
  )
  assert.equal(inside(deploy, { type: 'Callout' }).length, 0)
})

test('no drafts shows no Drafts section', async () => {
  await open({ 'wiki.drafts': [] })
  assert.equal(panel.find({ type: 'Collapsible' }), null)
  assert.equal(panel.find({ type: 'Skeleton' }), null)
})

test('Open on a draft sends wiki.edit for its page and shows the message in the card', async () => {
  const host = await open({ 'wiki.drafts': [DEPLOY], 'wiki.edit': { opened: true, message: OPENED } })
  await pressIn('Deploy', 'Open')
  assert.deepEqual(inputsTo(host, 'wiki.edit'), [refOf('/Runbooks/Deploy')])
  assert.deepEqual(calloutsIn('Deploy'), [['accent', null, OPENED]])
  assert.equal(requestsTo(host, 'wiki.drafts').length, 2)
})

test('Publish sends the draft key and shows the result, and the list reloads', async () => {
  const answers: WikiResult[] = [
    { status: 'published', message: 'Published.' },
    { status: 'unchanged', message: 'Nothing to publish yet. Save your changes in the editor first.' },
    { status: 'failed', message: 'This page was moved or deleted in Azure DevOps. Your draft is kept.' }
  ]
  const host = await open({ 'wiki.drafts': [DEPLOY], 'wiki.publish': () => answers.shift() as WikiResult })
  const expectations = [
    ['success', 'Published.'],
    ['neutral', 'Nothing to publish yet. Save your changes in the editor first.'],
    ['danger', 'This page was moved or deleted in Azure DevOps. Your draft is kept.']
  ]
  for (const [index, [tone, message]] of expectations.entries()) {
    await pressIn('Deploy', 'Publish')
    assert.deepEqual(calloutsIn('Deploy'), [[tone, null, message]])
    assert.equal(requestsTo(host, 'wiki.drafts').length, index + 2)
  }
  assert.deepEqual(inputsTo(host, 'wiki.publish'), [{ key: DEPLOY.key }, { key: DEPLOY.key }, { key: DEPLOY.key }])
  assert.equal(requestsTo(host, 'wiki.publish')[0]?.timeoutMs, 90_000)
})

test('a successful Publish reloads its page when that page is open; a failed or conflicting one, or another page, does not', async () => {
  let content = 'before'
  let answer = held<WikiResult>()
  const host = await open({
    'wiki.drafts': [DEPLOY, HOME],
    'wiki.publish': () => answer.promise,
    'wiki.resolve': () => answer.promise,
    'wiki.page': input => pageOf(input.path, { content })
  })
  const shownText = () => panel.find({ type: 'Markdown' })?.props.content
  const pageReads = () => requestsTo(host, 'wiki.page').length
  const whileHomeIsOpen = async (card: string, text: string, result: WikiResult) => {
    if (panel.find(BACK)) await panel.press(BACK)
    answer = held<WikiResult>()
    const pressing = pressIn(card, text)
    await until(() => button('Publish', cardOf(card))?.disabled)
    const selecting = panel.selectItem(TREE, '/Home')
    await until(() => heading() === 'Home' && shownText() !== undefined)
    const opened = shownText()
    content = `after ${text} ${result.status}`
    answer.release(result)
    await Promise.all([pressing, selecting])
    return opened
  }

  await whileHomeIsOpen('Home', 'Publish', { status: 'published', message: 'Published.' })
  assert.equal(shownText(), 'after Publish published')
  assert.equal(pageReads(), 2, 'opened, then read again after the Publish')

  const beforeConflict = await whileHomeIsOpen('Home', 'Publish', CONFLICT)
  assert.equal(shownText(), beforeConflict)
  assert.equal(pageReads(), 3)

  await panel.press(BACK)
  await pressIn('Home', 'Publish mine…')
  await whileHomeIsOpen('Home', 'Publish mine', { status: 'published', message: 'Published. Their changes were replaced.' })
  assert.equal(shownText(), 'after Publish mine published')
  assert.equal(pageReads(), 5)

  const beforeFailure = await whileHomeIsOpen('Home', 'Publish', { status: 'failed', message: 'This page was moved or deleted in Azure DevOps. Your draft is kept.' })
  assert.equal(shownText(), beforeFailure)
  assert.equal(pageReads(), 6)

  const beforeOther = await whileHomeIsOpen('Deploy', 'Publish', { status: 'published', message: 'Published.' })
  assert.equal(shownText(), beforeOther)
  assert.equal(pageReads(), 7, 'another page was published')
  assert.deepEqual(inputsTo(host, 'wiki.page'), Array.from({ length: 7 }, () => refOf('/Home')))
})

test('a Publish that throws shows its message in the card', async () => {
  await open({
    'wiki.drafts': [DEPLOY],
    'wiki.publish': () => {
      throw hostError('action_failed', 'That draft no longer exists.')
    }
  })
  await pressIn('Deploy', 'Publish')
  assert.deepEqual(calloutsIn('Deploy'), [['danger', null, 'That draft no longer exists.']])
})

test('a conflict shows both diffs and the three choices; Publish mine and Take theirs ask first', async () => {
  const resolved: WikiResult[] = [
    { status: 'published', message: 'Published. Their changes were replaced.' },
    { status: 'updated', message: 'Your draft now holds their version.' },
    { status: 'updated', message: "Opened their version as .orca-ado/wiki/X.theirs.md. Copy what you need into your draft, save it, then press Publish." }
  ]
  const host = await open({
    'wiki.drafts': [DEPLOY],
    'wiki.publish': CONFLICT,
    'wiki.resolve': () => resolved.shift() as WikiResult
  })
  await pressIn('Deploy', 'Publish')
  const [callout] = inside(cardOf('Deploy'), { type: 'Callout' })
  assert.deepEqual([callout.props.tone, callout.props.title], ['warning', 'This page changed in Azure DevOps'])
  assert.ok(callout.text.includes(CONFLICT.message))
  assert.deepEqual(diffsIn('Deploy'), [['Their changes', THEIRS_DIFF], ['Your changes', MINE_DIFF]])
  const views = inside(cardOf('Deploy'), { type: 'CodeView' })
  assert.deepEqual(views.map(view => [view.props.language, view.props.lineNumbers, view.props.maxHeight]), [['diff', false, 'md'], ['diff', false, 'md']])
  assert.deepEqual(
    inside(cardOf('Deploy'), { type: 'Text', text: /^(Their|Your) changes$/ }).map(text => [text.text, text.props.weight]),
    [['Their changes', 'semibold'], ['Your changes', 'semibold']]
  )
  assert.deepEqual(buttonsIn('Deploy'), ['Publish', 'Open', 'Discard…', 'Publish mine…', 'Take theirs…', 'Merge by hand'])
  assert.equal(button('Merge by hand')?.props.variant, 'outline')

  await pressIn('Deploy', 'Publish mine…')
  assert.equal(requestsTo(host, 'wiki.resolve').length, 0)
  const question = inside(cardOf('Deploy'), { type: 'Text', text: 'Publish your draft over their changes? Their changes are lost.' })
  assert.equal(question.length, 1)
  assert.deepEqual(
    inside(cardOf('Deploy'), { type: 'Button' }).slice(3).map(item => [item.text, item.props.variant ?? null, item.props.tone ?? null]),
    [['Publish mine', null, 'danger'], ['Cancel', 'ghost', null]]
  )
  await pressIn('Deploy', 'Cancel')
  assert.equal(requestsTo(host, 'wiki.resolve').length, 0)
  assert.deepEqual(buttonsIn('Deploy').slice(3), ['Publish mine…', 'Take theirs…', 'Merge by hand'])

  await pressIn('Deploy', 'Publish mine…')
  await pressIn('Deploy', 'Publish mine')
  assert.deepEqual(inputsTo(host, 'wiki.resolve'), [{ key: DEPLOY.key, choice: 'mine' }])
  assert.equal(requestsTo(host, 'wiki.resolve')[0]?.timeoutMs, 90_000)
  assert.deepEqual(calloutsIn('Deploy'), [['success', null, 'Published. Their changes were replaced.']])
  assert.deepEqual(diffsIn('Deploy'), [])

  await pressIn('Deploy', 'Publish')
  await pressIn('Deploy', 'Take theirs…')
  assert.ok(inside(cardOf('Deploy'), { type: 'Text', text: 'Replace your draft with their version? Your changes are lost.' }).length === 1)
  assert.deepEqual(
    inside(cardOf('Deploy'), { type: 'Button' }).slice(3).map(item => [item.text, item.props.variant ?? null, item.props.tone ?? null]),
    [['Take theirs', null, 'danger'], ['Cancel', 'ghost', null]]
  )
  await pressIn('Deploy', 'Take theirs')
  assert.deepEqual(inputsTo(host, 'wiki.resolve').at(-1), { key: DEPLOY.key, choice: 'theirs' })
  assert.deepEqual(calloutsIn('Deploy'), [['success', null, 'Your draft now holds their version.']])

  await pressIn('Deploy', 'Publish')
  await pressIn('Deploy', 'Merge by hand')
  assert.deepEqual(inputsTo(host, 'wiki.resolve').at(-1), { key: DEPLOY.key, choice: 'merge' })
  assert.equal(requestsTo(host, 'wiki.resolve').length, 3)
  assert.equal(calloutsIn('Deploy')[0][0], 'success')
})

test('a version without text shows its message instead of a diff', async () => {
  await open({
    'wiki.drafts': [DEPLOY],
    'wiki.publish': {
      status: 'conflict',
      message: CONFLICT.status === 'conflict' ? CONFLICT.message : '',
      theirs: { text: null, message: 'Their version is too large to compare here.' },
      mine: { text: MINE_DIFF, message: 'Showing the first 60 KiB of the changes.' }
    }
  })
  await pressIn('Deploy', 'Publish')
  assert.deepEqual(diffsIn('Deploy'), [['Your changes', MINE_DIFF]])
  assert.deepEqual(
    inside(cardOf('Deploy'), { type: 'Text', text: /^(Their version|Showing)/ }).map(text => [text.text, text.props.muted]),
    [['Their version is too large to compare here.', true], ['Showing the first 60 KiB of the changes.', true]]
  )
})

test('Discard asks first', async () => {
  let list = [DEPLOY, HOME]
  const host = await open({ 'wiki.drafts': () => list, 'wiki.discard': () => ({ ok: true as const, message: 'Draft discarded.' }) })
  await pressIn('Deploy', 'Discard…')
  assert.equal(requestsTo(host, 'wiki.discard').length, 0)
  const question = inside(cardOf('Deploy'), { type: 'Text', text: "Discard this draft? Changes you haven't published are lost." })
  assert.equal(question.length, 1)
  assert.deepEqual(
    inside(cardOf('Deploy'), { type: 'Button' }).map(item => [item.text, item.props.variant ?? null, item.props.tone ?? null]),
    [['Discard', null, 'danger'], ['Keep', 'ghost', null]]
  )
  assert.deepEqual(buttonsIn('Home'), ['Publish', 'Open', 'Discard…'])
  await pressIn('Deploy', 'Keep')
  assert.equal(requestsTo(host, 'wiki.discard').length, 0)
  assert.deepEqual(buttonsIn('Deploy'), ['Publish', 'Open', 'Discard…'])

  await pressIn('Deploy', 'Discard…')
  list = [HOME]
  await pressIn('Deploy', 'Discard')
  assert.deepEqual(inputsTo(host, 'wiki.discard'), [{ key: DEPLOY.key }])
  assert.equal(requestsTo(host, 'wiki.discard')[0]?.timeoutMs, 90_000)
  assert.deepEqual(cardTitles(), ['Home'])
  assert.ok(panel.find({ type: 'Collapsible', label: 'Drafts (1)' }))
  assert.equal(requestsTo(host, 'wiki.drafts').length, 2)
})

test('a Discard that fails keeps the draft and shows why', async () => {
  await open({
    'wiki.drafts': [DEPLOY],
    'wiki.discard': () => {
      throw hostError('action_failed', 'The wiki draft folder leads outside this workspace, so nothing was written.')
    }
  })
  await pressIn('Deploy', 'Discard…')
  await pressIn('Deploy', 'Discard')
  assert.deepEqual(calloutsIn('Deploy'), [['danger', null, 'The wiki draft folder leads outside this workspace, so nothing was written.']])
  assert.deepEqual(buttonsIn('Deploy'), ['Publish', 'Open', 'Discard…'])
})

test('results stay with their draft', async () => {
  let list = [DEPLOY, HOME]
  const host = await open({
    'wiki.drafts': () => list,
    'wiki.publish': { status: 'published', message: 'Published.' },
    'wiki.edit': { opened: true, message: OPENED }
  })
  await pressIn('Deploy', 'Publish')
  assert.deepEqual(calloutsIn('Deploy'), [['success', null, 'Published.']])
  assert.deepEqual(calloutsIn('Home'), [])
  list = [HOME, DEPLOY]
  await pressIn('Home', 'Open')
  assert.deepEqual(cardTitles(), ['Home', 'Deploy'])
  assert.deepEqual(calloutsIn('Deploy'), [['success', null, 'Published.']])
  assert.deepEqual(calloutsIn('Home'), [['accent', null, OPENED]])
  assert.equal(requestsTo(host, 'wiki.drafts').length, 3)
})

test('a second Publish press before the buttons redraw sends nothing', async () => {
  const answer = held<WikiResult>()
  const host = await open({ 'wiki.drafts': [DEPLOY, HOME], 'wiki.publish': () => answer.promise, 'wiki.edit': { opened: true, message: OPENED }, 'wiki.discard': { ok: true as const, message: 'Draft discarded.' } })
  const publish = button('Publish', cardOf('Deploy'))
  const opener = button('Open', cardOf('Deploy'))
  const discarder = button('Discard…', cardOf('Deploy'))
  assert.ok(publish && opener && discarder)
  const presses = [panel.press(publish), panel.press(publish), panel.press(opener), panel.press(discarder)]
  await until(() => button('Publish', cardOf('Deploy'))?.disabled)
  assert.deepEqual(
    buttonsIn('Deploy').map(text => button(text, cardOf('Deploy'))?.disabled),
    [true, true, true]
  )
  assert.deepEqual(
    buttonsIn('Home').map(text => button(text, cardOf('Home'))?.disabled),
    [false, false, false]
  )
  answer.release({ status: 'published', message: 'Published.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'wiki.publish').length, 1)
  assert.equal(requestsTo(host, 'wiki.edit').length, 0)
  assert.equal(requestsTo(host, 'wiki.discard').length, 0)
  assert.deepEqual(
    buttonsIn('Deploy').map(text => button(text, cardOf('Deploy'))?.disabled),
    [false, false, false]
  )
})

test('every button in a conflict is disabled while its draft runs, and a second press sends nothing', async () => {
  const answer = held<WikiResult>()
  const host = await open({ 'wiki.drafts': [DEPLOY], 'wiki.publish': CONFLICT, 'wiki.resolve': () => answer.promise })
  await pressIn('Deploy', 'Publish')
  const merge = button('Merge by hand', cardOf('Deploy'))
  assert.ok(merge)
  const presses = [panel.press(merge), panel.press(merge)]
  await until(() => button('Merge by hand', cardOf('Deploy'))?.disabled)
  assert.deepEqual(
    buttonsIn('Deploy').map(text => button(text, cardOf('Deploy'))?.disabled),
    [true, true, true, true, true, true]
  )
  assert.equal(diffsIn('Deploy').length, 2)
  answer.release({ status: 'updated', message: 'Opened their version.' })
  await Promise.all(presses)
  assert.equal(requestsTo(host, 'wiki.resolve').length, 1)
  assert.deepEqual(calloutsIn('Deploy'), [['success', null, 'Opened their version.']])
})

test('a newer conflict leaves the older one with its message only', async () => {
  const host = await open({ 'wiki.drafts': [DEPLOY, HOME], 'wiki.publish': CONFLICT })
  await pressIn('Deploy', 'Publish')
  assert.equal(diffsIn('Deploy').length, 2)
  await pressIn('Home', 'Publish')
  assert.equal(diffsIn('Home').length, 2)
  assert.deepEqual(diffsIn('Deploy'), [])
  assert.deepEqual(calloutsIn('Deploy').map(([tone, title]) => [tone, title]), [['warning', 'This page changed in Azure DevOps']])
  assert.ok((calloutsIn('Deploy')[0][2] as string).includes(CONFLICT.message))
  const hint = inside(cardOf('Deploy'), { type: 'Text', text: 'Press Publish to see both versions again.' })
  assert.deepEqual([hint.length, hint[0].props.muted], [1, true])
  assert.deepEqual(buttonsIn('Deploy'), ['Publish', 'Open', 'Discard…'])
  assert.deepEqual(buttonsIn('Home'), ['Publish', 'Open', 'Discard…', 'Publish mine…', 'Take theirs…', 'Merge by hand'])

  await pressIn('Deploy', 'Publish')
  assert.equal(diffsIn('Deploy').length, 2)
  assert.deepEqual(diffsIn('Home'), [])
  assert.equal(requestsTo(host, 'wiki.publish').length, 3)
})

test('switching org resets the tab but keeps the chosen wiki per org', async () => {
  const fabrikam = { ...PROJECT_WIKI, id: 'wiki-fabrikam', name: 'Fabrikam.wiki' }
  const host = await open(
    {
      'wiki.list': input => (input.org === 'contoso' ? WIKIS : [fabrikam]),
      'wiki.drafts': input => (input.org === 'contoso' ? [DEPLOY] : []),
      'wiki.search': { hits: HITS, total: 2 }
    },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  await panel.type(SEARCH_BOX, 'release', { submit: true })
  assert.ok(panel.find({ type: 'List', label: 'Search results' }))
  assert.deepEqual(cardTitles(), ['Deploy'])

  await panel.select({ type: 'Select', label: 'Organization' }, 'fabrikam')
  assert.deepEqual(inputsTo(host, 'wiki.list').slice(-1), [{ org: 'fabrikam' }])
  assert.equal(panel.find({ type: 'Select', label: 'Wiki' }), null)
  assert.ok(panel.find({ type: 'Text', text: 'Fabrikam.wiki' }))
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.equal(panel.valueOf(SEARCH_BOX), '')
  assert.equal(panel.find({ type: 'List', label: 'Search results' }), null)
  assert.deepEqual(cardTitles(), [])
  assert.deepEqual(inputsTo(host, 'wiki.pages').at(-1), { org: 'fabrikam', projectId: 'proj-web', wikiId: 'wiki-fabrikam', path: '/' })
  assert.deepEqual(panel.persisted.plugin.wikiChoice, { contoso: 'wiki-project' })

  assert.deepEqual(rememberedAt(), ['/Runbooks'])
  assert.equal(rememberedAt('fabrikam|wiki-fabrikam'), undefined)

  await panel.select({ type: 'Select', label: 'Organization' }, 'contoso')
  assert.equal(panel.valueOf({ type: 'Select', label: 'Wiki' }), 'wiki-project')
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(panel.valueOf(SEARCH_BOX), '')
  assert.deepEqual(cardTitles(), ['Deploy'])
  assert.deepEqual(inputsTo(host, 'wiki.pages').slice(-2), [
    { org: 'contoso', projectId: 'proj-web', wikiId: 'wiki-project', path: '/' },
    { org: 'contoso', projectId: 'proj-web', wikiId: 'wiki-project', path: '/Runbooks' }
  ])
})

test('an org that expires and reconnects keeps the tree, the search and the results', async () => {
  const host = await open({
    'wiki.list': WIKIS,
    'wiki.drafts': [DEPLOY],
    'wiki.search': { hits: HITS, total: 2 },
    'wiki.edit': { opened: true, message: OPENED }
  })
  await panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  await panel.expand(TREE, '/Runbooks')
  await pressIn('Deploy', 'Open')
  await panel.type(SEARCH_BOX, 'release', { submit: true })
  const before = ['wiki.list', 'wiki.pages', 'wiki.drafts', 'wiki.search', 'wiki.edit'].map(name => requestsTo(host, name).length)
  const results = panel.findAll({ type: 'ListItem' }).map(item => item.label)
  const callouts = calloutsIn('Deploy')
  assert.deepEqual(callouts, [['accent', null, OPENED]])

  await panel.post('orgs.changed', { orgs: [org('contoso', { state: 'expired' })] })
  assert.equal(panel.find({ type: 'Tabs' }), null)
  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  assert.equal(panel.valueOf({ type: 'Tabs' }), 'wiki')

  assert.deepEqual(['wiki.list', 'wiki.pages', 'wiki.drafts', 'wiki.search', 'wiki.edit'].map(name => requestsTo(host, name).length), before)
  assert.equal(panel.valueOf(SEARCH_BOX), 'release')
  assert.deepEqual(panel.findAll({ type: 'ListItem' }).map(item => item.label), results)
  assert.deepEqual(calloutsIn('Deploy'), callouts)
  assert.equal(panel.valueOf({ type: 'Select', label: 'Wiki' }), 'wiki-project')
  await panel.press({ type: 'Button', text: 'Clear search' })
  assert.deepEqual(panel.expandedOf(TREE), ['/Runbooks'])
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(requestsTo(host, 'wiki.pages').length, before[1])
})

test('a drafts answer and an action result for an org that is no longer shown are dropped', async () => {
  const late = held<DraftSummary[]>()
  let calls = 0
  const host = await open(
    {
      'wiki.drafts': input => {
        if (input.org === 'fabrikam') return []
        calls += 1
        return calls === 2 ? late.promise : [DEPLOY]
      },
      'wiki.publish': { status: 'published', message: 'Published.' }
    },
    { orgs: [org('contoso'), org('fabrikam')] }
  )
  const publishing = pressIn('Deploy', 'Publish')
  await until(() => button('Publish', cardOf('Deploy'))?.disabled)
  const switching = panel.select({ type: 'Select', label: 'Organization' }, 'fabrikam')
  await until(() => inputsTo(host, 'wiki.drafts').some(input => (input as { org: string }).org === 'fabrikam'))
  late.release([DEPLOY, HOME])
  await Promise.all([publishing, switching])
  assert.deepEqual(cardTitles(), [])
  await panel.select({ type: 'Select', label: 'Organization' }, 'contoso')
  assert.deepEqual(cardTitles(), ['Deploy'])
  assert.deepEqual(calloutsIn('Deploy'), [])
})

test('a remembered wiki that no longer exists falls back to the first', async () => {
  await open({ 'wiki.list': WIKIS }, { persisted: { plugin: { wikiChoice: { contoso: 'gone' } } } })
  assert.equal(panel.valueOf({ type: 'Select', label: 'Wiki' }), 'wiki-code')
})

test('an open page survives a panel reload', async () => {
  const first = await open({}, { persisted: { workspace: { wikiPage: OPEN_PAGE } } })
  assert.equal(heading(), 'Deploy')
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, PAGE_CONTENT)
  assert.equal(panel.find(TREE), null)
  assert.equal(panel.find(SEARCH_BOX), null)
  assert.deepEqual(inputsTo(first, 'wiki.page'), [refOf('/Runbooks/Deploy')])
  assert.equal(requestsTo(first, 'wiki.list').length, 0)
  assert.deepEqual(panel.persisted.workspace.wikiPage, OPEN_PAGE)

  const stored = { plugin: panel.persisted.plugin, workspace: panel.persisted.workspace }
  await closeCleanly(panel)
  const second = await mountPanel([org('contoso'), org('fabrikam')], { 'wiki.list': [PROJECT_WIKI], 'wiki.pages': pagesFrom(LEVELS), 'wiki.page': input => pageOf(input.path) }, { persisted: stored })
  panel = second.panel
  await panel.settled()
  assert.equal(heading(), 'Deploy')
  assert.equal(panel.find(TREE), null)
  await panel.post('orgs.changed', { orgs: [org('contoso'), org('fabrikam', { state: 'expired' })] })
  assert.equal(heading(), 'Deploy')
  assert.equal(panel.find(TREE), null)
  assert.equal(requestsTo(second.host, 'wiki.page').length, 1)
  await panel.press(BACK)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
})

test('a page remembered for another org is not shown', async () => {
  const host = await open({}, { persisted: { workspace: { wikiPage: { ...OPEN_PAGE, org: 'fabrikam' } } } })
  assert.equal(heading(), undefined)
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  assert.equal(requestsTo(host, 'wiki.page').length, 0)
  assert.equal(panel.persisted.workspace.wikiPage ?? null, null)
})

test('a page answer after Back is dropped', async () => {
  const answer = held<WikiPage>()
  await open({ 'wiki.page': () => answer.promise })
  const selecting = panel.selectItem(TREE, '/Home')
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading the page' }))
  const leaving = panel.press(BACK)
  await until(() => panel.find(TREE))
  answer.release(pageOf('/Home'))
  await Promise.all([selecting, leaving])
  assert.equal(panel.find({ type: 'Heading' }), null)
  assert.ok(panel.find(TREE))
  assert.equal(panel.persisted.workspace.wikiPage ?? null, null)
})

test('a quick second page wins over the first answer', async () => {
  const first = held<WikiPage>()
  const answers = [first.promise, Promise.resolve(pageOf('/Release notes', { content: 'second' }))]
  await open({ 'wiki.page': () => answers.shift() as Promise<WikiPage> })
  const firstPick = panel.selectItem(TREE, '/Home')
  await until(() => panel.find({ type: 'Skeleton', label: 'Loading the page' }))
  const leaving = panel.press(BACK)
  await until(() => panel.find(TREE))
  const secondPick = panel.selectItem(TREE, '/Release notes')
  await until(() => panel.find({ type: 'Markdown' })?.props.content === 'second')
  first.release(pageOf('/Home', { content: 'first' }))
  await Promise.all([firstPick, leaving, secondPick])
  assert.equal(heading(), 'Release notes')
  assert.equal(panel.find({ type: 'Markdown' })?.props.content, 'second')
})

test('a level answer for a wiki that is no longer shown is dropped', async () => {
  const slow = held<WikiLevel>()
  const host = await open({
    'wiki.list': WIKIS,
    'wiki.pages': input => (input.wikiId === 'wiki-code' && input.path === '/Runbooks' ? slow.promise : (LEVELS[input.path] ?? levelOf([])))
  })
  const expanding = panel.expand(TREE, '/Runbooks')
  await until(() => inputsTo(host, 'wiki.pages').some(input => (input as WikiPageRef).path === '/Runbooks'))
  const choosing = panel.select({ type: 'Select', label: 'Wiki' }, 'wiki-project')
  await until(() => inputsTo(host, 'wiki.pages').some(input => (input as WikiPageRef).wikiId === 'wiki-project'))
  slow.release(levelOf(['/Runbooks/Stale']))
  await Promise.all([expanding, choosing])
  assert.deepEqual(panel.expandedOf(TREE), [])
  assert.deepEqual(keysOf(treeOf()), ROOT_PAGES)
  await panel.expand(TREE, '/Runbooks')
  assert.deepEqual(childrenOf('/Runbooks'), ['/Runbooks/Deploy', '/Runbooks/Rollback'])
  assert.equal(requestsTo(host, 'wiki.pages').length, 4)
})

test('the pure tree builder nests loaded folders and leaves the rest to load on expand', () => {
  const levels = new Map<string, WikiLevel>([
    ['/', levelOf(['/A', '/B'], {}, ['/A', '/B'])],
    ['/A', levelOf(['/A/1', '/A/2'])]
  ])
  const shown = treeItems(levels, ['/A', '/B'])
  assert.deepEqual(shown.capped, false)
  assert.deepEqual(shown.items, [
    { key: '/A', label: 'A', icon: 'folder', description: '2 pages', hasChildren: true, children: [
      { key: '/A/1', label: '1', icon: 'file-text', hasChildren: false },
      { key: '/A/2', label: '2', icon: 'file-text', hasChildren: false }
    ] },
    { key: '/B', label: 'B', icon: 'folder', hasChildren: true }
  ])
  assert.deepEqual(treeItems(levels, []).items.map(item => item.children), [undefined, undefined])
  assert.deepEqual(treeItems(new Map(), ['/A']), { items: [], capped: false })
})

test('the pure tree builder stops at the item limit and says it capped', () => {
  const pages = Array.from({ length: 10 }, (_, index) => `/P${index}`)
  const levels = new Map<string, WikiLevel>([['/', levelOf(pages)]])
  const shown = treeItems(levels, [], 4)
  assert.deepEqual(keysOf(shown.items), ['/P0', '/P1', '/P2', '/P3'])
  assert.equal(shown.capped, true)
  assert.equal(treeItems(levels, [], 10).capped, false)
  assert.equal(treeItems(levels, []).capped, false)
  assert.equal(MAX_TREE_ITEMS, 1000)

  const capped = new Map<string, WikiLevel>([['/', levelOf(['/A', '/B'], { total: 9 })]])
  assert.deepEqual(keysOf(treeItems(capped, []).items), ['/A', '/B', 'more:/'])
  assert.deepEqual(keysOf(treeItems(capped, [], 2).items), ['/A', '/B'])
  assert.equal(treeItems(capped, [], 2).capped, true)
})

test('the pure tree builder counts items across folders and nests at most 16 levels', () => {
  const chain = Array.from({ length: 20 }, (_, index) => `/${Array.from({ length: index + 1 }, (_, part) => `d${part}`).join('/')}`)
  const levels = new Map<string, WikiLevel>([['/', levelOf([chain[0]], {}, [chain[0]])]])
  chain.forEach((path, index) => {
    if (index + 1 < chain.length) levels.set(path, levelOf([chain[index + 1]], {}, [chain[index + 1]]))
  })
  const shown = treeItems(levels, chain)
  let depth = 0
  let item: TreeItem | undefined = shown.items[0]
  let deepest: TreeItem | undefined
  while (item) {
    depth += 1
    deepest = item
    item = item.children?.[0]
  }
  assert.equal(depth, 16)
  assert.equal(deepest?.children, undefined)
  assert.equal(deepest?.hasChildren, false)
  assert.equal(shown.capped, true)

  const two = new Map<string, WikiLevel>([
    ['/', levelOf(['/A', '/B'], {}, ['/A'])],
    ['/A', levelOf(['/A/1', '/A/2', '/A/3'])]
  ])
  assert.equal(countItems(treeItems(two, ['/A'], 4).items), 4)
  assert.equal(treeItems(two, ['/A'], 4).capped, true)
  assert.equal(countItems(treeItems(two, ['/A'], 5).items), 5)
  assert.equal(treeItems(two, ['/A'], 5).capped, false)
})

test('the pure tree builder stops at the byte budget and stays stopped', () => {
  const filler = Array.from({ length: 353 }, (_, index) => `/A/${String(index).padStart(3, '0')}${'p'.repeat(94)}`)
  const giant = `/A/${'g'.repeat(996)}`
  const levels = new Map([
    ['/', levelOf(['/A', '/b'], {}, ['/A'])],
    ['/A', levelOf([...filler, giant, '/A/short'])]
  ])
  const shown = treeItems(levels, ['/A'])
  assert.deepEqual(keysOf(shown.items), ['/A'])
  assert.deepEqual(keysOf(shown.items[0].children ?? []), filler)
  assert.equal(shown.capped, true)

  const bytes = (item: TreeItem): number =>
    2 * (new TextEncoder().encode(item.key).length + new TextEncoder().encode(item.label).length) + 40 + (item.children ?? []).reduce((total, child) => total + bytes(child), 0)
  assert.ok(shown.items.reduce((total, item) => total + bytes(item), 0) <= TREE_BYTES)
  assert.equal(treeItems(new Map([['/', levelOf(['/a', '/b'])]]), []).capped, false)
})

test('a page path too long to be a tree key is left out and counts as hidden', () => {
  const long = `/${'x'.repeat(1100)}`
  const shown = treeItems(new Map([['/', { pages: [nodeOf('/Home'), nodeOf(long)], total: 2 }]]), [])
  assert.deepEqual(keysOf(shown.items), ['/Home'])
  assert.equal(shown.capped, true)
})

test('a deep chain of folders stays within what Orca accepts', async () => {
  const chain = Array.from({ length: 18 }, (_, index) => `/${Array.from({ length: index + 1 }, (_, part) => `d${part}`).join('/')}`)
  const below = (path: string) => (path === '/' ? chain[0] : chain[chain.indexOf(path) + 1])
  await open({ 'wiki.pages': input => (below(input.path) === undefined ? levelOf([]) : levelOf([below(input.path)], {}, [below(input.path)])) })
  for (const path of chain.slice(0, 15)) await panel.expand(TREE, path)
  assert.equal(countItems(treeOf()), 16)
  assert.ok(panel.find({ type: 'Text', text: 'Some pages are hidden. Collapse a folder to see others.' }))
})

test('long titles, paths and snippets are cut so Orca keeps every label', async () => {
  const long = 'x'.repeat(3_000)
  const hit = { path: '/Home', title: long, snippet: long }
  await open({
    'wiki.list': [{ ...PROJECT_WIKI, name: long }, { ...CODE_WIKI, name: long }],
    'wiki.pages': { pages: [{ path: '/Home', title: long, hasChildren: false }], total: 1 },
    'wiki.search': { hits: [hit], total: 1 },
    'wiki.drafts': [draftOf('/Home', { title: long, wikiName: long, workspaceName: long, file: long })]
  })
  assert.ok(new TextEncoder().encode(treeOf()[0].label).length <= 1024)
  const options = panel.find({ type: 'Select', label: 'Wiki' })?.props.options as { label: string }[]
  assert.ok(new TextEncoder().encode(options[0].label).length <= 1024)
  await panel.type(SEARCH_BOX, 'release', { submit: true })
  assert.ok(new TextEncoder().encode(String(panel.find({ type: 'ListItem' })?.props.description)).length <= 1024)
  assert.ok(new TextEncoder().encode(String(panel.findAll({ type: 'Card' })[0]?.props.description)).length <= 1024)
})

const BIG = 'word '.repeat(12_000)

function bigRoot(folderPad = '', pagePad = ''): Record<string, WikiLevel> {
  const folders = Array.from({ length: 8 }, (_, index) => `/Folder ${index}${folderPad}`)
  const level = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}/Page ${index}${pagePad}`)
  return {
    '/': levelOf(folders, { total: 8 }, folders),
    ...Object.fromEntries(folders.map(folder => [folder, levelOf(level(folder, 200), { total: 260 })]))
  }
}

function measure(section: string) {
  const nodes = countNodes(panel.tree())
  const bytes = treeBytes()
  assert.ok(nodes < 4_000, `${section}: ${nodes} nodes`)
  assert.ok(bytes < 450 * 1024, `${section}: ${bytes} bytes`)
}

test('the tree stops at 1,000 items, and the tab stays under 4,000 nodes and 450 KiB', async () => {
  const levels = bigRoot()
  const drafts = Array.from({ length: 50 }, (_, index) => draftOf(`/Section ${index}/Page ${index}`, { changed: index % 2 === 0, publishedAt: index % 3 === 0 ? NOW : null }))
  const diff = ['@@ -1 +1 @@', ...Array.from({ length: 1_900 }, (_, index) => `+ line ${index} of a very long generated change`)].join('\n').slice(0, 60 * 1024)
  assert.equal(new TextEncoder().encode(diff).length, 60 * 1024)
  await open({
    'wiki.pages': input => levels[input.path] ?? levelOf([]),
    'wiki.page': input => pageOf(input.path, { content: BIG.slice(0, 60_000) }),
    'wiki.drafts': drafts,
    'wiki.publish': { status: 'conflict', message: CONFLICT.status === 'conflict' ? CONFLICT.message : '', theirs: { text: diff }, mine: { text: diff } }
  })
  await panel.selectItem(TREE, '/Folder 0')
  assert.equal((panel.find({ type: 'Markdown' })?.props.content as string).length, 60_000)
  measure('page')
  await panel.press(BACK)

  for (let index = 7; index >= 3; index -= 1) await panel.expand(TREE, `/Folder ${index}`)
  assert.equal(countItems(treeOf()), MAX_TREE_ITEMS)
  assert.equal(panel.find({ type: 'Text', text: 'Some pages are hidden. Collapse a folder to see others.' })?.props.muted, true)
  assert.equal(cardTitles().length, 50)

  for (const title of ['Page 0', 'Page 1', 'Page 2']) await pressIn(title, 'Publish')
  assert.deepEqual(
    drafts.slice(0, 3).map(draft => diffsIn(draft.title).length),
    [0, 0, 2]
  )
  measure('drafts in conflict with the tree open')
})

test('about 150-character page paths still leave room for a conflict under 450 KiB', async () => {
  const folderPad = 'f'.repeat(90)
  const levels = bigRoot(folderPad, 'p'.repeat(40))
  const drafts = Array.from({ length: 50 }, (_, index) => draftOf(`/Section ${index}/Page ${index}`, { changed: index % 2 === 0 }))
  const diff = ['@@ -1 +1 @@', ...Array.from({ length: 1_900 }, (_, index) => `+ line ${index} of a very long generated change`)].join('\n').slice(0, 60 * 1024)
  await open({
    'wiki.pages': input => levels[input.path] ?? levelOf([]),
    'wiki.drafts': drafts,
    'wiki.publish': { status: 'conflict', message: CONFLICT.status === 'conflict' ? CONFLICT.message : '', theirs: { text: diff }, mine: { text: diff } }
  })
  for (let index = 7; index >= 3; index -= 1) await panel.expand(TREE, `/Folder ${index}${folderPad}`)
  const shown = countItems(treeOf())
  assert.ok(shown > 100 && shown < MAX_TREE_ITEMS, `${shown} items`)
  assert.ok(panel.find({ type: 'Text', text: 'Some pages are hidden. Collapse a folder to see others.' }))
  measure('long paths with the tree open')

  await pressIn('Page 0', 'Publish')
  assert.equal(diffsIn('Page 0').length, 2)
  measure('long paths with a conflict open')
})

test("a 2,000-page wiki stays within Orca's limits", async () => {
  const levels = largeLevels()
  assert.equal(Object.values(levels).reduce((total, level) => total + level.pages.length, 0), 2_000)
  const host = await open({ 'wiki.pages': pagesFrom(levels) })
  for (let press = 0; press < 6; press += 1) {
    const before = readsOf(host).length
    await panel.press({ type: 'IconButton', label: 'Expand all' })
    assert.ok(readsOf(host).length - before <= MAX_EXPAND_LOADS)
  }
  assert.equal(countItems(treeOf()), MAX_TREE_ITEMS)
  assert.equal(panel.find({ type: 'Text', text: 'Some pages are hidden. Collapse a folder to see others.' })?.props.muted, true)
  assert.equal(treeOf().every(item => item.description === '19 pages'), true)
  measure('2,000 pages')
  assert.equal(panel.expandedOf(TREE).every(path => rememberedAt()?.includes(path)), true)
  assert.ok((rememberedAt()?.length ?? 0) <= MAX_REMEMBERED_FOLDERS)

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.equal(countItems(treeOf()), 5)
  assert.equal(panel.find({ type: 'Text', text: 'Some pages are hidden. Collapse a folder to see others.' }), null)
  assert.deepEqual(rememberedAt(), [])
  measure('2,000 pages collapsed')
})
