import { AdoError } from './http'

export function expectText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected text')
  return value
}

export function expectList<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new TypeError('expected a list')
  return value
}

export function malformed(message: string): never {
  throw new AdoError('server', 200, message)
}

export function shaped<T>(build: () => T, message: string): T {
  try {
    return build()
  } catch {
    return malformed(message)
  }
}
