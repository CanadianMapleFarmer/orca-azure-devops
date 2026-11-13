import { messageOf } from '../shared/messages'
import {
  changeRepo,
  chooseCloneRepo,
  chooseProject,
  chooseRepo,
  CLONE_VALUE,
  cloneNote,
  cloneRepoOptions,
  lateNotice,
  pickerOf,
  pickOf,
  projectOptions,
  readyNotice,
  REPO_LABELS,
  repoOptions,
  repoSummary,
  SETUP_SKIPPED,
  SHORTENED,
  START_LABELS,
  startAgentOutcome,
  startWorkOutcome,
  withTargets,
  workingNotice,
  type Picker,
  type StartNotice,
  type StartOutcome,
  type Waiting
} from '../shared/start-flow'
import type { CloneTargets, ItemWorkspace, RepoPick, StartAgentResult, StartRepos, StartWorkResult, WorkspaceRef } from '../shared/work'
import { linkTo } from './links'
import { button, el } from './render'

type BoardScope = { teamId: string; boardId: string }

export interface StartRequests {
  itemWorkspace(input: { org: string; id: number }): Promise<ItemWorkspace>
  startRepos(input: { org: string; id: number; board?: BoardScope }): Promise<StartRepos>
  cloneTargets(input: { org: string }): Promise<CloneTargets>
  startWork(input: { org: string; id: number; board?: BoardScope; repo?: RepoPick }): Promise<StartWorkResult>
  startAgent(input: { org: string; id: number }): Promise<StartAgentResult>
  openWorkspace(input: { workspaceId: string }): Promise<{ opened: true }>
}

export interface StartState {
  lookup: { status: 'loading' } | { status: 'ready'; workspace: WorkspaceRef | null; unsupported: string | null }
  busy: boolean
  notice: StartNotice | null
  shortened: boolean
  setupSkipped: boolean
  picker: Picker | null
  waiting: (Waiting & { answered: boolean }) | null
}

export interface ItemEvent {
  org: string
  itemId: number
}

export interface Start {
  state(): StartState
  startWork(): Promise<void>
  startAgent(): Promise<void>
  show(workspace: WorkspaceRef): Promise<void>
  changeRepo(): void
  chooseRepo(value: string): void
  chooseProject(projectId: string): void
  chooseCloneRepo(repoId: string): void
  workspaceReady(event: ItemEvent & { workspaceId: string; branch: string }): void
  agentWorking(event: ItemEvent): void
  dispose(): void
}

export interface StartDeps {
  org: string
  itemId: number
  board: BoardScope | null
  requests: StartRequests
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
  changed(): void
}

export interface StartHandlers {
  startWork(): void
  startAgent(): void
  show(workspace: WorkspaceRef): void
  changeRepo(): void
  chooseRepo(value: string): void
  chooseProject(projectId: string): void
  chooseCloneRepo(repoId: string): void
  open(url: string): void
}

type ClonePicker = Extract<Picker, { mode: 'clone' }>
type Listed = CloneTargets | { error: string }

const OPEN_IN_ADO = 'Open in Azure DevOps'

