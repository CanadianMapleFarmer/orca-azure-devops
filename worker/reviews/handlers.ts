import type { OrcaWorkerApi } from 'orca/worker'
import type { Reviews } from './service'

export interface ReviewHandlerDeps {
  reviews: Reviews
}

export function registerReviewHandlers(orca: OrcaWorkerApi, { reviews }: ReviewHandlerDeps): void {
  orca.panels.handle('reviews.open', input => reviews.open(input))
  orca.panels.handle('reviews.diff', input => reviews.diff(input))
}
