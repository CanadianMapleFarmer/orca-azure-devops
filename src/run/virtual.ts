const OVERSCAN = 20

export function windowOf(input: { scrollTop: number; viewport: number; rowHeight: number; count: number; overscan?: number }): {
  start: number
  end: number
  offset: number
} {
  const { viewport, rowHeight, count, overscan = OVERSCAN } = input
  const top = Math.max(0, input.scrollTop)
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil((top + Math.max(0, viewport)) / rowHeight)
  const start = clamp(first - overscan, 0, count)
  const end = clamp(last + overscan, start, count)
  return { start, end, offset: start * rowHeight }
}

export function scrollTopFor(index: number, rowHeight: number, viewport: number): number {
  return Math.max(0, Math.floor(index * rowHeight - (viewport - rowHeight) / 2))
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
