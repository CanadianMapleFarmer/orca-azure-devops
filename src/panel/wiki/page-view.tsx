import { Box, Button, Callout, Heading, IconButton, Link, Markdown, read, Row, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { draftKey, type WikiPage } from '../../shared/wiki'
import { counted, OPEN_IN_TAB } from '../copy'
import { cutLabel } from '../label'
import { LoadFailure } from '../snapshot-parts'
import { backLabel, pageSegments, type PageSegment } from './segments'
import { closePage, edit, isRunning, linkKey, loadedPage, loadPageWhenIdle, openInTab, openLink, openPage, outcomeOf, pageLoad, readKey, reloadPage } from './state'

const openable = (url: string): boolean => /^https?:\/\//i.test(url) && url.length <= 2048

function Title({ title, path }: { title: string; path: string }): OrcaNode {
  return (
    <Stack gap="xs">
      <Row>
        <Link onPress={closePage}>{backLabel(path)}</Link>
      </Row>
      <Heading level={2}>{title}</Heading>
    </Stack>
  )
}

function OpenInTab({ page, primary }: { page: WikiPage; primary: boolean }): OrcaNode {
  return (
    <Button
      size="xs"
      variant={primary ? 'solid' : 'outline'}
      tone={primary ? 'accent' : undefined}
      icon="open-external"
      disabled={isRunning(readKey(page))}
      onPress={() => openInTab(page)}
    >
      {OPEN_IN_TAB}
    </Button>
  )
}

function Header({ page, loading }: { page: WikiPage; loading: boolean }): OrcaNode {
  const editKey = draftKey(page)
  const edited = page.editable ? outcomeOf(editKey) : undefined
  const tabbed = outcomeOf(readKey(page))
  const linked = outcomeOf(linkKey(page))
  return (
    <Stack gap="xs">
      <Title title={page.title} path={page.path} />
      <Row justify="between" align="center">
        <Row gap="xs" align="center" wrap>
          <OpenInTab page={page} primary />
          {page.editable ? (
            <Button size="xs" variant="outline" icon="edit" disabled={isRunning(editKey)} onPress={() => edit(page)}>
              Edit in Orca
            </Button>
          ) : null}
          {openable(page.url) ? <IconButton icon="globe" label="Open in Azure DevOps" size="xs" variant="ghost" onPress={() => openLink(page, page.url)} /> : null}
        </Row>
        <IconButton icon="refresh" label="Refresh" size="xs" variant="ghost" disabled={loading} onPress={reloadPage} />
      </Row>
      {edited?.status === 'opened' || edited?.status === 'refused' ? (
        <Callout tone={edited.status === 'opened' ? 'accent' : 'danger'}>{edited.message}</Callout>
      ) : null}
      {tabbed?.status === 'refused' ? <Callout tone="danger">{tabbed.message}</Callout> : null}
      {linked?.status === 'refused' ? <Callout tone="danger">{linked.message}</Callout> : null}
      {page.notice ? (
        <Text size="xs" muted>
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
    <Box border radius="md" background="muted" padding="sm" gap="xs">
      <Text size="sm" weight="semibold">
        {title}
      </Text>
      {description ? (
        <Text size="xs" muted>
          {description}
        </Text>
      ) : null}
      <Row>
        <OpenInTab page={page} primary={false} />
      </Row>
    </Box>
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
      <Stack gap="sm">
        <Title title={open.title} path={open.path} />
        {load.status === 'failed' ? <LoadFailure message={load.message} onRetry={reloadPage} /> : <Skeleton lines={6} label="Loading the page" />}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Header page={page} loading={load.status === 'loading'} />
      {load.status === 'failed' ? <Callout tone="danger">{load.message}</Callout> : null}
      <Content page={page} />
    </Stack>
  )
}
