import { Button, Callout, List, ListItem, read, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { PrSnapshot, PrSummary, ReleaseSet } from '../../shared/prs'
import { votePhrase } from '../../shared/reviews'
import type { OrgStatus } from '../../shared/types'
import { ACROSS_PROJECTS, ACROSS_REPOS, counted, needYouHint } from '../copy'
import { Group, projectTitle, ScopedEmpty } from '../group'
import { ACROSS_PROJECTS_KEY, choicesOf, groupByPlace, inScope, type Choices, type Grouped, type Place } from '../grouping'
import { cutLabel } from '../label'
import { choosePrsView, prsPrefs, prsViewIn, scopeIn, type PrsView } from '../prefs'
import { Channels, openChannels } from '../share/channels'
import { Composer } from '../share/composer'
import { shareView } from '../share/state'
import { LoadFailure } from '../snapshot-parts'
import { foldActions, ScopePickers, TabToolbar, type ToolAction } from '../toolbar'
import { ReleaseSetCard } from './release-set'
import { ReviewView } from './review/review-view'
import { openReview, showReview } from './review/state'
import { myVoteOn, needsYou, prPlace, setPlaces, type PlaceChip } from './rows'
import { load, notice, refresh, refreshing, retryLoad, snapshot } from './state'

const MAX_SETS = 30
const MAX_ROWS = 150
const MAX_TO_REVIEW = 50
const MAX_REVIEWED = 50

const prPlaces = (pr: PrSummary): Place[] => [prPlace(pr)]

interface View {
  org: string
  current: PrSnapshot
  choices: Choices
}

interface Layout<T> {
  prefix: PrsView
  count: (items: readonly T[]) => string
  hint: (items: readonly T[]) => string | undefined
  draw: (items: readonly T[], place: PlaceChip) => OrcaNode
}

function Groups<T>({ org, grouped, layout }: { org: string; grouped: Grouped<T>; layout: Layout<T> }): OrcaNode {
  const group = (foldKey: string, title: string, items: readonly T[], children: OrcaNode): OrcaNode => (
    <Group key={foldKey} org={org} tab="prs" foldKey={`${layout.prefix}/${foldKey}`} title={title} count={layout.count(items)} hint={layout.hint(items)}>
      {children}
    </Group>
  )
  return (
    <>
      {grouped.across.length > 0 ? group(ACROSS_PROJECTS_KEY, ACROSS_PROJECTS, grouped.across, layout.draw(grouped.across, 'project')) : null}
      {grouped.projects.map(project =>
        group(
          project.key,
          projectTitle(project),
          [...project.loose, ...project.repos.flatMap(repo => repo.items)],
          project.repos.length === 0 ? (
            layout.draw(project.loose, null)
          ) : (
            <Stack gap="sm">
              {project.loose.length > 0 ? layout.draw(project.loose, null) : null}
              {project.repos.map(repo => group(repo.key, repo.repoName ?? ACROSS_REPOS, repo.items, layout.draw(repo.items, repo.repoName === null ? 'repo' : null)))}
            </Stack>
          )
        )
      )}
    </>
  )
}

interface Shown {
  set: ReleaseSet
  limit: number
}

function setsToShow(sets: readonly ReleaseSet[]): Shown[] {
  const shown: Shown[] = []
  let room = MAX_ROWS
  for (const set of sets.slice(0, MAX_SETS)) {
    if (shown.length > 0 && set.prs.length > room) break
    const limit = Math.min(set.prs.length, room)
    shown.push({ set, limit })
    room -= limit
  }
  return shown
}

function Mine({ org, current, choices }: View): OrcaNode {
  const sets = inScope(current.sets, setPlaces, choices.scope)
  if (sets.length === 0) {
    return <ScopedEmpty choices={choices} title="No open pull requests of yours" description="Pull requests you create in this organization's code projects show up here." />
  }
  const shown = setsToShow(sets)
  const layout: Layout<Shown> = {
    prefix: 'mine',
    count: items => counted(items.length, 'set', 'sets'),
    hint: items => {
      const needing = items.filter(({ set }) => needsYou(set)).length
      return needing > 0 ? needYouHint(needing) : undefined
    },
    draw: (items, place) => (
      <Stack gap="sm">
        {items.map(({ set, limit }) => (
          <ReleaseSetCard key={set.key} org={org} me={current.me} options={current.autoComplete} set={set} limit={limit} place={place} />
        ))}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Groups org={org} grouped={groupByPlace(shown, ({ set }) => setPlaces(set))} layout={layout} />
      {shown.length < sets.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${sets.length} sets.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function ToReview({ org, current, choices }: View): OrcaNode {
  const waiting = inScope(current.toReview, prPlaces, choices.scope)
  const reviewed = inScope(current.reviewed, prPlaces, choices.scope).slice(0, MAX_REVIEWED)
  const total = choices.scope.project === null ? current.toReviewCount : waiting.length
  if (total === 0 && waiting.length === 0 && reviewed.length === 0) {
    return <ScopedEmpty choices={choices} title="Nothing to review" description="Pull requests that name you as a reviewer show up here until you vote." />
  }
  const shown = waiting.slice(0, MAX_TO_REVIEW)
  const layout: Layout<PrSummary> = {
    prefix: 'review',
    count: items => counted(items.length, 'pull request', 'pull requests'),
    hint: () => undefined,
    draw: items => (
      <List label="To review">
        {items.map(pr => (
          <ListItem key={pr.prId} title={cutLabel(pr.title)} description={cutLabel(`!${pr.prId} · ${pr.createdBy.name}`)} onPress={() => showReview(org, pr)} />
        ))}
      </List>
    )
  }
  return (
    <Stack gap="sm">
      <Groups org={org} grouped={groupByPlace(shown, prPlaces)} layout={layout} />
      {total > shown.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${total} pull requests.`}
        </Text>
      ) : null}
      {reviewed.length > 0 ? (
        <Group org={org} tab="prs" foldKey="review/reviewed" title="Reviewed by you" count={counted(reviewed.length, 'pull request', 'pull requests')}>
          <List label="Reviewed by you">
            {reviewed.map(pr => (
              <ListItem
                key={pr.prId}
                title={cutLabel(pr.title)}
                description={cutLabel(`!${pr.prId} · ${pr.projectName} / ${pr.repoName} · ${pr.createdBy.name} · you: ${votePhrase(myVoteOn(pr, current.me))}`)}
                onPress={() => showReview(org, pr)}
              />
            ))}
          </List>
        </Group>
      ) : null}
    </Stack>
  )
}

function reviewLabel({ current, choices }: View): string {
  if (current.toReviewCount === 0) return 'To review'
  if (choices.scope.project === null) return `To review · ${current.toReviewCount}`
  return `To review · ${inScope(current.toReview, prPlaces, choices.scope).length} of ${current.toReviewCount}`
}

function Toolbar({ view, shown }: { view: View; shown: PrsView }): OrcaNode {
  const { org, current, choices } = view
  const actions: ToolAction[] = [
    ...foldActions(org, 'prs'),
    { icon: 'refresh', label: 'Refresh', disabled: read(refreshing), onPress: () => refresh(org) },
    { icon: 'settings', label: 'Teams channels', onPress: () => openChannels('prs') }
  ]
  const choose = (next: PrsView) => (shown === next ? 'solid' : 'ghost')
  return (
    <TabToolbar
      left={
        <>
          <ScopePickers org={org} choices={choices} prefs={prsPrefs} />
          <Row gap="xs">
            <Button size="sm" variant={choose('mine')} onPress={() => choosePrsView(org, 'mine')}>
              Mine
            </Button>
            <Button size="sm" variant={choose('review')} onPress={() => choosePrsView(org, 'review')}>
              {reviewLabel(view)}
            </Button>
          </Row>
        </>
      }
      actions={actions}
      updatedAt={current.updatedAt}
      message={current.message}
      stale={current.stale}
    />
  )
}

const everyPr = (current: PrSnapshot): PrSummary[] => [...current.sets.flatMap(set => set.prs), ...current.toReview, ...current.reviewed]

export function PrsTab({ org }: { org: OrgStatus }): OrcaNode {
  const shown = shareView('prs')
  if (shown === 'composer') return <Composer />
  if (shown === 'channels') return <Channels />
  const opened = read(openReview)
  if (opened && opened.org === org.org) return <ReviewView org={org} />
  const stored = read(snapshot)
  const current = stored?.org === org.org ? stored : null
  const status = read(load)
  if (!current) {
    if (status.status !== 'failed') return <Skeleton lines={3} label="Loading pull requests" />
    return <LoadFailure message={status.message} onRetry={retryLoad} />
  }
  const prefs = read(prsPrefs) ?? {}
  const prsView = prsViewIn(prefs, org.org)
  const view: View = { org: org.org, current, choices: choicesOf(everyPr(current), prPlaces, scopeIn(prefs, org.org)) }
  const failure = read(notice)
  return (
    <Stack gap="md">
      <Toolbar view={view} shown={prsView} />
      {failure ? <Callout tone="danger">{failure}</Callout> : null}
      {prsView === 'mine' ? <Mine {...view} /> : <ToReview {...view} />}
    </Stack>
  )
}
