import { Stack, Text, type OrcaNode } from 'orca'
import { assert, test, type TreeSnapshot } from 'orca/testing'
import { Chips } from './chips'
import { Group } from './group'
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

test('the toolbar puts the scope controls first and the icon buttons last, with Updated under it', async () => {
  const { panel } = await mountPanel(ORGS, {}, { module: Scoped })

  const tree = panel.tree() as TreeSnapshot
  assert.equal(tree.type, 'Stack')
  const [bar, updated, message, ...rest] = childrenOf(tree) as TreeSnapshot[]
  assert.deepEqual(rest, [])
  assert.deepEqual(bar, {
    type: 'Row',
    props: { justify: 'between', align: 'center', gap: 'sm', wrap: true },
    children: [
      {
        type: 'Box',
        props: { grow: true, shrink: true, minWidth: 0 },
        children: [{ type: 'Row', props: { gap: 'xs', wrap: true }, children: [{ type: 'Text', props: { size: 'sm' }, children: ['Scope'] }] }]
      },
      {
        type: 'Row',
        props: { gap: 'xs' },
        children: [
          { type: 'IconButton', key: REFRESH_LABEL, props: { icon: 'refresh', label: REFRESH_LABEL, variant: 'ghost', size: 'sm', onPress: '[handler]' } },
          { type: 'IconButton', key: 'Collapse all', props: { icon: 'collapse', label: 'Collapse all', variant: 'ghost', size: 'sm', onPress: '[handler]' } },
          { type: 'IconButton', key: 'Expand all', props: { icon: 'expand', label: 'Expand all', variant: 'ghost', size: 'sm', onPress: '[handler]' } }
        ]
      }
    ]
  })
  assert.deepEqual(updated, { type: 'Text', props: { muted: true, size: 'sm' }, children: ['Updated ', { type: 'RelativeTime', props: { at: NOW } }] })
  assert.deepEqual(message, { type: 'Text', props: { size: 'sm', tone: 'warning' }, children: ['Showing the last good copy.'] })
  await closeCleanly(panel)
})

test('a toolbar with no scope controls and no message keeps its buttons to the right and Updated under them', async () => {
  const Bare = () => <TabToolbar actions={foldActions('contoso', 'pipelines')} updatedAt={NOW} stale={false} />
  const { panel } = await mountPanel(ORGS, {}, { module: Bare })

  const [bar, updated, ...rest] = childrenOf(panel.tree() as TreeSnapshot) as TreeSnapshot[]
  assert.deepEqual(rest, [])
  assert.deepEqual(
    childrenOf(bar).map(child => (child as TreeSnapshot).type),
    ['Box', 'Row']
  )
  assert.deepEqual((childrenOf(bar)[0] as TreeSnapshot).props, { grow: true, shrink: true, minWidth: 0 })
  assert.equal((updated as TreeSnapshot).type, 'Text')
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
