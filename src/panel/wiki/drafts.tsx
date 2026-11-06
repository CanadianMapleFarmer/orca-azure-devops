import { Button, Callout, Card, CodeView, Collapsible, read, RelativeTime, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import type { DiffText } from '../../shared/diff'
import type { DraftSummary } from '../../shared/wiki'
import { cutLabel } from '../label'
import { LoadFailure } from '../snapshot-parts'
import {
  ask,
  cancelAsk,
  confirmOf,
  discard,
  drafts,
  draftsLoad,
  edit,
  isRunning,
  outcomeOf,
  publish,
  resolve,
  retryDrafts,
  type Confirm,
  type Outcome,
  type Versions
} from './state'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

const TONE: Record<Exclude<Outcome['status'], 'conflict'>, Tone> = {
  published: 'success',
  updated: 'success',
  unchanged: 'neutral',
  failed: 'danger',
  opened: 'accent',
  refused: 'danger'
}

const QUESTIONS: Record<Confirm, { question: string; yes: string; no: string }> = {
  discard: { question: "Discard this draft? Changes you haven't published are lost.", yes: 'Discard', no: 'Keep' },
  mine: { question: 'Publish your draft over their changes? Their changes are lost.', yes: 'Publish mine', no: 'Cancel' },
  theirs: { question: 'Replace your draft with their version? Your changes are lost.', yes: 'Take theirs', no: 'Cancel' }
}

function carryOut(key: string, confirm: Confirm): Promise<void> {
  return confirm === 'discard' ? discard(key) : resolve(key, confirm)
}

function Confirmation({ id, confirm }: { id: string; confirm: Confirm }): OrcaNode {
  const { question, yes, no } = QUESTIONS[confirm]
  const busy = isRunning(id)
  return (
    <Stack gap="xs">
      <Text size="sm">{question}</Text>
      <Row gap="sm" wrap>
        <Button size="sm" tone="danger" disabled={busy} onPress={() => carryOut(id, confirm)}>
          {yes}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onPress={() => cancelAsk(id)}>
          {no}
        </Button>
      </Row>
    </Stack>
  )
}

function Version({ label, version }: { label: string; version: DiffText }): OrcaNode {
  return (
    <Stack gap="xs">
      <Text weight="semibold">{label}</Text>
      {version.message ? (
        <Text size="sm" muted>
          {version.message}
        </Text>
      ) : null}
      {version.text !== null ? <CodeView code={version.text} language="diff" label={label} lineNumbers={false} maxHeight="md" /> : null}
    </Stack>
  )
}

function Choices({ id }: { id: string }): OrcaNode {
  const confirm = confirmOf(id)
  if (confirm === 'mine' || confirm === 'theirs') return <Confirmation id={id} confirm={confirm} />
  const busy = isRunning(id)
  return (
    <Row gap="sm" wrap>
      <Button size="sm" disabled={busy} onPress={() => ask(id, 'mine')}>
        Publish mine…
      </Button>
      <Button size="sm" disabled={busy} onPress={() => ask(id, 'theirs')}>
        Take theirs…
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onPress={() => resolve(id, 'merge')}>
        Merge by hand
      </Button>
    </Row>
  )
}

function Conflict({ id, message, versions }: { id: string; message: string; versions: Versions | null }): OrcaNode {
  return (
    <Stack gap="sm">
      <Callout tone="warning" title="This page changed in Azure DevOps">
        {message}
      </Callout>
      {versions === null ? (
        <Text size="sm" muted>
          Press Publish to see both versions again.
        </Text>
      ) : (
        <Stack gap="sm">
          <Version label="Their changes" version={versions.theirs} />
          <Version label="Your changes" version={versions.mine} />
          <Choices id={id} />
        </Stack>
      )}
    </Stack>
  )
}

function Result({ id }: { id: string }): OrcaNode {
  const outcome = outcomeOf(id)
  if (!outcome) return null
  if (outcome.status === 'conflict') return <Conflict id={id} message={outcome.message} versions={outcome.versions} />
  return <Callout tone={TONE[outcome.status]}>{outcome.message}</Callout>
}

function Status({ draft }: { draft: DraftSummary }): OrcaNode {
  const saved = draft.changed ? 'Saved changes not published yet.' : 'No changes since you opened or published it.'
  return draft.publishedAt === null ? (
    <Text size="sm" muted>
      {saved}
    </Text>
  ) : (
    <Text size="sm" muted>
      {`${saved} Published `}
      <RelativeTime at={draft.publishedAt} />
    </Text>
  )
}

function Actions({ draft }: { draft: DraftSummary }): OrcaNode {
  const confirm = confirmOf(draft.key)
  if (confirm === 'discard') return <Confirmation id={draft.key} confirm={confirm} />
  const busy = isRunning(draft.key)
  return (
    <Row gap="sm" wrap>
      <Button size="sm" disabled={busy} onPress={() => publish(draft.key)}>
        Publish
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onPress={() => edit(draft)}>
        Open
      </Button>
      <Button size="sm" variant="ghost" tone="danger" disabled={busy} onPress={() => ask(draft.key, 'discard')}>
        Discard…
      </Button>
    </Row>
  )
}

function DraftCard({ draft }: { draft: DraftSummary }): OrcaNode {
  return (
    <Card title={cutLabel(draft.title)} description={cutLabel(`${draft.wikiName} · in ${draft.workspaceName}`)}>
      <Stack gap="sm">
        <Text size="sm" muted>
          {cutLabel(`.orca-ado/${draft.file}`)}
        </Text>
        <Status draft={draft} />
        <Actions draft={draft} />
        <Result id={draft.key} />
      </Stack>
    </Card>
  )
}

export function Drafts(): OrcaNode {
  const list = read(drafts)
  const load = read(draftsLoad)
  const failure = load.status === 'failed' ? <LoadFailure message={load.message} onRetry={retryDrafts} /> : null
  if (list === null) return failure ?? <Skeleton lines={2} label="Loading drafts" />
  if (list.length === 0) return failure
  return (
    <Stack gap="sm">
      {failure}
      <Collapsible title={`Drafts (${list.length})`} defaultOpen>
        <Stack gap="sm">
          {list.map(draft => (
            <DraftCard key={draft.key} draft={draft} />
          ))}
        </Stack>
      </Collapsible>
    </Stack>
  )
}
