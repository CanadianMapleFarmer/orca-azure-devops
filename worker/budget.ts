export const POST_BUDGET_BYTES = 240 * 1024

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export function itemBytes(item: unknown): number {
  return byteLength(item) + 1
}

export function newestThatFit<T>(items: T[], budget: number, at: (item: T) => number, maxItems = Infinity): Set<T> {
  const kept = new Set<T>()
  for (const item of [...items].sort((a, b) => at(b) - at(a))) {
    budget -= itemBytes(item)
    if (kept.size === maxItems || budget < 0) break
    kept.add(item)
  }
  return kept
}
