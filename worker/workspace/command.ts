export const MAX_COMMAND_BYTES = 1000
export const MAX_PROMPT_BYTES = 100_000
export const START_FILES_FOLDER = '.orca-azure-devops/starts'
export const NEW_REPO_SETUP: 'skip' | 'policy' = 'skip'
export const PATH_CONTROL = /[\u0000-\u001F\u007F-\u009F]/

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PLAIN_WORD = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/
const FILE_ID = /^[0-9a-f]{24}$/
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g
const IDENTITY = 'identity:'

export interface Prompts { full: string; short: string }

export interface StartCommand { command: string; files: Record<string, string>; shortened: boolean }

type Field = 'branch' | 'agent' | 'worktree' | 'prompt' | 'url' | 'folder' | 'repo'

type Value = (field: Field, text?: string) => string

export function validAgent(agent: string): boolean {
  return AGENT_NAME.test(agent)
}

export function createCommand({ fileId, branch, agent, prompts }: { fileId: string; branch: string; agent: string; prompts: Prompts }): StartCommand | null {
  return assemble(fileId, prompts, value => `orca worktree create --name ${value('branch', branch)} --branch ${value('branch', branch)} --agent ${value('agent', agent)} --prompt ${value('prompt')} --no-parent --activate`)
}

export function launchCommand({ fileId, workspaceId, agent, prompts }: { fileId: string; workspaceId: string; agent: string; prompts: Prompts }): StartCommand | null {
  const selector = workspaceId.startsWith(IDENTITY) ? workspaceId : `id:${workspaceId}`
  return assemble(fileId, prompts, value => `orca agent launch --agent ${value('agent', agent)} --worktree ${value('worktree', selector)} --prompt ${value('prompt')} --focus`)
}

export function cloneCommand({ fileId, url, folder, branch, agent, prompts }: { fileId: string; url: string | null; folder: string; branch: string; agent: string; prompts: Prompts }): StartCommand | null {
  for (const [field, text] of Object.entries({ url: url ?? '', folder })) {
    if (PATH_CONTROL.test(text)) throw new Error(`A clone ${field} can't hold a control character: ${JSON.stringify(text)}`)
  }
  const setup = NEW_REPO_SETUP === 'skip' ? ' --setup skip' : ''
  return assemble(fileId, prompts, (value, file) => {
    const fetch = url === null ? '' : `GIT_ALLOW_PROTOCOL=https:ssh command git clone -- ${file('url', url)} ${file('folder', folder)} && `
    return `${fetch}orca repo add --path ${file('folder', folder)} && orca worktree create --repo ${file('repo', `path:${folder}`)} --name ${value('branch', branch)} --branch ${value('branch', branch)} --agent ${value('agent', agent)} --prompt ${value('prompt')}${setup} --no-parent --activate`
  })
}

function assemble(fileId: string, prompts: Prompts, orca: (value: Value, file: Value) => string): StartCommand | null {
  if (!FILE_ID.test(fileId)) throw new Error(`Not a start file id: ${JSON.stringify(fileId)}`)
  const full = promptText(prompts.full)
  const shortened = Buffer.byteLength(full) > MAX_PROMPT_BYTES
  const prompt = shortened ? promptText(prompts.short) : full
  const files: Record<string, string> = {}
  const reads: string[] = []
  const file: Value = (field, text = prompt) => {
    const name = `${fileId}.${field}`
    if (!(name in files)) reads.push(`ado_${field}=$(command cat ~/${START_FILES_FOLDER}/${name}) && `)
    files[name] = text
    return `"$ado_${field}"`
  }
  const line = orca((field, text = prompt) => (PLAIN_WORD.test(text) ? text : file(field, text)), file)
  const command = `${reads.join('')}${line} && exit`
  return Buffer.byteLength(command) <= MAX_COMMAND_BYTES ? { command, files, shortened } : null
}

function promptText(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\n+$/, '')
}
