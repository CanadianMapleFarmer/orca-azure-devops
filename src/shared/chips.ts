import type { PrChip } from './work'

export type ChipTone = 'success' | 'warning' | 'danger' | 'neutral'

export const MAX_CHIPS = 4

export function chipOf(pr: PrChip): { tone: ChipTone; text: string } {
  if (pr.state === 'merged') return { tone: 'success', text: `${pr.target} ✓` }
  if (pr.state === 'abandoned') return { tone: 'neutral', text: `${pr.target} abandoned` }
  if (pr.state === 'open' && pr.build === 'running') return { tone: 'warning', text: `${pr.target} build …` }
  if (pr.state === 'open' && pr.build === 'failed') return { tone: 'danger', text: `${pr.target} ✗ build` }
  return { tone: 'neutral', text: `${pr.target} ·` }
}
