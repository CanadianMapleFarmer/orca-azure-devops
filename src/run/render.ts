import { button, el } from '../board/render'
import type { ApprovalSummary, JobView, StageView, StepState, StepView } from '../shared/pipelines'
import { STEP_GLYPH } from '../shared/runs'
import { ansiSpans } from './ansi'
import type { LogLine } from './log-model'
import { countsText, durationText } from './view-state'

export { button, el }

export type Tone = 'danger' | 'warning' | 'info'
export type Decision = 'approved' | 'rejected'

export interface ToolbarModel {
  title: string
  subtitle: string
  state: string
  stateTone: string
  loading: boolean
  watched: boolean
  watchDisabled: boolean
  rerun: boolean
  cancel: 'hidden' | 'ready' | 'armed'
  busy: ReadonlySet<string>
  openable: boolean
}

export interface DraftView {
  decision: Decision
  comment: string
  busy: boolean
}

export interface ErrorRow {
  key: string
  text: string
  jump: (() => void) | null
  open: (() => void) | null
  opening: boolean
  result: string | null
}

export interface FailureModel {
  key: string
  path: string
  select: () => void
  issues: ErrorRow[]
  lines: ErrorRow[]
}

export interface LogControls {
  hits: string | null
  errorsOnly: boolean
  follow: boolean
  earlier: boolean
  busy: boolean
  info: string
  notice: string | null
  error: string | null
}

export interface RowModel {
  line: LogLine
  hit: boolean
  current: boolean
}

export interface FocusMark {
  key: string
  start: number | null
  end: number | null
}

const COMMENT_MAX = 1000
const COMMENT_LABEL = 'Comment (optional)'
const SHARE_HINT = 'To ask someone, use Share for approval in the Pipelines tab.'
const CONFIRM_TEXT: Record<Decision, string> = { approved: 'Approve', rejected: 'Reject' }

export function keyed<T extends HTMLElement>(node: T, key: string): T {
  node.dataset.key = key
  return node
}

export function focusMark(root: HTMLElement): FocusMark | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root.contains(active) || active.dataset.key === undefined) return null
  const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null
  return { key: active.dataset.key, start: field?.selectionStart ?? null, end: field?.selectionEnd ?? null }
}

export function restoreFocus(root: HTMLElement, mark: FocusMark | null): void {
  if (!mark) return
  const target = [...root.querySelectorAll<HTMLElement>('[data-key]')].find(node => node.dataset.key === mark.key)
  if (!target || target === document.activeElement) return
  target.focus({ preventScroll: true })
  if (target instanceof HTMLTextAreaElement && mark.start !== null) target.setSelectionRange(mark.start, mark.end ?? mark.start)
}

export function createToolbar(handlers: { watch(): void; rerun(): void; cancel(): void; disarm(): void; open(): void }) {
  const bar = el('header', 'toolbar')
  const heading = el('div', 'heading')
  const title = el('span', 'title')
  const subtitle = el('span', 'muted')
  heading.append(title, subtitle)
  const state = el('span', 'badge')
  const status = el('span', 'muted grow')
  const watch = button('Watch', handlers.watch, 'button secondary')
  const rerun = button('Rerun failed stage', handlers.rerun, 'button secondary')
  const cancel = button('Cancel run', handlers.cancel, 'button secondary')
  cancel.addEventListener('blur', handlers.disarm)
  const open = button('Open in Azure DevOps', handlers.open, 'button secondary')
  bar.append(heading, state, status, watch, rerun, cancel, open)
  return {
    node: bar,
    update(model: ToolbarModel): void {
      title.textContent = model.title
      subtitle.textContent = model.subtitle
      state.textContent = model.state
      state.className = `badge ${model.stateTone}`
      status.textContent = model.loading ? 'Loading…' : ''
      watch.textContent = model.watched ? 'Stop watching' : 'Watch'
      watch.setAttribute('aria-pressed', String(model.watched))
      watch.disabled = model.watchDisabled || model.busy.has('watch')
      rerun.hidden = !model.rerun
      rerun.disabled = model.busy.has('rerun')
      cancel.hidden = model.cancel === 'hidden'
      cancel.textContent = model.cancel === 'armed' ? 'Confirm cancel' : 'Cancel run'
      cancel.classList.toggle('danger', model.cancel === 'armed')
      cancel.disabled = model.busy.has('cancel')
      open.hidden = !model.openable
      open.disabled = model.busy.has('open')
    }
  }
}

