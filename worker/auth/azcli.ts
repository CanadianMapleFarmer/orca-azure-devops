import * as path from 'node:path'
import { isValidOrgName } from '../ado/org'
import type { RunCommand } from '../sys/run'

export const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
export const NOT_SIGNED_IN = 'Not signed in.'

const PROFILE_ROOT = ['.orca-azure-devops', 'az']
const PROFILE_MODE = 0o700
const TOKEN_TIMEOUT_MS = 60_000
const TOKEN_FAILED = 'Azure CLI could not get an access token'
const JWT_LIKE = /eyJ[\w-]*(?:\.[\w-]*)*/g
const DETAIL_LINE = /AADSTS\d+|ERROR:/
const AZ_SUGGESTION = /^az |az login/

export interface AzProfiles {
  profileDir(org: string): string
  hasProfile(org: string): Promise<boolean>
  signOut(org: string): Promise<void>
}

export interface AzCliProvider extends AzProfiles {
  login(org: string, tenantId: string | null, signal?: AbortSignal): Promise<void>
  getToken(org: string, tenantId: string | null): Promise<{ token: string; expiresAt: number }>
}

export function createAzProfiles(deps: { home: string; fs: Pick<typeof import('node:fs/promises'), 'rm' | 'stat'> }): AzProfiles {
  function profileDir(org: string): string {
    if (!isValidOrgName(org)) throw new Error('Invalid organisation name')
    return path.join(deps.home, ...PROFILE_ROOT, org)
  }

  return {
    profileDir,

    async hasProfile(org) {
      try {
        return (await deps.fs.stat(profileDir(org))).isDirectory()
      } catch {
        return false
      }
    },

    async signOut(org) {
      await deps.fs.rm(profileDir(org), { recursive: true, force: true })
    }
  }
}

export function createAzCliProvider(deps: {
  azPath: string
  run: RunCommand
  home: string
  fs: Pick<typeof import('node:fs/promises'), 'mkdir' | 'rm' | 'chmod' | 'stat'>
}): AzCliProvider {
  const { azPath, run, home, fs } = deps
  const { profileDir, hasProfile, signOut } = createAzProfiles({ home, fs })

  function azEnv(dir: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    return {
      ...env,
      AZURE_CONFIG_DIR: dir,
      AZURE_CORE_COLLECT_TELEMETRY: 'false',
      AZURE_CORE_ONLY_SHOW_ERRORS: 'true'
    }
  }

  return {
    profileDir,
    hasProfile,

    async login(org, tenantId, signal) {
      const dir = profileDir(org)
      await fs.mkdir(dir, { recursive: true, mode: PROFILE_MODE })
      await fs.chmod(dir, PROFILE_MODE)
      const args = ['login', ...tenantArgs(tenantId), '--allow-no-subscriptions', '--output', 'none']
      const result = await run(azPath, args, { env: azEnv(dir), signal })
      if (result.code !== 0) throw failure('Azure CLI sign-in failed', result.stderr)
    },

    async getToken(org, tenantId) {
      const dir = profileDir(org)
      if (!(await hasProfile(org))) throw new Error(NOT_SIGNED_IN)
      const args = ['account', 'get-access-token', '--resource', ADO_RESOURCE, ...tenantArgs(tenantId), '--output', 'json']
      const result = await run(azPath, args, { env: azEnv(dir), timeoutMs: TOKEN_TIMEOUT_MS }).catch((error: unknown) => {
        throw new Error(TOKEN_FAILED, { cause: error })
      })
      if (result.code !== 0) throw failure(TOKEN_FAILED, result.stderr)
      const token = parseToken(result.stdout)
      if (!token) throw new Error('Azure CLI returned an unreadable token response')
      return token
    },

    signOut
  }
}

function tenantArgs(tenantId: string | null): string[] {
  return tenantId ? ['--tenant', tenantId] : []
}

function parseToken(stdout: string): { token: string; expiresAt: number } | null {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { accessToken, expires_on: expiresOn } = body as { accessToken?: unknown; expires_on?: unknown }
  if (typeof accessToken !== 'string' || !accessToken) return null
  if (typeof expiresOn !== 'number' || !Number.isFinite(expiresOn)) return null
  return { token: accessToken, expiresAt: expiresOn * 1000 }
}

function failure(sentence: string, stderr: string): Error {
  const detail = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => DETAIL_LINE.test(line) && !AZ_SUGGESTION.test(line))
  return new Error(detail ? `${sentence}: ${detail.replace(JWT_LIKE, '[redacted]')}` : sentence)
}