export function createStart(deps: StartDeps): Start {
  const { org, itemId: id, requests, timers } = deps
  const board = deps.board ? { board: deps.board } : {}
  let current: StartState = { lookup: { status: 'loading' }, busy: false, notice: null, shortened: false, setupSkipped: false, picker: null, waiting: null }
  let late: ReturnType<typeof setTimeout> | undefined
  let listed: Promise<Listed> | null = null
  let disposed = false

  function update(patch: Partial<StartState>): void {
    if (disposed) return
    current = { ...current, ...patch }
    deps.changed()
  }

  function stopLate(): void {
    timers.clearTimeout(late)
    late = undefined
  }

  const isLinked = () => current.lookup.status === 'ready' && current.lookup.workspace !== null

  function linked(workspace: WorkspaceRef): Partial<StartState> {
    return { lookup: { status: 'ready', workspace, unsupported: current.lookup.status === 'ready' ? current.lookup.unsupported : null }, picker: null }
  }

  function wait(waitFor: Waiting): StartState['waiting'] {
    const waiting = { ...waitFor, answered: false }
    late = timers.setTimeout(() => update({ waiting: { ...waiting, answered: true }, notice: lateNotice(id, waiting) }), waiting.lateMs)
    return waiting
  }

  function settled(outcome: StartOutcome): Partial<StartState> {
    if (outcome.kind === 'choose') return { picker: outcome.picker, notice: outcome.message ? { tone: 'warning', text: outcome.message } : null }
    return {
      ...(outcome.linked ? linked(outcome.linked) : {}),
      notice: outcome.notice,
      shortened: outcome.shortened,
      setupSkipped: outcome.setupSkipped,
      waiting: outcome.waitFor ? wait(outcome.waitFor) : null,
    }
  }

  async function act(send: () => Promise<StartOutcome>): Promise<void> {
    stopLate()
    update({ busy: true, notice: null, shortened: false, setupSkipped: false, waiting: null })
    const outcome = await send().then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    )
    if (disposed) return
    update({ ...(outcome.ok ? settled(outcome.value) : { notice: { tone: 'danger', text: messageOf(outcome.error) } }), busy: false })
    readTargets()
  }

  function pick(picker: Picker): void {
    if (disposed || picker === current.picker) return
    update({ picker })
    readTargets()
  }

  function edit(change: (picker: Picker) => Picker): void {
    if (current.picker) pick(change(current.picker))
  }

  function readTargets(): void {
    const picker = current.picker
    if (picker?.mode !== 'clone' || picker.targets !== 'loading') return
    listed ??= requests.cloneTargets({ org }).catch((error: unknown): Listed => {
      listed = null
      return { error: messageOf(error) }
    })
    void listed.then(targets => edit(shown => withTargets(shown, targets)))
  }

  function offer(): void {
    requests.startRepos({ org, id, ...board }).then(
      repos => {
        if (current.picker === null && !isLinked()) pick(pickerOf(repos))
      },
      () => undefined
    )
  }

  const ours = (event: ItemEvent) => event.org === org && event.itemId === id

  requests.itemWorkspace({ org, id }).then(
    found => {
      update({ lookup: { status: 'ready', workspace: found.workspace, unsupported: found.unsupported } })
      if (found.workspace === null && found.unsupported === null) offer()
    },
    () => update({ lookup: { status: 'ready', workspace: null, unsupported: null } })
  )

  return {
    state: () => current,
    async startWork() {
      const repo = current.picker && pickOf(current.picker)
      if (current.picker && !repo) return
      await act(async () => {
        const outcome = startWorkOutcome(await requests.startWork({ org, id, ...board, ...(repo ? { repo } : {}) }))
        if (repo?.kind === 'clone' && outcome.kind === 'choose') listed = null
        return outcome
      })
    },
    startAgent: () => act(async () => startAgentOutcome(await requests.startAgent({ org, id }))),
    async show(workspace) {
      try {
        await requests.openWorkspace({ workspaceId: workspace.id })
      } catch (error) {
        update({ notice: { tone: 'danger', text: messageOf(error) } })
      }
    },
    changeRepo: () => edit(changeRepo),
    chooseRepo: value => edit(picker => chooseRepo(picker, value)),
    chooseProject: projectId => edit(picker => chooseProject(picker, projectId)),
    chooseCloneRepo: repoId => edit(picker => chooseCloneRepo(picker, repoId)),
    workspaceReady(event) {
      if (!ours(event)) return
      const workspace = { id: event.workspaceId, name: event.branch }
      const waiting = current.waiting
      if (!waiting) return update(linked(workspace))
      stopLate()
      update({ ...linked(workspace), waiting: { ...waiting, workspace, answered: true }, notice: readyNotice(event.branch, waiting.agent) })
    },
    agentWorking(event) {
      const waiting = current.waiting
      if (!ours(event) || !waiting) return
      stopLate()
      update({ waiting: null, notice: workingNotice(waiting.agent) })
    },
    dispose() {
      disposed = true
      stopLate()
    },
  }
}

