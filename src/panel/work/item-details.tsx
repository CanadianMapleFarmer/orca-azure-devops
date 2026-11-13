import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  Textarea,
  update,
  type OrcaNode
} from 'orca'
import { chipOf } from '../../shared/chips'
import { recordOwn, withOwn, type OwnComments } from '../../shared/own-comments'
import type { WorkItemDetails } from '../../shared/work'
import { foldedAfter } from '../folds'
import { messageOf } from '../state'
import { resetStart, StartSection } from './item-start'
import { openItem } from './state'

type Loaded = { status: 'loading' } | { status: 'ready'; details: WorkItemDetails; message?: string } | { status: 'failed'; message: string }
type Section = 'comment' | 'link'
type Fold = 'acceptance' | 'comments'
type SectionNotice = { section: Section; tone: 'danger'; text: string }

const LINK_KINDS = [
  { kind: 'parent', label: 'Parent' },
  { kind: 'child', label: 'Children' },
  { kind: 'related', label: 'Related' },
  { kind: 'pr', label: 'Pull requests' }
] as const

const loaded = atom<Loaded>({ status: 'loading' })
const refreshing = atom(false)
const commentDraft = atom('')
const linkDraft = atom('')
const working = atom<Section | null>(null)
const sectionNotice = atom<SectionNotice | null>(null)
const closedFolds = atom<Fold[]>([])
const ownComments = atom<OwnComments>({})

const foldOpen = (fold: Fold): boolean => !read(closedFolds).includes(fold)

const setFoldOpen = (fold: Fold, open: boolean): void =>
  update(closedFolds, folds => foldedAfter(folds, fold, open))

const isOpen = (org: string, id: number): boolean => {
  const open = read(openItem)
  return open?.org === org && open.id === id
}

export function openDetails(org: string, id: number): void {
  set(openItem, { org, id })
  set(loaded, { status: 'loading' })
  set(refreshing, false)
  set(commentDraft, '')
  set(linkDraft, '')
  set(working, null)
  set(sectionNotice, null)
  set(closedFolds, [])
  resetStart(org, id)
  void fetchDetails(org, id)
}

const closeDetails = (): void => set(openItem, null)

async function fetchDetails(org: string, id: number): Promise<void> {
  try {
    await reloadDetails(org, id)
  } catch (error) {
    if (isOpen(org, id)) set(loaded, { status: 'failed', message: messageOf(error) })
  }
}

async function reloadDetails(org: string, id: number): Promise<void> {
  landed(org, id, await plugin.request('work.details', { org, id }))
}

function landed(org: string, id: number, details: WorkItemDetails): void {
  if (!isOpen(org, id)) return
  set(loaded, { status: 'ready', details: { ...details, comments: withOwn(read(ownComments), `${org}:${id}`, details.comments, Date.now()) } })
}

async function refreshDetails(): Promise<void> {
  const open = read(openItem)
  if (!open) return
  const { org, id } = open
  set(refreshing, true)
  try {
    landed(org, id, await plugin.request('work.details', { org, id, fresh: true }))
  } catch (error) {
    const message = messageOf(error)
    if (isOpen(org, id)) update(loaded, (state): Loaded => (state.status === 'ready' ? { ...state, message } : { status: 'failed', message }))
  } finally {
    if (isOpen(org, id)) set(refreshing, false)
  }
}

async function run(org: string, id: number, section: Section, work: () => Promise<void>): Promise<void> {
  set(working, section)
  set(sectionNotice, null)
  try {
    await work()
  } catch (error) {
    if (isOpen(org, id)) set(sectionNotice, { section, tone: 'danger', text: messageOf(error) })
  } finally {
    if (isOpen(org, id)) set(working, null)
  }
}

function postComment(org: string, id: number): Promise<void> {
  const text = read(commentDraft).trim()
  return run(org, id, 'comment', async () => {
    const comment = await plugin.request('work.comment', { org, id, text })
    update(ownComments, own => recordOwn(own, `${org}:${id}`, comment, Date.now()))
    if (!isOpen(org, id)) return
    update(loaded, state =>
      state.status === 'ready' ? { ...state, details: { ...state.details, comments: [comment, ...state.details.comments] } } : state
    )
    set(commentDraft, '')
  })
}

function linkPullRequest(org: string, id: number, rev: number): Promise<void> {
  const prUrl = read(linkDraft).trim()
  return run(org, id, 'link', async () => {
    try {
      await plugin.request('work.linkPr', { org, id, rev, prUrl })
    } catch (error) {
      await reloadDetails(org, id).catch(() => {})
      throw error
    }
    if (!isOpen(org, id)) return
    set(linkDraft, '')
    await reloadDetails(org, id)
  })
}

