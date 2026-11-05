import { assert, test } from 'orca/testing'
import { MAX_INTRO, MAX_SHARE_ITEMS, buildMessage, toHtml, toMarkdown, toPlain } from './message'
import { PR_TEMPLATE, PR_VARS } from './template'
import type { ShareItem } from './types'

const URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396'
const TITLE = "[PROJ-55283] Reserve a buyer's line and flag missed calls on the lead"

function item(overrides: Record<string, string> = {}): ShareItem {
  return {
    key: 'pr:p/r/123396',
    vars: { id: '123396', title: TITLE, url: URL, repo: 'web-app', project: 'Fabrikam Web', source: 'feature/x', target: 'develop', author: 'Alex Morgan', ...overrides }
  }
}

function build(items: ShareItem[], intro = '', template = PR_TEMPLATE) {
  return buildMessage({ template, fallback: PR_TEMPLATE, vars: PR_VARS, intro, items })
}

test('the default template reproduces the reference line', () => {
  const { message, warning } = build([item()])
  assert.equal(warning, undefined)
  assert.equal(
    toHtml(message),
    `<div><a href="${URL}">Pull Request 123396</a>: [PROJ-55283] Reserve a buyer&#39;s line and flag missed calls on the lead</div>`
  )
  assert.equal(toPlain(message), `Pull Request 123396: ${TITLE} ${URL}`)
  assert.equal(toMarkdown(message), `[Pull Request 123396](${URL}): \\[PROJ-55283\\] Reserve a buyer's line and flag missed calls on the lead`)
})

test('titles can never add links or markup', () => {
  const noisy = '[PROJ-1] ' + '<b>&"\'](x) '.repeat(35) + 'aaaaaa'
  const hostile = [
    { title: '](javascript:alert(1))', html: '](javascript:alert(1))', markdown: '\\]\\(javascript:alert\\(1\\)\\)' },
    { title: '<script>x</script>', html: '&lt;script&gt;x&lt;/script&gt;', markdown: '\\<script\\>x\\</script\\>' },
    { title: '[a](https://evil.example)', html: '[a](https://evil.example)', markdown: '\\[a\\]\\(https://evil.example\\)' },
    { title: '&amp; 🚀', html: '&amp;amp; 🚀', markdown: '\\&amp; 🚀' },
    { title: noisy, html: '[PROJ-1] ' + '&lt;b&gt;&amp;&quot;&#39;](x) '.repeat(35) + 'aaaaaa', markdown: '\\[PROJ-1\\] ' + '\\<b\\>\\&"\'\\]\\(x\\) '.repeat(35) + 'aaaaaa' }
  ]
  assert.equal(noisy.length, 400)
  for (const { title, html, markdown } of hostile) {
    const { message } = build([item({ title })])
    const rendered = toHtml(message)
    assert.equal(rendered, `<div><a href="${URL}">Pull Request 123396</a>: ${html}</div>`, title)
    assert.equal(rendered.split('<a ').length - 1, 1, title)
    assert.ok(!rendered.includes('<script'), title)
    assert.ok(!/[<>]/.test(rendered.replace(`<a href="${URL}">`, '').replace(/<\/?(div|a)>/g, '')), title)
    assert.equal(toPlain(message), `Pull Request 123396: ${title} ${URL}`, title)
    assert.equal(toMarkdown(message), `[Pull Request 123396](${URL}): ${markdown}`, title)
  }

  const blockStarts = [
    ['- item', '\\- item'],
    ['+ item', '\\+ item'],
    ['* item', '\\* item'],
    ['# Heading', '\\# Heading'],
    ['> quote', '\\> quote'],
    ['1. step', '1\\. step'],
    ['12) step', '12\\) step'],
    ['---', '\\---'],
    ['===', '\\==='],
    ['    indented', 'indented'],
    ['\tindented', 'indented'],
    [':-- delimiter', '\\:-- delimiter']
  ]
  for (const [title, markdown] of blockStarts) {
    const { message } = build([item({ title })], '', '{title} [#{id}]({url})')
    assert.equal(toMarkdown(message), `${markdown} [\\#123396](${URL})`, title)
    assert.equal(toPlain(message), `${title} #123396 ${URL}`, title)
    assert.equal(toHtml(message).split('<a ').length - 1, 1, title)
  }
})

test('an intro can never add a heading, list, quote, table or code block to the preview', () => {
  const preview = (intro: string) => toMarkdown(build([], intro).message)
  assert.equal(preview('Release notes\n---'), 'Release notes  \n\\---')
  assert.equal(preview('Release notes\n==='), 'Release notes  \n\\===')
  assert.equal(preview('Hello\n- item\n+ item\n* item'), 'Hello  \n\\- item  \n\\+ item  \n\\* item')
  assert.equal(preview('1. one\n2) two\n# h\n> q'), '1\\. one  \n2\\) two  \n\\# h  \n\\> q')
  assert.equal(preview('    code\n\tmore\n   - item'), 'code  \nmore  \n\\- item')
  assert.equal(preview('Header\n:--\n:-:'), 'Header  \n\\:--  \n\\:-:')
})

test('a template with an unknown placeholder or two links falls back with a warning', () => {
  for (const [template, warning] of [
    ['{id} {nope}: {title}', 'Unknown placeholder {nope} in the share template.'],
    ['[a]({url}) [b]({url})', 'The share template can have only one link.'],
    ['   ', 'The share template is empty.'],
    ['[]({url}): {title}', 'The link needs text, like [Pull Request {id}]({url}).']
  ]) {
    const result = build([item()], '', template)
    assert.equal(result.warning, warning)
    assert.equal(toPlain(result.message), `Pull Request 123396: ${TITLE} ${URL}`)
  }
})

