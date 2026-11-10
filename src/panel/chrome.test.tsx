import { Stack, Text, type OrcaNode } from 'orca'
import { assert, test, type TreeSnapshot } from 'orca/testing'
import { Chips } from './chips'
import { CHOOSE_ALL, counted } from './copy'
import { Group, Groups, ScopedEmpty, type Layout } from './group'
import { groupByPlace, type Choices, type Place } from './grouping'
import { cutLabel, MAX_LABEL_BYTES, utf8Length } from './label'
import { foldActions, TabToolbar, type ToolAction } from './toolbar'
import { closeCleanly, countNodes, mountPanel, org, reloadPanel } from './test-support'

const NOW = 1_700_000_000_000
const ORGS = [org('contoso')]
const REFRESH_LABEL = 'Refresh'

const foldsOf = (panel: { persisted: { plugin: Record<string, unknown> } }) => panel.persisted.plugin.folds as Record<string, unknown>

const childrenOf = (node: TreeSnapshot | string | undefined): (TreeSnapshot | string)[] => (typeof node === 'object' ? (node.children ?? []) : [])

function Scoped(): OrcaNode {
  const actions: ToolAction[] = [{ icon: 'refresh', label: REFRESH_LABEL, onPress: () => undefined }, ...foldActions('contoso', 'prs')]
  return <TabToolbar left={<Text size="sm">Scope</Text>} actions={actions} updatedAt={NOW} message="Showing the last good copy." stale />
}

function TwoGroups(): OrcaNode {
  return (
    <Stack gap="sm">
      <TabToolbar actions={foldActions('contoso', 'prs')} updatedAt={NOW} stale={false} />
      <Group org="contoso" tab="prs" foldKey="project:p1" title="Web" count="2 PRs">
        <Text>First PR</Text>
      </Group>
      <Group org="contoso" tab="prs" foldKey="project:p2" title="Boards" count="1 PR" hint="1 needs you">
        <Text>Second PR</Text>
      </Group>
    </Stack>
  )
}

function TwoOrganisations(): OrcaNode {
  return (
    <Stack gap="sm">
      <TabToolbar actions={foldActions('contoso', 'prs')} updatedAt={NOW} stale={false} />
      <Group org="contoso" tab="prs" foldKey="project:p1" title="Contoso Web" count="2 PRs">
        <Text>Contoso first</Text>
      </Group>
      <Group org="contoso" tab="prs" foldKey="project:p2" title="Contoso Boards" count="1 PR">
        <Text>Contoso second</Text>
      </Group>
      <Group org="fabrikam" tab="prs" foldKey="project:p1" title="Fabrikam Web" count="3 PRs">
        <Text>Fabrikam first</Text>
      </Group>
    </Stack>
  )
}

function NaturalGroups(): OrcaNode {
  return (
    <Stack gap="sm">
      <TabToolbar actions={foldActions('contoso', 'work')} updatedAt={NOW} stale={false} />
      <Group org="contoso" tab="work" foldKey="column:todo" title="To do" count="2">
        <Text>Open by default</Text>
      </Group>
      <Group org="contoso" tab="work" foldKey="column:done" title="Done" count="5" natural={false}>
        <Text>Closed by default</Text>
      </Group>
    </Stack>
  )
}

function OneGroup(): OrcaNode {
  return (
    <Group org="contoso" tab="prs" foldKey="project:p1" title="Web" count="2 PRs">
      <Text>First PR</Text>
      <Text>Second PR</Text>
    </Group>
  )
}

