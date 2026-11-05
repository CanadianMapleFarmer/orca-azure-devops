import { parsePrItemKey, prShareItem } from '../../src/shared/share/pr-items'
import { PR_TEMPLATE, PR_VARS } from '../../src/shared/share/template'
import type { AdoHttp } from '../ado/http'
import { mapLimit } from '../ado/limit'
import { getPullRequest, toPrSummary } from '../ado/pullrequests'
import type { ShareSource } from '../share/service'
import type { PrsService } from './service'
import type { PrSettings } from './settings'

const READS_AT_A_TIME = 3

export function prShareSource(http: AdoHttp, prs: Pick<PrsService, 'cached'>, settings: Pick<PrSettings, 'shareTemplate'>): ShareSource {
  return {
    kind: 'pr',
    template: () => settings.shareTemplate(),
    fallback: PR_TEMPLATE,
    vars: PR_VARS,
    async items(org, keys) {
      const wanted = keys.flatMap(key => parsePrItemKey(key) ?? [])
      const found = await mapLimit(wanted, READS_AT_A_TIME, async key => prs.cached(org, key) ?? toPrSummary(await getPullRequest(http, org, key), org))
      return { items: found.map(prShareItem), prs: wanted }
    }
  }
}
