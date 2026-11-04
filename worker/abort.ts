export function linkedAbort(parent: AbortSignal): { signal: AbortSignal; release(): void } {
  const child = new AbortController()
  const follow = () => child.abort(parent.reason)
  if (parent.aborted) follow()
  else parent.addEventListener('abort', follow, { once: true })
  return { signal: child.signal, release: () => parent.removeEventListener('abort', follow) }
}
