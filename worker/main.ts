import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import manifest from '../orca-plugin.json' with { type: 'json' }
import type { OrgStatus } from '../src/shared/types'
import { createAzCliProvider, createAzProfiles } from './auth/azcli'
import { listProjects, listTeams } from './ado/core'
import { AdoError } from './ado/http'
import { createConnections } from './connections'
import { statusBarFor, statusText } from './status-bar'
import { findExecutable } from './sys/find-executable'
import { runCommand } from './sys/run'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const home = os.homedir()
  const showStatus = (orgs: OrgStatus[]) => {
    orca.host.call('statusBar.update', { id: 'status', ...statusBarFor(orgs) }).catch(() => {})
  }

  const connections = createConnections({
    store: {
      get: async <T,>(key: string) => (await orca.storage.get(key)) as T | null,
      set: (key, value) => orca.storage.set(key, value as JsonValue)
    },
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
    },
    now: Date.now
  })
  await connections.resetInterrupted()

  orca.panels.handle('plugin.ping', () => ({ version: manifest.version }))
  orca.panels.handle('orgs.list', () => connections.list())
  orca.panels.handle('orgs.connect', input => connections.connect(input))
  orca.panels.handle('orgs.signOut', input => connections.signOut(input.org))
  orca.panels.handle('orgs.remove', async input => {
    await connections.remove(input.org)
    return { ok: true as const }
  })
  orca.panels.handle('ado.projects', input => listProjects(connections.http, input.org))
  orca.panels.handle('ado.teams', input => listTeams(connections.http, input.org, input.projectId))
  orca.panels.handle('orgs.setBoards', async ({ org, projectId, teamId }) => {
    const project = (await listProjects(connections.http, org)).find(item => item.id === projectId)
    const team = project && (await listTeams(connections.http, org, projectId)).find(item => item.id === teamId)
    if (!project || !team) throw new AdoError('bad_request', 400, 'That project or team no longer exists.')
    return connections.update(org, { boards: { projectId, projectName: project.name, teamId, teamName: team.name } })
  })
  orca.panels.handle('orgs.setCodeProjects', async ({ org, projects }) => {
    if (projects === 'all') return connections.update(org, { codeProjects: 'all' })
    const known = new Map((await listProjects(connections.http, org)).map(project => [project.id, project]))
    const chosen = projects.flatMap(id => known.get(id) ?? [])
    if (chosen.length !== projects.length) throw new AdoError('bad_request', 400, 'One or more projects no longer exist.')
    return connections.update(org, { codeProjects: chosen })
  })
  orca.commands.register('status', async () => statusText(await connections.list()))
  showStatus(await connections.list())
}
