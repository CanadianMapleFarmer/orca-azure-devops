import { APPROVAL_TEMPLATE, APPROVAL_VARS, approvalShareItem, parseApprovalItemKey } from '../../src/shared/share/approval-items'
import { mapLimit } from '../ado/limit'
import type { ShareSource } from '../share/service'
import type { PipelinesService } from './service'
import type { PipelineSettings } from './settings'

const READS_AT_A_TIME = 3

export function approvalShareSource(pipelines: Pick<PipelinesService, 'approval'>, settings: Pick<PipelineSettings, 'approvalTemplate'>): ShareSource {
  return {
    kind: 'approval',
    template: () => settings.approvalTemplate(),
    fallback: APPROVAL_TEMPLATE,
    vars: APPROVAL_VARS,
    async items(org, keys) {
      const wanted = keys.flatMap(key => parseApprovalItemKey(key) ?? [])
      const found = await mapLimit(wanted, READS_AT_A_TIME, key => pipelines.approval(org, key))
      return { items: found.flatMap(pair => (pair ? [approvalShareItem(pair.run, pair.approval)] : [])), prs: [] }
    }
  }
}
