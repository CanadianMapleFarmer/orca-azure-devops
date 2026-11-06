import { AdoError } from './http'

export function expectText(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected text')
  return value
}

export function expectId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('expected an id')
  return value
}

export function expectList<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new TypeError('expected a list')
  return value
}

const MALFORMED_STATUS = 200

export function malformed(message: string): never {
  throw new AdoError('server', MALFORMED_STATUS, message)
}

export function isMalformed(error: unknown): boolean {
  return error instanceof AdoError && error.code === 'server' && error.status === MALFORMED_STATUS
}

export function shaped<T>(build: () => T, message: string): T {
  try {
    return build()
  } catch {
    return malformed(message)
  }
}
