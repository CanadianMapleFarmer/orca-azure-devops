import type { DiffText } from './diff'

export const MAX_DRAFTS = 50
export const MIN_SEARCH_CHARS = 2

export interface WikiRef {
  id: string
  name: string
  projectId: string
  projectName: string
  editable: boolean
  mappedPath: string | null
}

export interface WikiPageRef {
  org: string
  projectId: string
  wikiId: string
  path: string
}

export interface WikiNode {
  path: string
  title: string
  hasChildren: boolean
}

export interface WikiLevel {
  pages: WikiNode[]
  total: number
}

export interface WikiPage extends WikiPageRef {
  title: string
  content: string
  url: string
  editable: boolean
  notice?: string
}

export interface WikiHit {
  path: string
  title: string
  snippet: string
}

export interface DraftSummary extends WikiPageRef {
  key: string
  wikiName: string
  title: string
  file: string
  workspaceName: string
  changed: boolean
  publishedAt: number | null
}

export type WikiResult =
  | { status: 'published' | 'unchanged' | 'updated' | 'failed'; message: string }
  | { status: 'conflict'; message: string; theirs: DiffText; mine: DiffText }