test('the toolbar puts the scope controls in a first row, then Updated beside the icon buttons, then the message', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: Scoped })

  const tree = panel.tree() as TreeSnapshot
  assert.equal(tree.type, 'Stack')
  const [controls, bar, message, ...rest] = childrenOf(tree) as TreeSnapshot[]
  assert.deepEqual(rest, [])
  assert.deepEqual(controls, {
    type: 'Row',
    props: { justify: 'between', align: 'center', gap: 'xs', wrap: true },
    children: [{ type: 'Text', props: { size: 'sm' }, children: ['Scope'] }]
  })
  assert.deepEqual(bar, {
    type: 'Row',
    props: { justify: 'between', align: 'center', gap: 'sm' },
    children: [
      { type: 'Text', props: { muted: true, size: 'xs' }, children: ['Updated ', { type: 'RelativeTime', props: { at: NOW } }] },
      {
        type: 'Row',
        props: { gap: 'none' },
        children: [
          { type: 'IconButton', key: REFRESH_LABEL, props: { icon: 'refresh', label: REFRESH_LABEL, variant: 'ghost', size: 'xs', onPress: '[handler]' } },
          { type: 'IconButton', key: 'Collapse all', props: { icon: 'collapse', label: 'Collapse all', variant: 'ghost', size: 'xs', onPress: '[handler]' } },
          { type: 'IconButton', key: 'Expand all', props: { icon: 'expand', label: 'Expand all', variant: 'ghost', size: 'xs', onPress: '[handler]' } }
        ]
      }
    ]
  })
  assert.deepEqual(message, { type: 'Text', props: { size: 'sm', tone: 'warning' }, children: ['Showing the last good copy.'] })
  await closeCleanly(panel)
})

test('a toolbar with no scope controls and no message is a single row with Updated on the left and its buttons on the right', async () => {
  const Bare = () => <TabToolbar actions={foldActions('contoso', 'pipelines')} updatedAt={NOW} stale={false} />
  const { panel } = await mountPanel(ORGS, {}, { module: Bare })

  const [bar, ...rest] = childrenOf(panel.tree() as TreeSnapshot) as TreeSnapshot[]
  assert.deepEqual(rest, [])
  assert.equal(bar.type, 'Row')
  assert.deepEqual(
    childrenOf(bar).map(child => (child as TreeSnapshot).type),
    ['Text', 'Row']
  )
  assert.deepEqual((childrenOf(bar)[0] as TreeSnapshot).props, { muted: true, size: 'xs' })
  assert.deepEqual((childrenOf(bar)[1] as TreeSnapshot).props, { gap: 'none' })
  assert.ok(panel.find({ type: 'RelativeTime' }))
  await closeCleanly(panel)
})

test('a toolbar action runs its onPress, and a disabled one does not', async () => {
  const pressed: string[] = []
  const actions: ToolAction[] = [
    { icon: 'refresh', label: REFRESH_LABEL, onPress: () => pressed.push(REFRESH_LABEL) },
    { icon: 'settings', label: 'Teams channels', disabled: true, onPress: () => pressed.push('Teams channels') }
  ]
  const Actions = () => <TabToolbar actions={actions} updatedAt={NOW} stale={false} />
  const { panel } = await mountPanel(ORGS, {}, { module: Actions })

  await panel.press({ type: 'IconButton', label: REFRESH_LABEL })
  assert.equal(panel.find({ type: 'IconButton', label: 'Teams channels' })?.disabled, true)
  await assert.rejects(panel.press({ type: 'IconButton', label: 'Teams channels' }), /disabled/)
  assert.deepEqual(pressed, [REFRESH_LABEL])
  await closeCleanly(panel)
})

test('a group header shows its title, with the count and hint as its description', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: TwoGroups })

  const groups = panel.findAll({ type: 'Collapsible' })
  assert.deepEqual(
    groups.map(group => [group.props.title, group.props.description, group.props.open]),
    [
      ['Web', '2 PRs', true],
      ['Boards', '1 PR · 1 needs you', true]
    ]
  )
  await closeCleanly(panel)
})

test('Collapse all and Expand all set every group of the tab and survive a reload', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: TwoGroups })
  const opens = (target: typeof panel) => target.findAll({ type: 'Collapsible' }).map(group => group.props.open)
  assert.deepEqual(opens(panel), [true, true])

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(opens(panel), [false, false])
  assert.deepEqual(foldsOf(panel)['contoso|prs'], { all: 'closed', open: [], closed: [] })

  const reloaded = await reloadPanel(panel, ORGS, {}, { module: TwoGroups })
  assert.deepEqual(opens(reloaded.panel), [false, false])

  await reloaded.panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(opens(reloaded.panel), [true, true])
  assert.deepEqual(foldsOf(reloaded.panel)['contoso|prs'], { all: 'open', open: [], closed: [] })
  await closeCleanly(reloaded.panel)
})

