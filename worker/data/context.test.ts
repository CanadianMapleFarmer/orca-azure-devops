import type { OrcaWorkerApi } from 'orca/worker'
import { assert, test } from 'orca/testing'
import {
  currentContext,
  featureOfJob,
  featureOfRequest,
  fly,
  inLane,
  join,
  onRaise,
  raise,
  withUserContext,
  type Feature,
  type Lane
} from './context'

function seen() {
  const { feature, lane } = currentContext()
  return { feature, priority: lane.priority }
}

function gate() {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { open, opened }
}

test('inLane is visible across awaits and timers inside the run', async () => {
  const inside = await inLane('prs', 'hidden', async () => {
    await Promise.resolve()
    const afterAwait = seen()
    const afterImmediate = await new Promise(resolve => setImmediate(() => resolve(seen())))
    return { afterAwait, afterImmediate }
  })
  assert.deepEqual(inside, { afterAwait: { feature: 'prs', priority: 'hidden' }, afterImmediate: { feature: 'prs', priority: 'hidden' } })
})

test('outside any context the default is a user request for other', () => {
  assert.deepEqual(seen(), { feature: 'other', priority: 'user' })
})

test('featureOfRequest maps request names to features', () => {
  const rows: [string, unknown, Feature][] = [
    ['work.board', { org: 'contoso' }, 'board'],
    ['work.boards', { org: 'contoso' }, 'board'],
    ['work.openBoard', { org: 'contoso' }, 'board'],
    ['work.snapshot', { org: 'contoso' }, 'work'],
    ['work.move', { org: 'contoso' }, 'work'],
    ['prs.snapshot', { org: 'contoso' }, 'prs'],
    ['reviews.open', { org: 'contoso' }, 'reviews'],
    ['runs.view', { org: 'contoso' }, 'run'],
    ['runs.log', { org: 'contoso' }, 'run'],
    ['runs.openFile', { org: 'contoso' }, 'run'],
    ['runs.snapshot', { org: 'contoso' }, 'pipelines'],
    ['runs.decide', { org: 'contoso' }, 'pipelines'],
    ['wiki.search', { org: 'contoso' }, 'wiki'],
    ['share.send', { org: 'contoso' }, 'share'],
    ['orgs.connect', { org: 'contoso' }, 'connect'],
    ['ado.projects', { org: 'contoso' }, 'connect'],
    ['ui.visibility', { surface: 'work', org: 'contoso', visible: true }, 'work'],
    ['ui.visibility', { surface: 'board', org: 'contoso', visible: true }, 'board'],
    ['ui.visibility', { surface: 'prs', org: 'contoso', visible: true }, 'prs'],
    ['ui.visibility', { surface: 'pipelines', org: 'contoso', visible: true }, 'pipelines'],
    ['ui.visibility', { surface: 'run', org: 'contoso', visible: true }, 'run'],
    ['ui.visibility', { surface: 'wiki', org: 'contoso', visible: true }, 'other'],
    ['ui.visibility', undefined, 'other'],
    ['plugin.ping', undefined, 'other'],
    ['workspace.arm', { org: 'contoso' }, 'other']
  ]
  assert.deepEqual(
    rows.map(([name, input]) => [name, featureOfRequest(name, input)]),
    rows.map(([name, , feature]) => [name, feature])
  )
})

test('featureOfJob maps job keys to features', () => {
  const rows: [string, Feature][] = [
    ['mine:contoso', 'work'],
    ['board:contoso:t:b', 'board'],
    ['prs:contoso', 'prs'],
    ['runs:contoso', 'pipelines'],
    ['watch:contoso', 'pipelines'],
    ['runview:contoso:42', 'run'],
    ['arm-expiry', 'other']
  ]
  assert.deepEqual(
    rows.map(([key]) => [key, featureOfJob(key)]),
    rows
  )
})

test('fly runs in its own lane; a user join raises it and a background join does not', async () => {
  const release = gate()
  const flight = inLane('board', 'hidden', () => fly(async () => {
    const before = seen()
    await release.opened
    return { before, lane: currentContext().lane }
  }))
  assert.equal(flight.lane.priority, 'hidden')

  const background = inLane('board', 'visible', () => join(flight))
  assert.equal(flight.lane.priority, 'hidden', 'a background join leaves the lane where it was')

  const user = inLane('work', 'user', () => join(flight))
  assert.equal(flight.lane.priority, 'user', 'a user join raises the lane')

  release.open()
  const answers = await Promise.all([background, user])
  assert.deepEqual(answers[0].before, { feature: 'board', priority: 'hidden' })
  assert.equal(answers[0].lane, flight.lane, 'the run sees the flight lane, not the caller lane')
  assert.equal(answers[1], answers[0])
})

test('fly carries the caller feature and priority into a fresh lane', () => {
  const [outer, flight] = inLane('prs', 'visible', () => [currentContext().lane, fly(async () => seen())] as const)
  assert.notEqual(flight.lane, outer)
  assert.equal(flight.lane.priority, 'visible')
})

test('raise tells every onRaise listener once', () => {
  const first: Lane[] = []
  const second: Lane[] = []
  const stopFirst = onRaise(lane => first.push(lane))
  const stopSecond = onRaise(lane => second.push(lane))
  try {
    const lane = inLane('pipelines', 'hidden', () => currentContext().lane)
    raise(lane)
    raise(lane)
    assert.equal(lane.priority, 'user')
    assert.deepEqual(first, [lane])
    assert.deepEqual(second, [lane])

    raise(inLane('pipelines', 'user', () => currentContext().lane))
    assert.equal(first.length, 1, 'a lane that is already user is not raised again')
  } finally {
    stopFirst()
    stopSecond()
  }
})

test('withUserContext runs every handler as a user request for its feature, and leaves the rest of the API working', async () => {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>()
  const posts: { event: string; payload: unknown }[] = []
  const logs: string[] = []
  const panels = Object.create({
    handle(name: string, handler: (input: unknown, context: unknown) => unknown) {
      handlers.set(name, handler)
      return { dispose() {} }
    },
    post(event: string, payload: unknown) {
      posts.push({ event, payload })
    }
  })
  const orca = Object.create({ log: (message: string) => logs.push(message) }, { panels: { value: panels } }) as OrcaWorkerApi

  const host = withUserContext(orca)
  const register = host.panels.handle.bind(host.panels) as unknown as (name: string, handler: () => unknown) => void
  register('work.board', async () => {
    await Promise.resolve()
    return seen()
  })
  register('ui.visibility', () => seen())

  const call = (name: string, input: unknown) => (handlers.get(name) ?? assert.fail(`no ${name} handler`))(input, {})
  assert.deepEqual(await call('work.board', { org: 'contoso' }), { feature: 'board', priority: 'user' })
  assert.deepEqual(await call('ui.visibility', { surface: 'run', org: 'contoso', visible: true }), { feature: 'run', priority: 'user' })

  host.panels.post('work.changed', { org: 'contoso' } as never)
  host.log('still here')
  assert.deepEqual(posts, [{ event: 'work.changed', payload: { org: 'contoso' } }])
  assert.deepEqual(logs, ['still here'])
})
