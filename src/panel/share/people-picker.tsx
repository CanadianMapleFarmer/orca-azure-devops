import { Box, IconButton, Input, List, ListItem, Row, Stack, Switch, Text, type OrcaNode } from 'orca'
import { MAX_SHARE_PEOPLE, TOO_MANY_PEOPLE } from '../../shared/share/limits'
import type { Person } from '../../shared/share/types'
import type { Identity } from '../../shared/types'
import { findPeople, searchOf, setQuery } from './people-search'

const MAX_RESULTS = 20
const MAX_SUGGESTIONS = 10
const CHOOSE_SOMEONE = 'Choose at least one person.'

interface PeoplePickerProps {
  org: string
  label: string
  groups: boolean
  required: boolean
  people: Person[]
  suggestions: Identity[]
  onChange: (people: Person[]) => void
}

function Offers({ label, identities, full, onAdd }: { label: string; identities: Identity[]; full: boolean; onAdd: (identity: Identity) => void }): OrcaNode {
  if (identities.length === 0) return null
  return (
    <List label={label}>
      {identities.map(identity => (
        <ListItem key={identity.id} title={identity.displayName} description={identity.uniqueName} disabled={full} onPress={() => onAdd(identity)} />
      ))}
    </List>
  )
}

export function PeoplePicker({ org, label, groups, required, people, suggestions, onChange }: PeoplePickerProps): OrcaNode {
  const search = searchOf(label)
  const chosen = new Set(people.map(person => person.id))
  const full = people.length >= MAX_SHARE_PEOPLE
  const offered = (identities: readonly Identity[], cap: number): Identity[] =>
    identities.filter(identity => (groups || identity.kind === 'user') && !chosen.has(identity.id)).slice(0, cap)
  const find = (query: string) => findPeople({ org, label, groups, query })
  const add = ({ id, displayName, uniqueName, kind }: Identity) => {
    if (!full && !chosen.has(id)) onChange([...people, { id, displayName, uniqueName, kind, required: false }])
  }
  const setRequired = (id: string, on: boolean) => onChange(people.map(person => (person.id === id ? { ...person, required: on } : person)))
  return (
    <Stack gap="xs">
      <Row gap="xs" align="end">
        <Box grow shrink minWidth={0}>
          <Input label={label} placeholder="Name or email" value={search.query} onChange={query => setQuery(label, query)} onSubmit={find} />
        </Box>
        <IconButton icon="search" label="Search" variant="ghost" disabled={search.status === 'searching'} onPress={() => find(search.query)} />
      </Row>
      {search.status === 'failed' ? (
        <Text size="sm" tone="danger">
          {search.message ?? ''}
        </Text>
      ) : null}
      {search.status === 'ready' && search.results.length === 0 ? (
        <Text size="sm" muted>
          No one found.
        </Text>
      ) : null}
      <Offers label="Search results" identities={offered(search.results, MAX_RESULTS)} full={full} onAdd={add} />
      <Offers label="Suggestions" identities={offered(suggestions, MAX_SUGGESTIONS)} full={full} onAdd={add} />
      {people.map(person => (
        <Row key={person.id} gap="sm" align="center">
          <Box grow shrink minWidth={0}>
            <Text truncate>{person.displayName}</Text>
          </Box>
          {required ? <Switch label="Required" checked={person.required} onChange={on => setRequired(person.id, on)} /> : null}
          <IconButton
            icon="remove"
            label={`Remove ${person.displayName}`}
            variant="ghost"
            size="sm"
            onPress={() => onChange(people.filter(other => other.id !== person.id))}
          />
        </Row>
      ))}
      {people.length === 0 ? (
        <Text size="sm" muted>
          {CHOOSE_SOMEONE}
        </Text>
      ) : null}
      {full ? (
        <Text size="sm" muted>
          {TOO_MANY_PEOPLE}
        </Text>
      ) : null}
    </Stack>
  )
}
