import * as fs from 'node:fs/promises'
import { assert, test } from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { MAX_COMMENTS_SHOWN, MAX_FILE_ROWS, MAX_THREAD_CARDS } from '../src/panel/prs/review/fit'
import { MERGED_SHOWN } from '../src/panel/prs/rows'
import { GROUP_PAGE, MAX_TITLE_CHARS } from '../src/panel/work/plan'
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

const GUIDES = ['README.md', 'docs/connecting.md', 'docs/work.md', 'docs/pull-requests.md', 'docs/pipelines.md', 'docs/wiki.md', 'docs/reference.md', 'docs/development.md']

async function readme(): Promise<string> {
  const files = await Promise.all(GUIDES.map(path => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8')))
  return files.map((text, index) => `\n## [${GUIDES[index]}]\n${text}`).join('\n')
}

function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`)
  assert.ok(start >= 0, `the README has a ${title} section`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

test('the README lists every built feature under What it does and links each guide', async () => {
  const text = await readme()
  const works = section(text, 'What it does')
  for (const feature of [/pipelines/i, /notifications/i, /PR reviews/, /wiki/i]) assert.match(works, feature)
  for (const guide of GUIDES.slice(1)) assert.ok(works.includes(`](${guide})`) || section(text, 'Documentation').includes(`](${guide})`), `the README links ${guide}`)
  assert.ok(!/\|\s*Coming\s*\|/.test(text), 'nothing is left under Coming')
})

test('the README stays a short landing page', async () => {
  const landing = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(landing.split('\n').length <= 120, 'the README is at most 120 lines; details go in docs/')
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
  const pending = text.slice(start)
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
  assert.match(wiki, /\*\*Publish\*\*, \*\*Open\*\* and \*\*Discard…\*\* are on the draft's row under \*\*Drafts · N\*\*, above the page tree/)
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
  const pending = text.slice(start)
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
  const pending = text.slice(start)
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
  const pending = text.slice(start)
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
  const pending = text.slice(start)
  for (const topic of [/Open in tab/, /Mermaid[^\n]*both forms/, /child tasks[^\n]*real board/i, /swimlanes/, /360 px[^\n]*light and dark/]) {
    assert.match(pending, topic)
  }
})

test('the pending live checks list each done-means check of the overhaul', async () => {
  const text = await readme()
  const start = text.indexOf('\nPanel overhaul:\n')
  const pending = text.slice(start)
  for (const check of [
    /every card's project is visible without opening it/,
    /several repositories splits[^\n]*single repository stays flat/,
    /project and repository pickers survive a reload/,
    /nothing that showed before is missing/,
    /\*\*Columns\*\* and \*\*Lanes\*\* on a board with swimlanes/,
    /Work view and open groups survive a reload/,
    /folders look different from pages/,
    /both Mermaid forms drawn[^\n]*wide table readable/,
    /Stage chips on every run card/
  ]) {
    assert.match(pending, check)
  }
})

test("the README says the Open in tab copy is the sidebar's cleaned Markdown that only Open in tab rewrites, and what child tasks a Work load reads", async () => {
  const text = await readme()
  const reading = subsection(section(text, 'The Wiki tab'), 'Open in tab')
  assert.match(reading, /same cleaned Markdown as the sidebar: images are links/)
  const pending = text.slice(text.indexOf('\nPanel overhaul:\n'))
  assert.match(pending, /pressing \*\*Open in tab\*\* again while the tab is open rewrites the copy and the open tab shows the new text/)
  assert.ok(!pending.includes('Refresh while the tab is open'), "the page's Refresh reloads only the sidebar page")
  const work = section(text, 'Polling')
    .split('\n')
    .find(line => line.startsWith('- My work:'))
  assert.match(work ?? '', /the parents of your tasks and the child tasks of your items and of those parents\./)
})

test('each toolbar is two rows, the controls then Updated and the icon buttons, and its views are one switch', async () => {
  const text = await readme()
  const toolbars: [string, RegExp, string][] = [
    ['The Work tab', /The first has the board's label and a \*\*Columns\*\* and \*\*Lanes\*\* switch\./, 'Open board'],
    ['The PRs tab', /The first has the pickers \(see Projects and repositories\) and the \*\*Mine\*\* and \*\*To review\*\* switch\./, 'Teams channels'],
    ['The Pipelines tab', /The first has the pickers and the filters \(see Filters\)\./, 'Teams channels']
  ]
  for (const [title, controls, last] of toolbars) {
    const body = section(text, title)
    assert.match(body, /The toolbar has two rows\./)
    assert.match(body, controls)
    assert.ok(
      body.includes(`The second has \`Updated …\` in muted text on the left and four icon buttons on the right: **Collapse all**, **Expand all**, **Refresh** and **${last}**.`),
      `${title}: the second row is Updated and the icon buttons`
    )
    assert.ok(!body.includes('under the toolbar'), `${title}: Updated isn't under the toolbar`)
  }
  assert.ok(section(text, 'The Pipelines tab').includes('The four filters are one switch in the toolbar.'), 'the run filters are one switch')
  assert.ok(!text.includes('is filled'), 'a chosen button is not called filled')
})

