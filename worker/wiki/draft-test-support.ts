import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { assert } from 'orca/testing'
import { AdoError } from '../ado/http'

const OUTSIDE = 'The wiki draft folder leads outside this workspace, so nothing was written.'

export function outside(label: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `${label}: expected an AdoError, got ${String(error)}`)
    assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, OUTSIDE], label)
    return true
  }
}

export function inUse(label: string, taken: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof AdoError, `${label}: expected an AdoError, got ${String(error)}`)
    const message = `Can't create a draft for this page because ${taken} in .orca-ado/wiki is already in use. Publish or discard the drafts there first.`
    assert.deepEqual([error.code, error.status, error.message], ['bad_request', 400, message], label)
    return true
  }
}

export async function listing(dir: string, prefix = ''): Promise<string[]> {
  const entries: string[] = []
  for (const name of (await fs.readdir(dir)).sort()) {
    const full = path.join(dir, name)
    const stat = await fs.lstat(full)
    if (stat.isDirectory()) entries.push(`${prefix}${name}/`, ...(await listing(full, `${prefix}${name}/`)))
    else if (stat.isSymbolicLink()) entries.push(`${prefix}${name} -> ${await fs.readlink(full)}`)
    else entries.push(`${prefix}${name}: ${await fs.readFile(full, 'utf8')}`)
  }
  return entries
}
