import { atom, Box, Button, Callout, Heading, Input, plugin, read, Row, set, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { messageOf } from '../../shared/messages'
import { CHANNEL_NAME_TOO_LONG, MAX_CHANNEL_NAME } from '../../shared/share/limits'
import type { Channel } from '../../shared/share/types'
import { LoadFailure } from '../snapshot-parts'
import { addToChannels, dropChannel, leaveChannels, setChannels, showChannels, shownChannels, type ShareHost } from './state'

const REPLACED = 'Webhook URL replaced.'
const HELP =
  'In Teams, open the channel\'s ⋯ menu → Workflows → "Send webhook alerts to a channel", then paste the URL it gives you. Posts come from the Workflows bot.'

type Listing = { status: 'loading' | 'ready' } | { status: 'failed'; message: string }

const listing = atom<Listing>({ status: 'loading' })
const nameDraft = atom('')
const urlDraft = atom('')
const replacing = atom<string | null>(null)
const replaceDraft = atom('')
const confirming = atom<string | null>(null)
const notice = atom<{ id: string; ok: boolean; text: string } | null>(null)
const addError = atom<string | null>(null)
const working = atom(false)

let loads = 0

const nameFits = (name: string): boolean => name.trim().length <= MAX_CHANNEL_NAME
const canAdd = (name: string, url: string): boolean => name.trim() !== '' && nameFits(name) && url.trim() !== ''

function forgetDrafts(): void {
  set(nameDraft, '')
  set(urlDraft, '')
  set(replacing, null)
  set(replaceDraft, '')
  set(confirming, null)
  set(notice, null)
  set(addError, null)
}

async function loadChannels(): Promise<void> {
  const run = (loads += 1)
  set(listing, { status: 'loading' })
  try {
    const list = await plugin.request('share.channels', {})
    if (run !== loads) return
    setChannels(list)
    set(listing, { status: 'ready' })
  } catch (error) {
    if (run === loads) set(listing, { status: 'failed', message: messageOf(error) })
  }
}

export function openChannels(host: ShareHost): void {
  forgetDrafts()
  showChannels(host)
  void loadChannels()
}

function closeChannels(): void {
  forgetDrafts()
  leaveChannels()
}

function begin(): boolean {
  if (read(working)) return false
  set(working, true)
  set(confirming, null)
  set(notice, null)
  set(addError, null)
  return true
}

async function testChannel(id: string): Promise<void> {
  if (!begin()) return
  try {
    const result = await plugin.request('share.testChannel', { id })
    set(notice, { id, ok: result.ok, text: result.text })
  } catch (error) {
    set(notice, { id, ok: false, text: messageOf(error) })
  }
  set(working, false)
}

function toggleReplace(id: string): void {
  set(confirming, null)
  set(replaceDraft, '')
  set(replacing, read(replacing) === id ? null : id)
}

async function saveReplace(id: string): Promise<void> {
  const url = read(replaceDraft)
  if (url.trim() === '' || !begin()) return
  set(replaceDraft, '')
  try {
    await plugin.request('share.replaceChannel', { id, url })
    set(replacing, null)
    set(notice, { id, ok: true, text: REPLACED })
  } catch (error) {
    set(notice, { id, ok: false, text: messageOf(error) })
  }
  set(working, false)
}

async function removeChannel(id: string): Promise<void> {
  if (read(working)) return
  if (read(confirming) !== id) {
    set(confirming, id)
    set(notice, null)
    return
  }
  begin()
  try {
    await plugin.request('share.removeChannel', { id })
    dropChannel(id)
    if (read(replacing) === id) set(replacing, null)
  } catch (error) {
    set(notice, { id, ok: false, text: messageOf(error) })
  }
  set(working, false)
}

async function addChannel(): Promise<void> {
  const name = read(nameDraft)
  const url = read(urlDraft)
  if (!canAdd(name, url) || !begin()) return
  set(urlDraft, '')
  try {
    addToChannels(await plugin.request('share.addChannel', { name, url }))
    set(nameDraft, '')
  } catch (error) {
    set(addError, messageOf(error))
  }
  set(working, false)
}

function ChannelRow({ channel }: { channel: Channel }): OrcaNode {
  const busy = read(working)
  const confirm = read(confirming) === channel.id
  const shown = read(notice)
  const draft = read(replaceDraft)
  return (
    <Stack gap="xs">
      <Text weight="medium">{channel.name}</Text>
      <Row gap="sm" wrap>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => testChannel(channel.id)}>
          Test
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={() => toggleReplace(channel.id)}>
          Replace URL
        </Button>
        <Button size="sm" variant={confirm ? 'solid' : 'outline'} tone="danger" disabled={busy} onPress={() => removeChannel(channel.id)}>
          {confirm ? 'Confirm remove' : 'Remove'}
        </Button>
      </Row>
      {read(replacing) === channel.id ? (
        <Row gap="sm" align="end">
          <Box grow shrink minWidth={0}>
            <Input type="password" label="New webhook URL" value={draft} onChange={next => set(replaceDraft, next)} onSubmit={() => saveReplace(channel.id)} />
          </Box>
          <Button size="sm" disabled={busy || draft.trim() === ''} onPress={() => saveReplace(channel.id)}>
            Save
          </Button>
        </Row>
      ) : null}
      {shown?.id === channel.id ? <Callout tone={shown.ok ? 'success' : 'danger'}>{shown.text}</Callout> : null}
    </Stack>
  )
}

function AddChannel(): OrcaNode {
  const name = read(nameDraft)
  const url = read(urlDraft)
  const error = read(addError)
  return (
    <Stack gap="sm">
      <Input label="Channel name" maxLength={MAX_CHANNEL_NAME} invalid={!nameFits(name)} value={name} onChange={next => set(nameDraft, next)} />
      {nameFits(name) ? null : (
        <Text size="sm" tone="danger">
          {CHANNEL_NAME_TOO_LONG}
        </Text>
      )}
      <Input type="password" label="Webhook URL" value={url} onChange={next => set(urlDraft, next)} onSubmit={() => addChannel()} />
      <Row gap="sm">
        <Button disabled={read(working) || !canAdd(name, url)} onPress={addChannel}>
          Add channel
        </Button>
      </Row>
      {error ? <Callout tone="danger">{error}</Callout> : null}
    </Stack>
  )
}

export function Channels(): OrcaNode {
  const loaded = read(listing)
  return (
    <Stack gap="md">
      <Heading level={2}>Teams channels</Heading>
      <Text size="sm" muted>
        {HELP}
      </Text>
      {loaded.status === 'loading' ? <Skeleton lines={2} label="Loading Teams channels" /> : null}
      {loaded.status === 'failed' ? <LoadFailure message={loaded.message} onRetry={loadChannels} /> : null}
      {loaded.status === 'ready' ? shownChannels().map(channel => <ChannelRow key={channel.id} channel={channel} />) : null}
      <AddChannel />
      <Row gap="sm">
        <Button variant="ghost" onPress={closeChannels}>
          Back
        </Button>
      </Row>
    </Stack>
  )
}
