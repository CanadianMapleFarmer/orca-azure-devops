import type { ChipTone } from './chips'
import type { PrChecks } from './prs'

export interface CheckChip {
  tone: ChipTone
  text: string
}

export function failedCheck(checks: PrChecks | null): CheckChip | null {
  if (checks?.build === 'failed') return { tone: 'danger', text: '✗ build' }
  if (checks?.policies === 'rejected') return { tone: 'danger', text: '✗ policies' }
  return null
}

export function openCheck(checks: PrChecks | null): CheckChip | null {
  if (checks?.build === 'running') return { tone: 'warning', text: 'building' }
  if (checks?.policies === 'pending') return { tone: 'neutral', text: '· policies' }
  if (checks?.build === 'succeeded' || checks?.policies === 'approved') return { tone: 'success', text: '✓ build' }
  return null
}

export function checkChip(checks: PrChecks | null): CheckChip | null {
  return failedCheck(checks) ?? openCheck(checks)
}
