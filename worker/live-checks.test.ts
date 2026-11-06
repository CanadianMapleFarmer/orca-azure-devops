import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'

const LIVE_STEPS = ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)', '(h2)', '(i)', '(j)', 'Step 4']

function read(path: string): Promise<string> {
  return fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('the spike record lists a pending live row for every Task 9 live check and the screenshots', async () => {
  const record = await read('docs/superpowers/spikes/2026-11-05-plan-6.md')
  const start = record.indexOf('\n## Pending live (Task 9)\n')
  assert.ok(start >= 0, 'the spike record has a Pending live section')
  const end = record.indexOf('\n## ', start + 1)
  const rows = record
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter(line => line.startsWith('|'))
    .map(line => line.split('|').map(cell => cell.trim()))
  const missing = LIVE_STEPS.filter(step => !rows.some(cells => cells[2] === step))
  assert.deepEqual(missing, [])
  const unmarked = rows.filter(cells => LIVE_STEPS.includes(cells[2]) && !cells[3].includes('**pending live**'))
  assert.deepEqual(unmarked, [], 'each row is pending live until its result is filled in')
})

test('roadmap row 6 names Sign in with Microsoft and the hand-written flow, not MSAL', async () => {
  const roadmap = await read('docs/superpowers/plans/2026-11-03-roadmap.md')
  const row = roadmap.split('\n').find(line => line.startsWith('| 6 |'))
  assert.ok(row, 'the roadmap has a row 6')
  assert.ok(row.includes('Sign in with Microsoft (Entra auth code + PKCE, loopback; Plan 6 ruling P1)'))
  assert.ok(!row.includes('MSAL'), 'row 6 no longer promises MSAL')
})
