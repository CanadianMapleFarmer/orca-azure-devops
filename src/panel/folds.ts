export const foldedAfter = <T extends string>(closed: T[], fold: T, open: boolean): T[] =>
  open ? closed.filter(other => other !== fold) : closed.includes(fold) ? closed : [...closed, fold]
