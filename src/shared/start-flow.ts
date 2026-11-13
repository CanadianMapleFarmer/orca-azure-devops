import type { CloneProject, CloneTargets, RepoPick, RepoSource, StartAgentResult, StartRefused, StartRepo, StartRepos, StartWorkResult, WorkspaceRef } from './work'

export const LATE_MS = 60_000
export const CLONE_LATE_MS = 600_000

export const START_LABELS = {
  work: 'Start a workspace and agent',
  agent: 'Start an agent',
  workspace: 'Open workspace',
  show: 'Show it'
} as const

export const SHORTENED =
  'The description is too long to give the agent, so it got the title and link only. With "Add work item context to agent prompts" on, later prompts in this workspace start with the link too.'

export const SETUP_SKIPPED =
  "This repository's setup didn't run, because the plugin just added it to Orca. Look the repository over, then run its setup steps yourself in the workspace's terminal. Later workspaces in this repository run setup as usual."

export type StartTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface StartNotice {
  tone: StartTone
  text: string
  show?: WorkspaceRef
}

export interface Waiting {
  agent: string
  workspace: WorkspaceRef
  awaited: string
  lateMs: number
}

export type StartOutcome =
  | { kind: 'notice'; notice: StartNotice; shortened: boolean; setupSkipped: boolean; waitFor: Waiting | null; linked: WorkspaceRef | null }
  | { kind: 'choose'; picker: Picker; message: string | null }

function noticeOnly(notice: StartNotice, linked: WorkspaceRef | null = null): StartOutcome {
  return { kind: 'notice', notice, shortened: false, setupSkipped: false, waitFor: null, linked }
}

const refusedOutcome = (result: StartRefused): StartOutcome => noticeOnly({ tone: result.tone, text: result.message })

type Sent = Extract<StartWorkResult, { status: 'sent' }>

function sentNotice({ branch, repo, workspace, clone }: Sent): StartNotice {
  if (!clone) return { tone: 'accent', text: `Creating ${branch} in ${repo}. Orca opens it when it's ready.` }
  const doing = clone.fresh ? `Cloning ${repo} into ${clone.folder}` : `Adding ${clone.folder} to Orca`
  return { tone: 'accent', text: shownText(`${doing}, then creating ${branch}. Orca opens it when it's ready.`), show: workspace }
}

export function startWorkOutcome(result: StartWorkResult): StartOutcome {
  switch (result.status) {
    case 'sent':
      return {
        kind: 'notice',
        notice: sentNotice(result),
        shortened: result.shortened,
        setupSkipped: result.clone?.setupSkipped ?? false,
        waitFor: { agent: result.agent, workspace: result.workspace, awaited: `${result.branch} didn't appear`, lateMs: result.clone ? CLONE_LATE_MS : LATE_MS },
        linked: null
      }
    case 'linked':
      return noticeOnly({ tone: 'success', text: `${result.workspace.name} is already on ${result.branch}, so it's now this item's workspace.` }, result.workspace)
    case 'choose-repo':
      return { kind: 'choose', picker: changeRepo(pickerOf(result.repos)), message: result.message }
    case 'refused':
      return refusedOutcome(result)
  }
}

export function startAgentOutcome(result: StartAgentResult): StartOutcome {
  if (result.status === 'refused') return refusedOutcome(result)
  return {
    kind: 'notice',
    notice: { tone: 'success', text: `${result.agent} is starting in ${result.workspace.name}.` },
    shortened: result.shortened,
    setupSkipped: false,
    waitFor: { agent: result.agent, workspace: result.workspace, awaited: `${result.agent} didn't start`, lateMs: LATE_MS },
    linked: null
  }
}

export function readyNotice(branch: string, agent: string): StartNotice {
  return { tone: 'success', text: `${branch} is open, and ${agent} is starting with the item's details.` }
}

export function workingNotice(agent: string): StartNotice {
  return { tone: 'success', text: `${agent} is working on it.` }
}

export function lateNotice(itemId: number, waiting: Waiting): StartNotice {
  return { tone: 'neutral', text: `Sent to Orca. If ${waiting.awaited}, the terminal "ADO #${itemId}" in ${waiting.workspace.name} shows why.`, show: waiting.workspace }
}

export const REPO_LABELS = {
  repo: 'Repository',
  change: 'Change repo',
  choose: 'Choose a repository',
  clone: 'Clone from Azure DevOps…',
  project: 'Project',
  chooseProject: 'Choose a project',
  cloneRepo: 'Repository to clone',
  reading: 'Reading the repository list…',
  noRepos: 'No repositories are in Orca on this computer yet. Clone one from Azure DevOps.',
  emptyProject: 'This project has no repositories to clone.',
  hints: { pr: 'linked pull request', last: 'last used' }
} as const

export const CLONE_VALUE = 'clone'

