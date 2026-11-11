import { assert, test } from 'orca/testing'
import { COLD_EVERY_MS, createHeat, HOT_FOR_MS } from './heat'

const T0 = Date.parse('2026-11-11T10:00:00Z')
const MINUTE = 60_000
const WEB = { id: 'web', name: 'Fabrikam Web' }
const PLATFORM = { id: 'platform', name: 'Fabrikam Platform' }
const PROJECTS = [WEB, PLATFORM]

function setup() {
  const clock = { now: T0 }
  const heat = createHeat(() => clock.now)
  const picked = (all = false) => heat.pick(PROJECTS, all).map(project => project.id)
  return { clock, heat, picked }
}

test('a project never read is picked at once', () => {
  const { heat, picked } = setup()
  assert.deepEqual(picked(), ['web', 'platform'])
  heat.saw(WEB.id, false)
  assert.deepEqual(picked(), ['platform'])
})

test('a hot project is picked every tick, and a cold one at most every 5 minutes', () => {
  const { clock, heat, picked } = setup()
  heat.saw(WEB.id, true)
  heat.saw(PLATFORM.id, false)

  for (let minute = 1; minute < 5; minute += 1) {
    clock.now = T0 + minute * MINUTE
    assert.deepEqual(picked(), ['web'], `minute ${minute}`)
    heat.saw(WEB.id, true)
  }
  clock.now = T0 + COLD_EVERY_MS - 1
  assert.deepEqual(picked(), ['web'])
  clock.now = T0 + COLD_EVERY_MS
  assert.deepEqual(picked(), ['web', 'platform'])
  heat.saw(PLATFORM.id, false)
  clock.now += MINUTE
  assert.deepEqual(picked(), ['web'], 'the 5 minutes count from its last read')
})

test('a project that found something stays hot for 24 hours', () => {
  const { clock, heat, picked } = setup()
  heat.saw(PLATFORM.id, true)
  heat.saw(WEB.id, false)

  clock.now = T0 + MINUTE
  heat.saw(PLATFORM.id, false)
  assert.deepEqual(picked(), ['platform'], 'an empty read does not cool it')

  clock.now = T0 + HOT_FOR_MS - 1
  heat.saw(WEB.id, false)
  heat.saw(PLATFORM.id, false)
  assert.deepEqual(picked(), ['platform'])
  clock.now = T0 + HOT_FOR_MS
  assert.deepEqual(picked(), [], '24 hours after it last found something, it is cold')
})

test('all picks every project', () => {
  const { heat, picked } = setup()
  heat.saw(WEB.id, false)
  heat.saw(PLATFORM.id, false)
  assert.deepEqual(picked(), [])
  assert.deepEqual(picked(true), ['web', 'platform'])
})