test('reloadPanel fails when the first mount logged an error', async () => {
  let draws = 0
  const Flaky = (): OrcaNode => {
    draws += 1
    if (draws > 1) throw new Error('first mount broke')
    return <Text>Ready</Text>
  }
  const { panel } = await mountPanel(ORGS, {}, { module: Flaky })
  const original = console.error
  console.error = () => undefined
  try {
    await panel.rerender()
  } finally {
    console.error = original
  }
  assert.equal(panel.errors.length, 1)

  await assert.rejects(reloadPanel(panel, ORGS, {}, { module: Flaky }), /first mount broke/)
})

test('a group set by hand stays as it was left, and other organisations keep their own', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: TwoOrganisations })
  const opens = (target: typeof panel) => target.findAll({ type: 'Collapsible' }).map(group => [group.label, group.props.open])

  await panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(opens(panel), [
    ['Contoso Web', false],
    ['Contoso Boards', false],
    ['Fabrikam Web', true]
  ])

  await panel.toggle({ type: 'Collapsible', label: 'Contoso Web' })
  await panel.toggle({ type: 'Collapsible', label: 'Fabrikam Web' })
  assert.deepEqual(foldsOf(panel), {
    'contoso|prs': { all: 'closed', open: ['project:p1'], closed: [] },
    'fabrikam|prs': { all: null, open: [], closed: ['project:p1'] }
  })

  const reloaded = await reloadPanel(panel, ORGS, {}, { module: TwoOrganisations })
  assert.deepEqual(opens(reloaded.panel), [
    ['Contoso Web', true],
    ['Contoso Boards', false],
    ['Fabrikam Web', false]
  ])
  await closeCleanly(reloaded.panel)
})

test('a group starts as its natural state says until a hand setting, Collapse all or Expand all decides', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: NaturalGroups })
  const opens = (target: typeof panel) => target.findAll({ type: 'Collapsible' }).map(group => group.props.open)
  assert.deepEqual(opens(panel), [true, false])

  await panel.toggle({ type: 'Collapsible', label: 'Done' })
  const reloaded = await reloadPanel(panel, ORGS, {}, { module: NaturalGroups })
  assert.deepEqual(opens(reloaded.panel), [true, true])

  await reloaded.panel.press({ type: 'IconButton', label: 'Collapse all' })
  assert.deepEqual(opens(reloaded.panel), [false, false])
  await reloaded.panel.press({ type: 'IconButton', label: 'Expand all' })
  assert.deepEqual(opens(reloaded.panel), [true, true])
  await closeCleanly(reloaded.panel)
})

test('a closed group draws no children', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: OneGroup })
  const open = countNodes(panel.tree())
  assert.ok(JSON.stringify(panel.tree()).includes('First PR'))

  await panel.toggle({ type: 'Collapsible', label: 'Web' })
  assert.equal(countNodes(panel.tree()), 1)
  assert.ok(!JSON.stringify(panel.tree()).includes('First PR'))
  assert.deepEqual(panel.tree(), { type: 'Collapsible', props: { title: 'Web', description: '2 PRs', open: false, onChange: '[handler]' } })

  await panel.toggle({ type: 'Collapsible', label: 'Web' })
  assert.equal(countNodes(panel.tree()), open)
  await closeCleanly(panel)
})

