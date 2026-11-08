import { Box, Button, Callout, EmptyState, IconButton, Input, List, ListItem, read, Row, Select, set, Skeleton, Stack, Text, Tree, type OrcaNode } from 'orca'
import type { WikiLevel, WikiNode, WikiRef } from '../../shared/wiki'
import type { OrgStatus } from '../../shared/types'
import { COLLAPSE_ALL, EXPAND_ALL } from '../copy'
import { cutLabel } from '../label'
import { LoadFailure } from '../snapshot-parts'
import { Drafts } from './drafts'
import { PageView } from './page-view'
import {
  chooseWiki,
  chosenWiki,
  clearSearch,
  collapseAll,
  expandAll,
  expanded,
  found,
  levelRef,
  levels,
  loadWikiWhenIdle,
  openPage,
  query,
  refreshingTree,
  refreshTree,
  retryRoot,
  retryWikis,
  ROOT,
  rootLoad,
  search,
  searching,
  searchNotice,
  selectedIn,
  showPage,
  toggleFolder,
  treeItems,
  treeKey,
  treeNotice,
  wikis,
  wikisLoad,
  type Found
} from './state'

const countText = (total: number): string => (total === 0 ? 'No pages match.' : total === 1 ? '1 page matches' : `${total} pages match`)

function Picker({ org, wiki }: { org: string; wiki: WikiRef }): OrcaNode {
  const list = read(wikis)
  if (list.length < 2) {
    return (
      <Text weight="semibold" truncate>
        {wiki.name}
      </Text>
    )
  }
  return (
    <Select
      label="Wiki"
      value={wiki.id}
      options={list.map(item => ({ value: item.id, label: cutLabel(`${item.name} · ${item.projectName}`) }))}
      onChange={value => chooseWiki(org, value)}
    />
  )
}

function Header({ org }: { org: string }): OrcaNode {
  const status = read(wikisLoad)
  if (status.status === 'failed') return <LoadFailure message={status.message} onRetry={retryWikis} />
  if (status.status !== 'ready') return <Skeleton lines={3} label="Loading wikis" />
  const wiki = chosenWiki(org)
  if (!wiki) return <EmptyState title="No wikis" description="Project wikis and published code wikis in this organization show up here." />
  const notice = read(searchNotice)
  const unavailable = !read(levels).has(ROOT) || read(refreshingTree)
  return (
    <Stack gap="xs">
      <Picker org={org} wiki={wiki} />
      <Row gap="xs" align="center">
        <Box grow shrink minWidth={0}>
          <Input
            type="search"
            label="Search the wiki"
            labelHidden
            placeholder="Search the wiki"
            value={read(query)}
            onChange={text => set(query, text)}
            onSubmit={text => search(text)}
          />
        </Box>
        <IconButton icon="collapse" label={COLLAPSE_ALL} variant="ghost" size="sm" disabled={unavailable} onPress={collapseAll} />
        <IconButton icon="expand" label={EXPAND_ALL} variant="ghost" size="sm" disabled={unavailable} onPress={() => expandAll()} />
        <IconButton icon="refresh" label="Refresh pages" variant="ghost" size="sm" disabled={unavailable} onPress={() => refreshTree()} />
      </Row>
      {notice ? <Callout tone="danger">{notice}</Callout> : null}
    </Stack>
  )
}

function Results({ org, wiki, result }: { org: string; wiki: WikiRef; result: Found }): OrcaNode {
  const { hits, total } = result
  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="sm">
        <Text size="sm" muted>
          {countText(total)}
        </Text>
        <Button size="sm" variant="ghost" onPress={clearSearch}>
          Clear search
        </Button>
      </Row>
      {hits.length > 0 ? (
        <List label="Search results">
          {hits.map(hit => (
            <ListItem
              key={hit.path}
              title={cutLabel(hit.title)}
              description={cutLabel(`${hit.path} · ${hit.snippet}`)}
              onPress={() => showPage({ ...levelRef({ org, wiki }, hit.path), title: hit.title })}
            />
          ))}
        </List>
      ) : null}
      {total > hits.length ? (
        <Text size="sm" muted>
          {`Showing ${hits.length} of ${total} pages. Narrow the search to see others.`}
        </Text>
      ) : null}
    </Stack>
  )
}

function nodeAt(all: ReadonlyMap<string, WikiLevel>, path: string): WikiNode | undefined {
  for (const level of all.values()) {
    const node = level.pages.find(page => page.path === path)
    if (node) return node
  }
  return undefined
}

function Pages({ org, wiki }: { org: string; wiki: WikiRef }): OrcaNode {
  const loaded = read(levels)
  if (!loaded.has(ROOT)) {
    const status = read(rootLoad)
    return status.status === 'failed' ? <LoadFailure message={status.message} onRetry={retryRoot} /> : <Skeleton lines={3} label="Loading pages" />
  }
  const open = read(expanded)
  const { items, capped } = treeItems(loaded, open)
  const notice = read(treeNotice)
  return (
    <Stack gap="xs">
      {notice ? <Callout tone="danger">{notice}</Callout> : null}
      {items.length === 0 ? (
        <EmptyState title="No pages yet" description="Pages in this wiki show up here." />
      ) : (
        <Tree
          key={`pages-${read(treeKey)}`}
          label="Pages"
          maxHeight="lg"
          items={items}
          selected={selectedIn(items, { org, wiki })}
          expanded={open}
          onToggle={({ key, expanded: next }) => toggleFolder(levelRef({ org, wiki }, key), next)}
          onSelect={({ key }) => {
            const node = nodeAt(loaded, key)
            if (node) showPage({ ...levelRef({ org, wiki }, node.path), title: node.title })
          }}
        />
      )}
      {capped && items.length > 0 ? (
        <Text size="sm" muted>
          Some pages are hidden. Collapse a folder to see others.
        </Text>
      ) : null}
    </Stack>
  )
}

function Browse({ org }: { org: string }): OrcaNode {
  if (read(wikisLoad).status !== 'ready') return null
  const wiki = chosenWiki(org)
  if (!wiki) return null
  const result = read(found)
  if (read(searching)) return <Skeleton lines={3} label="Searching the wiki" />
  return result ? <Results org={org} wiki={wiki} result={result} /> : <Pages org={org} wiki={wiki} />
}

export function WikiTab({ org }: { org: OrgStatus }): OrcaNode {
  const page = read(openPage)
  if (page && page.org === org.org) return <PageView />
  loadWikiWhenIdle(org.org)
  return (
    <Stack gap="md">
      <Header org={org.org} />
      <Drafts />
      <Browse org={org.org} />
    </Stack>
  )
}
