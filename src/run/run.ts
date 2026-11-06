import type { EditorDocument } from 'orca/frame'
import { fileRefOf } from '../shared/file-ref'
import { messageOf, OPEN_LINK_UNAVAILABLE } from '../shared/messages'
import type { FileRef, Issue, JobView, RunActionResult, RunView, StepView } from '../shared/pipelines'
import { isActive, RUN_STATE_TEXT, RUN_STATE_TONE } from '../shared/runs'
import { plainText } from './ansi'
import { appendChunk, earlierStart, errorLines, lastLine, nextHit, nextRead, searchHits, visibleIndexes, type LogBuffer } from './log-model'
import { parseRunRef, type RunRef } from './ref'
import {
  approvalBlock,
  button,
  createErrorSummary,
  createLogView,
  createStageStrip,
  createToolbar,
  el,
  focusMark,
  restoreFocus,
  stepList,
  type Decision,
  type DraftView,
  type ErrorRow,
  type FailureModel,
  type RowModel,
  type Tone
} from './render'
import { scrollTopFor, windowOf } from './virtual'
import {
  approvalText,
  issueFile,
  logNotice,
  nextSelection,
  openedText,
  rerunTarget,
  selectedRecord,
  watchedOf,
  type Selection,
  type WatchToggle
} from './view-state'

interface State {
  ref: RunRef
  view: RunView | null
  failure: string | null
  loading: boolean
  selection: Selection | null
  pinned: boolean
  buffer: LogBuffer | null
  logError: string | null
  logBusy: boolean
  logAgain: boolean
  follow: boolean
  errorsOnly: boolean
  query: string
  hitLine: number | null
  banner: { text: string; tone: Tone } | null
  busy: Set<string>
  cancelArmed: boolean
  watch: WatchToggle | null
  drafts: Map<string, DraftView>
  opened: Map<string, string>
  opening: Set<string>
}

const ROW_HEIGHT = 18
const READ_FAILED = "Couldn't read this run file."
const NOT_A_RUN = "This file doesn't name an Azure DevOps run."
const EDITOR_ONLY = 'This view opens only as the Azure DevOps run editor.'
const LOADING_RUN = 'Loading run…'
const LOADING_LOG = 'Loading log…'

const root = document.getElementById('app') as HTMLElement
const toolbar = createToolbar({ watch: () => void watch(), rerun: () => void rerun(), cancel: () => void cancel(), disarm, open: openInAdo })
const banner = el('div', 'banner')
const note = el('p', 'note muted')
const body = el('main', 'body')
const stages = createStageStrip()
const approvalsSlot = el('div', 'approvals')
const steps = el('aside', 'steps')
steps.setAttribute('aria-label', 'Steps')
const errors = createErrorSummary()
const log = createLogView({
  search,
  step: stepHit,
  errorsOnly: toggleErrorsOnly,
  follow: toggleFollow,
  earlier: () => void loadEarlier(),
  scrolled: paintRows,
  leftEnd: stopFollowing
})
const detail = el('section', 'detail')
detail.append(errors.node, log.node)
const split = el('div', 'split')
split.append(steps, detail)
body.append(stages.node, approvalsSlot, split)

let state: State | null = null
let shownText: string | null = null
let reported: RunRef | null = null
let viewSeq = 0
let visible: number[] = []
let hits: number[] = []

