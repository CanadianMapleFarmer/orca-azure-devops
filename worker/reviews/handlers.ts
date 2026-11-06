import type { OrcaWorkerApi } from 'orca/worker'
import type { ReviewActions } from './actions'
import type { Reviews } from './service'

export interface ReviewHandlerDeps {
  reviews: Reviews
  actions: ReviewActions
}

export function registerReviewHandlers(orca: OrcaWorkerApi, { reviews, actions }: ReviewHandlerDeps): void {
  orca.panels.handle('reviews.open', input => reviews.open(input))
  orca.panels.handle('reviews.diff', input => reviews.diff(input))
  orca.panels.handle('reviews.vote', input => actions.vote(input))
  orca.panels.handle('reviews.reply', input => actions.reply(input))
  orca.panels.handle('reviews.setStatus', input => actions.setStatus(input))
  orca.panels.handle('reviews.comment', input => actions.comment(input))
}
