import { assert, test } from 'orca/testing'
import { htmlToMarkdown } from './html'

const itemUrl = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/42'
const SUFFIX = '\n\n… open in Azure DevOps for the rest'
const md = (html: string, maxChars = 10_000) => htmlToMarkdown(html, { maxChars, itemUrl })

test('converts the common tags', () => {
  const cases: [string, string, string][] = [
    ['paragraphs', '<p>one</p><p>two</p>', 'one\n\ntwo'],
    ['divs', '<div>one</div><div>two</div>', 'one\n\ntwo'],
    ['line break', 'one<br>two<br/>three', 'one\ntwo\nthree'],
    ['bold', 'a <b>bold</b> and <strong>strong</strong>', 'a **bold** and **strong**'],
    ['italic', 'a <i>it</i> and <em>em</em>', 'a *it* and *em*'],
    ['headings', '<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4>', '# A\n\n## B\n\n### C\n\n#### D'],
    ['link', 'see <a href="https://example.com/a?b=1&amp;c=2">the docs</a>', 'see [the docs](https://example.com/a?b=1&c=2)'],
    ['mailto', '<a href="mailto:dev@fabrikam.test">mail</a>', '[mail](mailto:dev@fabrikam.test)'],
    ['inline code', 'run <code>npm test</code> now', 'run `npm test` now'],
    ['pre block', '<pre>line 1\n  line 2</pre><p>after</p>', '```\nline 1\n  line 2\n```\n\nafter'],
    ['pre with code and br', '<pre><code>a &lt; b<br>c</code></pre>', '```\na < b\nc\n```'],
    ['bullets', '<ul><li>one</li><li>two</li></ul>', '- one\n- two'],
    ['ordered', '<ol><li>one</li><li>two</li></ol>', '1. one\n2. two'],
    ['nested lists', '<ul><li>a<ul><li>b<ol><li>c</li><li>d</li></ol></li></ul></li><li>e</li></ul>', '- a\n  - b\n    1. c\n    2. d\n- e'],
    ['numbering restarts per list', '<ol><li>a</li></ol><p>x</p><ol><li>b</li><li>c</li></ol>', '1. a\n\nx\n\n1. b\n2. c'],
    ['paragraph inside an item', '<ul><li><p>a</p></li><li><p>b</p></li></ul>', '- a\n- b'],
    ['list after text', 'intro<ul><li>a</li></ul>outro', 'intro\n\n- a\n\noutro'],
    ['image', 'before <img src="https://example.com/x.png" alt="x"> after', `before [image](${itemUrl}) after`],
    ['unknown tags keep their text', '<section><span style="color:red">hi</span> <u>there</u></section>', 'hi there'],
    ['comments and doctype are dropped', '<!DOCTYPE html><!-- note -->text', 'text'],
    ['empty formatting leaves no markers', '<div><b><br></b></div><p>x <i></i>y</p>', 'x y'],
    ['whitespace is collapsed', '<p>  a \n\n  b\t c </p>', 'a b c'],
    ['blank paragraphs collapse', '<p>a</p><p>&nbsp;</p><p></p><div><br></div><p>b</p>', 'a\n\nb'],
    ['entities', '&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; a&nbsp;b &amp;lt;', '& <b> "q" \'s\' AB a b &lt;'],
  ]
  for (const [name, html, expected] of cases) assert.equal(md(html), expected, name)
})

test('links keep only http, https and mailto targets', () => {
  assert.equal(md('<a href="javascript:alert(1)">click</a>'), 'click')
  assert.equal(md('<a href=" JavaScript:alert(1)">click</a>'), 'click')
  assert.equal(md('<a href="data:text/html,x">click</a>'), 'click')
  assert.equal(md('<a href="ftp://example.com">click</a>'), 'click')
  assert.equal(md('<a name="anchor">click</a>'), 'click')
  assert.equal(md('<a href=http://example.com/x>bare</a>'), '[bare](http://example.com/x)')
  assert.equal(md("<a href='HTTPS://example.com'>single</a>"), '[single](HTTPS://example.com)')
  assert.equal(md('<a href="https://example.com/a(b) c">x</a>'), '[x](https://example.com/a%28b%29%20c)')
  assert.equal(md('<a href="https://example.com"></a>after'), 'after')
})