function paint(): void {
  const current = state
  if (!current) return
  const mark = focusMark(root)
  const view = current.view
  const now = Date.now()
  paintBanner(current)
  note.textContent = view?.message ?? ''
  note.hidden = note.textContent === ''
  if (!view) {
    toolbar.update({ title: 'Azure DevOps run', subtitle: '', state: '', stateTone: 'neutral', loading: current.loading, watched: false, watchDisabled: true, rerun: null, cancel: 'hidden', busy: current.busy, openable: false })
    body.replaceChildren(current.failure ? failureNotice(current.failure) : el('p', 'muted pad', LOADING_RUN))
    return
  }
  if (!body.contains(split)) body.replaceChildren(stages.node, approvalsSlot, split)
  const run = view.run
  const watched = watchedOf(view, current.watch)
  toolbar.update({
    title: `${run.pipeline.name} ${run.runNumber}`,
    subtitle: `${run.branch} · ${run.requestedFor.name}`,
    state: RUN_STATE_TEXT[run.state],
    stateTone: RUN_STATE_TONE[run.state],
    loading: current.loading,
    watched,
    watchDisabled: !watched && !isActive(run),
    rerun: rerunTarget(view, current.selection?.stageId ?? null)?.name ?? null,
    cancel: view.canCancel ? (current.cancelArmed ? 'armed' : 'ready') : 'hidden',
    busy: current.busy,
    openable: orca.shell !== undefined
  })
  const stage = view.stages.find(entry => entry.id === current.selection?.stageId) ?? null
  stages.update(view.stages, stage?.id ?? null, now, entry => select({ stageId: entry.id, stepId: null }))
  approvalsSlot.replaceChildren(...run.approvals.map(approval => approvalBlock(approval, approvalText(approval, view.stages, now), current.drafts.get(approval.approvalId) ?? null, approvalHandlers(approval.approvalId, approval.projectId))))
  steps.replaceChildren(stepList(stage, current.selection?.stepId ?? null, now, record => select({ stageId: stage?.id ?? null, stepId: record.id })))
  errors.update(failureModels(current, view))
  paintLog(current)
  restoreFocus(root, mark)
}

function paintBanner(current: State): void {
  banner.replaceChildren()
  banner.hidden = current.banner === null
  if (!current.banner) return
  banner.className = `banner ${current.banner.tone}`
  banner.setAttribute('role', current.banner.tone === 'danger' ? 'alert' : 'status')
  banner.append(el('span', '', current.banner.text), button('Dismiss', dismissBanner, 'button secondary small'))
}

function failureNotice(text: string): HTMLElement {
  const box = el('div', 'pad')
  box.append(el('p', 'muted', text), button('Try again', () => void loadView()))
  return box
}

function dismissBanner(): void {
  if (!state) return
  state.banner = null
  paint()
}

function tell(current: State, text: string, tone: Tone): void {
  current.banner = { text, tone }
}

function told(current: State, result: RunActionResult): void {
  tell(current, result.message, !result.ok ? 'danger' : result.warn ? 'warning' : 'info')
}

function recordOf(current: State): StepView | JobView | null {
  return current.view ? selectedRecord(current.view, current.selection) : null
}

function logIdOf(current: State): number | null {
  return recordOf(current)?.logId ?? null
}

function paintLog(current: State): void {
  const record = recordOf(current)
  const buffer = current.buffer?.logId === record?.logId ? current.buffer : null
  visible = buffer ? visibleIndexes(buffer, current.errorsOnly) : []
  hits = buffer ? searchHits(buffer, current.query).filter(index => !current.errorsOnly || buffer.lines[index].kind === 'error').map(index => buffer.lines[index].n) : []
  const position = current.hitLine === null ? 0 : hits.indexOf(current.hitLine) + 1
  log.update({
    hits: current.query ? `${position} of ${hits.length}` : null,
    errorsOnly: current.errorsOnly,
    follow: current.follow,
    earlier: buffer !== null && earlierStart(buffer) !== null,
    busy: current.logBusy,
    info: buffer && buffer.lines.length > 0 ? `Lines ${buffer.first}–${lastLine(buffer)} of ${buffer.total}` : '',
    notice: buffer ? null : (logNotice(record) ?? (current.logError ? null : LOADING_LOG)),
    error: current.logError
  })
  paintRows()
  if (current.follow) scrollToEnd()
}

function paintRows(): void {
  const current = state
  const buffer = current?.buffer
  if (!current || !buffer || buffer.logId !== logIdOf(current)) return log.paintRows([], 0, 0)
  const scroller = log.scroller
  const range = windowOf({ scrollTop: scroller.scrollTop, viewport: scroller.clientHeight, rowHeight: ROW_HEIGHT, count: visible.length })
  const hitSet = new Set(hits)
  const items: RowModel[] = []
  for (let index = range.start; index < range.end; index += 1) {
    const line = buffer.lines[visible[index]]
    items.push({ line, hit: hitSet.has(line.n), current: line.n === current.hitLine })
  }
  log.paintRows(items, range.offset, visible.length * ROW_HEIGHT)
}

