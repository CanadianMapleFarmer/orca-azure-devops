import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { MAX_COMMENTS_SHOWN, MAX_FILE_ROWS, MAX_THREAD_CARDS } from '../src/panel/prs/review/fit'
import { MERGED_SHOWN } from '../src/panel/prs/rows'
import { GROUP_PAGE } from '../src/panel/work/plan'
import { MAX_DIFF_BYTES } from '../src/shared/diff'
import { MAX_STAGE_CHIPS } from '../src/shared/pipelines'
import { MAX_REVIEW_COMMENT } from '../src/shared/reviews'
import { APPROVAL_TEMPLATE, APPROVAL_VARS } from '../src/shared/share/approval-items'
import { MAX_DRAFTS, MIN_SEARCH_CHARS } from '../src/shared/wiki'
import { WIDE_TABLE_CHARS, WIDE_TABLE_COLUMNS } from '../src/shared/wiki-blocks'
import { MAX_CHILD_TASKS } from '../src/shared/work'
import { ADO_RESOURCE } from './ado/org'
import { ENTRA_SIGN_IN_TIMEOUT_MS } from './auth/entra-provider'
import { ENTRA, entraFailed, NETWORK, NO_LOCAL_WORKSPACE_WIKI, READER_CUT_NOTE, REDIRECT_PAGE, TASKS_NOT_LOADED } from './messages'
import { LOOPBACK_NO_PROXY, MAX_CA_FILE_BYTES } from './net/network'
import { MAX_EDITS, MAX_SIDE_LINES } from './reviews/diff'
import { MAX_COMMENT_BYTES, MAX_COMMENTS_PER_THREAD, MAX_THREADS } from './reviews/threads'
import { MAX_PUBLISH_BYTES } from './wiki/publish'
import { MAX_READER_BYTES } from './wiki/reader'
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

