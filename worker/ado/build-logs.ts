import { MAX_LINE_CHARS } from '../../src/shared/pipelines'
import { MALFORMED } from '../messages'
import { cutText } from './cut-text'
import type { AdoHttp } from './http'
import { expectList, expectText, shaped } from './shape'

interface RawLog {
  id: number
  lineCount: number
}

export async function listLogs(
  http: AdoHttp,
  org: string,
  projectId: string,
  buildId: number,
  signal?: AbortSignal
): Promise<Map<number, number>> {
  const { data } = await http.json<{ value: RawLog[] }>({ org, project: projectId, path: logsPath(buildId), signal })
  return shaped(
    () => new Map(expectList<RawLog>(data.value).map((log): [number, number] => [expectCount(log.id), expectCount(log.lineCount)])),
    MALFORMED.log
  )
}

export async function getLogLines(
  http: AdoHttp,
  org: string,
  projectId: string,
  buildId: number,
  logId: number,
  first: number,
  last: number,
  signal?: AbortSignal
): Promise<string[]> {
  const { data } = await http.json<{ value: string[] }>({
    org,
    project: projectId,
    path: `${logsPath(buildId)}/${logId}`,
    query: { startLine: first, endLine: last },
    signal
  })
  return shaped(() => expectList<unknown>(data.value).map(line => cutText(expectText(line), MAX_LINE_CHARS)), MALFORMED.log)
}

function logsPath(buildId: number): string {
  return `/_apis/build/builds/${buildId}/logs`
}

function expectCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('expected a count')
  return value
}