test('a group header carries its count and only the hint sits under it', async () => {
  const text = await readme()
  const prs = section(text, 'The PRs tab')
  for (const phrase of [
    "Its header line has the project's name and a count such as `3 sets`.",
    'a hint such as `1 needs you` sits under the header when something does',
    '`Fabrikam · fabrikam-web · 3 sets`',
    '`Fabrikam · 2 repos · 3 sets`'
  ]) {
    assert.ok(prs.includes(phrase), `The PRs tab: ${phrase}`)
  }
  const pipelines = section(text, 'The Pipelines tab')
  for (const phrase of [
    "Its header line has the project's name and a count such as `4 runs`, and one hint sits under it: `1 needs you`, else `2 failed`, else `1 running`.",
    '`Fabrikam · fabrikam-api · 4 runs`',
    '`Fabrikam · 2 repos · 4 runs`'
  ]) {
    assert.ok(pipelines.includes(phrase), `The Pipelines tab: ${phrase}`)
  }
  assert.ok(section(text, 'The Work tab').includes('with the number of items in its header, such as `Active · 3`'), 'a Work group counts in its header')
  assert.ok(!text.includes('a muted count such as'), 'the count is no longer a separate muted part')
})

test('a Work card is a title cut at the limit, a second line with Move at the right and tasks on a shaded panel', async () => {
  const work = section(await readme(), 'The Work tab')
  assert.ok(work.includes(`one pressable line cut with \`…\` after ${MAX_TITLE_CHARS} characters`), 'the title cut is stated')
  assert.match(work, /The second has, on the left, the type's icon[^\n]*\*\*Tasks n\/m\*\* when the item has tasks\. On the right is a compact \*\*Move\*\* box\./)
  assert.match(work, /shows its tasks inside it while they are open/)
  const tasks = subsection(work, 'Tasks under their parent')
  assert.match(tasks, /opens or closes the list, which shows inside the card on a shaded panel/)
  assert.match(tasks, /A task is one line: its `#id`, its title and its state\. Press the `#id` to open the details; finished tasks open too\./)
  assert.match(tasks, /When the task isn't yours, the assignee's name or `Unassigned` follows the title/)
  assert.match(tasks, /A finished task has a muted title and its state in a success badge\./)
  assert.match(tasks, /Your own open task shows its state as the placeholder of its \*\*Move\*\* box, which moves it\./)
  assert.match(tasks, /with no state to move to shows its state as a badge/)
  assert.match(tasks, /shows dimmed, in the column \(and lane\) it is in, with a small progress bar beside \*\*Tasks n\/m\*\*/)
  assert.ok(!tasks.includes('Press a title to open the details'), 'the title of a task is not the press target')
  assert.ok(!tasks.includes("Finished tasks are muted and don't open"), 'a finished task opens from its id')
})

test('the PRs tab puts waiting for under the row, and the review header has a heading, two icon buttons and a check mark on your vote', async () => {
  const text = await readme()
  const prs = section(text, 'The PRs tab')
  assert.ok(prs.includes("`waiting for …` sits under the pull request's row and names the required reviewers who haven't voted or declined."))
  assert.ok(!prs.includes('Beside the chip'), 'waiting for is not beside the chip')
  const review = section(text, 'Reviewing a pull request')
  assert.match(review, /At the right of the same row are two icon buttons: \*\*Refresh\*\* reads the pull request again, and \*\*Open in Azure DevOps\*\* opens it on the website\./)
  assert.match(review, /The header shows the title as a heading, then `Pull Request N`/)
  assert.ok(!review.includes('\n**Open in Azure DevOps** opens it'), 'Open in Azure DevOps is not a separate header line')
  assert.match(subsection(review, 'Votes'), /The button for your current vote shows a check mark\./)
})

test('a run card has a short state badge, the age at the right, and Share for approval in the approval row', async () => {
  const card = subsection(section(await readme(), 'The Pipelines tab'), 'A run card')
  assert.match(card, /The state badge, the pipeline's name and, at the right, the run's age: when it finished, else when it started, else when it was queued\./)
  assert.ok(
    card.includes('The badge reads `queued`, `running`, `waiting` (for an approval), `cancelling`, `✓ succeeded`, `! partial` (partially succeeded), `✕ failed` or `canceled`.'),
    'the badge texts are listed'
  )
  assert.match(card, /One warning line for each approval the run waits on, with that approval's buttons under it/)
  assert.match(card, /\*\*Open in Azure DevOps\*\* \(an icon button\) opens the run on the website\./)
  assert.match(card, /\*\*Share for approval\*\* isn't in that row\. While the run waits for an approval, it sits in the button row of the last approval, beside \*\*Approve…\*\* and \*\*Reject…\*\* when you can decide/)
  assert.ok(!card.includes('- **Share for approval** shows'), 'Share for approval is not in the run buttons')
  assert.ok(!card.includes('waiting for approval, cancelling'), 'the badge says waiting')
})

test('a wiki page has icon buttons for Open in Azure DevOps and Refresh, and a draft is a compact row under Drafts · N', async () => {
  const text = await readme()
  const wiki = section(text, 'The Wiki tab')
  assert.match(
    wiki,
    /one row of actions: \*\*Open in tab\*\*, \*\*Edit in Orca\*\* \(project wikis only\) and \*\*Open in Azure DevOps\*\*, an icon button shown when the page has a web address\. \*\*Refresh\*\*, also an icon, is at the right of the row and reloads only that page\./
  )
  assert.match(wiki, /\*\*Drafts · N\*\* lists your drafts as compact rows\. A row has the page's name, a status line, \*\*Publish\*\*, an \*\*Open\*\* icon and a \*\*Discard…\*\* icon\./)
  assert.match(wiki, /`Saved changes not published yet\.` or `No changes since you opened or published it\.`, followed by `Published` and when/)
  assert.match(wiki, /its tooltip shows the file's path under `\.orca-ado\/`/)
  assert.match(wiki, /A row doesn't show the workspace or the file\. It shows the wiki's name only when your drafts come from more than one wiki\./)
  assert.match(wiki, /The group starts open, and the tab remembers if you fold it, for each organisation\./)
  for (const stale of ['Drafts (N)', "the draft's card", 'their page, wiki, workspace and file']) {
    assert.ok(!text.includes(stale), `${stale} no longer describes the drafts`)
  }
})
