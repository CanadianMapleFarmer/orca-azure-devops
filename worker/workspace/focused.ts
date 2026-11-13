export type HostCall = (method: string, params?: unknown) => Promise<any>

export interface WorkspaceEntry { id: string; kind: 'worktree' | 'folder'; name: string; project?: string | null; path: string; branch: string | null; hostId: string | null }

export function isLocalWorkspace(entry: WorkspaceEntry): boolean {
  return entry.hostId === null || entry.hostId === 'local'
}

export async function listWorkspaces(call: HostCall): Promise<WorkspaceEntry[]> {
  const { workspaces }: { workspaces: WorkspaceEntry[] } = await call('workspace.list')
  return workspaces
}

export async function focusedWorkspace(call: HostCall, listed?: WorkspaceEntry[]): Promise<WorkspaceEntry | null> {
  const context: { branch: string; displayName: string } | null = await call('workspace.readContext')
  if (!context) return null
  const workspaces = listed ?? (await listWorkspaces(call))
  const matches = workspaces.filter(entry => entry.name === context.displayName && (entry.kind === 'folder' || entry.branch === context.branch))
  return matches.length === 1 ? matches[0] : null
}
