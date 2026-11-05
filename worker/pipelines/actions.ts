import { messageOf } from '../../src/shared/messages'
import type { RunActionResult } from '../../src/shared/pipelines'
import { cancellableStatus, finishedStatus } from '../../src/shared/runs'
import { decideApproval, getApprovals, toApprovalSummary, type RawApproval } from '../ado/approvals'
import { cancelBuild, retryStage } from '../ado/build-actions'
import { getBuild } from '../ado/builds'
import type { AdoHttp } from '../ado/http'
import { getTimeline, runStages, type RawTimeline } from '../ado/timeline'
import {
  APPROVAL_NOT_PENDING,
  APPROVED,
  approvedNeedsMore,
  badRequest,
  COMMENT_TOO_LONG,
  MALFORMED,
  REJECTED,
  rerunning,
  RUN_ALREADY_CANCELLING,
  RUN_ALREADY_FINISHED,
  RUN_CANCELLING,
  STAGE_GONE,
  STAGE_NOT_RETRYABLE
} from '../messages'

export const MAX_COMMENT = 1000

type Decision = 'approved' | 'rejected'

export interface RunActions {
  decide(input: { org: string; projectId: string; approvalId: string; decision: Decision; comment: string }): Promise<RunActionResult>
  retryStage(input: { org: string; projectId: string; buildId: number; stageId: string }): Promise<RunActionResult>
  cancel(input: { org: string; projectId: string; buildId: number }): Promise<RunActionResult>
}

export interface RunActionsDeps {
  http: AdoHttp
  me: (org: string) => Promise<string>
  after: (org: string, buildId: number) => void
}

const PENDING = 'pending'
const APPROVED_STEP = 'approved'
const DECIDED: Record<Decision, string> = { approved: APPROVED, rejected: REJECTED }
const NO_LOG_LINES: ReadonlyMap<number, number> = new Map()
const NO_TIMELINE: RawTimeline = { changeId: 0, records: [] }

export function createRunActions({ http, me, after }: RunActionsDeps): RunActions {
  async function attempt(org: string, work: (reached: (buildId: number) => void) => Promise<RunActionResult>): Promise<RunActionResult> {
    const seen: { buildId?: number } = {}
    try {
      return await work(buildId => {
        seen.buildId = buildId
      })
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    } finally {
      if (seen.buildId !== undefined) after(org, seen.buildId)
    }
  }

  return {
    async decide({ org, projectId, approvalId, decision, comment }) {
      const text = comment.trim()
      if (text.length > MAX_COMMENT) throw badRequest(COMMENT_TOO_LONG)
      const account = await me(org)
      return attempt(org, async reached => {
        const wanted = approvalId.toLowerCase()
        const raw = (await getApprovals(http, org, projectId, [approvalId])).find(item => typeof item.id === 'string' && item.id.toLowerCase() === wanted)
        if (!raw) return refused(APPROVAL_NOT_PENDING)
        const approval = toApprovalSummary(raw, { projectId, me: account, stage: null, environment: null })
        reached(approval.buildId)
        if (raw.status !== PENDING) return refused(APPROVAL_NOT_PENDING)
        const answer = await decideApproval(http, org, projectId, raw.id, decision, text)
        return outcomeOf(decision, approval.minRequired, answer)
      })
    },

    async retryStage({ org, projectId, buildId, stageId }) {
      await me(org)
      return attempt(org, async reached => {
        reached(buildId)
        const [build, timeline] = await Promise.all([getBuild(http, org, projectId, buildId), getTimeline(http, org, projectId, buildId)])
        const stage = runStages(timeline ?? NO_TIMELINE, NO_LOG_LINES, !finishedStatus(build.status)).find(item => item.id === stageId)
        if (!stage) return refused(STAGE_GONE)
        if (!stage.canRetry || stage.identifier === null) return refused(STAGE_NOT_RETRYABLE)
        await retryStage(http, org, projectId, buildId, stage.identifier)
        return { ok: true, message: rerunning(stage.name) }
      })
    },

    async cancel({ org, projectId, buildId }) {
      await me(org)
      return attempt(org, async reached => {
        reached(buildId)
        const { status } = await getBuild(http, org, projectId, buildId)
        if (finishedStatus(status)) return refused(RUN_ALREADY_FINISHED)
        if (!cancellableStatus(status)) return refused(RUN_ALREADY_CANCELLING)
        await cancelBuild(http, org, projectId, buildId)
        return { ok: true, message: RUN_CANCELLING }
      })
    }
  }
}

function outcomeOf(decision: Decision, minRequired: number, answer: RawApproval): RunActionResult {
  if (answer.status === decision) return { ok: true, message: DECIDED[decision] }
  if (answer.status !== PENDING) return refused(APPROVAL_NOT_PENDING)
  if (decision === 'rejected') return refused(MALFORMED.approval)
  const missing = minRequired - approvedSteps(answer)
  return { ok: true, warn: true, message: missing > 0 ? approvedNeedsMore(missing) : APPROVED }
}

function approvedSteps({ steps }: RawApproval): number {
  return Array.isArray(steps) ? steps.filter(step => step.status === APPROVED_STEP).length : 0
}

function refused(message: string): RunActionResult {
  return { ok: false, message }
}
