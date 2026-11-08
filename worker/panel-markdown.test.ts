import { assert, test } from 'orca/testing'
import { MARKDOWN_CUT_NOTE } from './messages'
import { panelMarkdown, type MarkdownTarget } from './panel-markdown'

const PR_URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/4110'
const ME = '9d1c2b3a-4444-4e5f-8a6b-7c8d9e0f1a2b'
const STRANGER = '11111111-2222-3333-4444-555555555555'
const EVIL = 'javascript:alert(1)'
const CUT = `\n\n*${MARKDOWN_CUT_NOTE}*`
const UNSAFE = /(?:javascript|vbscript|data):|<\/?a[\s>]/i
const LINKED_UNSAFE = /\]\(\s*<?javascript:|<javascript:|^ {0,3}\[[^\]\n]*\]:\s*<?javascript:/im
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const SLOW_MS = 3000

function resolve(href: string): string {
  const strict = encodeURIComponent(href).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${PR_URL}?link=${strict}`
}

const TARGET: MarkdownTarget = { maxBytes: 60_000, resolve, people: new Map([[ME, 'Alex Contoso']]) }

function md(text: string, over: Partial<MarkdownTarget> = {}): string {
  return panelMarkdown(text, { ...TARGET, ...over })
}

function bytes(text: string): number {
  return Buffer.byteLength(text)
}

function headOf(out: string, tail: string): string {
  assert.ok(out.endsWith(tail), `expected the cut to end with ${JSON.stringify(tail)}: ${JSON.stringify(out.slice(-80))}`)
  return out.slice(0, out.length - tail.length)
}

test('panelMarkdown turns images into links and resolves relative links', () => {
  const cases: [string, string][] = [
    ['![Redirect flow](/.attachments/redirect-flow-4110.png)', `[Image: Redirect flow](${resolve('/.attachments/redirect-flow-4110.png')})`],
    ['![](/.attachments/login%20page.png)', `[Image: login page.png](${resolve('/.attachments/login%20page.png')})`],
    ['![ ](https://cdn.fabrikam.test/assets/)', '[Image: image](https://cdn.fabrikam.test/assets/)'],
    ['![Logo](https://cdn.fabrikam.test/logo.png "Fabrikam")', '[Image: Logo](https://cdn.fabrikam.test/logo.png)'],
    ['<img src="/.attachments/flow.png" alt="Login flow" width="300">', `[Image: Login flow](${resolve('/.attachments/flow.png')})`],
    ["<IMG SRC='http://cdn.fabrikam.test/b.jpg'>", '[Image: b.jpg](http://cdn.fabrikam.test/b.jpg)'],
    ['<img alt="a [b]" src="https://cdn.fabrikam.test/a b.png"/>', '[Image: a \\[b\\]](https://cdn.fabrikam.test/a%20b.png)'],
    ['See [the spec](/docs/spec.md).', `See [the spec](${resolve('/docs/spec.md')}).`],
    ['[Rollback](Release-process/Rollback "Rollback steps")', `[Rollback](${resolve('Release-process/Rollback')} "Rollback steps")`],
    ['[a page](<Release process.md>)', `[a page](${resolve('Release process.md')})`],
    ['[x](a\\_b&amp;c.md)', `[x](${resolve('a_b&c.md')})`],
    ['[docs](https://learn.microsoft.com/azure) and [mail](MAILTO:dev@fabrikam.test)', '[docs](https://learn.microsoft.com/azure) and [mail](MAILTO:dev@fabrikam.test)'],
    ['<https://dev.azure.com/contoso> and <dev@fabrikam.test>', '<https://dev.azure.com/contoso> and <dev@fabrikam.test>'],
    ['[ref]: ../Onboarding\n[Docs]: https://learn.microsoft.com "Learn"', `[ref]: ${resolve('../Onboarding')}\n[Docs]: https://learn.microsoft.com "Learn"`],
    [
      'A [link](/a), ![img](b.png) and <a href="/c" title="x>y">text</a>.',
      `A [link](${resolve('/a')}), [Image: img](${resolve('b.png')}) and text.`
    ],
    ['![shot](/.attachments/shot.png =500x)', `[Image: shot](${resolve('/.attachments/shot.png')})`],
    ['![shot](/.attachments/shot.png =500x250)', `[Image: shot](${resolve('/.attachments/shot.png')})`],
    ['![shot](/.attachments/shot.png =x250 "Shot")', `[Image: shot](${resolve('/.attachments/shot.png')})`],
    ['![shot](<My shot.png> =500x)', `[Image: shot](${resolve('My shot.png')})`],
    ['![shot](https://cdn.fabrikam.test/s.png =500x)', '[Image: shot](https://cdn.fabrikam.test/s.png)'],
    ['[a](b.md =500x)', `[a](${resolve('b.md')} =500x)`],
    ['[![badge](/badge.png)](/pipelines)', `[Image: badge](${resolve('/pipelines')})`],
    ['[![badge](/badge.png "b")](/pipelines "Runs")', `[Image: badge](${resolve('/pipelines')} "Runs")`],
    ['[![badge](/badge.png =80x)](https://dev.azure.com/contoso)', '[Image: badge](https://dev.azure.com/contoso)'],
    ['[<img src="/badge.png" alt="badge">](/pipelines)', `[Image: badge](${resolve('/pipelines')})`],
    ['[![badge](/badge.png) status](/pipelines)', `[[Image: badge](${resolve('/badge.png')}) status](${resolve('/pipelines')})`],
    ['![a][r]\n\n[r]: https://cdn.fabrikam.test/a.png', '[a][r]\n\n[r]: https://cdn.fabrikam.test/a.png'],
    ['![a][]\n\n[a]: https://cdn.fabrikam.test/a.png', '[a][]\n\n[a]: https://cdn.fabrikam.test/a.png'],
    ['![r]\n\n[r]: https://cdn.fabrikam.test/r.png', '[r]\n\n[r]: https://cdn.fabrikam.test/r.png'],
    ['See ![the flow][flow].\n\n[flow]: /.attachments/flow.png', `See [the flow][flow].\n\n[flow]: ${resolve('/.attachments/flow.png')}`]
  ]
  for (const [input, expected] of cases) assert.equal(md(input), expected, input)
})

