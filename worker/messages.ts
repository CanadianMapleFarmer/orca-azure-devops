import { AdoError } from './ado/http'

export { CHANNEL_NAME_TOO_LONG, TOO_MANY_ITEMS, TOO_MANY_PEOPLE } from '../src/shared/share/limits'

export const NOT_CONNECTED = 'Connect this organization first.'
export const CONFLICT = "Someone else changed this item. It's been refreshed; try again."
export const GONE = "That work item no longer exists, or you can't see it."
export const LOAD_FAILED = "Couldn't load work items."
export const REOPEN_BOARD = 'Reopen this board and try again.'
export const UNKNOWN_COLUMN = "That column isn't on this board."
export const UNKNOWN_LANE = "That lane isn't on this board."
export const UNMAPPED_TYPE = "This item type isn't on the board. Move it by state instead."
export const MOVE_BY_COLUMN = 'Move this item by column.'
export const INCOMPLETE_CONFIG = "This board's configuration is incomplete. Try refreshing."
export const LAST_BOARD = 'Showing the last loaded board.'
export const CHIPS_NEED_CODE_READ = 'Linked PR status needs Code (Read) access.'
export const NOT_A_PR = "That isn't an Azure DevOps pull request link."
export const EMPTY_COMMENT = 'Write a comment first.'
export const UNKNOWN_AUTHOR = 'Unknown'
export const REST_IN_ADO = '… open in Azure DevOps for the rest'
export const NO_LOCAL_WORKSPACE = 'Open a local workspace first, or use + → Azure DevOps board.'
export const BAD_BOARD = "That board can't be opened."
export const NO_ITEM_WORKSPACE = 'Start a workspace for this item first, or open one in Orca.'
export const SETTINGS_READ_FAILED = "Couldn't read settings; keeping the previous values."
export const BOARDS_TEAM_GONE = 'That project or team no longer exists.'
export const NO_CODE_PROJECTS = 'Pick at least one project, or choose all projects.'
export const CODE_PROJECTS_GONE = 'One or more projects no longer exist.'
export const FIND_PEOPLE_NEEDS_ACCESS = 'Finding people needs Graph (Read) and Identity (Read) access.'
export const PRS_TRIMMED = 'Showing the newest pull requests only.'
export const PRS_NEED_CODE_READ = 'Pull requests need Code (Read) access.'
export const PRS_LOAD_FAILED = "Couldn't load pull requests."
export const PRS_WORK_ITEMS_NEED_ACCESS = 'Linked work items need more access, so sets are grouped by branch only.'
export const PRS_CHECKS_NEED_ACCESS = 'Build and policy status need more access.'
export const PR_SKIPPED_COMPLETED = "Skipped: it's completed."
export const PR_SKIPPED_ABANDONED = "Skipped: it's abandoned."
export const PR_SKIPPED_DRAFT = "Skipped: it's a draft. Publish it first."
export const PR_ALREADY_APPROVED = 'Already approved.'
export const PR_APPROVED = 'Approved.'
export const PR_ALREADY_AUTO_COMPLETE = 'Already set to auto-complete.'
export const PR_AUTO_COMPLETE_SET = 'Auto-complete set.'
export const PR_BRANCH_KEPT_UNCHECKED = `${PR_AUTO_COMPLETE_SET} Source branch kept: couldn't check for other pull requests.`
export const COPY_NEEDS_TOOL = 'Copying needs wl-clipboard or xclip.'
export const COPY_FAILED = "Couldn't copy to the clipboard."
export const COPIED_RICH = 'Copied as rich text.'
export const COPIED_HTML = 'Copied as rich text (HTML only).'
export const WEBHOOK_URL_EMPTY = 'Paste the webhook URL from Teams Workflows.'
export const WEBHOOK_URL_INVALID = "That isn't a valid https webhook URL."
export const CHANNEL_NAME_EMPTY = 'Name the channel.'
export const CHANNEL_NAME_TAKEN = 'You already have a channel with that name.'
export const CHANNEL_LIMIT = 'You can add up to 20 channels.'
export const CHANNEL_GONE = 'That channel no longer exists.'
export const CHANNEL_URL_MISSING = "This channel's webhook URL is missing. Replace it."
export const SECRETS_UNAVAILABLE = "Orca can't store secrets on this system, so Teams channels are unavailable."
export const TEAMS_THROTTLED = 'Teams is throttling posts. Try again in a minute.'
export const TEAMS_UNREACHABLE = "Couldn't reach Teams."
export const CARD_TOO_LARGE = 'Too much to post at once. Share fewer items.'
export const CHANNEL_TEST_INTRO = 'Azure DevOps for Orca can post to this channel.'
export const CHANNEL_TEST_SENT = "Sent (accepted). Teams doesn't confirm delivery; check the channel."
export const NO_REVIEWERS_CHOSEN = 'Choose people to add as reviewers.'
export const NOTHING_TO_SHARE = 'Choose at least one item to share.'
export const NO_PULL_REQUESTS_FOR_REVIEWERS = 'There are no pull requests to add reviewers to.'
export const SHARE_PREFS_NOT_SAVED = "Couldn't save the share choices."
export const CHANNEL_SECRET_LEFT = "Couldn't remove the saved URL of a Teams channel that failed to save."
export const UNKNOWN_SHARE_KIND = "That can't be shared."

