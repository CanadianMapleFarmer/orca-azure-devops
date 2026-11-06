import { atom, plugin, read, set, update } from 'orca'
import { messageOf } from '../../../shared/messages'
import type { PrSummary } from '../../../shared/prs'
import type { PrReview, ReviewKey, ReviewResult, VoteChoice } from '../../../shared/reviews'
import { LONG_WAIT } from '../../state'
import { reviewNotice } from '../state'

export type ReviewSection = 'overview' | 'files' | 'comments'
export type OpenReview = ReviewKey & { title: string }
type Load = { status: 'idle' | 'loading' | 'ready' } | { status: 'failed'; message: string }

export const openReview = atom<OpenReview | null>('openReview', null, { persist: 'workspace' })
export const reviewSection = atom<ReviewSection>('reviewSection', 'overview', { persist: 'workspace' })
export const loadedReview = atom<PrReview | null>(null)
export const reviewLoad = atom<Load>({ status: 'idle' })
export const commentDraft = atom('')
const results = atom<Record<string, ReviewResult>>({})
const running = atom<string[]>([])
const armed = atom<{ key: ReviewKey; message: string } | null>(null)

let loads = 0

const keyText = ({ org, projectId, repoId, prId }: ReviewKey): string => JSON.stringify([org, projectId, repoId, prId])

const slotId = (key: ReviewKey, slot: string): string => `${keyText(key)}|${slot}`

function keyOf(open: OpenReview | null): ReviewKey | null {
  return open ? { org: open.org, projectId: open.projectId, repoId: open.repoId, prId: open.prId } : null
}

const isOpen = (key: ReviewKey): boolean => {
  const open = keyOf(read(openReview))
  return open !== null && keyText(open) === keyText(key)
}

export function isRunning(slot: string): boolean {
  const key = keyOf(read(openReview))
  return key !== null && read(running).includes(slotId(key, slot))
}

export function resultOf(slot: string): ReviewResult | null {
  const key = keyOf(read(openReview))
  return key === null ? null : (read(results)[slotId(key, slot)] ?? null)
}

export function armedMessage(): string | null {
  const key = keyOf(read(openReview))
  const instructions = read(armed)
  return key !== null && instructions !== null && keyText(instructions.key) === keyText(key) ? instructions.message : null
}

function setResult(key: ReviewKey, slot: string, result: ReviewResult | null): void {
  const id = slotId(key, slot)
  update(results, all => {
    const next = { ...all }
    if (result === null) delete next[id]
    else next[id] = result
    return next
  })
}

async function exclusively(slot: string, work: (key: ReviewKey) => Promise<void>): Promise<void> {
  const key = keyOf(read(openReview))
  if (key === null || isRunning(slot)) return
  const id = slotId(key, slot)
  update(running, list => [...list, id])
  try {
    await work(key)
  } finally {
    update(running, list => list.filter(item => item !== id))
  }
}

async function answered(request: Promise<ReviewResult>): Promise<ReviewResult> {
  try {
    return await request
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

export async function reloadReview(): Promise<void> {
  const key = keyOf(read(openReview))
  if (key === null) return
  loads += 1
  const mine = loads
  set(reviewLoad, { status: 'loading' })
  try {
    const next = await plugin.request('reviews.open', key, LONG_WAIT)
    if (mine !== loads) return
    set(loadedReview, next)
    set(reviewLoad, { status: 'ready' })
  } catch (error) {
    if (mine === loads) set(reviewLoad, { status: 'failed', message: messageOf(error) })
  }
}

export function showReview(org: string, pr: PrSummary): void {
  const { projectId, repoId, prId, title } = pr
  set(openReview, { org, projectId, repoId, prId, title })
  set(reviewSection, 'overview')
  set(reviewNotice, null)
  set(commentDraft, '')
  set(results, {})
  set(loadedReview, null)
  void reloadReview()
}

export function closeReview(): void {
  loads += 1
  set(openReview, null)
  set(loadedReview, null)
  set(reviewLoad, { status: 'idle' })
  set(commentDraft, '')
  set(results, {})
}

export function syncReview(org: string | null): void {
  void Promise.resolve().then(() => {
    const open = read(openReview)
    if (org !== null && open !== null && open.org !== org) closeReview()
  })
}

export function loadReviewWhenIdle(): void {
  void Promise.resolve().then(() => {
    if (read(openReview) !== null && read(reviewLoad).status === 'idle') void reloadReview()
  })
}

export function vote(choice: VoteChoice): Promise<void> {
  return exclusively('vote', async key => {
    setResult(key, 'vote', null)
    const result = await answered(plugin.request('reviews.vote', { ...key, vote: choice }, LONG_WAIT))
    setResult(key, 'vote', result)
    if (isOpen(key)) await reloadReview()
  })
}

export function checkout(): Promise<void> {
  return exclusively('checkout', async key => {
    setResult(key, 'checkout', null)
    try {
      const result = await plugin.request('reviews.checkout', key, LONG_WAIT)
      if (result.status === 'armed') set(armed, { key, message: result.message })
      else setResult(key, 'checkout', { ok: result.status === 'opened', message: result.message })
    } catch (error) {
      setResult(key, 'checkout', { ok: false, message: messageOf(error) })
    }
  })
}

export function cancelCheckout(): Promise<void> {
  return exclusively('checkout', async key => {
    setResult(key, 'checkout', null)
    try {
      await plugin.request('work.cancelWorkspace', {}, LONG_WAIT)
      set(armed, null)
    } catch (error) {
      setResult(key, 'checkout', { ok: false, message: messageOf(error) })
    }
  })
}

export function comment(input: { text: string }): Promise<void> {
  return exclusively('comment', async key => {
    setResult(key, 'comment', null)
    const result = await answered(plugin.request('reviews.comment', { ...key, text: input.text }, LONG_WAIT))
    setResult(key, 'comment', result)
    if (!result.ok || !isOpen(key)) return
    if (read(commentDraft) === input.text) set(commentDraft, '')
    await reloadReview()
  })
}
