import { assert, hostError, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../../orca-plugin.json' with { type: 'json' }
import { drain, withWorker } from '../test-support'
import { watchPrSettings, type PrSettings } from './settings'

const READ_FAILED = "Couldn't read settings; keeping the previous values."

test('settings fall back on unknown values and keep the last good read', async () => {
  const failing = { now: false }
  let saved: Record<string, unknown> = { autoCompleteMergeStrategy: 'octopus', autoCompleteDeleteSourceBranch: true, autoCompleteTransitionWorkItems: 'yes' }
  const host = mockHost({
    results: {
      'settings.get': () => {
        if (failing.now) throw hostError('unavailable', 'secret-detail')
        return { settings: saved }
      }
    }
  })
  const seen: { settings?: PrSettings; api?: OrcaWorkerApi['settings'] } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      seen.api = orca.settings
      seen.settings = await watchPrSettings(orca.settings, message => orca.log(message))
    }
  }
  await withWorker(module, { host }, async w => {
    const settings = seen.settings as PrSettings
    const api = seen.api as OrcaWorkerApi['settings']
    assert.deepEqual(settings.autoComplete(), { mergeStrategy: 'noFastForward', deleteSourceBranch: true, transitionWorkItems: false })

    saved = { autoCompleteMergeStrategy: 'rebaseMerge', autoCompleteTransitionWorkItems: true }
    await api.set('autoCompleteMergeStrategy', 'rebaseMerge')
    await drain()
    assert.deepEqual(settings.autoComplete(), { mergeStrategy: 'rebaseMerge', deleteSourceBranch: false, transitionWorkItems: true })

    failing.now = true
    await api.set('autoCompleteMergeStrategy', 'squash')
    await drain()
    assert.deepEqual(settings.autoComplete(), { mergeStrategy: 'rebaseMerge', deleteSourceBranch: false, transitionWorkItems: true })
    assert.deepEqual(w.logs, [READ_FAILED])
  })
})

test('the auto-complete settings are declared with their defaults and labels', () => {
  const declared = Object.fromEntries(manifest.contributes.settings.map(setting => [setting.key, setting]))
  assert.deepEqual(declared.autoCompleteMergeStrategy, {
    key: 'autoCompleteMergeStrategy',
    title: 'Auto-complete merge type',
    type: 'string',
    enum: ['noFastForward', 'squash', 'rebase', 'rebaseMerge'],
    enumLabels: ['Merge (no fast-forward)', 'Squash commit', 'Rebase and fast-forward', 'Semi-linear merge'],
    default: 'noFastForward'
  })
  assert.deepEqual(declared.autoCompleteDeleteSourceBranch, {
    key: 'autoCompleteDeleteSourceBranch',
    title: 'Auto-complete: delete the source branch',
    type: 'boolean',
    default: false
  })
  assert.deepEqual(declared.autoCompleteTransitionWorkItems, {
    key: 'autoCompleteTransitionWorkItems',
    title: 'Auto-complete: complete linked work items',
    type: 'boolean',
    default: false
  })
})
