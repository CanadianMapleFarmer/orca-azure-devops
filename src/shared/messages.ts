export const NO_BOARDS = "Pick a boards project and team in this org's settings."
export const OPEN_LINK_UNAVAILABLE = "Orca couldn't ask to open the link. Bring its window to the front and try again."

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}
