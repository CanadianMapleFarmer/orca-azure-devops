import { dropTarget, type Rect } from './dnd'
import type { Cell } from './layout'

export interface DragHandlers {
  canDrag(id: number): boolean
  accepts(id: number, cell: Cell): boolean
  drop(id: number, cell: Cell | null): void
  pressed(id: number): void
  ended(): void
}

interface Drag {
  id: number
  card: HTMLElement
  pointerId: number
  start: { x: number; y: number }
  offset: { x: number; y: number }
  ghost: HTMLElement | null
  cells: (Cell & { rect: Rect; node: HTMLElement })[]
  over: HTMLElement | null
}

const THRESHOLD_PX = 4

export function attachDrag(scroller: HTMLElement, handlers: DragHandlers): { dragging(): boolean } {
  let drag: Drag | null = null

  function measure(): Drag['cells'] {
    return [...scroller.querySelectorAll<HTMLElement>('.cell')].map(node => {
      const { left, top, width, height } = node.getBoundingClientRect()
      return { column: node.dataset.column ?? '', lane: node.dataset.lane ?? '', rect: { left, top, width, height }, node }
    })
  }

  function begin(current: Drag): void {
    const ghost = current.card.cloneNode(true) as HTMLElement
    ghost.classList.add('ghost')
    ghost.style.width = `${current.card.getBoundingClientRect().width}px`
    ghost.removeAttribute('tabindex')
    ghost.setAttribute('aria-hidden', 'true')
    document.body.append(ghost)
    current.ghost = ghost
    current.cells = measure()
    current.card.classList.add('dragging')
  }

  function hover(current: Drag, point: { x: number; y: number }): void {
    if (!current.ghost) return
    current.ghost.style.left = `${point.x - current.offset.x}px`
    current.ghost.style.top = `${point.y - current.offset.y}px`
    const cell = dropTarget(point, current.cells)
    const over = cell && handlers.accepts(current.id, cell) ? (current.cells.find(entry => entry.column === cell.column && entry.lane === cell.lane)?.node ?? null) : null
    if (over === current.over) return
    current.over?.classList.remove('drop')
    over?.classList.add('drop')
    current.over = over
  }

  function end(current: Drag, release: { x: number; y: number } | null): void {
    drag = null
    current.ghost?.remove()
    current.over?.classList.remove('drop')
    current.card.classList.remove('dragging')
    if (current.card.hasPointerCapture(current.pointerId)) current.card.releasePointerCapture(current.pointerId)
    if (release && current.ghost) handlers.drop(current.id, dropTarget(release, current.cells))
    else if (release) handlers.pressed(current.id)
    handlers.ended()
  }

  function finish(event: PointerEvent, commit: boolean): void {
    const current = drag
    if (!current || event.pointerId !== current.pointerId) return
    end(current, commit ? { x: event.clientX, y: event.clientY } : null)
  }

  scroller.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return
    const card = (event.target as Element).closest<HTMLElement>('.card')
    if (!card) return
    const id = Number(card.dataset.id)
    const box = card.getBoundingClientRect()
    drag = {
      id,
      card,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      offset: { x: event.clientX - box.left, y: event.clientY - box.top },
      ghost: null,
      cells: [],
      over: null
    }
    card.setPointerCapture(event.pointerId)
  })

  scroller.addEventListener('pointermove', event => {
    const current = drag
    if (!current || event.pointerId !== current.pointerId) return
    if (!current.ghost) {
      if (Math.hypot(event.clientX - current.start.x, event.clientY - current.start.y) < THRESHOLD_PX) return
      if (!handlers.canDrag(current.id)) return end(current, null)
      begin(current)
    }
    hover(current, { x: event.clientX, y: event.clientY })
  })

  scroller.addEventListener('pointerup', event => finish(event, true))
  scroller.addEventListener('pointercancel', event => finish(event, false))
  scroller.addEventListener('lostpointercapture', event => finish(event, false))
  scroller.addEventListener('scroll', () => {
    if (drag?.ghost) drag.cells = measure()
  })

  return { dragging: () => drag !== null }
}
