import type { WorkComment, WorkItemDetails, WorkItemSummary } from '../../src/shared/work'
import { htmlToMarkdown } from './html'
import { AdoError, type AdoHttp } from './http'
import { patchWorkItem } from './patch'
import { pullRequestWebUrl } from './pr-links'
import { expectList, expectText, shaped } from './shape'
import { hydrate, parsePrRef, PR_ARTIFACT_PREFIX, textOr, timestamp, workItemUrl, type RawWorkItem } from './workitems'

type Link = WorkItemDetails['links'][number]
type Relations = NonNullable<RawWorkItem['relations']>

interface RawComment {
  id?: unknown
  text?: unknown
  createdBy?: { displayName?: unknown } | null
  createdDate?: unknown
}

interface RawPullRequest {
  repository?: { id?: unknown; project?: { id?: unknown } }
}

interface ParsedPrUrl { project: string; repo: string; prId: number }

const DESCRIPTION_FIELD = 'System.Description'
const ACCEPTANCE_FIELD = 'Microsoft.VSTS.Common.AcceptanceCriteria'
const BODY_CAP = 30_000
const COMMENT_CAP = 4_000
const COMMENT_LIMIT = 50
const TITLE_LIMIT = 50
const COMMENTS_API_VERSION = '7.1-preview.4'
const UNKNOWN_AUTHOR = 'Unknown'
const WORK_ITEM_LINKS = [
  { kind: 'parent', rel: 'System.LinkTypes.Hierarchy-Reverse' },
  { kind: 'child', rel: 'System.LinkTypes.Hierarchy-Forward' },
  { kind: 'related', rel: 'System.LinkTypes.Related' }
] as const
const WORK_ITEM_RELATION_ID = /\/_apis\/wit\/workitems\/(\d+)\/?$/i
const VISUALSTUDIO_HOST = /^([^.]+)\.visualstudio\.com$/
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const NOT_A_PR = "That isn't an Azure DevOps pull request link."
const EMPTY_COMMENT = 'Write a comment first.'
const MALFORMED_COMMENT = 'Azure DevOps returned an unexpected comment response.'
const MALFORMED_PR = 'Azure DevOps returned an unexpected pull request response.'

export async function loadDetails(
  http: AdoHttp,
  org: string,
  projectId: string,
  summary: WorkItemSummary,
  raw: RawWorkItem
): Promise<WorkItemDetails> {
  const relations = raw.relations ?? []
  const linked = linkedWorkItems(relations)
  const titleIds = [...new Set(linked.map(link => link.id))].slice(0, TITLE_LIMIT)
  const [comments, titled] = await Promise.all([
    fetchComments(http, org, projectId, summary),
    hydrate(http, org, projectId, titleIds)
  ])
  const titles = new Map(titled.map(item => [item.id, item]))
  const home = textOr(raw.fields['System.TeamProject'], '') || projectId
  return {
    item: summary,
    descriptionMd: markdown(raw.fields[DESCRIPTION_FIELD], BODY_CAP, summary.url),
    acceptanceMd: markdown(raw.fields[ACCEPTANCE_FIELD], BODY_CAP, summary.url),
    comments,
    links: [
      ...linked.map(({ kind, id }): Link => {
        const found = titles.get(id)
        return {
          kind,
          title: textOr(found?.fields['System.Title'], '') || `#${id}`,
          url: workItemUrl(orgUrl(org), textOr(found?.fields['System.TeamProject'], '') || home, id)
        }
      }),
      ...pullRequestLinks(org, relations)
    ]
  }
}

export async function addComment(http: AdoHttp, org: string, projectId: string, id: number, text: string): Promise<WorkComment> {
  if (text.trim() === '') throw badRequest(EMPTY_COMMENT)
  const { data } = await http.json<RawComment>({
    org,
    project: projectId,
    path: commentsPath(id),
    method: 'POST',
    body: { text: toHtml(text) },
    apiVersion: COMMENTS_API_VERSION
  })
  return shaped(() => toComment(data, workItemUrl(orgUrl(org), projectId, id)), MALFORMED_COMMENT)
}

export async function linkPr(
  http: AdoHttp,
  org: string,
  projectId: string,
  id: number,
  rev: number,
  prUrl: string,
  raw: RawWorkItem
): Promise<number> {
  const artifactUrl = await resolveArtifactUrl(http, org, parsePrUrl(prUrl, org))
  if ((raw.relations ?? []).some(link => link.url.toLowerCase() === artifactUrl.toLowerCase())) return rev
  return patchWorkItem(http, org, projectId, id, [
    { op: 'test', path: '/rev', value: rev },
    { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } } }
  ])
}

