import { messageOf } from '../../src/shared/messages'
import type { AutoCompleteOptions, PrKey, PrSummary, RowResult } from '../../src/shared/prs'
import type { OrgStatus } from '../../src/shared/types'
import { AdoError, type AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { APPROVED_VOTE, castVote, setAutoComplete } from '../ado/pr-actions'
import {
  keptBranch,
  NOT_CONNECTED,
  PR_ALREADY_APPROVED,
  PR_ALREADY_AUTO_COMPLETE,
  PR_APPROVED,
  PR_AUTO_COMPLETE_SET,
  PR_SKIPPED_ABANDONED,
  PR_SKIPPED_COMPLETED,
  PR_SKIPPED_DRAFT
} from '../messages'
import type { PrSource } from './load'
import { sameId } from './release-sets'
import { samePr, type PrsService } from './service'
import type { PrSettings } from './settings'

const AT_A_TIME = 3

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
  orgs: () => Promise<OrgStatus[]>
  settings: PrSettings
}

interface Call {
  org: string
  me: string
  read: PrSummary[]
}

type Read = { pr: PrSummary } | { failed: RowResult }

export function createPrActions({ http, prs, orgs, settings }: PrActionsDeps): PrActions {
  async function meOf(org: string): Promise<string> {
    const status = (await orgs()).find(item => item.org === org)
    if (status?.state !== 'connected' || !status.account) throw new AdoError('unauthorized', 401, NOT_CONNECTED)
    return status.account.adoId
  }

  async function perform(
    { org, prs: keys }: PrActionsInput,
    act: (call: Call) => (pr: PrSummary) => Promise<RowResult>
  ): Promise<{ results: RowResult[] }> {
    const me = await meOf(org)
    const source = await prs.source(org)
    const reads = await mapLimit(keys, AT_A_TIME, key => read(source, key))
    const forEach = act({ org, me, read: reads.flatMap(item => ('pr' in item ? [item.pr] : [])) })
    const results = await mapLimit(reads, AT_A_TIME, async item => ('pr' in item ? attempt(item.pr.prId, () => forEach(item.pr)) : item.failed))
    void prs.refresh(org).catch(() => {})
    return { results }
  }

  async function approve(pr: PrSummary, org: string, me: string): Promise<RowResult> {
    const skip = skipMessage(pr)
    if (skip) return ok(pr, skip)
    const mine = pr.reviewers.find(reviewer => sameId(reviewer.id, me))
    if (mine?.vote === APPROVED_VOTE) return ok(pr, PR_ALREADY_APPROVED)
    await castVote(http, org, pr, me, mine?.isRequired ?? false)
    return ok(pr, PR_APPROVED)
  }

  async function autoComplete(pr: PrSummary, org: string, me: string, options: AutoCompleteOptions, active: PrSummary[]): Promise<RowResult> {
    const skip = skipMessage(pr)
    if (skip) return ok(pr, skip)
    if (pr.autoComplete) return ok(pr, PR_ALREADY_AUTO_COMPLETE)
    const sibling = options.deleteSourceBranch ? sharingBranch(pr, active) : undefined
    await setAutoComplete(http, org, pr, me, sibling ? { ...options, deleteSourceBranch: false } : options)
    return ok(pr, sibling ? keptBranch(sibling.prId) : PR_AUTO_COMPLETE_SET)
  }

  function activeAmong(org: string, read: PrSummary[]): PrSummary[] {
    const cached = prs.activeMine(org).filter(pr => !read.some(fresh => samePr(fresh, pr)))
    return [...cached, ...read.filter(pr => pr.status === 'active')]
  }

  return {
    approveAll: input => perform(input, ({ org, me }) => pr => approve(pr, org, me)),

    autoCompleteAll(input) {
      const options = settings.autoComplete()
      return perform(input, ({ org, me, read }) => {
        const active = activeAmong(org, read)
        return pr => autoComplete(pr, org, me, options, active)
      })
    }
  }
}

async function read(source: PrSource, key: PrKey): Promise<Read> {
  try {
    return { pr: await source.one(key) }
  } catch (error) {
    return { failed: failure(key.prId, error) }
  }
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

function sharingBranch(pr: PrSummary, active: PrSummary[]): PrSummary | undefined {
  return active
    .filter(other => other.repoId === pr.repoId && other.source === pr.source && !samePr(other, pr))
    .sort((a, b) => a.prId - b.prId)[0]
}

function ok(pr: PrSummary, message: string): RowResult {
  return { prId: pr.prId, ok: true, message }
}

function failure(prId: number, error: unknown): RowResult {
  return { prId, ok: false, message: messageOf(error) }
}
