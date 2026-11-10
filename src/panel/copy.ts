export const COLLAPSE_ALL = 'Collapse all'
export const EXPAND_ALL = 'Expand all'
export const ALL_PROJECTS = 'All projects'
export const ALL_REPOS = 'All repos'
export const ACROSS_PROJECTS = 'Across projects'
export const ACROSS_REPOS = 'Across repos'
export const OPEN_IN_TAB = 'Open in tab'
export const CHOOSE_ALL = 'Choose All projects to see everything.'

export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function needYouHint(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`
}

export function showMore(count: number): string {
  return `Show ${count} more`
}

export function nothingIn(project: string): string {
  return `Nothing here for ${project}`
}

export function repoCount(count: number): string {
  return counted(count, 'repo', 'repos')
}