async function fetchComments(http: AdoHttp, org: string, projectId: string, summary: WorkItemSummary): Promise<WorkComment[]> {
  const { data } = await http.json<{ comments: RawComment[] }>({
    org,
    project: projectId,
    path: commentsPath(summary.id),
    query: { $top: COMMENT_LIMIT, order: 'desc' },
    apiVersion: COMMENTS_API_VERSION
  })
  return shaped(
    () => expectList<RawComment>(data.comments).slice(0, COMMENT_LIMIT).map(raw => toComment(raw, summary.url)),
    MALFORMED_COMMENT
  )
}

async function resolveArtifactUrl(http: AdoHttp, org: string, pr: ParsedPrUrl): Promise<string> {
  const { data } = await http.json<RawPullRequest>({
    org,
    project: pr.project,
    path: `/_apis/git/repositories/${encodeURIComponent(pr.repo)}/pullrequests/${pr.prId}`
  })
  return shaped(() => {
    const projectId = expectText(data.repository?.project?.id)
    const repoId = expectText(data.repository?.id)
    return `${PR_ARTIFACT_PREFIX}${projectId}%2F${repoId}%2F${pr.prId}`
  }, MALFORMED_PR)
}

function parsePrUrl(prUrl: string, org: string): ParsedPrUrl {
  const parsed = readPrUrl(prUrl.trim(), org)
  if (!parsed) throw badRequest(NOT_A_PR)
  return parsed
}

function readPrUrl(prUrl: string, org: string): ParsedPrUrl | null {
  let url: URL
  try {
    url = new URL(prUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const segments = url.pathname.split('/').slice(1)
  const hostOrg = VISUALSTUDIO_HOST.exec(url.hostname)?.[1]
  if (url.hostname !== 'dev.azure.com' && hostOrg === undefined) return null
  const [urlOrg, project, git, repo, marker, number] = hostOrg === undefined ? segments : [hostOrg, ...segments]
  if (!urlOrg || !project || !repo || git?.toLowerCase() !== '_git' || marker?.toLowerCase() !== 'pullrequest') return null
  const prId = Number(number)
  if (!/^\d+$/.test(number ?? '') || !Number.isSafeInteger(prId) || prId < 1) return null
  try {
    const names = { org: decodeURIComponent(urlOrg), project: decodeURIComponent(project), repo: decodeURIComponent(repo) }
    return names.org.toLowerCase() === org.toLowerCase() ? { project: names.project, repo: names.repo, prId } : null
  } catch {
    return null
  }
}

function linkedWorkItems(relations: Relations): { kind: Link['kind']; id: number }[] {
  return WORK_ITEM_LINKS.flatMap(({ kind, rel }) =>
    relations
      .filter(link => link.rel === rel)
      .flatMap(link => {
        const id = workItemId(link.url)
        return id === null ? [] : [{ kind, id }]
      })
  )
}

function pullRequestLinks(org: string, relations: Relations): Link[] {
  return relations
    .filter(link => link.rel === 'ArtifactLink' && link.url.startsWith(PR_ARTIFACT_PREFIX))
    .map(link => {
      const ref = parsePrRef(link.url)
      return ref
        ? { kind: 'pr', title: `Pull request ${ref.prId}`, url: pullRequestWebUrl(org, ref) }
        : { kind: 'pr', title: 'Pull request', url: link.url }
    })
}

function workItemId(url: string): number | null {
  const id = Number(WORK_ITEM_RELATION_ID.exec(url)?.[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function toComment(raw: RawComment, itemUrl: string): WorkComment {
  if (typeof raw.id !== 'number') throw new TypeError('expected a comment id')
  return {
    id: raw.id,
    author: textOr(raw.createdBy?.displayName, '') || UNKNOWN_AUTHOR,
    createdAt: timestamp(raw.createdDate),
    textMd: markdown(raw.text, COMMENT_CAP, itemUrl)
  }
}

function markdown(html: unknown, maxChars: number, itemUrl: string): string {
  return htmlToMarkdown(textOr(html, ''), { maxChars, itemUrl })
}

function toHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => HTML_ESCAPES[char]).replace(/\r\n|\r|\n/g, '<br>')
}

function commentsPath(id: number): string {
  return `/_apis/wit/workItems/${id}/comments`
}

function orgUrl(org: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}`
}

function badRequest(message: string): AdoError {
  return new AdoError('bad_request', 400, message)
}
