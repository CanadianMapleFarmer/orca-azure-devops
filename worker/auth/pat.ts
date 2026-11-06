import { isValidOrgName } from '../ado/org'
import { INVALID_ORG_NAME } from '../messages'

export interface SecretsPort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export function patKey(org: string): string {
  if (!isValidOrgName(org)) throw new Error(INVALID_ORG_NAME)
  return `pat:${org}`
}

export function basicAuth(pat: string): string {
  return `Basic ${btoa(`:${pat}`)}`
}

export function createPatProvider(secrets: SecretsPort): {
  save(org: string, pat: string): Promise<void>
  header(org: string): Promise<string | null>
  forget(org: string): Promise<void>
} {
  return {
    async save(org, pat) {
      const key = patKey(org)
      const trimmed = pat.trim()
      if (!trimmed) throw new Error('Paste a personal access token.')
      await secrets.set(key, trimmed)
    },

    async header(org) {
      const pat = await secrets.get(patKey(org))
      return pat ? basicAuth(pat) : null
    },

    async forget(org) {
      await secrets.delete(patKey(org))
    }
  }
}
