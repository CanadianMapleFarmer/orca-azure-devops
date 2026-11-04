import { assert, test } from 'orca/testing'
import { htmlToMarkdown } from './html'

const itemUrl = 'https://dev.azure.com/contoso/Fabrikam%20Web/_workitems/edit/42'
const SUFFIX = '\n\n… open in Azure DevOps for the rest'
const md = (html: string, maxChars = 10_000) => htmlToMarkdown(html, { maxChars, itemUrl })
const SLOW_MS = 3000

function timed(html: string, maxChars = 10_000): string {
  const started = Date.now()
  const out = md(html, maxChars)
  assert.ok(Date.now() - started < SLOW_MS, `slow on ${JSON.stringify(html.slice(0, 20))}`)
  return out
}

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
    ['pre in a list item stays inside the item', '<ul><li>a<pre>x\ny</pre></li><li>b</li></ul>', '- a\n  ```\n  x\n  y\n  ```\n- b'],
    ['pre as the first thing in an item', '<ol><li><pre>&lt;img src=x onerror=alert(1)&gt;</pre></li></ol>', '1. ```\n   <img src=x onerror=alert(1)>\n   ```'],
    ['an item inside an item without a list keeps its own line', '<li><li><pre>&lt;img src=x&gt;</pre></li></li>', '-\n- ```\n  <img src=x>\n  ```'],
    ['pre with code and br', '<pre><code>a &lt; b<br>c</code></pre>', '```\na < b\nc\n```'],
    ['bullets', '<ul><li>one</li><li>two</li></ul>', '- one\n- two'],
    ['ordered', '<ol><li>one</li><li>two</li></ol>', '1. one\n2. two'],
    ['nested lists', '<ul><li>a<ul><li>b<ol><li>c</li><li>d</li></ol></li></ul></li><li>e</li></ul>', '- a\n  - b\n    1. c\n    2. d\n- e'],
    ['ul nested in ol indents three spaces', '<ol><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ol>', '1. a\n   - b\n     - c\n2. d'],
    ['ol nested in ol', '<ol><li>a<ol><li>b</li></ol></li></ol>', '1. a\n   1. b'],
    ['numbering restarts per list', '<ol><li>a</li></ol><p>x</p><ol><li>b</li><li>c</li></ol>', '1. a\n\nx\n\n1. b\n2. c'],
    ['paragraph inside an item', '<ul><li><p>a</p></li><li><p>b</p></li></ul>', '- a\n- b'],
    ['list after text', 'intro<ul><li>a</li></ul>outro', 'intro\n\n- a\n\noutro'],
    ['image', 'before <img src="https://example.com/x.png" alt="x"> after', `before [image](${itemUrl}) after`],
    ['unknown tags keep their text', '<section><span style="color:red">hi</span> <u>there</u></section>', 'hi there'],
    ['comments and doctype are dropped', '<!DOCTYPE html><!-- note -->text', 'text'],
    ['empty formatting leaves no markers', '<div><b><br></b></div><p>x <i></i>y</p>', 'x y'],
    ['whitespace is collapsed', '<p>  a \n\n  b\t c </p>', 'a b c'],
    ['blank paragraphs collapse', '<p>a</p><p>&nbsp;</p><p></p><div><br></div><p>b</p>', 'a\n\nb'],
    ['entities', '&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; a&nbsp;b &amp;lt;', '& \\<b> "q" \'s\' AB a b &lt;'],
  ]
  for (const [name, html, expected] of cases) assert.equal(md(html), expected, name)
})

test('a nested list lines up under the text of a wide marker', () => {
  const items = Array.from({ length: 9 }, (_, n) => `<li>${n}</li>`).join('')
  assert.ok(md(`<ol>${items}<li>ten<ul><li>child</li></ul></li></ol>`).endsWith('\n10. ten\n    - child'))
})

