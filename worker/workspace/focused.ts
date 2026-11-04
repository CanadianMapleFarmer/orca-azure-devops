export type HostCall = (method: string, params?: unknown) => Promise<any>

export interface WorkspaceEntry { id: string; kind: 'worktree' | 'folder'; name: string; path: string; branch: string | null; hostId: string | null }

export async function listWorkspaces(call: HostCall): Promise<WorkspaceEntry[]> {
  const { workspaces }: { workspaces: WorkspaceEntry[] } = await call('workspace.list')
  return workspaces
}

export async function focusedWorkspace(call: HostCall): Promise<WorkspaceEntry | null> {
  const context: { branch: string; displayName: string } | null = await call('workspace.readContext')
  if (!context) return null
  const workspaces = await listWorkspaces(call)
  // Folder workspaces have no branch, so they match by name alone.
  const matches = workspaces.filter(entry => entry.name === context.displayName && (entry.kind === 'folder' || entry.branch === context.branch))
  return matches.length === 1 ? matches[0] : null
}
