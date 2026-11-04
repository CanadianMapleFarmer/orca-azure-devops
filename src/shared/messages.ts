export const NO_BOARDS = "Pick a boards project and team in this org's settings."

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}
