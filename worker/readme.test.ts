import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { MAX_STAGE_CHIPS } from '../src/shared/pipelines'
import { APPROVAL_TEMPLATE, APPROVAL_VARS } from '../src/shared/share/approval-items'

const STATUS_BAR = 'ADO · N failed · N approvals · N to review'

function readme(): Promise<string> {
  return fs.readFile(new URL('../README.md', import.meta.url), 'utf8')
}

function statusTable(text: string): { works: string; coming: string } {
  const lines = text.split('\n')
  const header = lines.findIndex(line => /^\|\s*Works now\s*\|\s*Coming\s*\|$/.test(line))
  assert.ok(header >= 0, 'the status table has a Works now and a Coming column')
  const rows: string[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    rows.push(line)
  }
  const cells = rows.map(row => row.split('|').slice(1, -1).map(cell => cell.trim()))
  return { works: cells.map(row => row[0]).join('\n'), coming: cells.map(row => row[1]).join('\n') }
}

test('the status table lists Pipelines under Works now and no longer under Coming', async () => {
  const { works, coming } = statusTable(await readme())
  assert.match(works, /pipelines/i)
  assert.ok(!/pipelines/i.test(coming), 'Pipelines is no longer under Coming')
  assert.match(works, /notifications/i)
})

test('every setting the manifest declares is documented by its key', async () => {
  const text = await readme()
  const undocumented = manifest.contributes.settings.map(setting => setting.key).filter(key => !text.includes(`\`${key}\``))
  assert.deepEqual(undocumented, [])
})

test('the approval share line is documented with its default and every placeholder', async () => {
  const text = await readme()
  assert.ok(text.includes(`\`${APPROVAL_TEMPLATE}\``), 'the default approval template is quoted')
  const missing = APPROVAL_VARS.filter(name => !text.includes(`\`{${name}}\``))
  assert.deepEqual(missing, [])
})

test('the Build scope, the notifications permission and the status bar text are documented', async () => {
  const text = await readme()
  assert.ok(text.includes('`vso.build_execute`'), 'the Build scope is listed')
  assert.ok(text.includes('`notifications:show`'), 'the notifications permission is named')
  assert.ok(text.includes(`\`${STATUS_BAR}\``), 'the status bar text is quoted')
})

test('the pending live checks name the Pipelines, run tab and notification checks', async () => {
  const text = await readme()
  const start = text.indexOf('\nPipelines and notifications:\n')
  assert.ok(start >= 0, 'the pending live checks have a Pipelines and notifications list')
  const pending = text.slice(start, text.indexOf('\n## License'))
  for (const topic of [/multi-stage/i, /Docker/, /Helm/, /rerun/i, /two-approver/i, /Teams chat/, /email/i, /notification/i, /X-RateLimit/, /360 px/]) {
    assert.match(pending, topic)
  }
})

test('the stage bar is documented with the cap the posted runs keep, and no overflow count', async () => {
  const text = await readme()
  assert.ok(text.includes(`Up to ${MAX_STAGE_CHIPS} stages show.`), 'the stage cap is stated')
  assert.ok(!text.includes('`+N more`'), 'the trimmed chips leave nothing for a +N more count')
})
