import type { PrKey, PrSummary } from '../prs'
import type { PR_VARS } from './template'
import type { ShareItem } from './types'

const ITEM_KEY = /^pr:([^/]+)\/([^/]+)\/([1-9]\d*)$/

export function prItemKey(key: PrKey): string {
  return `pr:${key.projectId}/${key.repoId}/${key.prId}`
}

export function parsePrItemKey(key: string): PrKey | null {
  const match = ITEM_KEY.exec(key)
  if (!match) return null
  const prId = Number(match[3])
  return Number.isSafeInteger(prId) ? { projectId: match[1], repoId: match[2], prId } : null
}

export function prShareItem(pr: PrSummary): ShareItem {
  const vars: Record<(typeof PR_VARS)[number], string> = {
    id: String(pr.prId),
    title: pr.title,
    url: pr.url,
    repo: pr.repoName,
    project: pr.projectName,
    source: pr.source,
    target: pr.target,
    author: pr.createdBy.name
  }
  return { key: prItemKey(pr), vars }
}
