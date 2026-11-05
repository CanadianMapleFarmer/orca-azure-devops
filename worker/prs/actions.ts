import { messageOf } from '../../src/shared/messages'
import type { AutoCompleteOptions, PrKey, PrSummary, RowResult } from '../../src/shared/prs'
import type { AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { APPROVED_VOTE, castVote, setAutoComplete } from '../ado/pr-actions'
import { deletesSourceBranch, getPullRequest, listPullRequests, toPrSummary, type RawPullRequest } from '../ado/pullrequests'
import {
  alreadySetWillDelete,
  keptBranch,
  PR_ALREADY_APPROVED,
  PR_ALREADY_AUTO_COMPLETE,
  PR_APPROVED,
  PR_AUTO_COMPLETE_SET,
  PR_BRANCH_KEPT_UNCHECKED,
  PR_SKIPPED_ABANDONED,
  PR_SKIPPED_COMPLETED,
  PR_SKIPPED_DRAFT,
  siblingWillDelete
} from '../messages'
import { sameId } from './release-sets'
import { samePr, type PrsService } from './service'
import type { PrSettings } from './settings'

const AT_A_TIME = 3
const ON_BRANCH_TOP = 100

export interface PrActionsInput {
  org: string
  prs: PrKey[]
}

export interface PrActions {
  approveAll(input: PrActionsInput): Promise<{ results: RowResult[] }>
  autoCompleteAll(input: PrActionsInput): Promise<{ results: RowResult[] }>
}

export interface PrActionsDeps {
  http: AdoHttp
  prs: PrsService
  settings: PrSettings
}

interface Seen {
  pr: PrSummary
  deletesBranch: boolean
}

interface Call {
  org: string
  me: string
  seen: Seen[]
}

type Read = { seen: Seen } | { failed: RowResult }
type OnBranch = Map<string, Seen[] | null>

export function createPrActions({ http, prs, settings }: PrActionsDeps): PrActions {
  async function perform(
    { org, prs: keys }: PrActionsInput,
    prepare: (call: Call) => Promise<(item: Seen) => Promise<RowResult>>
  ): Promise<{ results: RowResult[] }> {
    const me = await prs.me(org)
    const reads = await mapLimit(distinct(keys), AT_A_TIME, key => read(org, key))
    const act = await prepare({ org, me, seen: reads.flatMap(item => ('seen' in item ? [item.seen] : [])) })
    const results = await mapLimit(reads, AT_A_TIME, async item => ('seen' in item ? attempt(item.seen.pr.prId, () => act(item.seen)) : item.failed))
    void prs.reloadFresh(org).catch(() => {})
    return { results }
  }

  async function read(org: string, key: PrKey): Promise<Read> {
    try {
      return { seen: seenOf(await getPullRequest(http, org, key), org) }
    } catch (error) {
      return { failed: failure(key.prId, error) }
    }
  }

  async function activeOnBranch(org: string, pr: PrSummary): Promise<Seen[] | null> {
    try {
      const criteria = { repositoryId: pr.repoId, sourceBranch: pr.source, status: 'active', top: ON_BRANCH_TOP } as const
      return (await listPullRequests(http, org, pr.projectId, criteria)).map(raw => seenOf(raw, org))
    } catch {
      return null
    }
  }

  async function lookUpBranches(org: string, options: AutoCompleteOptions, seen: Seen[]): Promise<OnBranch> {
    const wanted = distinctBy(seen.filter(item => needsBranchCheck(item, options)), item => branchKey(item.pr))
    const found = await mapLimit(wanted, AT_A_TIME, async item => [branchKey(item.pr), await activeOnBranch(org, item.pr)] as const)
    return new Map(found)
  }

  async function approve(item: Seen, org: string, me: string): Promise<RowResult> {
    const { pr } = item
    const skip = skipMessage(pr)
    if (skip) return ok(pr, skip)
    const mine = pr.reviewers.find(reviewer => sameId(reviewer.id, me))
    if (mine?.vote === APPROVED_VOTE) return ok(pr, PR_ALREADY_APPROVED)
    await castVote(http, org, pr, me, mine?.isRequired ?? false)
    return ok(pr, PR_APPROVED)
  }

  async function autoComplete(item: Seen, call: Call, options: AutoCompleteOptions, branches: OnBranch): Promise<RowResult> {
    const { pr } = item
    const skip = skipMessage(pr)
    if (skip) return ok(pr, skip)
    const found = branches.get(branchKey(pr))
    const others = othersOn(item, [...call.seen, ...(found ?? [])])
    if (pr.autoComplete) return item.deletesBranch && others[0] ? warning(pr, alreadySetWillDelete(others[0].pr.prId)) : ok(pr, PR_ALREADY_AUTO_COMPLETE)
    const checked = found !== undefined && found !== null
    const keep = options.deleteSourceBranch && (others.length > 0 || !checked)
    await setAutoComplete(http, call.org, pr, call.me, keep ? { ...options, deleteSourceBranch: false } : options)
    const deleting = options.deleteSourceBranch ? others.find(other => other.deletesBranch) : undefined
    return deleting ? warning(pr, siblingWillDelete(deleting.pr.prId)) : ok(pr, setMessage(options, others, checked))
  }

  return {
    approveAll: input => perform(input, async ({ org, me }) => item => approve(item, org, me)),

    autoCompleteAll(input) {
      const options = settings.autoComplete()
      return perform(input, async call => {
        const branches = await lookUpBranches(call.org, options, call.seen)
        return item => autoComplete(item, call, options, branches)
      })
    }
  }
}

function setMessage(options: AutoCompleteOptions, others: Seen[], checked: boolean): string {
  if (!options.deleteSourceBranch) return PR_AUTO_COMPLETE_SET
  if (others[0]) return keptBranch(others[0].pr.prId)
  return checked ? PR_AUTO_COMPLETE_SET : PR_BRANCH_KEPT_UNCHECKED
}

function needsBranchCheck(item: Seen, options: AutoCompleteOptions): boolean {
  if (skipMessage(item.pr)) return false
  return item.pr.autoComplete ? item.deletesBranch : options.deleteSourceBranch
}

function othersOn(item: Seen, known: Seen[]): Seen[] {
  const active = new Map<number, Seen>()
  for (const other of known) {
    if (other.pr.status !== 'active' || other.pr.repoId !== item.pr.repoId || other.pr.source !== item.pr.source) continue
    const known = active.get(other.pr.prId)
    active.set(other.pr.prId, known?.deletesBranch ? { ...other, deletesBranch: true } : other)
  }
  return [...active.values()].filter(other => !samePr(other.pr, item.pr)).sort((a, b) => a.pr.prId - b.pr.prId)
}

function seenOf(raw: RawPullRequest, org: string): Seen {
  return { pr: toPrSummary(raw, org), deletesBranch: deletesSourceBranch(raw) }
}

function branchKey(pr: PrSummary): string {
  return `${pr.projectId}:${pr.repoId}:${pr.source}`
}

function distinct(keys: PrKey[]): PrKey[] {
  return keys.filter((key, index) => keys.findIndex(other => samePr(other, key)) === index)
}

function distinctBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  return items.filter((item, index) => items.findIndex(other => keyOf(other) === keyOf(item)) === index)
}

async function attempt(prId: number, work: () => Promise<RowResult>): Promise<RowResult> {
  try {
    return await work()
  } catch (error) {
    return failure(prId, error)
  }
}

function skipMessage(pr: PrSummary): string | null {
  if (pr.status === 'completed') return PR_SKIPPED_COMPLETED
  if (pr.status === 'abandoned') return PR_SKIPPED_ABANDONED
  return pr.isDraft ? PR_SKIPPED_DRAFT : null
}

function ok(pr: PrSummary, message: string): RowResult {
  return { prId: pr.prId, ok: true, message }
}

function warning(pr: PrSummary, message: string): RowResult {
  return { ...ok(pr, message), warn: true }
}

function failure(prId: number, error: unknown): RowResult {
  return { prId, ok: false, message: messageOf(error) }
}
