import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import manifest from '../orca-plugin.json' with { type: 'json' }
import type { OrgStatus } from '../src/shared/types'
import { createAzCliProvider, createAzProfiles } from './auth/azcli'
import { listProjects, listTeams, resolveBoards, resolveProjects } from './ado/core'
import { AdoError } from './ado/http'
import { createBoardsService } from './boards/service'
import { createConnections, type StorePort } from './connections'
import { createScheduler, realClock } from './poll/scheduler'
import { statusBarFor, statusText } from './status-bar'
import { findExecutable } from './sys/find-executable'
import { runCommand, stopAllCommands } from './sys/run'

const SHUTDOWN = { killAfterMs: 1_500, withinMs: 1_900 }

let stopPolling = () => {}

export function deactivate(): Promise<void> {
  stopPolling()
  return stopAllCommands(SHUTDOWN)
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const home = os.homedir()
  const showStatus = (orgs: OrgStatus[]) => {
    orca.host.call('statusBar.update', { id: 'status', ...statusBarFor(orgs) }).catch(() => {})
  }

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
      showStatus(orgs)
      boards.onOrgs(orgs)
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
  await connections.resetInterrupted()

  orca.panels.handle('plugin.ping', () => ({ version: manifest.version }))
  orca.panels.handle('orgs.list', () => connections.list())
  orca.panels.handle('orgs.connect', input => connections.connect(input))
  orca.panels.handle('orgs.cancel', input => connections.cancel(input.org))
  orca.panels.handle('orgs.signOut', input => connections.signOut(input.org))
  orca.panels.handle('orgs.remove', async input => {
    await connections.remove(input.org)
    return { ok: true as const }
  })
  orca.panels.handle('ado.projects', input => listProjects(connections.http, input.org))
  orca.panels.handle('ado.teams', input => listTeams(connections.http, input.org, input.projectId))
  orca.panels.handle('orgs.setBoards', async ({ org, projectId, teamId }) => {
    const target = await resolveBoards(connections.http, org, projectId, teamId)
    if (!target) throw new AdoError('bad_request', 400, 'That project or team no longer exists.')
    return connections.update(org, { boards: target })
  })
  orca.panels.handle('orgs.setCodeProjects', async ({ org, projects }) => {
    if (projects === 'all') return connections.update(org, { codeProjects: 'all' })
    if (projects.length === 0) throw new AdoError('bad_request', 400, 'Pick at least one project, or choose all projects.')
    const chosen = await resolveProjects(connections.http, org, projects)
    if (!chosen) throw new AdoError('bad_request', 400, 'One or more projects no longer exist.')
    return connections.update(org, { codeProjects: chosen })
  })
  orca.panels.handle('work.snapshot', input => boards.snapshot(input.org))
  orca.panels.handle('work.refresh', input => boards.refresh(input.org))
  orca.panels.handle('work.details', input => boards.details(input.org, input.id))
  orca.panels.handle('work.move', input => boards.move(input))
  orca.panels.handle('work.comment', input => boards.comment(input.org, input.id, input.text))
  orca.panels.handle('work.linkPr', input => boards.linkPr(input))
  orca.panels.handle('work.board', input => boards.board(input))
  orca.panels.handle('work.dismissNudge', input => boards.dismissNudge(input))
  orca.panels.handle('ui.visibility', input => boards.visibility(input))
  orca.commands.register('status', async () => statusText(await connections.list()))
  const orgs = await connections.list()
  boards.onOrgs(orgs)
  showStatus(orgs)
}
