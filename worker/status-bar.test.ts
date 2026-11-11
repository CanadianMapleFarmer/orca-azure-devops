import { assert, test } from 'orca/testing'
import type { OrgState, OrgStatus } from '../src/shared/types'
import { createStatusBar, statusBarFor, statusText, type CountKind, type OrgCounts, type StatusBarState } from './status-bar'

function org(name: string, state: OrgState, message?: string): OrgStatus {
  return {
    org: name,
    url: `https://dev.azure.com/${name}`,
    method: 'pat',
    state,
    account: state === 'disconnected' ? null : { adoId: 'u1', uniqueName: `ada@${name}.com`, displayName: 'Ada', tenantId: null, objectId: null },
    ...(message ? { message } : {}),
    tokenStore: { kind: 'orca-secrets' },
    boards: null,
    codeProjects: 'all'
  }
}

test('statusBarFor shows a neutral item when no org is connected', () => {
  assert.deepEqual(statusBarFor([]), { text: 'ADO', tone: 'neutral', tooltip: 'Azure DevOps: not connected' })
})

test('statusBarFor is success when every org is connected', () => {
  assert.deepEqual(statusBarFor([org('contoso', 'connected')]), {
    text: 'ADO',
    tone: 'success',
    tooltip: 'Azure DevOps: contoso (ada@contoso.com)'
  })
  const both = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'connected')])
  assert.equal(both.tone, 'success')
  assert.equal(both.tooltip, 'Azure DevOps: contoso (ada@contoso.com)\nfabrikam (ada@fabrikam.com)')
})

test('statusBarFor warns when an org expired', () => {
  const item = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.')])
  assert.equal(item.tone, 'warning')
  assert.equal(item.tooltip, 'Azure DevOps: contoso (ada@contoso.com)\nfabrikam: Your sign-in expired. Reconnect to continue.')
})

test('statusBarFor is danger on a mismatch or error and names the org and its message', () => {
  const mismatch = 'Signed in as grace@contoso.com, but this org is pinned to ada@contoso.com.'
  const item = statusBarFor([org('contoso', 'mismatch', mismatch), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.')])
  assert.equal(item.tone, 'danger')
  assert.ok(item.tooltip.includes(`contoso: ${mismatch}`))

  const error = statusBarFor([org('fabrikam', 'error', "Azure DevOps didn't accept that sign-in.")])
  assert.equal(error.tone, 'danger')
  assert.equal(error.tooltip, "Azure DevOps: fabrikam: Azure DevOps didn't accept that sign-in.")
})

test('statusBarFor stays neutral while an org is signing in or signed out', () => {
  assert.equal(statusBarFor([org('contoso', 'connected'), org('fabrikam', 'signing-in')]).tone, 'neutral')
  const item = statusBarFor([org('contoso', 'disconnected')])
  assert.equal(item.tone, 'neutral')
  assert.equal(item.tooltip, 'Azure DevOps: contoso: not connected')
})

test('statusText lists each org on its own line', () => {
  assert.equal(
    statusText([org('contoso', 'connected'), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.'), org('adatum', 'signing-in')]),
    'contoso — connected as ada@contoso.com\nfabrikam — Your sign-in expired. Reconnect to continue.\nadatum — signing in'
  )
})

test('statusText tells the user how to connect when there are no orgs', () => {
  assert.equal(statusText([]), 'Not connected. Open the Azure DevOps panel to connect.')
})

test('status text lists network notes after the org lines, and after the not-connected line', () => {
  const notes = ["Couldn't read the extra CA certificates file, so it's ignored.", 'Using the HTTPS proxy from Settings.']
  assert.equal(
    statusText([org('contoso', 'connected'), org('fabrikam', 'expired')], new Map([['contoso', { toReview: 2 }]]), notes),
    [
      'contoso — connected as ada@contoso.com',
      'fabrikam — expired',
      '2 pull requests to review: contoso 2',
      "Couldn't read the extra CA certificates file, so it's ignored.",
      'Using the HTTPS proxy from Settings.'
    ].join('\n')
  )
  assert.equal(
    statusText([], undefined, notes),
    "Not connected. Open the Azure DevOps panel to connect.\nCouldn't read the extra CA certificates file, so it's ignored.\nUsing the HTTPS proxy from Settings."
  )
  assert.equal(statusText([], undefined, []), statusText([]))
})

test("statusText adds each connected org's detail lines under it", () => {
  const details = (name: string) => [`  ${name} detail 1`, `  ${name} detail 2`]
  assert.equal(
    statusText([org('contoso', 'connected'), org('fabrikam', 'expired'), org('adatum', 'connected')], counts({ contoso: 1 }), ['A note.'], details),
    [
      'contoso — connected as ada@contoso.com',
      '  contoso detail 1',
      '  contoso detail 2',
      'fabrikam — expired',
      'adatum — connected as ada@adatum.com',
      '  adatum detail 1',
      '  adatum detail 2',
      '1 pull request to review: contoso 1',
      'A note.'
    ].join('\n')
  )
  const orgs = [org('contoso', 'connected')]
  assert.equal(statusText(orgs, undefined, [], () => []), statusText(orgs))
})

function counts(entries: Record<string, number>): OrgCounts {
  return new Map(Object.entries(entries).map(([name, toReview]) => [name, { toReview }]))
}

function countsOf(entries: Record<string, Partial<Record<CountKind, number>>>): OrgCounts {
  return new Map(Object.entries(entries))
}

test('a to-review count shows in the text and tooltip and lifts the tone to accent', () => {
  const item = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'connected'), org('adatum', 'connected')], counts({ contoso: 2, fabrikam: 1, adatum: 0 }))
  assert.deepEqual(item, {
    text: 'ADO · 3 to review',
    tone: 'accent',
    tooltip: 'Azure DevOps: contoso (ada@contoso.com)\nfabrikam (ada@fabrikam.com)\nadatum (ada@adatum.com)\n3 pull requests to review: contoso 2, fabrikam 1'
  })
  assert.deepEqual(statusBarFor([org('contoso', 'connected')], counts({ contoso: 0 })), statusBarFor([org('contoso', 'connected')]))
})

test('a count lifts a neutral connection tone to accent', () => {
  const orgs = [org('contoso', 'connected'), org('fabrikam', 'signing-in')]
  assert.equal(statusBarFor(orgs).tone, 'neutral')
  assert.equal(statusBarFor(orgs, counts({ contoso: 1 })).tone, 'accent')
})

test('danger and warning connection tones win over the count', () => {
  const withCount = counts({ contoso: 4 })
  const warning = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'expired', 'Your sign-in expired. Reconnect to continue.')], withCount)
  assert.equal(warning.tone, 'warning')
  assert.equal(warning.text, 'ADO · 4 to review')
  const danger = statusBarFor([org('contoso', 'connected'), org('fabrikam', 'error', 'No.')], withCount)
  assert.equal(danger.tone, 'danger')
  assert.ok(danger.tooltip.endsWith('\n4 pull requests to review: contoso 4'))
})

