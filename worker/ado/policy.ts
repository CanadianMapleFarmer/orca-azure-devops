import type { PrChecks, PrKey } from '../../src/shared/prs'
import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { expectList, shaped } from './shape'

export interface RawEvaluation {
  status: string
  configuration?: {
    isBlocking?: boolean
    isEnabled?: boolean
    type?: { displayName?: string }
    settings?: { buildDefinitionId?: unknown }
  }
}

type BuildState = PrChecks['build']
type PolicyState = PrChecks['policies']

const BUILD_POLICY_TYPE = 'Build'
const BUILD_SEVERITY: Record<BuildState, number> = { none: 0, succeeded: 1, running: 2, failed: 3 }
const POLICY_SEVERITY: Record<PolicyState, number> = { none: 0, approved: 1, pending: 2, rejected: 3 }

export async function loadEvaluations(http: AdoHttp, org: string, key: PrKey): Promise<RawEvaluation[]> {
  const { data } = await http.json<{ value: RawEvaluation[] }>({
    org,
    project: key.projectId,
    path: '/_apis/policy/evaluations',
    query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${key.projectId}/${key.prId}` },
    apiVersion: '7.1-preview.1'
  })
  return shaped(() => expectList<RawEvaluation>(data.value), MALFORMED.pullRequest)
}

export function buildStateOf(evaluations: RawEvaluation[]): BuildState {
  return worstOf(evaluations.filter(isBuildPolicy).map(evaluation => buildStateFor(evaluation.status)), BUILD_SEVERITY, 'none')
}

export function policyStateOf(evaluations: RawEvaluation[]): PolicyState {
  const counted = evaluations.filter(evaluation => !isBuildPolicy(evaluation) && isBlockingAndEnabled(evaluation))
  return worstOf(counted.map(evaluation => policyStateFor(evaluation.status)), POLICY_SEVERITY, 'none')
}

function worstOf<S extends string>(states: S[], severity: Record<S, number>, none: S): S {
  return states.reduce((worst, state) => (severity[state] > severity[worst] ? state : worst), none)
}

function isBuildPolicy({ configuration }: RawEvaluation): boolean {
  const definitionId = configuration?.settings?.buildDefinitionId
  return configuration?.type?.displayName === BUILD_POLICY_TYPE || (definitionId !== undefined && definitionId !== null)
}

function isBlockingAndEnabled({ configuration }: RawEvaluation): boolean {
  return configuration?.isBlocking !== false && configuration?.isEnabled !== false
}

function buildStateFor(status: string): BuildState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'approved':
      return 'succeeded'
    case 'rejected':
      return 'failed'
    default:
      return 'none'
  }
}

function policyStateFor(status: string): PolicyState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'pending'
    case 'approved':
      return 'approved'
    case 'rejected':
    case 'broken':
      return 'rejected'
    default:
      return 'none'
  }
}
