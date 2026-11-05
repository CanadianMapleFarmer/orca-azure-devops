import { Button, Callout, Checkbox, CodeView, Heading, Markdown, read, Row, Skeleton, Stack, Text, Textarea, type OrcaNode } from 'orca'
import { MAX_INTRO, TOO_MANY_ITEMS } from '../../shared/share/limits'
import { toMarkdown } from '../../shared/share/message'
import type { ShareResult } from '../../shared/share/types'
import { LoadFailure } from '../snapshot-parts'
import { openChannels } from './channels'
import { PeoplePicker } from './people-picker'
import { retryChat, sending, share } from './send'
import {
  chat,
  chatHint,
  chatOpening,
  checked,
  checkItem,
  choices,
  choose,
  chooseChannel,
  closeComposer,
  composer,
  intro,
  prefs,
  retryPrefs,
  sent,
  setIntro,
  sharePlan,
  shownChannels,
  type ChatResult,
  type ComposerInput
} from './state'

const CHAT_HINT = "Orca asks before opening Teams. Tick 'Always allow' to skip this next time."
const COPY = 'Copy as rich text'
const CHAT = 'Message in Teams'
const REVIEWERS = 'Add as reviewers'
const MAX_RESULT_TEXT = 2000

const postTo = (name: string): string => `Post to ${name}`

function titleOf(destination: string): string | undefined {
  if (destination === 'copy') return COPY
  if (destination === 'reviewers') return REVIEWERS
  const channel = shownChannels().find(item => `channel:${item.id}` === destination)
  return channel ? postTo(channel.name) : undefined
}

const clip = (text: string): string => (text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}…` : text)

function Items({ input, tooMany }: { input: ComposerInput; tooMany: boolean }): OrcaNode {
  const keys = read(checked)
  return (
    <Stack gap="xs">
      {input.items.map(item => (
        <Checkbox key={item.key} label={item.label} checked={keys.includes(item.key)} onChange={on => checkItem(item.key, on)} />
      ))}
      {tooMany ? (
        <Text size="sm" tone="warning">
          {TOO_MANY_ITEMS}
        </Text>
      ) : null}
    </Stack>
  )
}

function Destinations({ input }: { input: ComposerInput }): OrcaNode {
  const chosen = read(choices)
  return (
    <Stack gap="sm">
      <Text weight="semibold">Send to</Text>
      <Checkbox label={COPY} checked={chosen.copy} onChange={copy => choose({ copy })} />
      {shownChannels().map(channel => (
        <Checkbox key={channel.id} label={postTo(channel.name)} checked={chosen.channels.includes(channel.id)} onChange={on => chooseChannel(channel.id, on)} />
      ))}
      <Row gap="sm">
        <Button variant="ghost" size="sm" onPress={openChannels}>
          Manage channels
        </Button>
      </Row>
      <Checkbox label={CHAT} checked={chosen.chat} onChange={on => choose({ chat: on })} />
      {read(chatHint) ? (
        <Text size="sm" muted>
          {CHAT_HINT}
        </Text>
      ) : null}
      {chosen.chat ? (
        <PeoplePicker
          org={input.org}
          label="Find people"
          groups={false}
          required={false}
          people={chosen.chatPeople}
          suggestions={input.suggestions}
          onChange={chatPeople => choose({ chatPeople })}
        />
      ) : null}
      {input.reviewers ? <Checkbox label={REVIEWERS} checked={chosen.reviewers} onChange={reviewers => choose({ reviewers })} /> : null}
      {input.reviewers && chosen.reviewers ? (
        <PeoplePicker
          org={input.org}
          label="Find people or groups"
          groups
          required
          people={chosen.reviewerPeople}
          suggestions={input.suggestions}
          onChange={reviewerPeople => choose({ reviewerPeople })}
        />
      ) : null}
    </Stack>
  )
}

function ResultCallout({ result }: { result: ShareResult }): OrcaNode {
  return (
    <Callout tone={result.ok ? 'success' : 'danger'} title={titleOf(result.destination)}>
      <Stack gap="xs">
        <Text>{clip(result.text)}</Text>
        {result.plain ? <CodeView label="Copy this text instead" code={result.plain} wrap /> : null}
      </Stack>
    </Callout>
  )
}

function ChatCallout({ result }: { result: ChatResult }): OrcaNode {
  return (
    <Callout tone={result.ok ? 'success' : 'danger'} title={CHAT}>
      <Stack gap="xs">
        <Text>{result.text}</Text>
        {result.reason ? <Text size="sm">{result.reason}</Text> : null}
        {result.retry ? (
          <Row gap="sm">
            <Button size="sm" disabled={read(chatOpening)} onPress={retryChat}>
              Open Teams chat
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

function Results(): OrcaNode {
  const answer = read(sent)
  const chatResult = read(chat)
  if (!answer && !chatResult) return null
  return (
    <Stack gap="sm">
      {answer?.error ? <Callout tone="danger">{answer.error}</Callout> : null}
      {answer?.results.map(result => <ResultCallout key={result.destination} result={result} />)}
      {chatResult ? <ChatCallout result={chatResult} /> : null}
    </Stack>
  )
}

function Form({ input }: { input: ComposerInput }): OrcaNode {
  const plan = sharePlan()
  if (!plan) return null
  return (
    <Stack gap="md">
      <Items input={input} tooMany={plan.tooMany} />
      <Textarea label="Intro (optional)" maxLength={MAX_INTRO} value={read(intro)} onChange={setIntro} />
      <Stack gap="xs">
        {plan.warning ? <Callout tone="warning">{plan.warning}</Callout> : null}
        <Text weight="semibold">Preview</Text>
        <Markdown content={toMarkdown(plan.message)} />
      </Stack>
      <Destinations input={input} />
      <Row gap="sm">
        <Button disabled={!plan.ready || read(sending)} onPress={share}>
          {read(sending) ? 'Sharing…' : 'Share'}
        </Button>
        <Button variant="ghost" onPress={closeComposer}>
          Back
        </Button>
      </Row>
      <Results />
    </Stack>
  )
}

export function Composer(): OrcaNode {
  const input = read(composer)
  if (!input) return null
  const loaded = read(prefs)
  if (loaded.status === 'ready') {
    return (
      <Stack gap="md">
        <Heading level={2}>{input.title}</Heading>
        <Form input={input} />
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <Heading level={2}>{input.title}</Heading>
      {loaded.status === 'loading' ? <Skeleton lines={4} label="Loading share options" /> : <LoadFailure message={loaded.message} onRetry={retryPrefs} />}
      <Row gap="sm">
        <Button variant="ghost" onPress={closeComposer}>
          Back
        </Button>
      </Row>
    </Stack>
  )
}
