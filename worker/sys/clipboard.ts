import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { COPY_FAILED, COPY_NEEDS_TOOL } from '../messages'

const COPY_TIMEOUT_MS = 10_000
const WAYLAND_SOCKET = /^wayland-(\d+)$/
const X11_SOCKET = '/tmp/.X11-unix/X0'

const MAC_SCRIPT = `ObjC.import('AppKit')
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
const input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
const pasteboard = $.NSPasteboard.generalPasteboard
pasteboard.clearContents
pasteboard.setStringForType($(input.html), 'public.html')
pasteboard.setStringForType($(input.plain), 'public.utf8-plain-text')
`

const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$content = [Console]::In.ReadToEnd() | ConvertFrom-Json
$data = New-Object System.Windows.Forms.DataObject
$data.SetData('HTML Format', $content.html)
$data.SetData('UnicodeText', $content.plain)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`

export type SpawnWithInput = (
  file: string,
  args: string[],
  opts: { input: string; env: Record<string, string>; timeoutMs: number }
) => Promise<{ code: number }>

export const spawnWithInput: SpawnWithInput = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const name = path.basename(file)
    const child = spawn(file, args, { env: opts.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(() => reject(new Error(`${name} timed out after ${opts.timeoutMs}ms`)))
    }, opts.timeoutMs)
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }

    child.once('error', error => settle(() => reject(error)))
    child.once('exit', (code, signal) =>
      settle(() => (code === null ? reject(new Error(`${name} was terminated by ${signal}`)) : resolve({ code })))
    )
    child.stdin?.on('error', ignoreBrokenPipe)
    child.stdin?.end(opts.input)
  })

function ignoreBrokenPipe(): void {}

export function cfHtml(fragment: string): string {
  const before = '<html><body><!--StartFragment-->'
  const after = '<!--EndFragment--></body></html>'
  const header = (startHtml: number, endHtml: number, startFragment: number, endFragment: number): string =>
    [
      'Version:0.9',
      `StartHTML:${pad(startHtml)}`,
      `EndHTML:${pad(endHtml)}`,
      `StartFragment:${pad(startFragment)}`,
      `EndFragment:${pad(endFragment)}`,
      ''
    ].join('\r\n')
  const startHtml = Buffer.byteLength(header(0, 0, 0, 0))
  const startFragment = startHtml + Buffer.byteLength(before)
  const endFragment = startFragment + Buffer.byteLength(fragment)
  const endHtml = endFragment + Buffer.byteLength(after)
  return header(startHtml, endHtml, startFragment, endFragment) + before + fragment + after
}

function pad(offset: number): string {
  return String(offset).padStart(10, '0')
}

export function linuxDisplayEnv(deps: {
  uid: number
  home: string
  exists: (path: string) => boolean
  list: (dir: string) => string[]
}): { kind: 'wayland' | 'x11'; env: Record<string, string> } | null {
  const runtimeDir = `/run/user/${deps.uid}`
  const socket = waylandSockets(deps.list, runtimeDir)[0]
  if (socket) return { kind: 'wayland', env: { XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: socket } }
  if (!deps.exists(X11_SOCKET)) return null
  const xauthority = `${deps.home}/.Xauthority`
  return { kind: 'x11', env: { DISPLAY: ':0', ...(deps.exists(xauthority) ? { XAUTHORITY: xauthority } : {}) } }
}

function waylandSockets(list: (dir: string) => string[], dir: string): string[] {
  let names: string[]
  try {
    names = list(dir)
  } catch {
    return []
  }
  return names
    .flatMap(name => {
      const number = WAYLAND_SOCKET.exec(name)?.[1]
      return number === undefined ? [] : [{ name, number: Number(number) }]
    })
    .sort((a, b) => a.number - b.number)
    .map(socket => socket.name)
}

export interface ClipboardDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  find: (name: string) => string | null
  spawn: SpawnWithInput
  uid: number
  home: string
  exists: (path: string) => boolean
  list: (dir: string) => string[]
}

export interface Clipboard {
  write(content: { html: string; plain: string }): Promise<'rich' | 'html'>
}

interface Plan {
  file: string
  args: string[]
  input: string
  env: Record<string, string>
  result: 'rich' | 'html'
}

export function createClipboard(deps: ClipboardDeps): Clipboard {
  return {
    async write(content) {
      const plan = planFor(deps, content)
      let exit: { code: number }
      try {
        exit = await deps.spawn(plan.file, plan.args, { input: plan.input, env: plan.env, timeoutMs: COPY_TIMEOUT_MS })
      } catch {
        throw new Error(COPY_FAILED)
      }
      if (exit.code !== 0) throw new Error(COPY_FAILED)
      return plan.result
    }
  }
}

function planFor(deps: ClipboardDeps, content: { html: string; plain: string }): Plan {
  switch (deps.platform) {
    case 'darwin':
      return {
        file: '/usr/bin/osascript',
        args: ['-l', 'JavaScript', '-e', MAC_SCRIPT],
        input: asciiJson(content),
        env: pick(deps.env, ['PATH', 'HOME', 'TMPDIR']),
        result: 'rich'
      }
    case 'win32':
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
        input: asciiJson({ html: cfHtml(content.html), plain: content.plain }),
        env: definedEnv(deps.env),
        result: 'rich'
      }
    case 'linux':
      return linuxPlan(deps, content.html)
    default:
      throw new Error(COPY_FAILED)
  }
}

function linuxPlan(deps: ClipboardDeps, html: string): Plan {
  const wlCopy = deps.find('wl-copy')
  const xclip = deps.find('xclip')
  if (!wlCopy && !xclip) throw new Error(COPY_NEEDS_TOOL)
  const display = linuxDisplayEnv(deps)
  if (!display) throw new Error(COPY_FAILED)
  const env = { ...definedEnv(deps.env), ...display.env }
  if (display.kind === 'wayland') {
    if (!wlCopy) throw new Error(COPY_NEEDS_TOOL)
    return { file: wlCopy, args: ['--type', 'text/html'], input: html, env, result: 'html' }
  }
  if (!xclip) throw new Error(COPY_NEEDS_TOOL)
  return { file: xclip, args: ['-selection', 'clipboard', '-t', 'text/html'], input: html, env, result: 'html' }
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const defined = definedEnv(env)
  return Object.fromEntries(names.filter(name => name in defined).map(name => [name, defined[name]]))
}
