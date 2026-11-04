import type { AutoCompleteOptions, PrKey, PrReviewer } from '../../src/shared/prs'
import { MALFORMED } from '../messages'
import type { AdoHttp } from './http'
import { toReviewer, type RawReviewer } from './pullrequests'
import { expectList, shaped } from './shape'

const APPROVED_VOTE = 10
const NO_VOTE = 0

export async function castVote(http: AdoHttp, org: string, key: PrKey, me: string, isRequired: boolean): Promise<void> {
  await putReviewer(http, org, key, me, { vote: APPROVED_VOTE, isRequired })
}

export async function setAutoComplete(
  http: AdoHttp,
  org: string,
  key: PrKey,
  me: string,
  options: AutoCompleteOptions
): Promise<void> {
  await http.json({
    org,
    project: key.projectId,
    method: 'PATCH',
    path: `/_apis/git/repositories/${encodeURIComponent(key.repoId)}/pullrequests/${key.prId}`,
    body: {
      autoCompleteSetBy: { id: me },
      completionOptions: {
        mergeStrategy: options.mergeStrategy,
        deleteSourceBranch: options.deleteSourceBranch,
        transitionWorkItems: options.transitionWorkItems,
        bypassPolicy: false
      }
    }
  })
}

export async function listReviewers(http: AdoHttp, org: string, key: PrKey): Promise<PrReviewer[]> {
  const { data } = await http.json<{ value: RawReviewer[] }>({ org, project: key.projectId, path: reviewersPath(key) })
  return shaped(() => expectList<RawReviewer>(data.value).map(toReviewer), MALFORMED.pullRequest)
}

export async function addReviewer(
  http: AdoHttp,
  org: string,
  key: PrKey,
  id: string,
  isRequired: boolean
): Promise<'added' | 'already'> {
  const existing = await listReviewers(http, org, key)
  if (existing.some(reviewer => reviewer.id.toLowerCase() === id.toLowerCase())) return 'already'
  await putReviewer(http, org, key, id, { vote: NO_VOTE, isRequired })
  return 'added'
}

async function putReviewer(
  http: AdoHttp,
  org: string,
  key: PrKey,
  reviewerId: string,
  body: { vote: number; isRequired: boolean }
): Promise<void> {
  await http.json({
    org,
    project: key.projectId,
    method: 'PUT',
    path: `${reviewersPath(key)}/${encodeURIComponent(reviewerId)}`,
    body
  })
}

function reviewersPath(key: PrKey): string {
  return `/_apis/git/repositories/${encodeURIComponent(key.repoId)}/pullRequests/${key.prId}/reviewers`
}
