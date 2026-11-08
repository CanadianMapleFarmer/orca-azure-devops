import { Button, Callout, Card, Link, Row, Stack, Text, type OrcaNode, type Tone } from 'orca'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type PrSummary, type ReleaseSet, type RowResult } from '../../shared/prs'
import { prShareItem } from '../../shared/share/pr-items'
import { PR_TEMPLATE, PR_VARS } from '../../shared/share/template'
import type { Identity } from '../../shared/types'
import { Chips } from '../chips'
import { cutLabel } from '../label'
import { openComposer } from '../share/state'
import { branchPattern, MERGED_SHOWN, needsApprove, needsAutoComplete, prChips, waitingOn, type PlaceChip } from './rows'
import { act, isActing, isMergedShown, outcomeOf, toggleMerged, type Outcome } from './state'

const optionsLine = (options: AutoCompleteOptions): string =>
  `Auto-complete uses ${MERGE_STRATEGY_LABELS[options.mergeStrategy]}, ${options.deleteSourceBranch ? 'deletes' : 'keeps'} the source branch, ${options.transitionWorkItems ? 'completes linked work items' : 'leaves work items alone'}. Change this in Settings → Azure DevOps.`

function PrRow({ pr, place }: { pr: PrSummary; place: PlaceChip }): OrcaNode {
  const chips = prChips(pr, place)
  const waiting = waitingOn(pr)
  return (
    <Row gap="sm" align="center" wrap>
      <Link href={pr.url}>{`!${pr.prId}`}</Link>
      <Text>{`→ ${pr.target}`}</Text>
      {chips.length > 0 ? <Chips chips={chips} /> : null}
      {waiting ? (
        <Text size="sm" muted>
          {waiting}
        </Text>
      ) : null}
    </Row>
  )
}

const resultTone = (result: RowResult): Tone => (!result.ok ? 'danger' : result.warn ? 'warning' : 'success')

function Result({ outcome }: { outcome: Outcome }): OrcaNode {
  if ('error' in outcome) return <Callout tone="danger">{outcome.error}</Callout>
  return (
    <Callout tone={outcome.results.every(result => resultTone(result) === 'success') ? 'success' : 'warning'}>
      <Stack gap="xs">
        {outcome.results.map(result => (
          <Text key={result.prId} size="sm" tone={resultTone(result)}>
            {`Pull Request ${result.prId}: ${result.message}`}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

function reviewersOf(set: ReleaseSet, me: string | null): Identity[] {
  const byId = new Map<string, Identity>()
  for (const reviewer of set.prs.flatMap(pr => pr.reviewers)) {
    if (reviewer.id.toLowerCase() !== me?.toLowerCase() && !byId.has(reviewer.id)) {
      byId.set(reviewer.id, { id: reviewer.id, displayName: reviewer.name, uniqueName: reviewer.uniqueName, kind: reviewer.isGroup ? 'group' : 'user' })
    }
  }
  return [...byId.values()]
}

function shareSet(org: string, me: string | null, set: ReleaseSet): void {
  openComposer({
    org,
    kind: 'pr',
    host: 'prs',
    title: 'Share pull requests',
    items: set.prs.map(pr => {
      const item = prShareItem(pr)
      return { key: item.key, label: `Pull Request ${pr.prId} → ${pr.target}`, item, checked: pr.status === 'active' }
    }),
    suggestions: reviewersOf(set, me),
    reviewers: true,
    email: false,
    subject: '',
    fallback: PR_TEMPLATE,
    vars: PR_VARS
  })
}

function foldMerged(prs: readonly PrSummary[]): { rows: PrSummary[]; folded: number } {
  const rows: PrSummary[] = []
  let merged = 0
  for (const pr of prs) {
    if (pr.status === 'completed') merged += 1
    if (pr.status !== 'completed' || merged <= MERGED_SHOWN) rows.push(pr)
  }
  return { rows, folded: prs.length - rows.length }
}

interface ReleaseSetCardProps {
  org: string
  me: string | null
  options: AutoCompleteOptions
  set: ReleaseSet
  limit?: number
  place?: PlaceChip
}

export function ReleaseSetCard({ org, me, options, set, limit = set.prs.length, place = null }: ReleaseSetCardProps): OrcaNode {
  const shown = set.prs.slice(0, limit)
  const { rows, folded } = foldMerged(shown)
  const showMerged = isMergedShown(set.key)
  const active = set.prs.filter(pr => pr.status === 'active')
  const ids = set.prs.map(pr => pr.prId)
  const busy = isActing(ids)
  const outcome = outcomeOf(ids)
  return (
    <Card title={cutLabel(set.title)} description={cutLabel(branchPattern(set.sources))}>
      {(showMerged ? shown : rows).map(pr => (
        <PrRow key={pr.prId} pr={pr} place={place} />
      ))}
      {folded > 0 ? <Link onPress={() => toggleMerged(set.key)}>{showMerged ? 'Hide merged' : `+ ${folded} merged · show`}</Link> : null}
      {shown.length < set.prs.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${set.prs.length} pull requests in this set.`}
        </Text>
      ) : null}
      <Row gap="sm" wrap>
        <Button size="sm" variant="solid" onPress={() => shareSet(org, me, set)}>
          Share…
        </Button>
        {set.prs.some(pr => needsApprove(pr, me)) ? (
          <Button size="sm" variant="outline" disabled={busy} onPress={() => act('prs.approve', org, active)}>
            Approve
          </Button>
        ) : null}
        {set.prs.some(needsAutoComplete) ? (
          <Button size="sm" variant="outline" tooltip={optionsLine(options)} disabled={busy} onPress={() => act('prs.autoComplete', org, active)}>
            Auto-complete
          </Button>
        ) : null}
      </Row>
      {outcome ? <Result outcome={outcome} /> : null}
    </Card>
  )
}
