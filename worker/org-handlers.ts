import type { OrcaWorkerApi } from 'orca/worker'
import { listProjects, listTeams, resolveBoards, resolveProjects } from './ado/core'
import { AdoError } from './ado/http'
import type { Connections } from './connections'

export function registerOrgHandlers(orca: OrcaWorkerApi, connections: Connections): void {
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
}
