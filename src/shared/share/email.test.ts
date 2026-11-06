import { assert, test } from 'orca/testing'
import { MAX_MAIL_URL, mailtoUrl } from './email'

test('mailtoUrl encodes recipients, subject and body, and refuses past 2,000 characters or with nobody', () => {
  const url = mailtoUrl({
    to: ['grace@contoso.com', 'dennis+ops@contoso.com'],
    subject: 'Approval needed: web-app-cd 20261105.3',
    body: 'Approval needed for production: web-app-cd 20261105.3 on main\nhttps://dev.azure.com/contoso/Fabrikam%20Web/_build/results?buildId=4520&x=1'
  })
  assert.equal(
    url,
    'mailto:grace%40contoso.com,dennis%2Bops%40contoso.com' +
      '?subject=Approval%20needed%3A%20web-app-cd%2020261105.3' +
      '&body=Approval%20needed%20for%20production%3A%20web-app-cd%2020261105.3%20on%20main%0A' +
      'https%3A%2F%2Fdev.azure.com%2Fcontoso%2FFabrikam%2520Web%2F_build%2Fresults%3FbuildId%3D4520%26x%3D1'
  )

  const base = mailtoUrl({ to: ['a@b.co'], subject: '', body: '' })
  assert.equal(base, 'mailto:a%40b.co?subject=&body=')
  assert.equal(MAX_MAIL_URL, 2000)
  const fits = mailtoUrl({ to: ['a@b.co'], subject: '', body: 'x'.repeat(MAX_MAIL_URL - base!.length) })
  assert.equal(fits?.length, MAX_MAIL_URL)
  assert.equal(mailtoUrl({ to: ['a@b.co'], subject: '', body: 'x'.repeat(MAX_MAIL_URL - base!.length + 1) }), null)
  assert.equal(mailtoUrl({ to: ['a@b.co'], subject: 's'.repeat(MAX_MAIL_URL), body: '' }), null)
  assert.equal(mailtoUrl({ to: ['a@b.co'], subject: '', body: '🚀'.repeat(300) }), null)
  assert.equal(mailtoUrl({ to: [], subject: 'Approval needed', body: 'hi' }), null)
})

test('mailtoUrl replaces a lone surrogate instead of throwing', () => {
  assert.equal(mailtoUrl({ to: ['a@b.co'], subject: 'a\uD83Db', body: 'c\uDE00d' }), 'mailto:a%40b.co?subject=a%EF%BF%BDb&body=c%EF%BF%BDd')
})
