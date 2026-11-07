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