test('panelMarkdown makes hostile and ADO-only markup safe to show', () => {
  assert.equal(md('<img src=/x.png onerror=alert(1)>'), `[Image: x.png](${resolve('/x.png')})`)
  assert.equal(md(`[x](${EVIL})`), `[x](${resolve(EVIL)})`)
  assert.equal(md(`[x][r]\n\n[r]: ${EVIL}`), `[x][r]\n\n[r]: ${resolve(EVIL)}`)
  assert.equal(md(`<${EVIL}>`), `<${resolve(EVIL)}>`)
  assert.equal(md(`<a href="${EVIL}">x</a>`), 'x')

  assert.equal(md(`Thanks @<${ME.toUpperCase()}>, and @<${STRANGER}>.`), 'Thanks @Alex Contoso, and @Unknown.')
  assert.equal(md(`@<${ME}>`, { people: new Map([[ME.toUpperCase(), 'Alex Contoso']]) }), '@Alex Contoso')
  assert.equal(md(`@<${ME}>`, { people: new Map([[ME, '[Alex](javascript:x)']]) }), '@\\[Alex\\](javascript:x)')
  assert.equal(md(`@<${ME}>`, { people: undefined }), '@Unknown')

  assert.equal(md('# Release process\n[[_TOC_]]\n[[_TOSP_]]  \nSteps'), '# Release process\nSteps')
  assert.equal(md('Intro\n\n   [[_TOC_]]\nSteps'), 'Intro\n\nSteps')
  for (const indented of ['para\n\n    [[_TOC_]]', 'para\n\n\t[[_TOSP_]]'])
    assert.equal(md(indented), indented, JSON.stringify(indented))

  const code = [`@<${ME}>`, '[[_TOC_]]', '![a](b.png)']
  const fenced = [
    '```md', ...code, '```', '',
    '~~~~', ...code, '```', '~~~~', '',
    '  ```', ...code, '  ```', '',
    '```', ...code
  ].join('\n')
  assert.equal(md(fenced), fenced)
  assert.equal(md(`<!--\n\`\`\`\n-->\n[x](${EVIL})`), `<!--\n\`\`\`\n-->\n[x](${resolve(EVIL)})`)
  assert.equal(md(`<div>\n\`\`\`\n\n[x](${EVIL})`), `<div>\n\`\`\`\n\n[x](${resolve(EVIL)})`)
  const inline = [
    code.map(text => `\`${text}\``).join(' '),
    '`[[_TOC_]]`',
    `\`\`a \` @<${ME}> ![a](b.png)\`\``,
    `\`a\n![a](b.png) @<${ME}>\``
  ].join('\n')
  assert.equal(md(inline), inline)

  const variants = [
    '[x](JavaScript:alert(1))',
    `[x](  ${EVIL} "t")`,
    `[x](<${EVIL}>)`,
    '[x](jav&#97;script:alert(1))',
    `[x](\n${EVIL})`,
    '[x](data:text/html,hi) [y](vbscript:msgbox)',
    `![x](${EVIL})`,
    `[![x](${EVIL})](${EVIL})`,
    `[x][R]\n\n[r]:\n  ${EVIL} "t"`,
    `[x][r]\n\n> [r]: <${EVIL}>`,
    `[x][r]\n\n- [r]: ${EVIL}`,
    `<A HREF='${EVIL}' title="a>b">x</A >`,
    `<a href=${EVIL}>x</a>`,
    `<a href="#" onclick=alert('x')>x</a>`,
    `<img src="${EVIL}">`,
    '<VBScript:msgbox> <DATA:text/html,hi>',
    `Text <a\nhref="${EVIL}">x</a> more`
  ]
  for (const input of variants) {
    const out = md(input)
    assert.ok(!UNSAFE.test(out), `${JSON.stringify(input)} gave ${JSON.stringify(out)}`)
  }

  for (const input of [`[x]<a></a>(${EVIL})`, `<<a></a>${EVIL}>`, `<a href=x></a>[r]: ${EVIL}\n\n[y][r]`]) {
    const out = md(input)
    assert.ok(!LINKED_UNSAFE.test(out), `${JSON.stringify(input)} gave ${JSON.stringify(out)}`)
  }
  for (const marker of ['- - ', '1. 2. ', '- > - ', '* + ', '> 1. - ', '-\t-\t', '2) \t-   '])
    assert.equal(md(`[x][r]\n\n${marker}[r]: ${EVIL}`), `[x][r]\n\n${marker}[r]: ${resolve(EVIL)}`, JSON.stringify(marker))

  for (const input of ['!![x](p.png)', '!<img src=p.png>', '!<a></a>[x](p.png)', '!![x][r]\n\n[r]: p.png']) {
    const out = md(input)
    assert.ok(!out.includes('!['), `${JSON.stringify(input)} gave ${JSON.stringify(out)}`)
  }

  const careless = md(`[x](y.md) <zz:w> ![i](j.png)\n\n[r]: k`, { resolve: () => EVIL })
  assert.ok(!UNSAFE.test(careless), careless)

  const comment = Array.from({ length: 4_000 }, (_, i) => `Line ${i}: [step](/docs/${i}.md) by @<${ME}>`).join('\n')
  assert.ok(bytes(comment) >= 200 * 1024)
  const out = md(comment, { maxBytes: 8_000 })
  assert.ok(bytes(out) <= 8_000, `${bytes(out)} bytes`)
  const head = headOf(out, CUT)
  assert.match(head, /^Line 0: \[step\]\(https:\/\/dev\.azure\.com\/.+\) by @Alex Contoso\n/)
  assert.ok(head.split('\n').length > 40)
  assert.ok(!head.includes('@<'))
})

