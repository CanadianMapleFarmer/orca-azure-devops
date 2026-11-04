import { afterEach, assert, hostError, mockHost, mount, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import type { WorkSnapshot } from '../shared/work'
import * as panelModule from './panel'

const SETTINGS = { label: 'Organization settings' }

const PROJECTS = [
  { id: 'proj-web', name: 'Web' },
  { id: 'proj-boards', name: 'Boards' }
]

function org(name: string, over: Partial<OrgStatus> = {}): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'azure-cli',
    state: 'connected',
    account: { adoId: `u-${name}`, uniqueName: `ada@${name}.com`, displayName: 'Ada Lovelace', tenantId: null, objectId: null },
    tokenStore: { kind: 'az-profile', path: `/Users/ada/.orca-azure-devops/az/${name}` },
    boards: null,
    codeProjects: 'all',
    ...over
  }
}

let panel: TestPanel

async function closeCleanly(): Promise<void> {
  const issues = { errors: panel.errors, warnings: panel.warnings, refusals: panel.refusals }
  await panel.unmount()
  assert.deepEqual(issues, { errors: [], warnings: [], refusals: [] })
}

afterEach(closeCleanly)

async function open(list: OrgStatus[], requests: MockRequests = {}) {
  const host = mockHost({
    requests: {
      'orgs.list': list,
      'ui.visibility': { ok: true },
      'work.snapshot': input => ({ org: input.org, board: null, mine: [], other: [], nudges: [], updatedAt: 0, stale: false }),
      ...requests
    }
  })
  panel = await mount(panelModule, { host })
  return host
}

const requestsTo = (host: ReturnType<typeof mockHost>, name: string) =>
  (host.callsOf('plugin.request') as { name: string; input: unknown }[]).filter(call => call.name === name)

const optionValues = (label: string) =>
  ((panel.find({ label })?.props as { options: { value: string }[] }).options ?? []).map(option => option.value)

const settingsRequests: MockRequests = {
  'ado.projects': PROJECTS,
  'ado.teams': []
}

const OPS = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
const ALPHA = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-alpha', teamName: 'Alpha' }
const RULE_COLUMNS = ['New', 'Active', 'Resolved']
const SUGGEST_MOVES = { type: 'Collapsible' }

type Rule = { branch: string; column: string }

function snapshotFor(name: string): WorkSnapshot {
  return {
    org: name,
    board: {
      org: name,
      projectId: OPS.projectId,
      teamId: OPS.teamId,
      boardId: 'board-stories',
      boardName: 'Stories',
      requirementTypes: ['User Story'],
      columns: RULE_COLUMNS.map((column, index) => ({ id: `col-${index}`, name: column, isSplit: false, columnType: 'inProgress', stateMappings: {} })),
      lanes: [],
      fields: { column: 'WEF_1_Kanban.Column', columnDone: 'WEF_1_Kanban.Column.Done', lane: 'WEF_1_Kanban.Lane' },
      areaPaths: [],
      doneStates: {}
    },
    mine: [],
    other: [],
    nudges: [],
    updatedAt: 0,
    stale: false
  }
}

function ruleRequests(stored: Rule[] = []) {
  const saves: { org: string; teamId: string; rules: Rule[] }[] = []
  const requests: MockRequests = {
    ...settingsRequests,
    'work.snapshot': input => snapshotFor(input.org),
    'work.nudgeRules': ({ org, teamId, rules }) => {
      if (!rules) return { rules: stored }
      saves.push({ org, teamId, rules })
      return { rules }
    }
  }
  return { saves, requests }
}

const branches = () => panel.findAll({ label: 'Branch' })
const columns = () => panel.findAll({ label: 'Column' })

async function openRules(stored: Rule[] = [], boards: OrgStatus['boards'] = OPS) {
  const rules = ruleRequests(stored)
  const host = await open([org('contoso', { boards })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  return { ...rules, host }
}

test('rules load, edit and save', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  const host = await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.title, 'Suggest moves')
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.open, false)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules'), [], 'nothing loads until the section opens')

  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules').map(call => call.input), [{ org: 'contoso', teamId: 'team-ops' }])
  assert.equal(requestsTo(host, 'work.snapshot').length, 1, 'the columns come from the Work snapshot already loaded')
  assert.ok(panel.find({ text: 'When a linked PR merges into this branch, suggest moving the item to this column.' }))
  assert.equal(branches().length, 1)
  assert.equal(panel.valueOf(branches()[0]), 'uat')
  assert.equal(panel.valueOf(columns()[0]), 'Resolved')
  assert.deepEqual(optionValues('Column'), RULE_COLUMNS)
  assert.equal(branches()[0].props.placeholder, 'uat')

  await panel.type(branches()[0], 'staging', { replace: true })
  await panel.select(columns()[0], 'Active')
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 2)
  assert.equal(panel.valueOf(branches()[1]), '')
  await panel.type(branches()[1], 'release/2026.11')
  await panel.select(columns()[1], 'Resolved')
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 3)
  await panel.press(panel.findAll({ label: 'Remove rule' })[2])
  assert.equal(branches().length, 2)
  assert.deepEqual(rules.saves, [])

  await panel.press({ text: 'Save rules' })
  assert.deepEqual(rules.saves, [
    {
      org: 'contoso',
      teamId: 'team-ops',
      rules: [{ branch: 'staging', column: 'Active' }, { branch: 'release/2026.11', column: 'Resolved' }]
    }
  ])
  assert.equal(branches().length, 2)
  assert.equal(panel.find({ type: 'Callout' }), null)

  await panel.press(panel.findAll({ label: 'Remove rule' })[0])
  assert.deepEqual(branches().map(row => panel.valueOf(row)), ['release/2026.11'])
})