test("counts of orgs that aren't connected are ignored, and an org that is gone loses its count", () => {
  const stale = counts({ fabrikam: 5, ghost: 2 })
  assert.deepEqual(statusBarFor([org('contoso', 'connected'), org('fabrikam', 'expired', 'Expired.')], stale), statusBarFor([org('contoso', 'connected'), org('fabrikam', 'expired', 'Expired.')]))
  const staleRuns = countsOf({ fabrikam: { failedRuns: 2, approvals: 1, toReview: 5 }, ghost: { failedRuns: 1, approvals: 1 } })
  const expired = [org('contoso', 'connected'), org('fabrikam', 'expired', 'Expired.')]
  assert.deepEqual(statusBarFor(expired, staleRuns), statusBarFor(expired))
  assert.equal(statusText(expired, staleRuns), statusText(expired))

  const seen: StatusBarState[] = []
  const bar = createStatusBar(state => seen.push(state))
  bar.setOrgs([org('contoso', 'connected'), org('fabrikam', 'connected')])
  bar.setCount('contoso', 'toReview', 2)
  bar.setCount('fabrikam', 'toReview', 1)
  bar.setOrgs([org('contoso', 'connected')])
  assert.deepEqual([...bar.counts()], [['contoso', { toReview: 2 }]])
  assert.equal(seen.at(-1)?.text, 'ADO · 2 to review')
  bar.setOrgs([org('contoso', 'connected'), org('fabrikam', 'connected')])
  assert.equal(seen.at(-1)?.text, 'ADO · 2 to review')

  bar.setCount('contoso', 'failedRuns', 1)
  bar.setCount('fabrikam', 'approvals', 3)
  bar.setOrgs([org('contoso', 'connected')])
  assert.deepEqual([...bar.counts()], [['contoso', { toReview: 2, failedRuns: 1 }]])
  assert.equal(seen.at(-1)?.text, 'ADO · 1 failed · 2 to review')
})

test('createStatusBar calls update only when the state changes, and null clears a count', () => {
  const seen: StatusBarState[] = []
  const bar = createStatusBar(state => seen.push(state))
  const orgs = [org('contoso', 'connected')]
  bar.setOrgs(orgs)
  bar.setOrgs([...orgs])
  assert.equal(seen.length, 1)
  bar.setCount('contoso', 'toReview', 2)
  bar.setCount('contoso', 'toReview', 2)
  assert.equal(seen.length, 2)
  assert.equal(seen.at(-1)?.text, 'ADO · 2 to review')
  bar.setCount('contoso', 'toReview', null)
  assert.equal(seen.length, 3)
  assert.deepEqual(seen.at(-1), statusBarFor(orgs))
  assert.equal(bar.counts().size, 0)
  bar.setCount('contoso', 'toReview', null)
  assert.equal(seen.length, 3)
})

test('statusText adds the review line', () => {
  const orgs = [org('contoso', 'connected'), org('fabrikam', 'connected')]
  assert.equal(
    statusText(orgs, counts({ contoso: 2, fabrikam: 1 })),
    'contoso — connected as ada@contoso.com\nfabrikam — connected as ada@fabrikam.com\n3 pull requests to review: contoso 2, fabrikam 1'
  )
  assert.equal(statusText(orgs, counts({ contoso: 0 })), statusText(orgs))
})

