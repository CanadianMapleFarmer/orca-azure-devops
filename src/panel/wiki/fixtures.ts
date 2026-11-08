import { draftKey, type DraftSummary, type WikiLevel, type WikiNode, type WikiPage, type WikiPageRef, type WikiRef } from '../../shared/wiki'

export const NOW = 1_700_000_000_000

export const PROJECT_WIKI: WikiRef = {
  id: 'wiki-project',
  name: 'Fabrikam Web.wiki',
  projectId: 'proj-web',
  projectName: 'Fabrikam Web',
  editable: true,
  mappedPath: '/'
}

export const CODE_WIKI: WikiRef = {
  id: 'wiki-code',
  name: 'api-docs',
  projectId: 'proj-web',
  projectName: 'Fabrikam Web',
  editable: false,
  mappedPath: '/docs'
}

export const WIKIS: WikiRef[] = [CODE_WIKI, PROJECT_WIKI]

export const titleOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function refOf(path: string, wiki: WikiRef = PROJECT_WIKI): WikiPageRef {
  return { org: 'contoso', projectId: wiki.projectId, wikiId: wiki.id, path }
}

export const OPEN_PAGE = { ...refOf('/Runbooks/Deploy'), title: 'Deploy' }

export function nodeOf(path: string, hasChildren = false): WikiNode {
  return { path, title: titleOf(path), hasChildren }
}

export function levelOf(paths: readonly string[], over: Partial<WikiLevel> = {}, folders: readonly string[] = []): WikiLevel {
  return { pages: paths.map(path => nodeOf(path, folders.includes(path))), total: paths.length, ...over }
}

export const ROOT_PAGES = ['/Home', '/Runbooks', '/Release notes']

export const LEVELS: Record<string, WikiLevel> = {
  '/': levelOf(ROOT_PAGES, {}, ['/Runbooks']),
  '/Runbooks': levelOf(['/Runbooks/Deploy', '/Runbooks/Rollback'])
}

export function largeLevels(): Record<string, WikiLevel> {
  const sections = Array.from({ length: 5 }, (_, index) => `/Section ${index + 1}`)
  const chaptersOf = (section: string) => Array.from({ length: 19 }, (_, index) => `${section}/Chapter ${index + 1}`)
  const levels: Record<string, WikiLevel> = { '/': levelOf(sections, {}, sections) }
  for (const section of sections) {
    const chapters = chaptersOf(section)
    levels[section] = levelOf(chapters, {}, chapters)
    for (const chapter of chapters) levels[chapter] = levelOf(Array.from({ length: 20 }, (_, index) => `${chapter}/Page ${index + 1}`))
  }
  return levels
}

export const PAGE_CONTENT = '# Deploy\n\nRun the **release** pipeline, then check the dashboard.'

export function pageOf(path: string, over: Partial<WikiPage> = {}): WikiPage {
  return {
    ...refOf(path),
    title: titleOf(path),
    content: PAGE_CONTENT,
    url: `https://dev.azure.com/contoso/Fabrikam%20Web/_wiki/wikis/Fabrikam%20Web.wiki?pagePath=${encodeURIComponent(path)}`,
    editable: true,
    ...over
  }
}

export function draftOf(path: string, over: Partial<DraftSummary> = {}): DraftSummary {
  const ref = refOf(path)
  return {
    ...ref,
    key: draftKey(ref),
    wikiName: PROJECT_WIKI.name,
    title: titleOf(path),
    file: `wiki/Fabrikam-Web.wiki${path}.md`,
    workspaceName: 'web-app',
    changed: false,
    publishedAt: null,
    ...over
  }
}

export const MINE_DIFF = ['@@ -1,2 +1,3 @@', ' Run the release pipeline.', '+Then check the dashboard.', ' Done.'].join('\n')
export const THEIRS_DIFF = ['@@ -1,2 +1,2 @@', '-Run the release pipeline.', '+Run the release pipeline twice.', ' Done.'].join('\n')
