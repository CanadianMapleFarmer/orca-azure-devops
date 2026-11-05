import type { AdoHttp } from './http'

export async function cancelBuild(http: AdoHttp, org: string, projectId: string, buildId: number): Promise<void> {
  await http.json({
    org,
    project: projectId,
    method: 'PATCH',
    path: buildPath(buildId),
    body: { status: 'cancelling' }
  })
}

export async function retryStage(http: AdoHttp, org: string, projectId: string, buildId: number, stageRef: string): Promise<void> {
  await http.json({
    org,
    project: projectId,
    method: 'PATCH',
    path: `${buildPath(buildId)}/stages/${encodeURIComponent(stageRef)}`,
    body: { state: 'retry', forceRetryAllJobs: false }
  })
}

function buildPath(buildId: number): string {
  return `/_apis/build/builds/${buildId}`
}