test('panelMarkdown cuts at a line and closes an open code block', () => {
  const lines = ['Intro', '````ts', ...Array.from({ length: 300 }, (_, i) => `const v${i} = ${i}`), '````', 'After']
  const source = lines.join('\n')
  const out = md(source, { maxBytes: 1_000 })
  assert.ok(bytes(out) <= 1_000, `${bytes(out)} bytes`)
  const head = headOf(out, `\n\`\`\`\`${CUT}`)
  assert.ok(source.startsWith(`${head}\n`))
  assert.ok(head.split('\n').length > 30)

  const wide = Array.from({ length: 100 }, (_, i) => `${i} ${'é'.repeat(50)}`).join('\n')
  const cutWide = md(wide, { maxBytes: 1_000 })
  assert.ok(bytes(cutWide) <= 1_000, `${bytes(cutWide)} bytes`)
  const wideHead = headOf(cutWide, CUT)
  assert.ok(wide.startsWith(`${wideHead}\n`))
  assert.ok(wideHead.split('\n').length >= 8)

  const span = `Intro\n\n\`a\n<${EVIL}>\n${'b'.repeat(2_000)}\``
  assert.equal(md(span), span)
  const cutSpan = md(span, { maxBytes: 600 })
  assert.ok(bytes(cutSpan) <= 600)
  assert.equal(cutSpan, `Intro\n\n\`a\n<${resolve(EVIL)}>${CUT}`)

  const emoji = '😀'.repeat(1_000)
  const single = md(emoji, { maxBytes: 500 })
  assert.ok(bytes(single) <= 500, `${bytes(single)} bytes`)
  const singleHead = headOf(single, CUT)
  assert.ok(singleHead.length > 0 && emoji.startsWith(singleHead))
  assert.ok(!LONE_SURROGATE.test(single))

  assert.equal(md('short', { maxBytes: 5 }), 'short')
  assert.equal(md('```\ncode', { maxBytes: 8 }), '```\ncode')
})

