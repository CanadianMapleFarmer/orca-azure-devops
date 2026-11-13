export const NO_BOARDS = "Pick a boards project and team in this org's settings."
export const OPEN_LINK_UNAVAILABLE = "Orca couldn't ask to open the link. Bring its window to the front and try again."
export const BAD_LINE = 'Enter the line as a whole number from 1 up.'
export const SEARCH_TOO_SHORT = 'Type at least 2 characters to search.'
export const NO_TASK_TYPE = "This team's board has no task type, so tasks can't be added here."

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}
