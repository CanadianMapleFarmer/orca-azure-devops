import { execFile } from 'node:child_process'
import * as path from 'node:path'

const MAX_BUFFER_BYTES = 16 * 1024 * 1024

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

export const runCommand: RunCommand = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr })
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr })
        if (typeof error.code === 'string') return reject(error)
        const name = path.basename(file)
        if (error.killed) return reject(new Error(`${name} timed out after ${opts.timeoutMs}ms`))
        reject(new Error(`${name} was terminated by ${error.signal}`))
      }
    )
  })
