import type { VoteChoice } from '../src/shared/reviews'
import { MAX_DRAFTS } from '../src/shared/wiki'
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
export const NOTIFY_FAILED = "Couldn't show a desktop notification."
export const MORE_UPDATES_BODY = 'Open the Pipelines tab in the Azure DevOps panel to see them.'
export const YOU_CAN_APPROVE = 'You can approve it.'
export const RUNS_TRIMMED = 'Showing the newest runs only.'
export const RUNS_NEED_BUILD_READ = 'Pipelines need Build (Read) access.'
export const RUNS_LOAD_FAILED = "Couldn't load pipeline runs."
export const APPROVALS_NEED_ACCESS = 'Pending approvals need more access, so Needs me may be incomplete.'
export const APPROVALS_UNREADABLE = "Some pending approvals couldn't be read, so Needs me may be incomplete."
export const APPROVAL_ENVIRONMENTS_UNREAD = "Some approval environments couldn't be read."
export const TOO_MANY_WATCHED = 'You can watch up to 20 runs.'
export const RUN_ALREADY_FINISHED = 'This run has already finished.'
export const RUN_GONE = "That run no longer exists, or you can't see it."
export const COMMENT_TOO_LONG = 'Keep the comment under 1,000 characters.'
export const APPROVAL_NOT_PENDING = 'This approval is no longer pending.'
export const APPROVED = 'Approved.'
export const REJECTED = 'Rejected.'
export const STAGE_GONE = "That stage isn't in this run any more."
export const STAGE_NOT_RETRYABLE = 'Only a failed or canceled stage of a finished run can be rerun.'
export const RUN_ALREADY_CANCELLING = 'The run is already cancelling.'
export const RUN_CANCELLING = 'Cancelling the run.'
export const BAD_RUN = "That run can't be opened."
export const NO_LOCAL_WORKSPACE_RUN = 'Open a local workspace first; runs open in a tab there.'
export const NO_LOCAL_WORKSPACE_FILE = 'Open a local workspace first.'
export const RUN_TRIMMED = 'Some issue details were left out to keep this run view small.'
export const RUN_CUT = 'Some steps were left out to keep this run view small.'
export const NOT_A_FILE_PATH = "That isn't a file path Orca can open."
export const GIT_REMOTES_FAILED = "Couldn't read the git remotes of a local workspace."
export const MARKDOWN_CUT_NOTE = 'The rest is in Azure DevOps.'
export const DIFF_BINARY = "Binary file; it isn't shown here."
export const DIFF_TOO_LARGE = 'This file is too large to show here. Check out the branch in Orca to see it.'
export const DIFF_TOO_MANY = 'Too many changes to show here. Check out the branch in Orca to see this diff.'
export const DIFF_NO_TEXT_CHANGES = 'No text changes in this file.'
export const REVIEW_PR_GONE = "That pull request no longer exists, or you can't see it."
export const REVIEW_TRIMMED = 'Some comments were left out to keep this view small. Open the pull request in Azure DevOps to see them all.'
export const DIFF_NO_BASE =
  "Azure DevOps hasn't worked out this pull request's base yet, so the diff can't be shown. Refresh in a moment, or check the branch out in Orca."
export const REVIEW_FILES_CAPPED = 'More than 1,000 files changed. Open the pull request in Azure DevOps, or check it out in Orca, to see them all.'
export const FILE_NOT_IN_PR = "That file isn't changed in this pull request any more."
export const REVIEW_PR_CLOSED = 'This pull request is no longer active.'
export const REVIEW_DRAFT_NO_VOTES = 'Votes are off while a pull request is a draft.'
export const REVIEW_COMMENT_TOO_LONG = 'Keep the comment under 10,000 characters.'
export const THREAD_GONE = 'That comment thread no longer exists.'
export const REPLIED = 'Reply posted.'
export const ALREADY_RESOLVED = 'This thread is already resolved.'
export const ALREADY_ACTIVE = 'This thread is already active.'
export const RESOLVED = 'Resolved.'
export const REACTIVATED = 'Reactivated.'
export const COMMENTED = 'Comment posted.'
export const BINARY_NO_LINES = 'Binary files take comments on the whole file only.'
export const LINE_UNCHECKED = 'This file is too large to check the line. Comment on the whole file, or comment in Azure DevOps.'
export const NO_LINES = 'This file has no lines; comment on the whole file instead.'
export const CHECKOUT_FORK = "This pull request comes from a fork. Check it out from the fork's repository instead."
export const CHECKOUT_NEEDS_GIT_PROJECT =
  "This repository is open in Orca only as a folder, which can't create worktrees. Open it as a git project in Orca, then press Check out in Orca again."
