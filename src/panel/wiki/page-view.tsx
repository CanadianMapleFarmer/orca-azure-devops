import { Button, Callout, Heading, IconButton, Link, Markdown, read, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { draftKey, type WikiPage } from '../../shared/wiki'
import { LoadFailure } from '../snapshot-parts'
import { closePage, edit, isRunning, loadedPage, loadPageWhenIdle, openPage, outcomeOf, pageLoad, reloadPage } from './state'

const openable = (url: string): boolean => /^https?:\/\//i.test(url) && url.length <= 2048

function Title({ title, path }: { title: string; path: string }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row>
        <IconButton icon="close" label="Back" variant="ghost" size="sm" onPress={closePage} />
      </Row>
      <Heading level={3}>{title}</Heading>
      <Text muted size="sm">
        {path}
      </Text>
    </Stack>
  )
}

function Edit({ page }: { page: WikiPage }): OrcaNode {
  const key = draftKey(page)
  const outcome = outcomeOf(key)
  return (
    <Stack gap="xs">
      <Row gap="sm">
        <Button size="sm" icon="edit" disabled={isRunning(key)} onPress={() => edit(page)}>
          Edit in Orca
        </Button>
      </Row>
      {outcome?.status === 'opened' || outcome?.status === 'refused' ? (
        <Callout tone={outcome.status === 'opened' ? 'accent' : 'danger'}>{outcome.message}</Callout>
      ) : null}
    </Stack>
  )
}

function Content({ content }: { content: string }): OrcaNode {
  return content.trim() === '' ? <Text muted>This page has no content yet.</Text> : <Markdown content={content} />
}

export function PageView(): OrcaNode {
  const open = read(openPage)
  if (open === null) return null
  loadPageWhenIdle()
  const page = read(loadedPage)
  const load = read(pageLoad)
  if (page === null) {
    return (
      <Stack gap="md">
        <Title title={open.title} path={open.path} />
        {load.status === 'failed' ? <LoadFailure message={load.message} onRetry={reloadPage} /> : <Skeleton lines={6} label="Loading the page" />}
      </Stack>
    )
  }
  return (
    <Stack gap="md">
      <Title title={page.title} path={page.path} />
      {page.editable ? <Edit page={page} /> : null}
      <Row gap="sm" align="center" wrap>
        {openable(page.url) ? <Link href={page.url}>Open in Azure DevOps</Link> : null}
        <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={load.status === 'loading'} onPress={reloadPage} />
      </Row>
      {load.status === 'failed' ? <Callout tone="danger">{load.message}</Callout> : null}
      {page.notice ? (
        <Text size="sm" muted>
          {page.notice}
        </Text>
      ) : null}
      <Content content={page.content} />
    </Stack>
  )
}
