import { assert, hostError, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../../orca-plugin.json' with { type: 'json' }
import { MERGE_STRATEGY_LABELS } from '../../src/shared/prs'
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
    enum: Object.keys(MERGE_STRATEGY_LABELS),
    enumLabels: Object.values(MERGE_STRATEGY_LABELS),
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

test('the pull request notification toggles default to on and follow the settings', async () => {
  let saved: Record<string, unknown> = {}
  const host = mockHost({ results: { 'settings.get': () => ({ settings: saved }) } })
  const seen: { settings?: PrSettings; api?: OrcaWorkerApi['settings'] } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      seen.api = orca.settings
      seen.settings = await watchPrSettings(orca.settings, message => orca.log(message))
    }
  }
  await withWorker(module, { host }, async () => {
    const settings = seen.settings as PrSettings
    const api = seen.api as OrcaWorkerApi['settings']
    const change = async (next: Record<string, unknown>) => {
      saved = next
      await api.set('notifyReviewRequests', 'changed')
      await drain()
    }
    assert.deepEqual(settings.notify(), { reviews: true, comments: true })

    await change({ notifyReviewRequests: false, notifyPrComments: 'no' })
    assert.deepEqual(settings.notify(), { reviews: false, comments: true })

    await change({ notifyReviewRequests: null, notifyPrComments: false })
    assert.deepEqual(settings.notify(), { reviews: true, comments: false })
  })
})

test('the pull request notification settings are declared after notifyWatchedRuns, on by default', () => {
  const keys = manifest.contributes.settings.map(setting => setting.key)
  const watched = keys.indexOf('notifyWatchedRuns')
  assert.deepEqual(keys.slice(watched, watched + 3), ['notifyWatchedRuns', 'notifyReviewRequests', 'notifyPrComments'])
  const declared = Object.fromEntries(manifest.contributes.settings.map(setting => [setting.key, setting]))
  assert.deepEqual(declared.notifyReviewRequests, {
    key: 'notifyReviewRequests',
    title: 'Notify when someone asks for my review',
    type: 'boolean',
    default: true
  })
  assert.deepEqual(declared.notifyPrComments, {
    key: 'notifyPrComments',
    title: 'Notify about new comments on my pull requests',
    type: 'boolean',
    default: true
  })
})

test('shareTemplate falls back to the default when empty or not a string', async () => {
  let saved: Record<string, unknown> = {}
  const host = mockHost({ results: { 'settings.get': () => ({ settings: saved }) } })
  const seen: { settings?: PrSettings; api?: OrcaWorkerApi['settings'] } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      seen.api = orca.settings
      seen.settings = await watchPrSettings(orca.settings, message => orca.log(message))
    }
  }
  await withWorker(module, { host }, async () => {
    const settings = seen.settings as PrSettings
    const api = seen.api as OrcaWorkerApi['settings']
    const DEFAULT = '[Pull Request {id}]({url}): {title}'
    assert.equal(settings.shareTemplate(), DEFAULT)
    for (const value of ['', '  \n', 42, null, true]) {
      saved = { shareTemplate: value }
      await api.set('shareTemplate', 'changed')
      await drain()
      assert.equal(settings.shareTemplate(), DEFAULT, JSON.stringify(value))
    }
    saved = { shareTemplate: '{title} ({repo} → {target}): {url}' }
    await api.set('shareTemplate', 'changed')
    await drain()
    assert.equal(settings.shareTemplate(), '{title} ({repo} → {target}): {url}')
  })
})

test('the share template setting is declared with its default and help', () => {
  const declared = manifest.contributes.settings.find(setting => setting.key === 'shareTemplate')
  assert.deepEqual(declared, {
    key: 'shareTemplate',
    title: 'Pull request share line',
    description: 'One line per pull request. [text]({url}) is the link. Also {repo}, {project}, {source}, {target}, {author}.',
    type: 'string',
    default: '[Pull Request {id}]({url}): {title}'
  })
})
