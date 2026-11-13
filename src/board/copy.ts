export const LOADING_DETAILS = 'Loading details…'
export const REFRESHING = 'Refreshing…'
export const DETAILS_FAILED = "Couldn't load this item."
export const READ_JUST_NOW = 'Read just now'
export const NO_DESCRIPTION = 'No description.'
export const NO_ACCEPTANCE = 'No acceptance criteria.'
export const NO_TASKS = 'No tasks yet.'
export const CHILDREN = 'Children'
export const NO_CHILDREN = 'No child items.'
export const TASKS_UNREAD = "Couldn't read this item's tasks. Refresh to try again."
export const NO_PRS = 'No linked pull requests.'
export const NO_COMMENTS = 'No comments yet.'
export const NOT_SHOWN = "This text couldn't be shown."
export const NEWEST_COMMENTS = 'Showing the newest 50 comments.'
export const OFF_BOARD = "This item isn't on the board any more."
export const NO_LINK_OPENER = "This view can't open links. Use Open in Azure DevOps in the sidebar."
export const UNASSIGNED = 'Unassigned'
export const SAVING = 'Saving…'
export const SEARCHING = 'Searching…'
export const NO_ONE_FOUND = 'No one found.'
export const SEND_HINT = 'Ctrl+Enter sends'
export const SEND_HINT_MAC = '⌘+Enter sends'
export const ADD_TASK = 'Add a task'
export const TASK_PLACEHOLDER = 'Task title'

export function tasksDone(done: number, total: number): string {
  return `${done} of ${total} done`
}

export function doneLabel(title: string): string {
  return `Done: ${title}`
}

export function moreTasks(count: number): string {
  return `${count} more in Azure DevOps`
}

export function readAge(age: string): string {
  return `Read ${age}`
}

export function into(target: string): string {
  return `into ${target}`
}

export function searchFor(query: string): string {
  return `Search Azure DevOps for "${query}"`
}
