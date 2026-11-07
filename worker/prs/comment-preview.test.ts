import { assert, test } from 'orca/testing'
import { ME } from './fake-prs'
import { commentPreview } from './comment-preview'

const PEOPLE = new Map([[ME, 'Alex Contoso']])

test('a comment preview is its first line as plain text', () => {
  const cases: [string, string][] = [
    ['Plain words.', 'Plain words.'],
    ['\n  \n\tSecond try\nthird', 'Second try'],
    ['**Bold**, __strong__, *em*, _em_, `code_span` and ~~gone~~', 'Bold, strong, em, em, code_span and gone'],
    ['snake_case_name and 2*3*4 stay', 'snake_case_name and 2*3*4 stay'],
    ['> - [the doc](https://dev.azure.com/contoso/x?token=abc) and ![shot](https://example.com/y.png)', 'the doc and shot'],
    ['# Heading\nbody', 'Heading'],
    ['12. numbered item', 'numbered item'],
    ['<p>Hello&nbsp;<b>there</b> &amp; you</p><p>next</p>', 'Hello there & you'],
    ['<!-- hidden -->\nShown', 'Shown'],
    ['see <https://example.com/x?sig=abc> now', 'see now'],
    ['```ts\nconst a = 1\n```', 'const a = 1'],
    [`@<${ME.toUpperCase()}> please look`, '@Alex Contoso please look'],
    ['@<00000000-0000-4000-8000-000000000000> hi', '@Unknown hi'],
    ['a \\*literal\\* star and \\_under\\_', 'a *literal* star and _under_'],
    ['', ''],
    ['![](https://example.com/only-an-image.png)', '']
  ]
  for (const [content, expected] of cases) assert.equal(commentPreview(content, PEOPLE), expected, JSON.stringify(content))
})

test('a comment preview keeps code spans verbatim', () => {
  const cases: [string, string][] = [
    ['`__init__` runs first', '__init__ runs first'],
    ['`*not em*` but *em*', '*not em* but em'],
    ['`a_b_c` and `~~x~~` and _y_', 'a_b_c and ~~x~~ and y']
  ]
  for (const [content, expected] of cases) assert.equal(commentPreview(content, PEOPLE), expected, JSON.stringify(content))
})

test('a comment preview carries no URL, whatever form it takes', () => {
  const cases: [string, string][] = [
    ['see https://dev.azure.com/contoso/_apis/x?sig=SECRET123 now', 'see now'],
    ['[ref]: https://example.com/x?token=abc\nafter', 'after'],
    ['> [ref]: <https://example.com/x?token=abc> "Title"', ''],
    ['[https://example.com/x?sig=abc](https://example.com/x?sig=abc) done', 'done'],
    ['see &lt;https://example.com/x?sig=abc&gt; now', 'see now'],
    ['`https://example.com/x?sig=abc` and **ftp://host/a_b?sig=1** gone', 'and gone'],
    ['https://example.com/x?sig=a\\_b ok', 'ok'],
    ['see ...https://dev.azure.com/x?sig=SECRET123 now', 'see now'],
    ['step 2.https://example.com/x?sig=abc done', 'step done'],
    ['see https:\\/\\/dev.azure.com/x?sig=SECRET123 now', 'see now'],
    ['[doc](https://x.com/a_(b)?sig=SECRET123) now', 'doc now'],
    ['see www.example.com/x?sig=abc now', 'see now'],
    ['[WIP]: fix the thing', '[WIP]: fix the thing']
  ]
  for (const [content, expected] of cases) assert.equal(commentPreview(content, PEOPLE), expected, JSON.stringify(content))
})

test('a pathological comment previews in well under a second', () => {
  const cases: [string, string][] = [
    ['one 100,000-char token', 'a'.repeat(100_000)],
    ['a dotted run', 'a.'.repeat(75_000)],
    ['a digit before a long run', '1' + 'a'.repeat(149_999)],
    ['open brackets', '['.repeat(150_000)],
    ['unclosed links', '[a]('.repeat(37_500)],
    ['unclosed strong', '**a '.repeat(37_500)],
    ['unclosed emphasis', '*a '.repeat(50_000)],
    ['unclosed code spans', '`a'.repeat(75_000)],
    ['unclosed HTML comments', '<!--'.repeat(37_500)]
  ]
  for (const [name, content] of cases) {
    const started = performance.now()
    commentPreview(content, PEOPLE)
    const took = performance.now() - started
    assert.ok(took < 250, `${name} took ${Math.round(took)} ms`)
  }
})

test('a long comment cut anywhere near a URL still previews without it', () => {
  for (let at = 3900; at <= 4100; at++) {
    const words = 'word '.repeat(Math.ceil(at / 5)).slice(0, at)
    const preview = commentPreview(`${words}https://dev.azure.com/x?sig=SECRET123 tail`, PEOPLE)
    assert.ok(preview.startsWith('word word'), `cut at ${at}`)
    assert.ok(!/sig|SECRET|:\/\//.test(preview), `cut at ${at}: ${preview.slice(-40)}`)
  }
})
