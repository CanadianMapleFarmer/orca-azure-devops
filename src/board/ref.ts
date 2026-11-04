export interface BoardRef { org: string; projectId: string; teamId: string; boardId?: string }

export function parseBoardRef(text: string): BoardRef | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { org, projectId, teamId, boardId } = value as Record<string, unknown>
  if (!filled(org) || !filled(projectId) || !filled(teamId)) return null
  if (boardId === undefined) return { org, projectId, teamId }
  return filled(boardId) ? { org, projectId, teamId, boardId } : null
}

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