function NoticeFor({ section }: { section: Section }): OrcaNode {
  const shown = read(sectionNotice)
  return shown?.section === section ? <Callout tone={shown.tone}>{shown.text}</Callout> : null
}

function Links({ links }: { links: WorkItemDetails['links'] }): OrcaNode {
  const groups = LINK_KINDS.map(({ kind, label }) => ({ label, links: links.filter(link => link.kind === kind) })).filter(
    group => group.links.length > 0
  )
  if (groups.length === 0) return null
  return (
    <Stack gap="sm">
      {groups.map(group => (
        <Stack key={group.label} gap="xs">
          <Text size="sm" weight="semibold">
            {group.label}
          </Text>
          <List label={group.label}>
            {group.links.map((link, index) => (
              <ListItem key={index}>
                <Link href={link.url}>{link.title}</Link>
              </ListItem>
            ))}
          </List>
        </Stack>
      ))}
    </Stack>
  )
}

function Comments({ org, details }: { org: string; details: WorkItemDetails }): OrcaNode {
  const busy = read(working) !== null
  const draft = read(commentDraft)
  return (
    <Collapsible title={`Comments (${details.comments.length})`} open={foldOpen('comments')} onChange={open => setFoldOpen('comments', open)}>
      <Stack gap="sm">
        {details.comments.map(comment => (
          <Stack key={comment.id} gap="xs">
            <Text muted size="sm">
              {`${comment.author} · `}
              <RelativeTime at={comment.createdAt} />
            </Text>
            <Markdown content={comment.textMd} />
          </Stack>
        ))}
        <Textarea label="Add a comment" rows={3} value={draft} disabled={busy} onChange={value => set(commentDraft, value)} />
        <Row gap="sm">
          <Button disabled={busy || draft.trim() === ''} onPress={() => postComment(org, details.item.id)}>
            Comment
          </Button>
        </Row>
        <NoticeFor section="comment" />
      </Stack>
    </Collapsible>
  )
}

function Body({ org, details }: { org: string; details: WorkItemDetails }): OrcaNode {
  const { item } = details
  const busy = read(working) !== null
  const draft = read(linkDraft)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={3}>{item.title}</Heading>
        <Text muted size="xs">
          Read <RelativeTime at={details.readAt} />
        </Text>
      </Stack>
      <KeyValue
        items={[
          { label: 'Type', value: item.type },
          { label: 'State', value: item.state },
          { label: 'Column', value: item.column },
          { label: 'Assigned', value: item.assignedTo },
          { label: 'Parent', value: item.parentId === null ? null : `#${item.parentId}${item.parentTitle ? ` ${item.parentTitle}` : ''}` }
        ]}
      />
      {item.prs.length > 0 ? (
        <Row gap="xs" wrap>
          {item.prs.map(pr => {
            const chip = chipOf(pr)
            return (
              <Badge key={pr.prId} tone={chip.tone}>
                {chip.text}
              </Badge>
            )
          })}
        </Row>
      ) : null}
      {details.descriptionMd ? <Markdown content={details.descriptionMd} /> : null}
      {details.acceptanceMd ? (
        <Collapsible title="Acceptance criteria" open={foldOpen('acceptance')} onChange={open => setFoldOpen('acceptance', open)}>
          <Markdown content={details.acceptanceMd} />
        </Collapsible>
      ) : null}
      <Comments org={org} details={details} />
      <Links links={details.links} />
      <Stack gap="xs">
        <Input
          label="Link a pull request"
          placeholder="https://dev.azure.com/your-org/project/_git/repo/pullrequest/1"
          value={draft}
          disabled={busy}
          onChange={value => set(linkDraft, value)}
        />
        <Row gap="sm">
          <Button disabled={busy || draft.trim() === ''} onPress={() => linkPullRequest(org, item.id, item.rev)}>
            Link
          </Button>
        </Row>
        <NoticeFor section="link" />
      </Stack>
      <StartSection org={org} item={item} disabled={busy} />
    </Stack>
  )
}

export function ItemDetails({ org }: { org: string }): OrcaNode {
  const state = read(loaded)
  return (
    <Stack gap="md">
      <Row align="center" gap="sm">
        <IconButton icon="close" label="Back" variant="ghost" size="sm" onPress={closeDetails} />
        <IconButton
          icon="refresh"
          label="Refresh"
          variant="ghost"
          size="sm"
          disabled={state.status === 'loading' || read(refreshing)}
          onPress={refreshDetails}
        />
      </Row>
      {state.status === 'loading' ? <Skeleton lines={4} label="Loading details" /> : null}
      {state.status !== 'loading' && state.message ? <Callout tone="danger">{state.message}</Callout> : null}
      {state.status === 'ready' ? <Body org={org} details={state.details} /> : null}
    </Stack>
  )
}
