import { parsePrItemKey, prShareItem } from '../../src/shared/share/pr-items'
import { PR_TEMPLATE, PR_VARS } from '../../src/shared/share/template'
import { mapLimit } from '../ado/limit'
import type { ShareSource } from '../share/service'
import type { PrsService } from './service'
import type { PrSettings } from './settings'

const READS_AT_A_TIME = 3

export function prShareSource(prs: Pick<PrsService, 'cached' | 'source'>, settings: Pick<PrSettings, 'shareTemplate'>): ShareSource {
  return {
    kind: 'pr',
    template: () => settings.shareTemplate(),
    fallback: PR_TEMPLATE,
    vars: PR_VARS,
    async items(org, keys) {
      const wanted = keys.flatMap(key => parsePrItemKey(key) ?? [])
      const found = await mapLimit(wanted, READS_AT_A_TIME, async key => prs.cached(org, key) ?? (await prs.source(org)).one(key))
      return { items: found.map(prShareItem), prs: wanted }
    }
  }
}
