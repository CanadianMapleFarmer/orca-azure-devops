import { Button, Callout, Card, Heading, IconButton, Link, Markdown, read, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { draftKey, type WikiPage } from '../../shared/wiki'
import { counted, OPEN_IN_TAB } from '../copy'
import { cutLabel } from '../label'
import { LoadFailure } from '../snapshot-parts'
import { backLabel, pageSegments, type PageSegment } from './segments'
import { closePage, edit, isRunning, loadedPage, loadPageWhenIdle, openInTab, openPage, outcomeOf, pageLoad, readKey, reloadPage } from './state'

const openable = (url: string): boolean => /^https?:\/\//i.test(url) && url.length <= 2048

function Title({ title, path }: { title: string; path: string }): OrcaNode {
  return (
    <Stack gap="xs">
      <Link onPress={closePage}>{backLabel(path)}</Link>
      <Heading level={3}>{title}</Heading>
    </Stack>
  )
}

function OpenInTab({ page, variant }: { page: WikiPage; variant: 'solid' | 'outline' }): OrcaNode {
  return (
    <Button size="sm" variant={variant} disabled={isRunning(readKey(page))} onPress={() => openInTab(page)}>
      {OPEN_IN_TAB}
    </Button>
  )
}

function Header({ page, loading }: { page: WikiPage; loading: boolean }): OrcaNode {
  const editKey = draftKey(page)
  const edited = page.editable ? outcomeOf(editKey) : undefined
  const tabbed = outcomeOf(readKey(page))
  return (
    <Stack gap="xs">
      <Title title={page.title} path={page.path} />
      <Row gap="sm" align="center" wrap>
        <OpenInTab page={page} variant="solid" />
        {page.editable ? (
          <Button size="sm" variant="outline" icon="edit" disabled={isRunning(editKey)} onPress={() => edit(page)}>
            Edit in Orca
          </Button>
        ) : null}
        {openable(page.url) ? <Link href={page.url}>Open in Azure DevOps</Link> : null}
        <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" disabled={loading} onPress={reloadPage} />
      </Row>
      {edited?.status === 'opened' || edited?.status === 'refused' ? (
        <Callout tone={edited.status === 'opened' ? 'accent' : 'danger'}>{edited.message}</Callout>
      ) : null}
      {tabbed?.status === 'refused' ? <Callout tone="danger">{tabbed.message}</Callout> : null}
      {page.notice ? (
        <Text size="sm" muted>
          {page.notice}
        </Text>
      ) : null}
    </Stack>
  )
}

function Segment({ page, segment }: { page: WikiPage; segment: PageSegment }): OrcaNode {
  if (segment.kind === 'markdown') return <Markdown content={segment.refs === '' ? segment.text : `${segment.text}\n\n${segment.refs}`} />
  const title = segment.kind === 'diagram' ? `Diagram · ${segment.diagram}` : `Table · ${counted(segment.columns.length, 'column', 'columns')}`
  const description = segment.kind === 'table' ? cutLabel(segment.columns.join(' · ')) : undefined
  return (
    <Card title={title} description={description}>
      <Row>
        <OpenInTab page={page} variant="outline" />
      </Row>
    </Card>
  )
}

function Content({ page }: { page: WikiPage }): OrcaNode {
  if (page.content.trim() === '') return <Text muted>This page has no content yet.</Text>
  const shown = pageSegments(page.content).filter(segment => segment.kind !== 'markdown' || segment.text.trim() !== '')
  return (
    <Stack gap="sm">
      {shown.map(segment => (
        <Segment key={segment.kind === 'markdown' ? `markdown:${segment.first}` : segment.key} page={page} segment={segment} />
      ))}
    </Stack>
  )
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
      <Header page={page} loading={load.status === 'loading'} />
      {load.status === 'failed' ? <Callout tone="danger">{load.message}</Callout> : null}
      <Content page={page} />
    </Stack>
  )
}
