import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { MAX_COMMENTS_SHOWN, MAX_FILE_ROWS, MAX_THREAD_CARDS } from '../src/panel/prs/review/fit'
import { MAX_DIFF_BYTES } from '../src/shared/diff'
import { MAX_STAGE_CHIPS } from '../src/shared/pipelines'
import { MAX_REVIEW_COMMENT } from '../src/shared/reviews'
import { APPROVAL_TEMPLATE, APPROVAL_VARS } from '../src/shared/share/approval-items'
import { MAX_DRAFTS, MIN_SEARCH_CHARS } from '../src/shared/wiki'
import { MAX_EDITS, MAX_SIDE_LINES } from './reviews/diff'
import { MAX_COMMENT_BYTES, MAX_COMMENTS_PER_THREAD, MAX_THREADS } from './reviews/threads'
import { MAX_PUBLISH_BYTES } from './wiki/publish'
import { createArm } from './workspace/arm'

const STATUS_BAR = 'ADO · N failed · N approvals · N to review'

function readme(): Promise<string> {
  return fs.readFile(new URL('../README.md', import.meta.url), 'utf8')
}

function worksNow(text: string): string {
  const lines = text.split('\n')
  const header = lines.findIndex(line => /^\|\s*Works now\s*\|$/.test(line))
  assert.ok(header >= 0, 'the status table has a Works now column')
  const rows: string[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    rows.push(line.split('|')[1].trim())
  }
  return rows.join('\n')
}

function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`)
  assert.ok(start >= 0, `the README has a ${title} section`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

test('the status table lists every built feature under Works now and has no Coming column', async () => {
  const text = await readme()
  const works = worksNow(text)
  for (const feature of [/pipelines/i, /notifications/i, /PR reviews/, /wiki/i]) assert.match(works, feature)
  assert.ok(!/\|\s*Coming\s*\|/.test(text), 'nothing is left under Coming')
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

test('the review and wiki sections, the Reviewed by you list and the Wiki scope are documented', async () => {
  const text = await readme()
  assert.ok(text.includes('`vso.wiki_write`'), 'the Wiki scope is listed')
  assert.ok(text.includes('**Reviewed by you**'), 'the Reviewed by you list is described')
  assert.ok(!text.includes('Click a row to open it in Azure DevOps.'), 'a To review row opens the review, not the website')
  const review = section(text, 'Reviewing a pull request')
  for (const heading of ['### Votes', '### The diff', "#### What isn't shown", '### Comments and replies', '### Check out in Orca']) {
    assert.ok(review.includes(`\n${heading}\n`), `the review section has ${heading}`)
  }
  assert.match(review, /any project/)
  assert.match(review, /`<source>-2`/)
  assert.match(review, /compare base/)
  const wiki = section(text, 'The Wiki tab')
  for (const heading of ['### Reading', '### Edit in Orca', '### Publish', '### When the page changed']) {
    assert.ok(wiki.includes(`\n${heading}\n`), `the wiki section has ${heading}`)
  }
  for (const choice of ['Publish mine', 'Take theirs', 'Merge by hand', 'Discard']) assert.ok(wiki.includes(`**${choice}`), `${choice} is described`)
  assert.match(wiki, /\.orca-ado\/wiki\//)
})

test('the review and wiki limits are documented with the values the code enforces', async () => {
  const text = await readme()
  const number = (value: number) => value.toLocaleString('en-US')
  const review = section(text, 'Reviewing a pull request')
  const wiki = section(text, 'The Wiki tab')
  const armed = createArm(() => 0).arm({ org: 'contoso', branch: 'feature', base: 'origin/feature', prId: 1 }) / 60_000
  const missingFromReview = [
    `up to ${number(MAX_FILE_ROWS)} changed files`,
    `${MAX_DIFF_BYTES / 1024} KiB`,
    `more than ${number(MAX_EDITS)} changed lines`,
    `more than ${number(MAX_SIDE_LINES)} lines`,
    `up to ${number(MAX_REVIEW_COMMENT)} characters`,
    `at most ${MAX_THREADS} threads and ${MAX_COMMENTS_PER_THREAD} comments in each (the first and the newest ${MAX_COMMENTS_PER_THREAD - 1})`,
    `cuts a comment at ${number(MAX_COMMENT_BYTES)} bytes`,
    `up to ${MAX_THREAD_CARDS} threads with ${MAX_COMMENTS_SHOWN} comments each (the first and the newest ${MAX_COMMENTS_SHOWN - 1})`,
    `${armed} minutes`
  ].filter(claim => !review.includes(claim))
  const missingFromWiki = [
    `up to ${MAX_DRAFTS} drafts`,
    `at least ${MIN_SEARCH_CHARS} characters`,
    `over ${MAX_PUBLISH_BYTES / 1024 / 1024} MiB`
  ].filter(claim => !wiki.includes(claim))
  assert.deepEqual([...missingFromReview, ...missingFromWiki], [])
})

test('the pending live checks name the review and wiki checks', async () => {
  const text = await readme()
  const start = text.indexOf('\nReviews and wiki:\n')
  assert.ok(start >= 0, 'the pending live checks have a Reviews and wiki list')
  const pending = text.slice(start, text.indexOf('\n## License'))
  for (const topic of [/unchanged rename/, /binary/, /Resolve/, /draft pull request/, /Check out in Orca/, /compare base/, /detached/, /ETag/, /git status/, /Résumé/, /typeKey/, /360 px/]) {
    assert.match(pending, topic)
  }
})
