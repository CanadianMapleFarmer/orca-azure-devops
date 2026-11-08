import { afterEach, assert, hostError, test, type MockRequests, type TestPanel } from 'orca/testing'
import type { OrgStatus } from '../shared/types'
import { NO_FAMILIES, type WorkSnapshot } from '../shared/work'
import { closeCleanly, mountPanel, optionValuesOf, org, PROJECTS, requestsTo, SETTINGS } from './test-support'

let panel: TestPanel

afterEach(() => closeCleanly(panel))

async function open(list: OrgStatus[], requests: MockRequests = {}) {
  const mounted = await mountPanel(list, requests)
  panel = mounted.panel
  return mounted.host
}

const optionValues = (label: string) => optionValuesOf(panel, label)

const settingsRequests: MockRequests = {
  'ado.projects': PROJECTS,
  'ado.teams': []
}

const OPS = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-ops', teamName: 'Ops' }
const ALPHA = { projectId: 'proj-boards', projectName: 'Boards', teamId: 'team-alpha', teamName: 'Alpha' }
const RULE_COLUMNS = ['New', 'Active', 'Resolved']
const SUGGEST_MOVES = { type: 'Collapsible' }

type Rule = { branch: string; column: string }

function snapshotFor(name: string, teamId = OPS.teamId): WorkSnapshot {
  return {
    org: name,
    board: {
      org: name,
      projectId: OPS.projectId,
      teamId,
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
    families: NO_FAMILIES,
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

test('Save rules waits for a column on every branch that is filled in', async () => {
  const { saves } = await openRules()
  await panel.press({ text: 'Add rule' })
  await panel.press({ text: 'Add rule' })
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)

  await panel.type(branches()[0], 'uat')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, true)

  await panel.select(columns()[0], 'Resolved')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)

  await panel.type(branches()[1], '   ')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false, 'a blank branch needs no column')
  await panel.type(branches()[1], 'qa')
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, true)

  await panel.press(panel.findAll({ label: 'Remove rule' })[1])
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)
  await panel.press({ text: 'Save rules' })
  assert.deepEqual(saves, [{ org: 'contoso', teamId: 'team-ops', rules: [{ branch: 'uat', column: 'Resolved' }] }])
})

type Held = { rules: Rule[] }

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0))
}

const branchValues = () => branches().map(row => row.props.value)
const loadingRules = () => panel.find({ type: 'Skeleton' }) !== null
const savingRules = () => panel.find({ type: 'Spinner' }) !== null

const UAT: Rule = { branch: 'uat', column: 'Resolved' }
const QA: Rule = { branch: 'qa', column: 'Active' }
const STALE: Rule = { branch: 'stale', column: 'New' }

test('settings for another org open with Suggest moves closed and empty', async () => {
  const stored: Record<string, Rule[]> = { contoso: [UAT], fabrikam: [QA] }
  const saves: unknown[] = []
  const host = await open([org('contoso', { boards: OPS }), org('fabrikam', { boards: ALPHA })], {
    ...settingsRequests,
    'work.snapshot': input => snapshotFor(input.org, input.org === 'fabrikam' ? ALPHA.teamId : OPS.teamId),
    'work.nudgeRules': ({ org: name, teamId, rules }) => {
      if (!rules) return { rules: stored[name] }
      saves.push({ org: name, teamId, rules })
      return { rules }
    }
  })
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(branchValues(), ['uat'])

  await panel.press({ text: 'Back' })
  await panel.select({ label: 'Organization' }, 'fabrikam')
  await panel.press(SETTINGS)
  assert.equal(panel.find(SUGGEST_MOVES)?.props?.open, false)
  assert.equal(branches().length, 0)
  assert.equal(panel.find({ type: 'Callout' }), null)

  await panel.toggle(SUGGEST_MOVES)
  assert.deepEqual(requestsTo(host, 'work.nudgeRules').map(call => call.input), [
    { org: 'contoso', teamId: 'team-ops' },
    { org: 'fabrikam', teamId: 'team-alpha' }
  ])
  assert.deepEqual(branchValues(), ['qa'])
  await panel.press({ text: 'Save rules' })
  assert.deepEqual(saves, [{ org: 'fabrikam', teamId: 'team-alpha', rules: [QA] }])
})

function heldActs() {
  const acts: Promise<void>[] = []
  return {
    during(act: Promise<void>): Promise<void> {
      acts.push(act)
      return flush()
    },
    finished: () => Promise.all(acts)
  }
}

async function staleLoad(finishStale: (held: ReturnType<typeof deferred<Held>>) => void): Promise<void> {
  const loads = [deferred<Held>(), deferred<Held>()]
  let started = 0
  const { requests } = ruleRequests()
  requests['work.nudgeRules'] = () => loads[started++].promise
  await open([org('contoso', { boards: OPS })], requests)
  await panel.press(SETTINGS)
  const { during, finished } = heldActs()
  await during(panel.toggle(SUGGEST_MOVES))
  assert.ok(loadingRules())

  await during(panel.press({ text: 'Back' }))
  await during(panel.press(SETTINGS))
  await during(panel.toggle(SUGGEST_MOVES))
  assert.equal(started, 2)

  loads[1].resolve({ rules: [UAT] })
  await flush()
  finishStale(loads[0])
  await finished()
  assert.deepEqual(branchValues(), ['uat'])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(loadingRules(), false)
}

test('a rules load that finishes after settings were re-entered adds no rows', async () => {
  await staleLoad(held => held.resolve({ rules: [STALE] }))
})

test('a rules load that fails after settings were re-entered shows no error', async () => {
  await staleLoad(held => held.reject(hostError('action_failed', 'Stale load failed.')))
})

async function staleSave(finishStale: (held: ReturnType<typeof deferred<Held>>) => void): Promise<void> {
  const saves = [deferred<Held>(), deferred<Held>()]
  let started = 0
  const { requests } = ruleRequests()
  requests['work.nudgeRules'] = ({ teamId, rules }) => (rules ? saves[started++].promise : { rules: [teamId === 'team-alpha' ? QA : UAT] })
  await open([org('contoso', { boards: OPS })], requests)
  await panel.press(SETTINGS)
  await panel.toggle(SUGGEST_MOVES)
  const { during, finished } = heldActs()
  await during(panel.press({ text: 'Save rules' }))
  assert.ok(savingRules())

  await during(panel.post('orgs.changed', { orgs: [org('contoso', { boards: ALPHA })] }))
  await during(panel.toggle(SUGGEST_MOVES))
  await during(panel.press({ text: 'Save rules' }))
  assert.equal(started, 2)

  saves[1].resolve({ rules: [QA] })
  await flush()
  finishStale(saves[0])
  await finished()
  assert.deepEqual(branchValues(), ['qa'])
  assert.equal(panel.find({ type: 'Callout' }), null)
  assert.equal(panel.find({ text: 'Save rules' })?.disabled, false)
  assert.equal(savingRules(), false)
}

test('a save that finishes after the team changed leaves the rows alone', async () => {
  await staleSave(held => held.resolve({ rules: [STALE] }))
})

test('a save that fails after the team changed shows no error', async () => {
  await staleSave(held => held.reject(hostError('action_failed', "That column isn't on this board.")))
})
