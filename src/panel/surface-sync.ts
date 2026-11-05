import { read, set, type Atom } from 'orca'
import type { OrgStatus } from '../shared/types'
import { tab, type TabId } from './state'
import { hostIsVisible } from './visibility'

export interface SyncedSurface {
  tab: TabId
  source: Atom<string | null>
  visibility: { report(next: string | null): void }
  isIdle(): boolean
  reset(): void
  load(org: string): void
}

function align(surface: SyncedSurface, org: string | null, visibleOrg: string | null): void {
  if (read(surface.source) !== org) {
    set(surface.source, org)
    surface.reset()
  }
  if (org !== null && visibleOrg === org && surface.isIdle()) surface.load(org)
  surface.visibility.report(visibleOrg)
}

// Orca offers no atom subscription, so Panel calls this while rendering and the effects run after the render.
export function syncSurface(surface: SyncedSurface, org: OrgStatus | null, onScreen: boolean): void {
  const connected = org?.state === 'connected' ? org.org : null
  const visibleOrg = connected && onScreen && hostIsVisible() && read(tab) === surface.tab ? connected : null
  void Promise.resolve().then(() => align(surface, connected, visibleOrg))
}
