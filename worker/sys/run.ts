import { spawn } from 'node:child_process'
import * as path from 'node:path'
import type { Readable } from 'node:stream'

const MAX_BUFFER_BYTES = 16 * 1024 * 1024
const KILL_GRACE_MS = 3_000

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type RunCommand = (
  file: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }
) => Promise<RunResult>

export class CommandTimeoutError extends Error {}

type SignalGroup = (sig: NodeJS.Signals | 0) => boolean

const live = new Set<SignalGroup>()

export async function stopAllCommands(opts: { killAfterMs: number; withinMs: number }): Promise<void> {
  const groups = [...live]
  if (groups.length === 0) return
  const deadline = Date.now() + opts.withinMs
  for (const signalGroup of groups) signalGroup('SIGTERM')
  const kill = setTimeout(() => groups.forEach(signalGroup => signalGroup('SIGKILL')), opts.killAfterMs)
  while (groups.some(signalGroup => signalGroup(0)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  clearTimeout(kill)
}

export const runCommand: RunCommand = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const { signal, timeoutMs } = opts
    if (signal?.aborted) return reject(abortError(signal))
    const name = path.basename(file)
    const child = spawn(file, args, { env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stopped: Error | null = null
    let escalation: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const signalGroup: SignalGroup = sig => {
      if (child.pid === undefined) return false
      try {
        process.kill(-child.pid, sig)
        return true
      } catch {
        return false
      }
    }
    if (child.pid !== undefined) live.add(signalGroup)

    const stop = (reason: Error): void => {
      if (stopped) return
      stopped = reason
      signalGroup('SIGTERM')
      escalation = setTimeout(() => {
        signalGroup('SIGKILL')
        if (closed) live.delete(signalGroup)
      }, KILL_GRACE_MS)
    }

    const collect = (stream: Readable, label: string): (() => string) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BUFFER_BYTES) return stop(maxBufferError(label))
        chunks.push(chunk)
      })
      return () => Buffer.concat(chunks).toString('utf8')
    }

    const stdout = collect(child.stdout, 'stdout')
    const stderr = collect(child.stderr, 'stderr')
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop(new CommandTimeoutError(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
    const onAbort = () => stop(abortError(signal!))
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (): void => {
      closed = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (escalation && signalGroup(0)) return
      clearTimeout(escalation)
      live.delete(signalGroup)
    }

    child.once('error', error => {
      finish()
      reject(error)
    })
    child.once('close', (code, sig) => {
      finish()
      if (stopped) return reject(stopped)
      if (code !== null) return resolve({ code, stdout: stdout(), stderr: stderr() })
      reject(new Error(`${name} was terminated by ${sig}`))
    })
  })

function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
}

function maxBufferError(label: string): Error {
  return Object.assign(new RangeError(`${label} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
}
