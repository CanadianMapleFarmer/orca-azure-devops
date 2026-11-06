import type { OrcaWorkerApi } from 'orca/worker'
import type { Drafts } from './drafts'
import type { WikiService } from './service'

export interface WikiHandlerDeps {
  wiki: WikiService
  drafts: Drafts
}

export function registerWikiHandlers(orca: OrcaWorkerApi, { wiki, drafts }: WikiHandlerDeps): void {
  orca.panels.handle('wiki.list', input => wiki.wikis(input.org))
  orca.panels.handle('wiki.pages', input => wiki.level(input))
  orca.panels.handle('wiki.page', input => wiki.page(input))
  orca.panels.handle('wiki.search', input => wiki.search(input))
  orca.panels.handle('wiki.edit', input => drafts.edit(input))
  orca.panels.handle('wiki.drafts', input => drafts.list(input.org))
  orca.panels.handle('wiki.discard', input => drafts.discard(input.key))
}
