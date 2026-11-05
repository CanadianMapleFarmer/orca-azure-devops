import { assert, test } from 'orca/testing'
import { ansiSpans, plainText, type Span } from './ansi'

const ALLOWED_CLASS = /^(?:b|dim|i|u|fg-(?:\d|1[0-5])|bg-(?:\d|1[0-5]))$/

function text(spans: Span[]): string {
  return spans.map(span => span.text).join('')
}

function assertClean(spans: Span[]): void {
  for (const span of spans) {
    assert.deepEqual(Object.keys(span).sort(), ['classes', 'text'])
    assert.equal(typeof span.text, 'string')
    assert.ok(span.text.length > 0)
    assert.ok(!/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(span.text), JSON.stringify(span.text))
    for (const name of span.classes) assert.ok(ALLOWED_CLASS.test(name), name)
  }
}

test('ansiSpans strips every escape and never yields markup', () => {
  const markup = ansiSpans('\x1b[31m<script>\x1b[0m &amp;')
  assert.deepEqual(markup, [
    { text: '<script>', classes: ['fg-1'] },
    { text: ' &amp;', classes: [] }
  ])
  const noisy = [
    ['a\x1b[2Kb\x1b[1;5Hc\x1b[?25l\x1b[3A', 'abc'],
    ['\x1b]0;window title\x07x\x1b]8;;https://example.com/\x1b\\link\x1b]8;;\x1b\\', 'xlink'],
    ['\x1b(Bkeep\x1b7\x1b=\x1b8', 'keep'],
    ['\x1bPdevice control\x1b\\after', 'after'],
    ['ok\x1b[31', 'ok'],
    ['ok\x1b[', 'ok'],
    ['ok\x1b', 'ok'],
    ['ok\x1b]0;never terminated', 'ok'],
    ['\u009b2Jc1\u009d0;title\u0007 done', 'c1 done'],
    ['tab\tkept\r', 'tab\tkept'],
    ['bell\x07 back\x08space\x00', 'bell backspace']
  ]
  for (const [line, expected] of noisy) {
    const spans = ansiSpans(line)
    assertClean(spans)
    assert.equal(text(spans), expected, JSON.stringify(line))
  }
  assertClean(markup)
  assert.deepEqual(ansiSpans(''), [])
  assert.deepEqual(ansiSpans('\x1b[31m\x1b[0m'), [])
})

test('ansiSpans turns SGR codes into classes', () => {
  assert.deepEqual(ansiSpans('\x1b[1;2;3;4mx'), [{ text: 'x', classes: ['b', 'dim', 'i', 'u'] }])
  assert.deepEqual(ansiSpans('\x1b[1;31;42mA\x1b[22mB\x1b[39;49mC'), [
    { text: 'A', classes: ['b', 'fg-1', 'bg-2'] },
    { text: 'B', classes: ['fg-1', 'bg-2'] },
    { text: 'C', classes: [] }
  ])
  assert.deepEqual(ansiSpans('\x1b[3;4mx\x1b[23my\x1b[24mz'), [
    { text: 'x', classes: ['i', 'u'] },
    { text: 'y', classes: ['u'] },
    { text: 'z', classes: [] }
  ])
  assert.deepEqual(ansiSpans('\x1b[30mk\x1b[37mw\x1b[90mK\x1b[97mW'), [
    { text: 'k', classes: ['fg-0'] },
    { text: 'w', classes: ['fg-7'] },
    { text: 'K', classes: ['fg-8'] },
    { text: 'W', classes: ['fg-15'] }
  ])
  assert.deepEqual(ansiSpans('\x1b[40mk\x1b[47mw\x1b[100mK\x1b[107mW'), [
    { text: 'k', classes: ['bg-0'] },
    { text: 'w', classes: ['bg-7'] },
    { text: 'K', classes: ['bg-8'] },
    { text: 'W', classes: ['bg-15'] }
  ])
  assert.deepEqual(ansiSpans('\x1b[1;31mred\x1b[mplain'), [
    { text: 'red', classes: ['b', 'fg-1'] },
    { text: 'plain', classes: [] }
  ])
  assert.deepEqual(ansiSpans('\x1b[31ma\x1b[31mb'), [{ text: 'ab', classes: ['fg-1'] }])
  assert.deepEqual(ansiSpans('\x1b[5;7;9;53mx'), [{ text: 'x', classes: [] }])
})

test('ansiSpans consumes and ignores extended colours', () => {
  assert.deepEqual(ansiSpans('\x1b[32mg\x1b[38;5;196mx\x1b[48;2;1;2;3my'), [{ text: 'gxy', classes: ['fg-2'] }])
  assert.deepEqual(ansiSpans('\x1b[38;5;1;4mx'), [{ text: 'x', classes: ['u'] }])
  assert.deepEqual(ansiSpans('\x1b[48;2;10;20;30;1mx'), [{ text: 'x', classes: ['b'] }])
  assert.deepEqual(ansiSpans('\x1b[38:2::255:0:0;1mx'), [{ text: 'x', classes: ['b'] }])
  assert.deepEqual(ansiSpans('\x1b[38;5mx'), [{ text: 'x', classes: [] }])
})

test('plainText drops escapes and control characters but keeps the words', () => {
  assert.equal(plainText('\x1b[31mERROR:\x1b[0m failed to solve'), 'ERROR: failed to solve')
  assert.equal(plainText('no escapes <b>here</b>'), 'no escapes <b>here</b>')
  assert.equal(plainText('\x1b]8;;https://example.com/\x07link\x1b]8;;\x07'), 'link')
})