export type Picker =
  | { mode: 'known'; repos: StartRepos; key: string }
  | { mode: 'list'; repos: StartRepos; key: string | null }
  | { mode: 'clone'; repos: StartRepos; targets: CloneTargets | 'loading' | { error: string }; projectId: string | null; repoId: string | null }

type ClonePicker = Extract<Picker, { mode: 'clone' }>

interface Option { value: string; label: string }

const HIDDEN = /[\p{Cc}\p{Cf}]/gu

const HINTS: Partial<Record<RepoSource, string>> = REPO_LABELS.hints

export function shownText(text: string): string {
  return text.replace(HIDDEN, '')
}

function rowLabel(repo: StartRepo): string {
  const hint = HINTS[repo.source]
  return `${shownText(repo.name)} · ${shownText(repo.detail)}${hint ? ` (${hint})` : ''}`
}

function cloning(repos: StartRepos): ClonePicker {
  const targets = 'problem' in repos.clone ? { error: repos.clone.problem } : 'loading'
  return { mode: 'clone', repos, targets, projectId: null, repoId: null }
}

function listedTargets(picker: ClonePicker): CloneTargets | null {
  return picker.targets !== 'loading' && 'projects' in picker.targets ? picker.targets : null
}

function projectIn(picker: ClonePicker, projectId: string | null): CloneProject | undefined {
  return listedTargets(picker)?.projects.find(project => project.id === projectId)
}

export function pickerOf(repos: StartRepos): Picker {
  const selected = repos.repos.find(repo => repo.key === repos.selected)
  if (selected) return { mode: 'known', repos, key: selected.key }
  return repos.repos.length === 0 ? cloning(repos) : { mode: 'list', repos, key: null }
}

export function repoOptions(repos: StartRepos): Option[] {
  return [...repos.repos.map(repo => ({ value: repo.key, label: rowLabel(repo) })), { value: CLONE_VALUE, label: REPO_LABELS.clone }]
}

export function repoSummary(picker: Extract<Picker, { mode: 'known' }>): string {
  const repo = picker.repos.repos.find(row => row.key === picker.key)
  return repo ? rowLabel(repo) : ''
}

export function changeRepo(picker: Picker): Picker {
  return picker.mode === 'known' ? { mode: 'list', repos: picker.repos, key: picker.key } : picker
}

export function chooseRepo(picker: Picker, value: string): Picker {
  if (value === CLONE_VALUE) return picker.mode === 'clone' ? picker : cloning(picker.repos)
  if (!picker.repos.repos.some(repo => repo.key === value)) return picker
  return { mode: 'list', repos: picker.repos, key: value }
}

export function withTargets(picker: Picker, targets: CloneTargets | { error: string }): Picker {
  return picker.mode === 'clone' && picker.targets === 'loading' ? { ...picker, targets } : picker
}

export function chooseProject(picker: Picker, projectId: string): Picker {
  if (picker.mode !== 'clone') return picker
  return projectIn(picker, projectId) ? { ...picker, projectId, repoId: null } : picker
}

export function chooseCloneRepo(picker: Picker, repoId: string): Picker {
  if (picker.mode !== 'clone' || !projectIn(picker, picker.projectId)?.repos.some(repo => repo.id === repoId)) return picker
  return { ...picker, repoId }
}

export function projectOptions(picker: Picker): Option[] {
  if (picker.mode !== 'clone') return []
  return (listedTargets(picker)?.projects ?? []).map(project => ({ value: project.id, label: shownText(project.name) }))
}

export function cloneRepoOptions(picker: Picker): Option[] {
  if (picker.mode !== 'clone') return []
  return (projectIn(picker, picker.projectId)?.repos ?? []).map(repo => ({ value: repo.id, label: shownText(repo.name) }))
}

export function pickOf(picker: Picker): RepoPick | null {
  if (picker.mode !== 'clone') return picker.key === null ? null : { kind: 'orca', key: picker.key }
  if ('problem' in picker.repos.clone || picker.projectId === null || picker.repoId === null) return null
  return { kind: 'clone', projectId: picker.projectId, repoId: picker.repoId }
}

function unlistedNote(more: number): string | null {
  if (more === 0) return null
  if (more === 1) return "1 more repository isn't listed. Clone it yourself and add it to Orca."
  return `${more} more repositories aren't listed. Clone them yourself and add them to Orca.`
}

export function cloneNote(picker: Picker): string | null {
  if (picker.mode !== 'clone') return null
  const clone = picker.repos.clone
  if ('problem' in clone) return clone.problem
  if (picker.targets === 'loading') return null
  if ('error' in picker.targets) return picker.targets.error
  const project = projectIn(picker, picker.projectId)
  if (project?.repos.length === 0) return REPO_LABELS.emptyProject
  const repo = project?.repos.find(row => row.id === picker.repoId)
  if (repo) return shownText(`Clones into ${clone.folder}/${repo.name}`)
  return unlistedNote(picker.targets.more)
}