test('tables render one row per line', () => {
  const cases: [string, string, string][] = [
    ['with a th row', '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>', '| A | B |\n| --- | --- |\n| 1 | 2 |'],
    ['without th', '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>', '| a | b |\n| c | d |'],
    ['th only in later rows', '<table><tr><td>a</td></tr><tr><th>b</th></tr></table>', '| a |\n| b |'],
    ['thead and tbody', '<table><thead><tr><th>N</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>', '| N |\n| --- |\n| x |'],
    ['between paragraphs', '<p>before</p><table><tr><td>a</td></tr></table><p>after</p>', 'before\n\n| a |\n\nafter'],
    ['cells are converted inline', '<table><tr><td><b>x</b> <a href="https://example.com">l</a></td><td>a<br>b<p>c</p><ul><li>d</li></ul></td></tr></table>', '| **x** [l](https://example.com) | a b c - d |'],
    ['pipes are escaped', '<table><tr><th>a|b</th><th>c</th></tr><tr><td>|</td><td>&#124;</td></tr></table>', '| a\\|b | c |\n| --- | --- |\n| \\| | \\| |'],
    ['empty cells', '<table><tr><td></td><td>b</td></tr></table>', '|  | b |'],
    ['unclosed rows and cells', '<table><tr><td>a<td>b<tr><td>c', '| a | b |\n| c |'],
    ['cells without a row', '<table><td>a</td><td>b</td></table>', '| a | b |'],
    ['rows and cells outside a table keep their text', '<tr><td>a</td><td>b</td></tr>', 'ab'],
    ['a nested table stays inside its cell', '<table><tr><td>outer<table><tr><td>inner</td></tr></table></td><td>x</td></tr></table>', '| outer inner | x |'],
    ['empty table', '<table></table><table><tr></tr></table>', ''],
  ]
  for (const [name, html, expected] of cases) assert.equal(md(html), expected, name)
})

test('an overlong or unterminated tag never reaches the output as raw HTML', () => {
  const long = 'A'.repeat(2100)
  assert.equal(md(`<a href="javascript:alert(1)" data-x="${long}">click</a>`), 'click')
  assert.equal(md(`<a href="https://example.com" data-x="${long}">click</a>`), '[click](https://example.com)')
  assert.equal(md(`<script data-x="${long}">alert(1)</script>ok`), 'ok')
  assert.equal(md(`<img src="data:image/png;base64,${long}">after`), `[image](${itemUrl})after`)
  assert.equal(md(`<p>kept</p><b data-x="${long}`), 'kept')
  assert.equal(md('before <a href="https://example.com'), 'before')
  assert.equal(md('a <b and <i c'), 'a')
  assert.equal(md('<!doctype'), '')
})

test('a missing closing bracket is found once, not once per tag start', () => {
  assert.equal(timed('<a '.repeat(150_000)), '')
  assert.equal(timed('<a x="'.repeat(70_000) + '>after'), 'after')
})

test('unmatched closing tags are not rescanned against the open tags', () => {
  assert.equal(timed('<b>'.repeat(50_000) + '</span>'.repeat(50_000)), '')
  assert.equal(timed('<b>'.repeat(87_000) + '</u>'.repeat(65_000)), '')
  const nested = '<b>'.repeat(40_000) + 'x' + '</i>'.repeat(40_000) + '</b>'.repeat(40_000)
  assert.equal(timed(nested, 1_000_000), '**'.repeat(40_000) + 'x' + '**'.repeat(40_000))
})

test('whitespace moved out of nested emphasis is not recopied by every closer', () => {
  const unclosed = '<b>x'.repeat(64_000) + '<br>'.repeat(64_000)
  assert.equal(timed(unclosed, 1_000_000), '**x'.repeat(64_000) + '**'.repeat(64_000))
  const closed = '<b>x'.repeat(30_000) + '<br>'.repeat(60_000) + '</b>'.repeat(30_000) + 'y'
  assert.equal(timed(closed, 1_000_000), '**x'.repeat(30_000) + '**'.repeat(30_000) + '\n\ny')
})

test('whitespace moved out of nested links is not recopied by every closer', () => {
  const html = '<a href=http://a.test>x'.repeat(12_000) + '<br>'.repeat(40_000) + '</a>'.repeat(12_000) + 'y'
  assert.equal(timed(html, 1_000_000), '[x'.repeat(12_000) + '](http://a.test)'.repeat(12_000) + '\n\ny')
})

