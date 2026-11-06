import type { CheckoutResult, ReviewKey } from '../../src/shared/reviews'
import { mapLimit } from '../ado/limit'
import { branchName } from '../ado/pr-links'
import { toPrSummary, type RawPullRequest } from '../ado/pullrequests'
import {
  ARM_ANY_PROJECT,
  armedCheckout,
  CHECKOUT_FORK,
  CHECKOUT_NEEDS_GIT_PROJECT,
  GIT_REMOTES_FAILED,
  noRepoWorkspace,
  openedCheckout,
  REVIEW_PR_CLOSED
} from '../messages'
import type { Arm } from '../workspace/arm'
import { focusedWorkspace, listWorkspaces, type HostCall, type WorkspaceEntry } from '../workspace/focused'
import { sameRepo, type AdoRemote } from '../workspace/remotes'

export interface CheckoutDeps {
  call: HostCall
  remotes: (workspacePath: string) => Promise<AdoRemote[]>
  arm: Pick<Arm, 'arm'>
  pullRequest: (key: ReviewKey) => Promise<RawPullRequest>
  log: (message: string) => void
}

interface Candidate {
  workspace: WorkspaceEntry
  remote: AdoRemote
}

const REMOTE_LOOKUPS = 4

export async function checkoutPr(deps: CheckoutDeps, key: ReviewKey): Promise<CheckoutResult> {
  const raw = await deps.pullRequest(key)
  const pr = toPrSummary(raw, key.org)
  if (pr.status !== 'active') return refused(REVIEW_PR_CLOSED)
  if (raw.forkSource) return refused(CHECKOUT_FORK)

  const listed = await listWorkspaces(deps.call)
  const focused = await focusedWorkspace(deps.call, listed)
  const target = { org: key.org, project: pr.projectName, repo: pr.repoName }
  const local = listed.filter(entry => entry.hostId === null)
  const found = await mapLimit(local, REMOTE_LOOKUPS, async workspace => ({
    workspace,
    remote: (await remotesOrNone(deps, workspace.path)).find(remote => sameRepo(remote, target))
  }))
  const rank = (workspace: WorkspaceEntry) =>
    (onBranch(workspace, pr.source) ? 0 : 4) + (workspace.kind === 'worktree' ? 0 : 2) + (workspace.id === focused?.id ? 0 : 1)
  const [first] = found.filter((entry): entry is Candidate => entry.remote !== undefined).sort((a, b) => rank(a.workspace) - rank(b.workspace))
  if (!first) return refused(noRepoWorkspace(pr.repoName))

  const { workspace, remote } = first
  if (onBranch(workspace, pr.source)) {
    await deps.call('workspace.open', { workspaceId: workspace.id })
    return { status: 'opened', message: openedCheckout(workspace.name, pr.source) }
  }
  if (workspace.kind !== 'worktree') return refused(CHECKOUT_NEEDS_GIT_PROJECT)
  if (workspace.id !== focused?.id) await deps.call('workspace.open', { workspaceId: workspace.id })
  const base = `${remote.remote}/${pr.source}`
  const armedUntil = deps.arm.arm({ org: key.org, branch: pr.source, base, prId: pr.prId })
  const message = `${armedCheckout({ repo: pr.repoName, branch: pr.source, base, prId: pr.prId, target: pr.target })} ${ARM_ANY_PROJECT}`
  return { status: 'armed', message, armedUntil }
}

function onBranch(workspace: WorkspaceEntry, branch: string): boolean {
  return branchName(workspace.branch ?? '') === branch
}

function remotesOrNone(deps: CheckoutDeps, workspacePath: string): Promise<AdoRemote[]> {
  return deps.remotes(workspacePath).catch(() => {
    deps.log(GIT_REMOTES_FAILED)
    return []
  })
}

function refused(message: string): CheckoutResult {
  return { status: 'refused', message }
}
