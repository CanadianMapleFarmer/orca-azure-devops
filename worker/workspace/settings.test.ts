import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { watchWorkspaceSettings, type WorkspaceSettings } from './settings'

async function drain(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

async function watched(host = mockHost()) {
  const seen: { settings?: WorkspaceSettings; api?: OrcaWorkerApi['settings'] } = {}
  await mountWorker(
    {
      default: async orca => {
        seen.api = orca.settings
        seen.settings = await watchWorkspaceSettings(orca.settings)
      }
    },
    { host }
  )
  return { settings: seen.settings as WorkspaceSettings, api: seen.api as OrcaWorkerApi['settings'] }
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

test('a failing settings read keeps the defaults', async () => {
  const { settings } = await watched(
    mockHost({
      results: {
        'settings.get': () => {
          throw hostError('unavailable')
        }
      }
    })
  )
  assert.deepEqual([settings.agentContext(), settings.defaultAgent(), settings.branchTemplate()], [false, 'claude', 'feature/{id}-{slug}'])
})
