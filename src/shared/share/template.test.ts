import { assert, test } from 'orca/testing'
import { PR_TEMPLATE, PR_VARS, fillLine, parseTemplate } from './template'
import type { ParsedTemplate } from './template'

const URL = 'https://dev.azure.com/contoso/Fabrikam%20Web/_git/web-app/pullrequest/123396'
const VALUES = { id: '123396', title: 'Reserve a line', url: URL, repo: 'web-app', project: 'Fabrikam Web', source: 'feature/x', target: 'develop', author: 'Alex Morgan' }

function parsed(template: string, vars: readonly string[] = PR_VARS): ParsedTemplate {
  const result = parseTemplate(template, vars)
  assert.ok('kind' in result, 'error' in result ? result.error : '')
  return result
}

test('the default template parses and fills into a link and a text segment', () => {
  assert.deepEqual(fillLine(parsed(PR_TEMPLATE), VALUES), [
    { text: 'Pull Request 123396', href: URL },
    { text: ': Reserve a line' }
  ])
})

test('the template errors are exact', () => {
  assert.deepEqual(parseTemplate('', PR_VARS), { error: 'The share template is empty.' })
  assert.deepEqual(parseTemplate('  \n ', PR_VARS), { error: 'The share template is empty.' })
  assert.deepEqual(parseTemplate('[a]({url}) and [b]({url})', PR_VARS), { error: 'The share template can have only one link.' })
  assert.deepEqual(parseTemplate('{id} {nope}', PR_VARS), { error: 'Unknown placeholder {nope} in the share template.' })
  assert.deepEqual(parseTemplate('[{id}]({link})', PR_VARS), { error: 'Unknown placeholder {link} in the share template.' })
  assert.deepEqual(parseTemplate('{id}', ['title']), { error: 'Unknown placeholder {id} in the share template.' })
  assert.deepEqual(parseTemplate('[]({url}): {title}', PR_VARS), { error: 'The link in the share template needs text, like [text]({url}).' })
  assert.deepEqual(parseTemplate('[ ]({url})', PR_VARS), { error: 'The link in the share template needs text, like [text]({url}).' })
})

test('brackets that do not form a link span stay literal text', () => {
  assert.deepEqual(fillLine(parsed('[WIP] {id} (draft) [x]'), VALUES), [{ text: '[WIP] 123396 (draft) [x]' }])
})

test('a link span can sit anywhere and the rest is literal text', () => {
  assert.deepEqual(fillLine(parsed('{repo} → {target}: [#{id}]({url}) by {author}'), VALUES), [
    { text: 'web-app → develop: ' },
    { text: '#123396', href: URL },
    { text: ' by Alex Morgan' }
  ])
})

test('values are inserted after parsing, so a value can never create a link', () => {
  const template = parsed(PR_TEMPLATE)
  for (const title of ['](javascript:alert(1))', '[a](https://evil.example)', '<a href="https://evil.example">x</a>', '{url}', '{title}']) {
    const segments = fillLine(template, { ...VALUES, title })
    assert.deepEqual(segments, [{ text: 'Pull Request 123396', href: URL }, { text: `: ${title}` }])
  }
})

test('a link whose filled target is not an http(s) URL becomes plain text', () => {
  const template = parsed(PR_TEMPLATE)
  for (const url of ['javascript:alert(1)', 'ftp://example.com/a', 'data:text/html,x', '//example.com', 'https://', 'https:///x', 'https://a b', 'https://a\nb', '']) {
    assert.deepEqual(fillLine(template, { ...VALUES, url }), [{ text: 'Pull Request 123396' }, { text: ': Reserve a line' }], url)
  }
  assert.deepEqual(fillLine(template, { ...VALUES, url: 'http://localhost:8080/pr/1' })[0], { text: 'Pull Request 123396', href: 'http://localhost:8080/pr/1' })
})

test('a variable missing from the values fills as empty', () => {
  assert.deepEqual(fillLine(parsed('{id}: {title}'), { id: '7' }), [{ text: '7: ' }])
})

test('line breaks inside a value fill as single spaces', () => {
  const segments = fillLine(parsed('{id}: {title}'), { id: '7', title: 'a\nb\r\nc\rd\u2028e\u2029f' })
  assert.deepEqual(segments, [{ text: '7: a b c d e f' }])
})
