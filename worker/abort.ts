import type { Clock } from './poll/scheduler'

export function linkedAbort(parent: AbortSignal): { signal: AbortSignal; release(): void } {
  const child = new AbortController()
  const follow = () => child.abort(parent.reason)
  if (parent.aborted) follow()
  else parent.addEventListener('abort', follow, { once: true })
  return { signal: child.signal, release: () => parent.removeEventListener('abort', follow) }
}

export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

export function within<T>(work: Promise<T>, ms: number, clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>): Promise<T> {
  const late = new AbortController()
  const timer = clock.setTimeout(() => late.abort(), ms)
  return untilAborted(work, late.signal).finally(() => clock.clearTimeout(timer))
}
