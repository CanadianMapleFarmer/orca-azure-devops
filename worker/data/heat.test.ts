import { assert, test } from 'orca/testing'
import { COLD_EVERY_MS, createHeat, HOT_FOR_MS } from './heat'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const LONGEST_TICK_MS = 2 * MINUTE
const COLD_DUE_MS = COLD_EVERY_MS - LONGEST_TICK_MS
const WEB = { id: 'web', name: 'Fabrikam Web' }
const PLATFORM = { id: 'platform', name: 'Fabrikam Platform' }
const PROJECTS = [WEB, PLATFORM]

type List = 'mine' | 'review'

function setup() {
  const clock = { now: T0 }
  const heat = createHeat<List>(() => clock.now, LONGEST_TICK_MS)
  const picked = (list: List = 'mine') => PROJECTS.filter(project => heat.due(list, project.id)).map(project => project.id)
  return { clock, heat, picked }
}

test('a project never read is due at once', () => {
  const { heat, picked } = setup()
  assert.deepEqual(picked(), ['web', 'platform'])
  heat.saw('mine', WEB.id, false)
  assert.deepEqual(picked(), ['platform'])
})

test('a hot project is due every tick, and a cold one early enough that the longest tick still reads it within 5 minutes', () => {
  const { clock, heat, picked } = setup()
  heat.saw('mine', WEB.id, true)
  heat.saw('mine', PLATFORM.id, false)

  for (let minute = 1; minute < 3; minute += 1) {
    clock.now = T0 + minute * MINUTE
    assert.deepEqual(picked(), ['web'], `minute ${minute}`)
    heat.saw('mine', WEB.id, true)
  }
  clock.now = T0 + COLD_DUE_MS - 1
  assert.deepEqual(picked(), ['web'])
  clock.now = T0 + COLD_DUE_MS
  assert.deepEqual(picked(), ['web', 'platform'])
  assert.ok(COLD_DUE_MS + LONGEST_TICK_MS <= COLD_EVERY_MS, 'a tick the longest interval later is still within 5 minutes')
  heat.saw('mine', PLATFORM.id, false)
  clock.now += MINUTE
  assert.deepEqual(picked(), ['web'], 'the wait counts from its last read')
})

test('each list keeps its own read time, so reading one list never makes another wait', () => {
  const { clock, heat, picked } = setup()
  heat.saw('mine', PLATFORM.id, false)
  heat.saw('review', PLATFORM.id, false)

  clock.now = T0 + COLD_DUE_MS
  heat.saw('review', PLATFORM.id, false)
  assert.deepEqual(picked('review'), ['web'], 'the review list was just read')
  assert.deepEqual(picked('mine'), ['web', 'platform'], 'the mine list is still due')
})

test('a project that found something stays hot for 24 hours, for every list', () => {
  const { clock, heat, picked } = setup()
  heat.saw('mine', PLATFORM.id, true)
  heat.saw('mine', WEB.id, false)
  heat.saw('review', PLATFORM.id, false)
  heat.saw('review', WEB.id, false)

  clock.now = T0 + MINUTE
  heat.saw('mine', PLATFORM.id, false)
  assert.deepEqual(picked(), ['platform'], 'an empty read does not cool it')
  assert.deepEqual(picked('review'), ['platform'], 'what one list found makes the project hot for the others')

  clock.now = T0 + HOT_FOR_MS - 1
  heat.saw('mine', WEB.id, false)
  heat.saw('mine', PLATFORM.id, false)
  assert.deepEqual(picked(), ['platform'])
  clock.now = T0 + HOT_FOR_MS
  assert.deepEqual(picked(), [], '24 hours after it last found something, it is cold')
})
