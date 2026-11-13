import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../../orca-plugin.json' with { type: 'json' }
import { drain } from '../test-support'
import { DEFAULT_CLONE_FOLDER } from './clone'
import { watchWorkspaceSettings, type WorkspaceSettings } from './settings'

async function watched(host = mockHost()) {
  const seen: { settings?: WorkspaceSettings; api?: OrcaWorkerApi['settings'] } = {}
  const w = await mountWorker(
    {
      default: async orca => {
        seen.api = orca.settings
        seen.settings = await watchWorkspaceSettings(orca.settings, message => orca.log(message))
      }
    },
    { host }
  )
  return { w, settings: seen.settings as WorkspaceSettings, api: seen.api as OrcaWorkerApi['settings'] }
}

test('workspace settings fall back to the defaults', async () => {
  const { settings } = await watched()
  assert.deepEqual([settings.agentContext(), settings.defaultAgent(), settings.branchTemplate()], [false, 'claude', 'feature/{id}-{slug}'])
})

test('workspace settings read what the person saved', async () => {
  const { settings } = await watched(mockHost({ settings: { agentContext: true, defaultAgent: ' codex ', branchTemplate: 'users/ada/{id}' } }))
  assert.deepEqual([settings.agentContext(), settings.defaultAgent(), settings.branchTemplate()], [true, 'codex', 'users/ada/{id}'])
})

test('a blank default agent means claude', async () => {
  const { settings } = await watched(mockHost({ settings: { defaultAgent: '   ' } }))
  assert.equal(settings.defaultAgent(), 'claude')
})

test('workspace settings follow changes made while the worker runs', async () => {
  const { settings, api } = await watched()
  await api.set('agentContext', true)
  await api.set('defaultAgent', 'codex')
  await api.set('branchTemplate', 'work/{id}')
  await drain()
  assert.deepEqual([settings.agentContext(), settings.defaultAgent(), settings.branchTemplate()], [true, 'codex', 'work/{id}'])
})

const READ_FAILED = "Couldn't read settings; keeping the previous values."

test('a failing settings read keeps the defaults and says so in the log without the error text', async () => {
  const { w, settings } = await watched(
    mockHost({
      results: {
        'settings.get': () => {
          throw hostError('unavailable', 'secret-detail')
        }
      }
    })
  )
  assert.deepEqual([settings.agentContext(), settings.defaultAgent(), settings.branchTemplate()], [false, 'claude', 'feature/{id}-{slug}'])
  assert.deepEqual(w.logs, [READ_FAILED])
})

test('a settings read that fails after a change keeps the values read before', async () => {
  let failing = false
  const { w, settings, api } = await watched(
    mockHost({
      settings: { defaultAgent: 'codex' },
      results: {
        'settings.get': () => {
          if (failing) throw hostError('unavailable')
          return { settings: { defaultAgent: 'codex' } }
        }
      }
    })
  )
  failing = true
  await api.set('agentContext', true)
  await drain()
  assert.equal(settings.defaultAgent(), 'codex')
  assert.equal(settings.agentContext(), false)
  assert.deepEqual(w.logs, [READ_FAILED])
})

test("the default agent setting names the item's Start buttons", () => {
  const setting = manifest.contributes.settings.find(entry => entry.key === 'defaultAgent')
  assert.equal(setting?.description, "The agent an item's Start buttons run, such as claude or codex.")
})

test('Folder for new clones defaults to ~/orca/repos and keeps what the user sets', async () => {
  assert.equal((await watched()).settings.cloneFolder(), DEFAULT_CLONE_FOLDER)
  assert.equal((await watched(mockHost({ settings: { cloneFolder: '  ' } }))).settings.cloneFolder(), '~/orca/repos')
  assert.equal((await watched(mockHost({ settings: { cloneFolder: '/srv/repos' } }))).settings.cloneFolder(), '/srv/repos')
  const setting = manifest.contributes.settings.find(entry => entry.key === 'cloneFolder')
  assert.equal(setting?.title, 'Folder for new clones')
  assert.equal(setting?.default, DEFAULT_CLONE_FOLDER)
})
