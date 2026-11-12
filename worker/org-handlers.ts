import type { OrcaWorkerApi } from 'orca/worker'
import { listProjects, listTeams, resolveBoards, resolveProjects } from './ado/core'
import type { AdoHttp } from './ado/http'
import type { Connections } from './connections'
import { badRequest, BOARDS_TEAM_GONE, CODE_PROJECTS_GONE, NO_CODE_PROJECTS } from './messages'

export function registerOrgHandlers(orca: OrcaWorkerApi, connections: Connections, http: AdoHttp): void {
  orca.panels.handle('orgs.list', () => connections.list())
  orca.panels.handle('orgs.connect', input => connections.connect(input))
  orca.panels.handle('orgs.cancel', input => connections.cancel(input.org))
  orca.panels.handle('orgs.signOut', input => connections.signOut(input.org))
  orca.panels.handle('orgs.remove', async input => {
    await connections.remove(input.org)
    return { ok: true as const }
  })
  orca.panels.handle('ado.projects', input => listProjects(http, input.org))
  orca.panels.handle('ado.teams', input => listTeams(http, input.org, input.projectId))
  orca.panels.handle('orgs.setBoards', async ({ org, projectId, teamId }) => {
    const target = await resolveBoards(http, org, projectId, teamId)
    if (!target) throw badRequest(BOARDS_TEAM_GONE)
    return connections.update(org, { boards: target })
  })
  orca.panels.handle('orgs.setCodeProjects', async ({ org, projects }) => {
    if (projects === 'all') return connections.update(org, { codeProjects: 'all' })
    if (projects.length === 0) throw badRequest(NO_CODE_PROJECTS)
    const chosen = await resolveProjects(http, org, projects)
    if (!chosen) throw badRequest(CODE_PROJECTS_GONE)
    return connections.update(org, { codeProjects: chosen })
  })
}