test('moved whitespace collapses to one space or up to two newlines', () => {
  assert.equal(md('<b>a<br><br><br><br></b>b'), '**a**\n\nb')
  assert.equal(md('<b>a <br> <br> </b>b'), '**a**\n\nb')
  assert.equal(md('<b>a  \t </b>b'), '**a** b')
})

test('input beyond 512 KB is cut before parsing', () => {
  assert.equal(timed('x'.repeat(2_000_000), 5_000_000).length, 512 * 1024)
  assert.ok(md('<p>kept</p>' + 'x'.repeat(600_000), 5_000_000).startsWith('kept'))
  const cutInsideTag = timed('a'.repeat(512 * 1024 - 3) + '<b>bold</b>', 5_000_000)
  assert.equal(cutInsideTag, 'a'.repeat(512 * 1024 - 3))
  assert.equal(timed('a'.repeat(512 * 1024 - 1) + '<b>x', 5_000_000), 'a'.repeat(512 * 1024 - 1))
  const huge = '<b>x'.repeat(40_000) + '<br>'.repeat(130_000) + '</b>'.repeat(40_000)
  assert.ok(huge.length > 800_000)
  assert.equal(typeof timed(huge), 'string')
  const links = '<a href="https://a.test">x'.repeat(25_000) + '<br>'.repeat(130_000)
  assert.ok(links.length > 1_000_000)
  assert.equal(typeof timed(links), 'string')
})

test('text cannot form links or raw HTML', () => {
  assert.equal(md('<p>[x](javascript:alert(1))</p>'), '\\[x\\](javascript:alert(1))')
  assert.equal(md('<p>&lt;img src=x onerror=alert(1)&gt;</p>'), '\\<img src=x onerror=alert(1)>')
  assert.equal(md('<p>&#60;b&#x3c;</p>'), '\\<b\\<')
  assert.equal(md('<a href="https://good.test">a](javascript:alert(1)) [b</a>'), '[a\\](javascript:alert(1)) \\[b](https://good.test)')
  assert.equal(md('<p>\\&lt;img src=x&gt; C:\\temp</p>'), '\\\\\\<img src=x> C:\\\\temp')
  assert.equal(md('<p>1 < 2 and <3</p>'), '1 \\< 2 and \\<3')
})

test('code spans are literal and cannot be broken out of', () => {
  const cases: [string, string, string][] = [
    ['brackets and angle brackets stay literal', '<code>a &lt; b[0]</code>', '`a < b[0]`'],
    ['backtick in code', '<code>a&#96;b</code>', '``a`b``'],
    ['code ending in a backtick', '<code>&#96;x&#96;</code>', '`` `x` ``'],
    ['no breaking out of the span', '<code>x&#96;&lt;img src=x onerror=alert(1)&gt;&#96;</code>', '`` x`<img src=x onerror=alert(1)>` ``'],
    ['tags inside are dropped', 'a <code><b>x</b> y</code> b', 'a `x y` b'],
    ['empty code', 'a<code></code><code> </code>b', 'ab'],
    ['unclosed code ends at a block tag', '<p><code>a</p><p>b</p>', '`a`\n\nb'],
    ['unclosed code ends at the end', '<code>a', '`a`'],
    ['code inside emphasis', '<b>x <code>y</code> </b>z', '**x `y`** z'],
    ['a text backtick cannot unbalance the span', '`<code>&lt;img src=x onerror=alert(1)&gt;</code>', '\\` `<img src=x onerror=alert(1)>`'],
    ['adjacent spans stay separate', '<code>a</code><code>b&#96;c&lt;img src=x&gt;</code>', '`a` ``b`c<img src=x>``'],
    ['code inside a cell', '<table><tr><td><code>a|b</code></td></tr></table>', '| `a\\|b` |'],
  ]
  for (const [name, html, expected] of cases) assert.equal(md(html), expected, name)
})

