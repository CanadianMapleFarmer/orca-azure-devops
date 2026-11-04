import type { StorePort } from './connections'

export async function drain(turns = 100): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

export function memoryStore(initial: Record<string, unknown> = {}): { data: Record<string, unknown>; store: StorePort } {
  const data: Record<string, unknown> = { ...initial }
  const store: StorePort = {
    get: async <T,>(key: string) => (key in data ? (structuredClone(data[key]) as T) : null),
    set: async (key, value) => {
      data[key] = structuredClone(value)
    }
  }
  return { data, store }
}
