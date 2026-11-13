import { assert, test } from 'orca/testing'
import { find, findAll, textOf, withFakeDom, type FakeNode } from './fake-dom'
import { parseBlocks, parseInline, renderRich, safeHref, type Inline } from './rich-text'

const text = (value: string): Inline => ({ kind: 'text', text: value })
const strong = (...children: Inline[]): Inline => ({ kind: 'strong', children })
const em = (...children: Inline[]): Inline => ({ kind: 'em', children })
const code = (value: string): Inline => ({ kind: 'code', text: value })
const link = (href: string, ...children: Inline[]): Inline => ({ kind: 'link', href, children })
const BREAK: Inline = { kind: 'break' }
const paragraph = (...children: Inline[]) => ({ kind: 'paragraph', children })
const ignore = () => {}

function rendered(markdown: string, open: (url: string) => void = ignore): FakeNode {
  return renderRich(markdown, open) as unknown as FakeNode
}

test('paragraphs, line breaks, bold, italic and inline code parse into inline runs', () => {
  assert.deepEqual(parseBlocks('One line\nnext **bold** and *it* with `code`\n\nTwo'), [
    paragraph(text('One line'), BREAK, text('next '), strong(text('bold')), text(' and '), em(text('it')), text(' with '), code('code')),
    paragraph(text('Two')),
  ])
  assert.deepEqual(parseBlocks('# A\n\n## B\n\n### C\n\n#### D\n\n##### E'), [
    { kind: 'heading', level: 1, children: [text('A')] },
    { kind: 'heading', level: 2, children: [text('B')] },
    { kind: 'heading', level: 3, children: [text('C')] },
    { kind: 'heading', level: 4, children: [text('D')] },
    paragraph(text('##### E')),
  ])
  assert.deepEqual(parseInline('**a *b***'), [strong(text('a '), em(text('b')))])
  assert.deepEqual(parseInline('***x* y**'), [strong(em(text('x')), text(' y'))])
  assert.deepEqual(parseInline('**a****b**'), [strong(text('a')), strong(text('b'))])
  assert.deepEqual(parseInline('**a*b***'), [strong(text('a'), em(text('b')))])
  assert.deepEqual(parseInline('*a**b*'), [em(text('a')), em(text('b'))])
  assert.deepEqual(parseInline('*a**b**c*'), [em(text('a'), strong(text('b')), text('c'))])
  assert.deepEqual(parseInline('*ab**cd***'), [em(text('ab'), strong(text('cd')))])
  assert.deepEqual(parseInline('`` `x` `` and ```a``b```'), [code('`x`'), text(' and '), code('a``b')])
  assert.deepEqual(parseInline('**open, *half and 2 * 3 `tick'), [text('**open, *half and 2 * 3 `tick')])
})

test('nested lists keep their order and depth', () => {
  assert.deepEqual(parseBlocks('- a\n  - b\n- c\n\n1. d'), [
    { kind: 'list', ordered: false, items: [[paragraph(text('a')), { kind: 'list', ordered: false, items: [[paragraph(text('b'))]] }], [paragraph(text('c'))]] },
    { kind: 'list', ordered: true, items: [[paragraph(text('d'))]] },
  ])
  assert.deepEqual(parseBlocks('1. a\n   - b\n     - c\n2. d'), [
    {
      kind: 'list',
      ordered: true,
      items: [
        [paragraph(text('a')), { kind: 'list', ordered: false, items: [[paragraph(text('b')), { kind: 'list', ordered: false, items: [[paragraph(text('c'))]] }]] }],
        [paragraph(text('d'))],
      ],
    },
  ])
  assert.deepEqual(parseBlocks('- a\nmore\n-\n- b'), [{ kind: 'list', ordered: false, items: [[paragraph(text('a'), BREAK, text('more'))], [], [paragraph(text('b'))]] }])
  assert.deepEqual(parseBlocks('text\n- not an item'), [paragraph(text('text'), BREAK, text('- not an item'))])
})