test('a group title and hint over 1 KiB are cut to the label limit', async () => {
  const long = 'é'.repeat(2_000)
  const Long = () => (
    <Group org="contoso" tab="prs" foldKey="project:p1" title={long} count="2 PRs" hint={long}>
      <Text>First PR</Text>
    </Group>
  )
  const { panel } = await mountPanel(ORGS, {}, { module: Long })

  const group = panel.find({ type: 'Collapsible' })
  const title = group?.props.title as string
  const description = group?.props.description as string
  assert.equal(title, cutLabel(long))
  assert.equal(description, cutLabel(`2 PRs · ${long}`))
  assert.ok(utf8Length(title) <= MAX_LABEL_BYTES)
  assert.ok(utf8Length(description) <= MAX_LABEL_BYTES)
  assert.ok(title.endsWith('…') && description.endsWith('…'))
  assert.ok(description.startsWith('2 PRs · é'))
  await closeCleanly(panel)
})

interface Spot {
  id: string
  places: Place[]
}

const at = (projectId: string, projectName: string, repoId: string | null = null, repoName: string | null = null): Place => ({ projectId, projectName, repoId, repoName })
const WEB_APP = at('p-web', 'Web', 'r-app', 'web-app')
const WEB_API = at('p-web', 'Web', 'r-api', 'fabrikam-api')
const BOARDS = at('p-boards', 'Boards', 'r-boards', 'boards')
const SPOTS: Spot[] = [
  { id: 'a', places: [WEB_APP] },
  { id: 'b', places: [WEB_API] },
  { id: 'c', places: [at('p-web', 'Web')] },
  { id: 'd', places: [WEB_APP, WEB_API] },
  { id: 'e', places: [WEB_APP, BOARDS] },
  { id: 'f', places: [BOARDS] }
]

const spotGroups =
  (prefix?: string) =>
  (): OrcaNode => {
    const layout: Layout<Spot> = {
      prefix,
      count: items => counted(items.length, 'spot', 'spots'),
      hint: items => (items.some(item => item.id === 'a') ? 'holds a' : undefined),
      draw: (items, place) => <Text>{`${items.map(item => item.id).join(' ')} · ${place ?? 'no chip'}`}</Text>
    }
    return <Groups org="contoso" tab="prs" grouped={groupByPlace(SPOTS, spot => spot.places)} layout={layout} />
  }

function groupOutline(tree: TreeSnapshot | string | null): string[] {
  const lines: string[] = []
  const textOf = (node: TreeSnapshot | string): string => (typeof node === 'string' ? node : childrenOf(node).map(textOf).join(''))
  const walk = (node: TreeSnapshot | string | null, depth: number): void => {
    if (node === null || typeof node === 'string') return
    if (node.type === 'Text') {
      lines.push(`${'  '.repeat(depth)}${textOf(node)}`)
      return
    }
    const inner = node.type === 'Collapsible' ? depth + 1 : depth
    if (node.type === 'Collapsible') lines.push(`${'  '.repeat(depth)}${node.props?.title} [${node.props?.description}]`)
    for (const child of childrenOf(node)) walk(child, inner)
  }
  walk(tree, 0)
  return lines
}

test('Groups draws Across projects first, then each project with its loose items before its repository groups, and prefixes fold keys only when asked', async () => {
  for (const [prefix, keyOf] of [
    ['mine', (key: string) => `mine/${key}`],
    [undefined, (key: string) => key]
  ] as const) {
    const { panel } = await mountPanel(ORGS, {}, { module: spotGroups(prefix) })
    assert.deepEqual(groupOutline(panel.tree()), [
      'Across projects [1 spot]',
      '  e · project',
      'Boards · boards [1 spot]',
      '  f · no chip',
      'Web · 2 repos [4 spots · holds a]',
      '  c · no chip',
      '  Across repos [1 spot]',
      '    d · repo',
      '  fabrikam-api [1 spot]',
      '    b · no chip',
      '  web-app [1 spot · holds a]',
      '    a · no chip'
    ])

    await panel.toggle({ type: 'Collapsible', label: 'fabrikam-api' })
    await panel.toggle({ type: 'Collapsible', label: 'Across projects' })
    assert.deepEqual(foldsOf(panel)['contoso|prs'], { all: null, open: [], closed: [keyOf('project:p-web/repo:r-api'), keyOf('across-projects')] })
    await closeCleanly(panel)
  }
})

