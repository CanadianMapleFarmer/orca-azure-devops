import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { createAzCliProvider, createAzProfiles } from './auth/azcli'
import { registerWorkHandlers } from './boards/handlers'
import { createBoardsService } from './boards/service'
import { createConnections, type StorePort } from './connections'
import { registerOrgHandlers } from './org-handlers'
import { createScheduler, realClock } from './poll/scheduler'
import { registerPrHandlers } from './prs/handlers'
import { createPrsService } from './prs/service'
import { watchPrSettings } from './prs/settings'
import { createStatusBar, statusText } from './status-bar'
import { findExecutable } from './sys/find-executable'
import { runCommand, stopAllCommands } from './sys/run'
import { registerVisibilityHandler } from './visibility-handler'
import type { HostCall } from './workspace/focused'
import { registerWorkspaceHandlers } from './workspace/handlers'

const SHUTDOWN = { killAfterMs: 1_500, withinMs: 1_900 }

let stopPolling = () => {}

export function deactivate(): Promise<void> {
  stopPolling()
  return stopAllCommands(SHUTDOWN)
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const home = os.homedir()
  const bar = createStatusBar(state => void orca.host.call('statusBar.update', { id: 'status', ...state }).catch(() => {}))
  const prSettings = await watchPrSettings(orca.settings, message => orca.log(message))

  const store: StorePort = {
    get: async <T,>(key: string) => (await orca.storage.get(key)) as T | null,
    set: (key, value) => orca.storage.set(key, value as JsonValue)
  }

  const connections = createConnections({
    store,
    secrets: orca.secrets,
    az: async () => {
      const override = await orca.settings.get('azPath')
      const azPath = findExecutable('az', { override: typeof override === 'string' ? override : undefined, pathEnv: process.env.PATH })
      return azPath ? createAzCliProvider({ azPath, run: runCommand, home, fs }) : null
    },
    azProfiles: createAzProfiles({ home, fs }),
    fetch: globalThis.fetch,
    post: orgs => {
      orca.panels.post('orgs.changed', { orgs })
      bar.setOrgs(orgs)
      boards.onOrgs(orgs)
      prs.onOrgs(orgs)
    },
    connectFailed: failure => orca.panels.post('orgs.connectFailed', failure),
    now: Date.now
  })
  const scheduler = createScheduler(realClock)
  stopPolling = () => scheduler.dispose()
  const boards = createBoardsService({
    http: connections.http,
    orgs: () => connections.list(),
    store,
    scheduler,
    post: snapshot => orca.panels.post('work.changed', snapshot),
    postBoard: change => orca.panels.post('work.boardChanged', change),
    now: Date.now
  })
  const prs = createPrsService({
    http: connections.http,
    orgs: () => connections.list(),
    scheduler,
    autoComplete: () => prSettings.autoComplete(),
    post: snapshot => orca.panels.post('prs.changed', snapshot),
    counts: (org, count) => bar.setCount(org, 'toReview', count),
    now: Date.now
  })
  await connections.resetInterrupted()

  const call: HostCall = (method, params) => orca.host.call(method as never, params as never)
  await registerWorkspaceHandlers(orca, { boards, store, call })
  orca.panels.handle('plugin.ping', () => ({ version: manifest.version }))
  registerOrgHandlers(orca, connections)
  registerWorkHandlers(orca, { boards, http: connections.http, call })
  registerPrHandlers(orca, { prs })
  registerVisibilityHandler(orca, { boards, prs })
  orca.commands.register('status', async () => statusText(await connections.list(), bar.counts()))
  const orgs = await connections.list()
  boards.onOrgs(orgs)
  prs.onOrgs(orgs)
  bar.setOrgs(orgs)
}
