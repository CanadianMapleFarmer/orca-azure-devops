import type { OrcaWorkerApi } from 'orca/worker'
import type { WikiService } from './service'

export interface WikiHandlerDeps {
  wiki: WikiService
}

export function registerWikiHandlers(orca: OrcaWorkerApi, { wiki }: WikiHandlerDeps): void {
  orca.panels.handle('wiki.list', input => wiki.wikis(input.org))
  orca.panels.handle('wiki.pages', input => wiki.level(input))
  orca.panels.handle('wiki.page', input => wiki.page(input))
  orca.panels.handle('wiki.search', input => wiki.search(input))
}