const CHOICES: Choices = { projects: [{ id: 'p1', name: 'Contoso Tools' }], repos: [], scope: { project: null, repo: null } }

const emptyOf = async (choices: Choices) => {
  const Probe = () => <ScopedEmpty choices={choices} title="Nothing yet" description="Things show up here." />
  const { panel } = await mountPanel(ORGS, {}, { module: Probe })
  const empty = panel.find({ type: 'EmptyState' })
  const shown = [empty?.props.title, empty?.props.description]
  await closeCleanly(panel)
  return shown
}

test('a scoped empty state names the chosen project and points to All projects, else shows its own copy', async () => {
  assert.deepEqual(await emptyOf(CHOICES), ['Nothing yet', 'Things show up here.'])
  assert.deepEqual(await emptyOf({ ...CHOICES, scope: { project: 'p1', repo: null } }), ['Nothing here for Contoso Tools', CHOOSE_ALL])
  assert.deepEqual(await emptyOf({ ...CHOICES, scope: { project: 'gone', repo: null } }), ['Nothing yet', 'Things show up here.'])
})

test('a scoped empty state cuts a long project name to the label limit', async () => {
  const long = 'é'.repeat(2_000)
  const title = (await emptyOf({ projects: [{ id: 'p1', name: long }], repos: [], scope: { project: 'p1', repo: null } }))[0] as string
  assert.ok(utf8Length(title) <= MAX_LABEL_BYTES)
  assert.ok(title.startsWith('Nothing here for é') && title.endsWith('…'))
})

test('Chips draw one Badge per chip in its tone', async () => {
  const Probe = () => (
    <Chips
      chips={[
        { tone: 'success', text: 'Approved' },
        { tone: 'warning', text: 'Draft' },
        { tone: 'danger', text: 'Conflicts' }
      ]}
    />
  )
  const { panel } = await mountPanel(ORGS, {}, { module: Probe })

  assert.deepEqual(panel.tree(), {
    type: 'Row',
    props: { gap: 'xs', wrap: true },
    children: [
      { type: 'Badge', key: 'Approved', props: { tone: 'success' }, children: ['Approved'] },
      { type: 'Badge', key: 'Draft', props: { tone: 'warning' }, children: ['Draft'] },
      { type: 'Badge', key: 'Conflicts', props: { tone: 'danger' }, children: ['Conflicts'] }
    ]
  })
  await closeCleanly(panel)
})

test('Chips with the same text twice draw both and log no error', async () => {
  const Probe = () => (
    <Chips
      chips={[
        { tone: 'neutral', text: 'Build' },
        { tone: 'success', text: 'Build' },
        { tone: 'danger', text: 'Deploy' },
        { tone: 'warning', text: 'Build' }
      ]}
    />
  )
  const { panel } = await mountPanel(ORGS, {}, { module: Probe })

  assert.deepEqual(panel.tree(), {
    type: 'Row',
    props: { gap: 'xs', wrap: true },
    children: [
      { type: 'Badge', key: 'Build', props: { tone: 'neutral' }, children: ['Build'] },
      { type: 'Badge', key: 'Build#1', props: { tone: 'success' }, children: ['Build'] },
      { type: 'Badge', key: 'Deploy', props: { tone: 'danger' }, children: ['Deploy'] },
      { type: 'Badge', key: 'Build#2', props: { tone: 'warning' }, children: ['Build'] }
    ]
  })
  await closeCleanly(panel)
})

test('Chips keep every key unique when a text already looks like a repeat key', async () => {
  const Probe = () => (
    <Chips
      chips={[
        { tone: 'neutral', text: 'Build' },
        { tone: 'neutral', text: 'Build' },
        { tone: 'neutral', text: 'Build#1' }
      ]}
    />
  )
  const { panel } = await mountPanel(ORGS, {}, { module: Probe })

  const keys = (panel.tree() as TreeSnapshot).children?.map(child => (typeof child === 'object' ? child.key : child))
  assert.equal(new Set(keys).size, 3)
  assert.equal(countNodes(panel.tree()), 7)
  await closeCleanly(panel)
})