test('one pull request to review reads in the singular', () => {
  const orgs = [org('contoso', 'connected')]
  assert.ok(statusText(orgs, counts({ contoso: 1 })).endsWith('\n1 pull request to review: contoso 1'))
})

test('failed runs, approvals and reviews show in order with the worst tone', () => {
  const orgs = [org('contoso', 'connected'), org('fabrikam', 'connected')]
  const all = statusBarFor(orgs, countsOf({ contoso: { failedRuns: 1, approvals: 2, toReview: 3 }, fabrikam: { failedRuns: 2, approvals: 0, toReview: 1 } }))
  assert.deepEqual(all, {
    text: 'ADO · 3 failed · 2 approvals · 4 to review',
    tone: 'danger',
    tooltip: [
      'Azure DevOps: contoso (ada@contoso.com)',
      'fabrikam (ada@fabrikam.com)',
      '3 failed pipeline runs: contoso 1, fabrikam 2',
      '2 approvals waiting: contoso 2',
      '4 pull requests to review: contoso 3, fabrikam 1'
    ].join('\n')
  })

  const approvals = statusBarFor(orgs, countsOf({ contoso: { approvals: 2, toReview: 3 } }))
  assert.equal(approvals.text, 'ADO · 2 approvals · 3 to review')
  assert.equal(approvals.tone, 'warning')
  assert.equal(statusBarFor(orgs, countsOf({ fabrikam: { failedRuns: 1 } })).text, 'ADO · 1 failed')
  assert.equal(statusBarFor(orgs, countsOf({ fabrikam: { failedRuns: 1 } })).tone, 'danger')
  assert.equal(statusBarFor(orgs, countsOf({ fabrikam: { toReview: 1 } })).tone, 'accent')
  assert.deepEqual(statusBarFor(orgs, countsOf({ contoso: { failedRuns: 0, approvals: 0, toReview: 0 } })), statusBarFor(orgs))

  const expired = [org('contoso', 'connected'), org('fabrikam', 'expired', 'Expired.')]
  assert.equal(statusBarFor(expired, countsOf({ contoso: { approvals: 1 } })).tone, 'warning')
  assert.equal(statusBarFor(expired, countsOf({ contoso: { toReview: 1 } })).tone, 'warning')
  assert.equal(statusBarFor(expired, countsOf({ contoso: { failedRuns: 1 } })).tone, 'danger')
  const broken = [org('contoso', 'connected'), org('fabrikam', 'error', 'No.')]
  assert.equal(statusBarFor(broken, countsOf({ contoso: { approvals: 1, toReview: 1 } })).tone, 'danger')
  const signingIn = [org('contoso', 'connected'), org('fabrikam', 'signing-in')]
  assert.equal(statusBarFor(signingIn, countsOf({ contoso: { approvals: 1 } })).tone, 'warning')
})

test('one of each uses the singular', () => {
  const orgs = [org('contoso', 'connected')]
  const item = statusBarFor(orgs, countsOf({ contoso: { failedRuns: 1, approvals: 1, toReview: 1 } }))
  assert.equal(item.text, 'ADO · 1 failed · 1 approval · 1 to review')
  assert.ok(item.tooltip.includes('\n1 failed pipeline run: contoso 1\n1 approval waiting: contoso 1\n1 pull request to review: contoso 1'))
  assert.ok(!item.tooltip.includes('runs') && !item.tooltip.includes('approvals'))
})

test('statusText adds the run and approval lines', () => {
  const orgs = [org('contoso', 'connected'), org('fabrikam', 'connected')]
  assert.equal(
    statusText(orgs, countsOf({ contoso: { failedRuns: 1, approvals: 2 }, fabrikam: { approvals: 1, toReview: 1 } })),
    [
      'contoso — connected as ada@contoso.com',
      'fabrikam — connected as ada@fabrikam.com',
      '1 failed pipeline run: contoso 1',
      '3 approvals waiting: contoso 2, fabrikam 1',
      '1 pull request to review: fabrikam 1'
    ].join('\n')
  )
  assert.equal(statusText(orgs, countsOf({ contoso: { failedRuns: 0, approvals: 0 } })), statusText(orgs))
})

test('failed and approval counts set and clear like any other kind', () => {
  const seen: StatusBarState[] = []
  const bar = createStatusBar(state => seen.push(state))
  bar.setOrgs([org('contoso', 'connected')])
  bar.setCount('contoso', 'failedRuns', 2)
  bar.setCount('contoso', 'approvals', 1)
  assert.equal(seen.at(-1)?.text, 'ADO · 2 failed · 1 approval')
  bar.setCount('contoso', 'failedRuns', null)
  bar.setCount('contoso', 'approvals', null)
  assert.deepEqual(seen.at(-1), statusBarFor([org('contoso', 'connected')]))
  assert.equal(bar.counts().size, 0)
})