export function stageStrip(stages: readonly StageView[], selected: string | null, now: number, onSelect: (stage: StageView) => void): HTMLElement {
  const strip = el('nav', 'stages')
  strip.setAttribute('aria-label', 'Stages')
  for (const stage of stages) {
    const node = keyed(button('', () => onSelect(stage), `stage state-${stage.state}`), `stage:${stage.id}`)
    node.setAttribute('aria-pressed', String(stage.id === selected))
    node.append(glyph(stage.state), el('span', 'name', stage.name), el('span', 'muted', durationText(stage.startedAt, stage.finishedAt, now)))
    strip.append(node)
  }
  return strip
}

export function stepList(stage: StageView | null, selected: string | null, now: number, onSelect: (record: StepView | JobView) => void): HTMLElement {
  const list = el('div', 'step-list')
  if (!stage) return list
  for (const job of stage.jobs) {
    const head = job.logId === null ? el('div', `job state-${job.state}`) : recordButton(job, 'job', selected, onSelect)
    head.append(glyph(job.state), el('span', 'name', job.name), el('span', 'muted', durationText(job.startedAt, job.finishedAt, now)))
    list.append(head)
    for (const step of job.steps) {
      const row = recordButton(step, 'step', selected, onSelect)
      row.append(glyph(step.state), el('span', 'name', step.name), el('span', 'muted', durationText(step.startedAt, step.finishedAt, now)))
      const counts = countsText(step.errorCount, step.warningCount)
      if (counts) row.append(el('span', step.errorCount > 0 ? 'counts error' : 'counts', counts))
      list.append(row)
    }
  }
  return list
}

function recordButton(record: StepView | JobView, kind: string, selected: string | null, onSelect: (record: StepView | JobView) => void): HTMLButtonElement {
  const node = keyed(button('', () => onSelect(record), `${kind} state-${record.state}`), `record:${record.id}`)
  node.setAttribute('aria-pressed', String(record.id === selected))
  return node
}

function glyph(state: StepState): HTMLElement {
  const node = el('span', 'glyph', STEP_GLYPH[state])
  node.setAttribute('aria-label', state)
  return node
}

export function approvalBlock(
  approval: ApprovalSummary,
  text: string,
  draft: DraftView | null,
  handlers: { start(decision: Decision): void; comment(value: string): void; confirm(): void; cancel(): void }
): HTMLElement {
  const block = el('section', 'approval')
  block.append(el('p', '', text))
  const key = approval.approvalId
  if (approval.canApprove && !draft) {
    const actions = el('div', 'actions')
    actions.append(
      keyed(button('Approve…', () => handlers.start('approved'), 'button secondary'), `approve:${key}`),
      keyed(button('Reject…', () => handlers.start('rejected'), 'button secondary'), `reject:${key}`)
    )
    block.append(actions)
  }
  if (approval.canApprove && draft) {
    const comment = keyed(el('textarea', 'comment'), `comment:${key}`)
    comment.maxLength = COMMENT_MAX
    comment.rows = 2
    comment.placeholder = COMMENT_LABEL
    comment.setAttribute('aria-label', COMMENT_LABEL)
    comment.value = draft.comment
    comment.disabled = draft.busy
    comment.addEventListener('input', () => handlers.comment(comment.value))
    const confirm = keyed(button(CONFIRM_TEXT[draft.decision], handlers.confirm, draft.decision === 'approved' ? 'button' : 'button danger'), `confirm:${key}`)
    confirm.disabled = draft.busy
    const cancel = keyed(button('Cancel', handlers.cancel, 'button secondary'), `cancel:${key}`)
    cancel.disabled = draft.busy
    const actions = el('div', 'actions')
    actions.append(confirm, cancel)
    block.append(comment, actions)
  }
  block.append(el('p', 'muted', SHARE_HINT))
  return block
}

