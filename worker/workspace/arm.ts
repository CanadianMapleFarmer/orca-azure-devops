export const DEFAULT_BRANCH_TEMPLATE = 'feature/{id}-{slug}'

const ARMED_MS = 600_000
const CLAIM_MS = 30_000
const SLUG_MAX = 40

export interface ArmedBranch { org: string; itemId: number; branch: string }

export interface Arm {
  arm(armed: ArmedBranch): number
  take(): ArmedBranch | null
  claim(branch: string): ArmedBranch | null
}

function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '')
  return slug || 'item'
}

function validSegment(raw: string): string {
  let segment = raw.replace(/\.{2,}/g, '.').replace(/^[.-]+/, '')
  for (let previous = ''; previous !== segment; ) {
    previous = segment
    segment = segment.replace(/(\.lock)+$/, '').replace(/[.-]+$/, '')
  }
  return segment
}

function validRef(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._/-]+/g, '-').split('/').map(validSegment).filter(Boolean).join('/')
}

function expand(template: string, item: { id: number; title: string }): string {
  return validRef(template.split('{id}').join(String(item.id)).split('{slug}').join(slugOf(item.title)))
}

export function branchFor(template: string, item: { id: number; title: string }): string {
  return expand(template, item) || expand(DEFAULT_BRANCH_TEMPLATE, item)
}

export function createArm(now: () => number): Arm {
  let armed: { value: ArmedBranch; until: number } | null = null
  let taken: { value: ArmedBranch; at: number } | null = null
  return {
    arm(value) {
      armed = { value, until: now() + ARMED_MS }
      return armed.until
    },
    take() {
      const current = armed
      armed = null
      if (!current || now() >= current.until) return null
      taken = { value: current.value, at: now() }
      return current.value
    },
    claim(branch) {
      const current = taken
      if (!current || now() - current.at > CLAIM_MS) return null
      const wanted = current.value.branch
      if (branch !== wanted && !branch.endsWith(`/${wanted}`)) return null
      taken = null
      return current.value
    }
  }
}
