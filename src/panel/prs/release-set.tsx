import { Badge, Box, Button, Callout, Link, Row, Stack, Text, type OrcaNode, type Tone } from 'orca'
import { MERGE_STRATEGY_LABELS, type AutoCompleteOptions, type PrSummary, type ReleaseSet, type RowResult } from '../../shared/prs'
import { prShareItem } from '../../shared/share/pr-items'
import { PR_TEMPLATE, PR_VARS } from '../../shared/share/template'
import type { Identity } from '../../shared/types'
import type { PlaceChip } from '../grouping'
import { cutLabel } from '../label'
import { openComposer } from '../share/state'
import { branchPattern, MERGED_SHOWN, needsApprove, needsAutoComplete, placeChip, statusChip, waitingOn } from './rows'
import { act, isActing, isMergedShown, outcomeOf, toggleMerged, type Outcome } from './state'

const optionsLine = (options: AutoCompleteOptions): string =>
  `Auto-complete uses ${MERGE_STRATEGY_LABELS[options.mergeStrategy]}, ${options.deleteSourceBranch ? 'deletes' : 'keeps'} the source branch, ${options.transitionWorkItems ? 'completes linked work items' : 'leaves work items alone'}. Change this in Settings → Azure DevOps.`

function PrRow({ pr, place }: { pr: PrSummary; place: PlaceChip }): OrcaNode {
  const where = placeChip(pr, place)
  const status = statusChip(pr)
  const waiting = waitingOn(pr)
  return (
    <>
      <Row justify="between" align="center" gap="xs" wrap>
        <Box direction="row" gap="xs" align="center" shrink={false} wrap maxWidth="100%">
          <Link href={pr.url}>{`!${pr.prId}`}</Link>
          <Text size="sm">{`→ ${pr.target}`}</Text>
          {where ? <Badge tone={where.tone}>{where.text}</Badge> : null}
        </Box>
        {status ? (
          <Box direction="row" shrink={false}>
            <Badge tone={status.tone}>{status.text}</Badge>
          </Box>
        ) : null}
      </Row>
      {waiting ? (
        <Text size="xs" muted>
          {waiting}
        </Text>
      ) : null}
    </>
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
  const branch = branchPattern(set.sources)
  return (
    <Box border radius="md" background="card" padding="sm" gap="xs">
      <Text weight="semibold" size="sm">
        {cutLabel(set.title)}
      </Text>
      {branch ? (
        <Text size="xs" muted>
          {cutLabel(branch)}
        </Text>
      ) : null}
      {(showMerged ? shown : rows).map(pr => (
        <PrRow key={pr.prId} pr={pr} place={place} />
      ))}
      {folded > 0 ? (
        <Row>
          <Link onPress={() => toggleMerged(set.key)}>{showMerged ? 'Hide merged' : `+ ${folded} merged · show`}</Link>
        </Row>
      ) : null}
      {shown.length < set.prs.length ? (
        <Text size="xs" muted>
          {`Showing ${shown.length} of ${set.prs.length} pull requests in this set.`}
        </Text>
      ) : null}
      <Row gap="xs" wrap>
        <Button size="xs" variant="solid" tone="accent" onPress={() => shareSet(org, me, set)}>
          Share…
        </Button>
        {set.prs.some(pr => needsApprove(pr, me)) ? (
          <Button size="xs" variant="outline" disabled={busy} onPress={() => act('prs.approve', org, active)}>
            Approve
          </Button>
        ) : null}
        {set.prs.some(needsAutoComplete) ? (
          <Button size="xs" variant="outline" tooltip={optionsLine(options)} disabled={busy} onPress={() => act('prs.autoComplete', org, active)}>
            Auto-complete
          </Button>
        ) : null}
      </Row>
      {outcome ? <Result outcome={outcome} /> : null}
    </Box>
  )
}