test('a link target that is not http(s) renders as plain text', () => {
  for (const url of ['javascript:alert(1)', 'ftp://example.com/x', '']) {
    const { message } = build([item({ url, title: 'Fix login' })])
    assert.equal(toHtml(message), '<div>Pull Request 123396: Fix login</div>')
    assert.equal(toPlain(message), 'Pull Request 123396: Fix login')
    assert.equal(toMarkdown(message), 'Pull Request 123396: Fix login')
  }
})

test('the renderers refuse a link href that is not http(s) even when the message was built elsewhere', () => {
  const message = { intro: '', lines: [[{ text: 'go', href: 'javascript:alert(1)' }, { text: ' now' }]] }
  assert.equal(toHtml(message), '<div>go now</div>')
  assert.equal(toPlain(message), 'go now')
  assert.equal(toMarkdown(message), 'go now')
})

test('a link target cannot be broken out of in markdown or an HTML attribute', () => {
  const url = 'https://example.com/a(b)c<d>e\\f`g"h\'i&amp;j'
  const { message } = build([item({ url })])
  const target = 'https://example.com/a\\(b\\)c\\<d\\>e\\\\f\\`g"h\'i\\&amp;j'
  assert.equal(toMarkdown(message), `[Pull Request 123396](${target}): \\[PROJ-55283\\] Reserve a buyer's line and flag missed calls on the lead`)
  assert.ok(toHtml(message).startsWith('<div><a href="https://example.com/a(b)c&lt;d&gt;e\\f`g&quot;h&#39;i&amp;amp;j">Pull Request 123396</a>'))
})

test('intro text is escaped, keeps its line breaks and is cut to 2,000 characters; items are cut to 50', () => {
  const { message } = build([item()], '  Release <b>Friday</b> & "more"\r\n\r\nPlease review (all) \n')
  assert.equal(message.intro, 'Release <b>Friday</b> & "more"\n\nPlease review (all)')
  assert.equal(
    toHtml(message),
    `<div>Release &lt;b&gt;Friday&lt;/b&gt; &amp; &quot;more&quot;</div><div><br></div><div>Please review (all)</div><div><a href="${URL}">Pull Request 123396</a>: ${TITLE.replace("'", '&#39;')}</div>`
  )
  assert.equal(toPlain(message), `Release <b>Friday</b> & "more"\n\nPlease review (all)\n\nPull Request 123396: ${TITLE} ${URL}`)
  assert.equal(
    toMarkdown(message),
    `Release \\<b\\>Friday\\</b\\> \\& "more"  \n  \nPlease review \\(all\\)\n\n[Pull Request 123396](${URL}): \\[PROJ-55283\\] Reserve a buyer's line and flag missed calls on the lead`
  )

  assert.equal(MAX_INTRO, 2000)
  assert.equal(build([item()], 'a'.repeat(2500)).message.intro.length, MAX_INTRO)
  assert.equal(build([item()], '  ' + 'a'.repeat(2500) + '  ').message.intro, 'a'.repeat(MAX_INTRO))
  const emoji = build([item()], 'x' + '🚀'.repeat(1500)).message.intro
  assert.equal(emoji.length, MAX_INTRO - 1)
  assert.equal(emoji, 'x' + '🚀'.repeat(999))

  assert.equal(MAX_SHARE_ITEMS, 50)
  const many = Array.from({ length: 60 }, (_, index) => item({ id: String(index + 1) }))
  const capped = build(many).message
  assert.equal(capped.lines.length, 50)
  assert.equal(capped.lines[49][0].text, 'Pull Request 50')
})

test('a whitespace-only intro line is a blank line in every output', () => {
  const { message } = build([], 'a\n   \nb')
  assert.equal(toHtml(message), '<div>a</div><div><br></div><div>b</div>')
  assert.equal(toPlain(message), 'a\n   \nb')
  assert.equal(toMarkdown(message), 'a  \n  \nb')
})

test('line breaks inside a value become spaces in every output', () => {
  const { message } = build([item({ title: 'Fix\nlogin\r\nnow\u2028x\u2029y' })])
  assert.equal(toPlain(message), `Pull Request 123396: Fix login now x y ${URL}`)
  assert.equal(toHtml(message), `<div><a href="${URL}">Pull Request 123396</a>: Fix login now x y</div>`)
  assert.equal(toMarkdown(message), `[Pull Request 123396](${URL}): Fix login now x y`)
})

test('an empty intro adds nothing and no items leaves only the intro', () => {
  assert.equal(toPlain(build([], 'Hello').message), 'Hello')
  assert.equal(toHtml(build([], '  ').message), '')
  assert.equal(toMarkdown(build([], 'Hello').message), 'Hello')
  assert.equal(toPlain(build([item(), item({ id: '7' })]).message), `Pull Request 123396: ${TITLE} ${URL}\nPull Request 7: ${TITLE} ${URL}`)
})

test('a custom template uses repo and target', () => {
  const { message, warning } = build([item()], '', '{repo} → {target}: [#{id}]({url})')
  assert.equal(warning, undefined)
  assert.equal(toHtml(message), `<div>web-app → develop: <a href="${URL}">#123396</a></div>`)
  assert.equal(toPlain(message), `web-app → develop: #123396 ${URL}`)
  assert.equal(toMarkdown(message), `web-app → develop: [\\#123396](${URL})`)
})

test('a fallback that is itself invalid is a programming error', () => {
  assert.throws(() => buildMessage({ template: '', fallback: '{nope}', vars: PR_VARS, intro: '', items: [] }), /Unknown placeholder \{nope\}/)
})