function scrollToEnd(): void {
  log.scroller.scrollTop = log.scroller.scrollHeight
  paintRows()
}

function scrollToLine(n: number): void {
  const current = state
  const buffer = current?.buffer
  if (!current || !buffer) return
  const position = visible.indexOf(n - buffer.first)
  if (position < 0) return
  log.scroller.scrollTop = scrollTopFor(position, ROW_HEIGHT, log.scroller.clientHeight)
  paintRows()
}

function failureModels(current: State, view: RunView): FailureModel[] {
  const buffer = current.buffer
  return view.failures.map(failure => {
    const key = `${failure.stageId}:${failure.stepId}`
    const issues = failure.issues.map(issue => issueRow(current, key, issue))
    const loaded = buffer && buffer.logId === failure.logId ? buffer : null
    const lines = loaded ? errorLines(loaded).map(line => lineRow(current, loaded.logId, line.n, plainText(line.text))) : []
    return { key, path: failure.path, select: () => select({ stageId: failure.stageId, stepId: failure.stepId }), issues, lines }
  })
}

function issueRow(current: State, failureKey: string, issue: Issue): ErrorRow {
  const file = issueFile(issue)
  const key = `issue:${failureKey}:${file?.path ?? ''}:${file?.line ?? ''}:${issue.message}`
  return { key, text: `${issue.type === 'error' ? '✗' : '!'} ${issue.message}`, jump: null, ...openOf(current, key, file) }
}

function lineRow(current: State, logId: number, n: number, text: string): ErrorRow {
  const key = `line:${logId}:${n}`
  return { key, text: `Line ${n}: ${text}`, jump: () => jumpTo(n), ...openOf(current, key, fileRefOf(text)) }
}

function openOf(current: State, key: string, file: FileRef | null): Pick<ErrorRow, 'open' | 'opening' | 'result'> {
  return { open: file ? () => void openFile(key, file) : null, opening: current.opening.has(key), result: current.opened.get(key) ?? null }
}

async function loadView(): Promise<void> {
  const current = state
  if (!current) return
  const mine = ++viewSeq
  current.loading = true
  paint()
  try {
    const view = await orca.plugin.request('runs.view', current.ref)
    if (mine !== viewSeq || state !== current) return
    accept(current, view)
  } catch (error) {
    if (mine !== viewSeq || state !== current) return
    if (current.view) tell(current, messageOf(error), 'danger')
    else current.failure = messageOf(error)
  }
  current.loading = false
  paint()
  syncLog()
}

function accept(current: State, view: RunView): void {
  const before = logIdOf(current)
  current.view = view
  current.failure = null
  if (current.watch && view.updatedAt >= current.watch.at) current.watch = null
  if (!view.canCancel) current.cancelArmed = false
  current.selection = nextSelection(view, current.selection, current.pinned)
  if (logIdOf(current) !== before) resetLog(current)
  const pending = new Set(view.run.approvals.map(approval => approval.approvalId))
  for (const id of current.drafts.keys()) if (!pending.has(id)) current.drafts.delete(id)
}

function resetLog(current: State): void {
  current.buffer = null
  current.logError = null
  current.hitLine = null
  current.follow = true
}

function select(selection: Selection): void {
  const current = state
  if (!current) return
  current.pinned = true
  current.selection = selection
  if (current.buffer?.logId !== logIdOf(current)) resetLog(current)
  paint()
  syncLog()
}

function syncLog(): void {
  const current = state
  if (!current) return
  if (current.logBusy) {
    current.logAgain = true
    return
  }
  const record = recordOf(current)
  if (!record || record.logId === null) return
  if (current.buffer?.logId !== record.logId) return void readLog(current, record.logId, undefined)
  const next = nextRead(current.buffer, 'logLines' in record ? record.logLines : null, current.follow)
  if (next) void readLog(current, record.logId, next.first)
}