function listDepth(blocks: ReturnType<typeof parseBlocks>): { depth: number; last: ReturnType<typeof parseBlocks> } {
  let depth = 0
  let inner = blocks
  for (let list = inner.find(block => block.kind === 'list'); list?.kind === 'list'; list = inner.find(block => block.kind === 'list')) {
    depth++
    inner = list.items[list.items.length - 1]
  }
  return { depth, last: inner }
}

test('list markers nested past 16 deep stay as text', () => {
  const { depth, last } = listDepth(parseBlocks('- '.repeat(20) + 'x'))
  assert.equal(depth, 16)
  assert.deepEqual(last, [paragraph(text('- - - - x'))])

  const lines = Array.from({ length: 20 }, (_, index) => `${'  '.repeat(index)}- line ${index + 1}`).join('\n')
  const indented = listDepth(parseBlocks(lines))
  assert.equal(indented.depth, 16)
  assert.deepEqual(indented.last.map(block => (block.kind === 'paragraph' ? block.children : block.kind)), [
    [text('line 16')],
    [text('- line 17')],
    [text('- line 18')],
    [text('- line 19')],
    [text('- line 20')],
  ])
})

test('1,500 and 10,000 nested list markers render quickly and no deeper than 16 lists', () => {
  withFakeDom(() => {
    for (const markers of [1_500, 10_000]) {
      const started = Date.now()
      const fragment = rendered('- '.repeat(markers) + 'x')
      assert.ok(Date.now() - started < 1000, `${markers} markers`)
      assert.equal(findAll(fragment, node => node.tagName === 'ul').length, 16)
      assert.ok(textOf(fragment).endsWith('- - x'))
    }
  })
})

test('a fenced code block keeps its text verbatim', () => {
  assert.deepEqual(parseBlocks('```\n<b>x</b> **y**\n```'), [{ kind: 'code', text: '<b>x</b> **y**' }])
  assert.deepEqual(parseBlocks('intro\n\n````\na\n```\n\nb\n````\n\nafter'), [paragraph(text('intro')), { kind: 'code', text: 'a\n```\n\nb' }, paragraph(text('after'))])
})

test('a fenced code block inside a list item stays code', () => {
  assert.deepEqual(parseBlocks('- Run it\n  ```\n  npm test\n  npm run lint\n  ```\n- Then ship'), [
    { kind: 'list', ordered: false, items: [[paragraph(text('Run it')), { kind: 'code', text: 'npm test\nnpm run lint' }], [paragraph(text('Then ship'))]] },
  ])
  assert.deepEqual(parseBlocks('1. ```\n   <img src=x onerror=alert(1)>\n   ```'), [{ kind: 'list', ordered: true, items: [[{ kind: 'code', text: '<img src=x onerror=alert(1)>' }]] }])
})

test('tables keep their header and cells, escaped pipes included', () => {
  assert.deepEqual(parseBlocks('| A | B\\|C |\n| --- | --- |\n| 1 | [x](https://x.test) |'), [
    { kind: 'table', header: [[text('A')], [text('B|C')]], rows: [[[text('1')], [link('https://x.test', text('x'))]]] },
  ])
  assert.deepEqual(parseBlocks('| a | `b\\|c` |\n|  | d |'), [{ kind: 'table', header: null, rows: [[[text('a')], [code('b|c')]], [[], [text('d')]]] }])
})

test('links keep only http, https and mailto targets', () => {
  assert.deepEqual(parseInline('[a](javascript:alert(1))'), [link('javascript:alert(1)', text('a'))])
  for (const unsafe of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'ftp://contoso.test', '/relative', 'dev.azure.com'])
    assert.equal(safeHref(unsafe), null, unsafe)
  assert.equal(safeHref('HTTPS://dev.azure.com/contoso'), 'https://dev.azure.com/contoso')
  assert.equal(safeHref('http://fabrikam.test/a'), 'http://fabrikam.test/a')
  assert.equal(safeHref('mailto:dev@contoso.com'), 'mailto:dev@contoso.com')

  withFakeDom(() => {
    const fragment = rendered('[a](javascript:alert(1)) [b](https://dev.azure.com/contoso) [c](mailto:dev@contoso.com)')
    const links = findAll(fragment, node => node.tagName === 'a')
    assert.deepEqual(links.map(node => [textOf(node), node.attributes.get('title')]), [['b', 'https://dev.azure.com/contoso'], ['c', 'mailto:dev@contoso.com']])
    assert.equal(textOf(fragment), 'a b c')
    assert.equal(find(fragment, node => node.attributes.has('href')), undefined)
  })
})