export const ALL_JOBS_STAGE = 'All jobs'

export const MALFORMED = {
  workItem: 'Azure DevOps returned an unexpected work item response.',
  pullRequest: 'Azure DevOps returned an unexpected pull request response.',
  comment: 'Azure DevOps returned an unexpected comment response.',
  boardConfig: 'Azure DevOps returned an unexpected board configuration.',
  identity: 'Azure DevOps returned an unexpected identity response.',
  build: 'Azure DevOps returned an unexpected pipeline run response.',
  timeline: 'Azure DevOps returned an unexpected run timeline.',
  log: 'Azure DevOps returned an unexpected log response.'
} as const

export function noBoardNamed(name: string): string {
  return `The team has no board named "${name}".`
}

export function showingNewest(count: number): string {
  return `Showing the ${count.toLocaleString('en-US')} most recently changed items.`
}

export function keptBranch(prId: number): string {
  return `${PR_AUTO_COMPLETE_SET} Source branch kept: Pull Request ${prId} also uses it.`
}

export function alreadySetWillDelete(prId: number): string {
  return `${PR_ALREADY_AUTO_COMPLETE} It will delete the source branch Pull Request ${prId} also uses; turn that off in Azure DevOps.`
}

export function siblingWillDelete(prId: number): string {
  return `${PR_AUTO_COMPLETE_SET} Pull Request ${prId} will delete the shared source branch when it completes.`
}

export function sentTo(name: string): string {
  return `Sent to ${name} (accepted).`
}

export function httpRefused(status: number): string {
  return `Teams didn't accept the post (HTTP ${status}). If the workflow changed, replace its URL.`
}

export function sharedBy(name: string): string {
  return `Shared by ${name} from Orca`
}

export function addedReviewers(names: string[], count: number): string {
  return `Added ${names.join(', ')} to ${count} ${count === 1 ? 'pull request' : 'pull requests'}.`
}

export function alreadyReviewer(name: string, prId: number): string {
  return `${name} is already on Pull Request ${prId}.`
}

export function reviewerNotAdded(name: string, prId: number, reason: string): string {
  return `Couldn't add ${name} to Pull Request ${prId}: ${reason}`
}

export function joinMessages(...messages: (string | undefined)[]): string | undefined {
  return messages.filter(Boolean).join(' ') || undefined
}

export function badRequest(message: string): AdoError {
  return new AdoError('bad_request', 400, message)
}

export function failureMessage(error: unknown, fallback = LOAD_FAILED): string {
  return error instanceof AdoError ? error.message : fallback
}