test('whitespace moves outside emphasis markers', () => {
  const cases: [string, string, string][] = [
    ['trailing', '<b>Steps: </b>text', '**Steps:** text'],
    ['trailing nbsp', '<strong>x&nbsp;</strong>y', '**x** y'],
    ['leading', 'a<b> x</b>', 'a **x**'],
    ['both', 'a<i> x </i>b', 'a *x* b'],
    ['whitespace only', '<i> </i>x<b>&nbsp;</b>', 'x'],
    ['line break before the close', '<b>a<br></b>b', '**a**\nb'],
    ['nested', '<b>a <i>b </i></b>c', '**a *b*** c'],
    ['link text', '<a href="https://example.com">link </a>after', '[link](https://example.com) after'],
    ['at line start', '<p><b> x</b></p>', '**x**'],
    ['inside a cell', '<table><tr><td><b>x </b>y</td></tr></table>', '| **x** y |'],
    ['a code fence keeps its line', '<b>x<pre>code</pre></b>y', '**x\n\n```\ncode\n```\n\n**y'],
    ['a code fence in an item keeps its line', '<ul><li><b>t<pre>c</pre></b>y</li></ul>', '- **t\n  ```\n  c\n  ```\n**y'],
    ['no space to move', '<b>x</b>y', '**x**y'],
  ]
  for (const [name, html, expected] of cases) assert.equal(md(html), expected, name)
})

test('decodes the common named entities', () => {
  assert.equal(
    md('&apos;&rsquo;&lsquo;&rdquo;&ldquo;&ndash;&mdash;&hellip;&copy;&reg;&trade;'),
    "'\u2019\u2018\u201d\u201c\u2013\u2014\u2026\u00a9\u00ae\u2122",
  )
  assert.equal(md('it&rsquo;s &ndash; &AMP; &bogus;'), 'it\u2019s \u2013 & &bogus;')
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

test('a cut inside a code fence closes the fence before the suffix', () => {
  const html = '<p>intro</p><pre>l1\nl2\nl3\nl4\nl5</pre><p>after</p>'
  assert.equal(md(html, 22), 'intro\n\n```\nl1\nl2\nl3\n```' + SUFFIX)
  assert.equal(md(html, 25), 'intro\n\n```\nl1\nl2\nl3\nl4\n```' + SUFFIX)
  assert.equal(md(html, 26), 'intro\n\n```\nl1\nl2\nl3\nl4\nl5\n```' + SUFFIX)
  assert.equal(md(html, 33), 'intro\n\n```\nl1\nl2\nl3\nl4\nl5\n```' + SUFFIX)
  assert.equal(md(html, 40), 'intro\n\n```\nl1\nl2\nl3\nl4\nl5\n```\n\nafter')
  assert.equal(md('<pre>aaaa\nbbbb</pre>', 10), '```\naaaa\n```' + SUFFIX)
  assert.equal(md('<pre>a\n```\nb\nc</pre>', 17), '````\na\n```\nb\nc\n````' + SUFFIX)
  assert.equal(md('<pre>a</pre><p>b</p><p>c</p>', 13), '```\na\n```\n\nb' + SUFFIX)
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
    '<ol>'.repeat(2000) + '<li>deep</li>' + '</ol>'.repeat(2000),
    '<table>'.repeat(5000) + '<tr><td>x</td></tr>' + '</table>'.repeat(5000),
    '<table><tr><td>'.repeat(3000) + 'x',
    '<table><tr><td><pre>never closed',
    '<ul><li><table><tr><td>x</ul></td></tr></table><li>y</li></ul>',
    '</td></tr></table><td>stray</td><th>stray</th></tr>',
    '<table><tr>' + '<td>a</td>'.repeat(20_000) + '</tr></table>',
    '<pre>' + '`'.repeat(100_000) + '</pre>',
    '<a "'.repeat(20_000),
    '<code>'.repeat(50_000),
    '<code>' + '`'.repeat(100_000),
    '<b> </b>'.repeat(50_000),
    '<b>x </b>'.repeat(50_000),
    '<'.repeat(50_000),
    ' '.repeat(100_000) + '<pre>' + ' '.repeat(100_000) + '</pre>',
  ]
  for (const input of inputs) assert.equal(typeof timed(input), 'string')
  assert.equal(md('a < b and c > d'), 'a \\< b and c > d')
  assert.equal(md('<p>unclosed <b>bold <i>italic'), 'unclosed **bold *italic***')
  assert.equal(md('&#99999999999; &#0;'), '� �')
})
