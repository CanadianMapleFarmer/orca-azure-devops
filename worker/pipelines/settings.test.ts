import { assert, hostError, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import manifest from '../../orca-plugin.json' with { type: 'json' }
import { APPROVAL_TEMPLATE } from '../../src/shared/share/approval-items'
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

test('approvalTemplate falls back to the default when empty or not a string', async () => {
  let saved: Record<string, unknown> = {}
  const host = mockHost({ results: { 'settings.get': () => ({ settings: saved }) } })
  const seen: { settings?: PipelineSettings; api?: OrcaWorkerApi['settings'] } = {}
  const module = {
    default: async (orca: OrcaWorkerApi) => {
      seen.api = orca.settings
      seen.settings = await watchPipelineSettings(orca.settings, message => orca.log(message))
    }
  }
  await withWorker(module, { host }, async () => {
    const settings = seen.settings as PipelineSettings
    const api = seen.api as OrcaWorkerApi['settings']
    const change = async (next: Record<string, unknown>) => {
      saved = next
      await api.set('approvalShareTemplate', 'changed')
      await drain()
    }
    assert.equal(settings.approvalTemplate(), APPROVAL_TEMPLATE)
    assert.equal(APPROVAL_TEMPLATE, 'Approval needed for {environment}: [{pipeline} {run}]({url}) on {branch}')

    await change({ approvalShareTemplate: 'Needs you: [{pipeline} {run}]({url})' })
    assert.equal(settings.approvalTemplate(), 'Needs you: [{pipeline} {run}]({url})')

    for (const value of ['', '  \n ', 42, true, null, ['x']]) {
      await change({ approvalShareTemplate: value })
      assert.equal(settings.approvalTemplate(), APPROVAL_TEMPLATE, JSON.stringify(value))
    }
  })
})

test('the approval share line setting is declared', () => {
  const declared = manifest.contributes.settings.find(setting => setting.key === 'approvalShareTemplate')
  assert.deepEqual(declared, {
    key: 'approvalShareTemplate',
    title: 'Approval share line',
    description: 'One line per approval. [text]({url}) is the link. Also {stage}, {requestedBy}, {project}.',
    type: 'string',
    default: APPROVAL_TEMPLATE
  })
})