export const ARM_ANY_PROJECT = 'Create it before any other new workspace: the next one, in any project, gets this branch.'
export const WIKIS_LOAD_FAILED = "Couldn't load wikis."
export const WIKI_NEEDS_READ = 'The wiki needs Wiki (Read) access.'
export const UNKNOWN_WIKI = "That wiki no longer exists, or you can't see it."
export const WIKI_PAGE_GONE = 'This page was moved or deleted in Azure DevOps.'
export const WIKI_READ_ONLY = 'This wiki is published from a repository. Edit its files there.'
export const WIKI_SEARCH_UNAVAILABLE = "Wiki search isn't available in this organization."
export const BAD_TAB_FILE = "That file name can't be used."
export const DRAFT_OUTSIDE = 'The wiki draft folder leads outside this workspace, so nothing was written.'
export const DRAFT_WORKSPACE_GONE = 'The workspace holding this draft is gone. Discard the draft to edit the page again.'
export const NO_LOCAL_WORKSPACE_WIKI = 'Open a local workspace first; wiki pages open in a tab there.'
export const WIKI_PAGE_TOO_LARGE = 'This page is too large to edit here. Edit it in Azure DevOps.'
export const TOO_MANY_DRAFTS = `You have ${MAX_DRAFTS} wiki drafts. Publish or discard some first.`
export const DRAFT_FILE_TAKEN = 'Another draft already uses that file name. Publish or discard it first.'
export const DRAFT_DISCARDED = 'Draft discarded.'
export const DRAFT_GONE = 'That draft no longer exists.'
export const DRAFT_FILE_NOT_REMOVED = "Couldn't remove a wiki draft file."
export const DRAFT_BUSY = 'This draft is already being published.'
export const DRAFT_FILE_GONE = 'The draft file is gone. Press Edit to start again.'
export const DRAFT_KEPT = 'Your draft is kept.'
export const DRAFT_BASE_GONE = `The draft's base copy is gone, so it can't be compared. ${DRAFT_KEPT}`
export const NOTHING_TO_PUBLISH = 'Nothing to publish yet. Save your changes in the editor first.'
export const MERGE_NOT_SAVED = "Your draft hasn't changed since their version opened. Copy what you need into it and save, or choose Publish mine."
export const WIKI_CONFLICT = 'Someone changed this page in Azure DevOps after you started editing.'
export const PUBLISHED = 'Published.'
export const PUBLISHED_OVER = `${PUBLISHED} Their changes were replaced.`
export const TOOK_THEIRS = 'Your draft now holds their version.'

export const VOTED: Record<VoteChoice, string> = {
  approve: PR_APPROVED,
  suggestions: 'Approved with suggestions.',
  waitForAuthor: 'Marked as waiting for the author.',
  reject: REJECTED
}

export const ALL_JOBS_STAGE = 'All jobs'

export const MALFORMED = {
  workItem: 'Azure DevOps returned an unexpected work item response.',
  pullRequest: 'Azure DevOps returned an unexpected pull request response.',
  comment: 'Azure DevOps returned an unexpected comment response.',
  boardConfig: 'Azure DevOps returned an unexpected board configuration.',
  identity: 'Azure DevOps returned an unexpected identity response.',
  build: 'Azure DevOps returned an unexpected pipeline run response.',
  timeline: 'Azure DevOps returned an unexpected run timeline.',
  log: 'Azure DevOps returned an unexpected log response.',
  approval: 'Azure DevOps returned an unexpected approval response.',
  review: 'Azure DevOps returned an unexpected pull request review response.',
  wiki: 'Azure DevOps returned an unexpected wiki response.'
} as const

export function diffCut(lines: number): string {
  return `Showing the first ${lines.toLocaleString('en-US')} lines of this diff. Check out the branch in Orca for the rest.`
}

export function alreadyVoted(phrase: string): string {
  return `You already voted: ${phrase}.`
}

export function votedAs(phrase: string): string {
  return `Azure DevOps recorded your vote as ${phrase}.`
}

export function lineOutOfRange(lines: number): string {
  return `Pick a line from 1 to ${lines}.`
}

export function commentedOn(path: string, line: number | null): string {
  return `Comment posted on ${path}${line === null ? '' : `, line ${line}`}.`
}

export function renamedFrom(path: string): string {
  return `Renamed from ${path}.`
}

export function openedCheckout(name: string, source: string): string {
  return `Opened ${name}. It's already on ${source}.`
}

export function armedCheckout({ repo, branch, base, prId, target }: { repo: string; branch: string; base: string; prId: number; target: string }): string {
  return (
    `Now create a new workspace in Orca from the ${repo} project. It will check out ${branch} from ${base} (or ${branch}-2 if that name is taken), ` +
    `the source of Pull Request ${prId}. To review it, set Source Control's compare base to ${target}.`
  )
}

export function openedDraft(title: string): string {
  return `Opened ${title} in Orca. Save your changes there, then press Publish here.`
}

export function draftNotUpdated(reason: string): string {
  return `Your draft couldn't be updated to match: ${reason}`
}

export function openedTheirs(name: string): string {
  return `Opened their version as ${name}. Copy what you need into your draft, save it, then press Publish.`
}

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

export function runFailedTitle(pipeline: string): string {
  return `${pipeline} failed`
}

const FINISHED_PHRASE = { succeeded: 'succeeded', warning: 'finished with warnings', canceled: 'was canceled' } as const

export function runFinishedTitle(pipeline: string, state: keyof typeof FINISHED_PHRASE): string {
  return `${pipeline} ${FINISHED_PHRASE[state]}`
}

export function approvalTitle(pipeline: string): string {
  return `${pipeline} is waiting for approval`
}

export function runBody(org: string, runNumber: string, branch: string, detail?: string): string {
  return `${org} · ${runNumber} on ${branch}${detail ? ` · ${detail}` : ''}`
}

export function failedAt(stage: string): string {
  return `failed at ${stage}`
}

export function waitingAt(place: string): string {
  return `waiting at ${place}`
}

export function moreRunUpdates(count: number): string {
  return `${count} more pipeline ${count === 1 ? 'update' : 'updates'}`
}

export function approvedNeedsMore(count: number): string {
  return `${APPROVED} It still needs ${count} more ${count === 1 ? 'approval' : 'approvals'}.`
}

export function rerunning(stage: string): string {
  return `Rerunning ${stage}.`
}

export function noRepoWorkspace(repo: string): string {
  return `Open a local workspace of ${repo} first.`
}

export function fileNotFound(path: string, repo: string): string {
  return `Couldn't find ${path} in your local workspaces of ${repo}.`
}

export const IMAGE_ALT = 'image'

export function imageLink(alt: string): string {
  return `Image: ${alt}`
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
