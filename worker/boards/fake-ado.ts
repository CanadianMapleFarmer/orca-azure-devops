import { readFileSync } from 'node:fs'
import type { RawWorkItem } from '../ado/workitems'

export const ORG = 'contoso'
export const ORG_URL = 'https://dev.azure.com/contoso'
export const PROJECT = '4f1a2c3d-1111-4a2b-9c3d-0e1f2a3b4c5d'
export const TEAM = '6a7b8c9d-2222-4b3c-8d4e-1f2a3b4c5d6e'
export const STORIES = 'e2c3d4e5-5555-4e6f-9a7b-4c5d6e7f8091'
export const FEATURES = 'd1b2c3d4-4444-4d5e-8f6a-3b4c5d6e7f80'
export const REPO = '7c8d9e0f-3333-4c4d-9e5f-2a3b4c5d6e7f'
export const WEF = 'WEF_5C1A2B3D4E5F4A6B8C7D9E0F1A2B3C4D_Kanban'
export const FEATURES_WEF = 'WEF_8D2E3F4A5B6C4D7E9F0A1B2C3D4E5F60_Kanban'
export const BOARDS = { projectId: PROJECT, projectName: 'Fabrikam Web', teamId: TEAM, teamName: 'Platform' }

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../ado/fixtures/${name}.json`, import.meta.url), 'utf8')) as T
}

export interface AdoCall {
  method: string
  host: string
  path: string
  headers: Headers
  query: URLSearchParams
  body: any
  signal?: AbortSignal
}

type Override = { match: (call: AdoCall) => boolean; respond: (call: AdoCall) => Response | Promise<Response> }

const TYPE_STATES: Record<string, string> = { 'User Story': 'states-user-story', Bug: 'states-bug', Task: 'states-task', Feature: 'states-user-story' }
const PULL_REQUESTS: Record<number, string> = { 321: 'pull-request-completed', 322: 'pull-request-active' }

function extraItems(): RawWorkItem[] {
  const item = (id: number, fields: Record<string, unknown>): RawWorkItem => ({
    id,
    rev: 1,
    url: `${ORG_URL}/${PROJECT}/_apis/wit/workItems/${id}`,
    fields: { 'System.TeamProject': 'Fabrikam Web', ...fields }
  })
  return [
    item(1100, {
      'System.WorkItemType': 'Feature',
      'System.Title': 'Vehicle search',
      'System.State': 'Active',
      'System.ChangedDate': '2026-10-28T10:00:00Z',
      [`${FEATURES_WEF}.Column`]: 'Active'
    }),
    item(1207, {
      'System.WorkItemType': 'Task',
      'System.Title': 'Write the filter tests',
      'System.State': 'Active',
      'System.Parent': 1204,
      'System.ChangedDate': '2026-11-02T10:00:00Z'
    }),
    item(1208, {
      'System.WorkItemType': 'Task',
      'System.Title': 'Spike the old export',
      'System.State': 'Closed',
      'System.ChangedDate': '2026-10-30T10:00:00Z'
    })
  ]
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function fakeAdo() {
  const items = new Map<number, RawWorkItem>()
  for (const raw of [...fixture<{ value: RawWorkItem[] }>('workitems-batch').value, ...extraItems()]) items.set(raw.id, raw)
  const calls: AdoCall[] = []
  const overrides: Override[] = []
  const state = { wiql: [1204, 1207, 1205, 1208], staleStatus: 412 }

  function route(call: AdoCall): Response {
    const { method, path } = call
    const work = `/${ORG}/${PROJECT}/${TEAM}/_apis/work`
    if (method === 'GET' && path === `${work}/backlogconfiguration`) return json(200, fixture('backlog-configuration'))
    if (method === 'GET' && path === `${work}/boards`) return json(200, fixture('boards'))
    if (method === 'GET' && path === `${work}/boards/${STORIES}`) return json(200, fixture('board-stories'))
    if (method === 'GET' && path === `${work}/boards/${FEATURES}`) return json(200, fixture('board-features'))
    if (method === 'GET' && path === `${work}/teamsettings/teamfieldvalues`) return json(200, fixture('team-field-values'))
    const states = new RegExp(`^/${ORG}/${PROJECT}/_apis/wit/workitemtypes/([^/]+)/states$`).exec(path)
    if (method === 'GET' && states && TYPE_STATES[states[1]]) return json(200, fixture(TYPE_STATES[states[1]]))
    if (method === 'POST' && path === `/${ORG}/${PROJECT}/${TEAM}/_apis/wit/wiql`) {
      return json(200, { workItems: state.wiql.map(id => ({ id, url: `${ORG_URL}/_apis/wit/workItems/${id}` })) })
    }
    if (method === 'POST' && path === `/${ORG}/${PROJECT}/_apis/wit/workitemsbatch`) {
      const ids = call.body.ids as number[]
      return json(200, { count: ids.length, value: ids.map(id => structuredClone(items.get(id)) ?? null) })
    }
    const pr = new RegExp(`^/${ORG}/${PROJECT}/_apis/git/pullrequests/(\\d+)$`).exec(path)
    if (method === 'GET' && pr && PULL_REQUESTS[Number(pr[1])]) return json(200, fixture(PULL_REQUESTS[Number(pr[1])]))
    if (method === 'GET' && path === `/${ORG}/${PROJECT}/_apis/policy/evaluations`) return json(200, fixture('policy-evaluations'))
    const patch = new RegExp(`^/${ORG}/${PROJECT}/_apis/wit/workitems/(\\d+)$`).exec(path)
    if (method === 'PATCH' && patch) return applyPatch(Number(patch[1]), call.body)
    const comments = new RegExp(`^/${ORG}/${PROJECT}/_apis/wit/workItems/(\\d+)/comments$`).exec(path)
    if (comments && method === 'GET') return json(200, { totalCount: 0, comments: [] })
    if (comments && method === 'POST') {
      return json(200, { id: 77, text: call.body.text, createdBy: { displayName: 'Alex Contoso' }, createdDate: '2026-11-04T09:00:00Z' })
    }
    const linked = new RegExp(`^/${ORG}/([^/]+)/_apis/git/repositories/([^/]+)/pullrequests/(\\d+)$`).exec(path)
    if (method === 'GET' && linked) return json(200, { pullRequestId: Number(linked[3]), repository: { id: REPO, project: { id: PROJECT } } })
    return json(404, { message: `no route for ${method} ${path}` })
  }

  function applyPatch(id: number, ops: { op: string; path: string; value: any }[]): Response {
    const raw = items.get(id)
    if (!raw) return json(404, { message: 'TF401232: not found' })
    const guard = ops.find(op => op.op === 'test' && op.path === '/rev')
    if (guard && guard.value !== raw.rev) return json(state.staleStatus, { message: 'TF26071: This work item has been changed by someone else since you opened it.' })
    for (const op of ops) {
      if (op.op === 'replace' && op.path.startsWith('/fields/')) raw.fields[op.path.slice('/fields/'.length)] = op.value
      if (op.op === 'add' && op.path === '/relations/-') raw.relations = [...(raw.relations ?? []), op.value]
    }
    raw.rev += 1
    return json(200, raw)
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: AdoCall = {
      method: init?.method ?? 'GET',
      host: url.host,
      path: decodeURIComponent(url.pathname),
      headers: new Headers(init?.headers),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined
    }
    calls.push(call)
    return dispatch(call)
  }) as typeof globalThis.fetch

  function dispatch(call: AdoCall, after?: Override): Response | Promise<Response> {
    const override = overrides.slice(after ? overrides.indexOf(after) + 1 : 0).find(entry => entry.match(call))
    return override ? override.respond(call) : route(call)
  }

  return {
    fetch,
    calls,
    items,
    state,
    on(match: (call: AdoCall) => boolean, respond: (call: AdoCall) => Response | Promise<Response>): void {
      overrides.unshift({ match, respond })
    },
    hold(match: (call: AdoCall) => boolean): { release(): void } {
      let release = () => {}
      const gate = new Promise<void>(resolve => (release = resolve))
      let held = false
      const holding: Override = {
        match: call => !held && match(call),
        respond: async call => {
          held = true
          const response = await dispatch(call, holding)
          await gate
          return response
        }
      }
      overrides.unshift(holding)
      return { release: () => release() }
    },
    hang(match: (call: AdoCall) => boolean): AdoCall[] {
      const hung: AdoCall[] = []
      overrides.unshift({
        match,
        respond: call =>
          new Promise<Response>((_, reject) => {
            hung.push(call)
            call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true })
          })
      })
      return hung
    },
    clear(): void {
      overrides.length = 0
    },
    count(match: (call: AdoCall) => boolean): number {
      return calls.filter(match).length
    }
  }
}

export type FakeAdo = ReturnType<typeof fakeAdo>

export const isWiql = (call: AdoCall) => call.method === 'POST' && call.path.endsWith('/_apis/wit/wiql')
export const isBatch = (call: AdoCall) => call.path.endsWith('/_apis/wit/workitemsbatch')
export const isPatch = (call: AdoCall) => call.method === 'PATCH'
export const isPullRequest = (call: AdoCall) => /\/_apis\/git\/pullrequests\/\d+$/.test(call.path)
export const isTypeStates = (type: string) => (call: AdoCall) => call.path.endsWith(`/_apis/wit/workitemtypes/${type}/states`)