test('empty branch rows are not saved', async () => {
  const { saves } = await openRules()
  assert.equal(branches().length, 0)
  await panel.press({ text: 'Add rule' })
  await panel.press({ text: 'Add rule' })
  await panel.press({ text: 'Add rule' })
  await panel.type(branches()[0], '  uat  ')
  await panel.select(columns()[0], 'Resolved')
  await panel.type(branches()[2], '   ')
  await panel.select(columns()[2], 'Active')

  await panel.press({ text: 'Save rules' })
  assert.deepEqual(saves, [{ org: 'contoso', teamId: 'team-ops', rules: [{ branch: 'uat', column: 'Resolved' }] }])
  assert.equal(branches().length, 1, 'the empty rows are gone once the saved rules come back')
  assert.equal(panel.valueOf(branches()[0]), 'uat')
})

test('Suggest moves only shows when the org has a boards team', async () => {
  const host = await open([org('contoso')], ruleRequests().requests)
  await panel.press(SETTINGS)
  assert.equal(panel.find(SUGGEST_MOVES), null)

  await panel.post('orgs.changed', { orgs: [org('contoso', { boards: OPS })] })
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.title, 'Suggest moves')

  await panel.post('orgs.changed', { orgs: [org('contoso')] })
  assert.equal(panel.find(SUGGEST_MOVES), null)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules'), [])
})

test('a failed save shows the message in a danger callout and keeps the edits', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  let refuse = true
  rules.requests['work.nudgeRules'] = ({ rules: sent }) => {
    if (!sent) return { rules: [{ branch: 'uat', column: 'Resolved' }] }
    if (refuse) throw hostError('action_failed', "That column isn't on this board.")
    return { rules: sent }
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  await panel.type(branches()[0], 'staging', { replace: true })
  await panel.press({ text: 'Save rules' })

  const callout = panel.find({ type: 'Callout' })
  assert.equal(callout?.props?.tone, 'danger')
  assert.equal(callout?.text, "That column isn't on this board.")
  assert.equal(panel.valueOf(branches()[0]), 'staging')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)

  refuse = false
  await panel.press({ text: 'Save rules' })
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('rules that fail to load show the message and can be retried', async () => {
  const rules = ruleRequests()
  let attempts = 0
  rules.requests['work.nudgeRules'] = () => {
    attempts += 1
    if (attempts === 1) throw hostError('action_failed', "Couldn't read the saved rules.")
    return { rules: [{ branch: 'uat', column: 'Resolved' }] }
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  assert.equal(panel.find({ type: 'Callout' })?.props?.tone, 'danger')
  assert.equal(panel.find({ type: 'Callout' })?.text, "Couldn't read the saved rules.")
  assert.equal(panel.find({ text: 'Add rule' }), null)

  await panel.press({ text: 'Try again' })
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.valueOf(branches()[0]), 'uat')
})

test('the columns come from work.snapshot when the Work tab has none loaded', async () => {
  const rules = ruleRequests([{ branch: 'uat', column: 'Resolved' }])
  let snapshots = 0
  rules.requests['work.snapshot'] = input => {
    snapshots += 1
    if (snapshots === 1) throw hostError('action_failed', "Couldn't load work items.")
    return snapshotFor(input.org)
  }
  await open([org('contoso', { boards: OPS })], rules.requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  assert.equal(snapshots, 2)
  assert.deepEqual(optionValues('Column'), RULE_COLUMNS)
  assert.equal(panel.find({ type: 'Callout' }), null)
})

test('at most 20 rules can be added', async () => {
  const stored = Array.from({ length: 19 }, (_, index) => ({ branch: `release/${index}`, column: 'Resolved' }))
  await openRules(stored)
  assert.equal(branches().length, 19)
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, false)
  await panel.press({ text: 'Add rule' })
  assert.equal(branches().length, 20)
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, true)
  await panel.press(panel.findAll({ label: 'Remove rule' })[0])
  assert.equal(panel.find({ text: 'Add rule' })?.disabled, false)
})

test('changing the boards team closes Suggest moves and loads that team\'s rules next time', async () => {
  const { host } = await openRules([{ branch: 'uat', column: 'Resolved' }])
  assert.equal(branches().length, 1)

  await panel.post('orgs.changed', { orgs: [org('contoso', { boards: ALPHA })] })
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.open, false)
  assert.equal(branches().length, 0)

  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules').map(call => call.input), [
    { org: 'contoso', teamId: 'team-ops' },
    { org: 'contoso', teamId: 'team-alpha' }
  ])
})
