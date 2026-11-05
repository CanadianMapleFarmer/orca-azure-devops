import { assert, test } from 'orca/testing'
import { MAX_CHAT_URL, teamsChatUrl } from './teams'

test('teamsChatUrl encodes users, message and tenant, and refuses past 2000 characters', () => {
  const url = teamsChatUrl({
    users: ['alex.morgan@contoso.com', 'grace+ops@contoso.com'],
    text: "Pull Request 1: Fix & flag (x)\nhttps://dev.azure.com/contoso/a b",
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47'
  })
  assert.equal(
    url,
    'https://teams.microsoft.com/l/chat/0/0?users=alex.morgan%40contoso.com,grace%2Bops%40contoso.com' +
      '&message=Pull%20Request%201%3A%20Fix%20%26%20flag%20(x)%0Ahttps%3A%2F%2Fdev.azure.com%2Fcontoso%2Fa%20b' +
      '&tenantId=72f988bf-86f1-41af-91ab-2d7cd011db47'
  )

  const base = teamsChatUrl({ users: ['a@b.co'], text: '', tenantId: null })
  assert.equal(base, 'https://teams.microsoft.com/l/chat/0/0?users=a%40b.co&message=')
  assert.equal(MAX_CHAT_URL, 2000)
  const fits = teamsChatUrl({ users: ['a@b.co'], text: 'x'.repeat(MAX_CHAT_URL - base!.length), tenantId: null })
  assert.equal(fits?.length, MAX_CHAT_URL)
  assert.equal(teamsChatUrl({ users: ['a@b.co'], text: 'x'.repeat(MAX_CHAT_URL - base!.length + 1), tenantId: null }), null)
  assert.equal(teamsChatUrl({ users: ['a@b.co'], text: '🚀'.repeat(300), tenantId: null }), null)
})

test('teamsChatUrl needs at least one user and omits an absent tenant', () => {
  assert.equal(teamsChatUrl({ users: [], text: 'hi', tenantId: 'tid' }), null)
  assert.equal(teamsChatUrl({ users: ['a@b.co'], text: 'hi', tenantId: '' }), 'https://teams.microsoft.com/l/chat/0/0?users=a%40b.co&message=hi')
})

test('teamsChatUrl replaces a lone surrogate instead of throwing', () => {
  assert.equal(teamsChatUrl({ users: ['a@b.co'], text: 'a\uD83Db', tenantId: null }), 'https://teams.microsoft.com/l/chat/0/0?users=a%40b.co&message=a%EF%BF%BDb')
})
