import { Button, CodeView, Input, read, Row, set, Skeleton, Stack, Table, Text, Textarea, type OrcaNode, type TableColumn } from 'orca'
import { MAX_REVIEW_COMMENT, type ChangedFile, type PrReview } from '../../../shared/reviews'
import { cutLabel } from '../../label'
import { LoadFailure } from '../../snapshot-parts'
import { FILE_THREADS_BYTES, fileRows, fitThreads, matchingFiles } from './fit'
import { comment, draftOf, fileDiff, fileFilter, isRunning, selectedFile, selectFile, setDraft } from './state'
import { ResultCallout, ThreadCard, ThreadsLeftOut } from './threads'

const COLUMNS: readonly TableColumn[] = [
  { key: 'change', label: 'Change', width: 'sm' },
  { key: 'path', label: 'File' }
]

const NEW_SIDE_HINT = 'Line numbers refer to the new version: the second number on each diff line.'
const OLD_SIDE_HINT = 'Line numbers refer to the old version: the first number on each diff line.'

function rowKeys(files: readonly ChangedFile[]): Map<string, string> {
  return new Map(files.map((file, index) => [file.path, cutLabel(file.path) === file.path ? file.path : `#long-path-${index}`]))
}

function Diff({ file }: { file: ChangedFile }): OrcaNode {
  const load = read(fileDiff)
  if (load?.path !== file.path) return null
  if (load.status === 'loading') return <Skeleton lines={6} label="Loading the diff" />
  if (load.status === 'failed') return <LoadFailure message={load.message} onRetry={() => selectFile(file.path)} />
  const { text, message } = load.diff
  return (
    <Stack gap="xs">
      {message ? (
        <Text size="sm" muted>
          {message}
        </Text>
      ) : null}
      {text !== null ? <CodeView code={text} language="diff" label={cutLabel(`Diff of ${file.path}`)} lineNumbers={false} maxHeight="lg" /> : null}
    </Stack>
  )
}

function SelectedFile({ review, file }: { review: PrReview; file: ChangedFile }): OrcaNode {
  const threads = review.threads.filter(thread => thread.anchor !== null && (thread.anchor.path === file.path || thread.anchor.path === file.originalPath))
  const { shown } = fitThreads(threads, FILE_THREADS_BYTES)
  const slot = `file:${file.path}`
  const lineSlot = `line:${file.path}`
  return (
    <Stack gap="sm">
      <Text weight="semibold" truncate>
        {file.path}
      </Text>
      <Diff file={file} />
      {shown.map(thread => (
        <ThreadCard key={thread.id} thread={thread} />
      ))}
      {shown.length < threads.length ? (
        <Text size="sm" muted>
          {`Showing ${shown.length} of ${threads.length} comment threads on this file. Open the pull request in Azure DevOps for the rest.`}
        </Text>
      ) : null}
      <ThreadsLeftOut shown={review.threads.length} total={review.threadCount} />
      <Text size="sm" muted>
        {file.kind === 'deleted' ? OLD_SIDE_HINT : NEW_SIDE_HINT}
      </Text>
      <Input label="Line (optional)" placeholder="42" maxLength={7} value={draftOf(lineSlot)} onChange={text => setDraft(lineSlot, text)} />
      <Textarea label="Comment on this file" rows={3} maxLength={MAX_REVIEW_COMMENT} value={draftOf(slot)} onChange={text => setDraft(slot, text)} />
      <Row gap="sm">
        <Button disabled={isRunning(slot)} onPress={() => comment({ text: draftOf(slot), path: file.path, lineText: draftOf(lineSlot) })}>
          Comment on file
        </Button>
      </Row>
      <ResultCallout slot={slot} />
    </Stack>
  )
}

export function FilesSection({ review }: { review: PrReview }): OrcaNode {
  const filter = read(fileFilter)
  const keys = rowKeys(review.files)
  const rows = fileRows(review.files, filter)
  const matching = matchingFiles(review.files, filter).length
  const selectedPath = read(selectedFile)
  const selected = review.files.find(file => file.path === selectedPath) ?? null
  const selectedKey = selected !== null && rows.includes(selected) ? keys.get(selected.path) : undefined
  return (
    <Stack gap="md">
      <Input type="search" label="Filter files" labelHidden placeholder="Filter files" value={filter} onChange={text => set(fileFilter, text)} />
      <Table
        label="Changed files"
        selectionMode="single"
        maxHeight="md"
        emptyText="No files match."
        columns={COLUMNS}
        rows={rows.map(file => ({ key: keys.get(file.path) ?? file.path, cells: { change: file.kind, path: cutLabel(file.path) } }))}
        selected={selectedKey === undefined ? [] : [selectedKey]}
        onSelectionChange={({ keys: picked }) => {
          const file = rows.find(row => keys.get(row.path) === picked[0])
          if (file && file.path !== read(selectedFile)) void selectFile(file.path)
        }}
      />
      {rows.length < matching ? (
        <Text size="sm" muted>
          {`Showing ${rows.length} of ${matching} files. Filter to narrow the list.`}
        </Text>
      ) : null}
      {selected !== null ? <SelectedFile review={review} file={selected} /> : null}
    </Stack>
  )
}
