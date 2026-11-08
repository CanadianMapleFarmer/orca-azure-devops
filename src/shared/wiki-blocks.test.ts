import { assert, test } from 'orca/testing'
import { diagramKind, mermaidBlocks, toFencedMermaid } from './wiki-blocks'

test('mermaidBlocks finds both forms, skips other fences and runs an unclosed block to the end', () => {
  const both = ['# Flow', '::: mermaid', 'graph TD', '  A --> B', ':::', '', '```mermaid', 'sequenceDiagram', '  A->>B: hi', '```', 'After']
  assert.deepEqual(mermaidBlocks(both), [
    { first: 1, last: 4, colon: true, body: 'graph TD\n  A --> B' },
    { first: 6, last: 9, colon: false, body: 'sequenceDiagram\n  A->>B: hi' }
  ])

  const spellings = ['   :::MERMAID  ', 'pie', '  :::  ', ':::  Mermaid', 'gantt', ':::', '~~~mermaid ', 'journey', '~~~~', '    ::: mermaid', '```Mermaid', 'x', '```']
  assert.deepEqual(mermaidBlocks(spellings), [
    { first: 0, last: 2, colon: true, body: 'pie' },
    { first: 3, last: 5, colon: true, body: 'gantt' },
    { first: 6, last: 8, colon: false, body: 'journey' }
  ])

  const insideOthers = ['~~~text', '::: mermaid', 'pie', ':::', '```mermaid', '~~~', '````', '```mermaid', 'graph LR', '```', '````', '`` ```mermaid', '::: mermaid', 'erDiagram', ':::']
  assert.deepEqual(mermaidBlocks(insideOthers), [{ first: 12, last: 14, colon: true, body: 'erDiagram' }])

  const crlf = '::: mermaid\r\ngraph TD\r\n  A --> B\r\n:::\r\n```mermaid\r\npie\r\n```\r\n'.split('\n')
  assert.deepEqual(mermaidBlocks(crlf), [
    { first: 0, last: 3, colon: true, body: 'graph TD\n  A --> B' },
    { first: 4, last: 6, colon: false, body: 'pie' }
  ])

  assert.deepEqual(mermaidBlocks(['Intro', ':::mermaid', 'graph TD', '```', 'A --> B']), [
    { first: 1, last: 4, colon: true, body: 'graph TD\n```\nA --> B' }
  ])
  assert.deepEqual(mermaidBlocks(['Intro', '```mermaid', 'graph TD', ':::', 'A --> B', '']), [
    { first: 1, last: 5, colon: false, body: 'graph TD\n:::\nA --> B\n' }
  ])
  assert.deepEqual(mermaidBlocks(['::: mermaid']), [{ first: 0, last: 0, colon: true, body: '' }])
  assert.deepEqual(mermaidBlocks(['No diagrams here.', '::: note', ':::']), [])
})

test('toFencedMermaid turns colon blocks into fences and leaves the rest alone', () => {
  const source = [
    '# Flow',
    '::: mermaid',
    'graph TD',
    '  A --> B',
    ':::',
    '',
    '```mermaid',
    'pie',
    '```',
    '~~~text',
    '::: mermaid',
    'not a diagram',
    ':::',
    '~~~',
    '  :::MERMAID ',
    'graph LR',
    '```',
    '  ````x',
    '   :::  ',
    'Tail ::: mermaid',
    ':::mermaid',
    'gantt'
  ].join('\n')
  const expected = [
    '# Flow',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    '```mermaid',
    'pie',
    '```',
    '~~~text',
    '::: mermaid',
    'not a diagram',
    ':::',
    '~~~',
    '`````mermaid',
    'graph LR',
    '```',
    '  ````x',
    '`````',
    'Tail ::: mermaid',
    '```mermaid',
    'gantt'
  ].join('\n')
  assert.equal(toFencedMermaid(source), expected)

  const crlf = 'Intro\r\n::: mermaid\r\ngraph TD\r\n:::\r\nAfter\r\n'
  assert.equal(toFencedMermaid(crlf), 'Intro\r\n```mermaid\r\ngraph TD\r\n```\r\nAfter\r\n')

  const untouched = 'Plain text\r\n\n```ts\nconst a = 1\n```\n::: note\n:::\n\t:::mermaid\n'
  assert.equal(toFencedMermaid(untouched), untouched)
  assert.equal(toFencedMermaid(''), '')
})

test('diagramKind names each Mermaid kind and falls back to diagram', () => {
  const cases: [string, string][] = [
    ['graph TD\n  A --> B', 'flowchart'],
    ['flowchart LR', 'flowchart'],
    ['sequenceDiagram\n  A->>B: hi', 'sequence diagram'],
    ['classDiagram', 'class diagram'],
    ['classDiagram-v2', 'class diagram'],
    ['stateDiagram', 'state diagram'],
    ['stateDiagram-v2', 'state diagram'],
    ['erDiagram', 'entity relationship diagram'],
    ['journey\n  title My day', 'user journey'],
    ['gantt', 'Gantt chart'],
    ['pie title Pets', 'pie chart'],
    ['gitGraph', 'git graph'],
    ['mindmap', 'mind map'],
    ['timeline', 'timeline'],
    ['quadrantChart', 'quadrant chart'],
    ['requirementDiagram', 'requirement diagram'],
    ['\n   \n%% a comment\n%%{init: {"theme": "dark"}}%%\n  graph TD', 'flowchart'],
    ['---\ntitle: Release flow\nconfig:\n  theme: dark\n---\nsequenceDiagram', 'sequence diagram'],
    ['\n---\ntitle: Pets\n---\n\n%% note\npie', 'pie chart'],
    ['gantt\r\n  title Release\r\n', 'Gantt chart'],
    ['C4Context', 'diagram'],
    ['Graph TD', 'diagram'],
    ['graphs', 'diagram'],
    ['---\ntitle: never closed\ngraph TD', 'diagram'],
    ['%% only a comment', 'diagram'],
    ['', 'diagram']
  ]
  for (const [body, kind] of cases) assert.equal(diagramKind(body), kind, JSON.stringify(body))
})
