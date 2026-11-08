import { Collapsible, type OrcaNode } from 'orca'
import { isFoldOpen, setFoldOpen, type FoldTab } from './folds'
import { cutLabel } from './label'

interface GroupProps {
  org: string
  tab: FoldTab
  foldKey: string
  title: string
  count: string
  hint?: string
  natural?: boolean
  children?: OrcaNode
}

export function Group({ org, tab, foldKey, title, count, hint, natural = true, children }: GroupProps): OrcaNode {
  const open = isFoldOpen(org, tab, foldKey, natural)
  return (
    <Collapsible
      title={cutLabel(title)}
      description={cutLabel(hint ? `${count} · ${hint}` : count)}
      open={open}
      onChange={next => setFoldOpen(org, tab, foldKey, next)}
    >
      {open ? children : null}
    </Collapsible>
  )
}
