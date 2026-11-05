import { isBuildId } from '../shared/runs'

export interface RunRef {
  org: string
  projectId: string
  buildId: number
}

export function parseRunRef(text: string): RunRef | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { org, projectId, buildId } = value as Record<string, unknown>
  return filled(org) && filled(projectId) && isBuildId(buildId) ? { org, projectId, buildId } : null
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
