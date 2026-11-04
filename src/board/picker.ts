import type { OrgStatus } from '../shared/types'
import type { BoardRef } from './ref'
import { button, el } from './render'

const NO_ORGS = 'Connect an organization in the Azure DevOps panel first.'
const NO_BOARDS = "Pick a boards project and team in this org's settings."

export function showPicker(root: HTMLElement, messageOf: (error: unknown) => string, picked: (ref: BoardRef) => void): void {
  const form = el('div', 'picker')
  const status = el('p', 'muted')
  status.setAttribute('role', 'status')
  const orgSelect = el('select')
  orgSelect.setAttribute('aria-label', 'Organization')
  const boardSelect = el('select')
  boardSelect.setAttribute('aria-label', 'Board')
  const open = button('Open board', () => {
    const org = orgs.find(entry => entry.org === orgSelect.value)
    if (org?.boards && boardSelect.value) {
      picked({ org: org.org, projectId: org.boards.projectId, teamId: org.boards.teamId, boardId: boardSelect.value })
    }
  })
  const retry = button('Try again', () => void loadOrgs(), 'button secondary')
  let orgs: OrgStatus[] = []
  let seq = 0

  form.append(el('h1', '', 'Open an Azure DevOps board'), labelled('Organization', orgSelect), labelled('Board', boardSelect), open, status, retry)
  root.replaceChildren(form)

  function say(text: string, canRetry = false): void {
    status.textContent = text
    retry.hidden = !canRetry
  }

  function boardsUnavailable(text: string, canRetry = false): void {
    boardSelect.replaceChildren()
    boardSelect.disabled = true
    open.disabled = true
    say(text, canRetry)
  }

  async function loadBoards(): Promise<void> {
    const mine = ++seq
    const org = orgs.find(entry => entry.org === orgSelect.value)
    if (!org?.boards) return boardsUnavailable(NO_BOARDS)
    boardsUnavailable('Loading boards…')
    try {
      const boards = await orca.plugin.request('work.boards', { org: org.org, projectId: org.boards.projectId, teamId: org.boards.teamId })
      if (mine !== seq) return
      if (boards.length === 0) return boardsUnavailable(`${org.boards.teamName} has no boards.`)
      boardSelect.replaceChildren(...boards.map(board => new Option(board.name, board.id)))
      boardSelect.disabled = false
      open.disabled = false
      say(`${org.boards.projectName} · ${org.boards.teamName}`)
    } catch (error) {
      if (mine === seq) boardsUnavailable(messageOf(error), true)
    }
  }

  async function loadOrgs(): Promise<void> {
    orgSelect.disabled = true
    boardsUnavailable('Loading organizations…')
    try {
      orgs = (await orca.plugin.request('orgs.list', {})).filter(org => org.state === 'connected')
    } catch (error) {
      return boardsUnavailable(messageOf(error), true)
    }
    if (orgs.length === 0) return boardsUnavailable(NO_ORGS, true)
    orgSelect.replaceChildren(...orgs.map(org => new Option(org.org, org.org)))
    orgSelect.disabled = false
    await loadBoards()
  }

  orgSelect.addEventListener('change', () => void loadBoards())
  void loadOrgs()
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const label = el('label', 'field')
  label.append(el('span', '', text), control)
  return label
}