test('script, style and head are dropped with their contents', () => {
  assert.equal(md('<head><title>t</title></head><style>p{}</style>a<script>if (1 < 2) { x("</p>") }</script>b'), 'ab')
  assert.equal(md('a<SCRIPT type="text/javascript">never()</SCRIPT >b'), 'ab')
  assert.equal(md('a<script>unterminated <b>x</b>'), 'a')
  assert.equal(md('<header>kept</header>'), 'kept')
})

test('an image never exposes its src', () => {
  const out = md('<img src="https://cdn.contoso.test/secret.png?sig=abc">')
  assert.equal(out, `[image](${itemUrl})`)
  assert.ok(!out.includes('secret'))
})

test('htmlToMarkdown caps and strips', () => {
  const paragraph = '<p>Lorem <b>ipsum</b> &amp; dolor <a href="https://example.com/x">sit</a> amet.</p>\n'
  const html = '<script>steal()</script><img src="https://cdn.contoso.test/a.png">' + paragraph.repeat(1500)
  assert.ok(html.length > 100_000)
  const out = md(html, 2000)
  assert.ok(out.endsWith(SUFFIX))
  assert.ok(out.length <= 2000 + SUFFIX.length)
  assert.ok(!/<\/?[a-z]/i.test(out), 'no tags remain')
  assert.ok(!out.includes('steal'))
  assert.ok(out.includes(`[image](${itemUrl})`))
  const body = out.slice(0, -SUFFIX.length)
  assert.ok(body.endsWith('amet.'), 'cut on a line boundary')
})

test('the cap cuts at the last newline before maxChars, else at maxChars', () => {
  assert.equal(md('<p>aaaa</p><p>bbbb</p><p>cccc</p>', 12), 'aaaa\n\nbbbb' + SUFFIX)
  assert.equal(md('<p>aaaa</p><p>bbbb</p>', 10), 'aaaa\n\nbbbb')
  assert.equal(md('<p>' + 'x'.repeat(50) + '</p>', 20), 'x'.repeat(20) + SUFFIX)
  assert.equal(md('😀'.repeat(10), 5), '😀😀' + SUFFIX)
})

test('null and empty give ""', () => {
  for (const input of [null, undefined, '', '   ', '<p></p>', '<br>', '<!-- x -->'])
    assert.equal(md(input as string), '', String(input))
})

test('malformed HTML never throws', () => {
  const inputs = [
    '<p>unclosed <b>bold <i>italic',
    'a < b and c > d',
    '<',
    '<<<>>>',
    '<a href="https://example.com',
    '<div <p>>x',
    '</b></i></ul></li></pre>text</p>',
    '<ul><li>a<ol><li>b</ul></ol></li>',
    '<pre>never closed <b>x',
    '<script>never closed',
    '<!-- never closed',
    '<!doctype',
    '<a href="x"><a href="https://a.test">nested</a></a>',
    '<img src="x" <b>y</b>',
    '&#99999999999; &#x110000; &#0; &#xD800; &bogus; &',
    '<h2><b>mixed</h2></b>',
    '<b>'.repeat(5000) + 'deep' + '</b>'.repeat(5000),
    '<ul>'.repeat(2000) + '<li>deep</li>' + '</ul>'.repeat(2000),
    '<a "'.repeat(20_000),
    '<'.repeat(50_000),
    ' '.repeat(100_000) + '<pre>' + ' '.repeat(100_000) + '</pre>',
  ]
  for (const input of inputs) {
    const started = Date.now()
    assert.equal(typeof md(input), 'string')
    assert.ok(Date.now() - started < 1000, `slow on ${JSON.stringify(input.slice(0, 20))}`)
  }
  assert.equal(md('a < b and c > d'), 'a < b and c > d')
  assert.equal(md('<p>unclosed <b>bold <i>italic'), 'unclosed **bold *italic***')
  assert.equal(md('&#99999999999; &#0;'), '� �')
})