async function readLog(current: State, logId: number, first: number | undefined): Promise<void> {
  current.logBusy = true
  const before = current.buffer?.logId === logId ? lastLine(current.buffer) : null
  let progressed = false
  const { org, projectId, buildId } = current.ref
  try {
    const chunk = await orca.plugin.request('runs.log', first === undefined ? { org, projectId, buildId, logId } : { org, projectId, buildId, logId, first })
    if (state !== current || logIdOf(current) !== logId) return
    const buffer = appendChunk(current.buffer?.logId === logId ? current.buffer : null, chunk)
    progressed = before === null || lastLine(buffer) > before
    current.buffer = buffer
    current.logError = null
  } catch (error) {
    if (state !== current || logIdOf(current) !== logId) return
    current.logError = messageOf(error)
  } finally {
    const again = current.logAgain
    current.logBusy = false
    current.logAgain = false
    if (state === current) {
      paint()
      if (progressed || again || logIdOf(current) !== logId) syncLog()
    }
  }
}

async function loadEarlier(): Promise<void> {
  const current = state
  const buffer = current?.buffer
  const start = buffer ? earlierStart(buffer) : null
  if (!current || !buffer || start === null || current.logBusy) return
  current.follow = false
  const anchor = buffer.first
  await readLog(current, buffer.logId, start)
  if (state === current && current.buffer?.logId === buffer.logId) scrollToLine(anchor)
}

function search(query: string): void {
  const current = state
  if (!current) return
  current.query = query
  current.hitLine = null
  paintLog(current)
  const first = nextHit(hits, null, 1)
  if (first !== null) showHit(current, first)
}

function stepHit(direction: 1 | -1): void {
  const current = state
  if (!current) return
  const target = nextHit(hits, current.hitLine, direction)
  if (target !== null) showHit(current, target)
}

function showHit(current: State, n: number): void {
  current.hitLine = n
  current.follow = false
  paintLog(current)
  scrollToLine(n)
}

function jumpTo(n: number): void {
  const current = state
  if (!current) return
  current.hitLine = n
  current.follow = false
  paint()
  scrollToLine(n)
  log.node.scrollIntoView({ block: 'nearest' })
}

function toggleErrorsOnly(): void {
  if (!state) return
  state.errorsOnly = !state.errorsOnly
  paintLog(state)
  if (state.hitLine !== null && !state.follow) scrollToLine(state.hitLine)
}

function toggleFollow(): void {
  if (!state) return
  state.follow = !state.follow
  paintLog(state)
  if (state.follow) syncLog()
}

function stopFollowing(): void {
  if (!state?.follow) return
  state.follow = false
  paintLog(state)
}

function approvalHandlers(approvalId: string, projectId: string) {
  return {
    start(decision: Decision) {
      if (!state) return
      state.drafts.set(approvalId, { decision, comment: '', busy: false })
      paint()
      restoreFocus(approvalsSlot, { key: `comment:${approvalId}`, start: null, end: null })
    },
    comment(value: string) {
      const draft = state?.drafts.get(approvalId)
      if (draft) draft.comment = value
    },
    confirm: () => void decide(approvalId, projectId),
    cancel() {
      if (!state) return
      state.drafts.delete(approvalId)
      paint()
    }
  }
}

async function decide(approvalId: string, projectId: string): Promise<void> {
  const current = state
  const draft = current?.drafts.get(approvalId)
  if (!current || !draft || draft.busy) return
  draft.busy = true
  paint()
  try {
    const result = await orca.plugin.request('runs.decide', { org: current.ref.org, projectId, approvalId, decision: draft.decision, comment: draft.comment })
    told(current, result)
    if (result.ok) current.drafts.delete(approvalId)
  } catch (error) {
    tell(current, messageOf(error), 'danger')
  }
  draft.busy = false
  if (state === current) paint()
}

async function act(name: string, work: (current: State, view: RunView) => Promise<void>): Promise<void> {
  const current = state
  const view = current?.view
  if (!current || !view || current.busy.has(name)) return
  current.busy.add(name)
  current.banner = null
  paint()
  try {
    await work(current, view)
  } catch (error) {
    tell(current, messageOf(error), 'danger')
  }
  current.busy.delete(name)
  if (state === current) paint()
}

function watch(): Promise<void> {
  return act('watch', async (current, view) => {
    const value = !watchedOf(view, current.watch)
    await orca.plugin.request('runs.watch', { ...current.ref, watched: value })
    current.watch = { value, at: Date.now() }
  })
}