test('panelMarkdown leaves a ::: mermaid block untouched like code, and a cut closes it', () => {
  const diagram = [
    'graph TD',
    '  A --> B[label]',
    '  C[see](Guide.md)',
    `  D["<a href='https://example.com'>docs</a>"]`,
    `  E["<b>x</b><br/>"] --> @<${STRANGER}>`,
    '%% a comment',
    '[[_TOC_]]'
  ]
  for (const opener of ['::: mermaid', ':::mermaid', '   :::  MERMAID  ']) {
    const source = ['Intro, see [the guide](Guide.md).', '', opener, ...diagram, ':::', '', `After @<${ME}>`].join('\n')
    const expected = [`Intro, see [the guide](${resolve('Guide.md')}).`, '', opener, ...diagram, ':::', '', 'After @Alex Contoso'].join('\n')
    assert.equal(md(source), expected, opener)
    assert.equal(md(source.replaceAll('\n', '\r\n')), expected, `${opener} with CRLF`)
  }

  const unclosed = ['Intro', '::: mermaid', ...diagram].join('\n')
  assert.equal(md(unclosed), unclosed)

  const lines = ['Intro', '::: mermaid', 'graph TD', ...Array.from({ length: 40 }, (_, i) => `  N${i} --> N${i + 1}[step ${i}](x.md)`), ':::', 'After']
  const source = lines.join('\n')
  const out = md(source, { maxBytes: 500 })
  assert.ok(bytes(out) <= 500, `${bytes(out)} bytes`)
  const head = headOf(out, `\n:::${CUT}`)
  assert.ok(source.startsWith(`${head}\n`), head)
  assert.ok(head.split('\n').length > 5)
})

test('panelMarkdown takes its own cut note', () => {
  const note = 'This page is too long to show here in full. Open it in Azure DevOps to read the rest.'
  const lines = ['Intro', '```ts', ...Array.from({ length: 300 }, (_, i) => `const v${i} = ${i}`), '```', 'After']
  const source = lines.join('\n')
  const out = md(source, { maxBytes: 1_000, cutNote: note })
  assert.ok(bytes(out) <= 1_000, `${bytes(out)} bytes`)
  const head = headOf(out, `\n\`\`\`\n\n*${note}*`)
  assert.ok(source.startsWith(`${head}\n`))
  assert.equal(out.includes(MARKDOWN_CUT_NOTE), false)
})

test('panelMarkdown stays fast on adversarial input', () => {
  const inputs = [
    '<a '.repeat(60_000),
    '![['.repeat(60_000),
    '<!--'.repeat(50_000),
    '[x]('.repeat(40_000),
    '<b x="'.repeat(30_000),
    '\n[a'.repeat(50_000),
    '\n> [a]:'.repeat(30_000),
    Array.from({ length: 600 }, (_, i) => `${'`'.repeat(i + 1)}x`).join(''),
    `${'['.repeat(40_000)}${'](x)'.repeat(40_000)}`,
    `${'![a'.repeat(30_000)}${'](x)'.repeat(30_000)}`,
    '![a](b =1x '.repeat(30_000),
    `${'[![a](b)'.repeat(30_000)}${'](c)'.repeat(30_000)}`,
    '-  '.repeat(5_000),
    `\n${'-\t'.repeat(5_000)}x`,
    '![a]'.repeat(30_000)
  ]
  for (const input of inputs) {
    const started = Date.now()
    const out = md(input)
    assert.ok(Date.now() - started < SLOW_MS, `slow on ${JSON.stringify(input.slice(0, 20))}`)
    assert.ok(bytes(out) <= TARGET.maxBytes)
  }
})