test('backslash escapes show the character itself', () => {
  assert.deepEqual(parseInline('\\*not em\\*'), [text('*not em*')])
  assert.deepEqual(parseInline('\\\\\\<img src=x> C:\\\\temp and \\[x\\](y)'), [text('\\<img src=x> C:\\temp and [x](y)')])
  assert.deepEqual(parseInline('C:\\temp'), [text('C:\\temp')])
})

test('emphasis nested 40,000 deep parses in under a second', () => {
  const started = Date.now()
  const runs = parseInline('**'.repeat(40_000) + 'x' + '**'.repeat(40_000))
  assert.ok(Date.now() - started < 1000)
  let depth = 0
  let inner = runs
  while (inner.length === 1 && inner[0].kind === 'strong') {
    depth++
    inner = inner[0].children
  }
  assert.equal(depth, 40_000)
  assert.deepEqual(inner, [text('x')])
})

test("the converter's other worst cases parse quickly", () => {
  const cases = [
    '**x'.repeat(64_000) + '**'.repeat(64_000),
    '[x'.repeat(12_000) + '](http://a.test)'.repeat(12_000),
    '[' + '](a'.repeat(30_000) + ' ' + ')'.repeat(30_000),
    '`'.repeat(1) + 'a``'.repeat(30_000),
    '- a\n' + '  '.repeat(1_000) + '- b',
  ]
  for (const markdown of cases) {
    const started = Date.now()
    parseBlocks(markdown)
    assert.ok(Date.now() - started < 1000, markdown.slice(0, 12))
  }
  const nested = parseInline('[x'.repeat(3) + '](http://a.test)'.repeat(3))
  assert.deepEqual(nested, [text('[x[x'), link('http://a.test', text('x')), text('](http://a.test)](http://a.test)')])
})

test('markup in the text shows as text', () => {
  withFakeDom(() => {
    const fragment = rendered('<script>alert(1)</script>')
    assert.deepEqual(fragment.children.map(node => node.tagName), ['p'])
    assert.equal(textOf(fragment.children[0]), '<script>alert(1)</script>')
    assert.equal(find(fragment, node => node.tagName === 'script'), undefined)
  })
})

test('renderRich builds headings, tight lists, code and tables from elements', () => {
  withFakeDom(() => {
    const opened: string[] = []
    const fragment = rendered('## Title\n\n### Sub\n\nSee **[docs](https://x.test)** *now*\nthen\n\n- one\n  ```\n  a < b\n  ```\n- two\n\n| H |\n| --- |\n| c |', url => opened.push(url))
    const shape = (node: FakeNode): unknown => (node.tagName === '#text' ? node.text : { [node.tagName]: node.children.map(shape) })
    assert.deepEqual(fragment.children.map(shape), [
      { h4: ['Title'] },
      { h5: ['Sub'] },
      { p: ['See ', { strong: [{ a: ['docs'] }] }, ' ', { em: ['now'] }, { br: [] }, 'then'] },
      { ul: [{ li: ['one', { pre: [{ code: ['a < b'] }] }] }, { li: ['two'] }] },
      { table: [{ tr: [{ th: ['H'] }] }, { tr: [{ td: ['c'] }] }] },
    ])
  })
})

test('emphasis nested 40,000 deep renders as shallow elements', () => {
  withFakeDom(() => {
    const fragment = rendered('**'.repeat(40_000) + 'x' + '**'.repeat(40_000))
    let depth = 0
    for (let node = fragment.children[0]; node.children.length > 0; node = node.children[0]) depth++
    assert.ok(depth < 50, `${depth} deep`)
    assert.equal(textOf(fragment), 'x')
  })
})
