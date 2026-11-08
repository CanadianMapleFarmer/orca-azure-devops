import { assert, test } from 'orca/testing'
import { backLabel, pageSegments, type PageSegment } from './segments'

function assertTiles(markdown: string, segments: readonly PageSegment[]): void {
  const lines = markdown.split('\n')
  let next = 0
  for (const segment of segments) {
    assert.equal(segment.first, next, `segment ${segment.first}..${segment.last} starts where the last one ended`)
    assert.ok(segment.last >= segment.first)
    if (segment.kind === 'markdown') assert.equal(segment.text, lines.slice(segment.first, segment.last + 1).join('\n'))
    next = segment.last + 1
  }
  assert.equal(next, lines.length, 'every line is covered')
}

const summary = (segments: readonly PageSegment[]) => segments.map(segment => [segment.kind, segment.first, segment.last])

const wide = (columns: number, row = 'x') => {
  const cells = (text: (index: number) => string) => `| ${Array.from({ length: columns }, (_, index) => text(index)).join(' | ')} |`
  return [cells(index => `Column ${index + 1}`), cells(() => '---'), cells(() => row)]
}

test('pageSegments keeps every line outside diagrams and wide tables', () => {
  const crlf = ['# Release', '', '::: mermaid', 'graph TD', '  A --> B', ':::', '', '| a | b | c | d |', '|---|---|---|---|', '| 1 | 2 | 3 | 4 |', 'After the table', ''].join('\r\n')
  const crlfSegments = pageSegments(crlf)
  assert.deepEqual(summary(crlfSegments), [
    ['markdown', 0, 1],
    ['diagram', 2, 5],
    ['markdown', 6, 6],
    ['table', 7, 9],
    ['markdown', 10, 11]
  ])
  assert.deepEqual(crlfSegments[1], { kind: 'diagram', key: 'diagram:2', first: 2, last: 5, diagram: 'flowchart' })
  assert.deepEqual(crlfSegments[3], { kind: 'table', key: 'table:7', first: 7, last: 9, columns: ['a', 'b', 'c', 'd'] })
  assertTiles(crlf, crlfSegments)

  const unclosed = ['Intro', '::: mermaid', 'graph TD', '| a | b | c | d |', '|---|---|---|---|', ''].join('\n')
  const unclosedSegments = pageSegments(unclosed)
  assert.deepEqual(summary(unclosedSegments), [
    ['markdown', 0, 0],
    ['diagram', 1, 5]
  ])
  assertTiles(unclosed, unclosedSegments)

  const fenced = ['~~~md', '```mermaid', 'graph TD', '```', '::: mermaid', 'pie', ':::', ...wide(5), '~~~', '', '```', ...wide(4), '```', 'After'].join('\n')
  const fencedSegments = pageSegments(fenced)
  assert.deepEqual(summary(fencedSegments), [['markdown', 0, fenced.split('\n').length - 1]])
  assertTiles(fenced, fencedSegments)

  const wideTable = wide(64, 'cell')
  const mixed = ['Start', '', ...wideTable, '', '| Name | Note |', '| --- | --- |', '| Deploy | Run it |', '', '```mermaid', 'pie', '```', '', ...wide(3, 'y'.repeat(20)), 'End'].join('\n')
  const mixedSegments = pageSegments(mixed)
  assert.deepEqual(summary(mixedSegments), [
    ['markdown', 0, 1],
    ['table', 2, 4],
    ['markdown', 5, 9],
    ['diagram', 10, 12],
    ['markdown', 13, 13],
    ['table', 14, 16],
    ['markdown', 17, 17]
  ])
  const table = mixedSegments[1]
  assert.equal(table.kind === 'table' && table.columns.length, 64)
  assert.equal(table.kind === 'table' && table.columns[63], 'Column 64')
  assert.equal(mixedSegments[3].kind === 'diagram' && mixedSegments[3].diagram, 'pie chart')
  assert.equal(mixedSegments[2].kind === 'markdown' && mixedSegments[2].text.includes('| Deploy | Run it |'), true, 'a narrow table stays in the text')
  assert.deepEqual(
    mixedSegments.flatMap(segment => (segment.kind === 'markdown' ? [] : [segment.key])),
    ['table:2', 'diagram:10', 'table:14']
  )
  assertTiles(mixed, mixedSegments)

  const interrupting = pageSegments('Intro\n| a | b | c | d |\n| - | - | - | - |')
  assert.deepEqual(summary(interrupting), [
    ['markdown', 0, 0],
    ['table', 1, 2]
  ])

  for (const page of ['', '\n', 'Plain', '::: mermaid', '```mermaid\npie\n```\n\n', '\r\n\r\n']) assertTiles(page, pageSegments(page))
})

test('a page whose link references and footnotes sit below a diagram keeps its links in the segment above', () => {
  const page = [
    'See [the guide][guide], [Docs] and a note.[^1] Also [no such label] and `[unused]`.',
    '',
    '```',
    '[unused]: https://contoso.example/code',
    'Say [hidden] here',
    '```',
    'Then [hidden] outside code.',
    '',
    '::: mermaid',
    'graph TD',
    '  A --> B',
    ':::',
    '',
    'Back to the [Guide] and [other thing][OTHER].',
    '',
    '[guide]: https://contoso.example/guide "Guide"',
    '[DOCS]: https://contoso.example/docs',
    '[other]: https://contoso.example/other',
    '[unused]: https://contoso.example/unused',
    '',
    '```',
    '[hidden]: https://contoso.example/hidden',
    '```',
    '[^1]: A footnote',
    '    that goes on.',
    '[^2]: Never used'
  ].join('\n')
  const segments = pageSegments(page)
  assert.deepEqual(summary(segments), [
    ['markdown', 0, 7],
    ['diagram', 8, 11],
    ['markdown', 12, 25]
  ])
  assertTiles(page, segments)
  const above = segments[0]
  assert.equal(above.kind === 'markdown' && above.refs, ['[guide]: https://contoso.example/guide "Guide"', '[DOCS]: https://contoso.example/docs', '[^1]: A footnote\n    that goes on.'].join('\n\n'))
  const below = segments[2]
  assert.equal(below.kind === 'markdown' && below.refs, '', 'the definitions it holds are not copied back')

  const flipped = pageSegments(['[a]: https://contoso.example/a', '', '```mermaid', 'pie', '```', '', 'Use [A] and [A][].'].join('\n'))
  assert.deepEqual(
    flipped.map(segment => segment.kind === 'markdown' && segment.refs),
    ['', false, '[a]: https://contoso.example/a']
  )
  const twice = pageSegments(['See [a].', '', '::: mermaid', 'pie', ':::', '', '[a]: https://contoso.example/first', '[A]: https://contoso.example/second'].join('\n'))
  assert.equal(twice[0].kind === 'markdown' && twice[0].refs, '[a]: https://contoso.example/first', 'the first definition of a label wins')
  assert.deepEqual(
    pageSegments('No links here.\n\n::: mermaid\npie\n:::\n\nNor here.').map(segment => segment.kind === 'markdown' && segment.refs),
    ['', false, '']
  )
})

test("backLabel names the page's parent, or All pages for a top-level page", () => {
  assert.equal(backLabel('/Home'), '‹ All pages')
  assert.equal(backLabel('/Release process/Checklist'), '‹ Release process')
  assert.equal(backLabel('/Release process/Checklist/Rollback'), '‹ Release process / Checklist')
  assert.equal(backLabel('/'), '‹ All pages')
  assert.equal(backLabel(''), '‹ All pages')
})
