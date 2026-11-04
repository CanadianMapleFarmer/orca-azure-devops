import { assert, test } from 'orca/testing'
import type { StorePort } from '../connections'
import { createLinkStore, LINKS_KEY } from './links'

const T0 = Date.parse('2026-11-04T09:00:00Z')

function memory(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const store: StorePort = {
    get: async <T,>(key: string) => (key in data ? (structuredClone(data[key]) as T) : null),
    set: async (key, value) => {
      data[key] = structuredClone(value)
    }
  }
  return { data, store }
}

function ticking() {
  let now = T0
  return () => (now += 1)
}

test('link remembers a workspace for its item and saves it', async () => {
  const { data, store } = memory()
  const links = await createLinkStore(store, ticking())
  assert.equal(links.byWorkspace('ws-1'), null)
  await links.link('ws-1', { org: 'contoso', itemId: 1204 })
  assert.deepEqual(links.byWorkspace('ws-1'), { org: 'contoso', itemId: 1204 })
  assert.equal(links.byItem('contoso', 1204), 'ws-1')
  assert.equal(links.byItem('fabrikam', 1204), null)
  assert.deepEqual(data[LINKS_KEY], { 'ws-1': { org: 'contoso', itemId: 1204, linkedAt: T0 + 1 } })
})

test('links load from storage at creation', async () => {
  const { store } = memory({ [LINKS_KEY]: { 'ws-1': { org: 'contoso', itemId: 1204, linkedAt: T0 } } })
  const links = await createLinkStore(store, ticking())
  assert.deepEqual(links.byWorkspace('ws-1'), { org: 'contoso', itemId: 1204 })
})

test('malformed stored links are ignored', async () => {
  for (const stored of [null, 'x', [], { 'ws-1': 'x', 'ws-2': { org: 'contoso' }, 'ws-3': { org: 7, itemId: 1, linkedAt: 1 }, 'ws-4': null }]) {
    const { store } = memory({ [LINKS_KEY]: stored })
    const links = await createLinkStore(store, ticking())
    for (const id of ['ws-1', 'ws-2', 'ws-3', 'ws-4']) assert.equal(links.byWorkspace(id), null)
  }
})

test('byItem answers the most recently linked workspace', async () => {
  const { store } = memory()
  const links = await createLinkStore(store, ticking())
  await links.link('ws-1', { org: 'contoso', itemId: 1204 })
  await links.link('ws-2', { org: 'contoso', itemId: 1204 })
  await links.link('ws-3', { org: 'contoso', itemId: 1205 })
  assert.equal(links.byItem('contoso', 1204), 'ws-2')
  await links.link('ws-1', { org: 'contoso', itemId: 1204 })
  assert.equal(links.byItem('contoso', 1204), 'ws-1', 'linking again makes it the latest')
})

test('byItem follows the stored link times after a restart', async () => {
  const { store } = memory({
    [LINKS_KEY]: {
      'ws-new': { org: 'contoso', itemId: 1204, linkedAt: T0 + 50 },
      'ws-old': { org: 'contoso', itemId: 1204, linkedAt: T0 }
    }
  })
  assert.equal((await createLinkStore(store, ticking())).byItem('contoso', 1204), 'ws-new')
})

test('a workspace links to one item at a time', async () => {
  const { data, store } = memory()
  const links = await createLinkStore(store, ticking())
  await links.link('ws-1', { org: 'contoso', itemId: 1204 })
  await links.link('ws-1', { org: 'contoso', itemId: 1205 })
  assert.deepEqual(links.byWorkspace('ws-1'), { org: 'contoso', itemId: 1205 })
  assert.equal(links.byItem('contoso', 1204), null)
  assert.deepEqual(Object.keys(data[LINKS_KEY] as object), ['ws-1'])
})

test('links are capped at 500 with the oldest dropped', async () => {
  const { data, store } = memory()
  const links = await createLinkStore(store, ticking())
  for (let id = 1; id <= 501; id += 1) await links.link(`ws-${id}`, { org: 'contoso', itemId: id })
  assert.equal(links.byWorkspace('ws-1'), null)
  assert.deepEqual(links.byWorkspace('ws-2'), { org: 'contoso', itemId: 2 })
  assert.deepEqual(links.byWorkspace('ws-501'), { org: 'contoso', itemId: 501 })
  assert.equal(Object.keys(data[LINKS_KEY] as object).length, 500)

  const reloaded = await createLinkStore(store, ticking())
  assert.equal(reloaded.byWorkspace('ws-1'), null)
  assert.deepEqual(reloaded.byWorkspace('ws-501'), { org: 'contoso', itemId: 501 })
})

test('a failed save rejects that link, keeps it in memory and does not block the next one', async () => {
  const { data, store } = memory()
  let failNext = true
  const links = await createLinkStore(
    {
      get: store.get,
      set: async (key, value) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        return store.set(key, value)
      }
    },
    ticking()
  )
  await assert.rejects(links.link('ws-1', { org: 'contoso', itemId: 1204 }), /disk full/)
  assert.equal(links.byItem('contoso', 1204), 'ws-1')
  await links.link('ws-2', { org: 'contoso', itemId: 1205 })
  assert.deepEqual(Object.keys(data[LINKS_KEY] as object), ['ws-1', 'ws-2'])
})
