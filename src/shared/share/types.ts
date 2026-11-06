import type { Identity } from '../types'

export type ShareKind = 'pr' | 'approval'

export interface Segment {
  text: string
  href?: string
}

export interface ShareItem {
  key: string
  vars: Record<string, string>
}

export interface ShareMessage {
  intro: string
  lines: Segment[][]
}

export interface Channel {
  id: string
  name: string
  service: 'teams'
  addedAt: number
}

export type Person = Identity & { required: boolean }

export type ShareDestination =
  | { kind: 'copy' }
  | { kind: 'channel'; id: string }
  | { kind: 'chat'; people: Identity[] }
  | { kind: 'email'; people: Identity[] }
  | { kind: 'reviewers'; people: Person[] }

export interface SharePrefs {
  destinations: ShareDestination[]
}

export interface SharePrefsView {
  template: string
  warning?: string
  channels: Channel[]
  prefs: SharePrefs
  tenantId: string | null
}

export interface ShareRequest {
  org: string
  kind: ShareKind
  keys: string[]
  intro: string
  destinations: ShareDestination[]
}

export interface ShareResult {
  destination: string
  ok: boolean
  text: string
  plain?: string
}