export function startSection(state: StartState, itemUrl: string, handlers: StartHandlers, disabled: boolean): HTMLElement {
  const node = el('div', 'slot')
  const off = disabled || state.busy
  const starting = off || state.waiting?.answered === false
  const found = state.lookup.status === 'ready' ? state.lookup : null
  const unsupported = found?.unsupported ?? null
  const workspace = found?.workspace ?? null
  if (workspace) {
    node.append(
      control('agent', button(START_LABELS.agent, () => handlers.startAgent()), starting || unsupported !== null),
      control('workspace', button(START_LABELS.workspace, () => handlers.show(workspace), 'button secondary'), off)
    )
  } else {
    const picked = state.picker === null || pickOf(state.picker) !== null
    if (state.picker) node.append(repoPicker(state.picker, starting, handlers))
    node.append(control('work', button(START_LABELS.work, () => handlers.startWork()), starting || found === null || unsupported !== null || !picked))
  }
  const link = linkTo(itemUrl, OPEN_IN_ADO, handlers.open)
  link.dataset.start = 'link'
  node.append(link)
  if (unsupported) node.append(el('p', 'muted', unsupported))
  if (state.notice) node.append(noticeOf(state.notice, handlers))
  if (state.setupSkipped) node.append(noticeOf({ tone: 'warning', text: SETUP_SKIPPED }, handlers))
  if (state.shortened) node.append(noticeOf({ tone: 'warning', text: SHORTENED }, handlers))
  return node
}

export function startControl(root: Element, key: string): HTMLElement | null {
  const pending = [...root.children]
  for (let node = pending.pop(); node; node = pending.pop()) {
    if ((node as HTMLElement).dataset?.start === key) return node as HTMLElement
    pending.push(...node.children)
  }
  return null
}

function control<T extends HTMLButtonElement | HTMLSelectElement>(key: string, node: T, disabled: boolean): T {
  node.dataset.start = key
  node.disabled = disabled
  return node
}

function repoPicker(picker: Picker, off: boolean, handlers: StartHandlers): HTMLElement {
  const node = el('div', 'choice')
  if (picker.mode === 'known') {
    node.append(el('span', 'repo', repoSummary(picker)), control('change', button(REPO_LABELS.change, () => handlers.changeRepo(), 'button secondary'), off))
    return node
  }
  const value = picker.mode === 'clone' ? CLONE_VALUE : (picker.key ?? '')
  node.append(field(REPO_LABELS.repo, select('repo', REPO_LABELS.choose, repoOptions(picker.repos), value, off, handlers.chooseRepo)))
  if (picker.mode === 'clone') node.append(...cloneParts(picker, off, handlers))
  return node
}

function cloneParts(picker: ClonePicker, off: boolean, handlers: StartHandlers): HTMLElement[] {
  const parts: HTMLElement[] = []
  if (picker.repos.repos.length === 0) parts.push(el('p', 'muted', REPO_LABELS.noRepos))
  if (picker.targets !== 'loading' && 'projects' in picker.targets) {
    const repos = cloneRepoOptions(picker)
    parts.push(
      field(REPO_LABELS.project, select('project', REPO_LABELS.chooseProject, projectOptions(picker), picker.projectId ?? '', off, handlers.chooseProject)),
      field(REPO_LABELS.cloneRepo, select('clone-repo', REPO_LABELS.choose, repos, picker.repoId ?? '', off || repos.length === 0, handlers.chooseCloneRepo))
    )
  }
  const note = picker.targets === 'loading' ? REPO_LABELS.reading : cloneNote(picker)
  const failed = picker.targets !== 'loading' && 'error' in picker.targets
  if (note) parts.push(failed ? noticeOf({ tone: 'warning', text: note }, handlers) : el('p', 'muted', note))
  return parts
}

function field(text: string, input: HTMLSelectElement): HTMLElement {
  const label = el('label', 'field')
  label.append(el('span', '', text), input)
  return label
}

function select(key: string, placeholder: string, options: { value: string; label: string }[], value: string, off: boolean, choose: (value: string) => void): HTMLSelectElement {
  const node = control(key, el('select'), off)
  const blank = new Option(placeholder, '')
  blank.disabled = true
  blank.hidden = true
  node.append(blank, ...options.map(option => new Option(option.label, option.value)))
  node.value = value
  node.addEventListener('change', () => choose(node.value))
  return node
}

function noticeOf(notice: StartNotice, handlers: StartHandlers): HTMLElement {
  const node = el('div', `notice ${notice.tone}`)
  node.setAttribute('role', notice.tone === 'danger' ? 'alert' : 'status')
  node.append(el('div', '', notice.text))
  const target = notice.show
  if (target) node.append(control('show', button(START_LABELS.show, () => handlers.show(target), 'button secondary'), false))
  return node
}