test('the README says where Publish is, how a draft status ages, where an image link leads and what a -2 branch means', async () => {
  const text = await readme()
  const wiki = section(text, 'The Wiki tab')
  assert.match(wiki, /Publish, \*\*Open\*\* and \*\*Discard\*\* are on the draft's card under \*\*Drafts \(N\)\*\*, above the page tree/)
  assert.match(wiki, /On a page, press the back link above its title to reach them/)
  assert.match(wiki, /status is as of the last time the list loaded; Publish always reads the saved file/)
  assert.match(wiki, /an attachment image links to the page in Azure DevOps, where it shows/)
  assert.match(section(text, 'Reviewing a pull request'), /Pushing from `<source>-2` creates a new branch on the remote; it does not update the pull request/)
  assert.match(text, /lists the active pull requests you have voted on: active, not a draft, not created by you, you voted and haven't declined/)
  assert.ok(!text.includes('under the same rules'), 'the Reviewed by you rule is spelled out')
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

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const NIL_GUID = '00000000-0000-0000-0000-000000000000'
const FIXER = /Your (network )?admin fixes it|You fix it/

function subsection(text: string, title: string): string {
  const start = text.indexOf(`\n### ${title}\n`)
  assert.ok(start >= 0, `the section has a ${title} subsection`)
  const end = text.slice(start + 1).search(/\n##+ /)
  return text.slice(start, end < 0 ? undefined : start + 1 + end)
}

test('the Microsoft account method, its credentials and its app registration are named where a reader chooses a method', async () => {
  const text = await readme()
  const connecting = section(text, 'Connecting an organisation')
  const azure = connecting.indexOf('- **Azure CLI (no setup).**')
  const microsoft = connecting.indexOf('- **Microsoft account (needs an app ID).**')
  const pat = connecting.indexOf('- **Personal access token.**')
  assert.ok(azure >= 0 && azure < microsoft && microsoft < pat, 'the Microsoft account sits between the Azure CLI and the PAT')
  assert.ok(
    connecting.includes(
      "Signs in with Microsoft Entra ID through an app your admin registers once (see below). It doesn't need the Azure CLI, so it also suits Windows (not yet checked live)."
    )
  )
  const credentials = subsection(connecting, 'Where credentials live')
  assert.match(credentials, /- \*\*Microsoft:\*\* the refresh token for each organisation is kept in Orca's encrypted secrets, which needs an OS keyring;/)
  assert.match(credentials, /access tokens stay in memory and are renewed before they expire\. Sign out deletes it\. It doesn't sign you out of Microsoft in your browser\./)
  assert.match(section(text, 'Requirements'), /Sign in with Microsoft[^\n]*app registration/)
})

test('Sign in with Microsoft walks through the five steps, the account rules and the listener', async () => {
  const guide = section(await readme(), 'Sign in with Microsoft')
  assert.match(guide, /\n1\. [^\n]*`entraClientId`/)
  assert.match(guide, /\n2\. [^\n]*Microsoft account \(needs an app ID\)[^\n]*\*\*Connect\*\*/)
  assert.match(guide, /\n3\. [^\n]*\*\*Open sign-in page\*\*[^\n]*`login\.microsoftonline\.com`[^\n]*"Always allow"/)
  assert.ok(guide.includes(`\n4. `) && guide.includes(`"${REDIRECT_PAGE.done}"`), 'the tab text is quoted as the redirect page shows it')
  assert.match(guide, /\n5\. [^\n]*`signed in as <account>`/)
  assert.match(guide, /The account picker shows every time\. The organisation is pinned, and another account is refused\./)
  assert.match(guide, new RegExp(`Cancel works at any time, and a sign-in stops after ${ENTRA_SIGN_IN_TIMEOUT_MS / 60_000} minutes\\.`))
  assert.match(guide, /listens only on `127\.0\.0\.1`, and only for that one sign-in/)
  assert.match(guide, /Reconnect/)
})

test('the Microsoft troubleshooting is keyed by AADSTS code and quotes every other message the plugin can show', async () => {
  const troubleshooting = subsection(section(await readme(), 'Sign in with Microsoft'), 'Troubleshooting')
  const codes = ['AADSTS50011', 'AADSTS700016', 'AADSTS50020', 'AADSTS90094', 'AADSTS65001', 'AADSTS650057', 'AADSTS7000218', 'AADSTS9002326']
  assert.deepEqual(
    codes.filter(code => !troubleshooting.includes(`\`${code}\``)),
    []
  )
  for (const code of codes) {
    const entry = troubleshooting.split('\n').find(line => line.startsWith('- ') && line.includes(`\`${code}\``))
    assert.ok(entry && FIXER.test(entry), `${code} says who fixes it`)
  }
  const keyedByCode = new Set<string>([ENTRA.consent, ENTRA.appNotFound, ENTRA.redirect, ENTRA.publicClient, ENTRA.apiPermission, ENTRA.wrongDirectory])
  const quoted = Object.values(ENTRA).filter(message => !keyedByCode.has(message))
  assert.deepEqual(
    quoted.filter(message => !troubleshooting.includes(`\`${message}\``)),
    []
  )
  for (const message of quoted) {
    const entry = troubleshooting.split('\n').find(line => line.startsWith('- ') && line.includes(`\`${message}\``))
    assert.ok(entry && FIXER.test(entry), `${message} says who fixes it`)
  }
  assert.ok(troubleshooting.includes(`\`${entraFailed('<code>')}\``), 'the generic failure is explained')
  assert.match(troubleshooting, /cancel[^\n]*in Orca[^\n]*rather than[^\n]*time out/i)
})

test('the admin guide is generic, marks its portal labels as unchecked and cites only the Azure DevOps application ID', async () => {
  const text = await readme()
  const guide = section(text, 'Registering the app (for admins)')
  assert.match(guide, /haven't been checked against the live portal/)
  for (const label of [
    'App registrations → New registration',
    'Accounts in this organizational directory only',
    'Accounts in any organizational directory',
    'Public client/native (mobile & desktop)',
    'Authentication → Advanced settings → Allow public client flows',
    'API permissions → Add a permission → APIs my organization uses',
    'Delegated → `user_impersonation` → Add',
    'Grant admin consent for',
    'Application (client) ID'
  ]) {
    assert.ok(guide.includes(label), `${label} is quoted`)
  }
  assert.ok(guide.includes('`http://localhost`'))
  assert.ok(guide.includes(`(\`${ADO_RESOURCE}\`)`), 'the Azure DevOps application ID is given')
  assert.match(guide, /Don't create a client secret or certificate/)
  assert.match(guide, /AADSTS7000218/)
  for (const note of [/Microsoft Entra ID[^\n]*personal Microsoft accounts[^\n]*Azure CLI or a PAT/, /Conditional Access/, /Removing consent, or deleting the registration, stops every saved sign-in/]) {
    assert.match(guide, note)
  }
  const ids = new Set(text.match(GUID) ?? [])
  assert.deepEqual([...ids].sort(), [NIL_GUID, ADO_RESOURCE].sort(), 'no tenant, organisation or app values')
})

test('Proxies and certificates says why the settings exist and what each one, az and Connection status do', async () => {
  const text = await readme()
  const network = section(text, 'Proxies and certificates')
  for (const variable of ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) assert.ok(network.includes(`\`${variable}\``), `${variable} is named`)
  for (const key of ['httpsProxy', 'caCertificatesFile', 'useSystemCertificates']) assert.ok(network.includes(`\`${key}\``), `${key} is described`)
  for (const host of LOOPBACK_NO_PROXY.split(',')) assert.ok(network.includes(host), `${host} bypasses the proxy`)
  assert.match(network, /Proxies that need a password aren't supported/)
  assert.ok(network.includes(`up to ${MAX_CA_FILE_BYTES / 1024 / 1024} MiB`), 'the certificate file cap is stated')
  assert.match(network, /`az` uses the proxy but not the certificate settings/)
  assert.match(network, /Sign in with Microsoft or a PAT/)
  assert.match(network, /new connections only/)
  assert.match(network, /Orca[^\n]*too old[^\n]*says so/)
  const status = manifest.contributes.commands.find(command => command.id === 'status')
  assert.ok(status && network.includes(`**${status.title}**`), 'the Connection status command is named by its title')
  assert.match(network, /lists any setting that was ignored, and why/)
  assert.ok(network.includes(`\`${NETWORK.proxyInUse}\``), 'the proxy-in-use note is quoted')
  assert.ok(network.includes(`\`${NETWORK.applyFailed}\``), 'the apply-failed note is quoted')
})

test('every Microsoft and network setting is documented with the default the manifest declares', async () => {
  const lines = section(await readme(), 'Settings').split('\n')
  for (const key of ['entraClientId', 'entraTenant', 'httpsProxy', 'caCertificatesFile', 'useSystemCertificates']) {
    const setting = manifest.contributes.settings.find(item => item.key === key)
    assert.ok(setting, `${key} is in the manifest`)
    const line = lines.find(item => item.startsWith(`- \`${key}\` `))
    assert.ok(line, `${key} has a line in Settings`)
    assert.ok(line.includes(`(${setting.title})`), `${key} names its title`)
    assert.ok(line.includes(setting.default === true ? 'On by default.' : setting.default === false ? 'Off by default.' : 'Empty by default.'), `${key} says its default`)
  }
})

test('the pending live checks name the Microsoft sign-in and network checks', async () => {
  const text = await readme()
  const start = text.indexOf('\nMicrosoft sign-in and network:\n')
  assert.ok(start >= 0, 'the pending live checks have a Microsoft sign-in and network list')
  const pending = text.slice(start, text.indexOf('\n## License'))
  for (const topic of [
    /admin guide[^\n]*portal labels/,
    /consent dialog[^\n]*login\.microsoftonline\.com/,
    /account picker/,
    /Safari, Chrome and Firefox/,
    /AADSTS7000218/,
    /own page/,
    /Orca restart/,
    /wrong-account/,
    /lsof/,
    /Sign out/,
    /proxy/,
    /both themes/
  ]) {
    assert.match(pending, topic)
  }
})

test('the pending Microsoft checks name the sign-in details, Reconnect and the client organisation', async () => {
  const text = await readme()
  const start = text.indexOf('\nMicrosoft sign-in and network:\n')
  assert.ok(start >= 0, 'the pending live checks have a Microsoft sign-in and network list')
  const pending = text.slice(start, text.indexOf('\n## License'))
  for (const topic of [/`signed in as <account>`/, /browser tab/, /Reconnect[^\n]*needs the browser again/, /client organisation[^\n]*Sign in with Microsoft/]) {
    assert.match(pending, topic)
  }
})

test('the README describes the grouped tabs, Columns and Lanes, tasks under their parent and Open in tab', async () => {
  const text = await readme()
  const expected: Record<string, string[]> = {
    'The PRs tab': ['Across repos', 'Across projects', '**Mine**', '**To review**', '`To review · 3 of 12`', '`+ N merged · show`', '\n### Approve\n', '\n### Auto-complete\n'],
    'The Pipelines tab': ['**All projects**'],
    'The Work tab': ['**Columns**', '**Lanes**', '**Not on this board**', '**No parent**', 'Collapse all', 'Expand all', '`+ N more`'],
    'The Wiki tab': ['**Open in tab**']
  }
  const missing = Object.entries(expected).flatMap(([title, phrases]) => {
    const body = section(text, title)
    return phrases.filter(phrase => !body.includes(phrase)).map(phrase => `${title}: ${phrase}`)
  })
  assert.deepEqual(missing, [])
  for (const stale of ['Approve all', 'Auto-complete all', '**Other**', '**To review (N)**', 'Waiting for approval** box']) {
    assert.ok(!text.includes(stale), `${stale} no longer describes the panel`)
  }
})

test('the README states the task, group, merged row, wide table and reader limits the code enforces', async () => {
  const text = await readme()
  const work = section(text, 'The Work tab')
  assert.ok(work.includes(`up to ${MAX_CHILD_TASKS} tasks`), 'the child task cap is stated')
  assert.ok(work.includes(`A group shows ${GROUP_PAGE} items`), 'the group page size is stated')
  assert.ok(work.includes(`\`${TASKS_NOT_LOADED}\``), 'the failed child read message is quoted')
  assert.ok(section(text, 'The PRs tab').includes(`the first ${MERGED_SHOWN} merged pull requests`), 'the merged rows kept in view are stated')
  const wiki = section(text, 'The Wiki tab')
  assert.ok(wiki.includes(`${WIDE_TABLE_COLUMNS} or more columns`), 'the wide table column count is stated')
  assert.ok(wiki.includes(`more than ${WIDE_TABLE_CHARS} characters`), 'the wide table width is stated')
  assert.ok(wiki.includes(`over ${MAX_READER_BYTES / 1024} KiB`), 'the size a copy is cut at is stated')
})

test('the README states which child tasks are listed and in what order, when a list starts open, and keeps panel choices out of storage:own', async () => {
  const text = await readme()
  const tasks = subsection(section(text, 'The Work tab'), 'Tasks under their parent')
  assert.match(tasks, /Removed[^\n]*left out/)
  assert.match(tasks, /your open tasks[^\n]*other people's open tasks[^\n]*finished/i)
  assert.ok(tasks.includes(`more than ${MAX_CHILD_TASKS} of the open tasks are yours, all of those show`), 'the yours-first overflow is stated')
  assert.ok(tasks.includes("its parent is dimmed or can't be read"), 'the open-by-default rule covers an unreadable parent')
  const grant = text.split('\n').find(line => line.startsWith('- `storage:own`'))
  assert.ok(grant, 'the Permissions list has a storage:own entry')
  assert.ok(!/panel choices|Columns or Lanes/.test(grant), 'panel choices are plugin-persisted atoms, not storage:own')
  assert.ok(!text.includes('stage bar'), 'the stage bar is gone from the panel')
})

test('the Wiki tab says where the Open in tab copy lives, that it is read-only and what a page cut for length gets', async () => {
  const wiki = section(await readme(), 'The Wiki tab')
  const reading = subsection(wiki, 'Open in tab')
  assert.match(reading, /\.orca-ado\/wiki-read\//)
  assert.match(reading, /read-only/)
  assert.match(reading, /Table of Contents/)
  assert.ok(reading.includes(`"${READER_CUT_NOTE}"`), 'the cut note is quoted')
  assert.ok(reading.includes(`\`${NO_LOCAL_WORKSPACE_WIKI}\``), 'the no-workspace refusal is quoted')
})

test('the pending live checks name the panel overhaul checks', async () => {
  const text = await readme()
  const start = text.indexOf('\nPanel overhaul:\n')
  assert.ok(start >= 0, 'the pending live checks have a Panel overhaul list')
  const pending = text.slice(start, text.indexOf('\n## License'))
  for (const topic of [/Open in tab/, /Mermaid[^\n]*both forms/, /child tasks[^\n]*real board/i, /swimlanes/, /360 px[^\n]*light and dark/]) {
    assert.match(pending, topic)
  }
})
