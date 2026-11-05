import { atom, plugin, read, set, type ReadonlyAtom } from 'orca'

let hostVisible: ReadonlyAtom<boolean> | null = null

export function watchVisibility(visible: ReadonlyAtom<boolean>): void {
  hostVisible = visible
}

export const hostIsVisible = (): boolean => hostVisible !== null && read(hostVisible)

export function surfaceVisibility(surface: 'work' | 'prs'): { report(next: string | null): void; hide(): void } {
  const shownOrg = atom<string | null>(null)

  function tell(org: string, visible: boolean): void {
    plugin.request('ui.visibility', { surface, org, visible }).catch(() => {})
  }

  return {
    report(next) {
      const previous = read(shownOrg)
      if (previous === next) return
      set(shownOrg, next)
      if (previous) tell(previous, false)
      if (next) tell(next, true)
    },
    hide() {
      const org = read(shownOrg)
      if (org) tell(org, false)
    }
  }
}