function rerun(): Promise<void> {
  return act('rerun', async (current, view) => {
    const target = rerunTarget(view, current.selection?.stageId ?? null)
    if (target) told(current, await orca.plugin.request('runs.retryStage', { ...current.ref, stageId: target.id }))
  })
}

function cancel(): Promise<void> {
  const current = state
  if (!current?.view?.canCancel) return Promise.resolve()
  if (!current.cancelArmed) {
    current.cancelArmed = true
    paint()
    return Promise.resolve()
  }
  current.cancelArmed = false
  return act('cancel', async now => told(now, await orca.plugin.request('runs.cancel', now.ref)))
}

function disarm(): void {
  if (!state?.cancelArmed || state.busy.has('cancel')) return
  state.cancelArmed = false
  paint()
}

function openInAdo(): void {
  const shell = orca.shell
  const url = state?.view?.run.url
  if (!shell || !url) return
  void act('open', async current => {
    const result = await shell.openExternal(url)
    if (!result.opened && result.reason === 'consent-unavailable') tell(current, OPEN_LINK_UNAVAILABLE, 'danger')
  })
}

async function openFile(key: string, file: FileRef): Promise<void> {
  const current = state
  if (!current || current.opening.has(key)) return
  current.opening.add(key)
  current.opened.delete(key)
  paint()
  try {
    current.opened.set(key, openedText(await orca.plugin.request('runs.openFile', { ...current.ref, path: file.path, line: file.line })))
  } catch (error) {
    current.opened.set(key, messageOf(error))
  }
  current.opening.delete(key)
  if (state === current) paint()
}

function report(ref: RunRef, visibleNow: boolean): void {
  orca.plugin
    .request('ui.visibility', { surface: 'run', org: ref.org, visible: visibleNow, run: { projectId: ref.projectId, buildId: ref.buildId } })
    .catch(() => {})
}

function reportVisibility(): void {
  const next = state?.ref ?? null
  if (reported && !sameRun(reported, next)) report(reported, false)
  if (next) report(next, document.visibilityState === 'visible')
  reported = next
}

function sameRun(a: RunRef, b: RunRef | null): boolean {
  return b !== null && a.org === b.org && a.projectId === b.projectId && a.buildId === b.buildId
}

function openRef(ref: RunRef): void {
  state = {
    ref,
    view: null,
    failure: null,
    loading: false,
    selection: null,
    pinned: false,
    buffer: null,
    logError: null,
    logBusy: false,
    logAgain: false,
    follow: true,
    errorsOnly: false,
    query: '',
    hitLine: null,
    banner: null,
    busy: new Set(),
    cancelArmed: false,
    watch: null,
    drafts: new Map(),
    opened: new Map(),
    opening: new Set()
  }
  root.replaceChildren(toolbar.node, banner, note, body)
  reportVisibility()
  void loadView()
}

function openText(text: string): void {
  if (text === shownText) return
  shownText = text
  const ref = parseRunRef(text)
  if (ref) return openRef(ref)
  state = null
  reportVisibility()
  root.replaceChildren(el('p', 'muted pad', NOT_A_RUN))
}

function textOf(doc: EditorDocument): string {
  return doc.content.kind === 'text' ? doc.content.text : ''
}

function applyTheme(colorScheme: 'light' | 'dark'): void {
  document.documentElement.style.colorScheme = colorScheme
}

async function start(): Promise<void> {
  applyTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  orca.on('theme', theme => applyTheme(theme.colorScheme))
  orca.plugin.on('runs.viewChanged', change => {
    if (state && change.org === state.ref.org && change.buildId === state.ref.buildId) void loadView()
  })
  document.addEventListener('visibilitychange', () => {
    reportVisibility()
    if (document.visibilityState === 'visible') void loadView()
  })
  window.addEventListener('pagehide', () => {
    if (reported) report(reported, false)
  })
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return
    reportVisibility()
    void loadView()
  })
  const doc = orca.document
  if (!doc) {
    root.replaceChildren(el('p', 'muted pad', EDITOR_ONLY))
    return
  }
  const first = await doc.get().catch(() => null)
  if (first) openText(textOf(first))
  else root.replaceChildren(el('p', 'muted pad', READ_FAILED))
  doc.onDidChange(next => openText(textOf(next)))
}

void start()
