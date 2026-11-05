import { assert, hostError, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../../orca-plugin.json' with { type: 'json' }
import { drain, withWorker } from '../test-support'
import { watchPipelineSettings, type PipelineSettings } from './settings'

const READ_FAILED = "Couldn't read settings; keeping the previous values."

test('toggles default to on and keep the last good read', async () => {
  const failing = { now: false }
  let saved: Record<string, unknown> = {}
  const host = mockHost({
    results: {
      'settings.get': () => {
        if (failing.now) throw hostError('unavailable', 'secret-detail')
        return { settings: saved }
      }
    }
  })
  const seen: { settings?: PipelineSettings; api?: OrcaWorkerApi['settings'] } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      seen.api = orca.settings
      seen.settings = await watchPipelineSettings(orca.settings, message => orca.log(message))
    }
  }
  await withWorker(module, { host }, async w => {
    const settings = seen.settings as PipelineSettings
    const api = seen.api as OrcaWorkerApi['settings']
    const change = async (next: Record<string, unknown>) => {
      saved = next
      await api.set('notifyRunFailures', 'changed')
      await drain()
    }
    assert.deepEqual(settings.notify(), { failures: true, approvals: true, watched: true })

    await change({ notifyRunFailures: false, notifyApprovals: 'no', notifyWatchedRuns: 0 })
    assert.deepEqual(settings.notify(), { failures: false, approvals: true, watched: true })

    await change({ notifyRunFailures: null, notifyApprovals: false, notifyWatchedRuns: false })
    assert.deepEqual(settings.notify(), { failures: true, approvals: false, watched: false })

    failing.now = true
    await change({ notifyRunFailures: false, notifyApprovals: true, notifyWatchedRuns: true })
    assert.deepEqual(settings.notify(), { failures: true, approvals: false, watched: false })
    assert.deepEqual(w.logs, [READ_FAILED])

    failing.now = false
    await change({ notifyApprovals: true })
    assert.deepEqual(settings.notify(), { failures: true, approvals: true, watched: true })
  })
})

test('the notification settings and capability are declared', () => {
  const declared = Object.fromEntries(manifest.contributes.settings.map(setting => [setting.key, setting]))
  assert.deepEqual(declared.notifyRunFailures, {
    key: 'notifyRunFailures',
    title: 'Notify when my pipeline runs fail',
    type: 'boolean',
    default: true
  })
  assert.deepEqual(declared.notifyApprovals, {
    key: 'notifyApprovals',
    title: 'Notify when a run waits for approval',
    description: 'Your runs, and approvals you can give.',
    type: 'boolean',
    default: true
  })
  assert.deepEqual(declared.notifyWatchedRuns, {
    key: 'notifyWatchedRuns',
    title: 'Notify when a watched run finishes',
    type: 'boolean',
    default: true
  })
  assert.ok(manifest.capabilities.some(capability => capability.kind === 'notifications:show'))
})