export function errorSummary(failures: readonly FailureModel[]): HTMLElement {
  const section = el('section', 'errors')
  section.setAttribute('aria-label', 'Errors')
  section.append(el('h2', '', 'Errors'))
  for (const failure of failures) {
    const block = el('div', 'failure')
    block.append(keyed(button(failure.path, failure.select, 'link'), `failure:${failure.key}`))
    const list = el('ul', 'error-rows')
    list.append(...failure.issues.map(row => errorRow(row, 'issue')), ...failure.lines.map(row => errorRow(row, 'line')))
    block.append(list)
    section.append(block)
  }
  return section
}

function errorRow(row: ErrorRow, kind: string): HTMLElement {
  const item = el('li', `error-row ${kind}`)
  item.append(el('span', 'error-text', row.text))
  if (row.jump) item.append(keyed(button('Jump to line', row.jump, 'button secondary small'), `jump:${row.key}`))
  if (row.open) {
    const open = keyed(button('Open in Orca', row.open, 'button secondary small'), `open:${row.key}`)
    open.disabled = row.opening
    item.append(open)
  }
  if (row.result) item.append(el('span', 'muted result', row.result))
  return item
}

export function createLogView(handlers: {
  search(query: string): void
  step(direction: 1 | -1): void
  errorsOnly(): void
  follow(): void
  earlier(): void
  scrolled(): void
  leftEnd(): void
}) {
  const section = el('section', 'log')
  section.setAttribute('aria-label', 'Log')
  const bar = el('div', 'log-bar')
  const search = el('input', 'search')
  search.type = 'search'
  search.placeholder = 'Search the log'
  search.setAttribute('aria-label', 'Search the log')
  search.addEventListener('input', () => handlers.search(search.value))
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    handlers.step(event.shiftKey ? -1 : 1)
  })
  const hits = el('span', 'muted')
  hits.setAttribute('aria-live', 'polite')
  const errorsOnly = button('Errors only', handlers.errorsOnly, 'toggle')
  const follow = button('Follow', handlers.follow, 'toggle')
  const earlier = button('Load earlier', handlers.earlier, 'button secondary small')
  const info = el('span', 'muted grow')
  bar.append(search, hits, errorsOnly, follow, earlier, info)
  const notice = el('p', 'log-notice muted')
  const failure = el('p', 'log-notice error')
  const scroller = el('div', 'log-scroller')
  scroller.tabIndex = 0
  scroller.setAttribute('role', 'log')
  scroller.setAttribute('aria-label', 'Log lines')
  const spacer = el('div', 'log-spacer')
  const rows = el('div', 'log-rows')
  spacer.append(rows)
  scroller.append(spacer)
  scroller.addEventListener('scroll', handlers.scrolled)
  scroller.addEventListener('wheel', event => {
    if (event.deltaY < 0) handlers.leftEnd()
  })
  scroller.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') handlers.leftEnd()
  })
  section.append(bar, notice, failure, scroller)
  return {
    node: section,
    scroller,
    update(model: LogControls): void {
      hits.textContent = model.hits ?? ''
      errorsOnly.setAttribute('aria-pressed', String(model.errorsOnly))
      follow.setAttribute('aria-pressed', String(model.follow))
      earlier.hidden = !model.earlier
      earlier.disabled = model.busy
      info.textContent = model.info
      notice.textContent = model.notice ?? ''
      notice.hidden = model.notice === null
      failure.textContent = model.error ?? ''
      failure.hidden = model.error === null
      scroller.hidden = model.notice !== null
    },
    paintRows(items: readonly RowModel[], offset: number, height: number): void {
      spacer.style.height = `${height}px`
      rows.style.transform = `translateY(${offset}px)`
      rows.replaceChildren(...items.map(logRow))
    }
  }
}

function logRow({ line, hit, current }: RowModel): HTMLElement {
  const row = el('div', `row kind-${line.kind}${hit ? ' hit' : ''}${current ? ' current' : ''}`)
  if (line.time) row.title = line.time
  const text = el('span', 'tx')
  for (const span of ansiSpans(line.text)) text.append(span.classes.length > 0 ? el('span', span.classes.join(' '), span.text) : document.createTextNode(span.text))
  row.append(el('span', 'ln', String(line.n)), text)
  return row
}
